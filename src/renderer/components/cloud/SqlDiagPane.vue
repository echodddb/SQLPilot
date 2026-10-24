<template>
  <div class="sd">
    <!-- 工具条 -->
    <div class="sd-head">
      <select class="sel" :value="s.clusterId" title="选择集群" @change="onCluster">
        <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <select class="sel" :value="s.tenantId" title="选择租户（全部租户走集群级 TopSQL）" @change="onTenant">
        <option :value="0">全部租户</option>
        <option v-for="t in tenants" :key="t.id" :value="t.id">{{ t.name }}（{{ t.mode }}）</option>
      </select>
      <div class="ranges">
        <button v-for="r in RANGES" :key="r.key" class="rng" :class="{ active: s.rangeSec === r.seconds }" @click="setSqlRange(r.seconds)">
          {{ r.label }}
        </button>
      </div>
      <span class="spacer"></span>
      <input
        v-model="kw"
        class="search"
        placeholder="过滤 SQL 文本，回车搜索"
        spellcheck="false"
        @keyup.enter="doSearch"
      />
      <button v-if="s.search" class="tb" title="清空过滤" @click="clearSearch">✕</button>
      <button class="tb" :disabled="s.loading" @click="loadSqlDiag">
        <span :class="{ spin: s.loading }">⟳</span> 刷新
      </button>
    </div>

    <!-- KPI -->
    <div class="sd-kpis" data-src="sqlStats">
      <div class="kpi" :class="{ warn: kpi.slowSqlCount > 0 }" data-ai="sqldiag.stats:slow" data-ai-name="慢 SQL">
        <div class="kpi-label">慢 SQL</div>
        <div class="kpi-value">{{ kpi.slowSqlCount }}</div>
        <div class="kpi-sub">时间窗内超过阈值</div>
      </div>
      <div class="kpi" data-ai="sqldiag.stats:new" data-ai-name="新 SQL">
        <div class="kpi-label">新 SQL</div>
        <div class="kpi-value">{{ kpi.newSqlCount }}</div>
        <div class="kpi-sub">首次出现</div>
      </div>
      <div class="kpi" :class="{ bad: kpi.anomalySqlCount > 0 }" data-ai="sqldiag.stats:anomaly" data-ai-name="异常 SQL">
        <div class="kpi-label">异常 SQL</div>
        <div class="kpi-value">{{ kpi.anomalySqlCount }}</div>
        <div class="kpi-sub">执行报错/回滚</div>
      </div>
      <div class="kpi" :class="{ bad: kpi.highRiskSqlCount > 0 }" data-ai="sqldiag.stats:risky" data-ai-name="高风险 SQL">
        <div class="kpi-label">高风险 SQL</div>
        <div class="kpi-value">{{ kpi.highRiskSqlCount }}</div>
        <div class="kpi-sub">无索引全表扫描等</div>
      </div>
    </div>

    <!-- 排序 + 统计 -->
    <div class="sd-bar">
      <span class="bar-label">排序</span>
      <button v-for="o in SORTS" :key="o.key" class="sort" :class="{ active: s.sort === o.key }" @click="setSqlSort(o.key)">
        {{ o.label }}
      </button>
      <button class="sort" :class="{ active: s.hideInner }" title="隐藏 sys 租户与内部 SQL（定时任务、统计采集等）" @click="toggleHideInner">
        {{ s.hideInner ? '已隐藏 sys / 内部 SQL' : '显示 sys / 内部 SQL' }}
      </button>
      <span class="count">{{ rows.length }} 条{{ s.search ? `（过滤：${s.search}）` : '' }}</span>
      <span class="spacer"></span>
      <span v-if="s.updatedAt" class="upd">更新于 {{ relTime(new Date(s.updatedAt).toISOString()) }}</span>
    </div>

    <div v-if="s.error" class="err">{{ s.error }}</div>

    <!-- 表格 -->
    <div class="table-wrap" data-ai="sqldiag.top">
      <table class="tbl">
        <thead data-src="sqlTopSql">
          <tr>
            <th class="w-exp"></th>
            <th>SQL</th>
            <th>类型</th>
            <th>用户 / 库</th>
            <th class="r">执行次数</th>
            <th class="r">平均耗时</th>
            <th class="r">最大耗时</th>
            <th class="w-cpu">CPU 占比</th>
            <th class="r">失败</th>
            <th>服务器</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in rows" :key="rowKey(r)">
            <tr class="clickable" @click="toggle(rowKey(r), r)">
              <td class="w-exp"><span class="caret" :class="{ open: expanded === rowKey(r) }">▸</span></td>
              <td class="sql-cell">
                <div class="sql-text mono" :title="r.sqlTextShort.slice(0, 600)">{{ r.sqlTextShort || '—' }}</div>
                <div class="sql-id mono">{{ r.tenantName ? `${r.tenantName} · ` : '' }}{{ r.sqlId }}</div>
              </td>
              <td><span class="pill gray sm">{{ shortType(r.sqlType) }}</span></td>
              <td class="dim">{{ r.userName || '—' }}<span class="sep">@</span>{{ r.dbName || '—' }}</td>
              <td class="r mono">{{ fmtNum(r.executions) }}</td>
              <td class="r mono" :class="{ slow: r.avgElapsedTime > 100000 }">{{ fmtUs(r.avgElapsedTime) }}</td>
              <td class="r mono dim">{{ fmtUs(r.maxElapsedTime) }}</td>
              <td class="w-cpu">
                <div class="cpu-bar">
                  <div class="cpu-fill" :style="{ width: `${Math.min(100, r.cpuPercentage)}%` }"></div>
                </div>
                <span class="cpu-num mono">{{ r.cpuPercentage.toFixed(1) }}%</span>
              </td>
              <td class="r mono" :class="{ bad: r.failCount > 0 }">{{ r.failCount || '—' }}</td>
              <td class="mono dim">{{ r.serverIp || '—' }}</td>
            </tr>
            <tr v-if="expanded === rowKey(r)" class="detail-row">
              <td colspan="10">
                <div class="detail">
                  <div class="d-sec wide">
                    <div class="d-title">
                      完整 SQL
                      <span v-if="txt(r).loading" class="dim">读取中…</span>
                      <span v-else-if="txt(r).error" class="warn-t">{{ txt(r).error }}</span>
                    </div>
                    <pre class="full-sql mono">{{ txt(r).fulltext || r.sqlTextShort }}</pre>
                    <div v-if="txt(r).tables && txt(r).tables.length" class="d-codes">
                      <span class="tag-plain">涉及表</span>
                      <span v-for="tb in txt(r).tables" :key="tb" class="tag mono">{{ tb }}</span>
                    </div>
                  </div>
                  <div class="d-sec">
                    <div class="d-title">耗时与调度</div>
                    <div class="d-grid">
                      <span>平均 CPU<b>{{ fmtUs(r.avgCpuTime) }}</b></span>
                      <span>总耗时<b>{{ fmtUs(r.sumElapsedTime) }}</b></span>
                      <span>总 CPU<b>{{ fmtUs(r.sumCpuTimeMs) }}</b></span>
                      <span>QPS<b>{{ r.execPs.toFixed(2) }}</b></span>
                      <span>等待事件<b>{{ r.waitEvent || '—' }}</b></span>
                      <span>重试次数<b>{{ fmtNum(r.retryCount) }}</b></span>
                    </div>
                  </div>
                  <div class="d-sec">
                    <div class="d-title">计划与一致性</div>
                    <div class="d-grid">
                      <span>本地计划<b>{{ pct(r.localPlanPercentage) }}</b></span>
                      <span>远端计划<b>{{ pct(r.remotePlanPercentage) }}</b></span>
                      <span>分布式计划<b>{{ pct(r.distPlanPercentage) }}</b></span>
                      <span>未命中计划<b :class="r.missPlanPercentage > 0 ? 'warn-t' : ''">{{ pct(r.missPlanPercentage) }}</b></span>
                      <span>全表扫描<b :class="r.tableScanPercentage > 50 ? 'warn-t' : ''">{{ pct(r.tableScanPercentage) }}</b></span>
                      <span>强一致读<b>{{ pct(r.strongConsistencyPercentage) }}</b></span>
                    </div>
                  </div>
                  <div class="d-sec">
                    <div class="d-title">错误码</div>
                    <div class="d-codes">
                      <span v-for="(n, code) in hitCodes(r)" :key="code" class="code">
                        {{ code }}<b>{{ n }}</b>
                      </span>
                      <span v-if="!Object.keys(hitCodes(r)).length" class="dim">无错误码</span>
                      <span v-if="r.dynamicSql" class="tag">动态 SQL</span>
                      <span v-if="r.inner" class="tag">内部 SQL</span>
                    </div>
                  </div>
                  <div class="d-actions">
                    <button class="mini" @click.stop="copy(r.sqlId, 'sql_id')">复制 sql_id</button>
                    <button class="mini" @click.stop="copySql(r)">复制完整 SQL</button>
                  </div>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!rows.length">
            <td colspan="10" class="empty">{{ s.loading ? '正在读取 TopSQL…' : '该时间窗内没有 SQL 记录' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * SQL 诊断（TopSQL）：按 CPU / 耗时 / 执行次数找吃资源的语句。
 * 数据来自 OCP 的 /ob/clusters/{cid}[/tenants/{tid}]/topSql，排序与搜索在客户端做
 * （OCP 端点只支持 sqlText 服务端过滤，不支持排序与分页）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  cloud,
  loadSqlDiag,
  loadSqlText,
  setSqlCluster,
  setSqlRange,
  setSqlSearch,
  setSqlSort,
  setSqlTenant,
  sqlClusters,
  sqlStatSummary,
  sqlTenants
} from '../../cloud/state'
import { RANGES } from '../../cloud/metrics'
import { relTime } from '../../cloud/parts'
import { pushNotice } from '../../store'

const s = cloud.sqldiag
const clusters = computed(() => sqlClusters())
const tenants = computed(() => sqlTenants())
const kpi = computed(() => sqlStatSummary())

const SORTS = [
  { key: 'cpu', label: 'CPU 占比' },
  { key: 'avg', label: '平均耗时' },
  { key: 'max', label: '最大耗时' },
  { key: 'exec', label: '执行次数' }
] as const

const kw = ref(s.search)
const expanded = ref('')

const rows = computed(() => {
  const list = s.hideInner ? s.rows.filter((r) => r.tenantName !== 'sys' && !r.inner) : [...s.rows]
  const key = s.sort
  list.sort((a, b) => {
    if (key === 'avg') return b.avgElapsedTime - a.avgElapsedTime
    if (key === 'max') return b.maxElapsedTime - a.maxElapsedTime
    if (key === 'exec') return b.executions - a.executions
    return b.cpuPercentage - a.cpuPercentage
  })
  return list
})

watch(() => s.search, (v) => { kw.value = v })

function onCluster(e: Event): void {
  setSqlCluster(Number((e.target as HTMLSelectElement).value))
}
function onTenant(e: Event): void {
  setSqlTenant(Number((e.target as HTMLSelectElement).value))
}
function doSearch(): void {
  setSqlSearch(kw.value.trim())
}
function clearSearch(): void {
  kw.value = ''
  setSqlSearch('')
}
function toggle(key: string, r: CloudTopSqlRow): void {
  const next = expanded.value === key ? '' : key
  expanded.value = next
  // 展开时才去取完整 SQL（列表接口给的是截断文本）
  if (next) void loadSqlText(r)
}

/** 展开行对应的完整 SQL 状态（未加载时返回空对象） */
function txt(r: CloudTopSqlRow): Partial<CloudSqlTextInfo & { loading?: boolean; error?: string }> {
  return s.sqlText[`${r.tenantId}|${r.sqlId}`] || { loading: true }
}

async function copySql(r: CloudTopSqlRow): Promise<void> {
  const full = txt(r).fulltext
  await window.sqlpilot.writeClipboard(full || r.sqlTextShort)
  pushNotice(full ? '已复制完整 SQL' : '已复制截断 SQL（全文还在读取）')
}

function toggleHideInner(): void {
  s.hideInner = !s.hideInner
}

/**
 * 行唯一键：同一个 sqlId 会按 OBServer 拆成多行，集群级视图下同一 sqlId 还会跨租户，
 * 只用 sqlId+serverIp 会撞 key（Vue diff 错乱、DOM 残留），所以带上租户与用户。
 */
function rowKey(r: CloudTopSqlRow): string {
  return `${r.tenantId}|${r.sqlId}|${r.serverIp}|${r.userName}`
}

/** 微秒自适应显示（小于 10μs 保留两位小数，否则整数） */
function fmtUs(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—'
  if (v < 10) return `${v.toFixed(2)} μs`
  if (v < 1000) return `${v.toFixed(0)} μs`
  if (v < 1e6) return `${(v / 1000).toFixed(2)} ms`
  return `${(v / 1e6).toFixed(2)} s`
}
function fmtNum(v: number): string {
  return Number.isFinite(v) ? v.toLocaleString('zh-CN') : '—'
}
function pct(v: number): string {
  return `${(Number.isFinite(v) ? v : 0).toFixed(1)}%`
}
/** SELECT_FOR_UPDATE → SELECT，表格里只留动词 */
function shortType(t: string): string {
  return String(t || '').replace(/_FOR_UPDATE$/, '').replace('SELECT', 'SELECT') || '—'
}
function hitCodes(r: CloudTopSqlRow): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(r.retCodes || {})) if (v > 0) out[k] = v
  return out
}
async function copy(text: string, label: string): Promise<void> {
  if (!text) return
  await window.sqlpilot.writeClipboard(text)
  pushNotice(`已复制 ${label}`)
}

