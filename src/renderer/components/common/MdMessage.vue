<template>
  <div class="mdm" :class="[role, { streaming, bubble }]">
    <span v-if="$slots.avatar" class="mdm-av"><slot name="avatar" /></span>
    <div class="mdm-main">
      <!-- 用户消息按纯文本显示（别把用户问的 SQL/代码当 markdown 解析掉格式） -->
      <div v-if="role === 'user'" class="mdm-bd plain">{{ text }}</div>
      <div v-else ref="bodyEl" class="mdm-bd md" v-html="html" @click="onClick"></div>

      <!-- 单段回答：整条复制（复制的是模型原始 Markdown） -->
      <div v-if="role === 'assistant' && text && !streaming" class="mdm-bar">
        <button class="mdm-act" title="复制这条回答的 Markdown 原文" @click="copyAll">
          {{ copiedAll ? '已复制' : '复制全文' }}
        </button>
        <slot name="bar" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * AI 回答气泡：Markdown 渲染 + 整段复制 + 代码块级复制。
 *
 * 云管（OCP / Oracle）与文本编辑器共用，保证两边的气泡、复制行为一致。
 * 代码块的复制按钮由渲染后插入（`renderMarkdown` 输出里没有按钮，
 * 这样文件预览那边不会平白多出一堆复制角标）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderMarkdown } from '../../editor/markdown'

const props = withDefaults(
  defineProps<{
    text: string
    role: 'user' | 'assistant'
    /** 正在流式输出：此时不出复制条（内容还在变） */
    streaming?: boolean
    /** 是否画气泡背景（默认画；嵌在已有卡片里时可关掉） */
    bubble?: boolean
  }>(),
  { streaming: false, bubble: true }
)

const emit = defineEmits<{ (e: 'link', href: string): void }>()

const bodyEl = ref<HTMLElement | null>(null)
const copiedAll = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const html = computed(() => (props.role === 'assistant' ? renderMarkdown(props.text || '', 400_000).html : ''))

/** 给每个代码块角上挂一个「复制」按钮（幂等：已有就跳过） */
function decorate(): void {
  const root = bodyEl.value
  if (!root) return
  root.querySelectorAll<HTMLElement>('.md-code').forEach((box) => {
    if (box.querySelector('.md-copy-code')) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'md-copy-code'
    btn.textContent = '复制'
    btn.title = '复制这段代码'
    box.appendChild(btn)
  })
}

watch(
  () => props.text,
  async () => {
    await nextTick()
    decorate()
  }
)

onMounted(async () => {
  await nextTick()
  decorate()
})

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})

async function write(text: string): Promise<boolean> {
  try {
    if (window.sqlpilot?.writeClipboard) {
      await window.sqlpilot.writeClipboard(text)
      return true
    }
  } catch {
    /* 回退到浏览器剪贴板 */
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function flash(btn: HTMLElement, ok: boolean): void {
  const old = btn.textContent || ''
  btn.textContent = ok ? '已复制' : '复制失败'
  btn.classList.toggle('ok', ok)
  setTimeout(() => {
    btn.textContent = old === '已复制' ? '复制' : old
    btn.classList.remove('ok')
  }, 1200)
}

async function copyAll(): Promise<void> {
  const ok = await write(props.text || '')
  copiedAll.value = ok
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copiedAll.value = false), 1400)
}

async function onClick(e: MouseEvent): Promise<void> {
  const el = e.target as HTMLElement | null
  if (!el) return
  const copyBtn = el.closest<HTMLElement>('.md-copy-code')
  if (copyBtn) {
    e.preventDefault()
    const box = copyBtn.closest('.md-code')
    const code = box?.querySelector('code')?.textContent || ''
    flash(copyBtn, await write(code))
    e.stopPropagation()
    return
  }
  const a = el.closest('a')
  if (a) {
    e.preventDefault()
    e.stopPropagation()
    const href = a.getAttribute('href') || ''
    if (/^https?:\/\//.test(href)) emit('link', href)
  }
}
</script>

<style scoped>
.mdm { display: flex; gap: 7px; align-items: flex-start; min-width: 0; }
.mdm.user { justify-content: flex-end; }
.mdm-main { min-width: 0; max-width: 100%; display: flex; flex-direction: column; gap: 3px; }
.mdm.user .mdm-main { align-items: flex-end; max-width: 88%; }

.mdm-av {
  width: 18px; height: 18px; flex-shrink: 0; border-radius: 5px; font-size: 9.5px; margin-top: 2px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); color: var(--text-faint); background: var(--bg-input);
}
.mdm.assistant .mdm-av { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, transparent); background: var(--accent-dim); }

