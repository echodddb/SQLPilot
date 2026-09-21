<template>
  <div class="it-pane">
    <div class="it-bar">
      <span class="it-name">{{ connName }} · 数据库信息</span>
      <span style="flex: 1"></span>
      <button class="mini-btn" title="重新采集基本信息与活跃会话" @click="refreshAll">⟳ 刷新全部</button>
    </div>
    <div v-if="infoLoading" class="it-empty"><span class="spinner"></span> 采集数据库信息中…</div>
    <div v-else-if="infoError" class="it-empty err">✗ {{ infoError }}</div>
    <template v-else-if="info">
      <div v-for="sec in info.sections" :key="sec.title" class="it-sec">
        <div class="it-title">{{ sec.title }}</div>
        <div class="it-grid">
          <template v-for="kv in sec.rows" :key="kv.k">
            <div class="it-k">{{ kv.k }}</div>
            <div class="it-v">{{ kv.v }}</div>
          </template>
        </div>
      </div>
      <!-- Oracle 活跃会话（交互块：列可选 + 刷新，列清单来自 GV$SESSION 实际结构） -->
      <div v-if="isOracle && as" class="it-sec">
        <div class="as-head">
          <span class="it-title">活跃会话（wait_class ≠ Idle 且 username 非空，按 last_call_et 排序）</span>
          <span style="flex: 1"></span>
          <button class="mini-btn" title="勾选要显示的列（按当前库 GV$SESSION 实际列动态生成）" @click="as.open = !as.open">列 {{ as.open ? '▴' : '▾' }}</button>
          <button class="mini-btn" title="重新查询" @click="loadActiveSessions">⟳ 刷新</button>
        </div>
        <div v-if="as.open" class="as-cols">
          <label v-for="c in as.available" :key="c" class="as-col">
            <input type="checkbox" :checked="as.selected.includes(c)" @change="toggleAsCol(c)" />{{ c }}
          </label>
          <div class="as-col-hint">列清单取自当前数据库 GV$SESSION 的真实结构（各版本不同）；默认勾选常用排障列</div>
        </div>
        <div v-if="as.loading" class="it-meta" style="padding: 4px 0"><span class="spinner"></span> 查询中…</div>
        <div v-else-if="as.error" style="color: var(--red); font-size: 12.5px; padding: 4px 0">✗ {{ as.error }}</div>
        <template v-else>
          <div class="it-meta" style="padding: 4px 0">{{ as.rows.length }} 行 · {{ as.ms }}ms{{ as.note ? ' · ' + as.note : '' }}</div>
          <div style="max-height: 320px; overflow: auto">
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
      <div v-for="tb in info.tables" :key="tb.title" class="it-sec">
        <div class="it-title">{{ tb.title }}</div>
        <div style="max-height: 280px; overflow: auto">
          <table class="result-table">
            <thead><tr><th v-for="c in tb.columns" :key="c">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="(row, i) in tb.rows" :key="i">
                <td v-for="(cell, j) in row" :key="j">{{ cell === null || cell === undefined ? '—' : String(cell) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div v-if="!info.sections.length && !info.tables.length" class="it-empty">（未采集到信息，可能权限受限）</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { store } from '../../store'

const props = defineProps<{
  connId: string
  /** 激活已打开的信息 tab 时递增 → 重新采集（避免读到旧快照） */
  activateSeq?: number
}>()

const info = ref<{ sections: { title: string; rows: { k: string; v: string }[] }[]; tables: { title: string; columns: string[]; rows: any[][] }[] } | null>(null)
const infoLoading = ref(false)
const infoError = ref('')
/** Oracle 活跃会话交互块；seq 为请求序号，防止乱序响应覆盖最新状态 */
const as = ref<{ available: string[]; selected: string[]; columns: string[]; rows: any[][]; ms: number; note: string; loading: boolean; error: string; open: boolean; seq: number } | null>(null)

const isOracle = computed(() => (store.cfg?.connections || []).find((c: any) => c.id === props.connId)?.type === 'oracle')
const connName = computed(() => (store.cfg?.connections || []).find((c: any) => c.id === props.connId)?.name || props.connId)

async function loadInfo() {
  infoLoading.value = true
  infoError.value = ''
  const r = await window.sqlpilot.connInfo(props.connId)
  infoLoading.value = false
  if (r.ok) info.value = { sections: r.sections || [], tables: r.tables || [] }
  else infoError.value = r.error || '获取信息失败'
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
.it-pane { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 14px; }
.it-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.it-name { font-size: 12.5px; color: var(--text); font-weight: 600; }
.it-sec { margin-bottom: 16px; }
.it-title { font-size: 12px; font-weight: 700; color: var(--accent); margin-bottom: 6px; letter-spacing: 0.5px; }
.it-grid { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 4px 16px; font-size: 12.5px; }
.it-k { color: var(--text-faint); }
.it-v { color: var(--text); word-break: break-all; }
.it-meta { font-size: 11.5px; color: var(--text-faint); }
.it-empty { padding: 40px 20px; text-align: center; color: var(--text-faint); font-size: 13px; }
.it-empty.err { color: var(--red); }
.mini-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 1px 7px; cursor: pointer; flex-shrink: 0; font-family: inherit;
}
.mini-btn:hover { color: var(--accent); border-color: var(--accent); }
.rownum { color: var(--text-faint); background: var(--bg-card); position: sticky; left: 0; }
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
