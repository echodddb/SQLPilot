<template>
  <div class="sidebar">
    <div class="side-head">
      <span>项目</span>
      <button class="icon-btn" title="新建项目（选择文件夹）" @click="openProjectModal()">＋</button>
    </div>
    <div class="conn-list" style="flex: 0 1 auto; max-height: 150px;">
      <div v-if="!store.cfg?.projects?.length" class="side-empty" style="padding: 4px 16px 10px">
        无项目。会话必须挂在一个项目下——点击 <b>＋</b> 选择文件夹创建。
      </div>
      <template v-else>
        <div
          v-for="p in store.cfg.projects"
          :key="p.id"
          class="conn-item"
          :title="`${p.rootPath}\n单击：新建会话 ｜ 右键：更多操作`"
          @click="newSessionFor(p.id)"
          @contextmenu.prevent="openProjectMenu($event, p)"
        >
          <span>📁</span>
          <span class="name">{{ p.name }}</span>
          <span class="sub" v-if="curSession()?.meta.projectId === p.id">当前</span>
          <button class="icon-btn" title="编辑项目属性（数据库/服务器）" @click.stop="openProjectEditor(p)">✎</button>
          <button class="icon-btn" title="删除项目" @click.stop="removeProject(p)">✕</button>
        </div>
      </template>
    </div>

    <!-- 项目右键菜单 -->
    <div v-if="ctxMenu.show" class="ctx-mask" @click="ctxMenu.show = false" @contextmenu.prevent="ctxMenu.show = false">
      <div class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
        <div class="ctx-item" @click="ctxAction('edit')">✎　编辑项目属性</div>
        <div class="ctx-item" @click="ctxAction('new')">＋　新建会话</div>
        <div class="ctx-item" @click="ctxAction('folder')">📂　在资源管理器中打开</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item danger" @click="ctxAction('delete')">🗑　删除项目</div>
      </div>
    </div>

    <div class="side-head" style="margin-top: 4px">
      <span>会话（按项目分组）</span>
      <button class="icon-btn" title="新建会话（选择项目）" @click="newSessionClick">＋</button>
    </div>
    <div class="session-list">
      <template v-for="g in sessionGroups" :key="g.key">
        <div class="session-group-title">📁 {{ g.label }}</div>
        <div
          v-for="id in g.ids"
          :key="id"
          class="session-item"
          :class="{ active: id === store.currentId }"
          @click="store.currentId = id"
          :title="store.sessions[id]?.meta.title"
        >
          <span class="mode-dot" :class="store.sessions[id]?.meta.mode"></span>
          <span class="name">{{ store.sessions[id]?.meta.title || '会话' }}</span>
          <span v-if="store.sessions[id]?.running" class="spinner" style="width:10px;height:10px"></span>
          <button class="icon-btn" title="删除会话" @click.stop="removeSession(id)">✕</button>
        </div>
        <div v-if="!g.ids.length" class="session-item" style="pointer-events:none; opacity:.55">（暂无会话，点击项目名新建）</div>
      </template>
    </div>

    <div class="side-head" style="margin-top: 4px">
      <span>数据库连接</span>
      <button class="icon-btn" title="新增连接" @click="openConnModal()">＋</button>
    </div>

    <div class="conn-list">
      <div v-if="!groups.length" class="side-empty">
        还没有数据库连接。<br />点击右上角 <b>＋</b> 添加：<br />
        Oracle 11g / 19c、OceanBase（MySQL 租户）、MySQL 均已支持。连接可按需关联到项目，不关联则全局可用。
      </div>

      <template v-for="g in groups" :key="g.type">
        <div class="conn-group-title">{{ g.label }}</div>
        <template v-for="c in g.items" :key="c.id">
          <div class="conn-item" @click="toggle(c.id)" :title="`${c.user}@${c.host}:${c.port}`">
            <span>{{ tree[c.id]?.expanded ? '▾' : '▸' }}</span>
            <span class="name">{{ c.name }}</span>
            <span v-if="projName(c.projectId)" class="sub" style="background: var(--bg-card-hover); color: var(--text-dim)" :title="'已关联项目：' + projName(c.projectId)">{{ projName(c.projectId) }}</span>
            <span class="sub" :class="{ rw: c.role !== 'readonly' }">{{ c.role === 'readonly' ? 'RO' : 'RW' }}</span>
            <button class="icon-btn" title="编辑" @click.stop="openConnModal(c)">✎</button>
            <button class="icon-btn" title="删除" @click.stop="removeConn(c)">✕</button>
          </div>

          <template v-if="tree[c.id]?.expanded">
            <div v-if="tree[c.id].loading" class="tree-schema" style="pointer-events:none">加载中…</div>
            <template v-else-if="tree[c.id].schemas?.length">
              <div
                v-for="s in tree[c.id].schemas"
                :key="s"
                class="tree-schema"
                :class="{ open: tree[c.id].opened === s }"
                @click="openSchema(c.id, s)"
              >🗄 {{ s }}</div>
              <template v-if="tree[c.id].opened && tree[c.id].tables[tree[c.id].opened]">
                <div
                  v-for="t in tree[c.id].tables[tree[c.id].opened].slice(0, 200)"
                  :key="t.name"
                  class="tree-table"
                  :class="{ view: t.type === 'VIEW' }"
                  :title="`${tree[c.id].opened}.${t.name}（双击在对象浏览器打开 / 单击填入输入框）`"
                  @click="pickTable(`${tree[c.id].opened}.${t.name}`)"
                  @dblclick.stop="openObject(c.id, String(tree[c.id].opened), t.name)"
                >{{ t.type === 'VIEW' ? '👁' : '▣' }} {{ t.name }}</div>
              </template>
            </template>
            <div v-else class="tree-schema" style="pointer-events:none; color: var(--text-dim)">（无可见 schema）</div>
          </template>
        </template>
      </template>
    </div>

    <div class="side-foot">
      <span><span class="dot"></span>SQLPilot v0.1</span>
      <span>{{ store.secretsAvailable ? 'DPAPI ✓' : 'DPAPI ✗' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, reactive } from 'vue'
import { store, curSession, removeSession, createSessionInProject, TYPE_LABELS, openObject } from '../store'

const openConnModal = inject<(c?: any) => void>('openConnModal')!
const openProjectModal = inject<() => void>('openProjectModal')!
const openSessionModal = inject<(mode: 'new' | 'switch') => void>('openSessionModal')!
const openProjectEditor = inject<(p: any) => void>('openProjectEditor')!

const tree = store.tree

// 项目右键菜单
const ctxMenu = reactive({ show: false, x: 0, y: 0, project: null as any })
function openProjectMenu(e: MouseEvent, p: any) {
  ctxMenu.show = true
  ctxMenu.x = Math.min(e.clientX, window.innerWidth - 190)
  ctxMenu.y = Math.min(e.clientY, window.innerHeight - 170)
  ctxMenu.project = p
}
async function ctxAction(action: string) {
  const p = ctxMenu.project
  ctxMenu.show = false
  if (!p) return
  if (action === 'edit') openProjectEditor(p)
  else if (action === 'new') await newSessionFor(p.id)
  else if (action === 'folder') await window.sqlpilot.openFolder(p.rootPath)
  else if (action === 'delete') await removeProject(p)
}

const groups = computed(() => {
  const map = new Map<string, any[]>()
  for (const c of store.cfg?.connections || []) {
    if (!map.has(c.type)) map.set(c.type, [])
    map.get(c.type)!.push(c)
  }
  return [...map.entries()].map(([type, items]) => ({ type, label: TYPE_LABELS[type] || type, items }))
})

function projName(pid?: string | null) {
  if (!pid) return ''
  return (store.cfg?.projects || []).find((p: any) => p.id === pid)?.name || ''
}

// 会话按项目分组：项目顺序在前，未绑定项目的会话归入"未分组"
const sessionGroups = computed(() => {
  const groups: { key: string; label: string; ids: string[] }[] = []
  const byKey = new Map<string, { key: string; label: string; ids: string[] }>()
  for (const p of store.cfg?.projects || []) {
    const g = { key: p.id, label: p.name, ids: [] as string[] }
    groups.push(g)
    byKey.set(p.id, g)
  }
  const none = { key: '__none__', label: '未分组（未选择项目）', ids: [] as string[] }
  for (const id of store.sessionOrder) {
    const pid = store.sessions[id]?.meta.projectId
    if (pid && byKey.has(pid)) byKey.get(pid)!.ids.push(id)
    else none.ids.push(id)
  }
  if (none.ids.length) groups.push(none)
  return groups
})

function newSessionClick() {
  if (!store.cfg?.projects?.length) {
    openProjectModal()
  } else {
    openSessionModal('new')
  }
}

async function newSessionFor(projectId: string) {
  await createSessionInProject(projectId)
}

async function toggle(id: string) {
  const t = ensureTree(id)
  t.expanded = !t.expanded
  if (t.expanded && !t.schemas) {
    t.loading = true
    const r = await window.sqlpilot.getSchemas(id)
    t.schemas = r.ok ? r.schemas || [] : []
    t.loading = false
    if (!r.ok) alert('获取 schema 失败：' + r.error)
  }
}

async function openSchema(connId: string, schema: string) {
  const t = ensureTree(connId)
  t.opened = t.opened === schema ? null : schema
  if (t.opened && !t.tables[schema]) {
    const r = await window.sqlpilot.getTables(connId, schema)
    t.tables[schema] = r.ok ? r.tables || [] : []
    if (!r.ok) alert('获取表列表失败：' + r.error)
  }
}

function ensureTree(id: string) {
  if (!tree[id]) {
    tree[id] = reactive({ expanded: false, schemas: undefined as any, loading: false, tables: {}, opened: null as any })
  }
  return tree[id]
}

function pickTable(name: string) {
  const cur = store.drafts[store.currentId] || ''
  store.drafts[store.currentId] = (cur ? cur.trimEnd() + ' ' : '') + name
}

async function removeConn(c: any) {
  if (!window.confirm(`删除连接「${c.name}」？（已保存的密码将一并删除）`)) return
  await window.sqlpilot.deleteConn(c.id)
  store.cfg = await window.sqlpilot.getConfig()
}

async function removeProject(p: any) {
  if (!window.confirm(`删除项目「${p.name}」？（只解除引用，不删除磁盘文件；关联会话需要重新选择项目）`)) return
  await window.sqlpilot.deleteProject(p.id)
  store.cfg = await window.sqlpilot.getConfig()
}
</script>

<style scoped>
.session-list { padding: 0 10px 8px; max-height: 260px; overflow-y: auto; }
.session-group-title {
  padding: 8px 4px 4px;
  font-size: 11px;
  color: var(--text-faint);
  font-weight: 600;
  letter-spacing: 0.5px;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 9px;
  cursor: pointer;
  color: var(--text-dim);
  font-size: 12.5px;
}
.session-item:hover { background: var(--bg-card-hover); color: var(--text); }
.session-item.active { background: var(--accent-dim); color: var(--text); }
.session-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mode-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text-faint); }
.mode-dot.plan { background: var(--purple); }
.mode-dot.readonly { background: var(--green); }
.mode-dot.confirm { background: var(--accent); }
.mode-dot.session { background: var(--yellow); }
.mode-dot.yolo { background: var(--red); }

/* 右键菜单 */
.ctx-mask { position: fixed; inset: 0; z-index: 200; }
.ctx-menu {
  position: fixed;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 5px;
  min-width: 180px;
  box-shadow: var(--shadow-lg);
}
.ctx-item {
  padding: 7px 12px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text);
}
.ctx-item:hover { background: var(--bg-card-hover); }
.ctx-item.danger { color: var(--red); }
.ctx-sep { height: 1px; background: var(--border); margin: 4px 6px; }
</style>
