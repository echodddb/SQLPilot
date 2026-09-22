<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal" style="width: 720px; max-width: 94vw; display: flex; flex-direction: column; max-height: 85vh">
      <h3> 项目归档 <span class="badge blue">{{ project }}</span></h3>
      <div style="font-size: 12px; color: var(--text-dim); margin: 4px 0 8px">
        归档会话的总结（按时间倒序展示为原文顺序）；该项目下会话的提示词自动携带最近部分作为任务背景。
      </div>
      <div v-if="loading" style="padding: 30px; text-align: center; color: var(--text-faint)">读取中…</div>
      <pre v-else-if="content" class="arc-body">{{ content }}</pre>
      <div v-else style="padding: 30px; text-align: center; color: var(--text-faint)">
        该项目还没有归档。<br />归档入口：会话输入框" 归档对话"或侧边栏会话行的 。
      </div>
      <div class="actions">
        <span style="flex: 1"></span>
        <button class="btn" @click="$emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{ projectId: string; project: string }>()
defineEmits<{ (e: 'close'): void }>()

const content = ref('')
const loading = ref(false)

watch(
  () => props.projectId,
  async (id) => {
    if (!id) return
    loading.value = true
    content.value = ''
    try {
      const r = await window.sqlpilot.getProjectArchive(id)
      content.value = r.ok ? r.content || '' : `读取失败：${r.error}`
    } catch (e: any) {
      content.value = `读取失败：${String(e?.message || e)}`
    } finally {
      loading.value = false
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.arc-body {
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 10px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-dim);
}
</style>
