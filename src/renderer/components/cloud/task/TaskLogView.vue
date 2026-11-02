<template>
  <div class="tl">
    <div class="tl-head">
      <button class="tp-btn sm ghost" title="返回任务详情" @click="$emit('close')">← 返回</button>
      <div class="tl-title">
        <b>{{ sub.name }}</b>
        <span class="tk-st" :class="st.tone"><i class="dot"></i>{{ st.label }}</span>
        <span class="tp-chip mono">#{{ sub.id }}</span>
        <span class="tp-chip">{{ sub.nodeType || '—' }}</span>
        <span class="tp-chip">{{ sub.runTime ? sub.runTime + 's' : '—' }}</span>
      </div>
      <span class="sp"></span>
      <button class="tp-btn sm" :disabled="loading" @click="fetchLog">{{ loading ? '读取中…' : '重新读取' }}</button>
    </div>

    <div class="tl-bar">
      <input
        v-model="kw"
        class="tp-input tl-search"
        placeholder="过滤日志行（空格分隔多个关键词）"
        spellcheck="false"
      />
      <label class="tl-opt" title="长日志按原始换行展示，关掉则整行不折行（横向滚动）">
        <input v-model="wrap" type="checkbox" /> 自动换行
      </label>
      <button class="tp-btn sm" :disabled="loading || !text" @click="copy">复制</button>
      <span class="sp"></span>
      <span v-if="loading" class="tp-note">正在向 OCP 拉取子任务日志…</span>
      <span v-else-if="error" class="tp-note err">{{ error }}</span>
      <span v-else-if="!text" class="tp-note">该子任务没有日志输出（可能尚未开始执行）</span>
      <template v-else>
        <span class="tp-note">{{ total }} 行 · {{ sizeText }}</span>
        <span v-if="kw.trim()" class="tp-note">· 匹配 {{ matched }} 行<template v-if="hidden">{{ `（仅渲染前 ${MAX_LINES} 行）` }}</template></span>
        <span class="tp-note mono">GET /tasks/instances/{{ taskId }}/subtasks/{{ sub.id }}/log</span>
      </template>
    </div>

    <div class="tl-body" :class="{ nowrap: !wrap }">
      <pre v-if="shown">{{ shown }}</pre>
      <div v-else-if="!loading && !error" class="tp-empty">没有可显示的日志</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 子任务日志面板（对齐 OCP 任务详情里的「查看日志」）：
 * 日志走 OCP 的 subtask log 接口，前端只做展示、过滤与复制——不落盘、不改写内容。
 * 单个子任务日志可能有几万行，这里按「过滤后再截断渲染」处理，避免一次插入几十万个文本节点。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { loadSubtaskLog } from '../../../cloud/state'
import { taskStatus } from '../../../cloud/parts'
import { pushNotice } from '../../../store'

const props = defineProps<{ taskId: number; sub: CloudSubtask }>()
defineEmits<{ (e: 'close'): void }>()

const MAX_LINES = 6000

const text = ref('')
const loading = ref(false)
const error = ref('')
const kw = ref('')
const wrap = ref(true)
/** 请求序号：快速切换子任务时只认最后一次响应 */
let reqSeq = 0

const st = computed(() => taskStatus(props.sub.status))
const lines = computed(() => (text.value ? text.value.split(/\r?\n/) : []))
const total = computed(() => lines.value.length)
const sizeText = computed(() => {
  const n = new Blob([text.value]).size
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
})

const filtered = computed(() => {
  const words = kw.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return lines.value
  return lines.value.filter((l) => {
    const low = l.toLowerCase()
    return words.every((w) => low.includes(w))
  })
})
const matched = computed(() => filtered.value.length)
const hidden = computed(() => filtered.value.length > MAX_LINES)
const shown = computed(() => {
  if (!text.value) return ''
  return filtered.value.slice(0, MAX_LINES).join('\n')
})

async function fetchLog(): Promise<void> {
  const mine = ++reqSeq
  loading.value = true
  error.value = ''
  const r = await loadSubtaskLog(props.taskId, props.sub.id)
  // 期间切到别的子任务时丢弃旧响应，避免串台
  if (mine !== reqSeq) return
  loading.value = false
  if (r.ok) text.value = r.text || ''
  else error.value = r.error || '读取日志失败'
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(shown.value || text.value)
    pushNotice('日志已复制到剪贴板')
  } catch {
    pushNotice('复制失败：剪贴板不可用')
  }
}

onMounted(fetchLog)
watch(() => props.sub.id, fetchLog)
</script>

<style scoped>
.tl { position: absolute; inset: 0; background: var(--bg-card); display: flex; flex-direction: column; z-index: 5; }
.tl-head { display: flex; align-items: center; gap: 7px; padding: 10px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.tl-title { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.tl-title b { font-size: 13px; }
.tl-head .sp { flex: 1; }
.tl-bar { display: flex; align-items: center; gap: 8px; padding: 5px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.tl-bar .sp { flex: 1; }
.tl-bar .err { color: var(--red); }
.tl-search { width: 220px; font-size: 11px; }
.tl-opt { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--text-dim); white-space: nowrap; }
.tl-body { flex: 1; overflow: auto; padding: 8px 12px 14px; }
.tl-body pre {
  margin: 0; font-family: var(--mono); font-size: 11px; line-height: 1.5; color: var(--text);
  white-space: pre-wrap; word-break: break-word;
}
.tl-body.nowrap pre { white-space: pre; word-break: normal; }
.tk-st { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); }
.tk-st .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); }
.tk-st.ok { color: var(--green); } .tk-st.ok .dot { background: var(--green); }
.tk-st.bad { color: var(--red); } .tk-st.bad .dot { background: var(--red); }
.tk-st.warn { color: var(--yellow); } .tk-st.warn .dot { background: var(--yellow); }
.tk-st.info { color: var(--accent); } .tk-st.info .dot { background: var(--accent); }
</style>
