<template>
  <div class="ic-grid" :class="{ flat }">
    <section v-for="c in charts" :key="c.id" class="ic-card" :class="c.kind">
        <header class="ic-head">
          <span class="ic-title">{{ c.title }}</span>
          <span v-if="c.unit" class="ic-unit">{{ c.unit }}</span>
        </header>

        <!-- 环形：gauge = 单值占比 / donut = 分类占比 -->
        <div v-if="c.kind === 'gauge' || c.kind === 'donut'" class="ic-ring-row" :class="{ 'only-ring': c.kind === 'gauge' }">
          <div class="ic-ring-box">
            <svg class="ic-ring" viewBox="0 0 120 120" role="img" :aria-label="c.title">
              <circle class="ic-track" cx="60" cy="60" :r="R" :stroke-width="SW" fill="none" />
              <circle
                v-for="s in segments(c)"
                :key="s.key"
                class="ic-seg"
                cx="60" cy="60" :r="R" :stroke-width="SW"
                fill="none"
                :stroke="s.color"
                :stroke-dasharray="s.dash"
                :stroke-dashoffset="s.offset"
                transform="rotate(-90 60 60)"
              ><title>{{ s.label }}</title></circle>
            </svg>
            <div class="ic-ring-center">
              <div class="ic-ring-num" :class="c.kind === 'gauge' ? toneClass(gaugePct(c)) : ''">{{ centerText(c) }}</div>
              <div class="ic-ring-cap">{{ centerCaption(c) }}</div>
            </div>
          </div>

          <div v-if="c.kind === 'donut'" class="ic-legend">
            <div v-for="(it, i) in c.items" :key="it.label" class="ic-leg-row">
              <span class="ic-dot" :style="{ background: color(i) }"></span>
              <span class="ic-leg-label" :title="it.label">{{ it.label }}</span>
              <span class="ic-leg-val">{{ fmtNum(it.value) }}</span>
              <span class="ic-leg-pct">{{ sharePct(it.value, c.items) }}%</span>
            </div>
          </div>
        </div>

        <!-- 横向条形：使用率 / 容量 TOP N -->
        <div v-if="c.kind === 'bars'" class="ic-bars">
          <div
            v-for="it in c.items"
            :key="it.label"
            class="ic-bar-row"
            :title="`${it.label}：${fmtNum(it.value)}${c.unit || ''}${it.hint ? '（' + it.hint + '）' : ''}`"
          >
            <span class="ic-bar-label">{{ it.label }}</span>
            <span class="ic-bar-track">
              <span class="ic-bar-fill" :style="{ width: barWidth(it.value, c) + '%', background: barColor(it.value, c) }"></span>
            </span>
            <span class="ic-bar-val">{{ fmtNum(it.value) }}<i v-if="c.unit === '%'">%</i></span>
          </div>
          <div v-if="!c.items.length" class="ic-note">（无数据）</div>
          <div v-if="c.note" class="ic-note">{{ c.note }}</div>
        </div>

        <!-- 单条堆叠：内存组成等 -->
        <div v-if="c.kind === 'stack'" class="ic-stack">
          <div class="ic-stack-bar">
            <span
              v-for="(it, i) in c.items"
              :key="it.label"
              :style="{ width: sharePct(it.value, c.items) + '%', background: color(i) }"
              :title="`${it.label}：${fmtNum(it.value)}${c.unit || ''}（${sharePct(it.value, c.items)}%）`"
            ></span>
          </div>
          <div class="ic-legend">
            <div v-for="(it, i) in c.items" :key="it.label" class="ic-leg-row">
              <span class="ic-dot" :style="{ background: color(i) }"></span>
              <span class="ic-leg-label" :title="it.label">{{ it.label }}</span>
              <span class="ic-leg-val">{{ fmtNum(it.value) }}</span>
              <span class="ic-leg-pct">{{ sharePct(it.value, c.items) }}%</span>
            </div>
          </div>
        </div>

        <div v-if="c.caption" class="ic-caption">{{ c.caption }}</div>
        <div v-if="c.note && c.kind !== 'bars'" class="ic-note">{{ c.note }}</div>
      </section>
  </div>
