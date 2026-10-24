/** 语法高亮：逐行分词 + 跨行状态（块注释 / 三引号 / CDATA / 代码围栏）缓存 */
import type { LangDef } from './langs'

export interface Token {
  s: number
  e: number
  c: string
}

/** 跨行状态 */
const S_NORMAL = 0
const S_BLOCK_COMMENT = 1
const S_TRIPLE_BASE = 2 // 2 + triple 下标
const S_DOLLAR = 6
const S_XML_COMMENT = 7
const S_FENCE = 8

const IDENT_RE = /[A-Za-z0-9_$@#\u00c0-\uffff]/
const IDENT_START_RE = /[A-Za-z_$@#\u00c0-\uffff]/
const NUMBER_RE = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)/
const OP_RE = /^(?:<=>|<>|!=|>=|<=|::|:=|=>|->>|->|\|\||&&|\*\*|[-+*/%=<>!&|^~]+)/

function isWord(ch: string | undefined): boolean {
  return !!ch && IDENT_RE.test(ch)
}

const kwCache = new WeakMap<LangDef, { kw: Set<string>; type: Set<string>; const: Set<string> }>()

function setsOf(lang: LangDef) {
  let s = kwCache.get(lang)
  if (!s) {
    s = {
      kw: new Set((lang.keywords || []).map((k) => (lang.ignoreCase ? k.toLowerCase() : k))),
      type: new Set((lang.types || []).map((k) => (lang.ignoreCase ? k.toLowerCase() : k))),
      const: new Set((lang.constants || []).map((k) => (lang.ignoreCase ? k.toLowerCase() : k)))
    }
    kwCache.set(lang, s)
  }
  return s
}

export function tokenize(line: string, state: number, lang: LangDef): { tokens: Token[]; state: number } {
  if (lang.special) return tokenizeSpecial(line, state, lang)
  return tokenizeCode(line, state, lang)
}

function tokenizeCode(line: string, state: number, lang: LangDef): { tokens: Token[]; state: number } {
  const n = line.length
  const tokens: Token[] = []
  const push = (s: number, e: number, c: string) => { if (e > s) tokens.push({ s, e, c }) }
  const bc = lang.blockComment
  const triples = lang.triple || []
  const quotes = lang.quotes || []
  const lcs = lang.lineComment || []
  const { kw, type, const: consts } = setsOf(lang)
  let i = 0

  while (i < n) {
    // ---- 跨行状态续接 ----
    if (state === S_BLOCK_COMMENT && bc) {
      const idx = line.indexOf(bc[1], i)
      if (idx < 0) { push(i, n, 'com'); i = n } else { push(i, idx + bc[1].length, 'com'); i = idx + bc[1].length; state = S_NORMAL }
      continue
    }
    if (state >= S_TRIPLE_BASE && state < S_TRIPLE_BASE + triples.length) {
      const d = triples[state - S_TRIPLE_BASE]
      const idx = line.indexOf(d, i)
      if (idx < 0) { push(i, n, 'str'); i = n } else { push(i, idx + d.length, 'str'); i = idx + d.length; state = S_NORMAL }
      continue
    }
    if (state === S_DOLLAR) {
      const idx = line.indexOf('$$', i)
      if (idx < 0) { push(i, n, 'str'); i = n } else { push(i, idx + 2, 'str'); i = idx + 2; state = S_NORMAL }
      continue
    }

    const ch = line[i]
    if (ch === ' ' || ch === '\t') { i++; continue }

    // ---- 行注释 ----
    let lineCom = false
    for (const lc of lcs) {
      if (lc.length && line.startsWith(lc, i)) {
        // REM 需要词边界，避免命中 "REMARK"
        if (/^rem$/i.test(lc) && isWord(line[i + 3])) continue
        push(i, n, 'com')
        i = n
        lineCom = true
        break
      }
    }
    if (lineCom) break

    // ---- 块注释 ----
    if (bc && line.startsWith(bc[0], i)) {
      const start = i
      const idx = line.indexOf(bc[1], i + bc[0].length)
      if (idx < 0) { push(start, n, 'com'); i = n; state = S_BLOCK_COMMENT } else { push(start, idx + bc[1].length, 'com'); i = idx + bc[1].length }
      continue
    }

    // ---- 三引号 ----
    let tripleHit = -1
    for (let k = 0; k < triples.length; k++) if (line.startsWith(triples[k], i)) { tripleHit = k; break }
    if (tripleHit >= 0) {
      const d = triples[tripleHit]
      const start = i
      const idx = line.indexOf(d, i + d.length)
      if (idx < 0) { push(start, n, 'str'); i = n; state = S_TRIPLE_BASE + tripleHit } else { push(start, idx + d.length, 'str'); i = idx + d.length }
      continue
    }

    // ---- SQL 美元引用 ----
    if (lang.dollarQuote && ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(line.slice(i, i + 32))
      if (m) {
        const tag = m[0]
        const start = i
        const idx = line.indexOf(tag, i + tag.length)
        if (idx < 0) {
          push(start, n, 'str'); i = n
          if (tag === '$$') state = S_DOLLAR
        } else { push(start, idx + tag.length, 'str'); i = idx + tag.length }
        continue
      }
    }

    // ---- 字符串 ----
    if (quotes.indexOf(ch) >= 0) {
      const q = ch
      let j = i + 1
      while (j < n) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === q) {
          if (line[j + 1] === q && (lang.id === 'sql' || lang.id === 'plsql')) { j += 2; continue }
          j++
          break
        }
        j++
      }
      if (j > n) j = n
      push(i, j, 'str')
      i = j
      continue
    }

    // ---- 数字 ----
    if ((ch >= '0' && ch <= '9') || (ch === '.' && line[i + 1] >= '0' && line[i + 1] <= '9')) {
      const m = NUMBER_RE.exec(line.slice(i, i + 40))
      if (m) { push(i, i + m[0].length, 'num'); i += m[0].length; continue }
    }

    // ---- 变量（shell 风格 $VAR / ${VAR}） ----
    if (ch === '$' && lang.special === 'shell') {
      let j = i + 1
      if (line[j] === '{') { const k = line.indexOf('}', j); j = k < 0 ? n : k + 1 }
      else while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++
      push(i, j, 'var')
      i = j
      continue
    }

    // ---- 标识符 / 关键字 ----
    if (IDENT_START_RE.test(ch)) {
      let j = i + 1
      while (j < n && isWord(line[j])) j++
      // SQL 里 @var 这类也按整体处理
      const word = line.slice(i, j)
      const key = lang.ignoreCase ? word.toLowerCase() : word
      if (kw.has(key)) push(i, j, 'kw')
      else if (type.has(key)) push(i, j, 'type')
      else if (consts.has(key)) push(i, j, 'const')
      else {
        // 函数调用：标识符后紧跟 (
        let k = j
        while (k < n && (line[k] === ' ' || line[k] === '\t')) k++
        if (line[k] === '(') push(i, j, 'fn')
      }
      i = j
      continue
    }

    // ---- 运算符 ----
    const m = OP_RE.exec(line.slice(i, i + 8))
    if (m) { push(i, i + m[0].length, 'op'); i += m[0].length; continue }

    i++
  }

  return { tokens, state }
}

