/**
 * Oracle 云平台 · AI 助手（主进程）
 *
 * 与 OCP 的 AI 助手（`../ai.ts`）同构，但取数方式完全不同：
 * - OCP 是调平台 REST 接口；Oracle 是直接查 v$ / dba_ 视图；
 * - 读取范围 = 「环境（哪一套库）× 单元（概要 / 14 个 tab）× 细分块（某个指标 / 卡片 / 子表）」，
 *   key 形如 `ora:<环境id>:storage`（整块）或 `ora:<环境id>:storage:fra`（只读 FRA）；
 * - 快照复用 `cloudOracleSection` 的 45 秒缓存，同一单元不会重复查库；
 * - 会话落在 userData/cloud-ai-oracle.json，与 OCP 的会话互不干扰。
 *
 * 粒度与 OCP 侧对齐：既能整块勾（一个 tab），也能只勾某个指标（如「核心指标 · 用户会话」），
 * 细块在快照里各带小标题，模型不会把没勾的数据混进来。
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { callLlm } from '../../agent/llm'
import { skillBlockFor } from '../../skill-context'
import { loadConfig } from '../../config'
import { writeFileAtomic } from '../../atomic'
import type { ChatMsg } from '../../types'
import * as svc from '../service'
import type {
  CloudOraclePlatform,
  OraAlerts,
  OraBackup,
  OraDg,
  OraEnvSummary,
  OraInstanceDetail,
  OraJobs,
  OraOverview,
  OraParams,
  OraPdbSection,
  OraPerf,
  OraRac,
  OraSessions,
  OraSqlSection,
  OraStorage,
  OraUsers
} from './types'

// ---------------------------------------------------------------- 单元目录

/** 一套环境里可被 AI 读取的单元：概要 + 14 个 tab */
export type OraAiUnit =
  | 'summary'
  | 'overview'
  | 'rac'
  | 'instances'
  | 'pdb'
  | 'storage'
  | 'sessions'
  | 'sql'
  | 'perf'
  | 'alerts'
  | 'backup'
  | 'dg'
  | 'jobs'
  | 'params'
  | 'users'

export const ORA_AI_UNITS: { key: OraAiUnit; label: string; desc: string }[] = [
  { key: 'summary', label: '环境概要', desc: '版本 / 角色 / 实例 / 会话 / 表空间最高水位 / 阻塞 / 失效对象（每套环境 7 条 SQL）' },
  { key: 'overview', label: '总览', desc: '库状态、KPI、待处理问题、表空间水位、等待 TOP、实时指标' },
  { key: 'rac', label: 'RAC 集群', desc: '实例与节点、服务分布、私网互通（单实例会说明不是 RAC）' },
  { key: 'instances', label: '实例', desc: 'SGA/PGA、资源限制、OS CPU/内存/load、缓冲池命中' },
  { key: 'pdb', label: '容器与 PDB', desc: 'CDB/PDB 打开状态与各容器数据文件占用' },
  { key: 'storage', label: '存储', desc: '表空间 / 临时 / UNDO / 数据文件 / ASM / FRA / 归档目标 / 在线日志' },
  { key: 'sessions', label: '会话与锁', desc: '会话明细、阻塞链（含阻塞者 SQL）、长操作进度' },
  { key: 'sql', label: 'SQL 诊断', desc: 'TopSQL（耗时/CPU/逻辑读/物理读）+ AWR 历史 TOP' },
  { key: 'perf', label: '性能与等待', desc: 'sysmetric / 系统等待 / ASH / SGA / PGA / OS 统计' },
  { key: 'alerts', label: '告警日志', desc: '告警聚类（去数字模板）、按小时分布、ORA- 错误' },
  { key: 'backup', label: '备份恢复', desc: 'RMAN 作业与备份集、归档量、FRA 水位' },
  { key: 'dg', label: 'Data Guard', desc: '应用/传输延迟、归档目标、MRP 进程' },
  { key: 'jobs', label: '作业调度', desc: 'Scheduler / DBMS_JOB 与最近运行结果' },
  { key: 'params', label: '参数', desc: '非默认参数与关键参数（含是否可动态修改）' },
  { key: 'users', label: '用户与对象', desc: '账号状态与过期、SYSDBA、失效对象、大对象 TOP' }
]

/** 会话归属的「平台」标识：Oracle 是多环境，历史对话统一按这个口子归集 */
export const ORA_AI_PLATFORM_ID = 'oracle'

/** `ora:<envId>:<unit>`（整块）或 `ora:<envId>:<unit>:<part>`（只读某一块指标/卡片） */
export type OraAiSectionKey = string

const KEY_RE = /^ora:([^:]+):([a-z]+)(?::([A-Za-z0-9_.-]+))?$/

/** 解析后的读取范围：part 为空 = 整个单元 */
export interface OraAiKeyParts {
  envId: string
  unit: OraAiUnit
  part: string
}

export function isOraAiKey(key: unknown): key is OraAiSectionKey {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return false
  const p = parseKey(key)
  if (!p) return false
  if (!p.part) return true
  // 细分块必须在目录里，避免脏 key（旧会话 / 手改）带进 prompt
  const { base, arg } = splitPart(p.part)
  const def = ORA_AI_PARTS[p.unit]?.find((x) => x.key === base)
  if (!def) return false
  if (arg && !def.dynamicArgs && !def.args?.some((x) => x.key === arg)) return false
  return true
}

function parseKey(key: string): OraAiKeyParts | null {
  const m = KEY_RE.exec(String(key || ''))
  if (!m) return null
  const unit = ORA_AI_UNITS.find((u) => u.key === m[2])
  return unit ? { envId: m[1], unit: unit.key, part: m[3] || '' } : null
}

function unitOf(key: string): OraAiUnit | null {
  return parseKey(key)?.unit ?? null
}

export function oraAiUnitLabel(unit: OraAiUnit): string {
  return ORA_AI_UNITS.find((u) => u.key === unit)?.label || unit
}

/** `ora:a:storage:fra` → 「存储 · FRA 闪回区」；整块给「存储」 */
export function oraAiKeyLabel(key: string): string {
  const p = parseKey(key)
  if (!p) return key
  const base = oraAiUnitLabel(p.unit)
  return p.part ? `${base} · ${oraAiPartLabel(p.unit, p.part)}` : base
}

// ---------------------------------------------------------------- 会话类型与持久化

export interface OraAiMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
}

export interface OraAiSessionMeta {
  id: string
  title: string
  /** 固定为 ORA_AI_PLATFORM_ID（多环境共用一套历史） */
  platformId: string
  platformName: string
  sections: OraAiSectionKey[]
  /** 由 sections 推导的涉及环境 id（列表展示用） */
  envIds: string[]
  createdAt: number
  updatedAt: number
  messageCount: number
  contextAt: number
  contextChars: number
}

export interface OraAiSession extends OraAiSessionMeta {
  context: string
  messages: OraAiMessage[]
}

export type OraAiEvent =
  | { type: 'building'; sessionId: string }
  | { type: 'context'; sessionId: string; contextAt: number; contextChars: number }
  | { type: 'start'; sessionId: string }
  | { type: 'reasoning'; sessionId: string; chars: number }
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'done'; sessionId: string; message: OraAiMessage; meta: OraAiSessionMeta }
  | { type: 'error'; sessionId: string; error: string }

export interface OraAiAskInput {
  sessionId?: string | null
  sections?: OraAiSectionKey[]
  text: string
  /** 本次对话启用的技能 id（正文拼进系统提示，不挂工具） */
  skills?: string[]
}

const MAX_SESSIONS = 40
const MAX_MESSAGES = 80
const CONTEXT_MAX_CHARS = 30_000

interface StoreShape {
  sessions: OraAiSession[]
}

let cache: StoreShape | null = null
const running = new Map<string, AbortController>()
let send: (ev: OraAiEvent) => void = () => {}

