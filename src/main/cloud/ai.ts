/**
 * 云管平台 · AI 助手（主进程）
 *
 * 设计取舍：
 * - 不复用 agent 会话（那套要项目绑定、工具审批、文件/数据库权限），云管助手只做「带数据快照的问答」；
 * - 会话（历史对话）落在 userData/cloud-ai.json，可随时新建、切回、删除；
 * - 读取范围精确到「子模块」（如「总览 → 集群容量」「告警 → 24 小时趋势」）：用户勾哪块就取哪块，
 *   每块一个独立取数/渲染函数（`sec*`），同一模块内的多块共享同一次 OCP 请求（Ctx.once）；
 * - 取数失败不中断对话，而是在快照里显式标注，让模型自己说明「这块没取到」；
 * - 快照是静态的，界面提供「刷新数据」重建，避免每轮都打 OCP。
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { callLlm } from '../agent/llm'
import { skillBlockFor } from '../skill-context'
import { loadConfig } from '../config'
import { writeFileAtomic } from '../atomic'
import type { ChatMsg } from '../types'
import * as svc from './service'
import type { CloudAlarm, CloudCluster, CloudHost, CloudTask, CloudTenant } from './ocp'

// ---------------------------------------------------------------- 模块与子模块目录

export type CloudAiModuleKey =
  | 'overview'
  | 'clusters'
  | 'tenants'
  | 'obproxy'
  | 'hosts'
  | 'backup'
  | 'inspection'
  | 'monitor'
  | 'sqldiag'
  | 'alarms'
  | 'tasks'
  | 'platform'

/** 子模块的「整块」key：模块.块；细分粒度时在它后面加 `:参数`（见 CloudAiSectionKey） */
export type CloudAiSectionBase =
  | 'overview.kpi'
  | 'overview.clusters'
  | 'overview.alarms'
  | 'overview.tasks'
  | 'clusters.list'
  | 'clusters.capacity'
  | 'clusters.alarms'
  | 'clusters.topology'
  | 'clusters.params'
  | 'tenants.list'
  | 'tenants.distribution'
  | 'tenants.unitSpecs'
  | 'obproxy.clusters'
  | 'obproxy.links'
  | 'hosts.list'
  | 'hosts.agent'
  | 'hosts.services'
  | 'backup.overview'
  | 'backup.objects'
  | 'backup.tasks'
  | 'inspection.overview'
  | 'inspection.reports'
  | 'monitor.cluster'
  | 'monitor.tenant'
  | 'monitor.host'
  | 'sqldiag.top'
  | 'sqldiag.stats'
  | 'alarms.active'
  | 'alarms.levels'
  | 'alarms.trend'
  | 'alarms.rules'
  | 'tasks.list'
  | 'tasks.stats'
  | 'platform.users'
  | 'platform.params'
  | 'platform.logins'

/**
 * 子模块 key：`base` 或 `base:arg`。
 * arg 用来把一块再拆细，例如：
 * - `overview.kpi:hosts` 只读「主机数」这一个磁贴
 * - `overview.clusters:obcluster-prod` 只读某个集群的容量
 * - `clusters.topology:obcluster-prod` 只读该集群的拓扑
 * - `hosts.list:<svr_ip>` / `tenants.list:<tenant_name>` / `monitor.cluster:cpu_percent`
 */
export type CloudAiSectionKey = CloudAiSectionBase | `${CloudAiSectionBase}:${string}`

/** 拆出「整块 key」与细分参数（没有参数时 arg 为空串） */
export function splitSectionKey(key: string): { base: CloudAiSectionBase; arg: string } {
  const i = key.indexOf(':')
  return i < 0
    ? { base: key as CloudAiSectionBase, arg: '' }
    : { base: key.slice(0, i) as CloudAiSectionBase, arg: key.slice(i + 1) }
}

export interface CloudAiModuleDef {
  key: CloudAiModuleKey
  label: string
  icon: string
  desc: string
}

export interface CloudAiSectionDef {
  key: CloudAiSectionBase
  module: CloudAiModuleKey
  label: string
  desc: string
}

export const CLOUD_AI_MODULES: CloudAiModuleDef[] = [
  { key: 'overview', label: '总览', icon: '◎', desc: '集群健康 / 容量水位 / 活跃告警 / 最近任务' },
  { key: 'clusters', label: '集群', icon: '▦', desc: 'OB 集群清单、容量、拓扑与参数' },
  { key: 'tenants', label: '租户', icon: '❐', desc: '跨集群租户、Locality、Unit 规格' },
  { key: 'obproxy', label: 'OBProxy', icon: '⇄', desc: 'OBProxy 集群、代理实例、连接的 OB 集群' },
  { key: 'hosts', label: '主机', icon: '▤', desc: '纳管主机、Agent 状态、承载服务' },
  { key: 'backup', label: '备份恢复', icon: '⛁', desc: '备份指标、备份对象、备份/恢复任务' },
  { key: 'inspection', label: '巡检', icon: '✓', desc: '巡检对象风险与巡检报告' },
  { key: 'monitor', label: '资源监控', icon: '∿', desc: '集群 / 租户 / 主机近 1 小时指标' },
  { key: 'sqldiag', label: 'SQL 诊断', icon: '⌁', desc: 'TopSQL 与租户 SQL 概况' },
  { key: 'alarms', label: '告警', icon: '⚠', desc: '活跃告警、级别分布、24h 趋势、规则' },
  { key: 'tasks', label: '任务', icon: '⟳', desc: '最近运维任务与状态统计' },
  { key: 'platform', label: '平台管理', icon: '⚙', desc: 'OCP 用户 / 角色 / 平台参数 / 登录审计' }
]

export const CLOUD_AI_SECTIONS: CloudAiSectionDef[] = [
  // 总览
  { key: 'overview.kpi', module: 'overview', label: '核心指标', desc: '集群/租户/主机/告警数量、CPU 分配、OCP 版本' },
  { key: 'overview.clusters', module: 'overview', label: '集群容量', desc: '每个集群的 CPU / 内存 / 数据盘水位与告警数' },
  { key: 'overview.alarms', module: 'overview', label: '活跃告警', desc: '总览页展示的最近 12 条活跃告警' },
  { key: 'overview.tasks', module: 'overview', label: '最近任务', desc: '总览页展示的最近 10 条运维任务' },
  // 集群
  { key: 'clusters.list', module: 'clusters', label: '集群清单', desc: '名称/状态/模式/版本/Zone/节点/租户/根服务节点' },
  { key: 'clusters.capacity', module: 'clusters', label: '容量水位', desc: 'CPU、内存、数据盘的已用与占比' },
  { key: 'clusters.alarms', module: 'clusters', label: '告警分布', desc: '各集群告警条数与严重/警告/注意分布' },
  { key: 'clusters.topology', module: 'clusters', label: '拓扑与 OBServer', desc: '前 3 个集群的 Zone、OBServer、租户分布' },
  { key: 'clusters.params', module: 'clusters', label: '启动参数', desc: '前 3 个集群的启动参数' },
  // 租户
  { key: 'tenants.list', module: 'tenants', label: '租户清单', desc: '租户/集群/模式/状态/Locality/主 Zone' },
  { key: 'tenants.distribution', module: 'tenants', label: '分布统计', desc: '按集群、模式、主/备角色统计租户数量' },
  { key: 'tenants.unitSpecs', module: 'tenants', label: 'Unit 规格', desc: '资源单元规格清单（CPU/内存区间、类型）' },
  // OBProxy
  { key: 'obproxy.clusters', module: 'obproxy', label: 'OBProxy 集群', desc: '集群名/状态/访问地址/版本/实例数与 IDC 分布' },
  { key: 'obproxy.links', module: 'obproxy', label: '连接关系', desc: '每个 OBProxy 反代了哪些 OB 集群、连接数与代理用户' },
  // 主机
  { key: 'hosts.list', module: 'hosts', label: '主机清单', desc: 'IP/别名/状态/机型/操作系统/区域' },
  { key: 'hosts.agent', module: 'hosts', label: 'Agent 状态', desc: 'Agent 可用性汇总与异常主机明细' },
  { key: 'hosts.services', module: 'hosts', label: '承载服务', desc: '每台主机上的 OB 集群 / OBProxy 服务与版本' },
  // 备份恢复
  { key: 'backup.overview', module: 'backup', label: '核心指标', desc: '已建策略集群数、本周备份成功率、日志备份延时、抽检' },
  { key: 'backup.objects', module: 'backup', label: '备份对象', desc: '每个集群的备份策略状态与租户级备份明细' },
  { key: 'backup.tasks', module: 'backup', label: '备份/恢复任务', desc: '最近的数据备份、日志备份、恢复与清理任务' },
  // 巡检
  { key: 'inspection.overview', module: 'inspection', label: '巡检对象', desc: '集群/租户/OBProxy 的最近巡检风险与调度状态' },
  { key: 'inspection.reports', module: 'inspection', label: '巡检报告', desc: '最近 20 份报告的风险统计与巡检集' },
  // 资源监控
  { key: 'monitor.cluster', module: 'monitor', label: '集群指标', desc: '前 3 个集群近 1 小时 CPU/内存/MemStore/QPS' },
  { key: 'monitor.tenant', module: 'monitor', label: '租户指标', desc: '前 3 个业务租户 QPS/活跃会话/MemStore' },
  { key: 'monitor.host', module: 'monitor', label: '主机指标', desc: '前 3 台主机 CPU/内存/load1' },
  // SQL 诊断
  { key: 'sqldiag.top', module: 'sqldiag', label: 'TopSQL', desc: '首业务集群近 1 小时按 CPU 排序的 Top 20 语句' },
  { key: 'sqldiag.stats', module: 'sqldiag', label: '租户 SQL 概况', desc: '新 SQL / 慢 SQL / 异常 / 高风险计数' },
  // 告警
  { key: 'alarms.active', module: 'alarms', label: '活跃告警', desc: '当前活跃告警明细（最多 30 条）' },
  { key: 'alarms.levels', module: 'alarms', label: '级别分布', desc: '严重 / 警告 / 注意 各级条数' },
  { key: 'alarms.trend', module: 'alarms', label: '24 小时趋势', desc: '按小时分布、Top 告警类型、对象类型分布' },
  { key: 'alarms.rules', module: 'alarms', label: '告警规则', desc: '规则清单（名称/级别/对象类型/启用状态）' },
  // 任务
  { key: 'tasks.list', module: 'tasks', label: '任务列表', desc: '最近 30 条运维任务（含状态、对象、发起人）' },
  { key: 'tasks.stats', module: 'tasks', label: '状态统计', desc: '各状态任务数量' },
  // 平台管理
  { key: 'platform.users', module: 'platform', label: '用户与角色', desc: 'OCP 用户清单与角色定义（含锁定/过期状态）' },
  { key: 'platform.params', module: 'platform', label: '平台参数', desc: '平台参数前 60 项（key/值/运行值/需重启）' },
  { key: 'platform.logins', module: 'platform', label: '登录审计', desc: '最近 20 条登录记录（用户/IP/结果/客户端）' }
]

