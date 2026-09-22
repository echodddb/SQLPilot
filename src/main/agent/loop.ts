import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callLlm } from './llm'
import { TOOLS, executeTool } from '../tools'
import type { ApprovalDecision, ApprovalRequest, ToolContext } from '../tools'
import type { ChatMsg, ConnProfile, PermissionMode, ProjectConfig, ProviderConfig, ThinkingEffort } from '../types'
import { appendAudit } from '../audit'
import { listSkills } from '../skills'
import { loadConfig } from '../config'
import { writeFileAtomic } from '../atomic'
import { modelContextK } from './catalog'
import { metaGet, metaKeys, metaSet } from '../meta'
import { getAdapter } from '../db/manager'
import { readConnMemory, readGlobalMemory, readProjectArchive, readProjectMemory } from '../memory'
import { launchSubagent, listSubagentsForPrompt, resolveSubagent } from './subagent'
import { stopSubtasksOfSession } from './subtask-registry'

export type AgentEvent =
  | { type: 'text'; sessionId: string; text: string }
  | { type: 'reasoning'; sessionId: string; text: string }
  | { type: 'tool-start'; sessionId: string; tool: string; args: string; toolCallId?: string }
  | { type: 'tool-end'; sessionId: string; tool: string; ok: boolean; result: string; toolCallId?: string }
  | { type: 'session-updated'; sessionId: string; meta: SessionMeta }
  | { type: 'done'; sessionId: string; note?: string }
  | { type: 'error'; sessionId: string; error: string }
  /** 会话上下文占用：est=下次请求估算 tokens，windowK=模型窗口(K)，usage=最近一次真实计量（有则带） */
  | { type: 'context'; sessionId: string; est: number; windowK: number; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }
  /** 子代理生命周期（subId = 对应 agent_spawn 的 toolCallId，渲染层据此挂到工具卡片） */
  | { type: 'sub-start'; sessionId: string; subId: string; agentType: string; description: string }
  | { type: 'sub-activity'; sessionId: string; subId: string; note: string }
  | { type: 'sub-end'; sessionId: string; subId: string; ok: boolean; summary: string; status: 'completed' | 'stopped' | 'failed' | 'exhausted' }
  | { type: 'notice'; sessionId: string; text: string }
  | { type: 'sub-tasks'; sessionId: string; tasks: { id: string; agentType: string; description: string; status: string; startedAt: number; summary?: string; runFile?: string }[] }

export interface RunDeps {
  emit: (ev: AgentEvent) => void
  /** sessionId 用于把写操作确认归属到具体会话（多会话并发时互不影响） */
  requestApproval: (req: ApprovalRequest, sessionId: string) => Promise<ApprovalDecision>
  /** LLM 发送前预览：返回 false 表示用户取消该次请求（主进程按配置决定是否启用） */
  previewLlm?: (url: string, body: any) => Promise<boolean>
}

export interface SessionMeta {
  id: string
  title: string
  mode: PermissionMode
  providerId: string | null
  projectId: string | null
  /** 会话级思考级别（null = 沿用提供商默认） */
  effort: ThinkingEffort | null
}

interface SessionState extends SessionMeta {
  messages: ChatMsg[]
  running: boolean
  sessionApproved: Set<string>
  cancelRequested: boolean
  abortCtrl: AbortController | null
  /** 最近一次 LLM 响应的真实计量（上下文徽标显示用，不持久化） */
  lastUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** 被截断历史的抽取式摘要（随会话持久化，注入系统提示词） */
  contextSummary?: string
  /** 后台子代理完成通知（随会话持久化；下一回合注入首条 user 消息，ZCode <task-notification> 的等价物） */
  pendingNotices: string[]
}

const sessions = new Map<string, SessionState>()
let sessionSeq = 0

// ---------- 会话持久化（userData/sessions.json） ----------

function sessionsFile(): string {
  return path.join(app.getPath('userData'), 'sessions.json')
}

/** 应用启动时恢复磁盘上的会话（含每会话的权限模式/模型/项目绑定） */
export function loadPersistedSessions(): void {
  try {
    const raw = fs.readFileSync(sessionsFile(), 'utf8')
    const data = JSON.parse(raw) as Record<string, Partial<SessionState> & { messages?: ChatMsg[] }>
    for (const [id, s] of Object.entries(data)) {
      if (!sessions.has(id)) {
        const tr = trimHistory(Array.isArray(s.messages) ? s.messages : [])
        sessions.set(id, {
          id,
          title: s.title || '会话',
          mode: (s.mode as PermissionMode) || 'readonly',
          providerId: s.providerId ?? null,
          projectId: s.projectId ?? null,
          effort: (s.effort as ThinkingEffort) ?? null,
          messages: repairDanglingToolCalls(tr.kept),
          contextSummary: tr.dropped.length ? summarizeDropped(s.contextSummary, tr.dropped) : s.contextSummary,
          pendingNotices: Array.isArray(s.pendingNotices) ? s.pendingNotices : [],
          running: false,
          sessionApproved: new Set(),
          cancelRequested: false,
          abortCtrl: null
        })
      }
    }
  } catch { /* 无历史文件或损坏时静默跳过 */ }
}

