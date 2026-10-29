<template>
  <div class="dbt-wrap">
    <div class="dbt-head">
      <input v-model="filterName" class="dbt-filter" placeholder="筛选连接…" />
      <select v-model="filterType" class="dbt-type-sel" title="连接类型">
        <option value="">全部</option>
        <option v-for="(label, key) in TYPE_LABELS" :key="key" :value="key">{{ label }}</option>
      </select>
      <button class="mini-btn" title="新建分组文件夹（先建组，再把连接拖进去）" @click="startNewGroup">▣＋</button>
      <button class="mini-btn" title="新增数据库连接（控制台内直接添加，无需回 AI 助手侧栏）" @click="openConnModal()">＋</button>
    </div>

    <!-- 新建分组：内联输入（Electron 渲染层不支持 window.prompt） -->
    <div v-if="creating" class="dbt-gnew">
      <input
        ref="newInput"
        v-model="newName"
        class="dbt-ginput"
        placeholder="分组名，回车创建"
        spellcheck="false"
        @keydown.enter="commitNew"
        @keydown.esc="cancelNew"
        @blur="commitNew"
      />
    </div>

    <div class="dbt-tree">
      <div v-if="!groups.length" class="dbt-empty">
        <div class="dim">{{ filterActive ? '没有匹配的连接' : '还没有任何数据库连接' }}</div>
        <template v-if="!filterActive">
          <button class="mini-btn primary" @click="openConnModal()">＋ 新建连接</button>
          <div class="hint">支持 Oracle 11g / 19c、OceanBase（MySQL / Oracle 租户）、MySQL</div>
        </template>
      </div>

      <div v-for="g in groups" :key="g.name" class="dbt-group">
        <!-- 分组头：点击折叠；右键重命名/删除；连接可拖进来 -->
        <div v-if="renaming === g.name" class="dbt-ghead editing">
          <input
            :ref="setRenameInput"
            v-model="renameName"
            class="dbt-ginput"
            spellcheck="false"
            @keydown.enter="commitRename(g.name)"
            @keydown.esc="cancelRename"
            @blur="commitRename(g.name)"
          />
        </div>
        <div
          v-else
          class="dbt-ghead"
          :class="{ 'drop-on': dropTarget === g.name, virtual: g.virtual }"
          :title="g.virtual ? '没有分组的连接' : '点击展开/收起 ｜ 右键重命名/删除 ｜ 把连接拖进来即可归组'"
          @click="toggleGroup(g.name)"
          @contextmenu.prevent="showGroupMenu($event, g)"
          @dragover.prevent="onDragOver(g.name)"
          @dragleave="onDragLeave($event, g.name)"
          @drop.stop.prevent="onDrop(g.name)"
        >
          <span class="caret" :class="{ closed: collapsed[g.name] }">▾</span>
          <span class="gicon" :class="{ virtual: g.virtual }">{{ g.virtual ? '·' : '▣' }}</span>
          <span class="gname">{{ g.name }}</span>
          <span class="gcount">{{ g.items.length }}</span>
        </div>

        <template v-if="!collapsed[g.name]">
          <template v-for="c in g.items" :key="c.id">
            <div
              class="dbt-node conn"
              :class="{ dragging: dragId === c.id }"
              :title="`${c.user}@${c.host}:${c.port}\n点击展开 schema ｜ 拖到其它分组 ｜ 右键更多操作`"
              draggable="true"
              @dragstart="onDragStart($event, c)"
              @dragend="onDragEnd"
              @click="toggleConn(c.id)"
              @contextmenu.prevent="showConnMenu($event, c)"
            >
              <span class="arrow">{{ tree[c.id]?.expanded ? '▾' : '▸' }}</span>
              <span class="ico">🗄</span>
              <!-- 两行式（与服务器模块一致）：名字独占一行，类型/角色/地址退到第二行，窄侧栏也不会把名字挤没 -->
              <span class="main">
                <span class="name">{{ c.name }}</span>
                <span class="meta">
                  {{ TYPE_LABELS[c.type] || c.type }}
                  <span :class="c.role === 'readonly' ? 'ro' : 'rw'">{{ c.role === 'readonly' ? 'RO' : 'RW' }}</span>
                  {{ c.user }}@{{ c.host }}:{{ c.port }}
                </span>
              </span>
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
        </template>
      </div>
    </div>

    <!-- 连接右键菜单（Teleport 到 body：侧栏 overflow 会裁掉绝对值定位的菜单） -->
    <Teleport to="body">
      <div v-if="menu" class="ctx-mask" @mousedown.self="menu = null" @contextmenu.prevent="menu = null">
        <div class="ctx" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
          <button class="ctx-item" @click="runConn('query')">新建查询窗口</button>
          <button class="ctx-item" @click="runConn('info')">数据库信息</button>
          <button class="ctx-item" @click="runConn('refresh')">刷新对象列表</button>
          <div class="ctx-sep"></div>
          <div class="ctx-label">移动到分组</div>
          <div class="ctx-chips">
            <button
              v-for="f in foldersForMove()"
              :key="f"
              class="ctx-chip"
              :class="{ on: (menu?.conn.group || UNGROUPED) === f }"
              @click="moveTo(f)"
            >{{ f }}</button>
            <button class="ctx-chip add" title="新建分组并移入" @click="moveToNew">＋新建…</button>
          </div>
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="runConn('edit')">编辑连接…</button>
          <button class="ctx-item danger" @click="runConn('del')">删除连接</button>
        </div>
      </div>
    </Teleport>

    <!-- 分组右键菜单 -->
    <Teleport to="body">
      <div v-if="gmenu" class="ctx-mask" @mousedown.self="gmenu = null" @contextmenu.prevent="gmenu = null">
        <div class="ctx" :style="{ left: gmenu.x + 'px', top: gmenu.y + 'px' }">
          <div class="ctx-label">{{ gmenu.group.name }}</div>
          <button class="ctx-item" @click="runGroup('newConn')">在此分组新建连接</button>
          <template v-if="!gmenu.group.virtual">
            <div class="ctx-sep"></div>
            <button class="ctx-item" @click="runGroup('rename')">重命名分组…</button>
            <button class="ctx-item danger" @click="runGroup('del')">删除分组</button>
          </template>
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="runGroup('toggle')">{{ collapsed[gmenu.group.name] ? '展开' : '收起' }}</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, reactive, ref } from 'vue'
import { store, TYPE_LABELS } from '../../store'
import { bucketByFolder, connGroupFolders, UNGROUPED } from '../../grouping'