export function bindOraAiEmitter(fn: (ev: OraAiEvent) => void): void {
  send = fn
}

function storeFile(): string {
  return path.join(app.getPath('userData'), 'cloud-ai-oracle.json')
}

function normalizeSession(raw: any): OraAiSession | null {
  if (!raw?.id) return null
  const sections: OraAiSectionKey[] = Array.isArray(raw.sections) ? raw.sections.filter(isOraAiKey) : []
  const messages: OraAiMessage[] = Array.isArray(raw.messages)
    ? raw.messages.filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    : []
  return {
    id: String(raw.id),
    title: String(raw.title || '新对话'),
    platformId: ORA_AI_PLATFORM_ID,
    platformName: String(raw.platformName || 'Oracle'),
    sections,
    envIds: envIdsOf(sections),
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
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as { sessions?: any[] }
    cache = { sessions: Array.isArray(data?.sessions) ? (data.sessions.map(normalizeSession).filter((s): s is OraAiSession => !!s)) : [] }
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
    /* 磁盘异常不影响本轮对话 */
  }
}

function envIdsOf(sections: OraAiSectionKey[]): string[] {
  const out: string[] = []
  for (const k of sections) {
    const p = parseKey(k)
    if (p && !out.includes(p.envId)) out.push(p.envId)
  }
  return out
}

function metaOf(s: OraAiSession): OraAiSessionMeta {
  return {
    id: s.id,
    title: s.title,
    platformId: s.platformId,
    platformName: s.platformName,
    sections: s.sections,
    envIds: envIdsOf(s.sections),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
    contextAt: s.contextAt,
    contextChars: s.context.length
  }
}

function findSession(id: string): OraAiSession | undefined {
  return loadStore().sessions.find((s) => s.id === id)
}

export function listOraAiSessions(): OraAiSessionMeta[] {
  return loadStore().sessions.sort((a, b) => b.updatedAt - a.updatedAt).map(metaOf)
}

export function getOraAiSession(id: string): OraAiSession | null {
  return findSession(id) || null
}

export function deleteOraAiSession(id: string): { ok: boolean } {
  const store = loadStore()
  store.sessions = store.sessions.filter((s) => s.id !== id)
  running.get(id)?.abort()
  running.delete(id)
  saveStore()
  return { ok: true }
}

export function stopOraAi(id: string): { ok: boolean } {
  running.get(id)?.abort()
  return { ok: true }
}