const SECTION_MAP = new Map<CloudAiSectionBase, CloudAiSectionDef>(CLOUD_AI_SECTIONS.map((s) => [s.key, s]))

export function moduleOfSection(key: CloudAiSectionKey): CloudAiModuleKey {
  return SECTION_MAP.get(splitSectionKey(key).base)?.module || 'overview'
}

/** 模块列表 → 该模块下的全部子模块（兼容只给了模块的旧会话/旧调用） */
export function sectionsOfModules(mods: CloudAiModuleKey[]): CloudAiSectionBase[] {
  return CLOUD_AI_SECTIONS.filter((s) => mods.includes(s.module)).map((s) => s.key)
}

/** 子模块列表 → 涉及到的模块（去重、按目录顺序） */
export function modulesOfSections(keys: CloudAiSectionKey[]): CloudAiModuleKey[] {
  return CLOUD_AI_MODULES.filter((m) => keys.some((k) => moduleOfSection(k) === m.key)).map((m) => m.key)
}

const isSectionKey = (k: any): k is CloudAiSectionKey =>
  typeof k === 'string' && SECTION_MAP.has(splitSectionKey(k).base)

// ---------------------------------------------------------------- 类型

export interface CloudAiMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
}

export interface CloudAiSessionMeta {
  id: string
  title: string
  platformId: string
  platformName: string
  /** 精确到子模块的读取范围 */
  sections: CloudAiSectionKey[]
  /** 由 sections 推导，只用于列表展示 */
  modules: CloudAiModuleKey[]
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 快照生成时间与字符数（界面展示「数据快照 · 时间」） */
  contextAt: number
  contextChars: number
}

export interface CloudAiSession extends CloudAiSessionMeta {
  /** 子模块数据快照（Markdown 文本），注入系统提示词 */
  context: string
  messages: CloudAiMessage[]
}

export type CloudAiEvent =
  | { type: 'building'; sessionId: string }
  | { type: 'context'; sessionId: string; contextAt: number; contextChars: number }
  | { type: 'start'; sessionId: string }
  /** 思考流（部分模型会先长时间输出 reasoning，界面据此提示「思考中」而不是看起来卡住） */
  | { type: 'reasoning'; sessionId: string; chars: number }
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'done'; sessionId: string; message: CloudAiMessage; meta: CloudAiSessionMeta }
  | { type: 'error'; sessionId: string; error: string }

export interface CloudAiAskInput {
  sessionId?: string | null
  platformId: string
  platformName?: string
  sections?: CloudAiSectionKey[]
  text: string
  /** 本次对话启用的技能 id（技能正文以「回答规范」形式拼进系统提示，不挂工具） */
  skills?: string[]
}

// ---------------------------------------------------------------- 持久化

const MAX_SESSIONS = 40
const MAX_MESSAGES = 80
const CONTEXT_MAX_CHARS = 30_000

interface StoreShape {
  sessions: CloudAiSession[]
}

let cache: StoreShape | null = null
/** 正在生成的会话 → 中断控制器（同一会话不并发） */
const running = new Map<string, AbortController>()
let send: (ev: CloudAiEvent) => void = () => {}

export function bindCloudAiEmitter(fn: (ev: CloudAiEvent) => void): void {
  send = fn
}

function storeFile(): string {
  return path.join(app.getPath('userData'), 'cloud-ai.json')
}

/** 旧版会话只有 modules，这里补出 sections，避免历史对话打不开 */
function normalizeSession(raw: any): CloudAiSession | null {
  if (!raw?.id) return null
  const sections: CloudAiSectionKey[] = Array.isArray(raw.sections) && raw.sections.length
    ? raw.sections.filter(isSectionKey)
    : sectionsOfModules(Array.isArray(raw.modules) ? raw.modules : ['overview'])
  const picked = sections.length ? sections : (['overview.kpi'] as CloudAiSectionKey[])
  const messages: CloudAiMessage[] = Array.isArray(raw.messages)
    ? raw.messages.filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    : []
  return {
    id: String(raw.id),
    title: String(raw.title || '新对话'),
    platformId: String(raw.platformId || ''),
    platformName: String(raw.platformName || ''),
    sections: picked,
    modules: modulesOfSections(picked),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    messageCount: messages.length,
    contextAt: Number(raw.contextAt) || 0,
    contextChars: Number(raw.contextChars) || 0,
    context: typeof raw.context === 'string' ? raw.context : '',
    messages
  }
}

function loadStore(): StoreShape {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(storeFile(), 'utf8')
    const data = JSON.parse(raw) as { sessions?: any[] }
    cache = {
      sessions: Array.isArray(data?.sessions)
        ? (data.sessions.map(normalizeSession).filter((s): s is CloudAiSession => !!s))
        : []
    }
  } catch {
    cache = { sessions: [] }
  }
  return cache
}

function saveStore(): void {
  if (!cache) return
  try {
    writeFileAtomic(storeFile(), JSON.stringify(cache, null, 2))
  } catch {
    /* 磁盘异常不影响本轮对话，下次保存再试 */
  }
}

function metaOf(s: CloudAiSession): CloudAiSessionMeta {
  return {
    id: s.id,
    title: s.title,
    platformId: s.platformId,
    platformName: s.platformName,
    sections: s.sections,
    modules: modulesOfSections(s.sections),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
    contextAt: s.contextAt,
    contextChars: s.context.length
  }
}

function findSession(id: string): CloudAiSession | undefined {
  return loadStore().sessions.find((s) => s.id === id)
}

export function listCloudAiSessions(platformId?: string): CloudAiSessionMeta[] {
  const list = loadStore().sessions
    .filter((s) => (platformId ? s.platformId === platformId : true))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return list.map(metaOf)
}

export function getCloudAiSession(id: string): CloudAiSession | null {
  return findSession(id) || null
}

export function deleteCloudAiSession(id: string): { ok: boolean } {
  const store = loadStore()
  store.sessions = store.sessions.filter((s) => s.id !== id)
  running.get(id)?.abort()
  running.delete(id)
  saveStore()
  return { ok: true }
}

export function stopCloudAi(id: string): { ok: boolean } {
  const ctrl = running.get(id)
  if (ctrl) ctrl.abort()
  return { ok: true }
}