/** 连接弹窗由 App.vue 全局 provide（控制台不依赖 AI 助手侧栏） */
const openConnModal = inject<(c?: any) => void>('openConnModal')!

const emit = defineEmits<{
  (e: 'open-table', connId: string, schema: string, table: string): void
  (e: 'new-query', connId: string): void
  (e: 'open-info', connId: string): void
}>()

const tree = store.tree
const connErrors = reactive<Record<string, string>>({})
const filterName = ref('')
const filterType = ref('')

// ---------- 分组：清单顺序跟配置走，空文件夹保留；有筛选时只留有命中的组 ----------
const filterActive = computed(() => !!filterName.value.trim() || !!filterType.value)

const groups = computed(() => {
  const q = filterName.value.trim().toLowerCase()
  const list = (store.cfg?.connections || []).filter((c: any) => {
    if (filterType.value && c.type !== filterType.value) return false
    if (!q) return true
    return [c.name, c.host, c.user, c.group, c.type].filter(Boolean).join(' ').toLowerCase().includes(q)
  })
  return bucketByFolder(
    connGroupFolders(),
    list as any[],
    {
      sort: (a: any, b: any) => String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true }),
      keepEmpty: !filterActive.value
    }
  )
})

const COLLAPSED_KEY = 'sqlpilot.dbGroups.collapsed'
const collapsed = reactive<Record<string, boolean>>({})
try {
  const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}')
  if (saved && typeof saved === 'object') Object.assign(collapsed, saved)
} catch { /* 损坏时忽略：默认全展开 */ }
function toggleGroup(name: string): void {
  collapsed[name] = !collapsed[name]
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
}

