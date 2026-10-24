<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">SQL 诊断</h4>
      <select v-model.number="rangeH" class="tp-select" @change="load">
        <option :value="0.25">近 15 分钟</option>
        <option :value="1">近 1 小时</option>
        <option :value="6">近 6 小时</option>
        <option :value="12">近 12 小时</option>
        <option :value="24">近 24 小时</option>
      </select>
      <input v-model="kw" class="tp-input tp-search" placeholder="按 SQL 文本过滤（服务端）" spellcheck="false" @keyup.enter="load" />
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>

    <nav class="subtabs">
      <button v-for="k in KINDS" :key="k.key" class="subtab" :class="{ on: kind === k.key }" @click="switchKind(k.key)">
        {{ k.label }}
      </button>
    </nav>

    <div v-if="err" class="tp-err">{{ err }}</div>
    <div v-if="hint" class="tp-warn">{{ hint }}</div>

    <div class="split">
      <div class="tp-tbl-wrap tp-scroll-y" data-src="tnSql" :data-tenant="d.tenant.name" :data-detail="`${kindLabel} ${rows.length} 条|时间窗 近 ${rangeH} 小时`">
        <table class="tp-tbl">
          <thead>
            <tr>
              <th>SQL</th>
              <th class="r sortable" @click="setSort('exec')">执行次数{{ sortIcon('exec') }}</th>
              <th class="r sortable" @click="setSort('avg')">平均耗时{{ sortIcon('avg') }}</th>
              <th class="r sortable" @click="setSort('max')">最大耗时{{ sortIcon('max') }}</th>
              <th class="r sortable" @click="setSort('cpu')">CPU 占比{{ sortIcon('cpu') }}</th>
              <th class="r">失败</th>
              <th>用户 / 库</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in sorted" :key="`${r.sqlId}-${r.serverIp}-${i}`" class="clickable" :class="{ on: active === i }" @click="pick(r, i)">
              <td class="ell tp-mono" :title="r.sqlTextShort">{{ r.sqlType ? `[${r.sqlType}] ` : '' }}{{ r.sqlTextShort || '—' }}</td>
              <td class="r tp-mono">{{ r.executions.toLocaleString() }}</td>
              <td class="r tp-mono">{{ us(r.avgElapsedTime) }}</td>
              <td class="r tp-mono">{{ us(r.maxElapsedTime) }}</td>
              <td class="r tp-mono" :class="{ hot: r.cpuPercentage >= 50 }">{{ r.cpuPercentage.toFixed(1) }}%</td>
              <td class="r tp-mono" :class="{ hot: r.failCount > 0 }">{{ r.failCount }}</td>
              <td class="tp-dim" style="font-size:10.5px">{{ r.userName || '—' }} / {{ r.dbName || '—' }}</td>
            </tr>
            <tr v-if="!sorted.length"><td colspan="7" class="tp-empty">{{ loading ? '读取中…' : '该时间窗内没有数据' }}</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="picked" class="detail">
        <div class="tp-bar">
          <h4 class="tp-h">详情</h4>
          <span class="sp"></span>
          <button class="tp-btn sm" @click="copyText">复制 SQL</button>
        </div>
        <div class="tp-kv-grid">
          <div class="tp-kv"><span>SQL ID</span><b class="tp-mono">{{ picked.sqlId }}</b></div>
          <div class="tp-kv"><span>执行次数</span><b class="tp-mono">{{ picked.executions.toLocaleString() }}</b></div>
          <div class="tp-kv"><span>平均 / 最大</span><b class="tp-mono">{{ us(picked.avgElapsedTime) }} / {{ us(picked.maxElapsedTime) }}</b></div>
          <div class="tp-kv"><span>CPU 占比</span><b class="tp-mono">{{ picked.cpuPercentage.toFixed(1) }}%</b></div>
          <div class="tp-kv"><span>远端执行占比</span><b class="tp-mono">{{ picked.remotePlanPercentage.toFixed(1) }}%</b></div>
          <div class="tp-kv"><span>未命中计划</span><b class="tp-mono">{{ picked.missPlanPercentage.toFixed(1) }}%</b></div>
          <div class="tp-kv"><span>等待事件</span><b>{{ picked.waitEvent || '—' }}</b></div>
          <div class="tp-kv"><span>失败次数</span><b class="tp-mono">{{ picked.failCount }}</b></div>
        </div>

        <div class="tp-bar">
          <span class="tp-h" style="font-size:11.5px">完整 SQL</span>
          <span class="sp"></span>
          <button class="tp-btn sm" :disabled="textLoading" @click="loadText">{{ textLoading ? '读取中…' : '取完整文本' }}</button>
        </div>
        <pre class="tp-code">{{ fullText || picked.sqlTextShort || '（点「取完整文本」加载）' }}</pre>
        <div v-if="tables.length" class="tp-bar">
          <span class="tp-note">涉及表：</span>
          <span v-for="tb in tables" :key="tb" class="tp-chip tp-mono">{{ tb }}</span>
        </div>

        <div class="tp-bar" style="margin-top:2px">
          <span class="tp-h" style="font-size:11.5px">诊断建议</span>
          <span class="sp"></span>
          <button class="tp-btn sm" :disabled="diagLoading" @click="loadDiag">{{ diagLoading ? '分析中…' : '分析' }}</button>
        </div>
        <div v-if="diagErr" class="tp-err">{{ diagErr }}</div>
        <div v-if="diag" class="diag">
          <div v-if="diag.bottleneck" class="tp-note">结论：{{ diag.bottleneck }}</div>
          <div v-for="(a, i) in diag.advices" :key="i" class="tp-card" style="padding:7px 9px">
            <div class="tp-bar">
              <span class="tp-chip" :style="lvlStyle(a.level)">{{ a.level }}</span>
              <b style="font-size:11.5px">{{ a.title }}</b>
            </div>
            <div class="tp-note" style="color:var(--text-dim)">{{ a.content }}</div>
          </div>
          <div v-if="!diag.advices.length && !diag.bottleneck" class="tp-note">OCP 未给出建议（该 SQL 可能无异常特征）。</div>
        </div>
      </div>
    </div>

    <!-- Outline -->
    <div class="tp-bar">
      <h4 class="tp-h">执行计划绑定（Outline） <span class="cnt">{{ outlines.length }}</span></h4>
      <span class="sp"></span>
      <button class="tp-btn sm" :disabled="outlineLoading" @click="loadOutlines">{{ outlineLoading ? '读取中…' : '刷新' }}</button>
    </div>
    <div class="tp-tbl-wrap">
      <table class="tp-tbl">
        <thead><tr><th>名称</th><th>SQL ID</th><th>库</th><th>创建时间</th><th>内容</th></tr></thead>
        <tbody>
          <tr v-for="o in outlines" :key="o.id">
            <td class="tp-mono">{{ o.outlineName || '—' }}</td>
            <td class="tp-mono tp-dim">{{ o.sqlId || '—' }}</td>
            <td>{{ o.dbName || '—' }}</td>
            <td class="tp-dim">{{ o.createTime || '—' }}</td>
            <td class="ell tp-mono tp-dim" :title="o.outlineContent">{{ o.outlineContent || '—' }}</td>
          </tr>
          <tr v-if="!outlines.length"><td colspan="5" class="tp-empty">{{ outlineLoading ? '读取中…' : '未配置 Outline' }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 租户级 SQL 诊断：TopSQL / 慢SQL / 新增SQL / 高危SQL / 并行SQL + 单条诊断建议 + Outline。
 * 时间窗上限 24h：parallelSql 服务端限制 ≤ PT24H，统一按 24h 封顶避免 400。
 * 所有耗时字段是微秒（含名字带 Ms 的 sumCpuTimeMs）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { pushNotice } from '../../../store'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

type Kind = 'top' | 'slow' | 'new' | 'risk' | 'parallel'
const KINDS: { key: Kind; label: string }[] = [
  { key: 'top', label: 'TopSQL' },
  { key: 'slow', label: '慢 SQL' },
  { key: 'new', label: '新增 SQL' },
  { key: 'risk', label: '高危 SQL' },
  { key: 'parallel', label: '并行 SQL' }
]

const kind = ref<Kind>('top')
const rangeH = ref(1)
const kw = ref('')
const rows = ref<CloudTopSqlRow[]>([])
const loading = ref(false)
const err = ref('')
const hint = ref('')
const sort = ref<'cpu' | 'avg' | 'max' | 'exec'>('cpu')

const active = ref(-1)
const picked = ref<CloudTopSqlRow | null>(null)
const fullText = ref('')
const tables = ref<string[]>([])
const textLoading = ref(false)

const diag = ref<CloudTenantSqlDiagnosis | null>(null)
const diagLoading = ref(false)
const diagErr = ref('')

const outlines = ref<CloudTenantOutline[]>([])
const outlineLoading = ref(false)

const kindLabel = computed(() => KINDS.find((k) => k.key === kind.value)?.label || '')

const sorted = computed(() => {
  const list = [...rows.value]
  const k = sort.value
  list.sort((a, b) =>
    k === 'exec' ? b.executions - a.executions
      : k === 'avg' ? b.avgElapsedTime - a.avgElapsedTime
        : k === 'max' ? b.maxElapsedTime - a.maxElapsedTime
          : b.cpuPercentage - a.cpuPercentage
  )
  return list
})

function sortIcon(k: typeof sort.value): string {
  return sort.value === k ? ' ↓' : ''
}
function setSort(k: typeof sort.value): void {
  sort.value = k
}

/** 微秒 → 人类可读 */
function us(v: number): string {
  if (!v) return '0'
  if (v < 1000) return `${v.toFixed(0)}μs`
  if (v < 1e6) return `${(v / 1000).toFixed(1)}ms`
  return `${(v / 1e6).toFixed(2)}s`
}
function lvlStyle(level: string): string {
  const l = String(level).toLowerCase()
  if (/error|high|fatal|严重/.test(l)) return 'color:var(--red);border-color:var(--red)'
  if (/warn|medium|中/.test(l)) return 'color:var(--yellow);border-color:var(--yellow)'
  return ''
}

function timeWindow(): { from: number; to: number } {
  const to = Date.now()
  return { from: to - rangeH.value * 3600e3, to }
}

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  hint.value = ''
  active.value = -1
  picked.value = null
  fullText.value = ''
  tables.value = []
  diag.value = null
  try {
    const t = d.value.tenant
    const { from, to } = timeWindow()
    let r: CloudApi<CloudTopSqlRow[]>
    if (kind.value === 'top') r = await window.sqlpilot.cloudTopSql(cloud.activeId, t.clusterId, t.id, { from, to, sqlText: kw.value.trim() || undefined })
    else if (kind.value === 'slow') r = await window.sqlpilot.cloudSlowSql(cloud.activeId, t.clusterId, t.id, { from, to })
    else if (kind.value === 'new') r = await window.sqlpilot.cloudTenantNewSql(cloud.activeId, t.clusterId, t.id, from, to)
    else if (kind.value === 'risk') r = await window.sqlpilot.cloudTenantHighRiskSql(cloud.activeId, t.clusterId, t.id, from, to)
    else r = await window.sqlpilot.cloudTenantParallelSql(cloud.activeId, t.clusterId, t.id, from, to)

    if (!r.ok) {
      err.value = r.error || '读取失败'
      rows.value = []
      return
    }
    rows.value = r.data || []
    if (kw.value.trim() && kind.value !== 'top') hint.value = '文本过滤只在 TopSQL 由服务端生效，其余类型请在本地面筛。'
    if (kind.value === 'parallel' && rangeH.value > 24) hint.value = '并行 SQL 服务端限制时间窗 ≤ 24h。'
  } finally {
    loading.value = false
  }
}

