<template>
  <div class="sidebar">
    <div class="side-head">
      <span>项目</span>
      <button class="icon-btn" title="新建项目（选择文件夹）" @click="openProjectModal()">＋</button>
    </div>
    <!-- 项目是低频配置：固定紧凑区；会话才是高频实体，拿走全部弹性空间 -->
    <div class="conn-list" style="flex: 0 0 auto; max-height: 132px;">
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

    <div class="conn-list" style="flex: 0 1 auto; max-height: 200px;">
      <div v-if="!groups.length" class="side-empty">
        还没有数据库连接。<br />点击本组标题行的 <b>＋</b> 添加：<br />
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

    <div class="side-head" style="margin-top: 4px">
      <span>服务器</span>
      <button class="icon-btn" title="添加 SSH 服务器（全局注册，项目按需引用）" @click="openServerModal()">＋</button>
    </div>

    <div class="conn-list" style="flex: 0 1 auto; max-height: 160px;">
      <div v-if="!store.cfg.servers?.length" class="side-empty">
        还没有服务器。<br />点击右上角 <b>＋</b> 添加（SSH 密码认证，<br />密码 DPAPI 加密存储），项目里可按需引用。
      </div>
      <div v-for="s in store.cfg.servers" :key="s.id" class="conn-item" :title="`${s.user}@${s.host}:${s.port}\n点击打开 SSH 终端面板`" @click="openTerm(s)">
        <span>🖥</span>
        <span class="name">{{ s.name }}</span>
        <span v-if="s.tag" class="sub" :class="{ rw: s.tag === '生产' }">{{ s.tag }}</span>
        <button class="icon-btn" title="编辑" @click.stop="openServerModal(s)">✎</button>
        <button class="icon-btn" title="删除（所有项目的引用一并解除）" @click.stop="removeServer(s)">✕</button>
      </div>
    </div>

    <!-- 底部：本机资源迷你监控常驻（CPU/内存 sparkline，3s 采样；− 收起为单行） -->
    <div class="res-foot">
      <template v-if="resOpen">
        <div class="rf-row" :title="cpuTitle">
          <span class="rf-label">CPU</span>
          <svg class="rf-spark" viewBox="0 0 100 22" preserveAspectRatio="none">
            <polyline :points="spark(cpuHist)" />
          </svg>
          <span class="rf-val" :class="lvl(lastCpu)">{{ lastCpu == null ? '—' : lastCpu + '%' }}</span>
        </div>
        <div class="rf-row" :title="memTitle">
          <span class="rf-label">内存</span>
          <svg class="rf-spark" viewBox="0 0 100 22" preserveAspectRatio="none">
            <polyline class="mem" :points="spark(memHist)" />
          </svg>
          <span class="rf-val" :class="lvl(memPct)">{{ memPct == null ? '—' : memPct + '%' }}</span>
        </div>
        <div v-for="d in disks" :key="d.drive" class="rf-row" :title="diskTitle(d)">
          <span class="rf-label rf-drive">{{ d.drive }}</span>
          <div class="rf-bar"><div class="rf-fill" :class="lvl(d.usedPct)" :style="{ width: Math.min(100, d.usedPct) + '%' }"></div></div>
          <span class="rf-val" :class="lvl(d.usedPct)">{{ d.usedPct }}%</span>
        </div>
      </template>
      <div class="rf-meta" :class="{ collapsed: !resOpen }" :title="collapsedTitle">
        <span class="rf-brand"><span class="dot"></span>SQLPilot v0.1</span>
        <span v-if="!resOpen && lastCpu != null" class="rf-val" :class="lvl(lastCpu)">{{ lastCpu }}%</span>
        <span v-if="resOpen" class="rf-dpapi">{{ store.secretsAvailable ? 'DPAPI ✓' : 'DPAPI ✗' }}</span>
        <button class="rf-toggle" :title="resOpen ? '收起资源监控' : '展开资源监控'" @click="resOpen = !resOpen">{{ resOpen ? '−' : '▤' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onUnmounted, reactive, ref, watch } from 'vue'
import { store, curSession, removeSession, createSessionInProject, TYPE_LABELS } from '../store'

const openConnModal = inject<(c?: any) => void>('openConnModal')!
const openProjectModal = inject<() => void>('openProjectModal')!
const openSessionModal = inject<(mode: 'new' | 'switch') => void>('openSessionModal')!
const openServerModal = inject<(s?: any) => void>('openServerModal')!
const openProjectEditor = inject<(p: any) => void>('openProjectEditor')!
const openArchiveView = inject<(p: any) => void>('openArchiveView')!

// ---------- 本机资源迷你监控（默认展开；收起即停表） ----------
const resOpen = ref(true)
const cpuHist = ref<number[]>([])
const memHist = ref<number[]>([])
const lastCpu = ref<number | null>(null)
const memPct = ref<number | null>(null)
const cpuTitle = ref('CPU 占用率（3 秒采样窗口）')
const memTitle = ref('内存占用')
const disks = ref<{ drive: string; totalBytes: number; freeBytes: number; usedPct: number }[]>([])
let resTimer: ReturnType<typeof setInterval> | null = null
const HIST = 40

/** 历史序列 → sparkline points（0..100 × 0..22 视区） */
function spark(hist: number[]): string {
  if (hist.length < 2) return ''
  return hist.map((v, i) => `${((i / (hist.length - 1)) * 100).toFixed(1)},${(21 - (Math.min(100, v) / 100) * 19).toFixed(1)}`).join(' ')
}
function lvl(v: number | null): string {
  return v == null ? '' : v > 90 ? 'danger' : v > 70 ? 'warn' : 'ok'
}
function fmtGB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(bytes > 100 * 1024 ** 3 ? 0 : 1)
}
async function pollRes(): Promise<void> {
  try {
    const r = await window.sqlpilot.sysResources()
    memPct.value = r.mem.usedPct
    memHist.value = [...memHist.value, r.mem.usedPct].slice(-HIST)
    if (r.cpu.usagePct != null) {
      lastCpu.value = r.cpu.usagePct
      cpuHist.value = [...cpuHist.value, r.cpu.usagePct].slice(-HIST)
    }
    cpuTitle.value = `CPU ${r.cpu.model} · ${r.cpu.cores} 线程 · 近 ${HIST} 个采样点`
    disks.value = (r.disks || []).slice(0, 5)
    memTitle.value = `内存已用 ${fmtGB(r.mem.totalBytes - r.mem.freeBytes)} / ${fmtGB(r.mem.totalBytes)} GB`
  } catch { /* 主进程忙时跳过本轮 */ }
}
function diskTitle(d: { drive: string; totalBytes: number; freeBytes: number; usedPct: number }): string {
  return `${d.drive} 共 ${fmtGB(d.totalBytes)} GB · 剩余 ${fmtGB(d.freeBytes)} GB · 已用 ${d.usedPct}%`
}
const collapsedTitle = computed(() =>
  `SQLPilot v0.1 · CPU ${lastCpu.value == null ? '—' : lastCpu.value + '%'} · 内存 ${memPct.value == null ? '—' : memPct.value + '%'} · ${store.secretsAvailable ? '密钥 DPAPI 加密' : 'DPAPI 不可用'} · 点 ▤ 展开资源监控`
)