function newSession(sections: OraAiSectionKey[]): OraAiSession {
  const store = loadStore()
  const now = Date.now()
  const s: OraAiSession = {
    id: `oai_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title: '新对话',
    platformId: ORA_AI_PLATFORM_ID,
    platformName: 'Oracle',
    sections,
    envIds: envIdsOf(sections),
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
  return s
}

// ---------------------------------------------------------------- 数据快照

function num(v: any, digits = 0): string {
  const n = Number(v)
  return Number.isFinite(n) ? (digits ? n.toFixed(digits) : String(Math.round(n))) : '—'
}

function table(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  return [head, sep, ...rows.map((r) => `| ${r.map((c) => String(c ?? '')).join(' | ')} |`)].join('\n')
}

function clip(s: string, max = 3000): string {
  return s.length > max ? `${s.slice(0, max)}\n…（本小节超长已截断）` : s
}

/** 「1.8 G」这类大小 */
function gb(mb: number): string {
  const n = Number(mb) || 0
  return n >= 1024 ? `${(n / 1024).toFixed(1)} G` : `${n.toFixed(0)} M`
}

/** 一个单元内的细分块：AI 可以只勾其中一块（如「核心指标 · 用户会话」） */
export interface OraAiPartDef {
  key: string
  label: string
  desc: string
  /** 支持再按参数细分（如 KPI 磁贴）：参数写成 `key.arg` */
  args?: { key: string; label: string }[]
  /** 参数是运行期数据（实例名这类），不写死 args 目录 */
  dynamicArgs?: boolean
  render: (d: any, arg: string) => string
}

/** 按实例名过滤（RAC 多个实例时，勾某一块 = 只读那一个实例的这块） */
function pickInst<T extends { instanceName: string }>(list: T[], arg: string): T[] {
  return arg ? list.filter((x) => x.instanceName === arg) : list
}

/** `kpi.orKpiSess` → { base: 'kpi', arg: 'orKpiSess' } */
export function splitPart(part: string): { base: string; arg: string } {
  const i = String(part || '').indexOf('.')
  return i < 0 ? { base: String(part || ''), arg: '' } : { base: String(part).slice(0, i), arg: String(part).slice(i + 1) }
}

/**
 * 每个单元里可单独勾选的细分块。
 *
 * 粒度对齐 OCP 侧（`overview.kpi:hosts` 这种）：一个指标 / 一张卡片 / 一张子表都能单独勾。
 * 整块 key（`ora:<env>:<unit>`）= 该单元全部 part 拼起来，所以「整块」与「细块」可以混用，
 * 细块在 prompt 与快照里都带自己的小标题，模型不会把两块数据混在一起。
 */
export const ORA_AI_PARTS: Record<OraAiUnit, OraAiPartDef[]> = {
  summary: [
    {
      key: 'info',
      label: '版本与角色',
      desc: '版本 / 角色 / 打开模式 / 日志模式 / 拓扑 / 启动时间',
      render: (d: OraEnvSummary) =>
        [
          `- ${d.version || 'Oracle'} · ${d.databaseRole || '—'} · ${d.openMode || '—'} · ${d.logMode || '—'} · ${d.isRac ? 'RAC' : '单实例'}${d.isCdb ? ' · CDB' : ''}`,
          `- 实例 ${d.instancesOpen ?? 0}/${d.instances ?? 0} OPEN · 启动 ${d.startupTime || '—'}`
        ].join('\n')
    },
    {
      key: 'session',
      label: '会话与阻塞',
      desc: '用户会话 / 活跃会话 / 阻塞 / 长操作',
      render: (d: OraEnvSummary) => `- 会话 ${d.sessions ?? 0}（活跃 ${d.activeSessions ?? 0}）· 阻塞 ${d.blocking ?? 0} · 长操作 ${d.longops ?? 0}`
    },
    {
      key: 'space',
      label: '水位与失效对象',
      desc: '最高表空间水位 / 失效对象数',
      render: (d: OraEnvSummary) =>
        `- 最高表空间水位 ${d.tsWorst ? `${d.tsWorst.name} ${num(d.tsWorst.usedPct, 1)}%` : '—'} · 失效对象 ${d.invalid ?? 0}`
    }
  ],

  overview: [
    {
      key: 'kpi',
      label: '核心指标',
      desc: '每个磁贴一项，可只勾其中某个指标',
      args: [
        { key: 'orKpiInst', label: '实例数量' },
        { key: 'orKpiDb', label: '库状态' },
        { key: 'orKpiSess', label: '用户会话' },
        { key: 'orKpiTps', label: '每秒事务' },
        { key: 'orKpiCpu', label: 'DB CPU 占比' },
        { key: 'orKpiBlock', label: '阻塞会话' },
        { key: 'orKpiTs', label: '表空间告警' },
        { key: 'orKpiInvalid', label: '失效对象' }
      ],
      render: (d: OraOverview, arg: string) => {
        const list = (d.kpis || []).filter((k: any) => !arg || k.src === arg)
        return list.length ? list.map((k: any) => `- ${k.label}：${k.value}${k.sub ? `（${k.sub}）` : ''}`).join('\n') : '（没有这一项指标）'
      }
    },
    {
      key: 'issues',
      label: '需要关注',
      desc: '按本地规则推导的待处理问题（水位 / 阻塞 / 失效对象）',
      render: (d: OraOverview) =>
        (d.issues || []).length ? `需要关注：\n${d.issues.map((i: any) => `- [${i.level}] ${i.title}：${i.detail}`).join('\n')}` : '需要关注：无'
    },
    {
      key: 'info',
      label: '数据库信息',
      desc: 'DB Name / 角色 / 日志与保护模式 / 版本 / 拓扑 / 创建时间',
      render: (d: OraOverview) => {
        const i: any = d.info || {}
        return [
          `- DB Name=${i.dbName || '—'} · DB Unique=${i.dbUniqueName || '—'} · 角色=${i.databaseRole || '—'} · 打开模式=${i.openMode || '—'}`,
          `- 日志模式=${i.logMode || '—'} · 保护模式=${i.protectionMode || '—'} · 拓扑=${i.isRac ? 'RAC' : '单实例'}${i.isCdb ? ' · CDB' : ''} · 创建=${i.created || '—'}`,
          `- 版本：${i.version || '—'}`
        ].join('\n')
      }
    },
    {
      key: 'instances',
      label: '实例与会话',
      desc: '每个实例的主机、用户会话数、活跃会话数',
      render: (d: OraOverview) =>
        (d.instances || []).length
          ? `实例与会话：\n${(d.instances as any[]).map((i) => `- ${i.name}@${i.host}：会话 ${i.sessions} / 活跃 ${i.active}`).join('\n')}`
          : '（没有实例数据）'
    },
    {
      key: 'ts',
      label: '表空间水位',
      desc: 'TOP 10 表空间的已用 / 总量 / 使用率 / 自动扩展',
      render: (d: OraOverview) =>
        (d.tablespaces || []).length
          ? `表空间水位（TOP ${Math.min(d.tablespaces.length, 10)}）：\n${table(
              ['表空间', '已用/总量(M)', '使用率%', '自动扩展文件数'],
              d.tablespaces.slice(0, 10).map((t) => [t.name, `${num(t.usedMb)}/${num(t.sizeMb)}`, num(t.usedPct, 1), t.autoext])
            )}`
          : '（没有表空间数据）'
    },
    {
      key: 'waits',
      label: '累计等待 TOP',
      desc: '实例启动以来的非空闲等待事件',
      render: (d: OraOverview) =>
        (d.waits || []).length
          ? `累计等待 TOP：\n${table(['等待事件', '等待类', '累计秒'], d.waits.slice(0, 10).map((w) => [w.event, w.waitClass, num(w.timeS, 1)]))}`
          : ''
    },
    {
      key: 'alerts',
      label: '近 12 小时告警条目',
      desc: '按小时统计的告警日志条数',
      render: (d: OraOverview) =>
        (d.alertHours || []).length
          ? `近 12 小时告警条目：${d.alertHours
              .map((h: any) => `${h.hour} 时 ${h.count} 条`)
              .join(' · ')}（合计 ${d.alertHours.reduce((a: number, b: any) => a + b.count, 0)} 条）`
          : ''
    },
    {
      key: 'metrics',
      label: '实时指标',
      desc: 'v$sysmetric 近 60 秒的 TPS / AAS / CPU / 连接数',
      render: (d: OraOverview) =>
        (d.metrics || []).length ? `实时指标：${d.metrics.map((m) => `${m.name} ${num(m.value, 2)}${m.unit}`).join(' · ')}` : ''
    }
  ],

  rac: [
    {
      key: 'config',
      label: '集群配置',
      desc: 'cluster_database / 配置实例数 / 在线实例数 / 活跃实例',
      render: (d: OraRac) =>
        `- cluster_database=${d.clusterDatabase} · 配置实例数 ${d.configuredInstances} · 在线实例 ${d.nodes.length} · 活跃实例 ${(d as any).activeInstances?.length ?? 0}`
    },
    {
      key: 'nodes',
      label: '实例与节点',
      desc: '各实例状态 / 角色 / active_state / 启动时间 / 会话',
      render: (d: OraRac) =>
        d.nodes.length
          ? `实例与节点：\n${table(
              ['实例', '主机', '状态', '角色', 'active_state', '启动时间', '会话', '活跃'],
              d.nodes.map((n) => [n.instanceName, n.hostName, n.status, n.instanceRole, n.activeState, n.startupTime, n.sessions, n.active])
            )}`
          : '- 没有取到实例信息'
    },
    {
      key: 'sessions',
      label: '节点会话',
      desc: '每个节点上的用户会话数与活跃会话数',
      render: (d: OraRac) =>
        d.nodes.length ? d.nodes.map((n) => `- ${n.instanceName}@${n.hostName}：会话 ${n.sessions} / 活跃 ${n.active}`).join('\n') : ''
    },
    {
      key: 'services',
      label: '服务分布',
      desc: '每个实例注册了哪些服务',
      render: (d: OraRac) => (d.services.length ? `服务分布：${d.services.map((s) => `${s.name}@${s.instId}`).join(' · ')}` : '')
    },
    {
      key: 'interconnect',
      label: '私网互通',
      desc: 'RAC 节点间私网地址',
      render: (d: OraRac) =>
        d.interconnects.length ? `私网：${d.interconnects.map((i) => `${i.instId}:${i.ip}${i.name ? `(${i.name})` : ''}`).join(' · ')}` : ''
    }
  ],

  instances: [
    {
      key: 'detail',
      label: '实例明细',
      desc: '状态 / 内存 / 主机 CPU / processes / 优化器 / 兼容版本 / UNDO / open_cursors',
      dynamicArgs: true,
      render: (d: OraInstanceDetail[], arg: string) => {
        const list = pickInst(d, arg)
        return list.length
          ? table(
              ['实例', '主机', '状态', '启动时间', 'SGA', 'PGA', 'processes', 'sessions', 'CPU 核', '内存(G)', 'load', 'buffer miss'],
              list.map((i) => [
                i.instanceName,
                i.hostName,
                i.status,
                i.startupTime,
                gb(i.sgaMb),
                gb(i.pgaMb),
                i.processes,
                i.sessions,
                i.osCpus,
                num(i.osMemGb, 1),
                num(i.load, 2),
                i.bufferHit.map((b) => `${b.name} ${num(b.missPct, 2)}%`).join(' / ') || '—'
              ])
            )
          : '（没有实例数据）'
      }
    },
    {
      key: 'sga',
      label: 'SGA 组成',
      desc: 'Buffer Cache / Shared Pool / Redo Buffers 等',
      dynamicArgs: true,
      render: (d: OraInstanceDetail[], arg: string) => {
        const list = pickInst(d, arg)
        return list.length ? list.map((i) => `**${i.instanceName}** SGA：${i.sga.map((s) => `${s.name} ${gb(s.mb)}`).join(' · ') || '—'}`).join('\n') : ''
      }
    },
    {
      key: 'pga',
      label: 'PGA',
      desc: '聚合目标 / 已分配 / 缓存命中',
      dynamicArgs: true,
      render: (d: OraInstanceDetail[], arg: string) => {
        const list = pickInst(d, arg)
        return list.length ? list.map((i) => `**${i.instanceName}** PGA：${i.pga.map((p) => `${p.name} ${gb(p.mb)}`).join(' · ') || '—'}`).join('\n') : ''
      }
    },
    {
      key: 'res',
      label: '资源限制',
      desc: 'processes / sessions 等资源的 current 与 limit',
      dynamicArgs: true,
      render: (d: OraInstanceDetail[], arg: string) => {
        const list = pickInst(d, arg)
        return list.length ? list.map((i) => `**${i.instanceName}** 资源限制：${i.resource.map((r) => `${r.name} ${r.current}/${r.max}`).join(' · ') || '—'}`).join('\n') : ''
      }
    },
    {
      key: 'buffer',
      label: '缓冲池命中',
      desc: '各缓冲池的 miss 率',
      dynamicArgs: true,
      render: (d: OraInstanceDetail[], arg: string) => {
        const list = pickInst(d, arg)
        return list.length
          ? list.map((i) => `**${i.instanceName}** 缓冲池：${i.bufferHit.map((b) => `${b.name} miss ${num(b.missPct, 2)}%`).join(' · ') || '—'}`).join('\n')
          : ''
      }
    },
    {
      key: 'params',
      label: '实例参数',
      desc: 'db_block_size / compatible / optimizer_mode / cursor_sharing / open_cursors',
      dynamicArgs: true,
      render: (d: OraInstanceDetail[], arg: string) => {
        const list = pickInst(d, arg)
        return list.length
          ? list
              .map(
                (i) =>
                  `**${i.instanceName}** 参数：db_block_size=${i.dbBlockSize} · compatible=${i.compat} · optimizer_mode=${i.optimizerMode} · cursor_sharing=${i.cursorSharing} · open_cursors=${i.openCursors}`
              )
              .join('\n')
          : ''
      }
    }
  ],

  pdb: [
    {
      key: 'list',
      label: 'PDB 列表',
      desc: 'CDB 下各 PDB 的打开模式 / 受限 / 打开时间',
      render: (d: OraPdbSection) => {
        if (!d.isCdb) return `- 非 CDB（${d.note || 'v$pdbs 不存在'}）`
        return [
          `- CDB：是 · PDB ${d.pdbs.length} 个（打开 ${d.pdbs.filter((p) => p.openMode.includes('READ WRITE')).length} 个）`,
          d.pdbs.length ? `\n${table(['CON_ID', 'PDB', '打开模式', '受限', '打开时间'], d.pdbs.map((p) => [p.conId, p.name, p.openMode, p.restricted, p.openTime]))}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    },
    {
      key: 'files',
      label: '数据文件占用',
      desc: '各容器数据文件大小',
      render: (d: OraPdbSection) =>
        d.isCdb && d.files.length ? `数据文件占用：${d.files.map((f) => `${f.name} ${gb(f.sizeMb)}`).join(' · ')}` : ''
    }
  ],

  storage: [
    {
      key: 'tablespaces',
      label: '表空间',
      desc: '类型 / 已用 / 上限 / 文件数 / 自动扩展 / 状态（最多 20 个）',
      render: (d: OraStorage) =>
        d.tablespaces.length
          ? table(
              ['表空间', '类型', '已用/总量(M)', '使用率%', '上限(M)', '文件数', '自动扩展', '状态'],
              d.tablespaces.slice(0, 20).map((t) => [t.name, t.contents, `${num(t.usedMb)}/${num(t.sizeMb)}`, num(t.usedPct, 1), num(t.maxMb), t.files, t.autoext, t.status])
            )
          : '（没有表空间数据）'
    },
    {
      key: 'temp',
      label: '临时表空间',
      desc: '临时表空间已用 / 总量 / 使用率',
      render: (d: OraStorage) =>
        d.temp.length ? `临时表空间：\n${table(['名称', '已用/总量(M)', '使用率%'], d.temp.map((t) => [t.name, `${num(t.usedMb)}/${num(t.totalMb)}`, num(t.usedPct, 1)]))}` : ''
    },
    {
      key: 'undo',
      label: 'UNDO',
      desc: '最近几段的 undoblks / 事务数 / 最长查询 / ORA-01555 / 无空间错误',
      render: (d: OraStorage) =>
        d.undo.recent.length
          ? `UNDO 近几段（begin/end、undoblks、事务数、最长查询秒、ORA-01555、无空间错误）：\n${table(
              ['begin', 'end', 'undoblks', 'txn', 'maxquery', 'ssolderrcnt', 'nospaceerrcnt'],
              d.undo.recent.slice(-6).map((u) => [u.begin, u.end, u.undoblks, u.txnCount, u.maxQueryLen, u.ssolderrcnt, u.nospaceerrcnt])
            )}`
          : ''
    },
    {
      key: 'datafiles',
      label: '数据文件',
      desc: '文件总数、未开自动扩展的文件清单',
      render: (d: OraStorage) => {
        const bad = d.datafiles.filter((f) => f.autoextensible !== 'YES')
        return [
          `数据文件 ${d.datafiles.length} 个，未开自动扩展：${bad.length} 个`,
          bad.length ? bad.slice(0, 10).map((f) => `- ${f.tablespace}：${f.fileName} ${gb(f.sizeMb)}`).join('\n') : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    },
    {
      key: 'asm',
      label: 'ASM 磁盘组',
      desc: '类型 / 已用% / 可用容量 / 磁盘数 / 状态',
      render: (d: OraStorage) =>
        d.asm.length
          ? `ASM 磁盘组：\n${table(['名称', '类型', '已用%', '可用(M)', '磁盘数', '状态'], d.asm.map((a) => [a.name, a.type, num(a.usedPct, 1), a.usableMb, a.disks, a.state]))}`
          : ''
    },
    {
      key: 'fra',
      label: 'FRA 闪回区',
      desc: '已用 / 上限 / 可回收空间 / 各类文件占用',
      render: (d: OraStorage) =>
        d.fra
          ? `FRA：${num(d.fra.usedGb, 1)}/${num(d.fra.limitGb, 1)} GB（可用回收 ${num(d.fra.reclaimGb, 1)} GB）· 文件 ${d.fra.files} 个\n${table(
              ['类型', '占用%', '可回收%', '文件数'],
              d.fra.usage.map((u) => [u.type, num(u.usedPct, 1), num(u.reclaimPct, 1), u.files])
            )}`
          : ''
    },
    {
      key: 'archive',
      label: '归档目标',
      desc: '近 24h 归档量、各归档目标状态与 GAP',
      render: (d: OraStorage) =>
        d.archive.dests.length
          ? `归档目标（近 24h 归档 ${d.archive.last24h.count} 个 / ${num(d.archive.last24h.gb, 2)} GB）：\n${table(
              ['DEST', '状态', '目标', '同步', 'DB', 'GAP', '错误'],
              d.archive.dests.map((x) => [x.destId, x.status, x.destination, x.syncStatus, x.dbUnique, x.gapStatus, x.error])
            )}`
          : ''
    },
    {
      key: 'redo',
      label: '在线日志',
      desc: '日志组 / 线程 / 序号 / 大小 / 成员 / 状态 / 归档',
      render: (d: OraStorage) =>
        d.redo.length
          ? `在线日志：\n${table(['组', '线程', '序号', '大小(M)', '成员', '状态', '归档'], d.redo.map((r) => [r.group, r.thread, r.sequence, r.mb, r.members, r.status, r.archived]))}`
          : ''
    }
  ],

  sessions: [
    {
      key: 'dist',
      label: '会话分布',
      desc: '按类型/状态统计的会话数',
      render: (d: OraSessions) => `- 会话分布：${d.summary.map((s) => `${s.type}/${s.status} ${s.count}`).join(' · ') || '—'}`
    },
    {
      key: 'waitclass',
      label: '等待分类',
      desc: '按 wait_class 统计的会话数',
      render: (d: OraSessions) => `- 等待分类：${d.waitClass.map((w) => `${w.waitClass} ${w.count}`).join(' · ') || '—'}`
    },
    {
      key: 'blocking',
      label: '阻塞链',
      desc: '被阻塞会话、阻塞者、持锁类型与阻塞者 SQL',
      render: (d: OraSessions) =>
        d.blocking.length
          ? `阻塞链：\n${table(
              ['实例', '被阻塞 SID', '阻塞者 SID', '阻塞者用户', '阻塞者 SQL', '等待事件', '等待秒', '持锁类型'],
              d.blocking.slice(0, 15).map((b) => [b.instId, b.sid, b.blockerSid, b.blockerUser || '—', b.blockerSql || '—', b.event || '—', b.ctime, `${b.type}/${b.lmode}`])
            )}`
          : '阻塞链：无'
    },
    {
      key: 'longops',
      label: '长操作',
      desc: '长事务/长操作进度、剩余时间',
      render: (d: OraSessions) =>
        d.longops.length
          ? `长操作：\n${table(
              ['实例', 'SID', '操作', '对象', '进度%', '剩余秒', '已执行秒', 'SQL'],
              d.longops.slice(0, 10).map((l) => [l.instId, l.sid, l.opname, l.target, num(l.pct, 1), l.timeRemaining, num(l.elapsed), l.sqlId])
            )}`
          : ''
    },
    {
      key: 'list',
      label: '会话明细',
      desc: '用户会话最多 30 条：用户 / 状态 / 机器 / 事件 / SQL',
      render: (d: OraSessions) =>
        d.list.length
          ? `用户会话（最多 30 条，按最近活动）：\n${table(
              ['实例', 'SID', '用户', '状态', '机器', '事件', '等待类', '等待秒', 'SQL'],
              d.list.slice(0, 30).map((s) => [s.instId, s.sid, s.username, s.status, s.machine, s.event, s.waitClass, s.secondsInWait, s.sqlId])
            )}`
          : ''
    }
  ],

  sql: [
    {
      key: 'top',
      label: 'TopSQL',
      desc: '按当前排序维度取前 25 条（耗时/CPU/逻辑读/物理读）',
      render: (d: OraSqlSection) =>
        [
          `- 当前排序：${d.by}（elapsed/cpu/gets/disk）`,
          d.rows.length
            ? table(
                ['SQL_ID', '执行次数', '耗时(s)', 'CPU(s)', '平均(ms)', '逻辑读', '物理读', '每执行逻辑读', '用户', '模块'],
                d.rows.slice(0, 25).map((r) => [r.sqlId, r.executions, num(r.elapsedS, 2), num(r.cpuS, 2), num(r.avgMs, 2), r.bufferGets, r.diskReads, r.getsPerExec, r.schema, r.module || '—'])
              )
            : '（共享池里没有可统计的 SQL）'
        ].join('\n')
    },
    {
      key: 'awr',
      label: 'AWR 历史 TOP',
      desc: '近几个快照区间内的高消耗 SQL',
      render: (d: OraSqlSection) =>
        d.awr.length
          ? `AWR 历史 TOP${d.awrRange ? `（${d.awrRange}）` : ''}：\n${table(
              ['SQL_ID', '执行次数', '耗时(s)', 'CPU(s)', '逻辑读', '物理读'],
              d.awr.slice(0, 15).map((a) => [a.sqlId, a.executions, num(a.elapsedS, 2), num(a.cpuS, 2), a.gets, a.reads])
            )}`
          : ''
    },
    {
      key: 'plan',
      label: '执行计划',
      desc: '当前点开那条 SQL 的执行计划（没点开时为空）',
      render: (d: OraSqlSection) =>
        d.detail?.plan?.length
          ? `SQL ${d.detail.sqlId} 执行计划：\n${table(
              ['ID', '深度', '操作', '选项', '对象', 'Cost', 'Card', 'Bytes'],
              d.detail.plan.map((p) => [p.id, p.depth, p.operation, p.options || '—', p.objectName || '—', p.cost, p.cardinality, p.bytes])
            )}`
          : ''
    }
  ],

  perf: [
    {
      key: 'metrics',
      label: '实时指标',
      desc: 'v$sysmetric 关键指标',
      render: (d: OraPerf) => (d.metrics.length ? `实时指标：${d.metrics.map((m) => `${m.name} ${num(m.value, 2)}${m.unit}`).join(' · ')}` : '')
    },
    {
      key: 'events',
      label: '系统等待 TOP',
      desc: 'v$system_event 累计等待（次数 / 累计秒 / 平均）',
      render: (d: OraPerf) =>
        d.systemEvent.length
          ? `系统等待 TOP：\n${table(['等待事件', '等待类', '次数', '累计秒', '平均(ms)'], d.systemEvent.slice(0, 12).map((e) => [e.event, e.waitClass, e.totalWaits, num(e.timeS, 1), num(e.avgMs, 2)]))}`
          : ''
    },
    {
      key: 'ash',
      label: 'ASH 采样',
      desc: '活动会话采样：SQL / 事件 / 状态 / 采样数',
      render: (d: OraPerf) =>
        d.ash.length
          ? `ASH（${d.ashWindow}）：\n${table(['SQL', '事件', '状态', '采样数'], d.ash.slice(0, 12).map((a) => [a.sqlId || '—', a.event, a.state, a.samples]))}`
          : ''
    },
    {
      key: 'sysstat',
      label: '系统统计',
      desc: 'v$sysstat 关键计数',
      render: (d: OraPerf) => (d.sysstat.length ? `系统统计：${d.sysstat.slice(0, 12).map((s) => `${s.name} ${num(s.value)}`).join(' · ')}` : '')
    },
    {
      key: 'sga',
      label: 'SGA',
      desc: 'SGA 各内存池大小',
      render: (d: OraPerf) => (d.sga.length ? `SGA：${d.sga.map((s) => `${s.name} ${gb(s.mb)}`).join(' · ')}` : '')
    },
    {
      key: 'pga',
      label: 'PGA',
      desc: 'PGA 聚合与分配情况',
      render: (d: OraPerf) => (d.pga.length ? `PGA：${d.pga.map((p) => `${p.name} ${gb(p.mb)}`).join(' · ')}` : '')
    },
    {
      key: 'os',
      label: 'OS 统计',
      desc: 'v$osstat 主机 CPU / 内存 / load',
      render: (d: OraPerf) => (d.osstat.length ? `OS：${d.osstat.map((o) => `${o.name} ${num(o.value)}`).join(' · ')}` : '')
    }
  ],

  alerts: [
    {
      key: 'overview',
      label: '告警总量与分布',
      desc: '窗口内日志条数、ORA- 条数、按小时分布',
      render: (d: OraAlerts) =>
        [
          `- 窗口 ${d.hours}h · 日志 ${d.total} 条 · 含 ORA- ${d.errorCount} 条`,
          d.byHour.length ? `- 按小时：${d.byHour.map((h) => `${h.hour} ${h.count}${h.errors ? `(ORA- ${h.errors})` : ''}`).join(' · ')}` : ''
        ]
          .filter(Boolean)
          .join('\n')
    },
    {
      key: 'groups',
      label: '告警聚类',
      desc: '数字归一化后的模板 TOP（次数 / 首次 / 最近）',
      render: (d: OraAlerts) =>
        d.groups.length
          ? `聚类 TOP（数字已归一化）：\n${table(['次数', '首次', '最近', '含 ORA-', '模板'], d.groups.slice(0, 15).map((g) => [g.count, g.firstTs, g.lastTs, g.isError ? '是' : '', g.pattern]))}`
          : ''
    },
    {
      key: 'ora',
      label: 'ORA- 错误',
      desc: '最近的 ORA- 错误明细',
      render: (d: OraAlerts) => (d.ora.length ? `最近的 ORA- 错误：\n${d.ora.slice(0, 10).map((o) => `- ${o.ts} ${o.msg}`).join('\n')}` : '')
    },
    {
      key: 'recent',
      label: '最近日志',
      desc: '最近 10 条告警日志原文',
      render: (d: OraAlerts) =>
        d.recent.length ? `最近日志：\n${d.recent.slice(0, 10).map((r) => `- ${r.ts} [type=${r.type} level=${r.level}] ${r.msg}`).join('\n')}` : ''
    }
  ],

  backup: [
    {
      key: 'overview',
      label: '备份概况',
      desc: '最近一次全库备份、状态、24h 归档量、FRA 水位',
      render: (d: OraBackup) =>
        [
          `- 最近一次全库备份：${d.lastFull || '无'}（${d.lastStatus || '—'}）· 归档 24h ${d.archive.count24h} 个 / ${num(d.archive.gb24h, 2)} GB`,
          d.fra ? `- FRA：${num(d.fra.usedGb, 1)}/${num(d.fra.limitGb, 1)} GB（${num(d.fra.usedPct, 1)}%）` : ''
        ]
          .filter(Boolean)
          .join('\n')
    },
    {
      key: 'jobs',
      label: 'RMAN 作业',
      desc: '最近 10 个 RMAN 作业的状态 / 输入类型 / 耗时 / 输出',
      render: (d: OraBackup) =>
        d.jobs.length
          ? `RMAN 作业：\n${table(['开始', '结束', '状态', '输入类型', '设备', '耗时(s)', '输出(GB)'], d.jobs.slice(0, 10).map((j) => [j.startTime, j.endTime, j.status, j.inputType, j.device, num(j.elapsedS), num(j.outputGb, 2)]))}`
          : 'RMAN 作业：没有记录'
    },
    {
      key: 'sets',
      label: '备份集',
      desc: '最近 10 个备份集的类型 / 增量级别 / 大小 / 片数',
      render: (d: OraBackup) =>
        d.sets.length
          ? `备份集：\n${table(['RECID', '类型', '增量级别', '完成时间', '大小(GB)', '片数'], d.sets.slice(0, 10).map((s) => [s.recid, s.backupType, s.incremental || '—', s.done, num(s.gb, 2), s.pieces]))}`
          : ''
    }
  ],

  dg: [
    {
      key: 'overview',
      label: '角色与保护模式',
      desc: '当前是主库还是备库、保护模式',
      render: (d: OraDg) =>
        `- 当前角色：${d.role} · 保护模式：${d.protectionMode}${d.available ? '' : ' · 没有延迟统计（可能未配 Data Guard）'}`
    },
    {
      key: 'stats',
      label: '应用与传输延迟',
      desc: 'apply lag / transport lag 等实时延迟',
      render: (d: OraDg) => (d.stats.length ? `- 延迟：${d.stats.map((s) => `${s.name}=${s.value}${s.unit}`).join(' · ')}` : '（没有延迟统计）')
    },
    {
      key: 'dests',
      label: '归档目标',
      desc: '各目标状态 / 恢复模式 / 同步 / GAP / 序号差',
      render: (d: OraDg) =>
        d.dests.length
          ? `归档目标：\n${table(
              ['DEST', '状态', '类型', 'DB', '恢复模式', '同步', 'GAP', '序号差', '错误'],
              d.dests.map((x) => [x.destId, x.status, x.type, x.dbUnique, x.recoveryMode, x.synchronized, x.gapStatus, x.archivedSeq && x.appliedSeq ? x.archivedSeq - x.appliedSeq : '—', x.error])
            )}`
          : ''
    },
    {
      key: 'processes',
      label: 'DG 进程',
      desc: 'MRP / RFS 等进程状态与推进序号',
      render: (d: OraDg) =>
        d.processes.length
          ? `DG 进程：\n${table(['进程', '状态', '线程', '序号', '块'], d.processes.map((p) => [p.process, p.status, p.thread, p.sequence, p.block]))}`
          : ''
    }
  ],

  jobs: [
    {
      key: 'overview',
      label: '作业概况',
      desc: 'Scheduler / DBMS_JOB 数量与失败次数',
      render: (d: OraJobs) => {
        const bad = d.scheduler.filter((j) => Number(j.failureCount) > 0)
        return `- Scheduler ${d.scheduler.length} 个（失败过 ${bad.length} 个）· DBMS_JOB ${d.dbms.length} 个 · 运行历史 ${d.runs.length} 条`
      }
    },
    {
      key: 'scheduler',
      label: 'Scheduler 作业',
      desc: '启用状态 / 运行与失败次数 / 上次与下次运行',
      render: (d: OraJobs) => {
        const bad = d.scheduler.filter((j) => Number(j.failureCount) > 0)
        return d.scheduler.length
          ? `Scheduler 作业${bad.length ? `（优先列失败过的 ${Math.min(bad.length, 10)} 个）` : ''}：\n${table(
              ['owner', '作业', '启用', '状态', '运行次数', '失败次数', '上次运行', '下次运行'],
              (bad.length ? bad : d.scheduler).slice(0, 15).map((j) => [j.owner, j.jobName, j.enabled, j.state, j.runCount, j.failureCount, j.lastStart, j.nextRun])
            )}`
          : ''
      }
    },
    {
      key: 'dbms',
      label: 'DBMS_JOB',
      desc: 'JOB 号 / broken / 失败次数 / 上下次执行',
      render: (d: OraJobs) =>
        d.dbms.length
          ? `DBMS_JOB：\n${table(['JOB', '用户', 'broken', '失败次数', '上次', '下次'], d.dbms.slice(0, 10).map((j) => [j.job, j.logUser, j.broken, j.failures, j.lastDate, j.nextDate]))}`
          : ''
    },
    {
      key: 'runs',
      label: '最近运行',
      desc: '最近 15 条作业运行结果与错误信息',
      render: (d: OraJobs) =>
        d.runs.length
          ? `最近运行：\n${table(['owner', '作业', '状态', '开始', '耗时(s)', '信息'], d.runs.slice(0, 15).map((r) => [r.owner, r.jobName, r.status, r.startTime, num(r.durationS), r.info || '—']))}`
          : ''
    }
  ],

  params: [
    {
      key: 'key',
      label: '关键参数',
      desc: 'sga/pga/optimizer 等关键参数值与是否可动态改',
      render: (d: OraParams) => {
        const restart = d.key.filter((k) => String(k.modifiable).toUpperCase() === 'FALSE')
        return [
          `- 非默认参数 ${d.changed.length} 个 · 关键参数 ${d.key.length} 个（其中需重启才生效：${restart.map((k) => k.name).join('、') || '无'}）`,
          d.key.length
            ? `\n关键参数：\n${table(['参数', '值', '是否默认', '可动态改'], d.key.map((k) => [k.name, k.value, k.isDefault, k.modifiable]))}`
            : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    },
    {
      key: 'changed',
      label: '非默认参数',
      desc: '被改过的参数（最多 40 个）',
      render: (d: OraParams) =>
        d.changed.length
          ? `非默认参数（最多 40 个）：\n${table(['参数', '值', '可动态改', '说明'], d.changed.slice(0, 40).map((k) => [k.name, k.value, k.modifiable, k.desc]))}`
          : ''
    }
  ],

  users: [
    {
      key: 'list',
      label: '账号清单',
      desc: '账号状态 / 过期时间 / 默认表空间 / profile / 认证方式（最多 30 个）',
      render: (d: OraUsers) => {
        const notOpen = d.users.filter((u) => u.status !== 'OPEN')
        return [
          `- 账号 ${d.users.length} 个（非 OPEN ${notOpen.length} 个）· 对象 ${d.totalObjects} 个`,
          d.users.length
            ? `\n账号（最多 30 个）：\n${table(
                ['账号', '状态', '过期时间', '默认表空间', 'profile', '认证方式'],
                d.users.slice(0, 30).map((u) => [u.username, u.status, u.expiry || '—', u.defaultTs, u.profile, u.authType])
              )}`
            : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    },
    {
      key: 'summary',
      label: '账号概览',
      desc: '用户总数 / 锁定与过期 / 对象总数 / 失效对象',
      render: (d: OraUsers) => {
        const notOpen = d.users.filter((u) => u.status !== 'OPEN')
        const invalid = d.invalid.reduce((a, b) => a + b.count, 0)
        return `- 用户 ${d.users.length} 个（锁定/过期/非 OPEN ${notOpen.length} 个）· 对象总数 ${d.totalObjects} · 失效对象 ${invalid} 个`
      }
    },
    {
      key: 'pwfile',
      label: '特权账号',
      desc: 'v$pwfile_users 里的 SYSDBA / SYSOPER',
      render: (d: OraUsers) =>
        `特权账号（v$pwfile_users）：${d.pwfile.map((p) => `${p.username}${p.sysdba === 'TRUE' ? '(SYSDBA)' : ''}${p.sysoper === 'TRUE' ? '(SYSOPER)' : ''}`).join('、') || '—'}`
    },
    {
      key: 'roles',
      label: '当前用户角色',
      desc: '当前连接账号被直接授予的角色',
      render: (d: OraUsers) => (d.roles.length ? `当前用户角色：${d.roles.map((r) => r.role).join('、')}` : '')
    },
    {
      key: 'invalid',
      label: '失效对象',
      desc: '按 owner / 类型汇总的失效对象数量',
      render: (d: OraUsers) =>
        d.invalid.length
          ? `失效对象（共 ${d.invalid.reduce((a, b) => a + b.count, 0)} 个）：\n${table(['owner', '类型', '数量'], d.invalid.slice(0, 10).map((i) => [i.owner, i.objectType, i.count]))}`
          : ''
    },
    {
      key: 'objects',
      label: '对象分布',
      desc: '各对象类型数量汇总',
      render: (d: OraUsers) =>
        d.objectTypes.length ? `对象类型分布：${d.objectTypes.slice(0, 8).map((t) => `${t.objectType} ${t.count}`).join(' · ')}` : ''
    },
    {
      key: 'segments',
      label: '最大段 TOP',
      desc: '占用空间最大的段（表 / 索引）',
      render: (d: OraUsers) =>
        d.segments.length
          ? `最大段 TOP：\n${table(['owner', '段', '类型', '表空间', '大小(M)'], d.segments.slice(0, 10).map((s) => [s.owner, s.name, s.type, s.tablespace, num(s.mb, 1)]))}`
          : ''
    }
  ]
}

/**
 * 把一个单元的数据渲染成 Markdown。
 * 单独导出：单测可以直接喂构造数据，检查字段映射与空格、空数组不会崩。
 */
export function renderOraAiUnit(unit: OraAiUnit, data: any): string {
  const list = ORA_AI_PARTS[unit]
  if (!list) return `（未知的单元：${unit}）`
  try {
    const md = list
      .map((p) => {
        try {
          return p.render(data || {}, '') || ''
        } catch {
          return ''
        }
      })
      .filter((x) => x && x.trim())
      .join('\n\n')
    // 空数据时各段都被过滤掉了：给模型一句明确说明，别让它以为「一切正常」
    return md.trim() ? md : '（这一块没有取到数据）'
  } catch (e: any) {
    return `（渲染失败：${e?.message || e}）`
  }
}

/**
 * 渲染单个细分块（`kpi.orKpiSess` 这种 part 也支持）。
 * 单独导出：单测直接喂数据，检查细粒度勾选拿到的是不是「只有那一块」。
 */
export function renderOraAiPart(unit: OraAiUnit, part: string, data: any): string {
  const list = ORA_AI_PARTS[unit]
  if (!list) return `（未知的单元：${unit}）`
  const { base, arg } = splitPart(part)
  const def = list.find((p) => p.key === base)
  if (!def) return `（未知的块：${base}）`
  try {
    const md = def.render(data || {}, arg)
    return md && md.trim() ? md : '（这一块没有取到数据）'
  } catch (e: any) {
    return `（渲染失败：${e?.message || e}）`
  }
}

export interface OraAiCatalogPart {
  key: string
  label: string
  desc: string
  args: { key: string; label: string }[]
  /** 参数是运行期数据（如实例名），渲染层不能枚举 */
  dynamicArgs: boolean
}

export interface OraAiCatalogUnit {
  unit: OraAiUnit
  label: string
  desc: string
  parts: OraAiCatalogPart[]
}

/**
 * 目录（不含 render 函数）：渲染层拿它画勾选框名字与范围摘要。
 * 单一来源，避免渲染层再抄一份 60 多个细分块的文案。
 */
export function oraAiCatalog(): OraAiCatalogUnit[] {
  return ORA_AI_UNITS.map((u) => ({
    unit: u.key,
    label: u.label,
    desc: u.desc,
    parts: (ORA_AI_PARTS[u.key] || []).map((p) => ({
      key: p.key,
      label: p.label,
      desc: p.desc,
      args: p.args || [],
      dynamicArgs: !!p.dynamicArgs
    }))
  }))
}

/** 细分块的中文名（`storage.fra` → 「FRA 闪回区」） */
export function oraAiPartLabel(unit: OraAiUnit, part: string): string {
  const { base, arg } = splitPart(part)
  const def = ORA_AI_PARTS[unit]?.find((p) => p.key === base)
  if (!def) return part
  if (!arg) return def.label
  const argLabel = def.args?.find((a) => a.key === arg)?.label
  return argLabel ? `${def.label} · ${argLabel}` : `${def.label} · ${arg}`
}

/** 环境名与地址（快照标题用） */
function envTitle(envId: string): string {
  const p = (loadConfig().cloudPlatforms || []).find((x) => x.id === envId) as CloudOraclePlatform | undefined
  if (!p) return `环境 ${envId}`
  return `${p.name || envId}（${p.host}:${p.port}${p.serviceName ? `/${p.serviceName}` : ''}）`
}

/**
 * 取一个单元的数据并渲染。
 * parts 为 null 表示整块（14 个 tab 全读）；否则只渲染选中的细分块。
 */
async function renderUnit(envId: string, unit: OraAiUnit, parts: string[] | null): Promise<string> {
  let platform: CloudOraclePlatform
  try {
    platform = svc.getOraclePlatform(envId)
  } catch (e: any) {
    return `（环境不可用：${e?.message || e}）`
  }
  const section = unit === 'summary' ? 'env' : unit
  try {
    const r = await svc.cloudOracleSection(platform.id, section as any, {}, false)
    if (!r.ok || !r.data) return `（读取失败：${r.error || '没有数据'}）`
    // 细分块各带自己的小标题，模型能分清「哪一句来自哪个指标」
    const body = parts === null
      ? renderOraAiUnit(unit, r.data)
      : parts
          .map((p) => `**${oraAiPartLabel(unit, p)}**\n${renderOraAiPart(unit, p, r.data)}`)
          .join('\n\n')
    const warn = r.warnings?.length ? `\n> 降级提示：${r.warnings.join('；')}` : ''
    return clip(`${body}${warn}`, 3200)
  } catch (e: any) {
    return `（读取失败：${e?.message || e}）`
  }
}

/**
 * 生成快照：环境 → 单元 → 细分块。
 * 同一个单元既勾了整块又勾了细分时，整块优先（避免重复喂同一份数据）。
 */
export async function buildOraAiContext(sections: OraAiSectionKey[]): Promise<string> {
  const picked = sections.filter(isOraAiKey)
  if (!picked.length) return '（本次没有勾选任何数据：请在环境卡、库详情 tab 或页面卡片上勾选后再问）'
  // 保持「环境 → 单元」的先后顺序，避免快照里同一套环境被拆成多段
  const byEnv = new Map<string, Map<OraAiUnit, Set<string> | null>>()
  for (const key of picked) {
    const p = parseKey(key)
    if (!p) continue
    const units = byEnv.get(p.envId) || new Map<OraAiUnit, Set<string> | null>()
    byEnv.set(p.envId, units)
    if (!p.part) {
      units.set(p.unit, null) // null = 整块
      continue
    }
    if (units.get(p.unit) === null) continue // 已经整块，细分忽略
    const set = units.get(p.unit) || new Set<string>()
    set.add(p.part)
    units.set(p.unit, set)
  }
  const parts: string[] = []
  for (const [envId, units] of byEnv) {
    parts.push(`### Oracle 环境：${envTitle(envId)}`)
    for (const [unit, sub] of units) {
      const body = await renderUnit(envId, unit, sub === null ? null : [...sub])
      parts.push(`#### ${oraAiUnitLabel(unit)}\n${body}`)
    }
  }
  let text = parts.join('\n\n')
  if (text.length > CONTEXT_MAX_CHARS) text = `${text.slice(0, CONTEXT_MAX_CHARS)}\n…（快照超长已截断）`
  return text
}

// ---------------------------------------------------------------- 提示词

/** 范围说明：勾到细分时写清是哪一块（模型据此知道「没读的别编」） */
function scopeText(sections: OraAiSectionKey[]): string {
  const byEnv = new Map<string, Map<OraAiUnit, Set<string> | null>>()
  for (const key of sections) {
    const p = parseKey(key)
    if (!p) continue
    const units = byEnv.get(p.envId) || new Map<OraAiUnit, Set<string> | null>()
    byEnv.set(p.envId, units)
    if (!p.part) {
      units.set(p.unit, null)
      continue
    }
    if (units.get(p.unit) === null) continue
    const set = units.get(p.unit) || new Set<string>()
    set.add(p.part)
    units.set(p.unit, set)
  }
  if (!byEnv.size) return '未选择'
  return [...byEnv.entries()]
    .map(([id, units]) => {
      const list = [...units.entries()].map(([unit, sub]) => {
        if (sub === null) return oraAiUnitLabel(unit)
        if (sub.size === (ORA_AI_PARTS[unit]?.length || 0)) return oraAiUnitLabel(unit)
        return `${oraAiUnitLabel(unit)}：${[...sub].map((p) => oraAiPartLabel(unit, p)).join('、')}`
      })
      return `${envTitle(id).split('（')[0]}（${list.join('；')}）`
    })
    .join('、')
}

/** 本次没勾、可以建议用户去勾的单元（只列单元名，避免 60 多个细分块把提示词撑爆） */
function missingText(sections: OraAiSectionKey[]): string {
  const picked = new Set(sections.map((s) => unitOf(s)).filter(Boolean) as OraAiUnit[])
  return ORA_AI_UNITS.filter((u) => !picked.has(u.key)).map((u) => u.label).join('、') || '（已全选）'
}

function systemPrompt(s: OraAiSession, skillText = ''): string {
  return [
    '你是 SQLPilot 内置的「Oracle 云平台 AI 助手」，服务对象是 Oracle DBA（单实例 / RAC / Data Guard 都可能）。',
    '',
    '## 当前会话',
    `- 读取范围：${scopeText(s.sections)}`,
    `- 数据快照时间：${new Date(s.contextAt).toLocaleString()}`,
    '- 快照是把 v$ / dba_ 视图的查询结果整理成的静态文本，不是你实时查询的结果；用户问「现在」时按快照口径回答，并注明快照时间。',
    '',
    '## 回答要求',
    '1. 只依据下面的数据快照作答；快照里没有的要明确说「当前快照里没有这项数据」，并从「可补充的单元」里指出该勾哪一项，禁止编造库名、实例名、SID、SQL_ID 或数值。',
    '2. 中文回答，简洁、可执行。给结论带上关键数字（如「SYSTEM 表空间 99.5%」）。',
    '3. 列表用 Markdown 表格（不超过 6 列）；排查步骤用有序列表，结尾给「建议下一步」。',
    '4. 涉及 SQL 时给出可直接在 sqlplus 里跑的语句（Oracle 语法，注意 11g 兼容：不要 fetch first、不要 v$pdbs 之类 12c 视图）；涉及变更要提醒先评估影响、走变更窗口。',
    '5. 只讨论 Oracle 运维话题（实例/RAC、空间、会话与锁、SQL 性能、备份恢复、Data Guard、作业、参数、用户对象）；无关问题一句话带过。',
    '',
    '## 可补充的单元（本次未读取）',
    missingText(s.sections),
    '',
    '## 数据快照',
    s.context || '（本次对话没有可用数据，请提示用户重新勾选后再问）',
    skillText
  ]
    .filter((x) => x !== '')
    .join('\n')
}

// ---------------------------------------------------------------- 对话

function titleOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 28 ? `${t.slice(0, 28)}…` : t || '新对话'
}

function trimMessages(s: OraAiSession): void {
  if (s.messages.length > MAX_MESSAGES) s.messages = s.messages.slice(s.messages.length - MAX_MESSAGES)
}

/** 发起一轮问答（sessionId 为空则新建）；正文通过 cloud:oraAi:event 流式回传 */
export async function askOraAi(input: OraAiAskInput): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const text = String(input.text || '').trim()
  if (!text) return { ok: false, error: '请输入问题' }

  const cfg = loadConfig()
  const provider = cfg.providers.find((p) => p.id === cfg.activeProviderId) || cfg.providers[0]
  if (!provider) return { ok: false, error: '尚未配置大模型：请先在「设置」里选择厂商和模型' }

  let session = input.sessionId ? findSession(input.sessionId) : undefined
  if (session && running.has(session.id)) return { ok: false, error: '上一条还在生成中，请等待完成或先停止' }

  const isNew = !session
  if (!session) session = newSession((input.sections || []).filter(isOraAiKey))
  const sess = session
  if (isNew && input.sections?.length) sess.sections = input.sections.filter(isOraAiKey)

  sess.messages.push({ id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, role: 'user', text, at: Date.now() })
  if (isNew || sess.messages.length === 1) sess.title = titleOf(text)
  sess.updatedAt = Date.now()
  trimMessages(sess)
  saveStore()

  const sessionId = sess.id
  // 技能正文（勾了才有）：不挂工具，作为「回答规范」拼进系统提示
  const skillText = skillBlockFor(input.skills)
  const ctrl = new AbortController()
  running.set(sessionId, ctrl)
  let streamed = ''

  void (async () => {
    try {
      if (!sess.context || Date.now() - sess.contextAt > 30 * 60_000) {
        send({ type: 'building', sessionId })
        try {
          sess.context = await buildOraAiContext(sess.sections)
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
      let reasoningChars = 0
      let rtimer: ReturnType<typeof setTimeout> | null = null
      const flush = (): void => {
        timer = null
        if (!pending) return
        send({ type: 'delta', sessionId, text: pending })
        pending = ''
      }
      const res = await callLlm(
        provider,
        systemPrompt(sess, skillText),
        history,
        [],
        {
          onText: (t: string) => {
            streamed += t
            pending += t
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
        },
        { signal: ctrl.signal }
      )
      if (timer) clearTimeout(timer)
      if (rtimer) clearTimeout(rtimer)
      flush()

      const finalText = (res.content || streamed).trim()
      const msg: OraAiMessage = {
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

/** 刷新快照（不动对话历史） */
export async function refreshOraAiContext(sessionId: string): Promise<{ ok: boolean; contextAt?: number; contextChars?: number; error?: string }> {
  const s = findSession(sessionId)
  if (!s) return { ok: false, error: '会话不存在' }
  if (running.has(sessionId)) return { ok: false, error: '生成中不能刷新数据' }
  send({ type: 'building', sessionId })
  try {
    s.context = await buildOraAiContext(s.sections)
    s.contextAt = Date.now()
    saveStore()
    send({ type: 'context', sessionId, contextAt: s.contextAt, contextChars: s.context.length })
    return { ok: true, contextAt: s.contextAt, contextChars: s.context.length }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 调整读取范围：保留对话，立刻重建快照 */
export async function setOraAiSections(sessionId: string, sections: OraAiSectionKey[]): Promise<{ ok: boolean; error?: string }> {
  const s = findSession(sessionId)
  if (!s) return { ok: false, error: '会话不存在' }
  if (running.has(sessionId)) return { ok: false, error: '生成中不能修改范围' }
  const picked = sections.filter(isOraAiKey)
  if (!picked.length) return { ok: false, error: '至少要勾选一项' }
  s.sections = picked
  s.envIds = envIdsOf(picked)
  s.updatedAt = Date.now()
  s.context = ''
  s.contextAt = 0
  saveStore()
  try {
    s.context = await buildOraAiContext(s.sections)
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