export function persistSessions(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  try {
    const data: Record<string, any> = {}
    for (const s of sessions.values()) {
      data[s.id] = {
        title: s.title,
        mode: s.mode,
        providerId: s.providerId,
        projectId: s.projectId,
        effort: s.effort,
        messages: s.messages,
        contextSummary: s.contextSummary,
        pendingNotices: s.pendingNotices
      }
    }
    writeFileAtomic(sessionsFile(), JSON.stringify(data))
  } catch { /* 持久化失败不阻断对话 */ }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

/** 高频元数据变更（切模式/改标题/绑项目）防抖落盘：每次都是全量序列化所有会话，同步写会卡主进程。
 *  会话回合结束与退出走 persistSessions() 立即写 */
function persistSessionsSoon(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistSessions()
  }, 300)
  persistTimer.unref?.()
}

export function getSession(id: string): SessionState {
  let s = sessions.get(id)
  if (!s) {
    s = {
      id,
      title: '新会话',
      mode: loadConfig().mode,
      providerId: null,
      projectId: null,
      effort: null,
      messages: [],
      running: false,
      sessionApproved: new Set(),
      cancelRequested: false,
      abortCtrl: null,
      pendingNotices: []
    }
    sessions.set(id, s)
  }
  return s
}

function metaOf(s: SessionState): SessionMeta {
  return { id: s.id, title: s.title, mode: s.mode, providerId: s.providerId, projectId: s.projectId, effort: s.effort }
}

/** 会话元信息（渲染层列表用） */
export function listSessions(): SessionMeta[] {
  return [...sessions.values()].map(metaOf)
}

export function newSession(): SessionMeta {
  const s = getSession(`s_${Date.now()}_${++sessionSeq}`)
  s.title = '新会话'
  persistSessionsSoon()
  return metaOf(s)
}

export function deleteSession(id: string): void {
  stopSubtasksOfSession(id)
  sessions.delete(id)
  persistSessionsSoon()
}

/** 更新会话元数据（模式/模型/项目/思考级别/标题） */
export function updateSession(id: string, patch: Partial<Pick<SessionState, 'title' | 'mode' | 'providerId' | 'projectId' | 'effort'>>): SessionMeta {
  const s = getSession(id)
  if (patch.title !== undefined) s.title = patch.title
  if (patch.mode !== undefined) s.mode = patch.mode
  if (patch.providerId !== undefined) s.providerId = patch.providerId
  if (patch.projectId !== undefined) s.projectId = patch.projectId
  if (patch.effort !== undefined) s.effort = patch.effort
  persistSessionsSoon()
  return metaOf(s)
}

export function resetSession(id: string): void {
  const s = getSession(id)
  s.messages = []
  s.contextSummary = undefined
  s.sessionApproved.clear()
  persistSessionsSoon()
}

/** 用户点击"停止"：中断进行中的 LLM 流式调用，并在最近的检查点结束本回合 */
export function cancelSession(id: string): void {
  const s = getSession(id)
  if (!s.running) return
  s.cancelRequested = true
  s.abortCtrl?.abort()
}

const MAX_ITERATIONS = 24

/** 同批 agent_spawn 的并发上限：DB 侧防爆 + 避免确认弹窗风暴 */
const MAX_CONCURRENT_SUBAGENTS = 3

/** 该 toolCall 是否已有对应的 tool 消息（悬空修复与扇出去重共用） */
function answered(messages: ChatMsg[], toolCallId: string): boolean {
  return messages.some((m) => m.role === 'tool' && m.toolCallId === toolCallId)
}

/** 固定并发池：保持 items 顺序返回，单项失败不中断其余（失败在各自 promise 内部处理） */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) break
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

/** 粗略 token 估算：CJK 字符约 1.1 tok/字，其余约 3.8 字符/tok（够显示用，非精确计量） */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 3.8)
}

function estimateContextTokens(system: string, messages: ChatMsg[]): number {
  let est = estimateTokens(system)
  for (const m of messages) {
    est += estimateTokens(m.content || '')
    if (m.toolCalls) for (const tc of m.toolCalls) est += estimateTokens(tc.args || '')
  }
  return est
}
/** 会话历史条数上限：超出时从最近的 user 边界截断，防止上下文与 sessions.json 无限膨胀 */
const MAX_MESSAGES = 200

/** 摘要总长上限（字符）：近期事实优先（截尾保留最新） */
const SUMMARY_MAX_CHARS = 3500

interface TrimResult {
  kept: ChatMsg[]
  dropped: ChatMsg[]
}

/** 从 from 起找第一条 user 消息下标（找不到返回 msgs.length） */
function indexAtUserBoundary(msgs: ChatMsg[], from: number): number {
  let i = Math.max(0, from)
  while (i < msgs.length && msgs[i].role !== 'user') i++
  return i
}

function lastUserIndex(msgs: ChatMsg[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return i
  }
  return 0
}

/** 截断历史：条数 + 估算 token 双上限。保留段必须以 user 消息开头——Anthropic 要求首条为 user，
 *  且孤儿 tool 消息（缺前面 assistant 的 tool_use）两家协议都会 400 拒绝 */
