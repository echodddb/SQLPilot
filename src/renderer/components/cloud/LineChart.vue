<template>
  <div class="lc">
    <div class="lc-head">
      <span class="lc-title">{{ series.label }}</span>
      <span class="lc-stats">
        <span v-if="series.last !== null">当前 <b>{{ fmtMetric(series.last, series.unit) }}</b></span>
        <span v-if="series.avg !== null">均 <b>{{ fmtMetric(series.avg, series.unit) }}</b></span>
        <span v-if="series.max !== null">峰 <b>{{ fmtMetric(series.max, series.unit) }}</b></span>
      </span>
    </div>
    <div class="lc-body" @mousemove="onMove" @mouseleave="hover = null">
      <svg v-if="hasData" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="lc-svg">
        <defs>
          <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28" />
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        <!-- 横向网格 + Y 轴刻度 -->
        <g v-for="(g, i) in grid" :key="i">
          <line :x1="PAD_L" :x2="W - 4" :y1="g.y" :y2="g.y" class="lc-grid" />
          <text :x="PAD_L - 6" :y="g.y + 3" class="lc-axis" text-anchor="end">{{ g.label }}</text>
        </g>
        <path :d="areaPath" :fill="`url(#${gid})`" />
        <path :d="linePath" class="lc-line" />
        <circle v-if="lastPoint" :cx="lastPoint.x" :cy="lastPoint.y" r="2.6" class="lc-dot" />
        <!-- 悬停竖线 -->
        <g v-if="hoverPoint">
          <line :x1="hoverPoint.x" :x2="hoverPoint.x" :y1="4" :y2="H - 16" class="lc-cursor" />
          <circle :cx="hoverPoint.x" :cy="hoverPoint.y" r="3" class="lc-dot" />
        </g>
      </svg>
      <div v-else class="lc-empty">这段时间没有数据</div>
      <div v-if="hoverPoint" class="lc-tip" :style="{ left: tipLeft + '%' }">
        <b>{{ fmtMetric(hoverPoint.v, series.unit) }}</b>
        <span>{{ fmtTime(hoverPoint.t) }}</span>
      </div>
      <div class="lc-xaxis"><span>{{ fmtTime(from) }}</span><span>{{ fmtTime(to) }}</span></div>
    </div>
  </div>
</template>

<script setup lang="ts">
/** 单指标折线图：纯 SVG，无图表库；坐标随容器宽度自适应（viewBox + preserveAspectRatio=none） */
import { computed, ref } from 'vue'
import { fmtMetric } from '../../cloud/metrics'

const props = defineProps<{ series: CloudMetricSeries; from: number; to: number }>()

const W = 600
const H = 132
const PAD_L = 46

let seq = 0
const gid = `lcg${++seq}`

const hasData = computed(() => props.series.points.some((p) => p.v !== null))
const values = computed(() => props.series.points.map((p) => p.v).filter((v): v is number => v !== null))
const yMax = computed(() => {
  const m = values.value.length ? Math.max(...values.value) : 1
  return m <= 0 ? 1 : m * 1.15
})
const yMin = computed(() => Math.min(0, values.value.length ? Math.min(...values.value) : 0))

function xOf(t: number): number {
  const span = Math.max(1, props.to - props.from)
  return PAD_L + ((t - props.from) / span) * (W - PAD_L - 6)
}
function yOf(v: number): number {
  const span = Math.max(1e-9, yMax.value - yMin.value)
  return H - 16 - ((v - yMin.value) / span) * (H - 22)
}

const linePath = computed(() => {
  const pts = props.series.points.filter((p) => p.v !== null)
  if (!pts.length) return ''
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.t).toFixed(1)},${yOf(p.v as number).toFixed(1)}`).join(' ')
})
const areaPath = computed(() => {
  const pts = props.series.points.filter((p) => p.v !== null)
  if (!pts.length) return ''
  const first = pts[0]
  const last = pts[pts.length - 1]
  return `M${xOf(first.t).toFixed(1)},${H - 16} ` + pts.map((p) => `L${xOf(p.t).toFixed(1)},${yOf(p.v as number).toFixed(1)}`).join(' ') + ` L${xOf(last.t).toFixed(1)},${H - 16} Z`
})
const lastPoint = computed(() => {
  const pts = props.series.points.filter((p) => p.v !== null)
  if (!pts.length) return null
  const p = pts[pts.length - 1]
  return { x: xOf(p.t), y: yOf(p.v as number) }
})

const grid = computed(() => {
  const out: { y: number; label: string }[] = []
  for (let i = 0; i <= 2; i++) {
    const v = yMin.value + ((yMax.value - yMin.value) * i) / 2
    out.push({ y: yOf(v), label: fmtMetric(v, props.series.unit) })
  }
  return out
})

const hover = ref<{ t: number; v: number; x: number } | null>(null)
const hoverPoint = computed(() => (hover.value ? { x: xOf(hover.value.t), y: yOf(hover.value.v), v: hover.value.v, t: hover.value.t } : null))
const tipLeft = computed(() => (hoverPoint.value ? Math.min(92, Math.max(2, (hoverPoint.value.x / W) * 100)) : 0))

function onMove(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const ratio = (e.clientX - rect.left) / Math.max(1, rect.width)
  const t = props.from + ratio * (props.to - props.from)
  let best: { t: number; v: number } | null = null
  let bestD = Infinity
  for (const p of props.series.points) {
    if (p.v === null) continue
    const d = Math.abs(p.t - t)
    if (d < bestD) { bestD = d; best = { t: p.t, v: p.v } }
  }
  hover.value = best
}

const fmtTime = (t: number): string => {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<style scoped>
.lc { background: var(--bg-card); border: 1px solid var(--border); border-radius: 11px; padding: 9px 11px 6px; min-width: 0; }
.lc-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.lc-title { font-size: 11.5px; color: var(--text-dim); }
.lc-stats { margin-left: auto; display: flex; gap: 9px; font-size: 10.5px; color: var(--text-faint); }
.lc-stats b { color: var(--text); font-family: var(--mono); font-weight: 600; }
.lc-body { position: relative; }
.lc-svg { width: 100%; height: 118px; display: block; }
.lc-grid { stroke: var(--border); stroke-width: 1; stroke-dasharray: 2 3; }
.lc-axis { fill: var(--text-faint); font-size: 9px; font-family: var(--mono); }
.lc-line { fill: none; stroke: var(--accent); stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
.lc-dot { fill: var(--accent); }
.lc-cursor { stroke: var(--border-strong); stroke-width: 1; stroke-dasharray: 3 2; }
.lc-xaxis { display: flex; justify-content: space-between; font-size: 9.5px; color: var(--text-faint); font-family: var(--mono); padding: 0 2px 0 46px; margin-top: -2px; }
.lc-empty { height: 118px; display: flex; align-items: center; justify-content: center; color: var(--text-faint); font-size: 11.5px; }
.lc-tip {
  position: absolute; top: 2px; transform: translateX(-50%); pointer-events: none;
  background: var(--bg-card); border: 1px solid var(--border-strong); border-radius: 6px;
  padding: 3px 7px; font-size: 10px; color: var(--text-dim); display: flex; flex-direction: column;
  box-shadow: var(--shadow); white-space: nowrap; z-index: 2;
}
.lc-tip b { color: var(--text); font-family: var(--mono); font-size: 11px; }
</style>