// ---------- 新建 / 重命名分组 ----------
const creating = ref(false)
const newName = ref('')
const newInput = ref<HTMLInputElement | null>(null)
const renaming = ref<string | null>(null)
const renameName = ref('')
const renameInput = ref<HTMLInputElement | null>(null)
/** 「＋新建…」从连接右键进来的：建完分组顺手把这条连接放进去 */
const pendingMoveId = ref<string | null>(null)

/** v-for 里的 ref 会被收集成数组，这里用函数 ref 只留当前那一个输入框 */
function setRenameInput(el: any): void {
  if (el) renameInput.value = el as HTMLInputElement
}

function startNewGroup(): void {
  creating.value = true
  newName.value = ''
  nextTick(() => newInput.value?.focus())
}
function cancelNew(): void {
  creating.value = false
  newName.value = ''
  pendingMoveId.value = null
}

async function commitNew(): Promise<void> {
  if (!creating.value) return // blur 与回车会连着触发，第二次直接吞掉
  const name = newName.value.trim()
  const moveId = pendingMoveId.value
  pendingMoveId.value = null
  creating.value = false
  if (!name) return
  const r = await window.sqlpilot.saveConnGroup(name)
  if (!r.ok) {
    await window.sqlpilot.uiAlert(r.error || '创建分组失败')
    return
  }
  await reload()
  if (moveId) await moveIds([moveId], name)
}

function startRename(name: string): void {
  renaming.value = name
  renameName.value = name
  nextTick(() => renameInput.value?.focus())
}
function cancelRename(): void {
  renaming.value = null
  renameName.value = ''
}
async function commitRename(oldName: string): Promise<void> {
  if (renaming.value !== oldName) return
  const name = renameName.value.trim()
  renaming.value = null
  renameName.value = ''
  if (!name || name === oldName) return
  const r = await window.sqlpilot.saveConnGroup(name, oldName)
  if (!r.ok) {
    await window.sqlpilot.uiAlert(r.error || '重命名失败')
    return
  }
  // 折叠状态跟着改名走，否则改完分组会自己展开
  if (collapsed[oldName] !== undefined) {
    collapsed[name] = collapsed[oldName]
    delete collapsed[oldName]
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
  }
  await reload()
}

/**
 * 重新拉配置。分组改动是主进程连带给连接改 group 字段的，必须等新配置回来再渲染，
 * 否则会出现"分组建好了但连接还在旧组里"的中间态。
 */
async function reload(): Promise<void> {
  try { store.cfg = await window.sqlpilot.getConfig() } catch { /* 保留旧配置 */ }
  // 连接被移到别的分组后，元数据缓存不受影响，但对象树 key 仍是连接 id，无需清理
}

// ---------- 拖拽归组 ----------
const dragId = ref<string | null>(null)
const dropTarget = ref<string | null>(null)

function onDragStart(e: DragEvent, c: any): void {
  dragId.value = c.id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', c.id) // 某些平台不带数据就不发 drop
  }
}
function onDragEnd(): void {
  dragId.value = null
  dropTarget.value = null
}
function onDragOver(name: string): void {
  if (!dragId.value) return
  dropTarget.value = name
}
function onDragLeave(e: DragEvent, name: string): void {
  // 在分组头内部的 span 之间移动不算离开，否则高亮会闪
  const to = e.relatedTarget as Node | null
  if (to && (e.currentTarget as HTMLElement)?.contains(to)) return
  if (dropTarget.value === name) dropTarget.value = null
}
async function onDrop(name: string): Promise<void> {
  const id = dragId.value
  dropTarget.value = null
  dragId.value = null
  if (!id) return
  await moveIds([id], name)
}
async function moveIds(ids: string[], group: string): Promise<void> {
  const target = group === UNGROUPED ? '' : group
  const hits = (store.cfg?.connections || []).filter((c: any) => ids.includes(c.id))
  if (hits.length && hits.every((c: any) => (c.group || '') === target)) return // 已经在目标分组，别白写配置
  const r = await window.sqlpilot.moveConnsToGroup(ids, target)
  if (!r.ok) {
    await window.sqlpilot.uiAlert(r.error || '移动失败')
    return
  }
  await reload()
}

