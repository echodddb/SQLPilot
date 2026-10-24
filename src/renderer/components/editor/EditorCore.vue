<template>
  <div
    class="te"
    :class="{ 'te-wrap': tab.wrap, 'te-readonly': tab.readOnly }"
    @mousedown="onMouseDown"
    @contextmenu.prevent="onContextMenu"
  >
    <div class="te-scroll" ref="scrollEl" @scroll.passive="onScroll">
      <div class="te-canvas" :style="{ height: canvasH + 'px' }"></div>
      <div
        class="te-rows"
        ref="rowsEl"
        :style="{ top: rowsTop + 'px', fontSize: fontSize + 'px', lineHeight: lh + 'px' }"
      >
        <div
          v-for="row in rows"
          :key="row.line"
          class="te-row"
          :class="{ cur: highlightCurrentLine && row.line === caretLine }"
          :style="{ height: tab.wrap ? 'auto' : lh + 'px' }"
          :data-line="row.line"
          v-memo="[row, row.line === caretLine]"
        >
          <div
            v-if="showLineNumbers"
            class="te-gln"
            data-gutter="1"
            :class="{ cur: row.line === caretLine, bookmarked: isBookmarked(row.line) }"
            :style="{ width: gutterW + 'px' }"
          >{{ row.line + 1 }}</div>
          <div class="te-code">
            <template v-for="(seg, i) in row.segs" :key="i">
              <span v-if="seg.caret" class="te-caret" :class="{ blink: focused }" aria-hidden="true"></span>
              <span v-else :class="seg.cls" :data-off="seg.off">{{ seg.t }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>

    <textarea
      ref="imeEl"
      class="te-ime"
      :style="imeStyle"
      spellcheck="false"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      @keydown="onKeyDown"
      @input="onInput"
      @compositionstart="onCompStart"
      @compositionupdate="onCompUpdate"
      @compositionend="onCompEnd"
      @paste="onPaste"
      @copy="onCopyEvent"
      @cut="onCutEvent"
      @focus="focused = true"
      @blur="onBlur"
    ></textarea>
    <div v-if="compText && focused" class="te-comp" :style="compStyle">{{ compText }}</div>
    <div v-if="imeHint" class="te-hint">{{ imeHint }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  indentOf, isWordChar, posCmp, selEnd, selStart, wordRangeAt,
  type EditRecord, type Pos, type Sel
} from '../../editor/model'
import { langById } from '../../editor/langs'
import { tokenize, type Token } from '../../editor/highlight'
import { SearchMatcher } from '../../editor/search'
import type { Tab } from '../../editor/types'

const props = defineProps<{
  tab: Tab
  fontSize: number
  showLineNumbers: boolean
  showInvisibles: boolean
  highlightCurrentLine: boolean
  matchBrackets: boolean
  autoClose: boolean
  tabSize: number
  useSpaces: boolean
  active: boolean
}>()

const emit = defineEmits<{
  (e: 'change'): void
  (e: 'cmd', name: string): void
  (e: 'contextmenu', p: { x: number; y: number }): void
  (e: 'goto-line', line: number): void
}>()

const scrollEl = ref<HTMLElement | null>(null)
const rowsEl = ref<HTMLElement | null>(null)
const imeEl = ref<HTMLTextAreaElement | null>(null)

const scrollTopRef = ref(0)
const scrollLeftRef = ref(0)
const viewH = ref(600)
const viewW = ref(900)
const focused = ref(false)
const compText = ref('')
const imePos = ref({ left: 0, top: 0, height: 18 })
const imeHint = ref('')

const OVERSCAN = 8
const MAX_SCROLL_PX = 18_000_000

const lh = computed(() => Math.max(14, Math.round(props.fontSize * props.tab.zoom * 1.55)))
const gutterW = computed(() => {
  const digits = String(Math.max(1, props.tab.lineCount)).length
  return Math.max(46, Math.round(digits * props.fontSize * props.tab.zoom * 0.66) + 24)
})

const caretLine = computed(() => props.tab.caret.line)

// ---------------- 滚动模型 ----------------
const exactH = computed(() => props.tab.lineCount * lh.value)
const overflow = computed(() => exactH.value > MAX_SCROLL_PX)
const canvasH = computed(() => {
  if (overflow.value) return MAX_SCROLL_PX
  if (props.tab.wrap) return Math.max(viewH.value, props.tab.lineCount * lh.value * wrapFactor.value)
  return Math.max(exactH.value, viewH.value)
})
const linesPerPx = computed(() => (overflow.value ? props.tab.lineCount / MAX_SCROLL_PX : 1 / lh.value))

const wrapFactor = ref(1)

const firstLine = computed(() => {
  if (props.tab.wrap) {
    const step = Math.max(1, lh.value * wrapFactor.value)
    return Math.max(0, Math.min(props.tab.lineCount - 1, Math.floor(scrollTopRef.value / step) - 2))
  }
  const raw = Math.floor(scrollTopRef.value * linesPerPx.value) - (overflow.value ? 0 : OVERSCAN)
  return Math.max(0, Math.min(Math.max(0, props.tab.lineCount - 1), raw))
})

const rowCount = computed(() => {
  if (props.tab.wrap) return 150
  return Math.ceil(viewH.value / lh.value) + OVERSCAN * 2 + 2
})

const rowsTop = computed(() => {
  if (overflow.value) return scrollTopRef.value
  return props.tab.wrap ? firstLine.value * lh.value * wrapFactor.value : firstLine.value * lh.value
})

const visibleLines = computed(() => Math.max(1, Math.floor(viewH.value / lh.value)))

// ---------------- 行文本 ----------------
function lineText(ln: number): string {
  const t = props.tab
  if (t.mode === 'window') {
    const w = t.win
    const i = ln - w.start
    return i >= 0 && i < w.lines.length ? w.lines[i] : ''
  }
  return t.doc ? t.doc.line(ln) : ''
}

// ---------------- 查找 ----------------
const matcher = computed(() => {
  const f = props.tab.find
  if (!f.query) return null
  const m = new SearchMatcher(f.query, { matchCase: f.matchCase, wholeWord: f.wholeWord, regex: f.regex })
  return m.ok ? m : null
})

// ---------------- 括号匹配 ----------------
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const REV_PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

const bracketMarks = computed<{ aLine: number; aCol: number; bLine: number; bCol: number } | null>(() => {
  const t = props.tab
  void t.rev
  if (!props.matchBrackets) return null
  const c = t.caret
  const line = lineText(c.line)
  const at = c.col < line.length ? line[c.col] : ''
  const before = c.col > 0 ? line[c.col - 1] : ''
  let open = ''
  let close = ''
  let startPos: Pos | null = null
  if (PAIRS[at]) { open = at; close = PAIRS[at]; startPos = { line: c.line, col: c.col } }
  else if (PAIRS[before]) { open = before; close = PAIRS[before]; startPos = { line: c.line, col: c.col - 1 } }
  else if (REV_PAIRS[at]) { close = at; open = REV_PAIRS[at]; startPos = { line: c.line, col: c.col } }
  else if (REV_PAIRS[before]) { close = before; open = REV_PAIRS[before]; startPos = { line: c.line, col: c.col - 1 } }
  if (!open || !close || !startPos) return null

  const forward = line[Math.min(startPos.col, line.length)] === open
  let depth = 0
  let budget = 200000
  if (forward) {
    for (let ln = startPos.line; ln < Math.min(t.lineCount, startPos.line + 3000) && budget > 0; ln++) {
      const s = ln === startPos.line ? lineText(ln).slice(startPos.col) : lineText(ln)
      for (let i = 0; i < s.length; i++) {
        budget--
        const ch = s[i]
        if (ch === open) depth++
        else if (ch === close) {
          depth--
          if (depth === 0) {
            const col = ln === startPos.line ? startPos.col + i : i
            return { aLine: startPos.line, aCol: startPos.col, bLine: ln, bCol: col }
          }
        }
        if (budget <= 0) break
      }
    }
  } else {
    for (let ln = startPos.line; ln >= Math.max(0, startPos.line - 3000) && budget > 0; ln--) {
      const full = lineText(ln)
      const s = ln === startPos.line ? full.slice(0, startPos.col + 1) : full
      for (let i = s.length - 1; i >= 0; i--) {
        budget--
        const ch = s[i]
        if (ch === close) depth++
        else if (ch === open) {
          depth--
          if (depth === 0) {
            const col = ln === startPos.line ? i : i
            return { aLine: ln, aCol: col, bLine: startPos.line, bCol: startPos.col }
          }
        }
        if (budget <= 0) break
      }
    }
  }
  return null
})

// ---------------- 行渲染 ----------------
interface Seg { t: string; cls: string; off: number; caret?: boolean }
interface RowModel { line: number; segs: Seg[] }

function selectionFor(ln: number, len: number): { a: number; b: number } | null {
  const t = props.tab
  const s = t.sel
  if (!s) return null
  const anchor = s.anchor
  const head = s.head
  if (t.block) {
    const l0 = Math.min(anchor.line, head.line)
    const l1 = Math.max(anchor.line, head.line)
    if (ln < l0 || ln > l1) return null
    const a = Math.max(0, Math.min(anchor.col, head.col))
    const b = Math.min(len, Math.max(anchor.col, head.col))
    return b > a ? { a, b } : null
  }
  const a = selStart(s)
  const b = selEnd(s)
  if (ln < a.line || ln > b.line) return null
  let la = 0
  let lb = len
  if (ln === a.line) la = Math.min(a.col, len)
  if (ln === b.line) lb = Math.min(b.col, len)
  if (ln === a.line && ln === b.line) return { a: la, b: Math.max(la, lb) }
  return { a: la, b: Math.max(la, lb) }
}

function buildRow(ln: number): RowModel {
  const t = props.tab
  const text = lineText(ln)
  const segs: Seg[] = []
  const caretCol = t.caret.line === ln && focused.value ? t.caret.col : -1
  const sel = selectionFor(ln, text.length)

  let tokens: Token[] = []
  if (text.length > 0 && text.length <= 8000) {
    if (t.mode === 'window') tokens = tokenize(text, 0, langById(t.langId)).tokens
    else tokens = t.hl.tokensFor(lineText, ln, text)
  }

  const overlays: { s: number; e: number; c: string }[] = []
  const m = matcher.value
  if (m && text.length <= 20000) {
    for (const h of m.all(text, 300)) overlays.push({ s: h.start, e: h.end, c: 'tk-find' })
  }
  if (t.find.current && t.find.current.line === ln) {
    const c = t.find.current
    overlays.push({ s: c.start, e: c.end, c: 'tk-find-cur' })
  }
  const bm = bracketMarks.value
  if (bm) {
    if (bm.aLine === ln) overlays.push({ s: bm.aCol, e: bm.aCol + 1, c: 'tk-bracket' })
    if (bm.bLine === ln) overlays.push({ s: bm.bCol, e: bm.bCol + 1, c: 'tk-bracket' })
  }

  const bounds: number[] = [0, text.length]
  for (const tk of tokens) { bounds.push(tk.s, tk.e) }
  if (sel) bounds.push(sel.a, sel.b)
  for (const o of overlays) bounds.push(Math.max(0, o.s), Math.min(text.length, o.e))
  bounds.push(Math.max(0, Math.min(text.length, t.caret.col === caretCol ? caretCol : -1)))
  bounds.sort((x, y) => x - y)

  let prev = -1
  let tokenIdx = 0
  for (let bi = 0; bi < bounds.length; bi++) {
    const s = bounds[bi]
    const e = bi + 1 < bounds.length ? bounds[bi + 1] : text.length
    if (e <= s) continue
    if (s === prev) continue
    prev = s
    while (tokenIdx < tokens.length && tokens[tokenIdx].e <= s) tokenIdx++
    let cls = tokenIdx < tokens.length && tokens[tokenIdx].s <= s ? 'tk-' + tokens[tokenIdx].c : ''
    if (sel && s >= sel.a && e <= sel.b) cls += ' tk-sel'
    for (const o of overlays) if (s >= o.s && e <= o.e) cls = (cls.replace(/ tk-find\S*/g, '') + ' ' + o.c).trim()
    let piece = text.slice(s, e)
    if (props.showInvisibles) piece = piece.replace(/ /g, '·').replace(/\t/g, '→   ')
    segs.push({ t: piece, cls: cls.trim(), off: s })
  }
  if (!segs.length) segs.push({ t: '', cls: '', off: 0 })

  // 插入光标
  if (caretCol >= 0) {
    let idx = segs.findIndex((s) => s.off >= caretCol)
    if (idx < 0) idx = segs.length
    // 若光标落在某段内部，先切开
    const seg = segs[idx - 1]
    if (seg && seg.off < caretCol && seg.off + seg.t.length > caretCol && !props.showInvisibles) {
      const cut = caretCol - seg.off
      const right: Seg = { t: seg.t.slice(cut), cls: seg.cls, off: caretCol }
      seg.t = seg.t.slice(0, cut)
      segs.splice(idx, 0, right)
    }
    segs.splice(idx, 0, { t: '', cls: '', off: caretCol, caret: true })
  }
  return { line: ln, segs }
}

interface RowCacheEntry { key: string; text: string; row: RowModel }
const rowCache = new Map<number, RowCacheEntry>()

function rowKey(ln: number, text: string): string {
  const t = props.tab
  const sel = selectionFor(ln, text.length)
  const caret = t.caret.line === ln && focused.value ? t.caret.col : -1
  let fq = ''
  if (t.find.query) {
    const cur = t.find.current
    fq = t.find.query + '|' + (t.find.matchCase ? 1 : 0) + (t.find.wholeWord ? 1 : 0) + (t.find.regex ? 1 : 0) + '|' + (cur && cur.line === ln ? cur.start + ':' + cur.end : '')
  }
  const bm = bracketMarks.value
  const bmk = bm && (bm.aLine === ln || bm.bLine === ln) ? `${bm.aLine}:${bm.aCol}:${bm.bLine}:${bm.bCol}` : ''
  return `${ln}|${sel ? sel.a + ',' + sel.b : ''}|${caret}|${fq}|${bmk}|${props.showInvisibles ? 1 : 0}|${t.langId}|${t.mode}`
}

function buildRowCached(ln: number, text: string): RowModel {
  const key = rowKey(ln, text)
  const hit = rowCache.get(ln)
  if (hit && hit.key === key && hit.text === text) return hit.row
  const row = buildRow(ln)
  rowCache.set(ln, { key, text, row })
  return row
}

const rows = computed<RowModel[]>(() => {
  // 显式依赖：编辑版本 / 光标 / 选区 / 查找 / 折行 / 行高
  void props.tab.rev
  void props.tab.caret.line
  void props.tab.caret.col
  void props.tab.sel
  void props.tab.block
  void props.tab.find.current
  void props.tab.find.query
  void props.tab.wrap
  void props.tab.langId
  void focused.value
  void props.showInvisibles
  void lh.value
  const start = firstLine.value
  const count = Math.min(rowCount.value, Math.max(0, props.tab.lineCount - start))
  const out: RowModel[] = []
  for (let i = 0; i < count; i++) {
    const ln = start + i
    out.push(buildRowCached(ln, lineText(ln)))
  }
  return out
})

// ---------------- 视口测量 ----------------
let ro: ResizeObserver | null = null
let raf = 0

function measure(): void {
  const el = scrollEl.value
  if (!el) return
  viewH.value = el.clientHeight
  viewW.value = el.clientWidth
}

function onScroll(): void {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    const el = scrollEl.value
    if (!el) return
    scrollTopRef.value = el.scrollTop
    scrollLeftRef.value = el.scrollLeft
    props.tab.scrollTop = el.scrollTop
    props.tab.scrollLeft = el.scrollLeft
    if (props.tab.wrap) measureWrapFactor()
    ensureWindow()
    queueSyncIme()
  })
}

