/** 标签页数据模型 */
import { markRaw, reactive } from 'vue'
import { LineDoc, UndoStack, type EolId, type Pos, type Sel } from './model'
import { HighlightCache } from './highlight'
import { langById } from './langs'

export type EncodingId = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'gbk' | 'gb18030' | 'big5' | 'latin1'

export interface FindState {
  query: string
  replacement: string
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
  /** 当前定位到的命中（用于高亮区分） */
  current: { line: number; start: number; end: number } | null
}

export interface Tab {
  id: string
  path: string | null
  name: string
  encoding: EncodingId
  eol: EolId
  langId: string
  mode: 'full' | 'window'
  readOnly: boolean
  dirty: boolean
  /** 正在重新解码/整篇载入：期间禁止重复触发 */
  busy?: boolean
  doc: LineDoc | null
  lineCount: number
  charCount: number
  size: number
  maxLineLen: number
  caret: Pos
  sel: Sel | null
  block: boolean
  scrollTop: number
  scrollLeft: number
  wrap: boolean
  zoom: number
  overtype: boolean
  bookmarks: number[]
  rev: number
  undo: UndoStack
  hl: HighlightCache
  win: { start: number; lines: string[]; total: number }
  find: FindState
}

export interface DocMetaLike {
  id: string
  path: string | null
  name: string
  size: number
  mtimeMs: number
  encoding: EncodingId
  eol: EolId
  lineCount: number
  mode: 'full' | 'window'
  langHint?: string
  text?: string
}

export function maxLineLengthOf(lines: string[]): number {
  let max = 0
  for (let i = 0; i < lines.length; i++) if (lines[i].length > max) max = lines[i].length
  return max
}

export function createTab(meta: DocMetaLike, langId: string): Tab {
  const hasText = typeof meta.text === 'string'
  const doc = hasText ? new LineDoc(meta.text as string, meta.eol) : null
  const lineCount = doc ? doc.lineCount : meta.lineCount
  const hl = new HighlightCache()
  hl.reset(langById(langId), lineCount)
  return reactive<Tab>({
    id: meta.id,
    path: meta.path,
    name: meta.name,
    encoding: meta.encoding,
    eol: meta.eol,
    langId,
    mode: meta.mode,
    readOnly: meta.mode === 'window',
    dirty: false,
    doc: doc ? markRaw(doc) : null,
    lineCount,
    charCount: doc ? doc.charCount : 0,
    size: meta.size,
    maxLineLen: doc ? maxLineLengthOf(doc.lines) : 200,
    caret: { line: 0, col: 0 },
    sel: null,
    block: false,
    scrollTop: 0,
    scrollLeft: 0,
    wrap: false,
    zoom: 1,
    overtype: false,
    bookmarks: [],
    rev: 0,
    undo: markRaw(new UndoStack()),
    hl: markRaw(hl),
    win: markRaw({ start: -1, lines: [], total: meta.lineCount }),
    find: { query: '', replacement: '', matchCase: false, wholeWord: false, regex: false, current: null }
  }) as Tab
}
