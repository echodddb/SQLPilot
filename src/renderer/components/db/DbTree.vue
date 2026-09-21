<template>
  <div class="dbt-wrap">
    <div class="dbt-head">
      <input v-model="filterName" class="dbt-filter" placeholder="筛选对象名…" />
      <select v-model="filterType" class="dbt-type-sel" title="对象类型">
        <option value="">全部</option>
        <option value="TABLE">表</option>
        <option value="VIEW">视图</option>
      </select>
    </div>
    <div class="dbt-tree">
      <template v-for="c in connections" :key="c.id">
        <div class="dbt-node conn" @click="toggleConn(c.id)" :title="`${c.user}@${c.host}:${c.port}`">
          <span class="arrow">{{ tree[c.id]?.expanded ? '▾' : '▸' }}</span>
          <span>🗄</span>
          <span class="name">{{ c.name }}</span>
          <span class="sub">{{ TYPE_LABELS[c.type] || c.type }}</span>
          <button class="mini-btn" title="对该连接新建查询窗口" @click.stop="emit('new-query', c.id)">＋</button>
          <button class="mini-btn" title="查看数据库信息（版本 / 会话 / 存储 / 活跃会话）" @click.stop="emit('open-info', c.id)">ℹ</button>
          <button class="mini-btn" title="刷新 schema 列表（绕过缓存强制重读）" @click.stop="refreshSchemas(c.id)">⟳</button>
        </div>
        <template v-if="tree[c.id]?.expanded">
          <div v-if="tree[c.id].loading" class="dbt-node dim">加载中…</div>
          <div v-else-if="connErrors[c.id]" class="dbt-node dim err" :title="connErrors[c.id]">✗ {{ connErrors[c.id].slice(0, 60) }}</div>
          <template v-else>
            <div v-for="s in tree[c.id].schemas || []" :key="s">
              <div class="dbt-node schema" @click="toggleSchema(c.id, s)">
                <span class="arrow">{{ tree[c.id].opened === s ? '▾' : '▸' }}</span>
                <span>📂</span>
                <span class="name">{{ s }}</span>
                <span class="sub" v-if="tree[c.id].tables[s]?.length">{{ tree[c.id].tables[s].length }}</span>
                <button v-if="tree[c.id].opened === s" class="mini-btn" title="刷新对象列表（绕过缓存）"
                  @click.stop="refreshTables(c.id, s)">⟳</button>
              </div>
              <template v-if="tree[c.id].opened === s && tree[c.id].tables[s]">
                <div
                  v-for="tb in filteredTables(tree[c.id].tables[s])"
                  :key="tb.name"
                  class="dbt-node table"
                  :title="`${s}.${tb.name}\n双击打开（数据 / 结构 / DDL）`"
                  @dblclick.stop="emit('open-table', c.id, s, tb.name)"
                >{{ tb.type === 'VIEW' ? '👁' : '▣' }} {{ tb.name }}</div>
                <div v-if="!filteredTables(tree[c.id].tables[s]).length" class="dbt-node dim">（无匹配对象）</div>
              </template>
            </div>
            <div v-if="!(tree[c.id].schemas || []).length" class="dbt-node dim">（无可见 schema）</div>
          </template>
        </template>
      </template>
      <div v-if="!connections.length" class="dbt-node dim">
        还没有数据库连接：左侧"数据库连接"区 ＋ 添加后即可浏览对象。
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { store, TYPE_LABELS } from '../../store'

const emit = defineEmits<{
  (e: 'open-table', connId: string, schema: string, table: string): void
  (e: 'new-query', connId: string): void
  (e: 'open-info', connId: string): void
}>()

const tree = store.tree
const connErrors = reactive<Record<string, string>>({})
const filterName = ref('')
const filterType = ref('')

const connections = computed(() => store.cfg?.connections || [])

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

async function refreshSchemas(id: string) {
  const t = ensureTree(id)
  t.loading = true
  connErrors[id] = ''
  const r = await window.sqlpilot.getSchemas(id, true)
  if (r.ok) {
    t.schemas = r.schemas || []
    t.tables = {} // schema 集合可能变了，已展开的表列表一并作废
    t.opened = null
  } else {
    connErrors[id] = r.error || '获取 schema 失败'
  }
  t.loading = false
}

async function toggleSchema(connId: string, schema: string) {
  const t = ensureTree(connId)
  t.opened = t.opened === schema ? null : schema
  if (t.opened && !t.tables[schema]) await loadTables(connId, schema)
}

async function loadTables(connId: string, schema: string, refresh = false) {
  const t = ensureTree(connId)
  const r = await window.sqlpilot.getTables(connId, schema, refresh)
  if (r.ok) {
    t.tables[schema] = r.tables || []
    connErrors[connId] = ''
  } else {
    t.tables[schema] = []
    connErrors[connId] = r.error || '获取对象列表失败'
  }
}

async function refreshTables(connId: string, schema: string) {
  await loadTables(connId, schema, true)
}

function filteredTables(list: any[]) {
  const n = filterName.value.trim().toLowerCase()
  return list.filter((t) => (!filterType.value || t.type === filterType.value) && (!n || t.name.toLowerCase().includes(n))).slice(0, 500)
}
</script>

<style scoped>
.dbt-wrap {
  width: 280px; flex-shrink: 0; border-right: 1px solid var(--border);
  display: flex; flex-direction: column; background: var(--bg-side); min-height: 0;
}
.dbt-head { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.dbt-filter { flex: 1; min-width: 0; font-size: 12px; }
.dbt-type-sel { font-size: 12px; padding: 2px 6px; background: var(--bg-input); color: var(--text-dim); border-radius: 7px; }
.dbt-tree { flex: 1; overflow-y: auto; padding: 4px 0 12px; }

.dbt-node {
  display: flex; align-items: center; gap: 7px;
  padding: 4px 10px; font-size: 12.5px; color: var(--text-dim);
  cursor: pointer; user-select: none;
}
.dbt-node:hover { background: var(--bg-card-hover); color: var(--text); }
.dbt-node .arrow { width: 12px; flex-shrink: 0; color: var(--text-faint); }
.dbt-node .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbt-node .sub { font-size: 10.5px; color: var(--text-faint); flex-shrink: 0; }
.dbt-node.conn { font-weight: 600; color: var(--text); }
.dbt-node.conn .sub { background: var(--accent-dim); color: var(--accent); padding: 1px 6px; border-radius: 99px; }
.dbt-node.schema { padding-left: 22px; }
.dbt-node.table { padding-left: 44px; font-family: var(--mono); font-size: 12px; }
.dbt-node.dim { color: var(--text-faint); cursor: default; padding-left: 24px; }
.dbt-node.dim.err { color: var(--red); }
.mini-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 0 6px; cursor: pointer; flex-shrink: 0; font-family: inherit; line-height: 1.6;
}
.mini-btn:hover { color: var(--accent); border-color: var(--accent); }
</style>
