// SQL 语句分类守门：只读通道只放行明确的读语句。
// 这是"语句层"防线；账号层(只读账号)是第二道兜底。

export interface SqlVerdict {
  /** 是否允许走只读通道 */
  ok: boolean
  kind: 'read' | 'dml' | 'ddl' | 'plsql' | 'kill' | 'multi' | 'unknown'
  risk: 0 | 1 | 2 | 3
  reason?: string
}

const READ_FIRST = new Set(['select', 'with', 'explain', 'show', 'desc', 'describe'])
const DML = new Set(['insert', 'update', 'delete', 'merge'])
const DDL = new Set(['create', 'alter', 'drop', 'truncate', 'comment', 'rename', 'grant', 'revoke', 'flashback', 'purge', 'audit', 'noaudit'])
const KILL = new Set(['kill', 'shutdown', 'startup'])
const PLSQL = new Set(['exec', 'execute', 'call', 'begin', 'declare', 'set'])

export function classifySql(raw: string): SqlVerdict {
  let sql = raw.trim()
  sql = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim()
  if (!sql) return { ok: false, kind: 'unknown', risk: 3, reason: '空语句' }

  // 检测用副本：把字符串字面量清空，避免字面量里的分号/关键字造成误判。
  // 先处理 Oracle q 字面量（q'[...]' 配对定界 / q'#...#' 单字符定界），其中的分号不构成多语句
  const plain = sql
    .replace(/\bq'([\[\(\{<])[\s\S]*?[\]\)\}>]'/gi, "''")
    .replace(/\bq'(.)[\s\S]*?\1'/gi, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``')

  const parts = plain.split(';').map((s) => s.trim()).filter(Boolean)
  if (parts.length > 1) {
    return { ok: false, kind: 'multi', risk: 3, reason: `包含 ${parts.length} 条语句，一次只允许执行一条` }
  }
  const body = parts[0]
  const first = (body.match(/^[a-zA-Z]+/)?.[0] || '').toLowerCase()

  if (READ_FIRST.has(first)) {
    // MySQL 8 的 EXPLAIN ANALYZE 会对写语句真实执行——explain 后跟写动词时拒绝走只读通道
    if (first === 'explain' && /\b(insert|update|delete|merge|replace)\b/i.test(body)) {
      return { ok: false, kind: 'dml', risk: 2, reason: 'EXPLAIN 的目标是写语句（EXPLAIN ANALYZE 形式可能实际执行）' }
    }
    if (/\bfor\s+update\b/i.test(body) || /\block\s+in\s+share\s+mode\b/i.test(body)) {
      return { ok: false, kind: 'dml', risk: 2, reason: '读语句包含锁定子句' }
    }
    if (/\binto\s+(out|dump)?file\b/i.test(body) || /\binto\s+dumpfile\b/i.test(body)) {
      return { ok: false, kind: 'dml', risk: 2, reason: '读语句包含写文件子句' }
    }
    // MySQL 8 / OB 支持 WITH ... INSERT/UPDATE/DELETE，首词是 WITH 也要查写动词
    if (first === 'with' && /\b(insert|update|delete|merge)\b/i.test(body)) {
      return { ok: false, kind: 'dml', risk: 2, reason: 'CTE 语句包含写操作' }
    }
    // PG 的 SELECT ... INTO newtable 会建新表；MySQL 的 INTO @var 以 @ 开头已排除
    if (/\binto\s+(?!outfile\b|dumpfile\b|@)[a-z_][\w$#]*\b/i.test(body)) {
      return { ok: false, kind: 'ddl', risk: 2, reason: 'SELECT INTO 会写入/创建目标对象' }
    }
    return { ok: true, kind: 'read', risk: 0 }
  }
  if (DML.has(first)) return { ok: false, kind: 'dml', risk: 2 }
  if (DDL.has(first)) {
    return { ok: false, kind: 'ddl', risk: first === 'drop' || first === 'truncate' ? 3 : 2 }
  }
  if (KILL.has(first)) return { ok: false, kind: 'kill', risk: 3 }
  if (PLSQL.has(first)) return { ok: false, kind: 'plsql', risk: 2 }
  return { ok: false, kind: 'unknown', risk: 3, reason: `无法识别的语句首词: "${first || '(空)'}"` }
}