onMounted(() => { void loadSqlDiag() })
</script>

<style scoped>
.sd { display: flex; flex-direction: column; gap: 9px; }
.sd-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.sel {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text);
  font-family: inherit; font-size: 12px; padding: 4px 8px; outline: none; min-width: 150px; max-width: 220px;
}
.ranges { display: flex; gap: 3px; }
.rng {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 99px; padding: 2px 9px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.rng.active { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.spacer { flex: 1; }
.search {
  width: 230px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px;
  color: var(--text); font-family: inherit; font-size: 12px; padding: 5px 9px; outline: none;
}
.search:focus { border-color: var(--accent); }
.tb {
  display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  font-family: inherit; font-size: 11.5px; cursor: pointer;
}
.tb:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.spin { display: inline-block; animation: rot 1s linear infinite; }
@keyframes rot { to { transform: rotate(360deg); } }

.sd-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
.kpi {
  background: var(--bg-card); border: 1px solid var(--border); border-left: 2.5px solid var(--border-strong);
  border-radius: 10px; padding: 8px 12px 9px; min-width: 0;
}
.kpi.warn { border-left-color: var(--yellow); }
.kpi.warn .kpi-value { color: var(--yellow); }
.kpi.bad { border-left-color: var(--red); }
.kpi.bad .kpi-value { color: var(--red); }
.kpi-label { font-size: 11px; color: var(--text-faint); }
.kpi-value { font-size: 19px; font-weight: 700; font-family: var(--mono); margin-top: 1px; line-height: 1.15; }
.kpi-sub { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; }

.sd-bar { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.bar-label { font-size: 10.5px; color: var(--text-faint); }
.sort {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-faint);
  border-radius: 99px; padding: 2px 10px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.sort:hover { color: var(--text); border-color: var(--border-strong); }
.sort.active { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.count { font-size: 10.5px; color: var(--text-faint); margin-left: 4px; }
.upd { font-size: 10.5px; color: var(--text-faint); }
.err { font-size: 11.5px; color: var(--red); background: var(--red-dim); border: 1px solid color-mix(in srgb, var(--red) 35%, transparent); border-radius: 8px; padding: 7px 10px; }

.table-wrap { border: 1px solid var(--border); border-radius: 11px; overflow: auto; background: var(--bg-card); }
.tbl { width: 100%; min-width: 1080px; border-collapse: collapse; font-size: 12px; }
.tbl th {
  text-align: left; font-weight: 500; font-size: 10.5px; color: var(--text-faint); letter-spacing: 0.4px;
  padding: 8px 10px; background: var(--bg-input); border-bottom: 1px solid var(--border);
  white-space: nowrap; position: sticky; top: 0; z-index: 1;
}
.tbl td { padding: 7px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; vertical-align: middle; }
.tbl tbody tr:last-child td { border-bottom: none; }
.tbl tbody tr.clickable { cursor: pointer; }
.tbl tbody tr.clickable:hover { background: var(--bg-card-hover); }
.tbl .r { text-align: right; }
.w-exp { width: 22px; }
.w-cpu { width: 130px; }
.sql-cell { max-width: 420px; }
.sql-text { font-size: 11.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sql-id { font-size: 9.5px; color: var(--text-faint); margin-top: 1px; }
.slow { color: var(--yellow); }
.bad { color: var(--red); }
.caret { display: inline-block; font-size: 9px; color: var(--text-faint); transition: transform 0.15s ease; }
.caret.open { transform: rotate(90deg); color: var(--accent); }
.cpu-bar { height: 4px; border-radius: 99px; background: var(--bg-input); border: 1px solid var(--border); overflow: hidden; }
.cpu-fill { height: 100%; background: var(--accent); }
.cpu-num { font-size: 10px; color: var(--text-dim); }

.detail-row td { background: var(--bg-input); padding: 10px 14px 12px 34px !important; white-space: normal; }
.detail { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.d-sec.wide { grid-column: 1 / -1; }
.full-sql {
  margin: 0; padding: 8px 10px; border-radius: 7px; background: var(--bg-card);
  border: 1px solid var(--border); color: var(--text); font-size: 11px; line-height: 1.65;
  white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto;
}
.tag-plain { font-size: 10.5px; color: var(--text-faint); margin-right: 2px; }
.d-title { font-size: 10.5px; color: var(--text-faint); margin-bottom: 5px; }
.d-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
.d-grid span { font-size: 11px; color: var(--text-faint); display: flex; gap: 6px; }
.d-grid b { color: var(--text); font-weight: 550; font-family: var(--mono); }
.warn-t { color: var(--yellow); }
.d-codes { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.code { font-size: 10px; font-family: var(--mono); color: var(--red); background: var(--red-dim); border-radius: 4px; padding: 0 6px; }
.code b { margin-left: 3px; }
.tag { font-size: 10px; color: var(--text-dim); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; }
.d-actions { grid-column: 1 / -1; display: flex; gap: 6px; }
.mini {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 10.5px; padding: 2px 9px; cursor: pointer; font-family: inherit;
}
.mini:hover { color: var(--accent); border-color: var(--accent); }
.empty { text-align: center; color: var(--text-faint); padding: 26px !important; }
.pill { display: inline-block; font-size: 10.5px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); }
.pill.sm { font-size: 9.5px; padding: 0 6px; }
.pill.gray { color: var(--text-dim); }
.mono { font-family: var(--mono); }
.dim { color: var(--text-dim); }
.sep { color: var(--text-faint); margin: 0 2px; }
</style>