function measureWrapFactor(): void {
  const el = rowsEl.value
  if (!el || !props.tab.wrap) return
  const n = el.children.length
  if (n < 5) return
  const h = el.getBoundingClientRect().height
  const avg = h / n / lh.value
  if (avg > 0.5 && Math.abs(avg - wrapFactor.value) > 0.02) {
    wrapFactor.value = wrapFactor.value * 0.7 + avg * 0.3
  }
}

// ---------------- 窗口模式取行 ----------------
let winLoading = false
let winSeq = 0

function ensureWindow(): void {
  const t = props.tab
  if (t.mode !== 'window') return
  const needStart = firstLine.value
  const needEnd = firstLine.value + rowCount.value
  const w = t.win
  if (w.start >= 0 && needStart >= w.start && needEnd <= w.start + w.lines.length) return
  if (winLoading) return
  winLoading = true
  const seq = ++winSeq
  const start = Math.max(0, needStart - 300)
  const count = Math.min(1600, Math.max(0, t.lineCount - start))
  window.sqlpilot.editorWindow(t.id, start, count).then((r: any) => {
    if (seq !== winSeq) return
    if (r?.ok) {
      t.win = markRaw({ start: r.start, lines: r.lines || [], total: r.total })
      t.rev++
    }
  }).catch(() => {}).finally(() => { winLoading = false })
}

// ---------------- 光标 / 选区 ----------------
function setCaret(pos: Pos, extend = false): void {
  const t = props.tab
  const p = { line: Math.max(0, Math.min(t.lineCount - 1, pos.line)), col: Math.max(0, pos.col) }
  if (extend) {
    const anchor = t.sel ? { ...t.sel.anchor } : { ...t.caret }
    t.sel = { anchor, head: p }
  } else {
    t.sel = null
  }
  t.caret = p
  t.block = false
  t.rev++
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
}

function setSel(anchor: Pos, head: Pos, block = false): void {
  const t = props.tab
  t.sel = { anchor: { ...anchor }, head: { ...head } }
  t.block = block
  t.caret = { ...head }
  t.rev++
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
}

function selectAll(): void {
  const t = props.tab
  const last = t.lineCount - 1
  setSel({ line: 0, col: 0 }, { line: last, col: lineText(last).length })
}

function ensureCaretVisible(): void {
  const el = scrollEl.value
  if (!el) return
  const caretEl = rowsEl.value?.querySelector('.te-caret') as HTMLElement | null
  if (!caretEl) {
    // 光标行不在渲染窗口内：估算位置
    const y = props.tab.wrap
      ? (props.tab.caret.line / Math.max(1, props.tab.lineCount)) * canvasH.value
      : props.tab.caret.line * lh.value
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - lh.value) {
      el.scrollTop = Math.max(0, y - el.clientHeight / 2)
    }
    return
  }
  const cr = caretEl.getBoundingClientRect()
  const er = el.getBoundingClientRect()
  if (cr.top < er.top) el.scrollTop -= er.top - cr.top + lh.value
  else if (cr.bottom > er.bottom) el.scrollTop += cr.bottom - er.bottom + lh.value
  if (!props.tab.wrap) {
    if (cr.left < er.left + gutterW.value) el.scrollLeft -= er.left + gutterW.value - cr.left + 8
    else if (cr.right > er.right - 8) el.scrollLeft += cr.right - er.right + 8 + Math.min(80, cr.width)
  }
  scrollTopRef.value = el.scrollTop
  scrollLeftRef.value = el.scrollLeft
}