function newSession(input: { platformId: string; platformName: string; sections: CloudAiSectionKey[] }): CloudAiSession {
  const store = loadStore()
  const now = Date.now()
  const sections = input.sections.length ? input.sections : (['overview.kpi'] as CloudAiSectionKey[])
  const s: CloudAiSession = {
    id: `cai_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title: '新对话',
    platformId: input.platformId,
    platformName: input.platformName,
    sections,
    modules: modulesOfSections(sections),
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    contextAt: 0,
    contextChars: 0,
    context: '',
    messages: []
  }
  store.sessions.unshift(s)
  if (store.sessions.length > MAX_SESSIONS) store.sessions = store.sessions.slice(0, MAX_SESSIONS)
  saveStore()
  return s
}

// ---------------------------------------------------------------- 通用格式化

const LEVEL_LABEL: Record<number, string> = { 1: '严重', 2: '警告', 3: '注意' }
const CLUSTER_STATUS: Record<string, string> = {
  RUNNING: '运行中',
  STOPPED: '已停止',
  OPERATING: '运维中',
  UPDATING: '升级中',
  FAILED: '异常'
}
const TASK_STATUS: Record<string, string> = {
  SUCCESSFUL: '已完成',
  FAILED: '失败',
  RUNNING: '执行中',
  PENDING: '等待中',
  CANCELED: '已取消',
  CANCELLED: '已取消'
}

const levelText = (n: number): string => LEVEL_LABEL[n] || `级别${n}`
const clusterText = (s: string): string => CLUSTER_STATUS[s] || s || '未知'
const taskText = (s: string): string => TASK_STATUS[s] || s || '未知'
const num = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(digits)
/** 单块文本上限：防止某一块把整份快照撑爆（总快照另有总上限） */
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字）` : s)
const ts = (iso: string): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
/** 微秒 → 可读耗时 */
const dur = (us: number): string => {
  if (!Number.isFinite(us)) return '—'
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(2)}s`
  if (us >= 1000) return `${(us / 1000).toFixed(2)}ms`
  return `${Math.round(us)}μs`
}

/** 固定 slug 的细分参数 → 展示名（集群名/主机 IP 这类动态参数直接用原值） */
const ARG_LABEL: Record<string, string> = {
  'overview.kpi:ocp': 'OCP 版本',
  'overview.kpi:clusters': '集群数',
  'overview.kpi:tenants': '租户数',
  'overview.kpi:hosts': '主机数',
  'overview.kpi:alarms': '活跃告警数',
  'overview.kpi:cpu': 'CPU 分配',
  'backup.overview:strategy': '备份策略覆盖',
  'backup.overview:success': '本周备份成功率',
  'backup.overview:logDelay': '日志备份延时',
  'backup.overview:rehearsal': '恢复抽检',
  'sqldiag.stats:slow': '慢 SQL',
  'sqldiag.stats:new': '新 SQL',
  'sqldiag.stats:anomaly': '异常 SQL',
  'sqldiag.stats:risky': '高风险 SQL',
  'alarms.levels:1': '严重告警',
  'alarms.levels:2': '警告告警',
  'alarms.levels:3': '注意告警',
  'alarms.levels:0': '活跃合计'
}

function argLabel(base: CloudAiSectionBase, arg: string): string {
  return ARG_LABEL[`${base}:${arg}`] || arg
}

function table(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map((c) => String(c ?? '')).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

/** 同一次快照构建内复用同一个 OCP 请求（例如「总览」4 块共用一次 overview） */
export class Ctx {
  private mem = new Map<string, Promise<any>>()

  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.mem.get(key)
    if (hit) return hit as Promise<T>
    const p = fn()
    this.mem.set(key, p)
    return p
  }
}

const fail = (r: { error?: string }): string => `（读取失败：${r.error || '未知错误'}）`

function clusterTable(list: CloudCluster[]): string {
  return table(
    ['集群', '状态', '模式', '版本', 'Zone', '节点', '租户', 'CPU 已用/总量', '内存 已用/总量(G)', '数据盘%', '根服务节点'],
    list.map((c) => [
      c.name,
      clusterText(c.status),
      c.clusterMode,
      `v${c.version}`,
      c.regionCount,
      c.serverCount,
      c.tenantCount,
      `${num(c.cpu.used, 0)}/${num(c.cpu.total, 0)}`,
      `${num(c.memory.used, 0)}/${num(c.memory.total, 0)}`,
      num(c.disk.pct, 1),
      c.rootServer || '—'
    ])
  )
}

/** 以平台 id 绑定的取数门面（每个 key 在一次快照构建里只打一次 OCP） */
function fetcher(id: string) {
  return {
    overview: (c: Ctx) => c.once('overview', () => svc.overview(id)),
    clusters: (c: Ctx) => c.once('clusters', () => svc.clusters(id)),
    tenants: (c: Ctx) => c.once('tenants', () => svc.tenants(id)),
    hosts: (c: Ctx) => c.once('hosts', () => svc.hosts(id)),
    tasks: (c: Ctx) => c.once('tasks', () => svc.tasks(id, { page: 1, size: 30 })),
    taskStats: (c: Ctx) => c.once('taskStats', () => svc.taskStats(id)),
    alarms: (c: Ctx) => c.once('alarms', () => svc.alarms(id, {})),
    levels: (c: Ctx) => c.once('levels', () => svc.alarmLevelCounts(id)),
    trend: (c: Ctx) => c.once('trend', () => svc.alarmTrend(id, 24)),
    rules: (c: Ctx) => c.once('rules', () => svc.alarmRules(id, { page: 1, size: 40 })),
    specs: (c: Ctx) => c.once('specs', () => svc.unitSpecs(id)),
    detail: (c: Ctx, clusterId: number) => c.once(`detail:${clusterId}`, () => svc.clusterDetail(id, clusterId)),
    // 补齐的四个模块：各是一次聚合请求，同模块内的子模块共用
    backup: (c: Ctx) => c.once('backup', () => svc.backupBundle(id)),
    obproxy: (c: Ctx) => c.once('obproxy', () => svc.obproxyBundle(id)),
    inspection: (c: Ctx) => c.once('inspection', () => svc.inspectionBundle(id)),
    platform: (c: Ctx) => c.once('platform', () => svc.platformBundle(id))
  }
}

type Fetcher = ReturnType<typeof fetcher>

// ---------------------------------------------------------------- 各子模块

async function allClusters(get: Fetcher, ctx: Ctx): Promise<CloudCluster[]> {
  const r = await get.clusters(ctx)
  return r.ok && r.data ? r.data : []
}

async function secOverviewKpi(get: Fetcher, ctx: Ctx, arg = ''): Promise<string> {
  const r = await get.overview(ctx)
  if (!r.ok || !r.data) return fail(r)
  const o = r.data
  const byKey: Record<string, string> = {
    ocp: `- OCP：${o.info.version || '—'} ${o.info.edition || ''}`.trim(),
    clusters: `- 集群 ${o.kpis.clusters} 个（运行中 ${o.kpis.clustersRunning}）`,
    tenants: `- 租户 ${o.kpis.tenants} 个`,
    hosts: `- 主机 ${o.kpis.hosts} 台（在线 ${o.hosts.online}，离线 ${o.hosts.offline}，Agent 异常 ${o.hosts.agentAbnormal}）`,
    alarms: `- 活跃告警 ${o.kpis.alarms} 条（严重 ${o.kpis.alarmsCritical}）`,
    cpu: `- CPU 已分配 ${o.kpis.cpuUsed}/${o.kpis.cpuTotal} 核`
  }
  if (arg) return byKey[arg] || `（未知的核心指标：${arg}）`
  const out = Object.values(byKey)
  if (o.warnings.length) out.push(`- 取数告警：${o.warnings.join('；')}`)
  return out.join('\n')
}

/** 单个集群的一行摘要（总览卡片 / 集群清单用） */
function clusterOne(c: CloudCluster): string {
  const lv = c.alarms.levels
    .filter((l) => l.count > 0)
    .map((l) => `${levelText(l.level)} ${l.count}`)
    .join(' / ')
  return [
    `**${c.name}**（${clusterText(c.status)} · v${c.version} · ${c.clusterMode}）`,
    `- CPU ${num(c.cpu.used, 0)}/${num(c.cpu.total, 0)} 核（${num(c.cpu.pct, 1)}%）· 内存 ${num(c.memory.used, 0)}/${num(c.memory.total, 0)} G（${num(c.memory.pct, 1)}%）· 数据盘 ${num(c.disk.used, 1)}/${num(c.disk.total, 1)} G（${num(c.disk.pct, 1)}%）`,
    `- 节点 ${c.serverCount} · 租户 ${c.tenantCount} · Zone ${c.regionCount} · 根服务节点 ${c.rootServer || '—'}`,
    `- 活跃告警 ${c.alarms.total}${lv ? `（${lv}）` : ''}`
  ].join('\n')
}

async function secOverviewClusters(get: Fetcher, ctx: Ctx, arg = ''): Promise<string> {
  const r = await get.overview(ctx)
  if (!r.ok || !r.data) return fail(r)
  const list = r.data.clusters
  if (!list.length) return '（OCP 中还没有 OB 集群）'
  if (arg) {
    const c = list.find((x) => x.name === arg)
    return c ? clip(clusterOne(c), 4000) : `（没有找到集群 ${arg}）`
  }
  return clip(clusterTable(list), 6000)
}

async function secOverviewAlarms(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.overview(ctx)
  if (!r.ok || !r.data) return fail(r)
  const items = r.data.alarms
  if (!items.length) return '活跃告警：无'
  return clip(
    table(
      ['级别', '名称', '对象类型', '对象', '开始时间'],
      items.slice(0, 12).map((a) => [levelText(a.level), a.name, a.scope, a.targetInfo?.names?.join(',') || a.target || '—', ts(a.activeAt)])
    ),
    6000
  )
}

async function secOverviewTasks(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.overview(ctx)
  if (!r.ok || !r.data) return fail(r)
  const items = r.data.tasks
  if (!items.length) return '暂无任务记录'
  return clip(
    table(
      ['任务', '状态', '集群', '对象', '触发', '开始时间'],
      items.slice(0, 10).map((t) => [t.name, taskText(t.status), t.clusterName || '—', t.objName || t.tenant || '—', t.type || '—', ts(t.startTime)])
    ),
    6000
  )
}

async function secClustersList(get: Fetcher, ctx: Ctx, arg = ''): Promise<string> {
  const list = await allClusters(get, ctx)
  if (!list.length) return '（OCP 中没有 OB 集群）'
  if (arg) {
    const c = list.find((x) => x.name === arg)
    return c ? clip(clusterTable([c]), 3000) : `（没有找到集群 ${arg}）`
  }
  return clip(clusterTable(list), 6000)
}

/** 容量水位表（整块 / 单集群共用） */
function capacityTable(list: CloudCluster[]): string {
  return table(
    ['集群', 'CPU 已用/总量(核)', 'CPU%', '内存 已用/总量(G)', '内存%', '数据盘 已用/总量(G)', '数据盘%'],
    list.map((c) => [
      c.name,
      `${num(c.cpu.used, 0)}/${num(c.cpu.total, 0)}`,
      num(c.cpu.pct, 1),
      `${num(c.memory.used, 0)}/${num(c.memory.total, 0)}`,
      num(c.memory.pct, 1),
      `${num(c.disk.used, 1)}/${num(c.disk.total, 1)}`,
      num(c.disk.pct, 1)
    ])
  )
}

async function secClustersCapacity(get: Fetcher, ctx: Ctx, arg = ''): Promise<string> {
  const list = await allClusters(get, ctx)
  if (!list.length) return '（OCP 中没有 OB 集群）'
  if (arg) {
    const c = list.find((x) => x.name === arg)
    return c ? clip(capacityTable([c]), 2000) : `（没有找到集群 ${arg}）`
  }
  return clip(capacityTable(list), 6000)
}

async function secClustersAlarms(get: Fetcher, ctx: Ctx, arg = ''): Promise<string> {
  const all = await allClusters(get, ctx)
  if (!all.length) return '（OCP 中没有 OB 集群）'
  const list = arg ? all.filter((c) => c.name === arg) : all
  if (!list.length) return `（没有找到集群 ${arg}）`
  const rows = list.map((c) => {
    const byLevel = c.alarms.levels
      .filter((l) => l.count > 0)
      .map((l) => `${levelText(l.level)} ${l.count}`)
      .join(' / ')
    return [c.name, c.alarms.total, byLevel || '—']
  })
  return clip(table(['集群', '活跃告警', '级别分布'], rows), 5000)
}

const DETAIL_LIMIT = 3

async function secClustersTopology(get: Fetcher, ctx: Ctx, arg = ''): Promise<string> {
  const list = await allClusters(get, ctx)
  if (!list.length) return '（OCP 中没有 OB 集群）'
  const picked = arg ? list.filter((c) => c.name === arg) : list.slice(0, DETAIL_LIMIT)
  if (!picked.length) return `（没有找到集群 ${arg}）`
  const out: string[] = [arg ? '仅包含指定集群' : `仅包含前 ${picked.length} 个集群（共 ${list.length} 个）`]
  for (const c of picked) {
    const r = await get.detail(ctx, c.id)
    if (!r.ok || !r.data) {
      out.push('', `**${c.name}**：${fail(r)}`)
      continue
    }
    const d = r.data
    out.push('', `**${c.name}**（${clusterText(c.status)} · v${c.version}）`)
    out.push(`- Zone：${d.zones.map((z) => `${z.name}(${z.idc || z.region || '—'})`).join('、') || '—'}`)
    out.push(`- 租户：${d.tenants.map((t) => t.name).join('、') || '—'}`)
    out.push(
      table(
        ['OBServer', 'Zone', '状态', '主机状态', 'RootServer', '版本', '启动时间'],
        d.servers.slice(0, 8).map((s) => [s.ip, s.zone, s.status, s.hostStatus, s.withRootserver ? '是' : '否', `v${s.version}`, ts(s.startTime)])
      )
    )
  }
  return clip(out.join('\n'), 9000)
}

async function secClustersParams(get: Fetcher, ctx: Ctx, arg = ''): Promise<string> {
  const list = await allClusters(get, ctx)
  if (!list.length) return '（OCP 中没有 OB 集群）'
  const picked = arg ? list.filter((c) => c.name === arg) : list.slice(0, DETAIL_LIMIT)
  if (!picked.length) return `（没有找到集群 ${arg}）`
  const out: string[] = [arg ? '指定集群的启动参数' : `仅包含前 ${picked.length} 个集群（共 ${list.length} 个）的启动参数`]
  for (const c of picked) {
    const r = await get.detail(ctx, c.id)
    if (!r.ok || !r.data) {
      out.push('', `**${c.name}**：${fail(r)}`)
      continue
    }
    const params = r.data.startupParameters
    out.push('', `**${c.name}**：${params.length ? params.slice(0, 24).map((p) => `${p.key}=${p.value}`).join('，') : '无启动参数'}`)
  }
  return clip(out.join('\n'), 7000)
}

async function secTenantsList(get: Fetcher, ctx: Ctx, arg = ''): Promise<string> {
  const r = await get.tenants(ctx)
  if (!r.ok || !r.data) return fail(r)
  const all: CloudTenant[] = r.data
  if (!all.length) return '（没有租户）'
  const list = arg ? all.filter((t) => t.name === arg) : all
  if (!list.length) return `（没有找到租户 ${arg}）`
  const rows = list.map((t) => [
    t.name,
    t.clusterName,
    t.mode,
    t.status,
    t.locality || '—',
    t.primaryZone || '—',
    t.locked ? '已锁定' : '正常',
    t.role || (t.clusterType === 'STANDBY' ? '备租户' : '—')
  ])
  return clip(`共 ${list.length} 个租户\n\n${table(['租户', '集群', '模式', '状态', 'Locality', '主 Zone', '锁', '角色'], rows)}`, 7000)
}

async function secTenantsDistribution(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.tenants(ctx)
  if (!r.ok || !r.data) return fail(r)
  const list = r.data
  if (!list.length) return '（没有租户）'
  const group = (fn: (t: CloudTenant) => string): string => {
    const m = new Map<string, number>()
    for (const t of list) {
      const k = fn(t) || '—'
      m.set(k, (m.get(k) || 0) + 1)
    }
    return [...m.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')
  }
  return [
    `共 ${list.length} 个租户`,
    `- 按集群：${group((t) => t.clusterName)}`,
    `- 按模式：${group((t) => t.mode)}`,
    `- 按角色：${group((t) => t.role || (t.clusterType === 'STANDBY' ? 'STANDBY' : 'PRIMARY'))}`,
    `- 按状态：${group((t) => t.status)}`
  ].join('\n')
}

async function secTenantsUnitSpecs(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.specs(ctx)
  if (!r.ok || !r.data) return fail(r)
  const list = r.data
  if (!list.length) return '（没有 Unit 规格）'
  return clip(
    `共 ${list.length} 个规格（内存单位 GiB）\n\n` +
      table(
        ['规格', '类型', 'CPU 区间', '内存区间(G)', '日志盘(G)', 'IOPS 上限'],
        list.map((s) => [
          s.name,
          s.type,
          `${num(s.minCpu, 1)}–${num(s.maxCpu, 1)}`,
          `${num(s.minMemory, 1)}–${num(s.maxMemory, 1)}`,
          s.logDisk === null ? '不限' : num(s.logDisk, 1),
          s.maxIops === null ? '不限' : num(s.maxIops, 0)
        ])
      ),
    7000
  )
}

async function secHostsList(get: Fetcher, ctx: Ctx, arg = ''): Promise<string> {
  const r = await get.hosts(ctx)
  if (!r.ok || !r.data) return fail(r)
  const all: CloudHost[] = r.data
  if (!all.length) return '（没有纳管主机）'
  const list = arg ? all.filter((h) => h.ip === arg) : all
  if (!list.length) return `（没有找到主机 ${arg}）`
  return clip(
    `共 ${list.length} 台主机\n\n` +
      table(
        ['IP', '别名', '状态', 'Agent', '机型/OS', '区域/IDC', 'SSH 端口'],
        list.map((h) => [
          h.ip,
          h.alias || h.name || '—',
          h.status || '—',
          h.agentStatus || '—',
          h.typeName || h.os || '—',
          `${h.region || '—'}/${h.idc || '—'}`,
          h.sshPort || '—'
        ])
      ),
    7000
  )
}

async function secHostsAgent(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.hosts(ctx)
  if (!r.ok || !r.data) return fail(r)
  const list = r.data
  if (!list.length) return '（没有纳管主机）'
  const tally = (fn: (h: CloudHost) => string): string => {
    const m = new Map<string, number>()
    for (const h of list) {
      const k = fn(h) || 'UNKNOWN'
      m.set(k, (m.get(k) || 0) + 1)
    }
    return [...m.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')
  }
  const out = [`Agent 状态分布：${tally((h) => h.agentStatus)}`, `主机状态分布：${tally((h) => h.status)}`]
  const bad = list.filter((h) => h.agentStatus && h.agentStatus !== 'AVAILABLE')
  if (bad.length) {
    out.push('', 'Agent 非 AVAILABLE 的主机：')
    out.push(
      table(
        ['IP', '别名', 'Agent 状态', 'Agent 版本', '主机状态'],
        bad.map((h) => [h.ip, h.alias || h.name || '—', h.agentStatus, h.agentVersion || '—', h.status || '—'])
      )
    )
  } else {
    out.push('', '所有主机 Agent 均可用')
  }
  return clip(out.join('\n'), 6000)
}

async function secHostsServices(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.hosts(ctx)
  if (!r.ok || !r.data) return fail(r)
  const list = r.data
  if (!list.length) return '（没有纳管主机）'
  const rows = list.map((h) => [
    h.ip,
    (h.services || []).map((s) => `${s.type}:${s.name}${s.version ? `(v${s.version})` : ''}`).join('、') || '—',
    (h.clusters || []).join('、') || '—',
    (h.obproxies || []).join('、') || '—'
  ])
  return clip(table(['主机', '承载服务', '所属集群', 'OBProxy'], rows), 7000)
}

const METRIC_DEFS = {
  cluster: [
    { key: 'cpu_percent', label: 'CPU 使用率', unit: '%' },
    { key: 'memory_percent', label: '内存使用率', unit: '%' },
    { key: 'memstore_percent', label: 'MemStore 使用率', unit: '%' },
    { key: 'sql_all_count', label: 'QPS', unit: '次/秒' }
  ],
  tenant: [
    { key: 'sql_all_count', label: 'QPS', unit: '次/秒' },
    { key: 'active_session', label: '活跃会话', unit: '个' },
    { key: 'memstore_percent', label: 'MemStore 使用率', unit: '%' }
  ],
  host: [
    { key: 'cpu_percent', label: 'CPU 使用率', unit: '%' },
    { key: 'memory_percent', label: '内存使用率', unit: '%' },
    { key: 'load1', label: '负载 load1', unit: '' }
  ]
}

const METRIC_LIMIT = 3

/** 指标统一取近 1 小时，压成「平均(峰)」单元格 */
/** 某个指标在某实体上的「平均 / 峰值」；arg = series key（如 cpu_percent） */
function metricOne(series: any[], key: string): string {
  const s = (series || []).find((x) => String(x.key) === key)
  if (!s) return `（没有该指标：${key}）`
  const unit = s.unit || ''
  const avg = s.avg === null || s.avg === undefined ? '—' : `${num(s.avg, 2)}${unit}`
  const max = s.max === null || s.max === undefined ? '—' : `${num(s.max, 2)}${unit}`
  return `${s.label || key}：平均 ${avg}，峰值 ${max}`
}

function cellOf(series: { key: string; avg: number | null; max: number | null }[], key: string): string {
  const s = series.find((x) => x.key === key)
  return s ? `${num(s.avg, 1)}（峰 ${num(s.max, 1)}）` : '—'
}

const metricWindow = (): { from: number; to: number } => {
  const to = Date.now()
  return { from: to - 3600_000, to }
}

async function secMonitorCluster(get: Fetcher, ctx: Ctx, platformId: string, arg = ''): Promise<string> {
  const list = await allClusters(get, ctx)
  if (!list.length) return '（没有集群，无法读取监控指标）'
  const picked = arg ? list : list.slice(0, METRIC_LIMIT)
  const { from, to } = metricWindow()
  const rows: (string | number)[][] = []
  const byName = new Map<string, any[]>()
  const warnings: string[] = []
  for (const c of picked) {
    const r = await ctx.once(`metric:CLUSTER:${c.name}`, () =>
      svc.metrics(platformId, {
        scope: 'CLUSTER',
        metrics: METRIC_DEFS.cluster,
        labels: `ob_cluster_name:${c.name}`,
        groupBy: 'ob_cluster_id',
        from,
        to,
        maxPoints: 30
      })
    )
    if (!r.ok || !r.data) {
      rows.push([c.name, fail(r), '', '', ''])
      continue
    }
    byName.set(c.name, r.data.series)
    rows.push([c.name, cellOf(r.data.series, 'cpu_percent'), cellOf(r.data.series, 'memory_percent'), cellOf(r.data.series, 'memstore_percent'), cellOf(r.data.series, 'sql_all_count')])
    if (r.data.warnings.length) warnings.push(`${c.name}：${r.data.warnings.join('；')}`)
  }
  if (arg) {
    return clip(
      [
        `统计窗口：最近 1 小时，指标：${arg}`,
        '',
        ...picked.map((c) => `- ${c.name}：${byName.has(c.name) ? metricOne(byName.get(c.name)!, arg) : '（读取失败）'}`),
        ...(warnings.length ? ['', `取数告警：${warnings.join('；')}`] : [])
      ].join('\n'),
      4000
    )
  }
  return clip(
    [
      `统计窗口：最近 1 小时（${ts(new Date(from).toISOString())} ~ ${ts(new Date(to).toISOString())}），数值为平均值（括号内为峰值）`,
      `仅包含前 ${picked.length} 个集群（共 ${list.length} 个）`,
      '',
      table(['集群', 'CPU% 平均(峰)', '内存% 平均(峰)', 'MemStore% 平均(峰)', 'QPS 平均(峰)'], rows),
      ...(warnings.length ? ['', `取数告警：${warnings.join('；')}`] : [])
    ].join('\n'),
    7000
  )
}

async function secMonitorTenant(get: Fetcher, ctx: Ctx, platformId: string, arg = ''): Promise<string> {
  const r = await get.tenants(ctx)
  if (!r.ok || !r.data) return fail(r)
  const biz = r.data.filter((t) => t.name !== 'sys')
  const list = arg ? biz : biz.slice(0, METRIC_LIMIT)
  if (!list.length) return '（没有业务租户，无法读取租户指标）'
  const { from, to } = metricWindow()
  const rows: (string | number)[][] = []
  const byName = new Map<string, any[]>()
  for (const t of list) {
    const m = await ctx.once(`metric:TENANT:${t.name}`, () =>
      svc.metrics(platformId, {
        scope: 'TENANT',
        metrics: METRIC_DEFS.tenant,
        labels: `tenant_name:${t.name}`,
        groupBy: 'tenant_name',
        from,
        to,
        maxPoints: 30
      })
    )
    if (!m.ok || !m.data) {
      rows.push([t.name, t.clusterName, fail(m), '', ''])
      continue
    }
    byName.set(t.name, m.data.series)
    rows.push([t.name, t.clusterName, cellOf(m.data.series, 'sql_all_count'), cellOf(m.data.series, 'active_session'), cellOf(m.data.series, 'memstore_percent')])
  }
  if (arg) {
    return clip(
      [`统计窗口：最近 1 小时，指标：${arg}`, '', ...list.map((t) => `- ${t.name}（${t.clusterName}）：${byName.has(t.name) ? metricOne(byName.get(t.name)!, arg) : '（读取失败）'}`)].join('\n'),
      4000
    )
  }
  return clip(
    ['统计窗口：最近 1 小时，数值为平均值（括号内为峰值）', `仅包含前 ${list.length} 个非 sys 租户`, '', table(['租户', '集群', 'QPS 平均(峰)', '活跃会话 平均(峰)', 'MemStore% 平均(峰)'], rows)].join('\n'),
    7000
  )
}

async function secMonitorHost(get: Fetcher, ctx: Ctx, platformId: string, arg = ''): Promise<string> {
  const r = await get.hosts(ctx)
  if (!r.ok || !r.data) return fail(r)
  const list = arg ? r.data : r.data.slice(0, METRIC_LIMIT)
  if (!list.length) return '（没有主机，无法读取主机指标）'
  const { from, to } = metricWindow()
  const rows: (string | number)[][] = []
  const byIp = new Map<string, any[]>()
  for (const h of list) {
    const m = await ctx.once(`metric:HOST:${h.ip}`, () =>
      svc.metrics(platformId, { scope: 'HOST', metrics: METRIC_DEFS.host, labels: `svr_ip:${h.ip}`, groupBy: 'svr_ip', from, to, maxPoints: 30 })
    )
    if (!m.ok || !m.data) {
      rows.push([h.ip, h.alias || '—', fail(m), '', ''])
      continue
    }
    byIp.set(h.ip, m.data.series)
    rows.push([h.ip, h.alias || h.name || '—', cellOf(m.data.series, 'cpu_percent'), cellOf(m.data.series, 'memory_percent'), cellOf(m.data.series, 'load1')])
  }
  if (arg) {
    return clip(
      [`统计窗口：最近 1 小时，指标：${arg}`, '', ...list.map((h) => `- ${h.ip}${h.alias ? `（${h.alias}）` : ''}：${byIp.has(h.ip) ? metricOne(byIp.get(h.ip)!, arg) : '（读取失败）'}`)].join('\n'),
      4000
    )
  }
  return clip(
    [
      '统计窗口：最近 1 小时，数值为平均值（括号内为峰值）',
      `仅包含前 ${list.length} 台主机（共 ${r.data.length} 台）`,
      '',
      table(['主机', '别名', 'CPU% 平均(峰)', '内存% 平均(峰)', 'load1 平均(峰)'], rows)
    ].join('\n'),
    7000
  )
}

/** SQL 诊断固定看第一个业务集群（排除 OCP 元数据集群） */
async function diagCluster(get: Fetcher, ctx: Ctx): Promise<CloudCluster | null> {
  const all = await allClusters(get, ctx)
  const biz = all.filter((c) => c.name !== 'metadb_cluster')
  return (biz.length ? biz : all)[0] || null
}

async function secSqlTop(get: Fetcher, ctx: Ctx, platformId: string): Promise<string> {
  const target = await diagCluster(get, ctx)
  if (!target) return '（没有集群，无法读取 SQL 诊断数据）'
  const { from, to } = metricWindow()
  const r = await ctx.once('topSql', () => svc.topSql(platformId, target.id, 0, { from, to, limit: 20 }))
  if (!r.ok || !r.data) return fail(r)
  if (!r.data.length) return `集群 ${target.name} 近 1 小时没有 TopSQL 记录`
  return clip(
    [
      `统计窗口：最近 1 小时 · 集群 ${target.name}（集群级 TopSQL，含全部租户），按 CPU 占比排序`,
      '',
      table(
        ['SQL ID', '租户', '类型', '次数', '平均CPU(ms)', '平均耗时', '最大耗时', 'CPU%', '失败数', '语句'],
        r.data.slice(0, 20).map((s) => [
          s.sqlId,
          s.tenantName || '—',
          s.sqlType || '—',
          num(s.executions, 0),
          num(s.avgCpuTime / 1000, 2),
          dur(s.avgElapsedTime),
          dur(s.maxElapsedTime),
          num(s.cpuPercentage, 1),
          num(s.failCount, 0),
          (s.sqlTextShort || '').replace(/\s+/g, ' ').slice(0, 110)
        ])
      )
    ].join('\n'),
    9000
  )
}

async function secSqlStats(get: Fetcher, ctx: Ctx, platformId: string, arg = ''): Promise<string> {
  const target = await diagCluster(get, ctx)
  if (!target) return '（没有集群，无法读取 SQL 统计）'
  const { from, to } = metricWindow()
  const r = await ctx.once('sqlStats', () => svc.tenantSqlStats(platformId, target.id, from, to))
  if (!r.ok || !r.data) return fail(r)
  const rows = r.data.filter((s) => s.tenantName !== 'sys')
  if (!rows.length) return `集群 ${target.name} 近 1 小时没有租户 SQL 统计`
  if (arg) {
    const pick: Record<string, (x: any) => number> = {
      slow: (x) => Number(x.slowSqlCount) || 0,
      new: (x) => Number(x.newSqlCount) || 0,
      anomaly: (x) => Number(x.anomalySqlCount) || 0,
      risky: (x) => Number(x.highRiskSqlCount) || 0
    }
    const fn = pick[arg]
    if (!fn) return `（未知的 SQL 指标：${arg}）`
    const total = rows.reduce((a, b) => a + fn(b), 0)
    const top = rows
      .filter((x) => fn(x) > 0)
      .sort((a, b) => fn(b) - fn(a))
      .slice(0, 3)
      .map((x) => `${x.tenantName} ${fn(x)}`)
    return `集群 ${target.name} · 最近 1 小时：${argLabel('sqldiag.stats', arg)} 共 ${total}${top.length ? `（${top.join('、')}）` : ''}`
  }
  return clip(
    `集群 ${target.name} · 最近 1 小时\n\n` +
      table(['租户', '新 SQL', '慢 SQL', '异常 SQL', '高风险 SQL'], rows.map((s) => [s.tenantName, s.newSqlCount, s.slowSqlCount, s.anomalySqlCount, s.highRiskSqlCount])),
    6000
  )
}

async function secAlarmsActive(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.alarms(ctx)
  if (!r.ok || !r.data) return fail(r)
  if (!r.data.items.length) return '活跃告警：无'
  return clip(
    `活跃告警共 ${r.data.total} 条\n\n` +
      table(
        ['级别', '名称', '对象类型', '对象', '告警规则', '开始时间'],
        r.data.items.slice(0, 30).map((x: CloudAlarm) => [
          levelText(x.level),
          x.name,
          x.scope,
          x.targetInfo?.names?.join(',') || x.target || '—',
          x.alarmType || '—',
          ts(x.activeAt)
        ])
      ),
    9000
  )
}

async function secAlarmsLevels(get: Fetcher, ctx: Ctx, arg = ''): Promise<string> {
  const r = await get.levels(ctx)
  if (!r.ok || !r.data) return fail(r)
  if (!r.data.length) return '（没有告警级别数据）'
  if (arg === '0') return `活跃告警合计 ${r.data.reduce((a, b) => a + (Number(b.count) || 0), 0)} 条`
  if (arg) {
    const lv = Number(arg)
    const hit = r.data.find((x) => Number(x.level) === lv)
    return `${levelText(lv)}告警 ${Number(hit?.count || 0)} 条`
  }
  return `按级别：${r.data.map((x) => `${levelText(x.level)} ${x.count}`).join(' · ')}`
}

async function secAlarmsTrend(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.trend(ctx)
  if (!r.ok || !r.data) return fail(r)
  const t = r.data
  const out = [
    `近 24 小时：共 ${t.total} 条（统计样本 ${t.scanned} 条${t.truncated ? '，超过 500 条仅统计前 500' : ''}）· 严重 ${t.levels[1]} · 警告 ${t.levels[2]} · 注意 ${t.levels[3]}`
  ]
  const buckets = t.buckets.filter((b) => b.total > 0).slice(-12)
  if (buckets.length) out.push(`按小时分布（最近 12 个非空小时）：${buckets.map((b) => `${ts(b.at).slice(5, 16)} ${b.total} 条`).join(' · ')}`)
  if (t.types.length) out.push(`Top 告警类型：${t.types.slice(0, 8).map((x) => `${x.name || x.key}(${x.count})`).join(' · ')}`)
  if (t.scopes.length) out.push(`对象类型分布：${t.scopes.map((x) => `${x.key}(${x.count})`).join(' · ')}`)
  if (t.appTypes.length) out.push(`应用分布：${t.appTypes.map((x) => `${x.key}(${x.count})`).join(' · ')}`)
  return clip(out.join('\n'), 6000)
}

async function secAlarmsRules(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.rules(ctx)
  if (!r.ok || !r.data) return fail(r)
  if (!r.data.items.length) return '（没有告警规则）'
  return clip(
    `共 ${r.data.total} 条规则，列出前 ${r.data.items.length} 条\n\n` +
      table(
        ['规则', '级别', '对象类型', '应用', '启用', '检测周期(s)', '内置'],
        r.data.items.map((x) => [
          x.name,
          levelText(x.level),
          x.scope,
          x.appType || '—',
          x.isEnabled ? '是' : '否',
          x.evaluationIntervalSeconds ?? '—',
          x.isBuildIn ? '是' : '否'
        ])
      ),
    9000
  )
}

async function secTasksList(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.tasks(ctx)
  if (!r.ok || !r.data) return fail(r)
  if (!r.data.items.length) return '（没有任务记录）'
  return clip(
    `共扫描 ${r.data.scanned} 条任务，列表显示 ${r.data.items.length} 条（总数 ${r.data.total}）\n\n` +
      table(
        ['ID', '任务', '状态', '集群', '对象类型', '对象', '发起人', '触发', '开始', '结束'],
        r.data.items.map((x: CloudTask) => [
          x.id,
          x.name,
          taskText(x.status),
          x.clusterName || '—',
          x.objType || '—',
          x.objName || x.tenant || '—',
          x.creator || '—',
          x.type || '—',
          ts(x.startTime),
          x.finishTime ? ts(x.finishTime) : '未结束'
        ])
      ),
    9000
  )
}

async function secTasksStats(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.taskStats(ctx)
  if (!r.ok || !r.data) return fail(r)
  if (!r.data.length) return '（没有任务统计）'
  return `按状态：${r.data.map((x) => `${taskText(x.status)} ${x.count}`).join(' · ')}`
}

// ---------- OBProxy（对齐官方 OBProxy 页） ----------

async function secObproxyClusters(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.obproxy(ctx)
  if (!r.ok || !r.data) return fail(r)
  const list = r.data.clusters
  if (!list.length) return '（OCP 没有纳管 OBProxy 集群）'
  return clip(
    table(
      ['集群', '状态', '访问地址', '版本', '工作模式', '实例(在线/总)', 'IDC 分布', '连接集群数'],
      list.map((c) => [
        c.name,
        c.status || '—',
        `${c.address}:${c.port}`,
        c.version || '—',
        c.workMode || '—',
        `${c.instances.filter((i) => i.status === 'RUNNING' && !i.offline).length}/${c.instances.length}`,
        c.topo.map((t) => `${t.idcName}×${t.count}`).join('、') || '—',
        c.links.length
      ])
    ),
    4000
  )
}

async function secObproxyLinks(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.obproxy(ctx)
  if (!r.ok || !r.data) return fail(r)
  const lines: string[] = []
  for (const c of r.data.clusters) {
    if (!c.links.length) {
      lines.push(`- ${c.name}：未反代任何 OB 集群`)
      continue
    }
    for (const l of c.links) {
      lines.push(
        `- ${c.name} → ${l.clusterName}（${l.clusterType || '—'}）：状态 ${l.status || '—'}，连接数 ${l.connections}，代理用户 ${l.username || '—'}，OB ${l.version || '—'}`
      )
    }
  }
  return lines.length ? clip(lines.join('\n'), 4000) : '（没有 oblink 连接关系）'
}

// ---------- 备份恢复 ----------

async function secBackupOverview(get: Fetcher, ctx: Ctx, arg = ''): Promise<string> {
  const r = await get.backup(ctx)
  if (!r.ok || !r.data) return fail(r)
  const o = r.data.overview
  const byKey: Record<string, string> = {
    strategy: `- 集群 ${o.totalClusterNum} 个，其中已创建备份策略 ${o.hasBackupStrategyClusterNum} 个`,
    success: `- 本周数据备份成功率 ${o.weekDataSuccessPct}%`,
    logDelay: `- 日志备份存在延时的对象 ${o.logBackupObjectNum} 个`,
    rehearsal: `- 本周恢复抽检 ${o.samplingSuccess}/${o.samplingTotal} 成功`
  }
  if (arg) return byKey[arg] || `（未知的备份指标：${arg}）`
  return [...Object.values(byKey), `- 备份服务 ${r.data.services.length} 个 · 备份存储 ${r.data.storages.length} 个`].join('\n')
}

async function secBackupObjects(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.backup(ctx)
  if (!r.ok || !r.data) return fail(r)
  const list = r.data.objects
  if (!list.length) return '（没有可备份的集群）'
  const lines: string[] = [
    table(
      ['集群', '状态', 'OB 版本', '备份策略', '调度状态', '集群形态', '租户数'],
      list.map((o) => [
        o.clusterName,
        o.obClusterStatus || '—',
        o.obVersion || '—',
        o.backupStatus === 'HAS_BACKUP_STRATEGY' ? '已建策略' : '未建策略',
        o.scheduleStatus || 'NONE',
        o.primaryAndStandbyMode ? '主备' : '普通',
        o.tenants.length
      ])
    )
  ]
  const withTenants = list.filter((o) => o.tenants.length)
  for (const o of withTenants.slice(0, 6)) {
    lines.push(`- ${o.clusterName} 租户：${o.tenants.map((t) => `${t.tenantName}(${t.backupStatus}/${t.scheduleStatus || 'NONE'})`).join('、')}`)
  }
  return clip(lines.join('\n'), 5000)
}

async function secBackupTasks(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.backup(ctx)
  if (!r.ok || !r.data) return fail(r)
  const out: string[] = []
  const labels: Record<string, string> = { data: '数据备份', log: '日志备份', restore: '恢复', clean: '清理过期数据' }
  for (const kind of ['data', 'log', 'restore', 'clean'] as const) {
    const rows = r.data.tasks[kind] || []
    if (!rows.length) {
      out.push(`- ${labels[kind]}：暂无任务`)
      continue
    }
    out.push(`- ${labels[kind]}：${rows.length} 条，最近 ${rows.slice(0, 8).map((t) => `${t.name || '#' + t.id} ${t.status || ''} ${t.startTime ? ts(t.startTime) : ''}`.trim()).join('；')}`)
  }
  return clip(out.join('\n'), 4000)
}

// ---------- 巡检 ----------

const inspTypeText = (t: string): string => (t === 'OB_CLUSTER' ? '集群' : t === 'OB_TENANT' ? '租户' : t === 'OB_PROXY' ? 'OBProxy' : t || '—')

async function secInspectionOverview(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.inspection(ctx)
  if (!r.ok || !r.data) return fail(r)
  const lines: string[] = []
  for (const type of ['OB_CLUSTER', 'OB_TENANT', 'OB_PROXY'] as const) {
    const rows = r.data.overviews[type] || []
    if (!rows.length) continue
    for (const o of rows) {
      const l = o.latest
      lines.push(
        `- [${inspTypeText(type)}] ${o.object.name || '#' + o.object.objectId}：${l ? `最近 ${ts(l.startTime)}，高 ${l.high} / 中 ${l.medium} / 低 ${l.low}，巡检项 ${l.itemFinished}/${l.itemTotal}，${l.tag || '—'}` : '未巡检'}；调度 ${o.scheduleState || 'INACTIVE'}`
      )
    }
  }
  return lines.length ? clip(lines.join('\n'), 5000) : '（还没有巡检对象数据）'
}

async function secInspectionReports(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.inspection(ctx)
  if (!r.ok || !r.data) return fail(r)
  const list = r.data.tasks.slice(0, 20)
  if (!list.length) return '（还没有巡检报告）'
  return clip(
    table(
      ['报告', '对象', '类型', '巡检集', '开始', '耗时', '高', '中', '低', '状态'],
      list.map((t) => [
        `#${t.id}`,
        t.object.name || '—',
        inspTypeText(t.object.type),
        t.tag || '—',
        ts(t.startTime),
        t.endTime ? `${Math.max(0, Math.round((new Date(t.endTime).getTime() - new Date(t.startTime).getTime()) / 1000))}s` : '—',
        t.high,
        t.medium,
        t.low,
        t.state || '—'
      ])
    ),
    4000
  )
}

