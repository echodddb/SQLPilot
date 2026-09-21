<template>
  <div class="dbw-wrap">
    <DbTree @open-table="openTable" @new-query="newQuery" @open-info="openInfo" />
    <div class="dbw-main">
      <div class="dbw-tabs" v-if="tabs.length">
        <div
          v-for="t in tabs"
          :key="t.key"
          class="dbw-tab"
          :class="{ active: t.key === activeKey }"
          :title="tabTitle(t)"
          @click="activate(t)"
        >
          <span>{{ KIND_ICON[t.kind] }} {{ t.title }}</span>
          <button class="icon-btn" style="padding: 0 3px; font-size: 11px" @click.stop="closeTab(t.key)">✕</button>
        </div>
        <span style="flex: 1"></span>
        <button class="mini-btn" title="新建查询窗口" @click="newQuery()">＋ 查询</button>
      </div>

      <div class="dbw-body" v-if="cur">
        <QueryTab
          v-for="t in tabs.filter((x) => x.kind === 'query')"
          :key="t.key"
          v-show="t.key === activeKey"
          :ref="setQRef(t.key)"
          :tab-key="t.key"
          :init-conn-id="t.connId"
          @open-info="openInfo"
        />
        <TableTab
          v-for="t in tabs.filter((x) => x.kind === 'table')"
          :key="t.key"
          v-show="t.key === activeKey"
          :tab-key="t.key"
          :conn-id="t.connId"
          :schema="t.schema!"
          :table="t.table!"
        />
        <InfoTab
          v-for="t in tabs.filter((x) => x.kind === 'info')"
          :key="t.key"
          v-show="t.key === activeKey"
          :conn-id="t.connId"
          :activate-seq="t.activateSeq"
        />
      </div>

      <div v-else class="dbw-empty">
        双击左侧的表或视图打开浏览<br />
        <span class="dim">查询窗口（Ctrl+Enter 执行）、表数据（双击单元格编辑）、结构 / DDL、数据库信息都在这里以标签页打开</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { store } from '../store'
import DbTree from './db/DbTree.vue'
import TableTab from './db/TableTab.vue'
import QueryTab from './db/QueryTab.vue'
import InfoTab from './db/InfoTab.vue'

interface WbTab {
  key: string
  kind: 'query' | 'table' | 'info'
  connId: string
  title: string
  schema?: string
  table?: string
  /** info tab：再次激活时递增 → InfoTab 重取，避免读到旧快照 */
  activateSeq: number
}

const KIND_ICON: Record<WbTab['kind'], string> = { query: '📝', table: '▣', info: '📊' }

const tabs = ref<WbTab[]>([])
const activeKey = ref('')
let tabSeq = 0

const cur = computed(() => tabs.value.find((t) => t.key === activeKey.value))

function connName(id: string): string {
  return (store.cfg?.connections || []).find((c: any) => c.id === id)?.name || id
}

function tabTitle(t: WbTab): string {
  return t.kind === 'table' ? `${connName(t.connId)} · ${t.schema}.${t.table}` : `${connName(t.connId)} · ${t.title}`
}

// ---------- 打开各类 tab ----------
function newQuery(connId?: string) {
  const cid = connId || tabs.value.find((t) => t.kind === 'query')?.connId || (store.cfg?.connections || [])[0]?.id || ''
  if (!cid) {
    alert('请先在左侧"数据库连接"区添加一个连接')
    return
  }
  tabSeq++
  const tab: WbTab = reactive({ key: `q_${Date.now()}_${tabSeq}`, kind: 'query', connId: cid, title: `查询${tabSeq}`, activateSeq: 0 })
  tabs.value.push(tab)
  activeKey.value = tab.key
}

function openTable(connId: string, schema: string, table: string) {
  const key = `${connId}::${schema}::${table}`
  const found = tabs.value.find((t) => t.key === key)
  if (found) {
    activeKey.value = key
    return
  }
  tabs.value.push(reactive({ key, kind: 'table', connId, title: table, schema, table, activateSeq: 0 }))
  activeKey.value = key
}

function openInfo(connId: string) {
  const key = `info::${connId}`
  const found = tabs.value.find((t) => t.key === key)
  if (found) {
    // 复用已打开的信息 tab 也重取，避免读到旧快照
    found.activateSeq++
    activeKey.value = key
    return
  }
  tabs.value.push(reactive({ key, kind: 'info', connId, title: connName(connId), activateSeq: 0 }))
  activeKey.value = key
}

function activate(t: WbTab) {
  if (t.kind === 'info' && t.key === activeKey.value) return
  activeKey.value = t.key
  // 切回查询 tab 后 CodeMirror 需要重新排版（v-show 隐藏期间尺寸变化不感知）
  if (t.kind === 'query') qRefs.get(t.key)?.refresh()
}

function closeTab(key: string) {
  const i = tabs.value.findIndex((t) => t.key === key)
  if (i >= 0) tabs.value.splice(i, 1)
  qRefs.delete(key)
  if (activeKey.value === key) activeKey.value = tabs.value[Math.max(0, i - 1)]?.key || ''
}

// ---------- 查询 tab 实例引用（激活时 refresh CodeMirror） ----------
const qRefs = new Map<string, InstanceType<typeof QueryTab>>()
function setQRef(key: string) {
  return (el: any) => {
    if (el) qRefs.set(key, el as InstanceType<typeof QueryTab>)
  }
}

// 本视图用 v-show 保活（切到聊天/设置再回来 tab 不丢），首次可见时让激活的 CodeMirror 排版
watch(
  () => store.view,
  (v) => {
    if (v === 'db') nextTick(() => { if (cur.value?.kind === 'query') qRefs.get(cur.value.key)?.refresh() })
  }
)
</script>

<style scoped>
.dbw-wrap { display: flex; height: 100%; min-height: 0; }
.dbw-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dbw-tabs {
  display: flex; align-items: center; gap: 4px; padding: 5px 8px 0;
  border-bottom: 1px solid var(--border); background: var(--bg-input);
  overflow-x: auto; flex-shrink: 0;
}
.dbw-tab {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 12px; border: 1px solid var(--border); border-bottom: none;
  border-radius: 7px 7px 0 0; cursor: pointer; font-size: 12px;
  color: var(--text-dim); background: var(--bg-card); max-width: 220px;
  white-space: nowrap; overflow: hidden;
}
.dbw-tab.active { color: var(--text); background: var(--bg); border-color: var(--border-strong); }
.dbw-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbw-empty { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; color: var(--text-faint); font-size: 13px; line-height: 2; }
.dbw-empty.dim, .dim { color: var(--text-faint); font-size: 12px; }
.mini-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 1px 7px; cursor: pointer; flex-shrink: 0; font-family: inherit;
}
.mini-btn:hover { color: var(--accent); border-color: var(--accent); }
</style>