</template>

<script setup lang="ts">
/** 图表渲染：纯 SVG + CSS，随主题变量切换，不引入图表库。
 *  flat=true 时去掉卡片边框/底色——用于嵌在「主题块」（图 + 明细同框）里。 */
import type { InfoChart, InfoChartItem } from './info-chart-types'

const props = withDefaults(defineProps<{ charts?: InfoChart[]; flat?: boolean }>(), {
  charts: () => [],
  flat: false
})
void props

/** 环形半径与线宽（viewBox 120×120） */
const R = 46
const SW = 13
const C = 2 * Math.PI * R

const PALETTE = ['var(--accent)', 'var(--green)', 'var(--yellow)', 'var(--purple)', 'var(--red)', '#0ea5e9']
function color(i: number): string {
  return PALETTE[i % PALETTE.length]
}

function sum(items: InfoChartItem[]): number {
  return items.reduce((s, it) => s + (Number(it.value) || 0), 0)
}

function sharePct(v: number, items: InfoChartItem[]): string {
  const total = sum(items)
  return total > 0 ? ((v / total) * 100).toFixed(1) : '0.0'
}

/** gauge 百分比（0-100） */
function gaugePct(c: InfoChart): number {
  const total = Number(c.total) || 0
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, ((Number(c.value) || 0) / total) * 100))
}

function toneClass(pct: number): string {
  return pct >= 90 ? 'tone-bad' : pct >= 80 ? 'tone-warn' : 'tone-ok'
}

interface Seg { key: string; label: string; color: string; dash: string; offset: number }

/** 环图分段：gauge 单段（按阈值取色），donut 多段（留 2px 视觉间隙） */
function segments(c: InfoChart): Seg[] {
  if (c.kind === 'gauge') {
    const pct = gaugePct(c)
    const len = (pct / 100) * C
    const col = pct >= 90 ? 'var(--red)' : pct >= 80 ? 'var(--yellow)' : 'var(--accent)'
    return [{ key: c.id, label: `${c.title} ${pct.toFixed(1)}%`, color: col, dash: `${len} ${C - len}`, offset: 0 }]
  }
  const total = sum(c.items)
  if (total <= 0) return []
  const out: Seg[] = []
  let start = 0
  c.items.forEach((it, i) => {
    const frac = (Number(it.value) || 0) / total
    const len = frac * C
    const gap = c.items.length > 1 ? Math.min(2, len / 2) : 0
    out.push({
      key: `${c.id}-${i}`,
      label: `${it.label}：${fmtNum(it.value)}（${(frac * 100).toFixed(1)}%）`,
      color: color(i),
      dash: `${Math.max(len - gap, 0)} ${C - Math.max(len - gap, 0)}`,
      offset: -(start + gap / 2)
    })
    start += len
  })
  return out
}

function centerText(c: InfoChart): string {
  if (c.kind === 'gauge') return `${gaugePct(c).toFixed(0)}%`
  return fmtNum(sum(c.items))
}

function centerCaption(c: InfoChart): string {
  if (c.kind === 'gauge') return c.unit === '%' ? '使用率' : '占比'
  return '总计'
}

/** 条形宽度：百分比类按 0-100 归一，其余按最大值归一 */
function barWidth(v: number, c: InfoChart): number {
  const n = Number(v) || 0
  if (c.unit === '%') return Math.min(100, Math.max(0, n))
  const max = Math.max(...c.items.map((it) => Number(it.value) || 0), 0)
  return max > 0 ? Math.min(100, (n / max) * 100) : 0
}

function barColor(v: number, c: InfoChart): string {
  if (c.unit === '%') {
    const n = Number(v) || 0
    return n >= 90 ? 'var(--red)' : n >= 80 ? 'var(--yellow)' : 'var(--accent)'
  }
  return 'var(--accent)'
}