// ---------- 平台管理 ----------

async function secPlatformUsers(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.platform(ctx)
  if (!r.ok || !r.data) return fail(r)
  const out: string[] = []
  out.push(`用户 ${r.data.users.length} 个：`)
  for (const u of r.data.users) {
    out.push(
      `- ${u.username}（${u.roles.join('/') || '无角色'}）${u.enabled ? '' : ' 已禁用'}${u.locked ? ' 已锁定' : ''}${u.accountExpired ? ' 已过期' : ''} · ${u.origin || '—'} · ${u.email || '—'} · 最近改密 ${u.lastPasswordChange ? ts(u.lastPasswordChange) : '—'}`
    )
  }
  out.push(`\n角色 ${r.data.roles.length} 个：`)
  for (const ro of r.data.roles) {
    out.push(`- ${ro.name}（${ro.type === 'DEFAULT' ? '内置' : '自定义'}）：用户 ${ro.userCount}，权限 ${ro.permissionCount}${ro.description ? `；${ro.description}` : ''}`)
  }
  return clip(out.join('\n'), 5000)
}

async function secPlatformParams(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.platform(ctx)
  if (!r.ok || !r.data) return fail(r)
  const list = r.data.properties.slice(0, 60)
  if (!list.length) return '（读取不到平台参数）'
  return clip(
    `${table(
      ['参数', '当前值', '运行值', '类型', '需重启'],
      list.map((p) => [p.key, p.value || '—', p.runningValue || '—', p.type || '—', p.needRestart ? '是' : '否'])
    )}\n（共 ${r.data.propertyTotal} 项，这里只列前 60 项）`,
    5000
  )
}

