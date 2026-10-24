/**
 * 行文档模型（编辑器内核）
 *
 * 以「行数组」为唯一真源：定位行 O(1)、行内编辑 O(行内容)、新增/删除行 O(行数 memmove)。
 * 不维护全局字符偏移索引——选区、查找、书签全部用 (line, col) 表示，
 * 这样每次按键都不需要重算几十万行偏移，20MB 级文件打字仍然是毫秒级。
 */

export type EolId = 'CRLF' | 'LF' | 'CR'

export interface Pos {
  line: number
  col: number
}

export interface Sel {
  /** 选区锚点（按下鼠标/开始 Shift 选择时的位置） */
  anchor: Pos
  /** 选区活动端（光标位置） */
  head: Pos
}

/** 一次可撤销的编辑：start 行起，before/after 为该区间的整行内容 */
export interface EditRecord {
  start: number
  before: string[]
  after: string[]
  beforePos: Pos
  afterPos: Pos
  time: number
  kind: 'type' | 'edit'
}

export function posEq(a: Pos | null | undefined, b: Pos | null | undefined): boolean {
  return !!a && !!b && a.line === b.line && a.col === b.col
}

export function posCmp(a: Pos, b: Pos): number {
  return a.line !== b.line ? a.line - b.line : a.col - b.col
}

export function selStart(s: Sel): Pos {
  return posCmp(s.anchor, s.head) <= 0 ? s.anchor : s.head
}

export function selEnd(s: Sel): Pos {
  return posCmp(s.anchor, s.head) <= 0 ? s.head : s.anchor
}

export function normText(text: string): string {
  return text.indexOf('\r') >= 0 ? text.replace(/\r\n?/g, '\n') : text
}

export class LineDoc {
  lines: string[]
  eol: EolId
  /** 全文长度（不含换行符）——状态栏展示用，增量维护 */
  charCount = 0

  constructor(text: string, eol: EolId = 'CRLF') {
    this.eol = eol
    const t = normText(text || '')
    this.lines = t.split('\n')
    if (!this.lines.length) this.lines = ['']
    this.recount()
  }

  get lineCount(): number {
    return this.lines.length
  }

  private recount(): void {
    let n = 0
    for (let i = 0; i < this.lines.length; i++) n += this.lines[i].length
    this.charCount = n
  }

  line(i: number): string {
    return this.lines[i] ?? ''
  }

  clamp(p: Pos): Pos {
    const line = Math.max(0, Math.min(this.lines.length - 1, p.line))
    const col = Math.max(0, Math.min(this.lines[line].length, p.col))
    return { line, col }
  }

  /** 文档内的连续文本（行之间用 \n） */
  textRange(a: Pos, b: Pos): string {
    const s = this.clamp(a)
    const e = this.clamp(b)
    if (s.line === e.line) return this.lines[s.line].slice(s.col, e.col)
    const out: string[] = [this.lines[s.line].slice(s.col)]
    for (let i = s.line + 1; i < e.line; i++) out.push(this.lines[i])
    out.push(this.lines[e.line].slice(0, e.col))
    return out.join('\n')
  }

  /** 整篇文本（\n 分隔，保存时再按 EOL 转换） */
  toString(): string {
    return this.lines.join('\n')
  }

  /** 分块拼接，避免超大文档 join 时参数爆栈 */
  toText(): string {
    if (this.lines.length < 200000) return this.lines.join('\n')
    const parts: string[] = []
    const CH = 5000
    for (let i = 0; i < this.lines.length; i += CH) parts.push(this.lines.slice(i, i + CH).join('\n'))
    return parts.join('\n')
  }

  private adjustLen(delta: number): void {
    this.charCount += delta
  }

  /** 在 pos 处插入文本（可含换行），返回插入后的光标位置 */
  insertText(pos: Pos, text: string): Pos {
    const p = this.clamp(pos)
    const t = normText(text)
    const cur = this.lines[p.line]
    if (t.indexOf('\n') < 0) {
      this.lines[p.line] = cur.slice(0, p.col) + t + cur.slice(p.col)
      this.adjustLen(t.length)
      return { line: p.line, col: p.col + t.length }
    }
    const parts = t.split('\n')
    const first = cur.slice(0, p.col) + parts[0]
    const last = parts[parts.length - 1] + cur.slice(p.col)
    const insert = parts.slice(1, -1)
    const replaced = [first, ...insert, last]
    this.lines.splice(p.line, 1, ...replaced)
    // 长度按"行内字符"统计：换行符不计入，故减去拆分出的换行数
    this.adjustLen(t.length - (parts.length - 1))
    return { line: p.line + parts.length - 1, col: parts[parts.length - 1].length }
  }

