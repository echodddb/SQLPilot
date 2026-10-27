<template>
  <!-- 对话内查找：浮在对话区右上角，不改 DOM（用 CSS Custom Highlight 画高亮），
       所以流式输出、v-html 重渲染都不会把高亮冲掉 -->
  <div class="cf">
    <span class="cf-ic">⌕</span>
    <input
      ref="inputEl"
      v-model="q"
      class="cf-in"
      type="text"
      placeholder="在对话中搜索…"
      spellcheck="false"
      autocomplete="off"
      @input="onInput"
      @keydown="onKeydown"
    />
    <span class="cf-n" :class="{ none: !!q.trim() && !ranges.length }">{{ countText }}</span>
    <button class="cf-b" :disabled="!ranges.length" title="上一个（Shift+Enter）" @click="step(-1)">▲</button>
    <button class="cf-b" :disabled="!ranges.length" title="下一个（Enter）" @click="step(1)">▼</button>
    <button class="cf-b x" title="关闭（Esc）" @click="close">✕</button>
  </div>
</template>

<script setup lang="ts">
/**
 * AI 对话内搜索（Ctrl+F）。
 *
 * 搜的是「当前渲染出来的对话正文」：遍历文本节点取 Range，用 CSS Custom Highlight API
 * 上色（`::highlight(sp-find)`，样式在全局 styles.css 里），点上下条时按 Range 的
 * 位置把滚动容器滚到匹配处。选这条路的理由：
 *  - 不插 <mark>，就不会与 v-html 的 markdown 重渲染互相踩（流式输出每秒都在重渲染）；
 *  - 用户消息的纯文本、助手 markdown、工具卡、代码块天然全覆盖，不用另建索引。
 * 局限：折叠起来的「思考过程」不在 DOM 里，搜不到 —— 与浏览器查找的行为一致。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, ref, watch } from 'vue'

const props = defineProps<{
  /** 对话滚动容器（匹配范围 = 容器内的 .chat-inner） */
  scroll: HTMLElement | null
  /** 消息签名：流式输出 / 切会话都会变，变了要重算匹配并保持当前序号 */
  signature: string
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const HL_ALL = 'sp-find'
const HL_CUR = 'sp-find-cur'
/** 保护上限：超长对话里一个字的查询能匹配上万处，画那么多高亮会卡 */
const MAX_RANGES = 2000

const inputEl = ref<HTMLInputElement | null>(null)
const q = ref('')
// shallowRef：Range 是原生对象，深层响应式会把它包成 Proxy，CSS.highlights / getBoundingClientRect 全都会失效
const ranges = shallowRef<Range[]>([])
const cur = ref(0)
let timer: ReturnType<typeof setTimeout> | null = null

const countText = computed(() => {
  if (!q.value.trim()) return ''
  if (!ranges.value.length) return '无结果'
  return `${cur.value + 1}/${ranges.value.length}`
})

function hostCss(): any {
  return (window as any).CSS
}

function collect(): Range[] {
  const box = props.scroll
  const needle = q.value.trim()
  if (!box || !needle) return []
  const root = box.querySelector('.chat-inner') || box
  const out: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node) {
      const el = (n as Text).parentElement
      if (!el || !n.nodeValue) return NodeFilter.FILTER_REJECT
      const tag = el.tagName
      // 脚本/样式不参与；复制按钮之类的纯装饰文本也没必要命中
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  const lower = needle.toLowerCase()
  let node = walker.nextNode()
  while (node) {
    const text = node.nodeValue || ''
    const hay = text.toLowerCase()
    let from = 0
    for (;;) {
      const i = hay.indexOf(lower, from)
      if (i < 0) break
      const r = document.createRange()
      r.setStart(node, i)
      r.setEnd(node, i + needle.length)
      out.push(r)
      if (out.length >= MAX_RANGES) return out
      from = i + Math.max(1, needle.length)
    }
    node = walker.nextNode()
  }
  return out
}