async function secPlatformLogins(get: Fetcher, ctx: Ctx): Promise<string> {
  const r = await get.platform(ctx)
  if (!r.ok || !r.data) return fail(r)
  const list = r.data.logins.slice(0, 20)
  if (!list.length) return '（没有登录记录）'
  return clip(
    `${table(
      ['时间', '用户', '来源 IP', '结果', '客户端'],
      list.map((l) => [ts(l.loginTime), l.username || `#${l.userId}`, l.clientAddress || '—', l.loginResult || '—', (l.userAgent || '—').slice(0, 40)])
    )}\n（共 ${r.data.loginTotal} 条记录，这里只列最近 20 条）`,
    4000
  )
}

/** 每个子模块一个渲染入口（导出供单测直接喂假 Fetcher） */
export async function renderSection(key: CloudAiSectionKey, get: Fetcher, ctx: Ctx, platformId: string): Promise<string> {
  const { base, arg } = splitSectionKey(key)
  switch (base) {
    case 'overview.kpi': return secOverviewKpi(get, ctx, arg)
    case 'overview.clusters': return secOverviewClusters(get, ctx, arg)
    case 'overview.alarms': return secOverviewAlarms(get, ctx)
    case 'overview.tasks': return secOverviewTasks(get, ctx)
    case 'clusters.list': return secClustersList(get, ctx, arg)
    case 'clusters.capacity': return secClustersCapacity(get, ctx, arg)
    case 'clusters.alarms': return secClustersAlarms(get, ctx, arg)
    case 'clusters.topology': return secClustersTopology(get, ctx, arg)
    case 'clusters.params': return secClustersParams(get, ctx, arg)
    case 'tenants.list': return secTenantsList(get, ctx, arg)
    case 'tenants.distribution': return secTenantsDistribution(get, ctx)
    case 'tenants.unitSpecs': return secTenantsUnitSpecs(get, ctx)
    case 'hosts.list': return secHostsList(get, ctx, arg)
    case 'hosts.agent': return secHostsAgent(get, ctx)
    case 'hosts.services': return secHostsServices(get, ctx)
    case 'monitor.cluster': return secMonitorCluster(get, ctx, platformId, arg)
    case 'monitor.tenant': return secMonitorTenant(get, ctx, platformId, arg)
    case 'monitor.host': return secMonitorHost(get, ctx, platformId, arg)
    case 'sqldiag.top': return secSqlTop(get, ctx, platformId)
    case 'sqldiag.stats': return secSqlStats(get, ctx, platformId, arg)
    case 'alarms.active': return secAlarmsActive(get, ctx)
    case 'alarms.levels': return secAlarmsLevels(get, ctx, arg)
    case 'alarms.trend': return secAlarmsTrend(get, ctx)
    case 'alarms.rules': return secAlarmsRules(get, ctx)
    case 'tasks.list': return secTasksList(get, ctx)
    case 'tasks.stats': return secTasksStats(get, ctx)
    case 'obproxy.clusters': return secObproxyClusters(get, ctx)
    case 'obproxy.links': return secObproxyLinks(get, ctx)
    case 'backup.overview': return secBackupOverview(get, ctx, arg)
    case 'backup.objects': return secBackupObjects(get, ctx)
    case 'backup.tasks': return secBackupTasks(get, ctx)
    case 'inspection.overview': return secInspectionOverview(get, ctx)
    case 'inspection.reports': return secInspectionReports(get, ctx)
    case 'platform.users': return secPlatformUsers(get, ctx)
    case 'platform.params': return secPlatformParams(get, ctx)
    case 'platform.logins': return secPlatformLogins(get, ctx)
    default: return ''
  }
}

/**
 * 生成数据快照（Markdown）：只包含勾选的子模块，按模块分组；
 * 单个子模块失败只在该小节里标注，不影响其它小节。
 */
export async function buildCloudAiContext(platformId: string, sections: CloudAiSectionKey[]): Promise<string> {
  const picked = sections.filter(isSectionKey)
  const use = picked.length ? picked : (['overview.kpi'] as CloudAiSectionKey[])
  const ctx = new Ctx()
  const get = fetcher(platformId)
  const parts: string[] = []
  for (const m of CLOUD_AI_MODULES) {
    const mine = use.filter((k) => moduleOfSection(k) === m.key)
    if (!mine.length) continue
    parts.push(`### ${m.label}`)
    for (const key of mine) {
      const { base, arg } = splitSectionKey(key)
      const def = SECTION_MAP.get(base)
      let body = ''
      try {
        body = await renderSection(key, get, ctx, platformId)
      } catch (e: any) {
        body = `（读取失败：${e?.message || e}）`
      }
      const title = `${def?.label || base}${arg ? ` · ${argLabel(base, arg)}` : ''}`
      parts.push(`#### ${title}\n${body || '（无数据）'}`)
    }
  }
  let text = parts.join('\n\n')
  if (text.length > CONTEXT_MAX_CHARS) text = `${text.slice(0, CONTEXT_MAX_CHARS)}\n…（快照超长已截断）`
  return text
}

