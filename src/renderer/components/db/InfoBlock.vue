<template>
  <!-- 主题块：同一主题的图表与明细同框——表空间图挨着表空间表，会话图挨着会话明细 -->
  <section class="it-block">
    <header class="it-block-head">
      <span class="it-title">{{ block.title }}</span>
      <span style="flex: 1"></span>
      <span v-if="block.charts.length" class="it-tag">图表 + 明细</span>
    </header>
    <div class="it-block-body" :class="{ split: block.split }">
      <div v-if="block.charts.length" class="it-block-charts">
        <InfoCharts :charts="block.charts" flat />
      </div>
      <div v-if="block.sections.length || block.tables.length" class="it-block-detail">
        <div v-for="(sec, i) in block.sections" :key="'s' + i" class="it-sec">
          <!-- 单条明细时标题已由块头承担，避免重复 -->
          <div v-if="block.multi" class="it-title">{{ sec.title }}</div>
          <div class="it-grid">
            <template v-for="kv in sec.rows" :key="kv.k">
              <div class="it-k">{{ kv.k }}</div>
              <div class="it-v">{{ kv.v }}</div>
            </template>
          </div>
        </div>
        <div v-for="(tb, i) in block.tables" :key="'t' + i" class="it-sec">
          <div v-if="block.multi" class="it-title">{{ tb.title }}</div>
          <div v-if="!tb.rows.length" class="it-nodata">（无数据 — 可能当前账号无权查看该视图）</div>
          <div v-else class="it-table-scroll">
            <table class="result-table">
              <thead><tr><th v-for="c in tb.columns" :key="c">{{ c }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, ri) in tb.rows" :key="ri">
                  <td v-for="(cell, ci) in row" :key="ci">{{ fmtCell(cell) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import InfoCharts from './InfoCharts.vue'
import type { InfoBlock } from './info-chart-types'

defineProps<{ block: InfoBlock }>()

/** 明细表格单元格：Date 统一显示为本地时间，避免 String(Date) 的 "GMT+0800 (中国标准时间)" 噪音 */
function fmtCell(v: any): string {
  if (v === null || v === undefined) return '—'
  if (v instanceof Date) {
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
</script>

<style scoped>
.it-block {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-card);
  padding: 10px 12px 12px;
  margin-bottom: 10px;
  min-width: 0;
}
.it-block-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.it-title { font-size: 12px; font-weight: 700; color: var(--accent); margin-bottom: 6px; letter-spacing: 0.5px; }
.it-block-head .it-title { margin-bottom: 0; }
.it-tag {
  font-size: 10px;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 99px;
  padding: 1px 7px;
  flex-shrink: 0;
}
.it-block-body { min-width: 0; }
/* 单图 + 单明细：图在左、明细在右，一眼对应 */
.it-block-body.split {
  display: grid;
  grid-template-columns: minmax(248px, 320px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.it-block-body.split .it-block-charts {
  padding-right: 14px;
  border-right: 1px dashed var(--border);
  min-width: 0;
}
.it-block-charts { min-width: 0; }
.it-block-detail { min-width: 0; }
.it-block-detail .it-sec { margin-bottom: 10px; }
.it-block-detail .it-sec:last-child { margin-bottom: 0; }
.it-grid { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 4px 16px; font-size: 12.5px; }
.it-k { color: var(--text-faint); }
.it-v { color: var(--text); word-break: break-all; }
.it-nodata { font-size: 12px; color: var(--text-faint); padding: 4px 0; }
.it-table-scroll { max-height: 280px; overflow: auto; }
@media (max-width: 900px) {
  .it-block-body.split { grid-template-columns: 1fr; }
  .it-block-body.split .it-block-charts {
    padding-right: 0;
    border-right: none;
    border-bottom: 1px dashed var(--border);
    padding-bottom: 10px;
  }
}
</style>
