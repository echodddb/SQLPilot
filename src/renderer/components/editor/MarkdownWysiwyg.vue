<template>
  <div ref="hostEl" class="wys" :style="{ fontSize: fontSize + 'px' }" @mousedown.self="onHostDown">
    <div class="wys-inner">
      <template v-for="(b, i) in blocks" :key="b.start + ':' + b.kind + ':' + b.text.length">
        <!-- 空行：一条可点击的细带，点一下就能在那里写新段落 -->
        <div
          v-if="b.kind === 'blank'"
          class="wys-blank"
          :class="{ editing: editingIndex === i }"
          @mousedown.prevent="startEdit(i)"
        >
          <textarea
            v-if="editingIndex === i"
            ref="taRef"
            v-model="editText"
            class="wys-ta blank"
            rows="1"
            spellcheck="false"
            placeholder="输入内容…（Esc 完成）"
            @input="onInput"
            @keydown="onEditKey"
            @blur="onBlur"
          ></textarea>
        </div>

        <!-- 正在编辑的块：显示原始 Markdown -->
        <div v-else-if="editingIndex === i" class="wys-editing" :class="'k-' + b.kind">
          <div v-if="b.kind === 'code'" class="wys-code-head">
            <span class="wys-code-lang">{{ b.lang || 'code' }}</span>
            <span class="wys-code-hint">直接编辑代码 · Esc 完成</span>
          </div>
          <textarea
            ref="taRef"
            v-model="editText"
            class="wys-ta"
            :class="{ code: b.kind === 'code' }"
            rows="1"
            spellcheck="false"
            @input="onInput"
            @keydown="onEditKey"
            @blur="onBlur"
          ></textarea>
        </div>

        <!-- 渲染态 -->
        <div
          v-else
          class="wys-block md-body"
          :class="'k-' + b.kind"
          v-html="htmlOf(b)"
          @mousedown.prevent="startEdit(i, $event)"
        ></div>
      </template>

      <!-- 文末空白：点一下就在末尾新建一段（Typora 的习惯） -->
      <div class="wys-end" title="点击在文末新建段落" @mousedown.prevent="createAtEnd"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Tab } from '../../editor/types'
import {
  splitBlocks, renderMarkdown, listMarker, isEmptyListItem,
  type MdBlock, type MdBlockKind
} from '../../editor/markdown'
import '../../editor/markdown.css'

const props = defineProps<{
  tab: Tab
  fontSize?: number
  /** 把 [start, start+del) 行替换成 lines（由编辑器内核执行，带撤销） */
  patch: (start: number, del: number, lines: string[]) => void
}>()

const hostEl = ref<HTMLElement | null>(null)
const taRef = ref<HTMLTextAreaElement | HTMLTextAreaElement[] | null>(null)
const editingIndex = ref<number | null>(null)
const editText = ref('')
const editKind = ref<MdBlockKind>('paragraph')

/** ref 放在 v-for 里会被收集成数组（同一时刻只有一个 textarea） */
function taEl(): HTMLTextAreaElement | null {
  const v = taRef.value
  if (Array.isArray(v)) return v[0] || null
  return v || null
}

/** 提交后自增，强制重新切块 */
const version = ref(0)
/** 自己提交产生的 rev 变化（避免被下面的 watch 当成"外部修改"而中断编辑） */
let selfPatch = 0

const blocks = computed<MdBlock[]>(() => {
  void version.value
  void props.tab.rev
  const doc = props.tab.doc
  if (!doc) return []
  return splitBlocks(doc.toText())
})

// ---------------- 渲染缓存 ----------------
const cache = new Map<string, string>()
function htmlOf(b: MdBlock): string {
  const key = b.kind + '|' + (b.lang || '') + '|' + b.text
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const html = b.kind === 'hr' ? '<hr>' : renderMarkdown(b.text).html
  if (cache.size > 300) cache.clear()
  cache.set(key, html)
  return html
}

// ---------------- 进入/退出编辑 ----------------
function codeBody(text: string): string {
  const lines = text.split('\n')
  return lines.length <= 2 ? '' : lines.slice(1, lines.length - 1).join('\n')
}

function beginEdit(i: number, caretAtEnd = true): void {
  const b = blocks.value[i]
  if (!b) return
  editKind.value = b.kind
  editText.value = b.kind === 'code' ? codeBody(b.text) : b.text
  editingIndex.value = i
  // 等两帧再聚焦：块刚从渲染态切换成 textarea，需要等 Vue patch + 布局完成，
  // 否则 focus() 作用在还没挂上的元素上（表现为"点了没反应、输入跑到别处"）
  nextTick(() => {
    requestAnimationFrame(() => {
      const ta = taEl()
      if (!ta) return
      ta.focus({ preventScroll: true })
      if (caretAtEnd) ta.setSelectionRange(ta.value.length, ta.value.length)
      resize()
      ta.scrollIntoView({ block: 'nearest' })
      if (document.activeElement !== ta) {
        setTimeout(() => {
          const again = taEl()
          if (again && document.activeElement !== again) again.focus({ preventScroll: true })
        }, 30)
      }
    })
  })
}