function syncResTimer(): void {
  if (resOpen.value && !resTimer) {
    pollRes()
    resTimer = setInterval(pollRes, 3_000)
  } else if (!resOpen.value && resTimer) {
    clearInterval(resTimer)
    resTimer = null
  }
}
watch(resOpen, syncResTimer, { immediate: true })
onUnmounted(() => { if (resTimer) clearInterval(resTimer) })

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
  if (!(await window.sqlpilot.uiConfirm(`删除连接「${c.name}」？`, '已保存的密码将一并删除', true))) return
  await window.sqlpilot.deleteConn(c.id)
  store.cfg = await window.sqlpilot.getConfig()
}

async function removeProject(p: any) {
  if (!(await window.sqlpilot.uiConfirm(`删除项目「${p.name}」？`, '只解除引用，不删除磁盘文件；关联会话需要重新选择项目（挂载的服务器为全局资产，不受影响）', true))) return
  await window.sqlpilot.deleteProject(p.id)
  store.cfg = await window.sqlpilot.getConfig()
}

// ---------- 全局服务器 ----------
function openTerm(s: any) {
  // 直达该服务器的 shell；若当前会话项目未引用它，面板里仍可从列表手动打开其他服务器
  store.pendingTermServer = s
  store.workbench = 'terminal'
}