// ---------------- 特殊语言 ----------------

function tokenizeSpecial(line: string, state: number, lang: LangDef): { tokens: Token[]; state: number } {
  switch (lang.special) {
    case 'xml': return tokenizeXml(line, state)
    case 'markdown': return tokenizeMarkdown(line, state)
    case 'log': return tokenizeLog(line)
    case 'ini': return tokenizeIni(line)
    case 'yaml': return tokenizeYaml(line)
    case 'json': return tokenizeJson(line)
    case 'diff': return tokenizeDiff(line)
    case 'shell': return tokenizeCode(line, state, lang)
    default: return tokenizeCode(line, state, lang)
  }
}

function tokenizeXml(line: string, state: number): { tokens: Token[]; state: number } {
  const n = line.length
  const tokens: Token[] = []
  const push = (s: number, e: number, c: string) => { if (e > s) tokens.push({ s, e, c }) }
  let i = 0
  while (i < n) {
    if (state === S_XML_COMMENT) {
      const idx = line.indexOf('-->', i)
      if (idx < 0) { push(i, n, 'com'); i = n } else { push(i, idx + 3, 'com'); i = idx + 3; state = S_NORMAL }
      continue
    }
    const ch = line[i]
    if (line.startsWith('<!--', i)) {
      const idx = line.indexOf('-->', i + 4)
      if (idx < 0) { push(i, n, 'com'); i = n; state = S_XML_COMMENT } else { push(i, idx + 3, 'com'); i = idx + 3 }
      continue
    }
    if (line.startsWith('<![CDATA[', i)) {
      const idx = line.indexOf(']]>', i + 9)
      if (idx < 0) { push(i, n, 'str'); i = n } else { push(i, idx + 3, 'str'); i = idx + 3 }
      continue
    }
    if (ch === '<') {
      if (line[i + 1] === '!' || line[i + 1] === '?') {
        const idx = line.indexOf('>', i)
        const end = idx < 0 ? n : idx + 1
        push(i, end, 'com')
        i = end
        continue
      }
      let j = i
      push(j, j + 1, 'op'); j++
      if (line[j] === '/') { push(j, j + 1, 'op'); j++ }
      const nameStart = j
      while (j < n && /[A-Za-z0-9_:.-]/.test(line[j])) j++
      push(nameStart, j, 'tag')
      // 属性
      while (j < n) {
        while (j < n && /\s/.test(line[j])) j++
        if (j >= n) break
        if (line[j] === '>') { push(j, j + 1, 'op'); j++; break }
        if (line[j] === '/' && line[j + 1] === '>') { push(j, j + 2, 'op'); j += 2; break }
        const as = j
        while (j < n && /[A-Za-z0-9_:.-]/.test(line[j])) j++
        if (j > as) push(as, j, 'attr')
        else j++
        while (j < n && /\s/.test(line[j])) j++
        if (line[j] === '=') {
          push(j, j + 1, 'op'); j++
          while (j < n && /\s/.test(line[j])) j++
          if (line[j] === '"' || line[j] === "'") {
            const q = line[j]
            const vs = j
            j++
            while (j < n && line[j] !== q) j++
            if (j < n) j++
            push(vs, j, 'str')
          }
        }
      }
      i = j
      continue
    }
    if (ch === '&') {
      const idx = line.indexOf(';', i)
      if (idx > i && idx - i < 12) { push(i, idx + 1, 'num'); i = idx + 1; continue }
    }
    i++
  }
  return { tokens, state }
}