function trimHistory(msgs: ChatMsg[], maxTokens?: number): TrimResult {
  let cut = 0
  if (msgs.length > MAX_MESSAGES) {
    const fwd = indexAtUserBoundary(msgs, msgs.length - MAX_MESSAGES)
    cut = fwd < msgs.length ? fwd : lastUserIndex(msgs)
  }
  if (maxTokens && msgs.length > 1) {
    const cost = msgs.map((m) => estimateTokens(m.content || '') + (m.toolCalls ? m.toolCalls.reduce((a, tc) => a + estimateTokens(tc.args || ''), 0) : 0))
    let acc = 0
    let start = msgs.length
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (acc + cost[i] > maxTokens) break
      acc += cost[i]
      start = i
    }
    if (start > 0) {
      // 推进到 user 边界；预算装不下最近一个完整回合时退而保留该回合——
      // 宁可超预算让 API 报错，也不产出破坏协议的孤儿 tool 消息
      const bounded = indexAtUserBoundary(msgs, start)
      start = bounded < msgs.length ? bounded : lastUserIndex(msgs)
      cut = Math.max(cut, start)
    }
  }
  if (cut <= 0) return { kept: msgs, dropped: [] }
  return { kept: msgs.slice(cut), dropped: msgs.slice(0, cut) }
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 被截断历史的本地抽取式摘要（不调 LLM，确定性零成本）：保留用户诉求、探索过的表、
 *  执行过的写操作/命令与关键结论；与旧摘要拼接后截尾（近期事实优先）。
 *  也被会话归档用作 LLM 总结失败时的回退 */
export function summarizeDropped(prev: string | undefined, dropped: ChatMsg[]): string {
  const users: string[] = []
  const wrote: string[] = []
  const explored = new Set<string>()
  const ran: string[] = []
  const conclusions: string[] = []
  for (const m of dropped) {
    if (m.role === 'user' && m.content) {
      users.push(oneLine(m.content, 100))
    } else if (m.role === 'assistant') {
      if (m.content && !m.toolCalls?.length) conclusions.push(oneLine(m.content, 200))
      for (const tc of m.toolCalls || []) {
        let a: any
        try {
          a = JSON.parse(tc.args || '{}')
        } catch {
          continue
        }
        if (tc.name === 'db_write') wrote.push(oneLine(String(a.sql || ''), 160))
        else if (tc.name === 'db_describe_table' || tc.name === 'db_get_ddl') explored.add(`${a.schema ? `${a.schema}.` : ''}${a.table}`)
        else if (tc.name === 'run_command' || tc.name === 'server_run') ran.push(oneLine(String(a.command || ''), 100))
      }
    }
  }
  const uniq = (arr: string[]) => [...new Set(arr)]
  const parts: string[] = []
  if (users.length) parts.push(`用户此前要求：\n${uniq(users).map((u) => `- ${u}`).join('\n')}`)
  if (explored.size) parts.push(`已确认结构的表（勿重复探索）：${[...explored].slice(0, 40).join('、')}`)
  if (wrote.length) parts.push(`已执行的写操作：\n${uniq(wrote).slice(-10).map((s) => `- ${s}`).join('\n')}`)
  if (ran.length) parts.push(`执行过的命令：${uniq(ran).slice(-5).join('；')}`)
  if (conclusions.length) parts.push(`此前结论：\n${conclusions.slice(-3).map((c) => `- ${c}`).join('\n')}`)
  const fresh = parts.join('\n\n')
  const merged = prev ? `${prev}\n\n${fresh}` : fresh
  return merged.length > SUMMARY_MAX_CHARS ? merged.slice(-SUMMARY_MAX_CHARS) : merged
}

/** 修复悬空 tool_use（旧版本点"停止"遗留）：assistant 的 toolCall 缺少对应 tool 消息时补一条取消结果，
 *  否则 OpenAI/Anthropic 协议都会以 400 拒绝该会话的后续所有请求 */
function repairDanglingToolCalls(msgs: ChatMsg[]): ChatMsg[] {
  const answered = new Set<string>()
  for (const m of msgs) if (m.role === 'tool' && m.toolCallId) answered.add(m.toolCallId)
  let missing = false
  for (const m of msgs) {
    if (m.role === 'assistant' && m.toolCalls?.some((tc) => !answered.has(tc.id))) missing = true
  }
  if (!missing) return msgs
  const out: ChatMsg[] = []
  for (const m of msgs) {
    out.push(m)
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue
    for (const tc of m.toolCalls) {
      if (answered.has(tc.id)) continue
      answered.add(tc.id)
      out.push({ role: 'tool', content: JSON.stringify({ error: '任务被中断，本工具未执行' }), toolCallId: tc.id, toolName: tc.name })
    }
  }
  return out
}

const TYPE_LABELS: Record<string, string> = {
  oracle: 'Oracle',
  mysql: 'MySQL',
  'ob-mysql': 'OceanBase 4.x（MySQL 租户）',
  'ob-oracle': 'OceanBase（Oracle 租户，暂未接入）'
}