function paint(): void {
  const css = hostCss()
  if (!css?.highlights || typeof (window as any).Highlight === 'undefined') return
  const H = (window as any).Highlight
  if (ranges.value.length) {
    const all = new H(...ranges.value)
    all.priority = 0
    css.highlights.set(HL_ALL, all)
  } else {
    css.highlights.delete(HL_ALL)
  }
  const one = ranges.value[cur.value]
  if (one) {
    const hl = new H(one)
    hl.priority = 1 // 当前条压在其他匹配之上
    css.highlights.set(HL_CUR, hl)
  } else {
    css.highlights.delete(HL_CUR)
  }
}

/** 把第 cur 条匹配滚到视口约 1/3 处（不居中，避免上方上下文全被挤掉） */
function reveal(smooth: boolean): void {
  const box = props.scroll
  const r = ranges.value[cur.value]
  if (!box || !r) return
  const rect = r.getBoundingClientRect()
  const boxRect = box.getBoundingClientRect()
  const top = box.scrollTop + (rect.top - boxRect.top) - Math.max(40, box.clientHeight / 3)
  box.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
}

function run(keepIndex = false, smooth = false, doReveal = true): void {
  const had = ranges.value.length
  ranges.value = collect()
  const n = ranges.value.length
  if (!n) cur.value = 0
  else if (keepIndex && had) cur.value = Math.min(cur.value, n - 1)
  else cur.value = 0
  paint()
  if (n && doReveal) reveal(smooth)
}

function step(dir: number): void {
  const n = ranges.value.length
  if (!n) return
  cur.value = (cur.value + dir + n) % n
  paint()
  reveal(true)
}

function onInput(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => run(false), 120)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    if (!ranges.value.length) run(false)
    else step(e.shiftKey ? -1 : 1)
    return
  }
  if (e.key === 'F3') {
    e.preventDefault()
    step(e.shiftKey ? -1 : 1)
  }
}

function close(): void {
  emit('close')
}

function clearHighlights(): void {
  const css = hostCss()
  css?.highlights?.delete(HL_ALL)
  css?.highlights?.delete(HL_CUR)
}

// 流式输出 / 切会话：内容变了要重算，但保持用户当前所在的条数
// doReveal=false：正文还在长，每 260ms 抢一次滚动会把用户按着的位置反复拽走
watch(
  () => props.signature,
  () => {
    if (!q.value.trim()) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => run(true, false, false), 260)
  }
)

// 侧栏切换等外部原因让滚动容器换了节点，也要重跑
watch(
  () => props.scroll,
  () => {
    if (q.value.trim()) run(true)
  }
)

/** 供外部（再次按 Ctrl+F）重新聚焦输入框 */
function focusInput(): void {
  inputEl.value?.focus()
  inputEl.value?.select()
}
defineExpose({ focusInput })

onMounted(async () => {
  await nextTick()
  inputEl.value?.focus()
  inputEl.value?.select()
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  clearHighlights()
})
</script>

<style scoped>
.cf {
  /* 在文档流里占一行（靠右）而不是浮在消息上：对话密度高，浮条压住的往往正是要看的正文 */
  flex-shrink: 0;
  align-self: flex-end;
  margin: 8px 18px 0 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 6px 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--bg-card);
  box-shadow: var(--shadow);
}
.cf-ic {
  color: var(--text-faint);
  font-size: 12.5px;
  line-height: 1;
}
.cf-in {
  width: 168px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  padding: 0 2px;
}
.cf-in::placeholder { color: var(--text-faint); }
.cf-n {
  min-width: 42px;
  text-align: center;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-dim);
  white-space: nowrap;
}
.cf-n.none { color: var(--red); }
.cf-b {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 5px;
  background: none;
  color: var(--text-faint);
  font-size: 9px;
  font-family: inherit;
  cursor: pointer;
}
.cf-b:hover:not(:disabled) { color: var(--accent); border-color: var(--border); background: var(--bg-card-hover); }
.cf-b:disabled { opacity: 0.35; cursor: default; }
.cf-b.x { font-size: 10px; }
.cf-b.x:hover { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
</style>