function tokenizeMarkdown(line: string, state: number): { tokens: Token[]; state: number } {
  const n = line.length
  const tokens: Token[] = []
  const push = (s: number, e: number, c: string) => { if (e > s) tokens.push({ s, e, c }) }
  if (state === S_FENCE) {
    if (/^\s*(```|~~~)/.test(line)) { push(0, n, 'op'); return { tokens, state: S_NORMAL } }
    push(0, n, 'str')
    return { tokens, state }
  }
  if (/^\s*(```|~~~)/.test(line)) { push(0, n, 'op'); return { tokens, state: S_FENCE } }
  const h = /^(#{1,6})\s+/.exec(line)
  if (h) { push(0, n, 'head'); return { tokens, state } }
  if (/^\s*>/.test(line)) { push(0, n, 'com'); return { tokens, state } }
  const li = /^(\s*)([-*+]|\d+\.)\s/.exec(line)
  if (li) push(li[1].length, li[1].length + li[2].length, 'kw')
  let i = 0
  while (i < n) {
    if (line[i] === '`') {
      const idx = line.indexOf('`', i + 1)
      if (idx > i) { push(i, idx + 1, 'str'); i = idx + 1; continue }
    }
    if (line.startsWith('**', i) || line.startsWith('__', i)) {
      const d = line.slice(i, i + 2)
      const idx = line.indexOf(d, i + 2)
      if (idx > i) { push(i, idx + 2, 'bold'); i = idx + 2; continue }
    }
    if (line[i] === '[') {
      const close = line.indexOf(']', i)
      if (close > i && line[close + 1] === '(') {
        const end = line.indexOf(')', close)
        if (end > close) { push(i, end + 1, 'link'); i = end + 1; continue }
      }
    }
    i++
  }
  return { tokens, state }
}

const LOG_RE = /(\b(?:ERROR|ERR|FATAL|CRITICAL|SEVERE|PANIC|ORA-\d+)\b)|(\b(?:WARN|WARNING)\b)|(\b(?:INFO|NOTICE)\b)|(\b(?:DEBUG|TRACE|VERBOSE)\b)|(\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b)|(\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b)/gi

function tokenizeLog(line: string): { tokens: Token[]; state: number } {
  const tokens: Token[] = []
  LOG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LOG_RE.exec(line))) {
    let c = 'num'
    if (m[1]) c = 'err'
    else if (m[2]) c = 'warn'
    else if (m[3]) c = 'info'
    else if (m[4]) c = 'dim'
    tokens.push({ s: m.index, e: m.index + m[0].length, c })
    if (m[0].length === 0) LOG_RE.lastIndex++
  }
  return { tokens, state: S_NORMAL }
}