function scrollToLine(line: number, col = 0): void {
  const el = scrollEl.value
  if (!el) return
  if (overflow.value) {
    el.scrollTop = (line / Math.max(1, props.tab.lineCount)) * MAX_SCROLL_PX
  } else if (props.tab.wrap) {
    el.scrollTop = Math.max(0, line * lh.value * wrapFactor.value - el.clientHeight / 3)
  } else {
    el.scrollTop = Math.max(0, line * lh.value - el.clientHeight / 2)
  }
  scrollTopRef.value = el.scrollTop
  setCaret({ line, col })
}

// ---------------- IME ----------------
let imeTimer = 0
function queueSyncIme(): void {
  if (imeTimer) return
  imeTimer = requestAnimationFrame(() => {
    imeTimer = 0
    syncIme()
  })
}

function syncIme(): void {
  const caretEl = rowsEl.value?.querySelector('.te-caret') as HTMLElement | null
  if (!caretEl) return
  const r = caretEl.getBoundingClientRect()
  imePos.value = { left: r.left, top: r.top, height: Math.max(12, r.height) }
  const ta = imeEl.value
  if (ta) {
    ta.style.left = r.left + 'px'
    ta.style.top = r.top + 'px'
    ta.style.height = Math.max(12, r.height) + 'px'
  }
}

const imeStyle = computed(() => ({
  left: imePos.value.left + 'px',
  top: imePos.value.top + 'px',
  height: imePos.value.height + 'px',
  fontSize: (props.fontSize * props.tab.zoom) + 'px'
}))

const compStyle = computed(() => ({
  left: imePos.value.left + 'px',
  top: imePos.value.top + 'px'
}))

// 组合输入（中文/日文输入法）状态：
// - composing 期间 textarea 由输入法维护，input 事件不落盘（否则每敲一个拼音就插一段）
// - 提交只在 compositionend 做一次；随后浏览器可能补发的同值 input 要忽略（否则重复）
// - 组合期间切了标签就丢弃这次提交，避免写进另一个文件
const composing = ref(false)
let compTabId = ''
let justCommitted = ''
let commitTimer = 0

function resetComposition(): void {
  composing.value = false
  compText.value = ''
  justCommitted = ''
  compTabId = ''
  if (commitTimer) { clearTimeout(commitTimer); commitTimer = 0 }
  const ta = imeEl.value
  if (ta) ta.value = ''
}

function onCompStart(): void {
  composing.value = true
  compText.value = ''
  compTabId = props.tab.id
  justCommitted = ''
  const ta = imeEl.value
  if (ta && ta.value) ta.value = ''
}

function onCompUpdate(e: CompositionEvent): void {
  compText.value = e.data || ''
  queueSyncIme()
}

function onCompEnd(e: CompositionEvent): void {
  const data = e.data || ''
  const sameTab = compTabId === props.tab.id
  composing.value = false
  compText.value = ''
  compTabId = ''
  const ta = imeEl.value
  if (ta) ta.value = ''
  if (!sameTab) return // 组合期间切走了：丢弃半截内容
  if (!data) return
  justCommitted = data
  insertText(data)
  if (commitTimer) clearTimeout(commitTimer)
  commitTimer = window.setTimeout(() => { justCommitted = ''; commitTimer = 0 }, 200)
}

function onInput(e: Event): void {
  const ta = e.target as HTMLTextAreaElement
  const ie = e as InputEvent
  // 组合态：内容由输入法维护，等 compositionend 统一提交
  if (ie.isComposing || composing.value) return
  const v = ta.value
  ta.value = ''
  if (!v) return
  // 提交后浏览器补发的同值 input：忽略，避免重复插入
  if (justCommitted && v === justCommitted) {
    justCommitted = ''
    if (commitTimer) { clearTimeout(commitTimer); commitTimer = 0 }
    return
  }
  justCommitted = ''
  insertText(v)
}

function onPaste(e: ClipboardEvent): void {
  e.preventDefault()
  const text = e.clipboardData?.getData('text/plain') ?? ''
  if (text) insertText(text)
}

function onCopyEvent(e: ClipboardEvent): void {
  e.preventDefault()
  copySelection()
}

function onCutEvent(e: ClipboardEvent): void {
  e.preventDefault()
  cutSelection()
}

function onBlur(): void {
  focused.value = false
  // 失焦（点菜单/别的标签/别的窗口）：组合态必须清干净，否则浮层会留在光标处
  resetComposition()
  queueSyncIme()
}

// ---------------- 编辑原语 ----------------
function editTarget(): Tab | null {
  const t = props.tab
  if (t.readOnly || t.mode !== 'full' || !t.doc) return null
  return t
}

function pushRec(t: Tab, start: number, before: string[], beforePos: Pos, endPos: Pos, kind: 'type' | 'edit', afterCount?: number): void {
  const doc = t.doc!
  const n = afterCount === undefined ? Math.max(0, endPos.line + 1 - start) : afterCount
  const after = doc.lines.slice(start, start + n)
  t.undo.push({ start, before, after, beforePos, afterPos: endPos, time: Date.now(), kind })
}

function afterEdit(startLine: number, caret: Pos, sel: Sel | null = null): void {
  const t = props.tab
  t.caret = caret
  t.sel = sel
  t.block = false
  t.dirty = true
  t.rev++
  t.charCount = t.doc!.charCount
  t.lineCount = t.doc!.lineCount
  t.hl.setLineCount(t.lineCount)
  t.hl.invalidate(startLine)
  emit('change')
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
}

function replaceRange(a: Pos, b: Pos, text: string): void {
  const t = editTarget()
  if (!t) return
  const doc = t.doc!
  const s = posCmp(a, b) <= 0 ? a : b
  const e = posCmp(a, b) <= 0 ? b : a
  const start = s.line
  const before = doc.lines.slice(s.line, e.line + 1)
  let caret: Pos
  if (posCmp(s, e) === 0) caret = doc.insertText(s, text)
  else {
    doc.deleteRange(s, e)
    caret = doc.insertText(s, text)
  }
  pushRec(t, start, before, s, caret, text.indexOf('\n') >= 0 || before.length > 1 ? 'edit' : 'type')
  afterEdit(start, caret)
}

/** 按行替换一整段（即时渲染模式提交一个块时用）：一次操作 = 一条撤销记录 */
function replaceLines(start: number, del: number, lines: string[]): void {
  const t = editTarget()
  if (!t) return
  const doc = t.doc!
  const from = Math.max(0, Math.min(doc.lineCount, start))
  const count = Math.max(0, Math.min(del, doc.lineCount - from))
  const next = lines.length ? lines : ['']
  const before = doc.lines.slice(from, from + count)
  doc.lines.splice(from, count, ...next)
  doc.charCount = doc.lines.reduce((n, x) => n + x.length, 0)
  if (!doc.lines.length) doc.lines = ['']
  pushRec(t, from, before, { line: from, col: 0 }, { line: from + next.length - 1, col: next[next.length - 1].length }, 'edit', next.length)
  t.dirty = true
  t.rev++
  t.lineCount = doc.lineCount
  t.charCount = doc.charCount
  t.hl.setLineCount(t.lineCount)
  t.hl.invalidate(from)
  emit('change')
}

/** 选区（含块选）内容 */
function selectionText(): string {
  const t = props.tab
  if (!t.sel) return ''
  if (t.block) {
    const l0 = Math.min(t.sel.anchor.line, t.sel.head.line)
    const l1 = Math.max(t.sel.anchor.line, t.sel.head.line)
    const a = Math.min(t.sel.anchor.col, t.sel.head.col)
    const b = Math.max(t.sel.anchor.col, t.sel.head.col)
    const out: string[] = []
    for (let i = l0; i <= l1; i++) out.push(lineText(i).slice(a, b))
    return out.join('\n')
  }
  const s = selStart(t.sel)
  const e = selEnd(t.sel)
  if (posCmp(s, e) === 0) return ''
  if (t.mode === 'window') {
    const out: string[] = []
    for (let i = s.line; i <= e.line; i++) {
      const ln = lineText(i)
      out.push(i === s.line && i === e.line ? ln.slice(s.col, e.col) : i === s.line ? ln.slice(s.col) : i === e.line ? ln.slice(0, e.col) : ln)
    }
    return out.join('\n')
  }
  return t.doc ? t.doc.textRange(s, e) : ''
}

/**
 * 某个位置在视口里的 x 坐标（用于把浮层钉在选区末端）。
 * 高亮把一行切成若干 `[data-off]` 段，这里找到包含该列的那一段再用 Range 量。
 */
function xAtPos(pos: Pos): number | null {
  const rowEl = rowsEl.value?.querySelector(`.te-row[data-line="${pos.line}"]`) as HTMLElement | null
  const codeEl = rowEl?.querySelector('.te-code') as HTMLElement | null
  if (!codeEl) return null
  const segs = Array.from(codeEl.querySelectorAll<HTMLElement>('[data-off]'))
  if (!segs.length) return codeEl.getBoundingClientRect().left
  for (const sg of segs) {
    const off = Number(sg.dataset.off)
    const len = sg.textContent?.length || 0
    if (pos.col < off || pos.col > off + len) continue
    const node = sg.firstChild
    if (!node || node.nodeType !== 3) return sg.getBoundingClientRect().left
    const rg = document.createRange()
    rg.setStart(node, Math.max(0, Math.min(len, pos.col - off)))
    rg.collapse(true)
    const r = rg.getBoundingClientRect()
    return r.left || sg.getBoundingClientRect().left
  }
  const last = segs[segs.length - 1]
  return last.getBoundingClientRect().right
}

