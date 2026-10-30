<template>
  <div class="sidebar">
    <!-- 项目树（ZCode workspace→task 式）：项目=父节点，会话/归档=子节点。
         每项目会话首屏 5 条，"显示更多"每次 +5；点击项目行展开/收起 -->
    <div class="side-head">
      <span>项目</span>
      <!-- 会话没挂项目时在这里提醒（原来挂在顶栏，跟模式开关挤；项目的事留在项目区说） -->
      <span
        v-if="showProjMiss"
        class="proj-miss"
        title="当前会话还没有挂项目，点击选择一个"
        @click="openSessionModal('switch')"
      >⚠ 未选择项目</span>
      <span class="proj-acts">
        <button class="icon-btn" title="新建会话（当前/最近项目；无项目时先选择）" @click="newSessionClick">＋</button>
        <button class="icon-btn" title="新建项目（选择文件夹）" @click="openProjectModal()">▣</button>
      </span>
    </div>
    <div class="session-list">
      <div v-if="!store.cfg?.projects?.length && !sessionGroups.some(g => g.key === '__none__')" class="side-empty" style="padding: 4px 16px 10px">
        无项目。会话必须挂在一个项目下——点击 <b>▣</b> 选择文件夹创建。
      </div>
      <template v-for="g in sessionGroups" :key="g.key">
        <!-- 项目行：点击展开/收起（ZCode：点击 workspace 行切换 task list） -->
        <div
          class="proj-row"
          :class="{ active: curSession()?.meta.projectId === g.key }"
          :title="g.key === '__none__' ? '未绑定项目的会话' : `${projPath(g.key)}\n单击：展开/收起会话 ｜ 右键：更多操作`"
          @click="toggleGroup(g.key)"
          @contextmenu.prevent="g.key !== '__none__' && openProjectMenu($event, projOf(g.key))"
        >
          <span class="chev">{{ collapsed.has(g.key) ? '▸' : '▾' }}</span>
          <span class="name">{{ g.label }}</span>
          <span v-if="g.ids.length" class="cnt">{{ g.ids.length }}</span>
          <span v-if="curSession()?.meta.projectId === g.key" class="sub cur">当前</span>
          <button v-if="g.key !== '__none__'" class="icon-btn" title="在此项目下新建会话" @click.stop="newSessionFor(g.key)">＋</button>
          <button v-if="g.key !== '__none__'" class="icon-btn" title="编辑项目属性（数据库/服务器）" @click.stop="openProjectEditor(projOf(g.key))">✒</button>
        </div>

        <template v-if="!collapsed.has(g.key)">
          <!-- 会话子行：首屏 5 条（ZCode 规则），显示更多每次 +5 -->
          <div
            v-for="id in g.ids.slice(0, visibleOf(g.key))"
            :key="id"
            class="session-item indent"
            :class="{ active: id === store.currentId }"
            @click="store.currentId = id"
            :title="store.sessions[id]?.meta.title"
          >
            <span class="mode-dot" :class="store.sessions[id]?.meta.mode"></span>
            <span class="name">{{ store.sessions[id]?.meta.title || '会话' }}</span>
            <span v-if="store.sessions[id]?.running" class="spinner" style="width:10px;height:10px"></span>
            <button class="icon-btn" :title="store.sessions[id]?.running ? '会话执行中，停止后才能归档' : '归档会话（总结对话到项目归档后移除）'" :disabled="store.sessions[id]?.running" @click.stop="removeSession(id)">▤</button>
          </div>
          <div v-if="g.ids.length > visibleOf(g.key)" class="show-more" @click="showMore(g.key)">
            显示更多（还有 {{ g.ids.length - visibleOf(g.key) }} 个会话）
          </div>
          <div v-if="!g.ids.length" class="session-item indent" style="pointer-events:none; opacity:.55">
            （暂无会话，点项目行的 ＋ 新建）
          </div>

          <!-- 归档入口（ZCode 归档平铺式改为弹窗）：点击弹出该项目全部归档，可恢复/继续/删除/清空 -->
          <div
            v-if="g.key !== '__none__'"
            class="archive-toggle"
            :title="`查看该项目归档：恢复会话 / 以总结为背景继续 / 清理（不再在侧栏里展开，避免项目树被撑长）`"
            @click="openArchive(projOf(g.key))"
          >
            <span class="chev">▤</span>
            <span>归档</span>
            <span style="flex:1"></span>
            <span class="arc-hint">查看 / 恢复 / 清理</span>
          </div>
        </template>
      </template>
    </div>

    <!-- 项目右键菜单 -->
    <div v-if="ctxMenu.show" class="ctx-mask" @click="ctxMenu.show = false" @contextmenu.prevent="ctxMenu.show = false">
      <div class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
        <div class="ctx-item" @click="ctxAction('edit')">✒　编辑项目属性</div>
        <div class="ctx-item" @click="ctxAction('new')">＋　新建会话</div>
        <div class="ctx-item" @click="ctxAction('archive')">▤　查看归档（弹窗）</div>
        <div class="ctx-item" @click="ctxAction('folder')">在资源管理器中打开</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item danger" @click="ctxAction('delete')">🗑　删除项目</div>
      </div>
    </div>

    <!-- 底部组：只留本机资源监控（数据库连接 / 服务器已各有独立一级模块，
         AI 对话侧栏不再重复挂它们的入口与清单） -->
    <div class="side-bottom">
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
      <div class="rf-meta" :title="collapsedTitle">
        <span class="rf-brand"><span class="dot"></span>SQLPilot v0.1</span>
        <span v-if="!resOpen" class="rf-mini" title="CPU / 内存占用（点 ▤ 展开趋势图）">
          <span class="rf-val" :class="lvl(lastCpu)">{{ lastCpu == null ? '—' : lastCpu + '%' }}</span>
          <span class="rf-sep">/</span>
          <span class="rf-val mem" :class="lvl(memPct)">{{ memPct == null ? '—' : memPct + '%' }}</span>
        </span>
        <span class="rf-flex"></span>
        <span class="rf-dpapi">{{ store.secretsAvailable ? 'DPAPI ✓' : 'DPAPI ✗' }}</span>
        <button class="rf-toggle" :title="resOpen ? '收起资源监控' : '展开资源监控'" @click="resOpen = !resOpen">{{ resOpen ? '−' : '▤' }}</button>
      </div>
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, reactive, ref, watch } from 'vue'
import { store, curSession, removeSession, createSessionInProject } from '../store'
import { useSysResources } from '../sysres'