const MODE_LINES: Record<PermissionMode, string> = {
  plan: `计划模式：只允许只读探索（查询/看结构/读项目文件），任何写操作都会被拒绝。
探索完成后调用 exit_plan_mode 提交计划，最终输出结构化执行计划：
## 执行计划
**目标**：一句话
**步骤**：编号列表，每步写明将执行的操作（含关键 SQL/文件写入，写全内容）
**影响与风险**：涉及的表/行数量级、可逆性、回滚方法
输出计划后结束回合，等待用户批准。批准后你将获得执行权限。`,
  readonly: '只读模式：只能执行只读查询，写操作一律拒绝',
  confirm: '确认执行模式：写操作会弹出确认框，请务必在执行前说明 SQL 的目的和影响范围。复杂任务应先调用 enter_plan_mode 规划',
  session: '会话放开模式：普通写操作本会话已获授权，高危操作（DROP/TRUNCATE 等）仍需逐次确认。复杂任务应先调用 enter_plan_mode 规划',
  yolo: '完全放开模式：所有操作自动执行——执行写操作前仍须先说明影响，谨慎行事。复杂任务仍建议先调用 enter_plan_mode 规划'
}

// ---------- 连接版本探测（注入提示词的环境事实，非硬编码） ----------

const VERSION_OK_TTL_MS = 30 * 60_000
const VERSION_FAIL_TTL_MS = 5 * 60_000
const VERSION_PROBE_TIMEOUT_MS = 4_000

interface VersionEntry {
  label: string | null
  at: number
}

/** 版本横幅压缩成短标签：如 "Oracle Database 11g ... Release 11.2.0.4.0 - 64bit Production" → "Oracle 11.2.0.4.0" */
function shortVersionLabel(raw: string): string {
  if (raw.length <= 28) return raw
  const m = raw.match(/\d+(\.\d+){1,4}/)
  const head = raw.match(/^[A-Za-z]+/)?.[0] || ''
  return m ? `${head} ${m[0]}`.trim() : raw.slice(0, 28)
}

/** 读取已缓存的连接版本（同步零成本；新鲜度由后台刷新维持） */
function cachedVersions(connections: ConnProfile[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of connections) {
    const hit = metaGet<VersionEntry>(metaKeys.version(c.id))
    if (hit?.label) out[c.id] = hit.label
  }
  return out
}

/** 后台刷新过期版本（成功 30 分钟/失败 5 分钟内不重试，同连接并发去重）。
 *  绝不 await 在回合路径上：探测曾同步阻塞回合并始（慢/死连接最多卡 4 秒，
 *  且排在共享适配器队列里会被长查询拖住），宁可版本标注晚一两轮出现 */
const versionInflight = new Map<string, Promise<void>>()
function kickVersionRefresh(connections: ConnProfile[], globalClientDir?: string): void {
  for (const c of connections) {
    const key = metaKeys.version(c.id)
    const hit = metaGet<VersionEntry>(key)
    const ttl = hit?.label ? VERSION_OK_TTL_MS : VERSION_FAIL_TTL_MS
    if ((hit && Date.now() - hit.at < ttl) || versionInflight.has(c.id)) continue
    const task = (async () => {
      let label: string | null = null
      try {
        const raw = await Promise.race([
          getAdapter(c, globalClientDir).test(),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error('版本探测超时')), VERSION_PROBE_TIMEOUT_MS)
            t.unref?.()
          })
        ])
        label = shortVersionLabel(String(raw))
      } catch {
        /* 连接失败/超时/无权限：留空，短 TTL 后重试 */
      }
      metaSet(key, { label, at: Date.now() })
    })().catch(() => undefined).then(() => {
      versionInflight.delete(c.id)
    })
    versionInflight.set(c.id, task)
  }
}

function fmtConnLine(c: ConnProfile, tag?: string, mask = false, ver?: string): string {
  // 脱敏：不发送服务名/库名（连接按名称寻址，明细不进提示词）；版本号不敏感，始终携带
  const target = mask ? '' : c.type === 'oracle' ? `service=${c.serviceName}` : `db=${c.database || '(未指定)'}`
  return `- ${tag ? `[${tag}] ` : ''}${c.name}: ${TYPE_LABELS[c.type]}${target ? ` ${target}` : ''}${ver ? ` [${ver}]` : ''} [${c.role === 'readonly' ? '只读账号' : '管理账号'}]`
}

/** 注入系统提示词的动态事实：连接版本（探测缓存）、跨会话记忆、项目归档、历史上下文摘要 */
export interface PromptFacts {
  versions: Record<string, string>
  globalMemory?: string
  connMemories: Record<string, string>
  /** 当前会话绑定项目的专属记忆（未绑定项目则无） */
  projectMemory?: string
  /** 当前会话绑定项目的会话归档（此前会话的总结） */
  archive?: string
  summary?: string
}

/** 项目根下的用户指令文件：SQLPILOT.md 优先，其次 AGENTS.md；缺失/超大返回 undefined */
function readProjectInstructions(rootPath: string | undefined): { file: string; content: string } | undefined {
  if (!rootPath) return undefined
  for (const name of ['SQLPILOT.md', 'AGENTS.md']) {
    try {
      const p = path.join(rootPath, name)
      const st = fs.statSync(p)
      if (!st.isFile() || st.size > 64 * 1024) continue // 超大文件视为误放，忽略
      const content = fs.readFileSync(p, 'utf8').trim()
      if (content) return { file: name, content: content.slice(0, 8192) }
    } catch {
      /* 不存在或不可读，试下一个 */
    }
  }
  return undefined
}