/** 选区最多读这么多行：整篇全选（几十万行）时别把几 MB 文本塞进 prompt */
const SEL_MAX_LINES = 800

interface SelRect {
  start: Pos
  end: Pos
  /** 选区末端 x */
  x: number
  /** 锚点行文字末尾的 x：短行时按钮放行末右侧，不压字 */
  lineRight: number
  top: number
  bottom: number
  lineHeight: number
  /** 粗估的字符数（只用于按钮 tooltip，不精确） */
  approx: number
}

/**
 * 选区的屏幕位置（不读文本）。
 * 鼠标每抬起一次都会调它，所以这里必须是常数级：行数超限直接返回 null。
 */
function selectionRect(): SelRect | null {
  const t = props.tab
  if (!t.sel) return null
  const s = selStart(t.sel)
  const e = selEnd(t.sel)
  const lines = e.line - s.line + 1
  if (lines > 1200) return null
  const sameLine = s.line === e.line
  const approx = sameLine ? e.col - s.col : lines * 80
  if (approx < 1) return null
  const rows = rowsEl.value
  const rowOf = (line: number): HTMLElement | null =>
    (rows?.querySelector(`.te-row[data-line="${line}"]`) as HTMLElement | null) || null
  const visible = (el: HTMLElement | null): DOMRect | null => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.bottom < 4 || r.top > window.innerHeight - 4) return null
    return r
  }
  // 首行优先（按钮在选区附近），首行滚出去了就用末行
  const headRect = visible(rowOf(s.line))
  const tailRect = visible(rowOf(e.line))
  const anchorRect = headRect || tailRect
  if (!anchorRect) return null
  const anchorPos = headRect ? s : e
  const x = xAtPos(anchorPos) ?? anchorRect.left + 80
  const lineRight = xAtPos({ line: anchorPos.line, col: lineText(anchorPos.line).length }) ?? anchorRect.right
  return { start: s, end: e, x, lineRight, top: anchorRect.top, bottom: anchorRect.bottom, lineHeight: anchorRect.height || lh.value, approx }
}

/** 取选区文本，超过 SEL_MAX_LINES 行就截断（返回 truncated 供界面提示） */
function selectionTextLimited(s: Pos, e: Pos): { text: string; truncated: boolean } {
  const t = props.tab
  const lines = e.line - s.line + 1
  const truncated = lines > SEL_MAX_LINES
  const stop = truncated ? { line: s.line + SEL_MAX_LINES - 1, col: lineText(s.line + SEL_MAX_LINES - 1).length } : e
  if (t.block) {
    const text = selectionText()
    return { text: text.length > 40000 ? text.slice(0, 40000) : text, truncated: truncated || text.length > 40000 }
  }
  if (t.mode === 'window') {
    const out: string[] = []
    for (let i = s.line; i <= stop.line; i++) {
      const ln = lineText(i)
      out.push(i === s.line && i === stop.line ? ln.slice(s.col, stop.col) : i === s.line ? ln.slice(s.col) : i === stop.line ? ln.slice(0, stop.col) : ln)
    }
    return { text: out.join('\n'), truncated }
  }
  const text = t.doc ? t.doc.textRange(s, stop) : ''
  return { text, truncated }
}

/**
 * 选区信息（点击 AI 按钮时才调，会真的读文本）。
 * 位置与文本分开取：定位要轻（selectionRect），取文本要准（这里）。
 */
function selectionInfo(): {
  text: string
  start: Pos
  end: Pos
  truncated: boolean
  x: number
  lineRight: number
  top: number
  bottom: number
  lineHeight: number
} | null {
  const rect = selectionRect()
  if (!rect) return null
  const t = props.tab
  if (!t.sel) return null
  const { text, truncated } = selectionTextLimited(rect.start, rect.end)
  if (!text.trim()) return null
  return { ...rect, text, truncated }
}

function hasSelection(): boolean {
  const t = props.tab
  if (!t.sel) return false
  if (t.block) return t.sel.anchor.line !== t.sel.head.line || t.sel.anchor.col !== t.sel.head.col
  return posCmp(t.sel.anchor, t.sel.head) !== 0
}

function deleteBlockSelection(): boolean {
  const t = editTarget()
  if (!t || !t.sel) return false
  const doc = t.doc!
  const l0 = Math.min(t.sel.anchor.line, t.sel.head.line)
  const l1 = Math.max(t.sel.anchor.line, t.sel.head.line)
  const a = Math.min(t.sel.anchor.col, t.sel.head.col)
  const b = Math.max(t.sel.anchor.col, t.sel.head.col)
  if (a === b) return false
  const before = doc.lines.slice(l0, l1 + 1)
  for (let i = l0; i <= l1; i++) {
    const ln = doc.lines[i]
    doc.lines[i] = ln.slice(0, Math.min(a, ln.length)) + ln.slice(Math.min(b, ln.length))
  }
  doc.charCount = doc.lines.reduce((n, x) => n + x.length, 0)
  pushRec(t, l0, before, t.caret, { line: l1, col: a }, 'edit', before.length)
  t.dirty = true
  t.rev++
  t.sel = null
  t.block = false
  t.caret = { line: l1, col: a }
  emit('change')
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
  return true
}

function deleteSelection(): boolean {
  const t = editTarget()
  if (!t || !t.sel) return false
  if (t.block) return deleteBlockSelection()
  const s = selStart(t.sel)
  const e = selEnd(t.sel)
  if (posCmp(s, e) === 0) return false
  replaceRange(s, e, '')
  return true
}

function insertText(text: string): void {
  const t = editTarget()
  if (!t) return
  const doc = t.doc!
  const lang = langById(t.langId)

  if (t.overtype && text.length === 1 && text !== '\n' && !t.sel) {
    const line = lineText(t.caret.line)
    if (t.caret.col < line.length) replaceRange(t.caret, { line: t.caret.line, col: t.caret.col + 1 }, text)
    else replaceRange(t.caret, t.caret, text)
    return
  }

  if (t.block && t.sel) {
    blockInsert(text)
    return
  }

  // 自动闭合
  if (props.autoClose && text.length === 1 && ['(', '[', '{', '"', "'", '`'].indexOf(text) >= 0 && !hasSelection()) {
    const line = lineText(t.caret.line)
    const next = line[t.caret.col]
    const pair = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' } as Record<string, string>
    if (pair[text] === text && next === text) {
      setCaret({ line: t.caret.line, col: t.caret.col + 1 })
      return
    }
    if (next === undefined || /[\s)\]},;]/.test(next)) {
      replaceRange(t.caret, t.caret, text + pair[text])
      // 光标退回到括号中间
      t.caret = { line: t.caret.line, col: Math.max(0, t.caret.col - 1) }
      t.rev++
      nextTick(() => { ensureCaretVisible(); queueSyncIme() })
      return
    }
  }

  const s = t.sel ? selStart(t.sel) : t.caret
  const e = t.sel ? selEnd(t.sel) : t.caret
  replaceRange(s, e, text)
}

function blockInsert(text: string): void {
  const t = editTarget()
  if (!t || !t.sel) return
  const doc = t.doc!
  const l0 = Math.min(t.sel.anchor.line, t.sel.head.line)
  const l1 = Math.max(t.sel.anchor.line, t.sel.head.line)
  const a = Math.min(t.sel.anchor.col, t.sel.head.col)
  const b = Math.max(t.sel.anchor.col, t.sel.head.col)
  const single = text.indexOf('\n') < 0 ? text : text.split('\n')[0]
  const before = doc.lines.slice(l0, l1 + 1)
  for (let i = l0; i <= l1; i++) {
    const ln = doc.lines[i]
    doc.lines[i] = ln.slice(0, Math.min(a, ln.length)) + single + ln.slice(Math.min(b, ln.length))
  }
  doc.charCount = doc.lines.reduce((n, s2) => n + s2.length, 0)
  pushRec(t, l0, before, t.caret, { line: t.caret.line, col: a + single.length }, 'edit')
  t.dirty = true
  t.rev++
  t.sel = { anchor: { line: l0, col: a + single.length }, head: { line: l1, col: a + single.length } }
  t.block = true
  t.caret = { line: l1, col: a + single.length }
  emit('change')
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
}

function backspace(): void {
  const t = editTarget()
  if (!t) return
  if (t.sel) { deleteSelection(); return }
  if (t.block && t.sel) return
  const c = t.caret
  if (c.col > 0) {
    const line = lineText(c.line)
    // 行首缩进：整级回退
    const ind = indentOf(line)
    if (c.col <= ind.length && ind.length > 0) {
      const cut = Math.min(c.col, props.tabSize - ((c.col - 1 + props.tabSize) % props.tabSize))
      const n = Math.max(1, Math.min(c.col, cut))
      replaceRange({ line: c.line, col: c.col - n }, c, '')
      return
    }
    replaceRange({ line: c.line, col: c.col - 1 }, c, '')
  } else if (c.line > 0) {
    const prev = lineText(c.line - 1)
    replaceRange({ line: c.line - 1, col: prev.length }, c, '')
  }
}

function del(): void {
  const t = editTarget()
  if (!t) return
  if (t.sel) { deleteSelection(); return }
  const c = t.caret
  const line = lineText(c.line)
  if (c.col < line.length) replaceRange(c, { line: c.line, col: c.col + 1 }, '')
  else if (c.line < t.lineCount - 1) replaceRange(c, { line: c.line + 1, col: 0 }, '')
}