function switchKind(k: Kind): void {
  if (kind.value === k) return
  kind.value = k
  load()
}

async function pick(r: CloudTopSqlRow, i: number): Promise<void> {
  active.value = i
  picked.value = r
  fullText.value = ''
  tables.value = []
  diag.value = null
  diagErr.value = ''
}

async function loadText(): Promise<void> {
  const p = picked.value
  if (!p) return
  textLoading.value = true
  try {
    const t = d.value.tenant
    const { from, to } = timeWindow()
    const r = await window.sqlpilot.cloudSqlText(cloud.activeId, t.clusterId, t.id, p.sqlId, { from, to })
    if (!r.ok) { err.value = r.error || '取完整 SQL 失败'; return }
    fullText.value = r.data?.fulltext || r.data?.statement || ''
    tables.value = r.data?.tables || []
  } finally {
    textLoading.value = false
  }
}

async function loadDiag(): Promise<void> {
  const p = picked.value
  if (!p) return
  diagLoading.value = true
  diagErr.value = ''
  try {
    const t = d.value.tenant
    const { from, to } = timeWindow()
    const r = await window.sqlpilot.cloudTenantSqlDiagnosis(cloud.activeId, t.clusterId, t.id, p.sqlId, from, to)
    if (!r.ok) { diagErr.value = r.error || '诊断失败'; return }
    diag.value = r.data || { advices: [], bottleneck: '' }
  } finally {
    diagLoading.value = false
  }
}