/** 当前时间行（注入提示词末尾）。粒度到小时：分钟级时间戳逐轮变化会打穿兼容网关的前缀缓存 */
function nowLine(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const week = '日一二三四五六'[d.getDay()]
  let tz = ''
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    /* 个别环境 resolvedOptions 异常时省略时区 */
  }
  return `当前时间：${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}（周${week}）${pad(d.getHours())} 时${tz ? `（时区 ${tz}）` : ''}。相对时间（今天/昨天/近 7 天/本月）以此为基准；需要精确时刻时用数据库时间函数（SYSDATE/CURRENT_DATE/NOW()）核实。`
}

function buildSystemPrompt(connections: ConnProfile[], mode: PermissionMode, project: ProjectConfig | undefined, skills: { name: string; description: string }[], mask = false, facts?: PromptFacts): string {
  // 连接分两组：关联本项目的优先，其余全局连接仍可用；每条连接可带版本标注与归属记忆
  const projConns = project ? connections.filter((c) => c.projectId === project.id) : []
  const otherConns = connections.filter((c) => !project || c.projectId !== project.id)
  const lineOf = (c: ConnProfile, tag?: string) => {
    let l = fmtConnLine(c, tag, mask, facts?.versions[c.id])
    const mem = facts?.connMemories[c.name]
    if (mem) l += `\n  记忆：${mem.split('\n').map((x) => x.replace(/^- \[/, '[')).join('；').slice(0, 400)}`
    return l
  }
  const connLines = connections.length
    ? [
        ...projConns.map((c) => lineOf(c, '本项目')),
        ...otherConns.map((c) => lineOf(c, projConns.length ? '未关联' : undefined))
      ].join('\n')
    : '（当前未配置任何数据库连接：数据库类任务请提示用户先在左侧添加连接；文件读写（fs_*）与技能类任务可正常进行，无需数据库。）'

  const dialects: string[] = []
  if (connections.some((c) => c.type === 'oracle')) {
    dialects.push('- Oracle：11g 及以下不支持 FETCH FIRST/LIMIT，分页用 ROWNUM；12c+ 两者皆可——以连接行标注的实际版本为准。动态 SQL 用绑定变量。v$ 视图无权限时给出替代方案并说明。')
  }
  if (connections.some((c) => c.type === 'ob-mysql' || c.type === 'mysql')) {
    dialects.push('- MySQL/OB MySQL 租户：用标准 MySQL 语法；OB 特有信息可查 oceanbase.GV$ 系统视图（如 GV$OB_SERVERS、CDB_OB_TENANTS 等，视权限而定）。')
  }

  // 脱敏：服务器只发名称/标签/备注（按名称寻址），不发 user@host:port
  const serverLines = project?.servers?.length
    ? '\n项目挂载的远程服务器（按名称寻址，server_run/server_read_file/server_tail 操作；执行命令前先说明影响，注意 tag 标记）：\n' +
      project.servers.map((s) => (mask
        ? `- ${s.name} [${s.tag || '未标记'}]${s.note ? `（${s.note}）` : ''}`
        : `- ${s.name} [${s.tag || '未标记'}]: ${s.user}@${s.host}:${s.port}${s.note ? `（${s.note}）` : ''}`
      )).join('\n') + '\n'
    : ''

  // 脱敏：不发项目根目录的完整本地路径（fs 工具用相对路径，无需绝对路径）
  const projectBlock = project
    ? `\n当前绑定项目：${project.name}${mask ? '' : `（根目录 ${project.rootPath}）`}。可用 fs_list/fs_read/fs_write 操作项目内文件（路径相对项目根），产出的报告/脚本等文件默认写入项目目录。${project.description ? `\n项目说明：${project.description}` : ''}\n`
    : ''

  // 项目指令文件（用户手写，覆盖默认规则——ZCode agentsMd 的等价物）
  const instr = readProjectInstructions(project?.rootPath)
  const instrBlock = instr
    ? `\n项目指令（${instr.file}，用户维护，优先级高于本提示词的其余默认规则，冲突时以本文件为准）：\n${instr.content}\n`
    : ''

  const skillLines = skills.length
    ? '\n可用技能（任务匹配时先用 read_skill 读取全文，然后严格遵循其步骤执行）：\n' + skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') + '\n'
    : ''

  const subagentLines = '\n可用子代理（agent_spawn 派生；子代理有独立上下文、看不到本会话历史，只在完成时返回最终报告，中间工具结果不占用本会话上下文）：\n' +
    listSubagentsForPrompt().map((a) => `- ${a.name}: ${a.description}\n  工具面：${a.tools}`).join('\n') +
    '\n使用要点：prompt 必须自包含（目标、连接名、期望输出）；大范围探索/多连接采集/日志排查优先派 explore（可同回合并行派多个）；写操作不要委托子代理，留在本会话执行。预计耗时长的后台采集（全库巡检/日志深扫）传 run_in_background=true：立即返回任务 id，本会话继续干别的，任务完成会有系统通知送达（含摘要与报告文件），需要结果时用 task_output(task_id, block) 收割、task_stop 停止；前台子代理超过 2 分钟也会自动转后台，流程相同。\n'

  const memParts: string[] = []
  if (facts?.globalMemory) memParts.push(`〔全局〕\n${facts.globalMemory}`)
  if (facts?.projectMemory && project) memParts.push(`〔当前项目「${project.name}」专属〕\n${facts.projectMemory}`)
  const memBlock = memParts.length
    ? '\n跨会话记忆（此前会话沉淀的事实与用户约定，遵循其中的约定；与实际探测不符时以探测结果为准，并用 memory_append 追加更正）：\n' + memParts.join('\n\n') + '\n'
    : ''

  const archiveBlock = facts?.archive
    ? '\n项目会话归档（该项目此前会话的总结，作为任务背景参考；不是当前对话内容，若与现状冲突以实际为准）：\n' + facts.archive + '\n'
    : ''

  const summaryBlock = facts?.summary
    ? '\n历史上下文摘要（更早的对话因超出长度已压缩，以下为保留的关键事实，已确认的内容不必重新探索）：\n' + facts.summary + '\n'
    : ''

  return `你是 SQLPilot，一名资深数据库管理员（DBA）AI 助手，运行在用户的 Windows 工作站上（${process.platform} ${os.release()}），直接操作用户配置的数据库。

当前可用数据库连接：
${connLines}
${projectBlock}${instrBlock}${serverLines}${skillLines}${subagentLines}${memBlock}${archiveBlock}${summaryBlock}
工作规则：
1. 所有数据库操作必须通过工具完成，并明确传 conn 参数（连接名，与上面列表一致）。
2. 不确定表结构时，先用 db_list_tables / db_describe_table / db_get_ddl 探索，再写 SQL，禁止凭猜测写表名列名。
3. 查询尽量加 WHERE 条件和行数限制，工具最多返回 500 行、预览 30 行。
4. SQL 报错时读取错误信息修正后重试（最多 2 次），仍失败则向用户说明原因和修复建议。
5. 当前权限模式：${MODE_LINES[mode]}
6. 自动规划：当任务涉及写操作、DDL 变更、多步骤执行或影响面较大时，即使当前模式允许写操作，也应先调用 enter_plan_mode 进入计划模式（用户也可手动切换模式，以更严格的为准）。
7. 本机操作：可通过 run_command 在用户电脑上执行系统命令（运行脚本、安装软件、查看状态等）、fs_delete 删除项目内文件、open_url 打开网页。执行有影响的操作（安装/修改系统/删除）前，必须先向用户说明将做什么、有什么影响；命令输出和退出码会返回给你，据此继续或修正。
8. 跨会话记忆：发现值得长期保留的事实并确认后，用 memory_append 记录——涉及具体数据库的记到该连接（conn 参数），项目专属的用 project=true，跨项目通用的省略参数记入全局；上面"记忆"与"摘要"仅作参照，与现实不符时以实际探测为准并追加更正。
${dialects.length ? '\n方言要点：\n' + dialects.join('\n') : ''}

回答要求：用中文；先给结论和关键数字，再给依据；展示 SQL 时用代码块。

${nowLine()}`
}

