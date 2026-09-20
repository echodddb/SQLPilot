<template>
  <div class="obj-wrap">
    <!-- ============ 左侧：连接 / Schema / 表树 ============ -->
    <div class="obj-side">
      <div class="obj-side-head">
        <input v-model="filterName" class="obj-filter" placeholder="筛选对象名…" />
        <select v-model="filterType" class="obj-type-sel" title="对象类型">
          <option value="">全部</option>
          <option value="TABLE">表</option>
          <option value="VIEW">视图</option>
        </select>
      </div>
      <div class="obj-tree">
        <template v-for="c in connections" :key="c.id">
          <div class="obj-node conn" @click="toggleConn(c.id)" :title="`${c.user}@${c.host}:${c.port}`">
            <span class="arrow">{{ tree[c.id]?.expanded ? '▾' : '▸' }}</span>
            <span>🗄</span>
            <span class="name">{{ c.name }}</span>
            <span class="sub">{{ TYPE_LABELS[c.type] || c.type }}</span>
          </div>
          <template v-if="tree[c.id]?.expanded">
            <div v-if="tree[c.id].loading" class="obj-node dim">加载中…</div>
            <div v-else-if="connErrors[c.id]" class="obj-node dim err" :title="connErrors[c.id]">✗ {{ connErrors[c.id].slice(0, 60) }}</div>
            <template v-else>
              <div v-for="s in tree[c.id].schemas || []" :key="s">
                <div class="obj-node schema" @click="toggleSchema(c.id, s)">
                  <span class="arrow">{{ tree[c.id].opened === s ? '▾' : '▸' }}</span>
                  <span>📂</span>
                  <span class="name">{{ s }}</span>
                  <span class="sub" v-if="tree[c.id].tables[s]?.length">{{ tree[c.id].tables[s].length }}</span>
                  <button v-if="tree[c.id].opened === s" class="obj-mini" title="刷新对象列表"
                    @click.stop="refreshTables(c.id, s)">⟳</button>
                </div>
                <template v-if="tree[c.id].opened === s && tree[c.id].tables[s]">
                  <div
                    v-for="tb in filteredTables(tree[c.id].tables[s])"
                    :key="tb.name"
                    class="obj-node table"
                    :title="`${s}.${tb.name}\n双击打开（数据 / 结构 / DDL）`"
                    @dblclick.stop="openTab(c.id, s, tb.name, c.type)"
                  >{{ tb.type === 'VIEW' ? '👁' : '▣' }} {{ tb.name }}</div>
                  <div v-if="!filteredTables(tree[c.id].tables[s]).length" class="obj-node dim">（无匹配对象）</div>
                </template>
              </div>
              <div v-if="!(tree[c.id].schemas || []).length" class="obj-node dim">（无可见 schema）</div>
            </template>
          </template>
        </template>
        <div v-if="!connections.length" class="obj-node dim">
          还没有数据库连接：左侧"数据库连接"区 ＋ 添加后即可浏览对象。
        </div>
      </div>
    </div>

    <!-- ============ 右侧：打开的对象标签页 ============ -->
    <div class="obj-main">
      <div class="obj-tabs" v-if="tabs.length">
        <div
          v-for="t in tabs"
          :key="t.key"
          class="obj-tab"
          :class="{ active: t.key === activeKey }"
          :title="`${t.connName} · ${t.schema}.${t.table}`"
          @click="activeKey = t.key"
        >
          {{ t.table }}
          <button class="icon-btn" style="padding: 0 3px; font-size: 11px" @click.stop="closeTab(t.key)">✕</button>
        </div>
        <span style="flex: 1"></span>
      </div>

      <div class="obj-body" v-if="cur">
        <!-- 子标签：数据 / 结构 / DDL -->
        <div class="obj-subtabs">
          <button class="obj-sub" :class="{ active: cur.sub === 'data' }" @click="cur.sub = 'data'">数据</button>
          <button class="obj-sub" :class="{ active: cur.sub === 'cols' }" @click="cur.sub = 'cols'">结构</button>
          <button class="obj-sub" :class="{ active: cur.sub === 'ddl' }" @click="cur.sub = 'ddl'">DDL</button>
          <span class="obj-target" :title="`${cur.connName} · ${cur.schema}.${cur.table}`">{{ cur.schema }}.{{ cur.table }}</span>
          <span style="flex: 1"></span>
          <template v-if="cur.sub === 'data'">
            <input
              v-model="cur.where"
              class="obj-where"
              placeholder="WHERE 条件（可选，如：created > SYSDATE - 1）"
              @keyup.enter="loadData(cur, 1)"
            />
            <button class="obj-mini" @click="loadData(cur, 1)">查询</button>
            <select v-model.number="cur.pageSize" class="obj-type-sel" title="每页行数" @change="loadData(cur, 1)">
              <option :value="50">50 行</option>
              <option :value="100">100 行</option>
              <option :value="200">200 行</option>
              <option :value="500">500 行</option>
            </select>
            <button class="obj-mini" title="重新加载当前页" @click="loadData(cur, cur.page)">⟳</button>
            <button class="obj-mini" title="把当前页结果复制为 TSV（可粘贴到 Excel）" @click="copyTsv(cur)">复制 TSV</button>
            <span v-if="cur.result" class="obj-meta">{{ cur.result.total }} 行 · {{ cur.result.ms }}ms</span>
          </template>
        </div>

        <!-- 数据页 -->
        <div class="obj-grid" v-if="cur.sub === 'data'">
          <table class="result-table" v-if="cur.result?.columns?.length">
            <thead>
              <tr>
                <th class="rownum">#</th>
                <th
                  v-for="col in cur.result.columns"
                  :key="col"
                  class="sortable"
                  :title="`点击按 ${col} 排序`"
                  @click="sortBy(cur, col)"
                >{{ col }}<span class="sort-mark" v-if="cur.orderBy === col">{{ cur.orderDir === 'desc' ? ' ▼' : ' ▲' }}</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in cur.result.rows" :key="i">
                <td class="rownum">{{ (cur.page - 1) * cur.pageSize + i + 1 }}</td>
                <td v-for="(cell, j) in row" :key="j" :title="full(cell)">{{ fmt(cell) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else-if="cur.loading" class="obj-empty"><span class="spinner"></span> 查询中…</div>
          <div v-else-if="cur.error" class="obj-empty err">✗ {{ cur.error }}</div>
          <div v-else class="obj-empty">（0 行）</div>
        </div>
        <div class="obj-pager" v-if="cur.sub === 'data' && cur.result">
          <button class="obj-mini" :disabled="cur.page <= 1" @click="loadData(cur, cur.page - 1)">‹ 上一页</button>
          <span>第 {{ cur.page }} / {{ totalPages(cur) }} 页</span>
          <button class="obj-mini" :disabled="cur.page >= totalPages(cur)" @click="loadData(cur, cur.page + 1)">下一页 ›</button>
        </div>

        <!-- 结构页 -->
        <div class="obj-grid" v-if="cur.sub === 'cols'">
          <div v-if="cur.colsLoading" class="obj-empty"><span class="spinner"></span> 加载中…</div>
          <div v-else-if="cur.colsError" class="obj-empty err">✗ {{ cur.colsError }}</div>
          <table class="result-table" v-else-if="cur.cols">
            <thead><tr><th>#</th><th>列名</th><th>类型</th><th>可空</th></tr></thead>
            <tbody>
              <tr v-for="(c2, i) in cur.cols.columns" :key="c2.name">
                <td class="rownum">{{ i + 1 }}</td>
                <td>{{ c2.name }}</td>
                <td>{{ c2.type }}</td>
                <td>{{ c2.nullable === 'Y' || c2.nullable === 'YES' ? '✓' : '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div class="obj-meta" style="padding: 6px 10px" v-if="cur.cols?.approxRows != null">
            近似行数：{{ Number(cur.cols.approxRows).toLocaleString() }}（来自统计信息）
          </div>
        </div>

        <!-- DDL 页 -->
        <div class="obj-grid" v-if="cur.sub === 'ddl'">
          <div v-if="cur.ddlLoading" class="obj-empty"><span class="spinner"></span> 加载中…</div>
          <div v-else-if="cur.ddlError" class="obj-empty err">✗ {{ cur.ddlError }}</div>
          <div v-else class="obj-ddl">
            <button class="obj-mini" @click="copyText(cur.ddl)">复制</button>
            <pre>{{ cur.ddl }}</pre>
          </div>
        </div>
      </div>

      <div v-else class="obj-empty big">
        双击左侧的表或视图打开浏览<br />
        <span class="dim">数据页支持分页 / 列排序 / WHERE 过滤 / 复制 TSV；结构页看列定义；DDL 页看建表语句</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { store, TYPE_LABELS } from '../store'

interface ObjTab {
  key: string
  connId: string
  connName: string
  connType: string
  schema: string
  table: string
  sub: 'data' | 'cols' | 'ddl'
  page: number
  pageSize: number
  where: string
  orderBy: string
  orderDir: 'asc' | 'desc'
  loading: boolean
  result: { columns: string[]; rows: any[][]; total: number; ms: number } | null
  error: string
  cols: { columns: { name: string; type: string; nullable: string }[]; approxRows?: number } | null
  colsLoading: boolean
  colsError: string
  ddl: string
  ddlLoading: boolean
  ddlError: string
}

const tree = store.tree
const connErrors = reactive<Record<string, string>>({})
const tabs = ref<ObjTab[]>([])
const activeKey = ref('')
const filterName = ref('')
const filterType = ref('')

const connections = computed(() => store.cfg?.connections || [])
const cur = computed(() => tabs.value.find((t) => t.key === activeKey.value))

// ---------- 左侧树（与侧边栏共享 store.tree 缓存） ----------
function ensureTree(id: string) {
  if (!tree[id]) {
    tree[id] = reactive({ expanded: false, schemas: undefined as any, loading: false, tables: {}, opened: null as any })
  }
  return tree[id]
}

async function toggleConn(id: string) {
  const t = ensureTree(id)
  t.expanded = !t.expanded
  if (t.expanded && !t.schemas) await loadSchemas(id)
}

async function loadSchemas(id: string) {
  const t = ensureTree(id)
  t.loading = true
  connErrors[id] = ''
  const r = await window.sqlpilot.getSchemas(id)
  t.schemas = r.ok ? r.schemas || [] : []
  t.loading = false
  if (!r.ok) connErrors[id] = r.error || '获取 schema 失败'
}

async function toggleSchema(connId: string, schema: string) {
  const t = ensureTree(connId)
  t.opened = t.opened === schema ? null : schema
  if (t.opened && !t.tables[schema]) await loadTables(connId, schema)
}

async function loadTables(connId: string, schema: string) {
  const t = ensureTree(connId)
  const r = await window.sqlpilot.getTables(connId, schema)
  t.tables[schema] = r.ok ? r.tables || [] : []
  if (!r.ok) connErrors[connId] = r.error || '获取对象列表失败'
}

async function refreshTables(connId: string, schema: string) {
  delete ensureTree(connId).tables[schema]
  await loadTables(connId, schema)
}

function filteredTables(list: any[]) {
  const n = filterName.value.trim().toLowerCase()
  return list.filter((t) => (!filterType.value || t.type === filterType.value) && (!n || t.name.toLowerCase().includes(n))).slice(0, 500)
}

// ---------- 右侧标签页 ----------
function openTab(connId: string, schema: string, table: string, connType: string) {
  const key = `${connId}::${schema}::${table}`
  const found = tabs.value.find((t) => t.key === key)
  if (found) {
    activeKey.value = key
  } else {
    const conn = connections.value.find((c: any) => c.id === connId)
    const tab: ObjTab = reactive({
      key, connId, connName: conn?.name || connId, connType,
      schema, table, sub: 'data',
      page: 1, pageSize: 50, where: '', orderBy: '', orderDir: 'asc',
      loading: false, result: null, error: '',
      cols: null, colsLoading: false, colsError: '',
      ddl: '', ddlLoading: false, ddlError: ''
    })
    tabs.value.push(tab)
    activeKey.value = key
    loadData(tab, 1)
  }
}

function closeTab(key: string) {
  const i = tabs.value.findIndex((t) => t.key === key)
  if (i >= 0) tabs.value.splice(i, 1)
  if (activeKey.value === key) activeKey.value = tabs.value[Math.max(0, i - 1)]?.key || ''
}

async function loadData(tab: ObjTab, page: number) {
  tab.page = page
  tab.loading = true
  tab.error = ''
  try {
    const r = await window.sqlpilot.objData({
      connId: tab.connId, schema: tab.schema, table: tab.table,
      page: tab.page, pageSize: tab.pageSize,
      where: tab.where, orderBy: tab.orderBy || undefined, orderDir: tab.orderDir
    })
    if (r.ok) {
      tab.result = { columns: r.columns || [], rows: r.rows || [], total: r.total || 0, ms: r.ms || 0 }
    } else {
      tab.result = null
      tab.error = r.error || '查询失败'
    }
  } catch (e: any) {
    tab.result = null
    tab.error = String(e?.message || e)
  } finally {
    tab.loading = false
  }
}

function sortBy(tab: ObjTab, col: string) {
  if (tab.orderBy !== col) {
    tab.orderBy = col
    tab.orderDir = 'asc'
  } else {
    tab.orderDir = tab.orderDir === 'asc' ? 'desc' : 'asc'
  }
  loadData(tab, 1)
}

function totalPages(tab: ObjTab): number {
  return Math.max(1, Math.ceil((tab.result?.total || 0) / tab.pageSize))
}

// 子标签懒加载：结构 / DDL 首次切入时取数
watch(
  () => (cur.value ? ([cur.value.key, cur.value.sub] as const) : null),
  async (v) => {
    if (!v) return
    const tab = cur.value
    const sub = v[1]
    if (!tab) return
    if (sub === 'cols' && !tab.cols && !tab.colsLoading) {
      tab.colsLoading = true
      const r = await window.sqlpilot.objDescribe(tab.connId, tab.schema, tab.table)
      if (r.ok) tab.cols = r.info || null
      else tab.colsError = r.error || '获取结构失败'
      tab.colsLoading = false
    } else if (sub === 'ddl' && !tab.ddl && !tab.ddlLoading) {
      tab.ddlLoading = true
      const r = await window.sqlpilot.objDdl(tab.connId, tab.schema, tab.table)
      if (r.ok) tab.ddl = r.ddl || ''
      else tab.ddlError = r.error || '获取 DDL 失败'
      tab.ddlLoading = false
    }
  }
)

// Sidebar 双击表 → 打开并让左侧树展开到对应位置
watch(
  () => store.objOpen,
  async (o) => {
    if (!o) return
    openTab(o.connId, o.schema, o.table, '')
    const t = ensureTree(o.connId)
    t.expanded = true
    if (!t.schemas) await loadSchemas(o.connId)
    if (!t.tables[o.schema]) await loadTables(o.connId, o.schema)
    t.opened = o.schema
  }
)

// ---------- 单元格格式化 ----------
function fmt(v: any): string {
  if (v === null || v === undefined) return '∅'
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
function full(v: any): string {
  if (v === null || v === undefined) return 'NULL'
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 23)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function copyText(text: string) {
  window.sqlpilot.writeClipboard(text)
}

function copyTsv(tab: ObjTab) {
  if (!tab.result) return
  const lines = [tab.result.columns.join('\t')]
  for (const row of tab.result.rows) lines.push(row.map((c) => (c === null || c === undefined ? '' : c instanceof Date ? c.toISOString() : typeof c === 'object' ? JSON.stringify(c) : String(c))).join('\t'))
  copyText(lines.join('\n'))
}
</script>

<style scoped>
.obj-wrap { display: flex; height: 100%; min-height: 0; }
.obj-side {
  width: 280px; flex-shrink: 0; border-right: 1px solid var(--border);
  display: flex; flex-direction: column; background: var(--bg-side);
}
.obj-side-head { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.obj-filter { flex: 1; min-width: 0; font-size: 12px; }
.obj-type-sel { font-size: 12px; padding: 2px 6px; background: var(--bg-input); color: var(--text-dim); border-radius: 7px; }
.obj-tree { flex: 1; overflow-y: auto; padding: 4px 0 12px; }

.obj-node {
  display: flex; align-items: center; gap: 7px;
  padding: 4px 10px; font-size: 12.5px; color: var(--text-dim);
  cursor: pointer; user-select: none;
}
.obj-node:hover { background: var(--bg-card-hover); color: var(--text); }
.obj-node .arrow { width: 12px; flex-shrink: 0; color: var(--text-faint); }
.obj-node .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.obj-node .sub { font-size: 10.5px; color: var(--text-faint); flex-shrink: 0; }
.obj-node.conn { font-weight: 600; color: var(--text); }
.obj-node.conn .sub { background: var(--accent-dim); color: var(--accent); padding: 1px 6px; border-radius: 99px; }
.obj-node.schema { padding-left: 22px; }
.obj-node.table { padding-left: 44px; font-family: var(--mono); font-size: 12px; }
.obj-node.dim { color: var(--text-faint); cursor: default; padding-left: 24px; }
.obj-node.dim.err { color: var(--red); }
.obj-mini {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 1px 7px; cursor: pointer; flex-shrink: 0; font-family: inherit;
}
.obj-mini:hover { color: var(--accent); border-color: var(--accent); }
.obj-mini:disabled { opacity: .45; cursor: default; }

.obj-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.obj-tabs {
  display: flex; align-items: center; gap: 4px; padding: 5px 8px 0;
  border-bottom: 1px solid var(--border); background: var(--bg-input);
  overflow-x: auto; flex-shrink: 0;
}
.obj-tab {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 12px; border: 1px solid var(--border); border-bottom: none;
  border-radius: 7px 7px 0 0; cursor: pointer; font-size: 12px;
  color: var(--text-dim); background: var(--bg-card); max-width: 220px;
  white-space: nowrap; overflow: hidden;
}
.obj-tab.active { color: var(--text); background: var(--bg); border-color: var(--border-strong); }

.obj-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.obj-subtabs {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap;
}
.obj-sub {
  border: none; background: transparent; color: var(--text-dim); font-size: 12.5px;
  padding: 4px 12px; border-radius: 7px; cursor: pointer; font-family: inherit;
}
.obj-sub:hover { color: var(--text); background: var(--bg-card-hover); }
.obj-sub.active { color: var(--accent); background: var(--accent-dim); font-weight: 600; }
.obj-target { font-family: var(--mono); font-size: 11.5px; color: var(--text-faint); margin-left: 8px; }
.obj-where { width: 300px; max-width: 40vw; font-size: 12px; font-family: var(--mono); }
.obj-meta { font-size: 11.5px; color: var(--text-faint); }

.obj-grid { flex: 1; min-height: 0; overflow: auto; padding: 6px 10px; position: relative; }
.obj-grid .result-table { min-width: 100%; }
.rownum { color: var(--text-faint); background: var(--bg-card); position: sticky; left: 0; }
th.sortable { cursor: pointer; }
th.sortable:hover { color: var(--accent); }
.sort-mark { color: var(--accent); }

.obj-pager {
  display: flex; align-items: center; gap: 12px; padding: 5px 12px;
  border-top: 1px solid var(--border); font-size: 12px; color: var(--text-dim); flex-shrink: 0;
}
.obj-empty { padding: 40px 20px; text-align: center; color: var(--text-faint); font-size: 13px; line-height: 2; }
.obj-empty.big { padding-top: 12vh; }
.obj-empty.dim, .dim { color: var(--text-faint); font-size: 12px; }
.obj-empty.err { color: var(--red); white-space: pre-wrap; word-break: break-all; }
.obj-ddl { position: relative; height: 100%; }
.obj-ddl .obj-mini { position: absolute; top: 6px; right: 14px; z-index: 2; }
.obj-ddl pre { margin: 0; font-size: 12.5px; }
</style>
