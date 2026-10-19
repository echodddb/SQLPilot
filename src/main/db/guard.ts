// SQL 语句分类守门：只读通道只放行明确的读语句。
// 这是"语句层"防线；账号层(只读账号)是第二道兜底。
//
// 分类必须按方言进行。MySQL 与 Oracle 对 `--`、`#`、反斜杠转义、双引号、反引号的
// 语义不同，用同一套词法规则必然在其中一侧漏判：
//   - MySQL 的 `--` 只有后跟空白/控制符时才算注释（`SELECT 0--1 INTO OUTFILE ...`
//     在服务端是 `0 - -1`，不是注释）；
//   - MySQL 默认把 `\` 当字符串转义符，`'a\'' INTO OUTFILE` 会在第二个引号处提前结束；
//   - Oracle 的 `#`、`$` 是合法标识符字符，`FROM t e#` 不能从 `#` 起截断成注释。
// MySQL 的 sql_mode 可能含 NO_BACKSLASH_ESCAPES / ANSI_QUOTES，分类时无法得知，
// 因此对 MySQL 同时按"有转义"和"无转义"两种词法各分类一次，取更严格的结果。

import type { ConnType } from '../types'

export type SqlDialect = 'oracle' | 'mysql'

export function dialectOf(type: ConnType): SqlDialect {
  return type === 'mysql' || type === 'ob-mysql' ? 'mysql' : 'oracle'
}

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

/** 高权限 DDL：改动账号/权限/实例参数，会话放行不得覆盖（每次确认） */
const DANGEROUS_DDL = /\b(?:grant|revoke)\b|\b(?:create|alter|drop)\s+(?:user|role|profile|system|database)\b|\bset\s+(?:global|persist|password)\b|\balter\s+system\b/i

/**
 * 单遍词法扫描，输出用于分类的"纯语句"。规则（顺序即安全性所在）：
 * 1) 先按方言识别字符串字面量（MySQL 的 `\` 转义、Oracle 的 q''、`""`/`` `` `` 转义），
 *    内容清空、保留定界符——字面量里的分号/注释符/关键字既不构成多语句，也不能被注释规则误吞；
 * 2) 再剔除普通注释（块注释、`--` 行注释、MySQL 的 `#` 行注释）——`--` 的判定按方言：
 *    MySQL 要求后跟空白/控制符或行尾，Oracle 无此限制；Oracle 的 `#` 不是注释；
 * 3) MySQL 可执行注释 `/*!...*\/`（含版本号形式）内容按代码保留——它在服务端会真实执行；
 * 4) 未终止的字面量/注释按"已消费到结尾"处理：驱动侧本就报语法错误，分类侧宁可保守。
 */