// ---------------------------------------------------------------- 提示词

/** 「总览（核心指标、集群容量）、告警（活跃告警）」 */
function scopeText(sections: CloudAiSectionKey[]): string {
  const groups: string[] = []
  for (const m of CLOUD_AI_MODULES) {
    const mine = sections
      .filter((k) => moduleOfSection(k) === m.key)
      .map((k) => {
        const { base, arg } = splitSectionKey(k)
        const label = SECTION_MAP.get(base)?.label || base
        return arg ? `${label}·${argLabel(base, arg)}` : label
      })
    if (mine.length) groups.push(`${m.label}（${mine.join('、')}）`)
  }
  return groups.join('、') || '未选择'
}

/** 本次没勾、但可以用来说服用户「去勾哪块」的候选 */
function missingSections(sections: CloudAiSectionKey[]): string {
  return CLOUD_AI_SECTIONS.filter((s) => !sections.includes(s.key))
    .map((s) => `${CLOUD_AI_MODULES.find((m) => m.key === s.module)?.label || s.module} → ${s.label}`)
    .join('；')
}

function systemPrompt(s: CloudAiSession, skillText = ''): string {
  return [
    '你是 SQLPilot 内置的「云管平台 AI 助手」，服务对象是 OceanBase 的 DBA 与运维人员。',
    '',
    '## 当前会话',
    `- 平台：${s.platformName || s.platformId}`,
    `- 读取范围：${scopeText(s.sections)}`,
    `- 数据快照时间：${ts(new Date(s.contextAt).toISOString())}`,
    '- 快照是开始对话（或手动刷新）时从 OCP 接口拉取的静态数据，不是你实时查询的结果；用户问「现在」时按快照口径回答，并注明快照时间。',
    '',
    '## 回答要求',
    '1. 只依据下面的数据快照作答；快照里没有的信息要明确说明「当前快照里没有这项数据」，并从「可补充的子模块」里指出需要勾选哪一项，禁止编造集群/租户/主机名或数值。',
    '2. 中文回答，简洁、可执行。给结论时带上关键数字（如「memstore 水位 92%」）。',
    '3. 列表用 Markdown 表格（不超过 6 列）；排查步骤用有序列表，结尾给「建议下一步」。',
    '4. 涉及变更或 SQL 时，给出可执行的 SQL / OCP 操作路径（菜单位置），并提醒先评估影响、必要时走变更窗口。',
    '5. 只讨论云管平台内的集群、租户、主机、监控、SQL、告警、任务话题；无关问题一句话带过并引导回运维场景。',
    '',
    '## 可补充的子模块（本次未读取）',
    missingSections(s.sections) || '（已全选）',
    '',
    '## 数据快照',
    s.context || '（本次对话没有可用数据，请提示用户重新勾选子模块或刷新数据）',
    // 技能放在快照之后：模型先看到「能看什么数据」，再看到「按什么规范回答」
    skillText
  ]
    .filter((x) => x !== '')
    .join('\n')
}