const openProjectModal = inject<() => void>('openProjectModal')!
const openSessionModal = inject<(mode: 'new' | 'switch') => void>('openSessionModal')!
const openProjectEditor = inject<(p: any) => void>('openProjectEditor')!
const openArchiveView = inject<(p: any) => void>('openArchiveView')!

/** 当前会话挂的项目名（空 = 没挂）：项目区据此显示「未选择项目」提醒 */
const boundProjectName = computed(() => {
  const pid = curSession()?.meta.projectId
  if (!pid) return ''
  return (store.cfg?.projects || []).find((p: any) => p.id === pid)?.name || ''
})

/**
 * 什么时候催「未选择项目」：只在 Agent 模块、已经打开某个会话、且本机已建过项目时。
 * 启动不自动打开会话（currentId 为空），此时没有"这个会话挂哪个项目"可谈；
 * 数据库 / 服务器 / 编辑器模块跟项目没关系；一个项目都没建的用户也没有可选项——
 * 这几种情况下常驻一条黄提示只会变成噪音（顶栏那个 badge 原本也只在 Agent 模块显示）。
 */
const showProjMiss = computed(
  () =>
    store.module === 'agent' &&
    !!store.currentId &&
    !boundProjectName.value &&
    (store.cfg?.projects?.length || 0) > 0
)

// ---------- 本机资源迷你监控 ----------
// 采样已抽到 renderer/sysres.ts 的单例：顶栏「资源概述」用的是同一份数据。
// 这里只管“展开/收起”的显示，不再自己起定时器 —— 两处各起一个轮询器会让
// 主进程的 CPU 差分窗口（两次请求的间隔）被交替调用切碎，双方都算不准。
const resOpen = ref(true)
const { cpuHist, memHist, lastCpu, memPct, cpuTitle, memTitle, disks, spark, lvl, diskTitle } = useSysResources()

const collapsedTitle = computed(() =>
  `SQLPilot v0.1 · CPU ${lastCpu.value == null ? '—' : lastCpu.value + '%'} · 内存 ${memPct.value == null ? '—' : memPct.value + '%'} · ${store.secretsAvailable ? '密钥 DPAPI 加密' : 'DPAPI 不可用'} · 点 ▤ 展开资源监控`
)

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
  // 归档改成弹窗（项目树只留一个入口行，不在树里展开条目）
  else if (action === 'archive') openArchive(p)
  else if (action === 'folder') await window.sqlpilot.openFolder(p.rootPath)
  else if (action === 'delete') await removeProject(p)
}