function tokenizeIni(line: string): { tokens: Token[]; state: number } {
  const n = line.length
  const tokens: Token[] = []
  const push = (s: number, e: number, c: string) => { if (e > s) tokens.push({ s, e, c }) }
  const t = line.trimStart()
  if (!t) return { tokens, state: S_NORMAL }
  if (t[0] === ';' || t[0] === '#') { push(n - t.length, n, 'com'); return { tokens, state: S_NORMAL } }
  const sec = /^\[([^\]]*)\]/.exec(t)
  if (sec) { push(n - t.length, n - t.length + sec[0].length, 'tag'); return { tokens, state: S_NORMAL } }
  const kv = /^([^=:]+)([=:])/.exec(t)
  if (kv) {
    const off = n - t.length
    push(off, off + kv[1].length, 'key')
    push(off + kv[1].length, off + kv[0].length, 'op')
    const rest = t.slice(kv[0].length)
    if (/^\s*[;#]/.test(rest)) {
      const idx = rest.search(/[;#]/)
      push(off + kv[0].length + idx, n, 'com')
    }
    return { tokens, state: S_NORMAL }
  }
  return { tokens, state: S_NORMAL }
}

function tokenizeYaml(line: string): { tokens: Token[]; state: number } {
  const n = line.length
  const tokens: Token[] = []
  const push = (s: number, e: number, c: string) => { if (e > s) tokens.push({ s, e, c }) }
  let i = 0
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++
  if (line[i] === '#') { push(i, n, 'com'); return { tokens, state: S_NORMAL } }
  if (line[i] === '-') { push(i, i + 1, 'op'); i++ }
  const kv = /^([A-Za-z0-9_.-]+)(\s*:)/.exec(line.slice(i))
  if (kv) { push(i, i + kv[1].length, 'key'); push(i + kv[1].length, i + kv[0].length, 'op'); i += kv[0].length }
  return { tokens, state: S_NORMAL }
}

function tokenizeJson(line: string): { tokens: Token[]; state: number } {
  const n = line.length
  const tokens: Token[] = []
  const push = (s: number, e: number, c: string) => { if (e > s) tokens.push({ s, e, c }) }
  let i = 0
  while (i < n) {
    const ch = line[i]
    if (ch === '"') {
      let j = i + 1
      while (j < n) { if (line[j] === '\\') { j += 2; continue } if (line[j] === '"') { j++; break } j++ }
      let k = j
      while (k < n && /\s/.test(line[k])) k++
      push(i, j, line[k] === ':' ? 'key' : 'str')
      i = j
      continue
    }
    if (line.startsWith('//', i)) { push(i, n, 'com'); break }
    if ((ch >= '0' && ch <= '9') || ch === '-') {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(line.slice(i))
      if (m) { push(i, i + m[0].length, 'num'); i += m[0].length; continue }
    }
    if (/[A-Za-z]/.test(ch)) {
      const m = /^[A-Za-z_]+/.exec(line.slice(i))
      if (m) {
        push(i, i + m[0].length, /^(true|false|null)$/.test(m[0]) ? 'const' : 'kw')
        i += m[0].length
        continue
      }
    }
    i++
  }
  return { tokens, state: S_NORMAL }
}

function tokenizeDiff(line: string): { tokens: Token[]; state: number } {
  const n = line.length
  const tokens: Token[] = []
  if (line.startsWith('@@')) tokens.push({ s: 0, e: n, c: 'kw' })
  else if (line.startsWith('+++') || line.startsWith('---')) tokens.push({ s: 0, e: n, c: 'head' })
  else if (line[0] === '+') tokens.push({ s: 0, e: n, c: 'add' })
  else if (line[0] === '-') tokens.push({ s: 0, e: n, c: 'del' })
  else if (line.startsWith('diff ') || line.startsWith('index ')) tokens.push({ s: 0, e: n, c: 'com' })
  return { tokens, state: S_NORMAL }
}

/**
 * 跨行状态缓存：只缓存"每行行首状态"，行内容不缓存。
 * 编辑某行后从该行起失效，下次渲染时按需向后重算。
 */
export class HighlightCache {
  private states: Uint8Array = new Uint8Array(1024)
  private highest = 0 // 已计算到（不含）的行号
  private lang: LangDef | null = null
  private total = 0
  /** 超过该行数不再做跨行状态推算（逐行独立着色，避免跳转到最后一行时扫描全文） */
  maxStateLines = 400000

  reset(lang: LangDef, lineCount: number): void {
    this.lang = lang
    this.total = lineCount
    this.ensure(lineCount)
    this.states.fill(255, 0, Math.min(this.states.length, lineCount))
    this.states[0] = S_NORMAL
    this.highest = 1
  }

  setLineCount(n: number): void {
    this.total = n
    if (n > this.states.length) this.ensure(n)
    if (this.highest > n) this.highest = n
  }

  private ensure(n: number): void {
    if (n <= this.states.length) return
    let cap = this.states.length
    while (cap < n) cap *= 2
    const next = new Uint8Array(cap)
    next.fill(255)
    next.set(this.states)
    this.states = next
  }

  invalidate(fromLine: number): void {
    if (fromLine < this.highest) {
      this.highest = Math.max(0, fromLine)
      if (fromLine < this.states.length) this.states[fromLine] = fromLine === 0 ? S_NORMAL : 255
    }
  }

  private stateAt(line: number, getLine: (n: number) => string): number {
    if (!this.lang) return S_NORMAL
    if (this.total > this.maxStateLines) return S_NORMAL
    if (line < this.highest && this.states[line] !== 255) return this.states[line]
    if (line > this.highest + 30000) {
      // 距离太远：放弃跨行推算，避免为了一屏内容扫描几十万行
      this.ensure(line + 1)
      this.states[line] = S_NORMAL
      return S_NORMAL
    }
    let s = this.highest > 0 ? (this.states[this.highest - 1] === 255 ? S_NORMAL : this.states[this.highest - 1]) : S_NORMAL
    for (let i = Math.max(0, this.highest - 1); i < line; i++) {
      const r = tokenize(getLine(i), s, this.lang)
      s = r.state
      this.states[i + 1] = s
    }
    this.highest = line + 1
    this.states[line] = this.states[line] === 255 ? S_NORMAL : this.states[line]
    return this.states[line]
  }

  tokensFor(getLine: (n: number) => string, line: number, text: string): Token[] {
    if (!this.lang) return []
    const st = this.stateAt(line, getLine)
    return tokenize(text, st, this.lang).tokens
  }
}