export async function runTurn(
  sessionId: string,
  text: string,
  provider: ProviderConfig,
  globalClientDir: string | undefined,
  deps: RunDeps
): Promise<void> {
  const sess = getSession(sessionId)
  if (sess.running) {
    deps.emit({ type: 'error', sessionId, error: '上一个任务仍在执行中，请等待完成或点击停止' })
    return
  }
  // 会话标题：首条用户消息截断
  if (!sess.messages.length || sess.title === '新会话') {
    sess.title = text.slice(0, 24) || '会话'
  }
  sess.running = true
  sess.cancelRequested = false
  sess.abortCtrl = new AbortController()
  try {
    // 后台子代理完成通知：注入本回合首条 user 消息（随历史持久化，模型下次也能看到）
    let textOut = text
    if (sess.pendingNotices.length) {
      const block = sess.pendingNotices.join('\n\n')
      sess.pendingNotices = []
      textOut = '<系统通知>（后台子代理的完成通报，供你知晓；如与用户诉求相关请主动汇报）\n' + block + '\n</系统通知>\n\n<用户消息>\n' + text + '\n</用户消息>'
    }
    sess.messages.push({ role: 'user', content: textOut })
    const windowK = modelContextK(provider)

    // 回合级事实采集（回合内循环复用）：连接版本后台刷新（不阻塞回合）+ 跨会话记忆
    const cfg0 = loadConfig()
    kickVersionRefresh(cfg0.connections, globalClientDir)
    const proj0 = sess.projectId ? cfg0.projects.find((p) => p.id === sess.projectId) : undefined
    const connMemories: Record<string, string> = {}
    for (const c of cfg0.connections) {
      const m = readConnMemory(c.name)
      if (m) connMemories[c.name] = m
    }
    const facts: PromptFacts = {
      versions: cachedVersions(cfg0.connections),
      globalMemory: readGlobalMemory(),
      connMemories,
      projectMemory: proj0 ? readProjectMemory(proj0.name) : undefined,
      archive: proj0 ? readProjectArchive(proj0.name) : undefined,
      summary: sess.contextSummary
    }

    // 双上限截断（条数 + token 预算）：预算必须扣除系统提示词与工具定义的实际占用
    // （指令文件/记忆/归档/摘要都在系统提示词里），否则小窗口模型会预算内超窗被 API 拒绝。
    // 系统提示词用截断前的旧摘要估算，截断后摘要至多多 3500 字符，余量足以覆盖
    const systemPreview = buildSystemPrompt(cfg0.connections, sess.mode, proj0, listSkills().filter((s) => cfg0.skillsEnabled[s.id] !== false), cfg0.maskPromptDetails !== false, facts)
    const overhead = estimateTokens(systemPreview) + estimateTokens(JSON.stringify(TOOLS))
    const msgBudget = Math.max(4096, Math.floor(windowK * 1024 * 0.8) - overhead)
    const tr = trimHistory(sess.messages, msgBudget)
    if (tr.dropped.length) sess.contextSummary = summarizeDropped(sess.contextSummary, tr.dropped)
    facts.summary = sess.contextSummary
    sess.messages = tr.kept

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const cfg = loadConfig()
      const project = sess.projectId ? cfg.projects.find((p) => p.id === sess.projectId) : undefined
      const skills = listSkills().filter((s) => cfg.skillsEnabled[s.id] !== false)
      const system = buildSystemPrompt(cfg.connections, sess.mode, project, skills, cfg.maskPromptDetails !== false, facts)
      const est = estimateContextTokens(system, sess.messages)
      // 先发估算（请求前徽标即可更新），响应带回真实计量后再补发一次
      deps.emit({ type: 'context', sessionId, est, windowK, usage: sess.lastUsage })
      const res = await callLlm(provider, system, sess.messages, TOOLS, {
        onText: (t) => deps.emit({ type: 'text', sessionId, text: t }),
        onReasoning: (t) => deps.emit({ type: 'reasoning', sessionId, text: t })
      }, {
        signal: sess.abortCtrl.signal,
        effort: sess.effort ?? undefined,
        preview: deps.previewLlm ? (url, body) => deps.previewLlm!(url, body) : undefined
      })
      if (res.usage) {
        sess.lastUsage = res.usage
        deps.emit({ type: 'context', sessionId, est, windowK, usage: res.usage })
      }
      sess.messages.push({ role: 'assistant', content: res.content || null, toolCalls: res.toolCalls, thinking: res.thinking, thinkingSig: res.thinkingSig })

      if (!res.toolCalls.length) {
        deps.emit({ type: 'done', sessionId })
        return
      }

      const cfg2 = loadConfig()
      const project2 = sess.projectId ? cfg2.projects.find((p) => p.id === sess.projectId) : undefined
      const skills2 = listSkills().filter((s) => cfg2.skillsEnabled[s.id] !== false)
      const mask2 = cfg2.maskPromptDetails !== false
      for (const tc of res.toolCalls) {
        if (tc.name === 'agent_spawn') continue // 子代理派生在本批串行工具之后并发执行
        if (sess.cancelRequested) break
        deps.emit({ type: 'tool-start', sessionId, tool: tc.name, args: tc.args, toolCallId: tc.id })

        // 规划控制工具由会话层拦截处理（agent 自主进入/退出计划模式）
        if (tc.name === 'enter_plan_mode' || tc.name === 'exit_plan_mode') {
          let pr: { ok: boolean; result: string }
          if (tc.name === 'enter_plan_mode') {
            if (sess.mode === 'plan') {
              pr = { ok: false, result: JSON.stringify({ error: '已在计划模式中，继续探索并最终用 exit_plan_mode 提交计划' }) }
            } else {
              sess.mode = 'plan'
              persistSessionsSoon()
              deps.emit({ type: 'session-updated', sessionId, meta: metaOf(sess) })
              pr = { ok: true, result: JSON.stringify({ note: '已进入计划模式。接下来只读探索，完成后调用 exit_plan_mode 提交计划。' }) }
            }
          } else {
            if (sess.mode !== 'plan') {
              pr = { ok: false, result: JSON.stringify({ error: '当前不在计划模式，无需提交计划' }) }
            } else {
              pr = { ok: true, result: JSON.stringify({ note: '计划已呈现给用户。请输出完整的最终计划（若尚未输出），然后结束本回合等待批准。不要继续调用工具。' }) }
            }
          }
          deps.emit({ type: 'tool-end', sessionId, tool: tc.name, ok: pr.ok, result: pr.result, toolCallId: tc.id })
          sess.messages.push({ role: 'tool', content: pr.result, toolCallId: tc.id, toolName: tc.name })
          continue
        }

        const ctx: ToolContext = {
          connections: cfg2.connections,
          globalClientDir,
          mode: sess.mode,
          sessionApproved: sess.sessionApproved,
          requestApproval: (req) => deps.requestApproval(req, sessionId),
          project: project2 ? { id: project2.id, name: project2.name, rootPath: project2.rootPath } : undefined,
          servers: project2?.servers || [],
          sessionId
        }
        const r = await executeTool(tc.name, tc.args, ctx)
        deps.emit({ type: 'tool-end', sessionId, tool: tc.name, ok: r.ok, result: r.result, toolCallId: tc.id })
        sess.messages.push({ role: 'tool', content: r.result, toolCallId: tc.id, toolName: tc.name })
      }

      // ---------- 子代理并发扇出 ----------
      // 同一批 agent_spawn 并行执行（上限 3）：多连接巡检/采集类扇出的核心收益；
      // 其余工具已在上面的串行循环执行完，保证写操作的顺序性
      const spawns = res.toolCalls.filter((tc) => tc.name === 'agent_spawn' && !answered(sess.messages, tc.id))
      if (spawns.length && !sess.cancelRequested) {
        const buildSystem = (mode: PermissionMode) => buildSystemPrompt(cfg2.connections, mode, project2, skills2, mask2, facts)
        const spawnOne = async (tc: { id: string; args: string }): Promise<void> => {
          deps.emit({ type: 'tool-start', sessionId, tool: 'agent_spawn', args: tc.args, toolCallId: tc.id })
          let r: { ok: boolean; result: string }
          try {
            let a: any = {}
            try {
              a = JSON.parse(tc.args || '{}')
            } catch {
              a = {}
            }
            const profile = resolveSubagent(String(a.agent_type ?? ''))
            const prompt = String(a.prompt ?? '').trim()
            if (!profile) {
              const available = listSubagentsForPrompt().map((x) => x.name).join(' / ')
              r = { ok: false, result: JSON.stringify({ error: `未知子代理类型 "${a.agent_type}"，可用：${available}` }) }
            } else if (!prompt) {
              r = { ok: false, result: JSON.stringify({ error: 'prompt 不能为空：任务书必须自包含（目标、连接名、期望输出）' }) }
            } else {
              r = await launchSubagent({
                sessionId,
                subId: tc.id,
                profile,
                description: String(a.description ?? profile.name).slice(0, 60),
                prompt,
                background: a.run_in_background === true,
                provider,
                effort: sess.effort,
                parentMode: sess.mode,
                cancelSignal: sess.abortCtrl!.signal,
                sessionApproved: sess.sessionApproved,
                requestApproval: deps.requestApproval,
                previewLlm: deps.previewLlm,
                emit: deps.emit,
                estimateTokens,
                windowK,
                buildSystem,
                connections: cfg2.connections,
                globalClientDir,
                project: project2 ? { id: project2.id, name: project2.name, rootPath: project2.rootPath } : undefined,
                servers: project2?.servers || [],
                onNotice: (text2) => {
                  // 完成通知：立即 UI 提示 + 挂 pendingNotices 随下一回合注入模型
                  sess.pendingNotices.push(text2)
                  persistSessionsSoon()
                  deps.emit({ type: 'notice', sessionId, text: text2 })
                }
              })
            }
          } catch (e: any) {
            r = { ok: false, result: JSON.stringify({ status: 'failed', error: String(e?.message || e).slice(0, 500) }) }
          }
          deps.emit({ type: 'tool-end', sessionId, tool: 'agent_spawn', ok: r.ok, result: r.result, toolCallId: tc.id })
          sess.messages.push({ role: 'tool', content: r.result, toolCallId: tc.id, toolName: 'agent_spawn' })
        }
        await runPool(spawns, MAX_CONCURRENT_SUBAGENTS, spawnOne)
      }
      if (sess.cancelRequested) {
        // 中断可能跳过本批部分 toolCall：必须补上取消结果，否则历史里留下悬空 tool_use，
        // OpenAI/Anthropic 下一轮都会以 400 拒绝该会话
        for (const tc of res.toolCalls) {
          if (sess.messages.some((m) => m.role === 'tool' && m.toolCallId === tc.id)) continue
          const r = JSON.stringify({ error: '用户已停止任务，本工具未执行' })
          deps.emit({ type: 'tool-end', sessionId, tool: tc.name, ok: false, result: r, toolCallId: tc.id })
          sess.messages.push({ role: 'tool', content: r, toolCallId: tc.id, toolName: tc.name })
        }
        break
      }
    }
    if (sess.cancelRequested) {
      deps.emit({ type: 'done', sessionId, note: '已停止（当前任务被手动中断）' })
    } else {
      deps.emit({ type: 'done', sessionId, note: `已达最大迭代次数（${MAX_ITERATIONS}），任务暂停` })
    }
  } catch (e: any) {
    if (sess.cancelRequested) {
      deps.emit({ type: 'done', sessionId, note: '已停止（当前任务被手动中断）' })
    } else {
      const msg = String(e?.message || e)
      appendAudit({ kind: 'llm.error', actor: 'agent', sessionId, detail: msg.slice(0, 500) })
      deps.emit({ type: 'error', sessionId, error: msg })
    }
  } finally {
    sess.running = false
    sess.abortCtrl = null
    persistSessions()
  }
}