async function removeServer(s: any) {
  if (!(await window.sqlpilot.uiConfirm(`删除服务器「${s.name}」？`, `${s.user}@${s.host}:${s.port}\n所有项目对该服务器的引用将一并解除，已保存的密码一并删除`, true))) return
  await window.sqlpilot.deleteServer(s.id)
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
/* 底栏资源按钮：与版本号同排的小号轻量按钮 */
.foot-btn {
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-faint);
  border-radius: 7px;
  font-size: 11px;
  padding: 2px 9px;
  cursor: pointer;
  font-family: inherit;
}
.foot-btn:hover { color: var(--accent); border-color: var(--accent); }
.foot-btn.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }

/* ---- 底部资源迷你监控 ---- */
.res-foot { border-top: 1px solid var(--border); padding: 8px 12px 6px; font-size: 11px; color: var(--text-faint); flex-shrink: 0; margin-top: auto; /* 恒贴侧栏底部：吸收上方全部剩余空间（收起/展开都不悬浮） */ }
.rf-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.rf-label { width: 26px; font-size: 10.5px; letter-spacing: 1px; color: var(--text-faint); flex-shrink: 0; }
.rf-spark { flex: 1; height: 20px; min-width: 0; }
.rf-spark polyline { fill: none; stroke: var(--accent); stroke-width: 1.4; vector-effect: non-scaling-stroke; opacity: 0.85; }
.rf-spark polyline.mem { stroke: var(--green); }
.rf-val { width: 34px; text-align: right; font-family: var(--mono); font-size: 10.5px; flex-shrink: 0; }
.rf-val.ok { color: var(--green); }
.rf-val.warn { color: var(--yellow); }
.rf-val.danger { color: var(--red); font-weight: 700; }
.rf-meta { display: flex; align-items: center; gap: 8px; margin-top: 1px; }
.rf-brand { display: flex; align-items: center; }
.rf-dpapi { flex: 1; }
.rf-toggle {
  border: 1px solid var(--border); background: none; color: var(--text-faint);
  border-radius: 6px; width: 22px; height: 20px; cursor: pointer; font-size: 12px; line-height: 1;
}
.rf-toggle:hover { color: var(--text); border-color: var(--border-strong); }
/* 磁盘微型条形（存量指标用条形而非趋势线） */
.rf-drive { font-family: var(--mono); font-weight: 700; letter-spacing: 0; text-align: left; }
.rf-bar { flex: 1; height: 6px; border-radius: 3px; background: var(--bg-card-hover); overflow: hidden; }
.rf-fill { height: 100%; border-radius: 3px; transition: width 0.5s ease; }
.rf-fill.ok { background: var(--accent); opacity: 0.7; }
.rf-fill.warn { background: var(--yellow); }
.rf-fill.danger { background: var(--red); }
/* 收起态：整个区域压到最底、高度最小化（一行 10.5px 字 + 24px 总高） */
.res-foot:not(:has(.rf-row)) { padding: 3px 10px; }
.rf-meta.collapsed { margin-top: 0; gap: 6px; min-height: 0; }
.rf-meta.collapsed .rf-brand { font-size: 10.5px; }
.rf-meta.collapsed .rf-toggle { width: 20px; height: 18px; font-size: 11px; }
.rf-meta.collapsed .rf-val { width: auto; font-size: 10px; }

.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); display: inline-block; margin-right: 5px; }
</style>
