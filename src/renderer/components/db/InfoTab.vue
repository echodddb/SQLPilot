<template>
  <div class="it-pane">
    <div class="it-bar">
      <span class="it-name">{{ connName }} · 数据库信息</span>
      <span style="flex: 1"></span>
      <button class="mini-btn" title="重新采集基本信息、图形化指标与活跃会话" @click="refreshAll">⟳ 刷新全部</button>
    </div>
    <div v-if="infoLoading" class="it-empty"><span class="spinner"></span> 采集数据库信息中…</div>
    <div v-else-if="infoError" class="it-empty err">✗ {{ infoError }}</div>
    <template v-else-if="info">
      <!-- 顶部 KPI：全库状态概览（数值，不是图，不与明细分组） -->
      <InfoKpis :kpis="info.kpis" />

      <!-- 无对应明细的概况图（连接状态 / 缓冲池命中率等）单独成卡片 -->
      <InfoCharts v-if="overviewCharts.length" :charts="overviewCharts" class="it-overview" />

      <!-- 主题块：每个块里图与它自己的明细同框 -->
      <InfoBlock v-for="b in blocks" :key="b.key" :block="b" />

      <!-- Oracle 活跃会话（交互块：列可选 + 刷新，列清单来自 GV$SESSION 实际结构） -->
      <div v-if="isOracle && as" class="it-block">
        <div class="as-head">
          <span class="it-title">{{ isObOracle ? '活跃会话（GV$OB_PROCESSLIST，按执行时长排序）' : '活跃会话（wait_class ≠ Idle 且 username 非空，按 last_call_et 排序）' }}</span>
          <span style="flex: 1"></span>
          <button class="mini-btn" title="勾选要显示的列（按当前库 GV$SESSION 实际列动态生成）" @click="as.open = !as.open">列 {{ as.open ? '▴' : '▾' }}</button>
          <button class="mini-btn" title="重新查询" @click="loadActiveSessions">⟳ 刷新</button>
        </div>
        <div v-if="as.open" class="as-cols">
          <label v-for="c in as.available" :key="c" class="as-col">
            <input type="checkbox" :checked="as.selected.includes(c)" @change="toggleAsCol(c)" />{{ c }}
          </label>
          <div class="as-col-hint">列清单取自当前数据库{{ isObOracle ? ' GV$OB_PROCESSLIST' : ' GV$SESSION' }} 的真实结构（各版本不同）；默认勾选常用排障列</div>
        </div>
        <div v-if="as.loading" class="it-meta" style="padding: 4px 0"><span class="spinner"></span> 查询中…</div>
        <div v-else-if="as.error" style="color: var(--red); font-size: 12.5px; padding: 4px 0">✗ {{ as.error }}</div>
        <template v-else>
          <div class="it-meta" style="padding: 4px 0">{{ as.rows.length }} 行 · {{ as.ms }}ms{{ as.note ? ' · ' + as.note : '' }}</div>
          <div class="it-table-scroll" style="max-height: 320px">
            <table class="result-table">
              <thead><tr><th class="rownum">#</th><th v-for="c in as.columns" :key="c">{{ c }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, i) in as.rows" :key="i">
                  <td class="rownum">{{ i + 1 }}</td>
                  <td v-for="(cell, j) in row" :key="j" :title="asFull(cell)">{{ asFmt(cell) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

      <!-- 采集诊断固定在页尾（权限不足等提示，不该夹在图与明细中间） -->
      <InfoBlock v-for="b in diagBlocks" :key="b.key" :block="b" />

      <div v-if="!info.sections.length && !info.tables.length && !info.charts?.length" class="it-empty">（未采集到信息，可能权限受限）</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { store } from '../../store'
import InfoCharts from './InfoCharts.vue'
import InfoKpis from './InfoKpis.vue'
import InfoBlock from './InfoBlock.vue'
import type { InfoBlock as Block, InfoChart, InfoKpi, InfoSection, InfoTable } from './info-chart-types'

const props = defineProps<{
  connId: string
  /** 激活已打开的信息 tab 时递增 → 重新采集（避免读到旧快照） */
  activateSeq?: number
}>()

const info = ref<{
  sections: InfoSection[]
  tables: InfoTable[]
  kpis: InfoKpi[]
  charts: InfoChart[]
} | null>(null)
const infoLoading = ref(false)
const infoError = ref('')
/** Oracle 活跃会话交互块；seq 为请求序号，防止乱序响应覆盖最新状态 */
const as = ref<{ available: string[]; selected: string[]; columns: string[]; rows: any[][]; ms: number; note: string; loading: boolean; error: string; open: boolean; seq: number } | null>(null)

const isOracle = computed(() => ['oracle', 'ob-oracle'].includes((store.cfg?.connections || []).find((c: any) => c.id === props.connId)?.type))
const isObOracle = computed(() => (store.cfg?.connections || []).find((c: any) => c.id === props.connId)?.type === 'ob-oracle')
const connName = computed(() => (store.cfg?.connections || []).find((c: any) => c.id === props.connId)?.name || props.connId)

/** 找不到同组明细的图（连接状态、缓冲池命中率等）单独成卡片展示 */
const overviewCharts = computed<InfoChart[]>(() => {
  const i = info.value
  if (!i) return []
  const grouped = new Set<string>()
  for (const s of i.sections) if (s.group) grouped.add(s.group)
  for (const t of i.tables) if (t.group) grouped.add(t.group)
  return i.charts.filter((c) => !c.group || !grouped.has(c.group))
})

/** 按 group 把图表与明细捏成块；块顺序 = 明细原有顺序（基础信息在前，诊断在后） */
const allBlocks = computed<Block[]>(() => {
  const i = info.value
  if (!i) return []
  const map = new Map<string, Block>()
  const list: Block[] = []
  const ensure = (key: string, title: string): Block => {
    let b = map.get(key)
    if (!b) {
      b = { key, title, charts: [], sections: [], tables: [], split: false, multi: false }
      map.set(key, b)
      list.push(b)
    }
    return b
  }
  // 先把明细挂进各自的块（未分组的明细自己成一块）
  for (const s of i.sections) ensure(s.group || 'sec:' + s.title, s.title).sections.push(s)
  for (const t of i.tables) ensure(t.group || 'tbl:' + t.title, t.title).tables.push(t)
  // 再把同组图表挂进去 —— 图不再集中到页面顶部，而是跟自己的明细待在一起
  for (const c of i.charts) {
    if (c.group && map.has(c.group)) map.get(c.group)!.charts.push(c)
  }
  for (const b of list) {
    const detailCount = b.sections.length + b.tables.length
    b.multi = detailCount > 1
    const onlyTable = b.tables.length === 1 && b.sections.length === 0
    // 列多的表格并排会被挤成横向滚动，仍按上下排
    b.split = b.charts.length === 1 && detailCount === 1 && (!onlyTable || b.tables[0].columns.length <= 5)
  }
  return list
})

const isDiag = (b: Block): boolean => b.title.includes('采集诊断')
const blocks = computed<Block[]>(() => allBlocks.value.filter((b) => !isDiag(b)))
const diagBlocks = computed<Block[]>(() => allBlocks.value.filter(isDiag))

async function loadInfo() {
  infoLoading.value = true
  infoError.value = ''
  const r = await window.sqlpilot.connInfo(props.connId)
  infoLoading.value = false
  if (r.ok) {
    info.value = {
      sections: r.sections || [],
      tables: r.tables || [],
      kpis: r.kpis || [],
      charts: r.charts || []
    }
  } else infoError.value = r.error || '获取信息失败'
}

/** 活跃会话：selected 为空时后端用默认列；seq 防止乱序响应覆盖最新状态（快速连续勾选列时） */
async function loadActiveSessions() {
  if (!as.value) return
  const mySeq = ++as.value.seq
  as.value.loading = true
  as.value.error = ''
  try {
    const r = await window.sqlpilot.activeSessions(props.connId, as.value.selected.length ? [...as.value.selected] : undefined)
    if (mySeq !== as.value.seq) return // 已有更新的请求在途，丢弃本次响应
    if (r.ok) {
      as.value.available = r.available || []
      as.value.columns = r.columns || []
      as.value.selected = r.columns || []
      as.value.rows = r.rows || []
      as.value.ms = r.ms || 0
      as.value.note = r.note || ''
    } else {
      as.value.error = r.error || '查询失败'
    }
  } catch (e: any) {
    if (mySeq === as.value.seq) as.value.error = String(e?.message || e)
  } finally {
    if (mySeq === as.value.seq) as.value.loading = false
  }
}

function toggleAsCol(col: string) {
  if (!as.value) return
  const i = as.value.selected.indexOf(col)
  if (i >= 0) {
    if (as.value.selected.length <= 1) return // 至少保留一列
    as.value.selected.splice(i, 1)
  } else {
    as.value.selected.push(col)
  }
  loadActiveSessions()
}

function refreshAll() {
  loadInfo()
  if (isOracle.value && as.value) loadActiveSessions()
}

function asFmt(v: any): string {
  if (v === null || v === undefined) return '∅'
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
function asFull(v: any): string {
  return v === null || v === undefined ? 'NULL' : asFmt(v)
}

onMounted(() => {
  loadInfo()
  if (isOracle.value) {
    as.value = { available: [], selected: [], columns: [], rows: [], ms: 0, note: '', loading: true, error: '', open: false, seq: 0 }
    loadActiveSessions()
  }
})

watch(() => props.activateSeq, () => refreshAll())
</script>

<style scoped>
.it-pane { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 14px 16px; }
.it-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.it-name { font-size: 12.5px; color: var(--text); font-weight: 600; }
.it-overview { margin-bottom: 10px; }
/* 概况图没有明细可配：卡片按内容宽度流动排列，避免一张图被拉伸占满整行 */
.it-overview.ic-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.it-overview :deep(.ic-card) { flex: 0 1 330px; min-width: 272px; }
.it-title { font-size: 12px; font-weight: 700; color: var(--accent); margin-bottom: 6px; letter-spacing: 0.5px; }
.it-meta { font-size: 11.5px; color: var(--text-faint); }
.it-empty { padding: 40px 20px; text-align: center; color: var(--text-faint); font-size: 13px; }
.it-empty.err { color: var(--red); }
.mini-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 1px 7px; cursor: pointer; flex-shrink: 0; font-family: inherit;
}
.mini-btn:hover { color: var(--accent); border-color: var(--accent); }
.rownum { color: var(--text-faint); background: var(--bg-card); position: sticky; left: 0; }

/* 活跃会话交互块沿用主题块外观（结构块由 InfoBlock 负责） */
.it-block {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-card);
  padding: 10px 12px 12px;
  margin-bottom: 10px;
  min-width: 0;
}
.it-table-scroll { max-height: 280px; overflow: auto; }

.as-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.as-head .it-title { margin-bottom: 0; }
.as-cols {
  border: 1px dashed var(--border-strong); border-radius: 8px; padding: 8px 10px;
  margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 4px 12px;
  max-height: 180px; overflow: auto;
}
.as-col { font-size: 11.5px; font-family: var(--mono); color: var(--text-dim); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.as-col:hover { color: var(--text); }
.as-col-hint { flex-basis: 100%; font-size: 11px; color: var(--text-faint); }
</style>