function insertNewline(): void {
  const t = editTarget()
  if (!t) return
  if (t.sel) {
    const s = selStart(t.sel)
    const e = selEnd(t.sel)
    replaceRange(s, e, '\n')
    return
  }
  const c = t.caret
  const line = lineText(c.line)
  const ind = indentOf(line)
  const pre = line.slice(0, c.col).trimEnd()
  const lang = langById(t.langId).id
  let add = ''
  const lastCh = pre.slice(-1)
  if (lastCh === '{' || lastCh === '[' || lastCh === '(') add = ' '.repeat(props.tabSize)
  else if ((lang === 'python' || lang === 'yaml') && lastCh === ':') add = ' '.repeat(props.tabSize)
  replaceRange(c, c, '\n' + ind + add)
}

function indentSelection(outdent: boolean): void {
  const t = editTarget()
  if (!t) return
  const doc = t.doc!
  const s = t.sel ? selStart(t.sel) : t.caret
  const e = t.sel ? selEnd(t.sel) : t.caret
  const l0 = s.line
  const l1 = e.line
  const before = doc.lines.slice(l0, l1 + 1)
  const unit = props.useSpaces ? ' '.repeat(props.tabSize) : '\t'
  for (let i = l0; i <= l1; i++) {
    if (outdent) {
      const line = doc.lines[i]
      if (line.startsWith('\t')) doc.lines[i] = line.slice(1)
      else {
        let n = 0
        while (n < props.tabSize && doc.lines[i][n] === ' ') n++
        doc.lines[i] = doc.lines[i].slice(n)
      }
    } else {
      doc.lines[i] = unit + doc.lines[i]
    }
  }
  doc.charCount = doc.lines.reduce((n2, x) => n2 + x.length, 0)
  const delta = outdent ? -1 : unit.length
  pushRec(t, l0, before, s, { line: e.line, col: Math.max(0, e.col + delta) }, 'edit')
  t.dirty = true
  t.rev++
  if (t.sel) {
    t.sel = { anchor: { line: s.line, col: Math.max(0, s.col + delta) }, head: { line: e.line, col: Math.max(0, e.col + delta) } }
    t.caret = { ...t.sel.head }
  } else {
    t.caret = { line: s.line, col: Math.max(0, s.col + delta) }
  }
  emit('change')
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
}

function tabKey(shift: boolean): void {
  const t = editTarget()
  if (!t) return
  const multi = !!t.sel && selStart(t.sel).line !== selEnd(t.sel).line
  if (multi) { indentSelection(shift); return }
  if (shift) { indentSelection(true); return }
  if (props.useSpaces) {
    const n = props.tabSize - (t.caret.col % props.tabSize)
    insertText(' '.repeat(n))
  } else insertText('\t')
}

// ---------------- 撤销 / 重做 ----------------
function undo(): void {
  const t = editTarget()
  if (!t) return
  const r = t.undo.undo(t.doc!)
  if (!r) return
  t.caret = r.pos
  t.sel = null
  t.block = false
  t.dirty = true
  t.rev++
  t.lineCount = t.doc!.lineCount
  t.charCount = t.doc!.charCount
  t.hl.setLineCount(t.lineCount)
  t.hl.invalidate(r.start)
  emit('change')
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
}

function redo(): void {
  const t = editTarget()
  if (!t) return
  const r = t.undo.redo(t.doc!)
  if (!r) return
  t.caret = r.pos
  t.sel = null
  t.block = false
  t.dirty = true
  t.rev++
  t.lineCount = t.doc!.lineCount
  t.charCount = t.doc!.charCount
  t.hl.setLineCount(t.lineCount)
  t.hl.invalidate(r.start)
  emit('change')
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
}

// ---------------- 剪贴板 ----------------
function copySelection(): void {
  const text = selectionText()
  if (text) window.sqlpilot.writeClipboard(text)
}

function cutSelection(): void {
  const text = selectionText()
  if (!text) return
  window.sqlpilot.writeClipboard(text)
  if (editTarget()) deleteSelection()
}

async function paste(): Promise<void> {
  const text = await window.sqlpilot.editorClipboardRead()
  if (text) insertText(text)
}

// ---------------- 常用命令 ----------------
function toggleComment(): void {
  const t = editTarget()
  if (!t) return
  const lang = langById(t.langId)
  const mark = (lang.lineComment && lang.lineComment[0]) || '//'
  const doc = t.doc!
  const s = t.sel ? selStart(t.sel) : t.caret
  const e = t.sel ? selEnd(t.sel) : t.caret
  const l0 = s.line
  const l1 = e.line
  const before = doc.lines.slice(l0, l1 + 1)
  const allCommented = before.every((l) => l.trim() === '' || l.trimStart().startsWith(mark))
  for (let i = l0; i <= l1; i++) {
    const line = doc.lines[i]
    if (allCommented) {
      const idx = line.indexOf(mark)
      if (idx >= 0) doc.lines[i] = line.slice(0, idx) + line.slice(idx + mark.length).replace(/^ /, '')
    } else {
      const ind = indentOf(line)
      doc.lines[i] = ind + mark + ' ' + line.slice(ind.length)
    }
  }
  doc.charCount = doc.lines.reduce((n2, x) => n2 + x.length, 0)
  pushRec(t, l0, before, t.caret, { line: l1, col: t.caret.col }, 'edit')
  t.dirty = true
  t.rev++
  emit('change')
  nextTick(ensureCaretVisible)
}

function changeCase(upper: boolean): void {
  const t = editTarget()
  if (!t) return
  const text = selectionText()
  if (!text) return
  if (t.block) return
  const s = selStart(t.sel!)
  const e = selEnd(t.sel!)
  replaceRange(s, e, upper ? text.toUpperCase() : text.toLowerCase())
  setSel(s, { line: s.line, col: s.col + text.length })
}

function duplicateLine(): void {
  const t = editTarget()
  if (!t) return
  const doc = t.doc!
  const s = t.sel ? selStart(t.sel) : t.caret
  const e = t.sel ? selEnd(t.sel) : t.caret
  const l0 = s.line
  const l1 = e.line
  const before = doc.lines.slice(l0, l1 + 1)
  if (posCmp(s, e) === 0) {
    doc.lines.splice(l1 + 1, 0, doc.lines[l1])
    doc.charCount += doc.lines[l1].length
    pushRec(t, l0, before, t.caret, { line: l1 + 1, col: t.caret.col }, 'edit')
    t.caret = { line: l1 + 1, col: t.caret.col }
  } else {
    const chunk = before.slice()
    doc.lines.splice(l1 + 1, 0, ...chunk)
    doc.charCount += chunk.reduce((n2, x) => n2 + x.length, 0)
    pushRec(t, l0, before, s, { line: e.line + chunk.length, col: e.col }, 'edit')
    t.sel = null
    t.caret = { line: l1 + chunk.length, col: e.col }
  }
  t.dirty = true
  t.rev++
  t.lineCount = doc.lineCount
  t.hl.setLineCount(t.lineCount)
  t.hl.invalidate(l0)
  emit('change')
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
}

function deleteLine(): void {
  const t = editTarget()
  if (!t) return
  const doc = t.doc!
  const s = t.sel ? selStart(t.sel) : t.caret
  const e = t.sel ? selEnd(t.sel) : t.caret
  const l0 = s.line
  const l1 = e.line
  const before = doc.lines.slice(l0, l1 + 1)
  doc.lines.splice(l0, l1 - l0 + 1)
  if (!doc.lines.length) doc.lines = ['']
  doc.charCount = doc.lines.reduce((n2, x) => n2 + x.length, 0)
  const caret = { line: Math.min(l0, doc.lineCount - 1), col: 0 }
  pushRec(t, l0, before, t.caret, caret, 'edit', 0)
  t.dirty = true
  t.rev++
  t.sel = null
  t.block = false
  t.caret = caret
  t.lineCount = doc.lineCount
  t.hl.setLineCount(t.lineCount)
  t.hl.invalidate(l0)
  emit('change')
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
}

function moveLines(dir: -1 | 1): void {
  const t = editTarget()
  if (!t) return
  const doc = t.doc!
  const s = t.sel ? selStart(t.sel) : t.caret
  const e = t.sel ? selEnd(t.sel) : t.caret
  const l0 = s.line
  const l1 = e.line
  if (dir < 0 && l0 === 0) return
  if (dir > 0 && l1 >= doc.lineCount - 1) return
  const rangeStart = dir < 0 ? l0 - 1 : l0
  const rangeEnd = dir < 0 ? l1 : l1 + 1
  const before = doc.lines.slice(rangeStart, rangeEnd + 1)
  const blockLines = doc.lines.splice(l0, l1 - l0 + 1)
  doc.lines.splice(dir < 0 ? l0 - 1 : l0 + 1, 0, ...blockLines)
  const delta = dir
  const caret = { line: t.caret.line + delta, col: t.caret.col }
  pushRec(t, rangeStart, before, t.caret, caret, 'edit', before.length)
  t.dirty = true
  t.rev++
  t.caret = caret
  if (t.sel) {
    t.sel = {
      anchor: { line: t.sel.anchor.line + delta, col: t.sel.anchor.col },
      head: { line: t.sel.head.line + delta, col: t.sel.head.col }
    }
  }
  t.hl.invalidate(Math.max(0, rangeStart))
  emit('change')
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
}

function toggleBookmark(): void {
  const t = props.tab
  const line = t.caret.line
  const i = t.bookmarks.indexOf(line)
  if (i >= 0) t.bookmarks.splice(i, 1)
  else t.bookmarks.push(line)
  t.bookmarks.sort((a, b) => a - b)
  t.rev++
}

function nextBookmark(): void {
  const t = props.tab
  if (!t.bookmarks.length) return
  const next = t.bookmarks.find((b) => b > t.caret.line)
  scrollToLine(next === undefined ? t.bookmarks[0] : next)
}