  /** 删除 [a,b) 区间，返回删除后的光标位置 */
  deleteRange(a: Pos, b: Pos): Pos {
    let s = this.clamp(a)
    let e = this.clamp(b)
    if (posCmp(s, e) > 0) [s, e] = [e, s]
    if (s.line === e.line) {
      const cur = this.lines[s.line]
      this.lines[s.line] = cur.slice(0, s.col) + cur.slice(e.col)
      this.adjustLen(-(e.col - s.col))
      return s
    }
    const head = this.lines[s.line].slice(0, s.col)
    const tail = this.lines[e.line].slice(e.col)
    let removed = 0
    for (let i = s.line; i <= e.line; i++) removed += this.lines[i].length
    const merged = head + tail
    this.adjustLen(merged.length - removed)
    this.lines.splice(s.line, e.line - s.line + 1, merged)
    return s
  }

  /** 用整行数组替换区间（撤销/重做专用） */
  replaceLines(start: number, removeCount: number, insert: string[]): void {
    const removed = this.lines.slice(start, start + removeCount)
    let len = 0
    for (const s of removed) len += s.length
    let insLen = 0
    for (const s of insert) insLen += s.length
    this.adjustLen(insLen - len)
    this.lines.splice(start, removeCount, ...insert)
    if (!this.lines.length) this.lines = ['']
  }
}

/** 撤销栈：按编辑区间记录整行快照，连续输入自动合并为一步 */
export class UndoStack {
  private undoStack: EditRecord[] = []
  private redoStack: EditRecord[] = []
  limit = 500

  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  push(rec: EditRecord): void {
    this.redoStack.length = 0
    const last = this.undoStack[this.undoStack.length - 1]
    const mergeable =
      !!last &&
      last.kind === 'type' &&
      rec.kind === 'type' &&
      rec.time - last.time < 700 &&
      last.start === rec.start &&
      last.before.length === 1 &&
      rec.before.length === 1 &&
      last.after.length === 1 &&
      rec.after.length === 1
    if (mergeable) {
      last.after = rec.after
      last.afterPos = rec.afterPos
      last.time = rec.time
      return
    }
    this.undoStack.push(rec)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
  }

  undo(doc: LineDoc): { pos: Pos; start: number } | null {
    const rec = this.undoStack.pop()
    if (!rec) return null
    doc.replaceLines(rec.start, rec.after.length, rec.before)
    this.redoStack.push(rec)
    return { pos: rec.beforePos, start: rec.start }
  }

  redo(doc: LineDoc): { pos: Pos; start: number } | null {
    const rec = this.redoStack.pop()
    if (!rec) return null
    doc.replaceLines(rec.start, rec.before.length, rec.after)
    this.undoStack.push(rec)
    return { pos: rec.afterPos, start: rec.start }
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }
}

/** 单词/标识符字符判定（中英文都算词内字符，双击中文也能选中整段） */
export function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false
  return /[A-Za-z0-9_\u00c0-\uffff]/.test(ch) && !/\s/.test(ch)
}

export function wordRangeAt(line: string, col: number): { a: number; b: number } {
  let a = col
  let b = col
  while (a > 0 && isWordChar(line[a - 1])) a--
  while (b < line.length && isWordChar(line[b])) b++
  if (a === b) {
    // 空白或标点：选中一段同类字符
    const ch = line[col] ?? ''
    if (!ch) return { a: col, b: col }
    if (/\s/.test(ch)) {
      while (a > 0 && /\s/.test(line[a - 1])) a--
      while (b < line.length && /\s/.test(line[b])) b++
    } else {
      b = col + 1
    }
  }
  return { a, b }
}

export function indentOf(line: string): string {
  const m = /^[ \t]*/.exec(line)
  return m ? m[0] : ''
}