async function loadOutlines(): Promise<void> {
  outlineLoading.value = true
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantOutlines(cloud.activeId, t.clusterId, t.id)
    outlines.value = r.ok ? r.data || [] : []
  } finally {
    outlineLoading.value = false
  }
}

async function copyText(): Promise<void> {
  const text = fullText.value || picked.value?.sqlTextShort || ''
  if (!text) return
  await window.sqlpilot.writeClipboard(text)
  pushNotice('已复制 SQL')
}

onMounted(async () => {
  await load()
  await loadOutlines()
})
watch(() => props.reloadToken, async () => {
  await load()
  await loadOutlines()
})
</script>

<style scoped>
.subtabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-top: -3px; }
.subtab {
  border: none; background: transparent; color: var(--text-faint); font-size: 11.5px; font-family: inherit;
  padding: 5px 10px; cursor: pointer; border-bottom: 2px solid transparent;
}
.subtab.on { color: var(--accent); border-bottom-color: var(--accent); }
.subtab:hover { color: var(--text); }
.split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 11px; align-items: start; }
/* 宽屏把详情并到右侧，避免详情被压在长表格下方 */
@media (min-width: 1180px) {
  .split { grid-template-columns: minmax(0, 1fr) minmax(360px, 470px); }
  .split .detail { border-top: none; border-left: 1px dashed var(--border); padding-top: 0; padding-left: 11px; }
}
.detail { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--border); padding-top: 9px; }
.tp-tbl th.sortable { cursor: pointer; user-select: none; }
.tp-tbl th.sortable:hover { color: var(--accent); }
.hot { color: var(--yellow); }
.diag { display: flex; flex-direction: column; gap: 6px; }
</style>
