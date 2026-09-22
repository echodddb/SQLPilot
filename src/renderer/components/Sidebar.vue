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
        <div class="ctx-item" @click="ctxAction('archive')">查看归档</div>
        <div class="ctx-item" @click="ctxAction('folder')">在资源管理器中打开</div>
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
        <div
          class="session-group-title session-group-toggle"
          :title="collapsed.has(g.key) ? '展开该项目的会话' : '折叠该项目的会话'"
          @click="toggleGroup(g.key)"
        >
          <span class="chev">{{ collapsed.has(g.key) ? '▸' : '▾' }}</span>
          <span>{{ g.label }}</span>
          <span v-if="g.ids.length" class="cnt">{{ g.ids.length }}</span>
        </div>
        <template v-if="!collapsed.has(g.key)">
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
          <button class="icon-btn" :title="store.sessions[id]?.running ? '会话执行中，停止后才能归档' : '归档会话（总结对话到项目归档后移除）'" :disabled="store.sessions[id]?.running" @click.stop="removeSession(id)">▤</button>
          </div>
          <div v-if="!g.ids.length" class="session-item" style="pointer-events:none; opacity:.55">（暂无会话，点击项目名新建）</div>
        </template>
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
          <!-- 对象浏览在数据库工作台；侧边栏只做连接管理，点行进入工作台 -->
          <div class="conn-item" :title="`${c.user}@${c.host}:${c.port}\n点击进入数据库工作台`" @click="store.view = 'db'">
            <span>🗄</span>
            <span class="name">{{ c.name }}</span>
            <span v-if="projName(c.projectId)" class="sub" style="background: var(--bg-card-hover); color: var(--text-dim)" :title="'已关联项目：' + projName(c.projectId)">{{ projName(c.projectId) }}</span>
            <span class="sub" :class="{ rw: c.role !== 'readonly' }">{{ c.role === 'readonly' ? 'RO' : 'RW' }}</span>
            <button class="icon-btn" title="编辑" @click.stop="openConnModal(c)">✎</button>
            <button class="icon-btn" title="删除" @click.stop="removeConn(c)">✕</button>
          </div>
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
import { computed, inject, reactive, watch } from 'vue'
import { store, curSession, removeSession, createSessionInProject, TYPE_LABELS } from '../store'

const openConnModal = inject<(c?: any) => void>('openConnModal')!
const openProjectModal = inject<() => void>('openProjectModal')!
const openSessionModal = inject<(mode: 'new' | 'switch') => void>('openSessionModal')!
const openProjectEditor = inject<(p: any) => void>('openProjectEditor')!
const openArchiveView = inject<(p: any) => void>('openArchiveView')!

// 项目右键菜单
const ctxMenu = reactive({ show: false, x: 0, y: 0, project: null as any })
function openProjectMenu(e: MouseEvent, p: any) {
  ctxMenu.show = true
  ctxMenu.x = Math.min(e.clientX, window.innerWidth - 190)
  ctxMenu.y = Math.min(e.clientY, window.innerHeight - 170)
  ctxMenu.project = p
}
// 透明遮罩若残留会吞掉下一次点击（输入框点不进去、光标不出现）：
// Esc/窗口失焦/滚动（菜单是屏幕坐标，滚动后已脱离锚点）/尺寸变化都必须关闭
function closeCtxMenu() {
  ctxMenu.show = false
}
function onCtxKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeCtxMenu()
}
watch(() => ctxMenu.show, (open) => {
  if (open) {
    window.addEventListener('keydown', onCtxKeydown)
    window.addEventListener('blur', closeCtxMenu)
    window.addEventListener('resize', closeCtxMenu)
    document.addEventListener('scroll', closeCtxMenu, true)
  } else {
    window.removeEventListener('keydown', onCtxKeydown)
    window.removeEventListener('blur', closeCtxMenu)
    window.removeEventListener('resize', closeCtxMenu)
    document.removeEventListener('scroll', closeCtxMenu, true)
  }
})
async function ctxAction(action: string) {
  const p = ctxMenu.project
  ctxMenu.show = false
  if (!p) return
  if (action === 'edit') openProjectEditor(p)
  else if (action === 'new') await newSessionFor(p.id)
  else if (action === 'archive') openArchiveView(p)
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

// 分组折叠状态：纯 UI 状态，localStorage 持久化（不值得进 config.json）
const COLLAPSED_KEY = 'sqlpilot.sessionGroups.collapsed'
const collapsed = reactive(new Set<string>())
try {
  const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')
  if (Array.isArray(saved)) for (const k of saved) collapsed.add(String(k))
} catch { /* 损坏时忽略 */ }

function toggleGroup(key: string) {
  if (collapsed.has(key)) collapsed.delete(key)
  else collapsed.add(key)
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
}

// 当前会话切换/恢复时自动展开其所在分组——"当前"不应藏在折叠里
watch(() => store.currentId, (id) => {
  if (!id) return
  const pid = store.sessions[id]?.meta.projectId
  const key = pid && sessionGroups.value.some((g) => g.key === pid) ? pid : '__none__'
  if (collapsed.has(key)) toggleGroup(key)
}, { immediate: true })

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
.session-group-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  border-radius: 6px;
}
.session-group-toggle:hover { color: var(--text-dim); }
.session-group-toggle .chev {
  width: 12px;
  flex-shrink: 0;
  font-size: 10px;
  text-align: center;
}
.session-group-toggle .cnt {
  margin-left: auto;
  font-weight: 400;
  opacity: 0.75;
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