function isBookmarked(line: number): boolean {
  return props.tab.bookmarks.indexOf(line) >= 0
}

// ---------------- 光标移动 ----------------
function moveCaret(key: string, extend: boolean, shift: boolean, ctrl: boolean): void {
  const t = props.tab
  let { line, col } = t.caret
  const len = lineText(line).length
  const page = Math.max(1, visibleLines.value - 2)

  if (key === 'ArrowLeft') {
    if (col > 0) {
      if (ctrl) {
        const s = lineText(line)
        let i = col - 1
        while (i > 0 && !isWordChar(s[i - 1])) i--
        while (i > 0 && isWordChar(s[i - 1])) i--
        col = i
      } else col--
    } else if (line > 0) { line--; col = lineText(line).length }
  } else if (key === 'ArrowRight') {
    if (col < len) {
      if (ctrl) {
        const s = lineText(line)
        let i = col + 1
        while (i < s.length && !isWordChar(s[i])) i++
        while (i < s.length && isWordChar(s[i])) i++
        col = i
      } else col++
    } else if (line < t.lineCount - 1) { line++; col = 0 }
  } else if (key === 'ArrowUp') {
    if (line > 0) line--
    col = Math.min(col, lineText(line).length)
  } else if (key === 'ArrowDown') {
    if (line < t.lineCount - 1) line++
    col = Math.min(col, lineText(line).length)
  } else if (key === 'Home') {
    col = 0
  } else if (key === 'End') {
    col = len
  } else if (key === 'PageUp') {
    line = Math.max(0, line - page)
    col = Math.min(col, lineText(line).length)
  } else if (key === 'PageDown') {
    line = Math.min(t.lineCount - 1, line + page)
    col = Math.min(col, lineText(line).length)
  }
  setCaret({ line, col }, extend)
}

// ---------------- 键盘 ----------------
function onKeyDown(e: KeyboardEvent): void {
  if (e.isComposing) return
  const t = props.tab
  const mod = e.ctrlKey || e.metaKey
  const shift = e.shiftKey
  const alt = e.altKey
  const key = e.key
  const lower = key.toLowerCase()
  let handled = true

  if (mod && !shift && lower === 'z') undo()
  else if (mod && (lower === 'y' || (shift && lower === 'z'))) redo()
  else if (mod && lower === 'a') selectAll()
  else if (mod && lower === 'c') copySelection()
  else if (mod && lower === 'x') cutSelection()
  else if (mod && !shift && lower === 'd') duplicateLine()
  else if (mod && !shift && lower === 'l') deleteLine()
  else if (mod && !shift && lower === 'q') toggleComment()
  else if (mod && shift && lower === 'u') changeCase(false)
  else if (mod && !shift && lower === 'u') changeCase(true)
  else if (mod && shift && (key === 'ArrowUp' || key === 'ArrowDown')) moveLines(key === 'ArrowUp' ? -1 : 1)
  else if (mod && shift && lower === 'f') { emit('cmd', 'find-in-files') }
  else if (mod && (lower === 'f' || lower === 'h' || lower === 'g')) { emit('cmd', lower === 'f' ? 'find' : lower === 'h' ? 'replace' : 'goto') }
  else if (mod && lower === 's') { emit('cmd', shift ? 'save-as' : 'save') }
  else if (mod && lower === 'o') { emit('cmd', 'open') }
  else if (mod && lower === 'n') { emit('cmd', 'new') }
  else if (mod && lower === 'w') { emit('cmd', 'close') }
  else if (mod && lower === 'tab') { emit('cmd', 'next-tab') }
  else if (mod && lower === 'v') handled = false // 交给 paste 事件
  // Markdown：粗体/斜体/链接/标题 + 预览切换（只在 Markdown 文档里生效）
  else if (mod && !shift && t.langId === 'markdown' && lower === 'b') mdFormat('bold')
  else if (mod && !shift && t.langId === 'markdown' && lower === 'i') mdFormat('italic')
  else if (mod && !shift && t.langId === 'markdown' && lower === 'k') mdFormat('link')
  else if (mod && !shift && t.langId === 'markdown' && /^[1-6]$/.test(key)) mdFormat(('h' + key) as MdFormat)
  else if (mod && shift && lower === 'm') emit('cmd', 'md-preview')
  else if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') moveCaret(key, shift, shift, mod)
  else if (key === 'Home' || key === 'End') {
    if (mod) {
      if (key === 'Home') setCaret({ line: 0, col: 0 }, shift)
      else { const l = t.lineCount - 1; setCaret({ line: l, col: lineText(l).length }, shift) }
    } else if (key === 'Home') {
      const ln = lineText(t.caret.line)
      const ind = indentOf(ln).length
      setCaret({ line: t.caret.line, col: t.caret.col === ind ? 0 : ind }, shift)
    } else setCaret({ line: t.caret.line, col: lineText(t.caret.line).length }, shift)
  } else if (key === 'PageUp' || key === 'PageDown') moveCaret(key, shift, shift, mod)
  else if (key === 'Enter') insertNewline()
  else if (key === 'Tab') tabKey(shift)
  else if (key === 'Backspace') backspace()
  else if (key === 'Delete') del()
  else if (key === 'Insert') t.overtype = !t.overtype
  else if (key === 'F2') nextBookmark()
  else if (key === 'F3') { emit('cmd', shift ? 'find-prev' : 'find-next') }
  else if (key === 'Escape') { emit('cmd', 'escape') }
  else if (key === 'F5') { /* 运行：保留 */ handled = false }
  else handled = false

  if (handled) e.preventDefault()
}

// ---------------- 鼠标 ----------------
let dragging = false
let dragAnchor: Pos | null = null

function rowByY(y: number): HTMLElement | null {
  const el = rowsEl.value
  if (!el) return null
  const kids = el.children
  for (let i = 0; i < kids.length; i++) {
    const r = (kids[i] as HTMLElement).getBoundingClientRect()
    if (y >= r.top && y <= r.bottom) return kids[i] as HTMLElement
  }
  if (kids.length) {
    const first = (kids[0] as HTMLElement).getBoundingClientRect()
    return y < first.top ? (kids[0] as HTMLElement) : (kids[kids.length - 1] as HTMLElement)
  }
  return null
}

function hitTest(x: number, y: number): { pos: Pos; row: HTMLElement | null; gutter: boolean } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const rowEl = el?.closest('[data-line]') as HTMLElement | null
  if (rowEl) {
    const line = Number(rowEl.dataset.line)
    const gutter = !!el?.closest('[data-gutter]')
    if (gutter) return { pos: { line, col: 0 }, row: rowEl, gutter: true }
    const range = (document as any).caretRangeFromPoint?.(x, y) as Range | null
    if (range && rowEl.contains(range.startContainer)) {
      let node: Node | null = range.startContainer
      const segEl = (node.nodeType === 3 ? node.parentElement : (node as HTMLElement))?.closest('[data-off]') as HTMLElement | null
      if (segEl) {
        return { pos: { line, col: Number(segEl.dataset.off) + range.startOffset }, row: rowEl, gutter: false }
      }
    }
    // 兜底：按分段矩形估算
    const segs = Array.from(rowEl.querySelectorAll('.te-code [data-off]')) as HTMLElement[]
    let col = lineText(line).length
    for (const s of segs) {
      const r = s.getBoundingClientRect()
      if (x < r.left) { col = Number(s.dataset.off); break }
      if (x <= r.right) {
        const off = Number(s.dataset.off)
        const frac = r.width > 0 ? (x - r.left) / r.width : 0
        col = off + Math.round(frac * (s.textContent?.length || 0))
        break
      }
    }
    return { pos: { line, col }, row: rowEl, gutter: false }
  }
  // 点击空白区：落到最近一行
  const row = rowByY(y)
  if (!row) return null
  const line = Number(row.dataset.line)
  const last = lineText(line).length
  return { pos: { line, col: last }, row, gutter: false }
}

function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return
  const hit = hitTest(e.clientX, e.clientY)
  focus()
  if (!hit) return
  if (hit.gutter) {
    const t = props.tab
    setSel({ line: hit.pos.line, col: 0 }, { line: hit.pos.line, col: lineText(hit.pos.line).length })
    dragAnchor = { line: hit.pos.line, col: 0 }
    dragging = true
    e.preventDefault()
    addDragListeners()
    return
  }
  if (e.altKey) {
    const anchor = { ...props.tab.caret }
    setSel(anchor, hit.pos, true)
    dragAnchor = anchor
    dragging = true
    e.preventDefault()
    addDragListeners()
    return
  }
  if (e.shiftKey) {
    const anchor = props.tab.sel ? { ...props.tab.sel.anchor } : { ...props.tab.caret }
    setSel(anchor, hit.pos)
  } else {
    setCaret(hit.pos)
  }
  dragAnchor = { ...props.tab.caret }
  dragging = true
  e.preventDefault()
  addDragListeners()
}

function onMouseMoveDoc(e: MouseEvent): void {
  if (!dragging || !dragAnchor) return
  const el = scrollEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  // 拖拽到视口外：自动滚动
  if (e.clientY < r.top + 4) el.scrollTop -= lh.value * 2
  else if (e.clientY > r.bottom - 4) el.scrollTop += lh.value * 2
  if (e.clientX < r.left + gutterW.value + 4) el.scrollLeft -= 24
  else if (e.clientX > r.right - 4) el.scrollLeft += 24
  scrollTopRef.value = el.scrollTop
  scrollLeftRef.value = el.scrollLeft

  const x = Math.max(r.left + gutterW.value + 1, Math.min(r.right - 2, e.clientX))
  const y = Math.max(r.top + 1, Math.min(r.bottom - 2, e.clientY))
  const hit = hitTest(x, y)
  if (!hit) return
  if (props.tab.block) setSel(dragAnchor, hit.pos, true)
  else setSel(dragAnchor, hit.pos)
}