/** 切换编辑块时旧 textarea 会被卸载并触发 blur，不能让它把新块又提交一次 */
let switching = false

function startEdit(i: number, e?: MouseEvent): void {
  // Ctrl/Cmd+点击链接：直接交给系统浏览器（Typora 的习惯）
  if (e && (e.ctrlKey || e.metaKey)) {
    const a = (e.target as HTMLElement | null)?.closest('a')
    const href = a?.getAttribute('href') || ''
    if (href) {
      if (/^https?:/i.test(href)) window.sqlpilot.openExternal(href)
      return
    }
  }
  if (editingIndex.value === i) return
  const targetStart = blocks.value[i]?.start ?? 0
  if (editingIndex.value !== null) {
    switching = true
    const info = commit()
    setTimeout(() => { switching = false }, 0)
    if (info) {
      // 上一个块行数变了：把点击的目标行号一起平移，再按行号找回目标块
      const adjusted = targetStart + (info.start < targetStart ? info.delta : 0)
      const idx = blocks.value.findIndex((b) => b.start <= adjusted && adjusted <= b.end)
      if (idx >= 0) beginEdit(idx)
      return
    }
  }
  beginEdit(i)
}

function closeEdit(): void {
  editingIndex.value = null
  editText.value = ''
}

/** 提交当前块，返回行数变化（供调用方校正行号） */
function commit(extra?: string[]): { start: number; delta: number; newCount: number } | null {
  if (editingIndex.value === null) return null
  const b = blocks.value[editingIndex.value]
  if (!b) { closeEdit(); return null }

  let text = editText.value
  if (b.kind === 'code') {
    const body = text.replace(/\n+$/, '')
    text = '```' + (b.lang || '') + '\n' + body + '\n```'
  }
  if (extra && extra.length) text = text.trim() ? text + '\n' + extra.join('\n') : extra.join('\n')

  const lines = text.split('\n')
  // 原来是空行、现在写成了内容：若后面紧跟别的块，补一个空行做分隔（保持源码整洁）
  if (b.kind === 'blank' && text.trim()) {
    const next = blocks.value[editingIndex.value! + 1]
    if (next && next.kind !== 'blank' && lines[lines.length - 1] !== '') lines.push('')
  }
  const oldCount = b.end - b.start + 1
  const changed = text !== b.text
  closeEdit()
  if (changed && !props.tab.readOnly) {
    selfPatch++
    props.patch(b.start, oldCount, lines)
  }
  version.value++
  return { start: b.start, delta: lines.length - oldCount, newCount: lines.length }
}

function onBlur(e: FocusEvent): void {
  const el = e.target as HTMLElement | null
  // 切块时旧 textarea 被移除也会触发 blur：此时内容已经提交过，忽略
  if (switching || !el || !el.isConnected) return
  commit()
}

function onInput(): void {
  resize()
}

function resize(): void {
  const ta = taEl()
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = Math.max(ta.classList.contains('blank') ? 24 : 32, ta.scrollHeight + 2) + 'px'
}

function onHostDown(): void {
  if (editingIndex.value !== null) commit()
}

/** 文末新建段落：末尾已是空行时直接编辑它，避免越点越多空行 */
function createAtEnd(): void {
  if (editingIndex.value !== null) commit()
  const last = blocks.value[blocks.value.length - 1]
  if (last && last.kind === 'blank') {
    beginEdit(blocks.value.length - 1)
    return
  }
  const start = last ? last.end + 1 : 0
  selfPatch++
  props.patch(start, 0, [''])
  version.value++
  nextTick(() => {
    const idx = blocks.value.findIndex((b) => b.start === start)
    if (idx >= 0) beginEdit(idx)
  })
}

/** 在当前块后插入若干行并继续编辑新块（Typora：回车结束当前段落） */
function newBlockAfter(extra: string[]): void {
  const info = commit(extra)
  if (!info) return
  const target = info.start + info.newCount - 1
  nextTick(() => {
    const idx = blocks.value.findIndex((b) => b.start <= target && target <= b.end)
    if (idx >= 0) beginEdit(idx)
  })
}