/** 打开某项目的归档弹窗（恢复 / 以总结为背景继续 / 删除 / 清空都在弹窗里） */
function openArchive(p: any): void {
  if (!p) return
  openArchiveView(p)
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
  else {
    collapsed.add(key)
    visibleSessions[key] = SESSION_PAGE // 收起重置分页（ZCode 规则：再次展开从默认 5 条开始）
  }
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
}

// ---------- 会话分页（ZCode：每项目首屏 5 条，显示更多 +5，不提供"收起显示"） ----------
const SESSION_PAGE = 5
const visibleSessions = reactive<Record<string, number>>({})
function visibleOf(key: string): number {
  return visibleSessions[key] ?? SESSION_PAGE
}
function showMore(key: string): void {
  visibleSessions[key] = visibleOf(key) + SESSION_PAGE
}

function projOf(key: string): any {
  return (store.cfg?.projects || []).find((p: any) => p.id === key)
}
function projPath(key: string): string {
  return projOf(key)?.rootPath || ''
}

// 当前会话切换/恢复时自动展开其所在分组——"当前"不应藏在折叠里
watch(() => store.currentId, (id) => {
  if (!id) return
  const pid = store.sessions[id]?.meta.projectId
  const key = pid && sessionGroups.value.some((g) => g.key === pid) ? pid : '__none__'
  if (collapsed.has(key)) toggleGroup(key)
}, { immediate: true })

function newSessionClick() {
  const projects = store.cfg?.projects || []
  if (!projects.length) {
    openProjectModal()
    return
  }
  const cur = curSession()?.meta.projectId
  if (cur && projects.some((p: any) => p.id === cur)) {
    void newSessionFor(cur)
    return
  }
  if (projects.length === 1) {
    void newSessionFor(projects[0].id)
    return
  }
  openSessionModal('new')
}

async function newSessionFor(projectId: string) {
  await createSessionInProject(projectId)
}

async function removeProject(p: any) {
  if (!(await window.sqlpilot.uiConfirm(`删除项目「${p.name}」？`, '只解除引用，不删除磁盘文件；关联会话需要重新选择项目（挂载的服务器为全局资产，不受影响）', true))) return
  await window.sqlpilot.deleteProject(p.id)
  store.cfg = await window.sqlpilot.getConfig()
}
</script>

<style scoped>
/* 项目区标题：字号与颜色提一档，和放大后的 ＋/▣ 同气 */
.side-head { font-size: 11.5px; color: var(--text-dim); }
/* 「未选择项目」提醒：项目区自己的事，样式压到最小，别抢项目名与 ＋/▣ 的位置。
   flex 允许收缩 + 省略号：侧栏最窄时宁可把文字截断，也不能把 ＋/▣ 顶出去。 */
.proj-miss {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  margin-right: 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  color: var(--yellow);
  background: var(--yellow-dim);
  border-radius: 99px;
  padding: 2px 7px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proj-miss:hover { background: color-mix(in srgb, var(--yellow) 26%, transparent); }
/* 项目树占满项目区剩余高度：底部连接/服务器清单撤掉后，这里不再需要 260px 的上限 */
.session-list { padding: 0 10px 8px; }
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
  padding: 7px 10px;
  border-radius: 9px;
  cursor: pointer;
  color: var(--text-dim);
  font-size: 13px;
}
.session-item:hover { background: var(--bg-card-hover); color: var(--text); }
.session-item.active { background: var(--accent-dim); color: var(--text); }
.session-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 权限模式点：放大 + 同色微光，扫一眼就能分出计划/只读/放开 */
.mode-dot {
  width: 9.5px; height: 9.5px; border-radius: 50%; flex-shrink: 0;
  background: var(--text-faint);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text-faint) 14%, transparent);
}
.mode-dot.plan { background: var(--purple); box-shadow: 0 0 0 2px color-mix(in srgb, var(--purple) 22%, transparent); }
.mode-dot.readonly { background: var(--green); box-shadow: 0 0 0 2px color-mix(in srgb, var(--green) 22%, transparent); }
.mode-dot.confirm { background: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
.mode-dot.session { background: var(--yellow); box-shadow: 0 0 0 2px color-mix(in srgb, var(--yellow) 24%, transparent); }
.mode-dot.yolo { background: var(--red); box-shadow: 0 0 0 2px color-mix(in srgb, var(--red) 24%, transparent); }

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
.side-bottom { margin-top: auto; display: flex; flex-direction: column; flex-shrink: 0; }
.res-foot { border-top: 1px solid var(--border); padding: 8px 12px 6px; font-size: 11px; color: var(--text-faint); flex-shrink: 0; }
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

/* ---- 项目树（ZCode workspace→task 式） ---- */
/* 项目区的符号整体放大一号：原来 ＋/✎/▤ 只有 13px、折叠箭头 10px，在 272px 侧栏里
   看着"没力气"。图标按钮统一成 24px 方块（hover 才亮底色），不靠 transform 放大（会发虚）。 */
.proj-acts { display: flex; gap: 5px; }
/* ✎ / ▤ / ＋ 这类字符本身笔画细，只放大字号仍然"发飘"：给一个常显的淡边框小方块当底座，
   hover 再亮主色。这样图标有轮廓托着，视觉重量才立得住（不用 transform，避免发虚）。 */
.proj-acts .icon-btn,
.proj-row .icon-btn,
.session-item .icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-card);
  font-size: 16px; line-height: 1; color: var(--text-dim);
  transition: color .14s ease, background .14s ease, border-color .14s ease;
}
.proj-acts .icon-btn {
  width: 27px; height: 27px; font-size: 17px;
  color: var(--text); border-color: var(--border-strong);
}
.proj-acts .icon-btn:hover,
.proj-row .icon-btn:hover,
.session-item .icon-btn:hover {
  color: var(--accent);
  background: var(--accent-dim);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}