function onMouseUpDoc(): void {
  dragging = false
  dragAnchor = null
  removeDragListeners()
}

function addDragListeners(): void {
  document.addEventListener('mousemove', onMouseMoveDoc)
  document.addEventListener('mouseup', onMouseUpDoc)
}

function removeDragListeners(): void {
  document.removeEventListener('mousemove', onMouseMoveDoc)
  document.removeEventListener('mouseup', onMouseUpDoc)
}

function onMouseDblClick(e: MouseEvent): void {
  const hit = hitTest(e.clientX, e.clientY)
  if (!hit) return
  const line = lineText(hit.pos.line)
  const r = wordRangeAt(line, hit.pos.col)
  setSel({ line: hit.pos.line, col: r.a }, { line: hit.pos.line, col: r.b })
}

function onContextMenu(e: MouseEvent): void {
  emit('contextmenu', { x: e.clientX, y: e.clientY })
}

// ---------------- 查找替换（供外壳调用） ----------------
function replaceAt(line: number, start: number, end: number, text: string): void {
  const t = editTarget()
  if (!t) return
  replaceRange({ line, col: start }, { line, col: end }, text)
}

function replaceAllWith(m: SearchMatcher, replacement: string): number {
  const t = editTarget()
  if (!t) return 0
  const doc = t.doc!
  const before = doc.lines.slice()
  let count = 0
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i]
    if (!line) continue
    const hits = m.all(line, 20000)
    if (!hits.length) continue
    let out = ''
    let last = 0
    for (const h of hits) {
      out += line.slice(last, h.start) + m.expand(replacement, line, h)
      last = h.end
      count++
    }
    out += line.slice(last)
    doc.lines[i] = out
  }
  if (!count) return 0
  doc.charCount = doc.lines.reduce((n, x) => n + x.length, 0)
  pushRec(t, 0, before, { line: 0, col: 0 }, { line: doc.lines.length - 1, col: 0 }, 'edit', doc.lines.length)
  t.dirty = true
  t.rev++
  t.sel = null
  t.lineCount = doc.lineCount
  t.hl.setLineCount(t.lineCount)
  t.hl.invalidate(0)
  emit('change')
  nextTick(() => { ensureCaretVisible(); queueSyncIme() })
  return count
}

// ---------------- Markdown 格式化 ----------------
type MdFormat =
  | 'bold' | 'italic' | 'strike' | 'code'
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'quote' | 'ul' | 'ol' | 'task'
  | 'link' | 'image' | 'codeblock' | 'table' | 'hr'

/** 文本插入后，从起点推进后的位置 */
function posAfter(start: Pos, text: string): Pos {
  let line = start.line
  let from = 0
  let idx = text.indexOf('\n')
  if (idx < 0) return { line, col: start.col + text.length }
  while (idx >= 0) {
    line++
    from = idx + 1
    idx = text.indexOf('\n', from)
  }
  return { line, col: text.length - from }
}

function mdSelection(): { s: Pos; e: Pos; sel: string } | null {
  const t = editTarget()
  if (!t) return null
  if (t.block) return null
  const s = t.sel ? selStart(t.sel) : t.caret
  const e = t.sel ? selEnd(t.sel) : t.caret
  const sel = posCmp(s, e) !== 0 ? t.doc!.textRange(s, e) : ''
  return { s, e, sel }
}

/** 行内包裹：**粗** / *斜* / ~~删~~ / `代码`；已在其中则取消，空选区且光标在标记之间也取消 */
function mdInline(prefix: string, suffix = prefix): void {
  const r = mdSelection()
  if (!r) return
  const { s, e, sel } = r
  if (sel) {
    // 选区本身就带着标记（选中了 **x**）→ 去掉标记
    if (sel.length > prefix.length + suffix.length && sel.startsWith(prefix) && sel.endsWith(suffix)) {
      const inner = sel.slice(prefix.length, sel.length - suffix.length)
      replaceRange(s, e, inner)
      setSel(s, posAfter(s, inner))
      return
    }
    // 选区两侧紧邻标记（上次包裹后选中的是内文）→ 再按一次取消
    if (s.line === e.line) {
      const line = lineText(s.line)
      if (line.slice(0, s.col).endsWith(prefix) && line.slice(e.col).startsWith(suffix)) {
        const a = { line: s.line, col: Math.max(0, s.col - prefix.length) }
        const b = { line: e.line, col: e.col + suffix.length }
        replaceRange(a, b, sel)
        setSel(a, { line: a.line, col: a.col + sel.length })
        return
      }
    }
    replaceRange(s, e, prefix + sel + suffix)
    // 只选中内文：下次再按同一快捷键才能识别出「两侧已有标记」并取消
    setSel(posAfter(s, prefix), posAfter(s, prefix + sel))
    return
  }
  const line = lineText(s.line)
  const before = line.slice(0, s.col)
  const after = line.slice(s.col)
  if (before.endsWith(prefix) && after.startsWith(suffix)) {
    const a = { line: s.line, col: Math.max(0, s.col - prefix.length) }
    const b = { line: s.line, col: s.col + suffix.length }
    replaceRange(a, b, '')
    setCaret(a)
    return
  }
  replaceRange(s, s, prefix + suffix)
  setCaret(posAfter(s, prefix))
}

/** 行级标记：标题 / 引用 / 列表 / 任务列表（整块选中时逐行处理） */
function mdLines(kind: 'quote' | 'ul' | 'ol' | 'task' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'): void {
  const r = mdSelection()
  if (!r) return
  const l0 = r.s.line
  const l1 = r.e.line
  const endCol = lineText(l1).length
  const src: string[] = []
  for (let i = l0; i <= l1; i++) src.push(lineText(i))

  const marker = (idx: number): string => {
    if (kind === 'quote') return '> '
    if (kind === 'ul') return '- '
    if (kind === 'task') return '- [ ] '
    if (kind === 'ol') return `${idx + 1}. `
    return '#'.repeat(Number(kind[1])) + ' '
  }
  const lead = (s: string): string => /^\s*/.exec(s)![0]
  const stripMarker = (ln: string): string => {
    const ind = lead(ln)
    let rest = ln.slice(ind.length)
    if (kind.startsWith('h')) rest = rest.replace(/^#{1,6}\s+/, '')
    else if (kind === 'quote') rest = rest.replace(/^>\s?/, '')
    else rest = rest.replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, '')
    rest = rest.replace(/^\[[ xX]\]\s+/, '')
    return ind + rest
  }

  const filled = src.map((ln, i) => ({ ln, i })).filter((x) => x.ln.trim())
  const allHas = filled.length > 0 && filled.every((x) => lead(x.ln).length + marker(x.i).length <= x.ln.length
    && x.ln.slice(lead(x.ln).length).startsWith(marker(x.i)))

  let out: string[]
  if (allHas) {
    out = src.map((ln, i) => {
      if (!ln.trim()) return ''
      const ind = lead(ln)
      return ind + ln.slice(ind.length + marker(i).length)
    })
  } else {
    out = src.map((ln, i) => {
      if (!ln.trim()) return ''
      const stripped = stripMarker(ln)
      const ind = lead(stripped)
      return ind + marker(i) + stripped.slice(ind.length)
    })
  }

  const text = out.join('\n')
  replaceRange({ line: l0, col: 0 }, { line: l1, col: endCol }, text)
  if (posCmp(r.s, r.e) !== 0) setSel({ line: l0, col: 0 }, posAfter({ line: l0, col: 0 }, text))
  else setCaret({ line: l0, col: Math.min(lineText(l0).length, lead(lineText(l0)).length + marker(0).length) })
}

/** 多行块插入（代码块/表格/链接等）：可在插入结果里选中一段 */
function mdInsert(text: string, selFrom?: number, selTo?: number): void {
  const r = mdSelection()
  if (!r) return
  const base = { ...r.s }
  replaceRange(r.s, r.e, text)
  if (selFrom !== undefined && selTo !== undefined) {
    setSel(posAfter(base, text.slice(0, selFrom)), posAfter(base, text.slice(0, selTo)))
  } else {
    setCaret(posAfter(base, text))
  }
}

/** 块级插入时按上下文补空行：光标所在行前后有内容就断开成独立块 */
function padFor(s: Pos, e: Pos): { pre: string; post: string } {
  const before = lineText(s.line).slice(0, s.col)
  const after = lineText(e.line).slice(e.col)
  return { pre: before.trim() ? '\n\n' : '', post: after.trim() ? '\n' : '' }
}

function mdLink(): void {
  const r = mdSelection()
  if (!r) return
  if (!r.sel) {
    mdInsert('[]()', 1, 1)
    return
  }
  const text = `[${r.sel}](url)`
  const from = 1 + r.sel.length + 2
  mdInsert(text, from, from + 3)
}

function mdImage(): void {
  const r = mdSelection()
  if (!r) return
  if (!r.sel) {
    mdInsert('![](url)', 4, 7)
    return
  }
  const text = `![${r.sel}](url)`
  const from = 2 + r.sel.length + 2
  mdInsert(text, from, from + 3)
}

function mdCodeBlock(): void {
  const r = mdSelection()
  if (!r) return
  const { pre, post } = padFor(r.s, r.e)
  if (r.sel) {
    const text = pre + '```\n' + r.sel + '\n```' + post
    const from = pre.length + 4
    mdInsert(text, from, from + r.sel.length)
    return
  }
  const text = pre + '```\n\n```' + post
  mdInsert(text, pre.length + 4, pre.length + 4)
}