/** 数值格式化：MB 大数转 GB，其余千分位 */
function fmtNum(v: any): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1024 && Number.isInteger(n)) return n.toLocaleString('zh-CN')
  return (Math.round(n * 10) / 10).toLocaleString('zh-CN')
}
</script>

<style scoped>
/* ---------- 图表卡片 ---------- */
.ic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(272px, 1fr));
  gap: 10px;
}
.ic-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px 11px;
  min-width: 0;
}
/* 嵌在主题块内：外框由主题块提供，图表只保留内容 */
.ic-grid.flat { grid-template-columns: 1fr; gap: 12px; }
.ic-grid.flat .ic-card { background: transparent; border: none; border-radius: 0; padding: 0; }
/* 环形图不要被拉满整行（图小、空白大），条形/堆叠才需要全宽 */
.ic-grid.flat .ic-card.donut,
.ic-grid.flat .ic-card.gauge { max-width: 430px; }
.ic-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.ic-title { font-size: 12px; font-weight: 700; color: var(--text); }
.ic-unit { font-size: 10.5px; color: var(--text-faint); margin-left: auto; }
.ic-caption { font-size: 11px; color: var(--text-faint); margin-top: 8px; line-height: 1.5; }
.ic-note { font-size: 11px; color: var(--text-faint); margin-top: 6px; line-height: 1.5; }

/* ---------- 环形 ---------- */
.ic-ring-row { display: flex; align-items: center; gap: 14px; }
.ic-ring-row.only-ring { justify-content: center; }
.ic-ring-box { position: relative; width: 108px; height: 108px; flex-shrink: 0; }
.ic-ring { width: 108px; height: 108px; display: block; }
.ic-track { stroke: var(--bg-card-hover); }
.ic-seg { transition: stroke-dasharray 0.4s ease, stroke-dashoffset 0.4s ease; }
.ic-ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  pointer-events: none;
}
.ic-ring-num { font-size: 18px; font-weight: 700; font-family: var(--mono); color: var(--text); }
.ic-ring-num.tone-ok { color: var(--text); }
.ic-ring-num.tone-warn { color: var(--yellow); }
.ic-ring-num.tone-bad { color: var(--red); }
.ic-ring-cap { font-size: 10px; color: var(--text-faint); }

/* ---------- 图例 ---------- */
.ic-legend { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.ic-leg-row {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
}
.ic-dot { width: 8px; height: 8px; border-radius: 2px; }
.ic-leg-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ic-leg-val { color: var(--text); font-family: var(--mono); font-size: 11.5px; }
.ic-leg-pct { color: var(--text-faint); font-family: var(--mono); font-size: 11px; min-width: 42px; text-align: right; }

/* ---------- 条形 ---------- */
.ic-bars { display: flex; flex-direction: column; gap: 6px; }
.ic-bar-row {
  display: grid;
  grid-template-columns: minmax(64px, 96px) minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}
.ic-bar-label { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ic-bar-track {
  height: 9px;
  border-radius: 5px;
  background: var(--bg-card-hover);
  overflow: hidden;
  display: block;
}
.ic-bar-fill {
  display: block;
  height: 100%;
  border-radius: 5px;
  transition: width 0.45s cubic-bezier(0.4, 0, 0.2, 1);
  min-width: 2px;
}
.ic-bar-val { color: var(--text); font-family: var(--mono); font-size: 11.5px; min-width: 56px; text-align: right; }
.ic-bar-val i { font-style: normal; color: var(--text-faint); margin-left: 1px; }

/* ---------- 堆叠 ---------- */
.ic-stack-bar {
  display: flex;
  height: 14px;
  border-radius: 7px;
  overflow: hidden;
  background: var(--bg-card-hover);
  margin-bottom: 9px;
}
.ic-stack-bar span { display: block; height: 100%; transition: width 0.45s ease; }
.ic-stack .ic-legend { gap: 5px; }
</style>