/* 气泡：每段消息用一块圆角底色围住 */
.mdm.bubble .mdm-bd {
  border-radius: 10px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  background: var(--bg-input);
}
.mdm.bubble.user .mdm-bd {
  border-radius: 10px 10px 4px 10px;
  background: var(--accent-dim);
  border-color: color-mix(in srgb, var(--accent) 32%, transparent);
}
.mdm.assistant .mdm-bd { font-size: 11.5px; line-height: 1.72; color: var(--text); word-break: break-word; }
.mdm-bd.plain { white-space: pre-wrap; font-size: 11.5px; line-height: 1.7; color: var(--text); }

/* Markdown 排版 */
.mdm-bd.md :deep(p) { margin: 3px 0; }
.mdm-bd.md :deep(p:first-child) { margin-top: 0; }
.mdm-bd.md :deep(p:last-child) { margin-bottom: 0; }
.mdm-bd.md :deep(h1), .mdm-bd.md :deep(h2), .mdm-bd.md :deep(h3),
.mdm-bd.md :deep(h4), .mdm-bd.md :deep(h5), .mdm-bd.md :deep(h6) { margin: 8px 0 4px; font-size: 12.5px; }
.mdm-bd.md :deep(ul), .mdm-bd.md :deep(ol) { margin: 4px 0; padding-left: 18px; }
.mdm-bd.md :deep(li) { margin: 2px 0; }
.mdm-bd.md :deep(strong) { font-weight: 650; }
.mdm-bd.md :deep(code) {
  font-family: var(--mono); font-size: 10.5px; background: var(--bg-card);
  padding: 0 3px; border-radius: 3px; color: var(--text);
}
.mdm-bd.md :deep(.md-code) {
  position: relative; margin: 7px 0; border: 1px solid var(--border); border-radius: 8px;
  overflow: hidden; background: var(--bg-code, var(--bg-input));
}
.mdm-bd.md :deep(.md-code-lang) {
  font-family: var(--mono); font-size: 9.5px; color: var(--text-faint);
  padding: 3px 8px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 40%, transparent);
  text-transform: lowercase;
}
.mdm-bd.md :deep(.md-code pre) { margin: 0; padding: 7px 9px; overflow-x: auto; }
.mdm-bd.md :deep(.md-code pre code) { background: none; padding: 0; font-size: 10.5px; line-height: 1.6; }
/* 代码块右上角复制：hover 代码块才显形，不压住正文 */
.mdm-bd.md :deep(.md-copy-code) {
  position: absolute; top: 4px; right: 6px;
  border: 1px solid var(--border-strong); background: var(--bg-side); color: var(--text-faint);
  border-radius: 5px; padding: 1px 7px; font-size: 9.5px; font-family: inherit; cursor: pointer;
  opacity: 0; transition: opacity 0.12s ease, color 0.12s ease;
}
.mdm-bd.md :deep(.md-code:hover .md-copy-code) { opacity: 1; }
.mdm-bd.md :deep(.md-copy-code:hover) { color: var(--accent); border-color: var(--accent); }
.mdm-bd.md :deep(.md-copy-code.ok) { opacity: 1; color: var(--green); border-color: color-mix(in srgb, var(--green) 50%, transparent); }
.mdm-bd.md :deep(.md-table) { overflow-x: auto; margin: 7px 0; }
.mdm-bd.md :deep(.md-table table) { border-collapse: collapse; font-size: 10.5px; min-width: 100%; }
.mdm-bd.md :deep(table) { border-collapse: collapse; font-size: 10.5px; margin: 6px 0; }
.mdm-bd.md :deep(th), .mdm-bd.md :deep(td) { border: 1px solid var(--border); padding: 4px 7px; }
.mdm-bd.md :deep(.md-table th) { background: var(--bg-card); font-weight: 600; color: var(--text-dim); }
.mdm-bd.md :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 9px 0; }
.mdm-bd.md :deep(blockquote) { margin: 6px 0; padding-left: 8px; border-left: 2px solid var(--border-strong); color: var(--text-dim); }
.mdm-bd.md :deep(a) { color: var(--accent); text-decoration: none; }
.mdm-bd.md :deep(a:hover) { text-decoration: underline; }

.mdm-bar { display: flex; align-items: center; gap: 5px; padding-left: 2px; }
.mdm-act {
  border: 1px solid var(--border); background: none; color: var(--text-faint);
  border-radius: 5px; padding: 1px 7px; font-size: 9.5px; font-family: inherit; cursor: pointer;
  opacity: 0.75;
}
.mdm-act:hover { color: var(--accent); border-color: var(--accent); opacity: 1; }
</style>
