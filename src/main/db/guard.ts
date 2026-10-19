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
const DML = new Set(['insert', 'update', 'delete', 'merge', 'replace', 'load'])
const DDL = new Set(['create', 'alter', 'drop', 'truncate', 'comment', 'rename', 'grant', 'revoke', 'flashback', 'purge', 'audit', 'noaudit'])
const KILL = new Set(['kill', 'shutdown', 'startup'])
const PLSQL = new Set(['exec', 'execute', 'call', 'begin', 'declare', 'set'])

/**
 * 单遍词法扫描，输出用于分类的"纯语句"。规则（顺序即安全性所在）：
 * 1) 字符串字面量（含 Oracle q'' 定界形式、'' 与 "" 与 `` 转义）内容清空、保留定界符——
 *    字面量里的分号/注释符/关键字既不构成多语句，也不能被注释规则误吞；
 * 2) 普通注释（块注释 /*...*\/、-- 行注释、# 行注释）剔除；
 * 3) MySQL 可执行注释 /*!...*\/（含 /*!50003 版本形式）内容按代码保留——它在服务端会真实执行，
 *    当普通注释剥掉等于给 INTO OUTFILE / 多语句注入让路；
 * 4) 未终止的字面量/注释按"已消费到结尾"处理：驱动侧本就报语法错误，分类侧宁可保守。
 */
function normalizeSql(raw: string): string {
  const n = raw.length
  let out = ''
  let i = 0
  while (i < n) {
    const c = raw[i]
    // 行注释：-- 与 #（# 在 Oracle 可出现在标识符中，但剔除只影响读语句内部细节，不影响首词判断）
    if ((c === '-' && raw[i + 1] === '-') || c === '#') {
      while (i < n && raw[i] !== '\n') i++
      out += ' '
      continue
    }
    if (c === '/' && raw[i + 1] === '*') {
      if (raw[i + 2] === '!') {
        // MySQL 可执行注释：跳过 "!" 与可选版本号前缀，内容按代码保留
        let j = i + 3
        while (j < n && raw[j] >= '0' && raw[j] <= '9') j++
        const close = raw.indexOf('*/', j)
        if (close === -1) {
          out += ' ' + raw.slice(j) // 未终止：按代码保留，宁可误拒不可误放
          i = n
        } else {
          out += ' ' + raw.slice(j, close) + ' '
          i = close + 2
        }
      } else {
        const close = raw.indexOf('*/', i + 2)
        if (close === -1) {
          out += ' '
          i = n
        } else {
          out += ' '
          i = close + 2
        }
      }
      continue
    }
    // Oracle q 定界字符串：q'[...]' q'(...)' q'{...}' q'<...>' q'#...#'（定界符自身成对）
    if ((c === 'q' || c === 'Q') && raw[i + 1] === "'") {
      const d = raw[i + 2]
      const closer = d === '[' ? "]'" : d === '(' ? ")'" : d === '{' ? "}'" : d === '<' ? ">'" : d + "'"
      const end = raw.indexOf(closer, i + 3)
      out += "''"
      i = end === -1 ? n : end + closer.length
      continue
    }
    // 普通字符串字面量（'' 为 SQL 标准转义；\' 由驱动层语法保证，分类层无需处理）
    if (c === "'") {
      i++
      while (i < n) {
        if (raw[i] === "'") {
          if (raw[i + 1] === "'") {
            i += 2
            continue
          }
          break
        }
        i++
      }
      out += "''"
      if (i < n) i++
      continue
    }
    // 引号标识符 ""（ANSI，"" 转义）与 ``（MySQL，`` 转义）：内容清空防干扰
    if (c === '"' || c === '`') {
      const q = c
      i++
      while (i < n) {
        if (raw[i] === q) {
          if (raw[i + 1] === q) {
            i += 2
            continue
          }
          break
        }
        i++
      }
      out += q + q
      if (i < n) i++
      continue
    }
    out += c
    i++
  }
  return out
}

export function classifySql(raw: string): SqlVerdict {
  const sql = normalizeSql(raw).trim()
  if (!sql) return { ok: false, kind: 'unknown', risk: 3, reason: '空语句' }

  const parts = sql.split(';').map((s) => s.trim()).filter(Boolean)
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
    if (first === 'with') {
      // MySQL 8 / OB 支持 WITH ... INSERT/UPDATE/DELETE，首词是 WITH 也要查写动词；
      // Oracle 12c+ 还支持 WITH FUNCTION（可内联 PRAGMA AUTONOMOUS_TRANSACTION + EXECUTE IMMEDIATE
      // 携带 DML/DDL），这类 PL/SQL 载荷一律不允许走只读通道
      if (/\b(insert|update|delete|merge)\b/i.test(body)) {
        return { ok: false, kind: 'dml', risk: 2, reason: 'CTE 语句包含写操作' }
      }
      if (/\b(function|procedure|pragma|execute\s+immediate)\b/i.test(body)) {
        return { ok: false, kind: 'plsql', risk: 2, reason: 'WITH 子句携带 PL/SQL 定义（FUNCTION/PROCEDURE/PRAGMA/EXECUTE IMMEDIATE）' }
      }
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
