import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 审计日志格式规范（v2，2026-09-22）
 * ────────────────────────────────────
 * 存储：userData/audit.log，JSONL（每行一个 JSON 对象），超过 4MB 轮转为 audit.log.1（再超覆盖）。
 * 查询：queryAudit()（设置页审计查看器 / audit:query IPC），按结构化字段过滤。
 *
 * 字段（除 ts/kind/detail 外均可选——2026-09-22 前的旧记录只有前几个字段，查询侧容错）：
 *   ts        ISO 时间戳（写入时自动填）
 *   kind      sql.read | sql.write | tool | subagent | llm.error | conn | ui.error
 *   actor     发起者：'agent'（主代理）| 'sub:<类型>'（子代理）| 'human'（工作台/人工操作）| 'app'（应用自身）
 *   sessionId 发起会话 id（agent / sub 来源时有）
 *   runId     子代理运行 id（关联 userData/subagent-runs/<runId>.jsonl 的完整过程）
 *   conn      数据库连接名（数据库/服务器类操作）
 *   tool      工具名（agent 工具发起时，如 db_query / fs_write）
 *   target    操作对象：schema.table / 文件路径 / 服务器名（与 detail 的区别：可精确过滤）
 *   sql       SQL 语句全文（仅数据库操作；文件/命令类不占此字段）
 *   rows      返回行数（读）/ 影响行数（写）/ 条目数（探索类）
 *   ms        耗时毫秒
 *   mode      权限模式：readonly/confirm/session/yolo/plan（agent 操作）或 'human'（人工）
 *   approved  写操作是否获批（true/false；被拦截为 false）
 *   error     失败原因（成功省略）
 *   detail    人读摘要（列表展示用；查询请优先用上面的结构化字段）
 */
export interface AuditEntry {
  ts?: string
  kind: 'sql.read' | 'sql.write' | 'tool' | 'subagent' | 'llm.error' | 'conn' | 'ui.error'
  actor?: string
  sessionId?: string
  runId?: string
  conn?: string
  tool?: string
  target?: string
  sql?: string
  rows?: number
  ms?: number
  mode?: string
  approved?: boolean
  error?: string
  detail: string
}

export function auditPath(): string {
  return path.join(app.getPath('userData'), 'audit.log')
}

/** 单文件大小上限：超过则轮转一份 .1（再超覆盖旧 .1），避免只增不减 */
const MAX_AUDIT_BYTES = 4 * 1024 * 1024

function rotateIfNeeded(): void {
  try {
    const st = fs.statSync(auditPath())
    if (st.size < MAX_AUDIT_BYTES) return
    const bak = `${auditPath()}.1`
    try { fs.rmSync(bak, { force: true }) } catch { /* 忽略 */ }
    fs.renameSync(auditPath(), bak)
  } catch { /* 文件不存在或轮转失败都不阻断记录 */ }
}

export function appendAudit(e: AuditEntry): void {
  try {
    rotateIfNeeded()
    fs.mkdirSync(path.dirname(auditPath()), { recursive: true })
    fs.appendFileSync(auditPath(), JSON.stringify({ ...e, ts: new Date().toISOString() }) + '\n', 'utf8')
  } catch {
    /* 审计失败不阻断主流程 */
  }
}

function readAllLines(): string[] {
  let lines: string[] = []
  try {
    lines = fs.readFileSync(auditPath(), 'utf8').split('\n').filter(Boolean)
    // 当前文件行数不足时向轮转文件补齐（更早的记录在 .1 里）
    try {
      lines = fs.readFileSync(`${auditPath()}.1`, 'utf8').split('\n').filter(Boolean).concat(lines)
    } catch { /* 无轮转文件 */ }
  } catch { /* 无文件 */ }
  return lines
}

/** 旧接口：最近 N 条（时间正序）。新代码请用 queryAudit */
export function readAudit(max = 200): AuditEntry[] {
  const parse = (l: string): AuditEntry | null => {
    try { return JSON.parse(l) as AuditEntry } catch { return null }
  }
  return readAllLines().slice(-max).map(parse).filter((x): x is AuditEntry => x !== null)
}

// ---------- 结构化查询 ----------

export interface AuditQuery {
  kinds?: string[]
  /** 精确匹配 actor；'sub:*' 前缀通配全部子代理 */
  actors?: string[]
  conns?: string[]
  sessionId?: string
  runId?: string
  /** detail/sql/target/error/conn/tool 的全文包含（不区分大小写） */
  q?: string
  fromMs?: number
  toMs?: number
  approvedOnly?: boolean
  errorsOnly?: boolean
  limit?: number
  offset?: number
}

export interface AuditQueryResult {
  /** 时间倒序（最新在前），已应用 offset/limit */
  entries: AuditEntry[]
  /** 满足筛选的总条数（不含分页） */
  total: number
  hasMore: boolean
}

function tsOf(e: AuditEntry): number {
  const t = Date.parse(e.ts || '')
  return Number.isFinite(t) ? t : 0
}

function matchesActor(entryActor: string | undefined, wanted: string): boolean {
  if (wanted === 'sub:*') return !!entryActor && entryActor.startsWith('sub:')
  return entryActor === wanted
}

export function queryAudit(query: AuditQuery = {}): AuditQueryResult {
  const parse = (l: string): AuditEntry | null => {
    try { return JSON.parse(l) as AuditEntry } catch { return null }
  }
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 2000)
  const offset = Math.max(query.offset ?? 0, 0)
  const q = query.q ? query.q.toLowerCase() : ''
  const kinds = query.kinds?.filter(Boolean)
  const actors = query.actors?.filter(Boolean)
  const conns = query.conns?.filter(Boolean)

  const all = readAllLines().map(parse).filter((x): x is AuditEntry => x !== null)
  const filtered = all.filter((e) => {
    if (kinds?.length && !kinds.includes(e.kind)) return false
    if (actors?.length && !actors.some((a) => matchesActor(e.actor, a))) return false
    if (conns?.length && !conns.includes(e.conn || '')) return false
    if (query.sessionId && e.sessionId !== query.sessionId) return false
    if (query.runId && e.runId !== query.runId) return false
    const t = tsOf(e)
    if (query.fromMs != null && t < query.fromMs) return false
    if (query.toMs != null && t > query.toMs) return false
    if (query.approvedOnly && e.approved !== true) return false
    if (query.errorsOnly && !e.error) return false
    if (q) {
      const hay = `${e.detail || ''}\n${e.sql || ''}\n${e.target || ''}\n${e.error || ''}\n${e.conn || ''}\n${e.tool || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
  filtered.sort((a, b) => tsOf(b) - tsOf(a)) // 最新在前
  const entries = filtered.slice(offset, offset + limit)
  return { entries, total: filtered.length, hasMore: offset + entries.length < filtered.length }
}
