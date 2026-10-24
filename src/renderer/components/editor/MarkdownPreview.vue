<template>
  <div class="md-host" :style="{ fontSize: fontSize + 'px' }" @click="onClick">
    <div class="md-body" v-html="html"></div>
    <div v-if="truncated" class="md-cut">
      内容过大，预览只显示前 {{ limitLabel }}（{{ sizeLabel }}）——用「源码」模式查看完整内容
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../../editor/markdown'
import '../../editor/markdown.css'

const props = withDefaults(defineProps<{ content: string; fontSize?: number }>(), { fontSize: 13.5 })

const LIMIT = 600_000

const result = computed(() => renderMarkdown(props.content, LIMIT))
const html = computed(() => result.value.html)
const truncated = computed(() => result.value.truncated)

const limitLabel = computed(() => {
  const n = Math.min(props.content.length, LIMIT)
  return n >= 10000 ? Math.round(n / 1000) + ' 千字符' : n + ' 字符'
})
const sizeLabel = computed(() => {
  const n = props.content.length
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'
})

/** 预览里的链接交给系统浏览器，锚点留在页内滚动（不能让应用自己跳走） */
function onClick(e: MouseEvent): void {
  const a = (e.target as HTMLElement | null)?.closest('a')
  if (!a) return
  const href = a.getAttribute('href') || ''
  e.preventDefault()
  if (/^https?:/i.test(href)) window.sqlpilot.openExternal(href)
}
</script>

<style scoped>
.md-host {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--bg);
  color: var(--text);
  line-height: 1.72;
  padding: 22px 30px 60px;
}
.md-body {
  max-width: 880px;
  margin: 0 auto;
}
.md-cut {
  max-width: 880px;
  margin: 24px auto 0;
  padding: 9px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.6;
}
</style>