function mdTable(): void {
  const r = mdSelection()
  if (!r) return
  const { pre, post } = padFor(r.s, r.e)
  const body = '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |'
  const text = pre + body + post
  const at = pre.length + body.indexOf('列 1')
  mdInsert(text, at, at + 3)
}

function mdFormat(kind: MdFormat): void {
  if (!editTarget()) return
  switch (kind) {
    case 'bold': mdInline('**'); break
    case 'italic': mdInline('*'); break
    case 'strike': mdInline('~~'); break
    case 'code': mdInline('`'); break
    case 'quote': mdLines('quote'); break
    case 'ul': mdLines('ul'); break
    case 'ol': mdLines('ol'); break
    case 'task': mdLines('task'); break
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': mdLines(kind); break
    case 'link': mdLink(); break
    case 'image': mdImage(); break
    case 'codeblock': mdCodeBlock(); break
    case 'table': mdTable(); break
    case 'hr': {
      const r = mdSelection()
      if (!r) return
      const { pre, post } = padFor(r.s, r.e)
      mdInsert(pre + '---\n' + post)
      break
    }
  }
}

// ---------------- 对外 API ----------------
function focus(): void {
  imeEl.value?.focus({ preventScroll: true })
}

function exec(cmd: string): void {
  switch (cmd) {
    case 'undo': undo(); break
    case 'redo': redo(); break
    case 'copy': copySelection(); break
    case 'cut': cutSelection(); break
    case 'paste': paste(); break
    case 'delete': del(); break
    case 'moveUp': moveLines(-1); break
    case 'moveDown': moveLines(1); break
    case 'selectAll': selectAll(); break
    case 'duplicate': duplicateLine(); break
    case 'deleteLine': deleteLine(); break
    case 'comment': toggleComment(); break
    case 'indent': indentSelection(false); break
    case 'outdent': indentSelection(true); break
    case 'upper': changeCase(true); break
    case 'lower': changeCase(false); break
    case 'bookmark': toggleBookmark(); break
    case 'nextBookmark': nextBookmark(); break
    case 'goto': emit('cmd', 'goto'); break
    case 'find': emit('cmd', 'find'); break
    case 'replace': emit('cmd', 'replace'); break
    case 'save': emit('cmd', 'save'); break
    case 'save-as': emit('cmd', 'save-as'); break
    case 'refresh': props.tab.rev++; break
  }
}

defineExpose({ focus, exec, setCaret, setSel, scrollToLine, selectAll, ensureCaretVisible, syncIme, hitTest, replaceAt, replaceAllWith, mdFormat, replaceLines, selectionInfo, selectionRect })
defineOptions({ inheritAttrs: false })

// ---------------- 生命周期 / 联动 ----------------
let dblTimer: ReturnType<typeof setTimeout> | null = null
function handleDblClick(e: MouseEvent): void {
  if (e.detail === 3) {
    const hit = hitTest(e.clientX, e.clientY)
    if (hit) setSel({ line: hit.pos.line, col: 0 }, { line: hit.pos.line, col: lineText(hit.pos.line).length })
    return
  }
  onMouseDblClick(e)
}

function bindDbl(): void {
  const el = scrollEl.value
  if (!el) return
  el.addEventListener('dblclick', handleDblClick)
}

onMounted(() => {
  measure()
  bindDbl()
  ro = new ResizeObserver(() => { measure(); props.tab.rev++ })
  if (scrollEl.value) ro.observe(scrollEl.value)
  const el = scrollEl.value
  if (el && props.tab.scrollTop) {
    el.scrollTop = props.tab.scrollTop
    el.scrollLeft = props.tab.scrollLeft
    scrollTopRef.value = el.scrollTop
    scrollLeftRef.value = el.scrollLeft
  }
  if (props.active) focus()
  ensureWindow()
  nextTick(() => { ensureCaretVisible(); syncIme() })
})

onBeforeUnmount(() => {
  ro?.disconnect()
  removeDragListeners()
  if (dblTimer) clearTimeout(dblTimer)
})

watch(() => props.tab.id, () => {
  rowCache.clear()
  resetComposition()
  scrollTopRef.value = 0
  nextTick(() => {
    measure()
    const el = scrollEl.value
    if (el) { el.scrollTop = props.tab.scrollTop; el.scrollLeft = props.tab.scrollLeft; scrollTopRef.value = el.scrollTop }
    ensureWindow()
    if (props.active) focus()
  })
})

watch(firstLine, () => ensureWindow())

watch(() => props.tab.caret, () => queueSyncIme(), { deep: true })

watch(() => props.tab.wrap, () => {
  nextTick(() => { measure(); props.tab.rev++; measureWrapFactor(); props.tab.rev++ })
})

watch(() => props.active, (v) => { if (v) nextTick(() => { focus(); queueSyncIme() }) })

watch(() => props.fontSize, () => nextTick(() => { measure(); props.tab.rev++; syncIme() }))
</script>

<style scoped>
.te {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  background: var(--bg);
  overflow: hidden;
}
.te-scroll {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: auto;
  outline: none;
  scrollbar-gutter: stable;
}
.te-canvas { position: absolute; top: 0; left: 0; width: 1px; pointer-events: none; }
.te-rows {
  position: absolute;
  left: 0;
  min-width: 100%;
  width: max-content;
  will-change: transform;
}
.te-row {
  display: flex;
  align-items: flex-start;
  min-width: 100%;
  width: max-content;
  font-family: var(--mono);
  white-space: pre;
  tab-size: 4;
}
.te-row.cur { background: var(--te-cur-line); }
/* 换行模式：容器不能是 max-content，否则行宽永远等于最长行，永远不会折行 */
.te-wrap .te-rows { width: auto; min-width: 0; }
.te-wrap .te-row { white-space: pre-wrap; word-break: break-word; width: auto; min-width: 0; }
.te-gln {
  position: sticky;
  left: 0;
  z-index: 2;
  flex: 0 0 auto;
  text-align: right;
  padding-right: 10px;
  color: var(--te-gutter);
  background: var(--te-gutter-bg);
  font-family: var(--mono);
  user-select: none;
  cursor: pointer;
  border-right: 1px solid var(--border);
}
.te-gln.cur { color: var(--accent); }
.te-gln.bookmarked { color: var(--yellow); }
.te-wrap .te-gln { align-self: stretch; }
.te-code { flex: 1 0 auto; padding: 0 42px 0 8px; min-width: 0; }
.te-wrap .te-code { flex: 1 1 auto; }
.te-caret {
  display: inline-block;
  width: 2px;
  height: 1.25em;
  margin: 0 -1px;
  vertical-align: text-bottom;
  background: var(--te-caret);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.25);
}
.te-caret.blink { animation: te-blink 1.05s steps(1) infinite; }
@keyframes te-blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0; } }

.te-ime {
  position: fixed;
  z-index: 30;
  width: 2px;
  min-height: 12px;
  padding: 0;
  margin: 0;
  border: 0;
  outline: none;
  resize: none;
  overflow: hidden;
  background: transparent;
  color: transparent;
  caret-color: transparent;
  font-family: var(--mono);
  font-size: inherit;
  opacity: 0.01;
  pointer-events: none;
}
.te-comp {
  position: fixed;
  z-index: 31;
  padding: 0 2px;
  transform: translateY(1px);
  background: var(--bg-card);
  border-bottom: 1px solid var(--accent);
  color: var(--text);
  font-family: var(--mono);
  pointer-events: none;
  white-space: pre;
}
.te-hint {
  position: absolute;
  right: 14px;
  bottom: 10px;
  padding: 3px 9px;
  border-radius: 6px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 11px;
}

/* 行内 token 配色（跟随主题） */
:deep(.tk-kw) { color: var(--tk-kw); }
:deep(.tk-type) { color: var(--tk-type); }
:deep(.tk-str) { color: var(--tk-str); }
:deep(.tk-num) { color: var(--tk-num); }
:deep(.tk-com) { color: var(--tk-com); font-style: italic; }
:deep(.tk-fn) { color: var(--tk-fn); }
:deep(.tk-const) { color: var(--tk-const); }
:deep(.tk-var) { color: var(--tk-var); }
:deep(.tk-op) { color: var(--tk-op); }
:deep(.tk-tag) { color: var(--tk-tag); }
:deep(.tk-attr) { color: var(--tk-attr); }
:deep(.tk-key) { color: var(--tk-key); }
:deep(.tk-head) { color: var(--tk-head); font-weight: 700; }
:deep(.tk-bold) { color: var(--text); font-weight: 700; }
:deep(.tk-link) { color: var(--accent); text-decoration: underline; }
:deep(.tk-err) { color: var(--red); font-weight: 600; }
:deep(.tk-warn) { color: var(--yellow); font-weight: 600; }
:deep(.tk-info) { color: var(--green); }
:deep(.tk-dim) { color: var(--text-faint); }
:deep(.tk-add) { color: var(--green); background: var(--green-dim); }
:deep(.tk-del) { color: var(--red); background: var(--red-dim); }
:deep(.tk-sel) { background: var(--te-sel); }
:deep(.tk-find) { background: var(--te-find); border-radius: 2px; }
:deep(.tk-find-cur) { background: var(--te-find-cur); border-radius: 2px; color: #fff; }
:deep(.tk-bracket) { background: var(--te-bracket); box-shadow: 0 0 0 1px var(--te-bracket-line); border-radius: 2px; }
:deep(.te-readonly) .te-code { cursor: default; }
</style>