.session-item .icon-btn {
  border-color: transparent; background: transparent; color: var(--text-faint);
}
.session-item:hover .icon-btn { color: var(--text-dim); }
.session-item .icon-btn:disabled {
  opacity: .35; cursor: not-allowed;
  background: transparent; border-color: var(--border); color: var(--text-faint);
}

.proj-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 9px; cursor: pointer;
  color: var(--text); font-weight: 700; font-size: 13px;
  transition: background 0.14s ease;
}
.proj-row:hover { background: var(--bg-card-hover); }
.proj-row.active { background: var(--bg-card-hover); }
/* 折叠箭头：实心三角放大 + 提亮（原来是 10px 的 text-faint，几乎看不见） */
.proj-row .chev {
  color: var(--text-dim); font-size: 13px; width: 13px; flex-shrink: 0;
  text-align: center; transition: color .14s ease;
}
.proj-row:hover .chev { color: var(--accent); }
.proj-row .cnt {
  font-size: 10.5px; font-weight: 700; color: var(--text-dim);
  background: var(--bg-card-hover); border-radius: 99px; padding: 1px 7px;
}
.proj-row .sub.cur {
  font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 99px;
  background: var(--accent-dim); color: var(--accent);
}
.session-item.indent { padding-left: 30px; }
.show-more {
  padding: 5px 10px 5px 30px; font-size: 11.5px; color: var(--text-faint); cursor: pointer;
  border-radius: 7px;
}
.show-more:hover { color: var(--accent); background: var(--bg-card-hover); }
.archive-toggle {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px 6px 26px; border-radius: 7px; cursor: pointer;
  font-size: 12.5px; color: var(--text-dim);
}
.archive-toggle:hover { color: var(--text); background: var(--bg-card-hover); }
.archive-toggle .chev {
  color: var(--text-dim); font-size: 14px; width: 14px; flex-shrink: 0; text-align: center;
}
.archive-toggle:hover .chev { color: var(--accent); }
.arc-hint { font-size: 10.5px; color: var(--text-faint); opacity: 0.85; }
/* 磁盘微型条形（存量指标用条形而非趋势线） */
.rf-drive { font-family: var(--mono); font-weight: 700; letter-spacing: 0; text-align: left; }
.rf-bar { flex: 1; height: 6px; border-radius: 3px; background: var(--bg-card-hover); overflow: hidden; }
.rf-fill { height: 100%; border-radius: 3px; transition: width 0.5s ease; }
.rf-fill.ok { background: var(--accent); opacity: 0.7; }
.rf-fill.warn { background: var(--yellow); }
.rf-fill.danger { background: var(--red); }
/* 收起态：整个区域压到最底、高度最小化（一行 10.5px 字 + 24px 总高） */
.res-foot:not(:has(.rf-row)) { padding: 3px 12px; }
/* 收起态仅由 .res-foot 的垂直 padding 压高度；两端位置由 flex spacer 锚定，
   收起态单独收窄 gap 防止单行内容（品牌+CPU/内存+DPAPI+按钮）在 272px 侧栏内溢出换行 */
.res-foot:not(:has(.rf-row)) .rf-meta { gap: 4px; }
.rf-flex { flex: 1; }
.rf-mini { display: flex; align-items: center; gap: 2px; font-family: var(--mono); }
.rf-mini .rf-val { width: auto; }
.rf-mini .rf-sep { color: var(--text-faint); font-size: 10px; }
.rf-mini .rf-val.mem { color: var(--green); }

.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); display: inline-block; margin-right: 5px; }
</style>