// ---------- 连接右键菜单 ----------
const menu = ref<{ x: number; y: number; conn: any } | null>(null)
function showConnMenu(e: MouseEvent, c: any): void {
  menu.value = {
    x: Math.min(e.clientX, window.innerWidth - 230),
    y: Math.min(e.clientY, window.innerHeight - 330),
    conn: c
  }
}
/** 「移动到分组」可选目标：现有文件夹 + 未分组 */
function foldersForMove(): string[] {
  return [...connGroupFolders(), UNGROUPED]
}
async function moveTo(group: string): Promise<void> {
  const m = menu.value
  menu.value = null
  if (!m) return
  await moveIds([m.conn.id], group)
}
/** 新建分组 + 移入：不能弹 window.prompt（Electron 渲染层不支持），走顶部内联输入框 */
function moveToNew(): void {
  const m = menu.value
  menu.value = null
  if (!m) return
  pendingMoveId.value = m.conn.id
  startNewGroup()
}

async function runConn(action: string): Promise<void> {
  const m = menu.value
  menu.value = null
  if (!m) return
  const c = m.conn
  if (action === 'query') emit('new-query', c.id)
  else if (action === 'info') emit('open-info', c.id)
  else if (action === 'refresh') await refreshSchemas(c.id)
  else if (action === 'edit') openConnModal(c)
  else if (action === 'del') {
    if (!(await window.sqlpilot.uiConfirm(`删除连接「${c.name}」？`, '已保存的密码将一并删除；该连接上的查询窗口需要重开', true))) return
    const r = await window.sqlpilot.deleteConn(c.id)
    if (!r.ok) {
      await window.sqlpilot.uiAlert('删除失败')
      return
    }
    delete tree[c.id]
    await reload()
  }
}

// ---------- 分组右键菜单 ----------
const gmenu = ref<{ x: number; y: number; group: any } | null>(null)
function showGroupMenu(e: MouseEvent, group: any): void {
  gmenu.value = {
    x: Math.min(e.clientX, window.innerWidth - 210),
    y: Math.min(e.clientY, window.innerHeight - 220),
    group
  }
}
async function runGroup(action: string): Promise<void> {
  const m = gmenu.value
  gmenu.value = null
  if (!m) return
  const g = m.group
  if (action === 'newConn') {
    openConnModal({ group: g.virtual ? '' : g.name })
  } else if (action === 'rename') {
    startRename(g.name)
  } else if (action === 'toggle') {
    toggleGroup(g.name)
  } else if (action === 'del') {
    const n = g.items.length
    const ok = await window.sqlpilot.uiConfirm(
      `删除分组「${g.name}」？`,
      n ? `组内 ${n} 个连接不会被删除，会移到「${UNGROUPED}」。` : '这是空分组，删除后不影响任何连接。',
      true
    )
    if (!ok) return
    const r = await window.sqlpilot.deleteConnGroup(g.name)
    if (!r.ok) {
      await window.sqlpilot.uiAlert(r.error || '删除分组失败')
      return
    }
    delete collapsed[g.name]
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
    await reload()
  }
}