function normalizeSql(raw: string, dialect: SqlDialect, backslashEscapes: boolean): string {
  const n = raw.length
  const isMy = dialect === 'mysql'
  let out = ''
  let i = 0
  while (i < n) {
    const c = raw[i]
    // MySQL 的 # 行注释；Oracle 中 # 是合法标识符字符，不能当注释
    if (isMy && c === '#') {
      while (i < n && raw[i] !== '\n') i++
      out += ' '
      continue
    }
    if (c === '-' && raw[i + 1] === '-') {
      // MySQL: `--` 后必须是空白/控制符/行尾；否则是减号运算（0--1）
      const after = raw[i + 2]
      const isComment = !isMy || after === undefined || after === '\n' || after === '\r' || after === '\t' || after === ' '
      if (isComment) {
        while (i < n && raw[i] !== '\n') i++
        out += ' '
        continue
      }
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
        out += ' '
        i = close === -1 ? n : close + 2
      }
      continue
    }
    // Oracle q 定界字符串：q'[...]' q'(...)' q'{...}' q'<...>' q'#...#'（定界符自身成对）
    if (!isMy && (c === 'q' || c === 'Q') && raw[i + 1] === "'") {
      const d = raw[i + 2]
      const closer = d === '[' ? "]'" : d === '(' ? ")'" : d === '{' ? "}'" : d === '<' ? ">'" : d + "'"
      const end = raw.indexOf(closer, i + 3)
      out += "''"
      i = end === -1 ? n : end + closer.length
      continue
    }
    // 单引号字符串：MySQL 默认支持 \ 转义（除非 sql_mode 含 NO_BACKSLASH_ESCAPES，由双词法覆盖）
    if (c === "'") {
      i++
      while (i < n) {
        if (isMy && backslashEscapes && raw[i] === '\\') {
          i += 2
          continue
        }
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
    // 双引号：Oracle/ANSI 是标识符（"" 转义）；MySQL 默认是字符串（支持 \ 转义），
    // 开启 ANSI_QUOTES 时才是标识符——两种语义都按最严格方式处理，由双词法覆盖
    if (c === '"') {
      const asString = isMy && backslashEscapes
      const q = c
      i++
      while (i < n) {
        if (asString && raw[i] === '\\') {
          i += 2
          continue
        }
        if (raw[i] === q) {
          if (raw[i + 1] === q) {
            i += 2
            continue
          }
          break
        }
        i++
      }
      out += asString ? "''" : q + q
      if (i < n) i++
      continue
    }
    // 反引号标识符（MySQL）：`` 转义，内容清空防干扰
    if (c === '`') {
      i++
      while (i < n) {
        if (raw[i] === '`') {
          if (raw[i + 1] === '`') {
            i += 2
            continue
          }
          break
        }
        i++
      }
      out += '``'
      if (i < n) i++
      continue
    }
    out += c
    i++
  }
  return out
}

function classifyNormalized(sql: string): SqlVerdict {
  if (!sql) return { ok: false, kind: 'unknown', risk: 3, reason: '空语句' }

  const parts = sql.split(';').map((s) => s.trim()).filter(Boolean)
  if (parts.length > 1) {
    return { ok: false, kind: 'multi', risk: 3, reason: `包含 ${parts.length} 条语句，一次只允许执行一条` }
  }
  const body = parts[0]
  if (!body) return { ok: false, kind: 'unknown', risk: 3, reason: '空语句' }
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
    // 账号/权限/实例级 DDL 提升到 risk 3：会话放行只对普通对象 DDL 生效
    const dangerous = first === 'drop' || first === 'truncate' || DANGEROUS_DDL.test(body)
    return { ok: false, kind: 'ddl', risk: dangerous ? 3 : 2 }
  }
  if (KILL.has(first)) return { ok: false, kind: 'kill', risk: 3 }
  if (PLSQL.has(first)) {
    // SET 可能是会话级（risk 2），也可能是 SET GLOBAL/PASSWORD（risk 3）；CALL/EXEC/BEGIN/DECLARE
    // 可承载任意 PL/SQL 载荷，按高危处理，避免被"会话放行"静默通过
    const dangerous = first !== 'set' || /\bset\s+(?:global|persist|password)\b/i.test(body)
    return { ok: false, kind: 'plsql', risk: dangerous ? 3 : 2 }
  }
  return { ok: false, kind: 'unknown', risk: 3, reason: `无法识别的语句首词: "${first || '(空)'}"` }
}

/** 同一语句在两种词法解释下取更严格的结论（ok=false 优先，其次 risk 更高者） */
function stricter(a: SqlVerdict, b: SqlVerdict): SqlVerdict {
  if (!a.ok && !b.ok) return a.risk >= b.risk ? a : b
  if (!a.ok) return a
  if (!b.ok) return b
  return a
}

export function classifySql(raw: string, dialect: SqlDialect = 'oracle'): SqlVerdict {
  if (dialect === 'mysql') {
    // sql_mode 未知：默认（反斜杠转义）与 NO_BACKSLASH_ESCAPES/ANSI_QUOTES 各判一次
    return stricter(
      classifyNormalized(normalizeSql(raw, 'mysql', true)),
      classifyNormalized(normalizeSql(raw, 'mysql', false))
    )
  }
  return classifyNormalized(normalizeSql(raw, 'oracle', false))
}
