<template>
  <div class="cb-row">
    <span class="cb-label">{{ label }}</span>
    <div class="cb-track" :title="`${pct}%`">
      <div class="cb-fill" :class="tone" :style="{ width: Math.min(100, Math.max(pct > 0 ? 2 : 0, pct)) + '%' }"></div>
    </div>
    <span class="cb-val" :class="tone">{{ text }}</span>
  </div>
</template>

<script setup lang="ts">
/** 容量水位条（纯 CSS，不引图表库）：标签 / 进度 / 数值三段式，颜色随水位变化 */
import { computed } from 'vue'
import { capacityTone, fmtBytes } from '../../cloud/parts'

const props = withDefaults(
  defineProps<{
    label: string
    used: number
    total: number
    percent: number
    unit?: 'bytes' | 'count'
    /** 语义色覆盖：OB 的 CPU/内存"分配率"接近 100% 属正常，沿用磁盘的红黄阈值会误报 */
    tone?: 'ok' | 'warn' | 'bad' | 'idle' | 'info'
  }>(),
  { unit: 'bytes', tone: undefined }
)

const pct = computed(() => Math.round((Number(props.percent) || 0) * 10) / 10)
const tone = computed(() => props.tone || capacityTone(pct.value))
const text = computed(() =>
  props.unit === 'bytes'
    ? `${fmtBytes(props.used)} / ${fmtBytes(props.total)}`
    : `${props.used} / ${props.total}`
)
</script>

<style scoped>
.cb-row { display: grid; grid-template-columns: 54px 1fr auto; align-items: center; gap: 8px; }
.cb-label { font-size: 11px; color: var(--text-faint); }
.cb-track {
  height: 7px; border-radius: 99px; background: var(--bg-input); overflow: hidden;
  box-shadow: inset 0 0 0 1px var(--border);
}
.cb-fill { height: 100%; border-radius: 99px; transition: width 0.4s ease; min-width: 2px; }
.cb-fill.ok { background: var(--green); }
.cb-fill.warn { background: var(--yellow); }
.cb-fill.bad { background: var(--red); }
.cb-fill.info { background: var(--accent); }
.cb-fill.idle { background: var(--border-strong); }
.cb-val { font-family: var(--mono); font-size: 11px; color: var(--text-dim); white-space: nowrap; }
.cb-val.warn { color: var(--yellow); }
.cb-val.bad { color: var(--red); }
</style>
