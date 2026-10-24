<template>
  <div class="dbw-wrap">
    <DbTree @open-table="openTable" @new-query="newQuery" @open-info="openInfo" />
    <div class="dbw-main">
      <div class="dbw-tabs">
        <div
          v-for="t in tabs"
          :key="t.key"
          class="dbw-tab"
          :class="[t.kind, { active: t.key === activeKey }]"
          :title="tabTitle(t)"
          @click="activate(t)"
        >
          <span class="dbw-tab-icon">{{ KIND_ICON[t.kind] }}</span>
          <span class="dbw-tab-title">{{ t.title }}</span>
          <button class="dbw-tab-close" title="关闭标签页" @click.stop="closeTab(t.key)">✕</button>
        </div>
        <span style="flex: 1"></span>
        <button class="mini-btn" title="新建查询窗口" @click="newQuery()">＋ 查询</button>
        <button class="icon-btn" title="回到 AI 助手（控制台保活，标签页与未提交事务都保留）" @click="store.module = 'agent'">−</button>
        <button class="icon-btn" title="关闭控制台（销毁全部查询/表标签页，关闭连接）" @click="closeDbWorkbench()">✕</button>
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
        <div class="dbw-empty-icon">SQL</div>
        <b>数据库控制台</b>
        <span class="dim">新建查询，或双击左侧表 / 视图浏览数据；标签页会保留会话与结果。</span>
        <button class="mini-btn primary" @click="newQuery()">＋ 新建查询</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { store, closeDbWorkbench } from '../store'
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

const KIND_ICON: Record<WbTab['kind'], string> = { query: '▸', table: '▣', info: '◇' }

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
// 任务栏定位：点击数据库任务时激活该连接最近的 tab（查询/表/信息皆可），无则新开查询窗口
watch(() => store.pendingDbConn, (cid) => {
  if (!cid) return
  store.pendingDbConn = null
  const found = tabs.value.find((t) => t.connId === cid)
  if (found) {
    activeKey.value = found.key
    return
  }
  if ((store.cfg?.connections || []).some((c: any) => c.id === cid)) newQuery(cid)
}, { immediate: true })

function newQuery(connId?: string) {
  const cid = connId || tabs.value.find((t) => t.kind === 'query')?.connId || (store.cfg?.connections || [])[0]?.id || ''
  if (!cid) {
    window.sqlpilot.uiAlert('还没有数据库连接：点顶栏「＋ 新建连接」添加，或在左侧对象树点「＋ 新建连接」')
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

// 控制台以 v-show 挂在 App 上保活（切到别的模块再回来 tab 不丢），
// 重新可见时让激活的 CodeMirror 重新排版（隐藏期间尺寸变化不感知）
watch(
  () => store.module,
  (v) => {
    if (v === 'db') nextTick(() => { if (cur.value?.kind === 'query') qRefs.get(cur.value.key)?.refresh() })
  }
)
</script>

<style scoped>
.dbw-wrap { display: flex; height: 100%; min-height: 0; }
.dbw-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dbw-tabs {
  display: flex; align-items: flex-end; gap: 4px; padding: 6px 8px 0;
  border-bottom: 1px solid var(--border); background: var(--bg-input);
  overflow-x: auto; flex-shrink: 0; scrollbar-width: thin;
}
.dbw-tab {
  display: flex; align-items: center; gap: 6px; height: 29px;
  padding: 0 6px 0 9px; border: 1px solid var(--border); border-bottom: none;
  border-radius: 8px 8px 0 0; cursor: pointer; font-size: 12px;
  color: var(--text-dim); background: var(--bg-card); max-width: 225px;
  white-space: nowrap; overflow: hidden; position: relative;
  transition: color .15s ease, border-color .15s ease, background .15s ease;
}
.dbw-tab::before {
  content: ''; position: absolute; inset: 0 8px auto; height: 2px; border-radius: 0 0 3px 3px;
  background: transparent; transition: background .15s ease;
}
.dbw-tab:hover { color: var(--text); border-color: var(--border-strong); }
.dbw-tab.active { color: var(--text); background: var(--bg); border-color: var(--border-strong); box-shadow: 0 -1px 0 var(--accent) inset; }
.dbw-tab.active::before { background: transparent; }
.dbw-tab.query.active { box-shadow: 0 -2px 0 var(--accent) inset; }
.dbw-tab.table.active { box-shadow: 0 -2px 0 var(--green) inset; }
.dbw-tab.info.active { box-shadow: 0 -2px 0 color-mix(in srgb, var(--accent) 60%, var(--green)) inset; }
.dbw-tab-icon { color: var(--text-faint); font-size: 10px; flex-shrink: 0; }
.dbw-tab.active .dbw-tab-icon { color: var(--accent); }
.dbw-tab-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dbw-tab-close {
  width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 4px; background: transparent; color: var(--text-faint);
  cursor: pointer; font-size: 10px; flex-shrink: 0;
}
.dbw-tab-close:hover { background: var(--red-dim, rgba(220, 38, 38, .12)); color: var(--red); }
.dbw-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbw-empty { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 7px; color: var(--text-faint); font-size: 13px; line-height: 1.6; text-align: center; padding: 20px; }
.dbw-empty b { color: var(--text); font-size: 15px; }
.dbw-empty-icon {
  width: 48px; height: 48px; display: flex; align-items: center; justify-content: center;
  border-radius: 14px; border: 1px solid var(--border); background: var(--accent-dim);
  color: var(--accent); font-family: var(--mono); font-size: 13px; font-weight: 700; margin-bottom: 3px;
}
.dbw-empty.dim, .dim { color: var(--text-faint); font-size: 12px; }
.mini-btn {
  height: 24px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 0 8px; cursor: pointer; flex-shrink: 0; font-family: inherit;
  display: inline-flex; align-items: center; justify-content: center;
  transition: color .15s ease, border-color .15s ease, background .15s ease;
}
.mini-btn:hover { color: var(--accent); border-color: var(--accent); }
.mini-btn.primary { border-color: transparent; background: var(--accent); color: #fff; font-weight: 700; }
.mini-btn.primary:hover { color: #fff; filter: brightness(1.08); }
</style>