// ---------------------------------------------------------------- 对话

function trimMessages(s: CloudAiSession): void {
  if (s.messages.length > MAX_MESSAGES) s.messages = s.messages.slice(s.messages.length - MAX_MESSAGES)
}

function titleOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 28 ? `${t.slice(0, 28)}…` : t || '新对话'
}

/**
 * 发起一轮问答：sessionId 为空时新建会话（按 sections 生成快照）。
 * 返回 ok 表示已受理，正文通过 cloud:ai:event 流式回传。
 */
export async function askCloudAi(input: CloudAiAskInput): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const text = String(input.text || '').trim()
  if (!text) return { ok: false, error: '请输入问题' }

  const cfg = loadConfig()
  const provider = cfg.providers.find((p) => p.id === cfg.activeProviderId) || cfg.providers[0]
  if (!provider) return { ok: false, error: '尚未配置大模型：请先在「设置」里选择厂商和模型' }

  let session = input.sessionId ? findSession(input.sessionId) : undefined
  if (session && running.has(session.id)) return { ok: false, error: '上一条还在生成中，请等待完成或先停止' }

  const isNew = !session
  if (!session) {
    const platformName = input.platformName || svc.listPlatforms().find((p) => p.id === input.platformId)?.name || ''
    session = newSession({ platformId: input.platformId, platformName, sections: (input.sections || []).filter(isSectionKey) })
  }
  const sess = session
  if (isNew && input.sections?.length) {
    sess.sections = input.sections.filter(isSectionKey)
    sess.modules = modulesOfSections(sess.sections)
  }

  sess.messages.push({ id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, role: 'user', text, at: Date.now() })
  if (isNew || sess.messages.length === 1) sess.title = titleOf(text)
  sess.updatedAt = Date.now()
  trimMessages(sess)
  saveStore()

  const sessionId = sess.id
  // 技能正文（勾了才有）：不挂工具，直接作为「回答规范」拼进系统提示
  const skillText = skillBlockFor(input.skills)
  const ctrl = new AbortController()
  running.set(sessionId, ctrl)
  /** 已经流出的正文（停止时落库，别让半截回答消失） */
  let streamed = ''
  // 立即返回，流式过程通过事件推送（IPC handle 不应等整段生成）
  void (async () => {
    try {
      // 首次对话或快照过期时重建；失败也继续（快照里写明原因）
      if (!sess.context || Date.now() - sess.contextAt > 30 * 60_000) {
        send({ type: 'building', sessionId })
        try {
          sess.context = await buildCloudAiContext(sess.platformId, sess.sections)
        } catch (e: any) {
          sess.context = `（数据快照读取失败：${e?.message || e}）`
        }
        sess.contextAt = Date.now()
        saveStore()
        send({ type: 'context', sessionId, contextAt: sess.contextAt, contextChars: sess.context.length })
      }

      send({ type: 'start', sessionId })
      const history: ChatMsg[] = sess.messages.map((m) => ({ role: m.role, content: m.text }))
      let pending = ''
      let timer: ReturnType<typeof setTimeout> | null = null
      /** 思考流累计字数（只用于提示，不落库） */
      let reasoningChars = 0
      let rtimer: ReturnType<typeof setTimeout> | null = null
      const flush = (): void => {
        timer = null
        if (!pending) return
        send({ type: 'delta', sessionId, text: pending })
        pending = ''
      }
      const res = await callLlm(provider, systemPrompt(sess, skillText), history, [], {
        onText: (t: string) => {
          streamed += t
          pending += t
          // 合并 50ms 内的片段再发 IPC，避免逐字刷新把渲染层压死
          if (!timer) timer = setTimeout(flush, 50)
        },
        onReasoning: (t: string) => {
          reasoningChars += t.length
          if (!rtimer) {
            rtimer = setTimeout(() => {
              rtimer = null
              send({ type: 'reasoning', sessionId, chars: reasoningChars })
            }, 300)
          }
        }
      }, { signal: ctrl.signal })
      if (timer) clearTimeout(timer)
      if (rtimer) clearTimeout(rtimer)
      flush()

      const finalText = (res.content || streamed).trim()
      const msg: CloudAiMessage = {
        id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        text: finalText || '（模型没有返回内容）',
        at: Date.now()
      }
      sess.messages.push(msg)
      sess.updatedAt = Date.now()
      trimMessages(sess)
      saveStore()
      send({ type: 'done', sessionId, message: msg, meta: metaOf(sess) })
    } catch (e: any) {
      const aborted = e?.name === 'AbortError' || ctrl.signal.aborted
      const err = aborted ? '已停止生成' : e?.message || String(e)
      // 停止时把已产生的半截内容留在会话里（用户能看到已经答了什么）
      const partial = streamed.trim()
      if (partial) {
        sess.messages.push({
          id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          role: 'assistant',
          text: `${partial}\n\n> （回答被中断：${err}）`,
          at: Date.now()
        })
        trimMessages(sess)
      }
      sess.updatedAt = Date.now()
      saveStore()
      send({ type: 'error', sessionId, error: err })
    } finally {
      running.delete(sessionId)
    }
  })()

  return { ok: true, sessionId }
}