// ---------------- 键盘（Typora 行为） ----------------
function onEditKey(e: KeyboardEvent): void {
  const ta = e.target as HTMLTextAreaElement

  if (e.key === 'Escape') {
    e.preventDefault()
    commit()
    return
  }

  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    // 代码块里回车就是换行
    if (editKind.value === 'code') return
    e.preventDefault()
    const s = ta.selectionStart
    const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1
    const nl = ta.value.indexOf('\n', s)
    const lineEnd = nl < 0 ? ta.value.length : nl
    const line = ta.value.slice(lineStart, lineEnd)
    const head = ta.value.slice(lineStart, s)

    // 空列表项再回车：删掉标记、退出列表，留在原地继续写
    if (isEmptyListItem(line)) {
      const next = ta.value.slice(0, lineStart) + ta.value.slice(lineEnd)
      const offset = (next.slice(0, lineStart).match(/\n/g) || []).length
      editText.value = next
      const info = commit()
      if (!info) return
      const target = info.start + offset
      nextTick(() => {
        const idx = blocks.value.findIndex((b) => b.start <= target && target <= b.end)
        if (idx >= 0) beginEdit(idx)
      })
      return
    }

    // 列表项：自动续写下一项（有序列表编号 +1，任务列表补 [ ]）
    const marker = listMarker(head.trim() ? head : line)
    if (marker) {
      const insert = '\n' + marker
      const value = ta.value.slice(0, s) + insert + ta.value.slice(ta.selectionEnd)
      editText.value = value
      nextTick(() => {
        const at = s + insert.length
        taEl()?.setSelectionRange(at, at)
        resize()
      })
      return
    }

    // 普通段落：回车结束本块
    const tail = ta.value.slice(ta.selectionEnd)
    if (tail.trim()) {
      // 光标在中间：后半段另起一段
      editText.value = ta.value.slice(0, s)
      newBlockAfter(['', tail.trimStart()])
    } else {
      newBlockAfter([''])
    }
    return
  }

  if (e.key === 'Tab') {
    e.preventDefault()
    const s = ta.selectionStart
    const value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd)
    editText.value = value
    nextTick(() => {
      taEl()?.setSelectionRange(s + 2, s + 2)
      resize()
    })
  }
}

// ---------------- 对外：工具栏格式化（作用于当前编辑块） ----------------
function hasActive(): boolean {
  return editingIndex.value !== null
}

