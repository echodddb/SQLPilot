<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">监控 <span class="cnt">{{ tenantName }}</span></h4>
      <span class="sp"></span>
      <span v-if="updated" class="tp-note">更新于 {{ updated }}</span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>

    <div class="tp-cards">
      <div v-for="c in cards" :key="c.key" class="tp-card metric">
        <div class="m-label">{{ c.label }}</div>
        <div class="m-value">
          {{ c.value }}<span v-if="c.unit" class="m-unit">{{ c.unit }}</span>
        </div>
        <div v-if="c.ratio !== null" class="tp-bar-meter" style="margin:4px 0 2px">
          <i :class="c.ratio > 0.85 ? 'bad' : c.ratio > 0.7 ? 'warn' : ''" :style="{ width: `${Math.min(100, Math.max(2, c.ratio * 100))}%` }"></i>
        </div>
        <div class="m-hint">{{ c.hint }}</div>
      </div>
    </div>

    <div v-if="data?.window" class="tp-note">
      统计窗口 {{ data.window.windowSec / 60 }} 分钟：SQL {{ data.window.sqlCount }} 条，其中错误
      {{ data.window.errCount }} 条，平均耗时 {{ (data.window.avgUs / 1000).toFixed(2) }} ms，折算 QPS
      {{ data.window.qps.toFixed(2) }}。窗口一过归零属正常（审计表只保留近一段时间）。
    </div>

    <div class="tp-note">
      直连模式没有 OCP 的 metrics 时序接口，这里是在 sys 租户里现算的一屏实时快照：
      <code class="tp-mono">GV$OB_SQL_AUDIT</code>（QPS/错误/耗时）、
      <code class="tp-mono">GV$OB_MEMSTORE</code>（MemStore）、
      <code class="tp-mono">GV$OB_TENANT_MEMORY</code>（租户内存）、
      <code class="tp-mono">GV$OB_UNITS</code>（CPU/磁盘）、
      <code class="tp-mono">GV$OB_PROCESSLIST</code>（会话）。每 30 秒自动刷新。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 直连租户 · 监控：一屏快照（没有时序库，指标全是现算的当前值） */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ platformId: string; tenantId: number; tenantName: string; reloadToken: number }>()

const data = ref<CloudDirectMetrics | null>(null)
const loading = ref(false)
const err = ref('')
const updated = ref('')
const cards = computed(() => data.value?.cards || [])

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const r = await window.sqlpilot.cloudDirectTenantMetrics(props.platformId, props.tenantId, props.tenantName)
    if (!r.ok) { err.value = r.error || '读取监控数据失败'; return }
    data.value = r.data || null
    updated.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  } finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void load()
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && !loading.value) void load()
  }, 30_000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
watch(() => props.reloadToken, load)
</script>

<style scoped>
.metric { gap: 2px; }
.m-label { font-size: 10.5px; color: var(--text-faint); }
.m-value { font-size: 19px; font-weight: 600; line-height: 1.2; }
.m-unit { font-size: 10.5px; font-weight: 400; color: var(--text-dim); margin-left: 3px; }
.m-hint { font-size: 10px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-cards { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 760px) { .tp-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