// ---------- 对象树展开 ----------
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
    t.expanded = true
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
.dbt-head { display: flex; gap: 5px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.dbt-filter { flex: 1; min-width: 0; font-size: 12px; }
.dbt-type-sel { font-size: 12px; padding: 2px 4px; background: var(--bg-input); color: var(--text-dim); border-radius: 7px; max-width: 78px; }
.dbt-tree { flex: 1; overflow-y: auto; padding: 2px 0 12px; min-height: 0; }

/* 新建/重命名分组的内联输入框：就地编辑，不弹窗 */
.dbt-gnew { padding: 6px 10px 0; }
.dbt-ginput {
  width: 100%; box-sizing: border-box; font-size: 12px; padding: 3px 8px; border-radius: 6px;
  border: 1px solid var(--accent); background: var(--bg-card); color: var(--text); font-family: inherit;
}

.dbt-group { margin-top: 2px; }
.dbt-ghead {
  display: flex; align-items: center; gap: 5px; width: 100%;
  padding: 5px 10px; cursor: pointer; user-select: none;
  color: var(--text-faint); font-size: 11px; letter-spacing: .4px;
}
.dbt-ghead:hover { color: var(--text-dim); background: var(--bg-card-hover); }
/* 拖连接悬停到分组头：整行高亮 + 内描边，明确"松手就归这个组" */
.dbt-ghead.drop-on {
  color: var(--accent); background: var(--accent-dim);
  box-shadow: inset 0 0 0 1px var(--accent); border-radius: 6px;
}
.dbt-ghead.editing { padding: 4px 8px; }
.dbt-ghead .caret { display: inline-block; transition: transform .15s ease; font-size: 9px; width: 9px; flex-shrink: 0; }
.dbt-ghead .caret.closed { transform: rotate(-90deg); }
.dbt-ghead .gicon { font-size: 9px; opacity: .8; }
.dbt-ghead .gicon.virtual { opacity: .5; }
.dbt-ghead .gname { flex: 1; text-align: left; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbt-ghead .gcount { font-weight: 400; flex-shrink: 0; }

.dbt-node {
  display: flex; align-items: center; gap: 7px;
  padding: 4px 10px 4px 18px; font-size: 12.5px; color: var(--text-dim);
  cursor: pointer; user-select: none;
}
.dbt-node:hover { background: var(--bg-card-hover); color: var(--text); }
.dbt-node .arrow { width: 12px; flex-shrink: 0; color: var(--text-faint); }
.dbt-node .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbt-node.schema .name { flex: 1; }
.dbt-node .sub { font-size: 10.5px; color: var(--text-faint); flex-shrink: 0; }
/* 连接行：名字 + 第二行元信息（类型 / RO-RW / 地址），小按钮排在右侧 */
.dbt-node.conn { font-weight: 600; color: var(--text); padding-top: 5px; padding-bottom: 5px; }
.dbt-node.conn .ico { font-size: 11px; flex-shrink: 0; }
.dbt-node.conn .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dbt-node.conn .meta {
  font-size: 10px; font-weight: 400; color: var(--text-faint); font-family: var(--mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dbt-node.conn .meta .rw { color: var(--yellow); }
.dbt-node.conn.dragging { opacity: .45; }
.dbt-node.schema { padding-left: 34px; }
.dbt-node.table { padding-left: 56px; font-family: var(--mono); font-size: 12px; }
.dbt-node.dim { color: var(--text-faint); cursor: default; padding-left: 36px; }
.dbt-node.dim.err { color: var(--red); }
.mini-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 0 6px; cursor: pointer; flex-shrink: 0; font-family: inherit; line-height: 1.6;
}
.mini-btn:hover { color: var(--accent); border-color: var(--accent); }
.mini-btn.primary { border-color: transparent; background: var(--accent); color: #fff; font-weight: 700; }
.mini-btn.primary:hover { color: #fff; filter: brightness(1.08); }
/* 无连接时的空态：控制台自带连接入口 */
.dbt-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 9px; padding: 18px 14px; }
.dbt-empty .dim { font-size: 12px; color: var(--text-faint); }
.dbt-empty .hint { font-size: 11px; color: var(--text-faint); line-height: 1.6; }

/* 右键菜单（与服务器模块同一套视觉） */
.ctx-mask { position: fixed; inset: 0; z-index: 320; }
.ctx {
  position: fixed; min-width: 190px; padding: 5px;
  background: var(--bg-card); border: 1px solid var(--border-strong);
  border-radius: 10px; box-shadow: var(--shadow-lg);
}
.ctx-item {
  display: block; width: 100%; text-align: left;
  padding: 7px 12px; border: none; border-radius: 7px;
  background: none; color: var(--text); font-size: 12.5px; font-family: inherit; cursor: pointer;
}
.ctx-item:hover { background: var(--bg-card-hover); }
.ctx-item.danger { color: var(--red); }
.ctx-sep { height: 1px; background: var(--border); margin: 4px 6px; }
.ctx-label { font-size: 10.5px; color: var(--text-faint); padding: 2px 10px 4px; letter-spacing: .5px; }
.ctx-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 8px 5px; max-width: 220px; }
.ctx-chip {
  border: 1px solid var(--border); background: var(--bg-side); color: var(--text-dim);
  border-radius: 99px; font-size: 10.5px; padding: 2px 8px; cursor: pointer; font-family: inherit;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ctx-chip:hover { color: var(--accent); border-color: var(--accent); }
.ctx-chip.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.ctx-chip.add { border-style: dashed; }
</style>