function applyFormat(kind: string): void {
  if (editingIndex.value === null) return
  if (editKind.value === 'code') return
  const ta = taEl()
  if (!ta) return
  let value = ta.value
  let selStart = ta.selectionStart
  let selEnd = ta.selectionEnd
  let focusStart = selStart
  let focusEnd = selEnd

  const wrap = (prefix: string, suffix = prefix): void => {
    const before = value.slice(0, selStart)
    const after = value.slice(selEnd)
    const sel = value.slice(selStart, selEnd)
    if (!sel) {
      if (before.endsWith(prefix) && after.startsWith(suffix)) {
        value = before.slice(0, before.length - prefix.length) + after.slice(suffix.length)
        focusStart = focusEnd = selStart - prefix.length
      } else {
        value = before + prefix + suffix + after
        focusStart = focusEnd = selStart + prefix.length
      }
      return
    }
    if (before.endsWith(prefix) && after.startsWith(suffix)) {
      value = before.slice(0, before.length - prefix.length) + sel + after.slice(suffix.length)
      focusStart = selStart - prefix.length
      focusEnd = focusStart + sel.length
      return
    }
    if (sel.startsWith(prefix) && sel.endsWith(suffix) && sel.length > prefix.length + suffix.length) {
      const inner = sel.slice(prefix.length, sel.length - suffix.length)
      value = before + inner + after
      focusStart = selStart
      focusEnd = selStart + inner.length
      return
    }
    value = before + prefix + sel + suffix + after
    focusStart = selStart + prefix.length
    focusEnd = focusStart + sel.length
  }

  const prefixLines = (make: (i: number) => string, strip: RegExp): void => {
    const l0 = value.lastIndexOf('\n', selStart - 1) + 1
    const nl = value.indexOf('\n', selEnd)
    const l1 = nl < 0 ? value.length : nl
    const lines = value.slice(l0, l1).split('\n')
    const filled = lines.filter((l) => l.trim())
    const has = filled.length > 0 && filled.every((l) => strip.test(l.replace(/^\s*/, '')))
    const out = lines.map((l, i) => {
      if (!l.trim()) return ''
      const ind = /^\s*/.exec(l)![0]
      const body = l.slice(ind.length).replace(strip, '')
      return has ? ind + body : ind + make(i) + body
    }).join('\n')
    value = value.slice(0, l0) + out + value.slice(l1)
    focusStart = l0
    focusEnd = l0 + out.length
  }

  switch (kind) {
    case 'bold': wrap('**'); break
    case 'italic': wrap('*'); break
    case 'strike': wrap('~~'); break
    case 'code': wrap('`'); break
    case 'link': {
      const sel = value.slice(selStart, selEnd)
      const ins = sel ? `[${sel}](url)` : '[]()'
      value = value.slice(0, selStart) + ins + value.slice(selEnd)
      const u = selStart + ins.lastIndexOf('url')
      focusStart = sel ? u : selStart + 1
      focusEnd = sel ? u + 3 : focusStart
      break
    }
    case 'image': {
      const sel = value.slice(selStart, selEnd)
      const ins = `![${sel}](url)`
      value = value.slice(0, selStart) + ins + value.slice(selEnd)
      focusStart = selStart + ins.length - 4
      focusEnd = focusStart + 3
      break
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const lv = Number(kind[1])
      prefixLines(() => '#'.repeat(lv) + ' ', /^#{1,6}\s+/)
      break
    }
    case 'quote': prefixLines(() => '> ', /^>\s?/); break
    case 'ul': prefixLines(() => '- ', /^(?:[-*+]|\d{1,9}[.)])\s+/); break
    case 'ol': prefixLines((i) => `${i + 1}. `, /^(?:[-*+]|\d{1,9}[.)])\s+/); break
    case 'task': prefixLines(() => '- [ ] ', /^(?:[-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/); break
    case 'codeblock': {
      const sel = value.slice(selStart, selEnd)
      const ins = '```\n' + sel + '\n```'
      value = value.slice(0, selStart) + ins + value.slice(selEnd)
      focusStart = selStart + 4
      focusEnd = focusStart + sel.length
      break
    }
    case 'table': {
      const ins = '\n\n| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n'
      value = value.slice(0, selStart) + ins + value.slice(selEnd)
      const at = selStart + ins.indexOf('列 1')
      focusStart = at
      focusEnd = at + 3
      break
    }
    case 'hr': {
      const ins = '\n\n---\n'
      value = value.slice(0, selStart) + ins + value.slice(selEnd)
      focusStart = focusEnd = selStart + ins.length
      break
    }
    default: return
  }

  editText.value = value
  nextTick(() => {
    const el = taEl()
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(focusStart, focusEnd)
    resize()
  })
}

defineExpose({ hasActive, applyFormat })

// ---------------- 生命周期 ----------------
onMounted(() => {
  // 进入即时渲染时，直接落在源码里光标所在的那一块（Typora 的"接着上次继续写"）
  const line = props.tab.caret?.line || 0
  const idx = blocks.value.findIndex((b) => b.start <= line && line <= b.end && b.kind !== 'blank')
  if (idx >= 0) {
    beginEdit(idx)
    nextTick(() => taEl()?.scrollIntoView({ block: 'center' }))
  }
})

watch(() => props.tab.id, () => { closeEdit(); version.value++ })
watch(() => props.tab.rev, () => {
  if (selfPatch > 0) { selfPatch--; return }
  // 外部（撤销/查找替换）改了文档：结束本地编辑并按新内容重切块
  if (editingIndex.value !== null && !taEl()) closeEdit()
})

onBeforeUnmount(() => { closeEdit() })
</script>

<style scoped>
.wys {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--bg);
  color: var(--text);
  line-height: 1.72;
  padding: 20px 30px 200px;
}
.wys-inner {
  max-width: 880px;
  margin: 0 auto;
}
.wys-block {
  border-radius: 6px;
  cursor: text;
  margin: 0.28em 0;
}
.wys-block:hover {
  background: color-mix(in srgb, var(--bg-card) 40%, transparent);
  outline: 1px solid var(--border);
}
.wys-block.k-hr { padding: 2px 0; }
.wys-end {
  min-height: 90px;
  border-radius: 8px;
  cursor: text;
}
.wys-end:hover {
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  outline: 1px dashed var(--border);
}
.wys-block.k-code { margin: 0.6em 0; }
.wys-blank {
  min-height: 10px;
  border-radius: 5px;
  cursor: text;
}
.wys-blank:hover {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  outline: 1px dashed var(--border-strong);
}
.wys-editing { position: relative; }
.wys-ta {
  display: block;
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-side);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  padding: 8px 10px;
  font-family: var(--mono, 'Cascadia Code', Consolas, 'Courier New', monospace);
  font-size: 0.94em;
  line-height: 1.68;
  resize: none;
  outline: none;
  overflow: hidden;
  tab-size: 2;
}
.wys-ta:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-dim);
}
.wys-ta.blank {
  min-height: 26px;
  font-family: inherit;
  font-size: 0.96em;
  padding: 3px 8px;
}
.wys-ta.code {
  border-radius: 0 0 7px 7px;
  border-top: none;
}
.wys-code-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-bottom: 1px solid var(--border);
  border-radius: 7px 7px 0 0;
  font-size: 10.5px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-faint);
}
.wys-code-lang { color: var(--accent); font-weight: 600; }
.wys-code-hint { text-transform: none; letter-spacing: 0; opacity: 0.75; }
</style>