/** 重建快照（界面「刷新数据」）：只刷数据，不动对话历史 */
export async function refreshCloudAiContext(sessionId: string): Promise<{ ok: boolean; contextAt?: number; contextChars?: number; error?: string }> {
  const s = findSession(sessionId)
  if (!s) return { ok: false, error: '会话不存在' }
  if (running.has(sessionId)) return { ok: false, error: '生成中不能刷新数据' }
  send({ type: 'building', sessionId })
  try {
    s.context = await buildCloudAiContext(s.platformId, s.sections)
    s.contextAt = Date.now()
    saveStore()
    send({ type: 'context', sessionId, contextAt: s.contextAt, contextChars: s.context.length })
    return { ok: true, contextAt: s.contextAt, contextChars: s.context.length }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 切换会话的读取范围（子模块级）：对话历史保留，快照立刻重建 */
export async function setCloudAiSections(sessionId: string, sections: CloudAiSectionKey[]): Promise<{ ok: boolean; error?: string }> {
  const s = findSession(sessionId)
  if (!s) return { ok: false, error: '会话不存在' }
  if (running.has(sessionId)) return { ok: false, error: '生成中不能修改范围' }
  const picked = sections.filter(isSectionKey)
  s.sections = picked.length ? picked : (['overview.kpi'] as CloudAiSectionKey[])
  s.modules = modulesOfSections(s.sections)
  s.updatedAt = Date.now()
  s.context = ''
  s.contextAt = 0
  saveStore()
  try {
    s.context = await buildCloudAiContext(s.platformId, s.sections)
    s.contextAt = Date.now()
    saveStore()
    send({ type: 'context', sessionId, contextAt: s.contextAt, contextChars: s.context.length })
  } catch (e: any) {
    s.context = `（数据快照读取失败：${e?.message || e}）`
    s.contextAt = Date.now()
    saveStore()
  }
  return { ok: true }
}
