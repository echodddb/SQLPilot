<template>
  <SplashOverlay
    v-if="showSplash"
    :app-ready="splashAppReady"
    @exiting="appRevealed = true"
    @close="onSplashClosed"
  />
  <!-- 空闲锁屏：复用开机动画，必须手动点「解锁进入」才放行；挂在根上，所有模块都覆盖 -->
  <SplashOverlay
    v-if="locked"
    mode="lock"
    :app-ready="true"
    :idle-min="idleLimitMin"
    @close="unlock"
  />
  <div
    class="layout"
    :class="{ 'app-revealed': appRevealed }"
    :inert="locked ? '' : null"
    v-if="store.ready && curSession()"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <ModuleNav />
    <Sidebar v-if="store.module === 'agent'" />
    <div class="main-area">
      <!-- 顶栏：所有模块共用（含文本编辑），品牌标识 + 模块标识 + 模块级操作 -->
      <div class="topbar">
        <span class="logo">◆ SQLPilot</span>

        <span
          v-if="store.module === 'agent' && boundProject"
          class="badge blue"
          :title="`${boundProject.rootPath}（点击切换项目）`"
          style="cursor: pointer"
          @click="openSessionModal('switch')"
        >{{ boundProject.name }}</span>
        <span
          v-else-if="store.module === 'agent'"
          class="badge yellow"
          title="会话必须挂在一个项目下，点击选择"
          style="cursor: pointer"
          @click="openSessionModal('switch')"
        >⚠ 未选择项目</span>

        <span class="spacer"></span>

        <!-- 数据库控制台：独立一级模块，顶栏只保留模块标识与连接入口 -->
        <span
          v-if="store.module === 'db'"
          class="badge blue"
          title="独立模块：对象树 / 查询窗口 / 表数据编辑 / 库信息；每个查询标签页是独立数据库会话"
        >数据库控制台</span>

        <!-- 云管平台：OCP（调接口）与 Oracle（直连查库）两种平台，导航与切换在模块内部 -->
        <span
          v-if="store.module === 'cloud'"
          class="badge blue"
          :title="cloudBadgeTitle"
        >{{ cloudBadge }}</span>

        <!-- 服务器不是一级导航模块，靠侧栏「服务器」分组点进来；顶栏只给模块标识 -->
        <span
          v-if="store.module === 'server'"
          class="badge blue"
          title="SSH 会话 · 多标签终端 · SFTP 双栏传输（入口在左侧栏底部「服务器」分组）"
        >服务器 · SSH</span>

        <!-- 文本编辑：文件树 / 多标签 / 大文件与编码转换，状态栏在自身底部 -->
        <span
          v-if="store.module === 'editor'"
          class="badge blue"
          title="文本编辑器 · 多标签 / 语法高亮 / 正则替换 / 编码转换"
        >文本编辑</span>

        <button
          v-if="store.module === 'agent'"
          class="btn ghost"
          :class="{ on: store.chatFindOpen }"
          title="在对话中搜索（Ctrl+F）：匹配正文 / 代码块 / 工具输出，回车下一条、Shift+回车上一条"
          @click="store.chatFindOpen = !store.chatFindOpen"
        >⌕ 搜索</button>

        <button
          v-if="store.module === 'agent'"
          class="btn ghost"
          :class="{ on: store.artifactsOpen }"
          :title="`产物（Ctrl+Shift+A）：本次对话的查询结果 / DDL / 读写文件 / 命令输出${artifactCount ? '，共 ' + artifactCount + ' 项' : ''}`"
          @click="store.artifactsOpen = !store.artifactsOpen"
        >▦ 产物<span v-if="artifactCount" style="margin-left:5px;opacity:.75">{{ artifactCount }}</span></button>

        <!-- 未配置厂商时给一个明确 CTA，替代不可用的空下拉 -->
        <button
          v-if="store.module === 'agent' && !(store.cfg.providers || []).length"
          class="btn primary"
          title="先配置模型厂商（API Key / 型号），会话才能发起"
          @click="store.settingsOpen = true"
        >配置模型 →</button>
        <select
          v-else-if="store.module === 'agent'"
          :value="curSession().meta.providerId || store.cfg.activeProviderId || ''"
          style="min-width: 190px"
          title="当前会话使用的模型（各会话可不同）"
          @change="onProviderChange"
        >
          <option value="" disabled>— 选择模型 —</option>
          <option v-for="p in store.cfg.providers" :key="p.id" :value="p.id">{{ p.name }}（{{ p.model }}）</option>
        </select>

        <button
          v-if="store.module === 'db'"
          class="btn ghost"
          title="新增数据库连接（Oracle 11g/19c · OceanBase · MySQL）"
          @click="openConnModal()"
        >＋ 新建连接</button>

        <button
          v-if="store.module === 'server'"
          class="btn ghost"
          title="新建 SSH 会话（密码 / 私钥 / 跳板机）"
          @click="newServerSession"
        >＋ 新建会话</button>


      </div>

      <!-- AI 助手：对话为主视图；SSH 终端面板与任务栏挂在本模块下 -->
      <template v-if="store.module === 'agent'">
        <!-- ChatView 的 attrs 继承在运行中不稳定（style/v-show 未落到根元素），
             改由宿主 div 承担布局，子组件只管内容 -->
        <!-- 右侧「产物」栏：查询结果 / DDL / 文件 / 命令输出的结果预览（WorkBuddy 式） -->
        <div class="agent-row">
          <div class="chat-view-host">
            <ChatView />
          </div>
          <ArtifactsPanel v-if="store.artifactsOpen" />
        </div>

      <!-- 底部工作台面板（SSH 终端 / 本机资源）：首次打开后常驻 + v-show 显隐——隐藏不销毁，
           SSH 连接与回滚缓冲保留，重开恢复原样（切会话自动隐藏，见下方 watch） -->
        <WorkbenchPanel v-if="wbEverOpen" v-show="store.workbench === 'terminal'" @close="store.workbench = null" @destroy="wbEverOpen = false; store.workbench = null" />
        <Taskbar />
      </template>
      <ReportView v-else-if="store.module === 'report'" style="flex: 1; min-height: 0" />
      <TextEditorView v-else-if="store.module === 'editor'" style="flex: 1; min-height: 0" />
      <MaskingView v-else-if="store.module === 'masking'" style="flex: 1; min-height: 0" />
      <CloudView v-else-if="store.module === 'cloud'" style="flex: 1; min-height: 0" />

      <!-- 数据库控制台（独立一级模块）：v-show 保活——切到别的模块处理完再回来，
           查询标签页 / 结果集 / 未提交事务全部还在；只有 ✕ 关闭控制台才销毁 -->
      <DbWorkbenchView v-if="store.dbOpen" v-show="store.module === 'db'" style="flex: 1; min-height: 0" />

      <!-- 服务器模块（独立一级模块）：终端与 SSH 连接必须保活，切模块不能断线重连，
           所以首次进入后常驻 + v-show 显隐 -->
      <ServerView v-if="srvState.mounted || store.module === 'server'" v-show="store.module === 'server'" style="flex: 1; min-height: 0" />
    </div>

    <ConnManager v-if="connModal" :editing="connModalEditing" @close="closeConnModal" />
    <ServerSessionModal
      v-if="srvState.editing"
      :server="srvState.editing"
      :is-new="srvState.editingNew"
      @close="srvState.editing = null"
      @saved="reloadServerCfg"
    />
    <SettingsView v-if="store.settingsOpen" @close="store.settingsOpen = false" />
    <ConfirmModal v-if="store.confirmQueue.length" />
    <PreviewModal v-if="store.previewQueue.length" />
    <ArchiveModal v-if="archiveView" :project-id="archiveView.id" :project="archiveView.name" @close="archiveView = null" />
    <ProjectModal v-if="projectModal" @close="projectModal = false" @created="onProjectCreated" />
    <ProjectEditor v-if="projectEditorTarget" :project="projectEditorTarget" @close="projectEditorTarget = null" @saved="projectEditorTarget = null" />
    <SessionModal
      v-if="sessionModal"
      :mode="sessionModal"
      @close="sessionModal = null"
      @pick="onSessionPick"
      @create-project="sessionModal = null; projectModal = true"
    />
  </div>
  <div v-else class="empty-state"><div class="big">◆</div>加载中…</div>
  <!-- UI 操作反馈浮窗（归档/模式切换等；4 秒自动消失，不进会话消息流） -->
  <div class="toast-stack">
    <transition-group name="toast">
      <div v-for="t in store.toasts" :key="t.id" class="ui-toast">{{ t.text }}</div>
    </transition-group>
  </div>
  <!-- 拖入文件：松手用文本编辑器打开 -->
  <div v-if="dragActive" class="drop-hint">
    <div class="drop-box">松开鼠标，用「文本编辑」打开<div class="drop-sub">文件直接打开；文件夹会作为左侧文件夹树打开</div></div>
  </div>
  <!-- 归档进行中的前台提示（阶段事件驱动，done/error 自动消失） -->
  <div v-if="store.archiveProgress" class="archive-toast">
    <span class="spinner"></span>{{ store.archiveProgress.note }}
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { store, curSession, init, setSessionProvider, toPlain, createSessionInProject, bindSessionProject } from './store'
import SplashOverlay from './components/SplashOverlay.vue'
import Sidebar from './components/Sidebar.vue'
import ModuleNav from './components/ModuleNav.vue'
import ReportView from './components/ReportView.vue'
import MaskingView from './components/MaskingView.vue'
import Taskbar from './components/Taskbar.vue'
import ChatView from './components/ChatView.vue'
import TextEditorView from './components/TextEditorView.vue'
import SettingsView from './components/SettingsView.vue'
import DbWorkbenchView from './components/DbWorkbenchView.vue'
import ServerView from './components/server/ServerView.vue'
import { srv as srvState } from './server/state'
import CloudView from './components/cloud/CloudView.vue'
import { engineOf } from './cloud/engines'
import WorkbenchPanel from './components/WorkbenchPanel.vue'
import ArtifactsPanel from './components/artifacts/ArtifactsPanel.vue'
import { collectArtifacts } from './artifacts'
import ConnManager from './components/ConnManager.vue'
import ServerSessionModal from './components/server/ServerSessionModal.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import PreviewModal from './components/PreviewModal.vue'
import ArchiveModal from './components/ArchiveModal.vue'
import ProjectModal from './components/ProjectModal.vue'
import ProjectEditor from './components/ProjectEditor.vue'
import SessionModal from './components/SessionModal.vue'
import { edState } from './editor/session'
import { cloud } from './cloud/state'

const connModal = ref(false)

/** 顶栏产物角标：当前会话从工具结果推导出的产物数 */
const artifactCount = computed(() => collectArtifacts(curSession()?.msgs as any).length)
const connModalEditing = ref<any>(null)
const serverModal = ref(false)
const serverModalEditing = ref<any>(null)
const theme = ref<'dark' | 'light'>('dark')

// 启动画面：主进程用 SQLPILOT_NO_SPLASH=1 时会带 ?nosplash=1（开发时反复重启省得等 3 秒）
const showSplash = ref(new URLSearchParams(location.search).get('nosplash') !== '1')
// 主界面是否已放行：启动遮罩开始退场的同时翻成 true，两段动画叠成一次交叉溶解
const appRevealed = ref(!showSplash.value)
// 「应用已可用」= 配置读完且当前会话能渲染出来，否则收起启动画面会露出空窗口
const splashAppReady = computed(() => store.ready && !!curSession())

function onSplashClosed(): void {
  showSplash.value = false
  appRevealed.value = true
  // 从这一刻开始算空闲，别把用户停在启动画面上的时间也算进去
  lastActive = Date.now()
}

/* ---------------- 空闲锁屏 ----------------
   只要没操作（鼠标 / 键盘 / 滚轮 / 触摸）到点，就盖上开机动画；
   解锁只有一条路：手动点「解锁进入」（Esc 等效）。对全部模块生效，因为遮罩挂在根上。 */
const locked = ref(false)
/** 阈值来自配置（分钟，0 = 关闭） */
const idleLimitMin = computed(() => {
  const v = store.cfg?.lockIdleMin
  return typeof v === 'number' && v >= 0 ? v : 3
})

let lastActive = Date.now()
let idleTimer = 0
const ACTIVITY = ['mousemove', 'mousedown', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const

function markActive(): void {
  // 锁屏状态下不续命：遮罩上的任何操作都不算「已回来」，必须走按钮
  if (locked.value) return
  lastActive = Date.now()
}

function checkIdle(): void {
  if (locked.value || showSplash.value || !store.ready) return
  const min = idleLimitMin.value
  if (!min) return
  if (Date.now() - lastActive >= min * 60_000) locked.value = true
}

function lockNow(): void {
  if (locked.value || showSplash.value || !store.ready) return
  locked.value = true
}

function unlock(): void {
  locked.value = false
  lastActive = Date.now()
}

// 设置里改了阈值：从当下重新计时，避免刚放宽就立刻被锁
watch(idleLimitMin, () => (lastActive = Date.now()))

onMounted(() => {
  // index.html 里的极简骨架交给启动画面组件接管，别留着占一层
  document.getElementById('boot-veil')?.remove()

  ACTIVITY.forEach((e) => window.addEventListener(e, markActive, { passive: true, capture: true }))
  // 2s 巡检足够准（误差远小于分钟级阈值），比每次移动都重排定时器省
  idleTimer = window.setInterval(checkIdle, 2000)
  window.addEventListener('sqlpilot:lock', lockNow)
  window.addEventListener('keydown', onArtifactsKey)
})

onBeforeUnmount(() => {
  ACTIVITY.forEach((e) => window.removeEventListener(e, markActive, { capture: true }))
  window.clearInterval(idleTimer)
  window.removeEventListener('sqlpilot:lock', lockNow)
  window.removeEventListener('keydown', onArtifactsKey)
})

/** Ctrl+Shift+A 切换右侧产物栏（与 WorkBuddy「切换右侧栏」对齐） */
function onArtifactsKey(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== 'a') return
  if (store.module !== 'agent') return
  e.preventDefault()
  store.artifactsOpen = !store.artifactsOpen
}

/** 顶栏模块标识：当前接的是 OCP 还是直连 Oracle（平台在模块内切换，这里跟着变） */
const cloudActiveKind = computed(() => {
  const list = cloud.platforms
  const p = list.find((x) => x.id === cloud.activeId) || list[0]
  return p?.type === 'oracle' ? 'oracle' : 'ocp'
})
const cloudBadge = computed(() => {
  // 只做了架构预览的引擎：顶栏跟着显示它，别挂着 OceanBase
  if (cloud.preview) return `${engineOf(cloud.preview).name} 体系预览`
  return cloudActiveKind.value === 'oracle' ? 'Oracle 云管理' : 'OceanBase 云管理'
})
const cloudBadgeTitle = computed(() => {
  const e = cloud.preview ? engineOf(cloud.preview) : null
  if (e) return `云管平台：${e.name} 还没接真实接口，当前只有架构装配动画与占位页`
  return cloudActiveKind.value === 'oracle'
    ? '云管平台：Oracle 直连，直接查 v$ / dba_ 视图（RAC / 实例 / 存储 / 会话 / SQL / 备份 / DG / 作业）'
    : '云管平台：OceanBase 云平台（OCP）的集群 / 租户 / 主机 / 告警 / 任务'
})
const projectModal = ref(false)
const projectEditorTarget = ref<any>(null)
const sessionModal = ref<'new' | 'switch' | null>(null)
const archiveView = ref<{ id: string; name: string } | null>(null)
const dragActive = ref(false)

// 拖拽文件到窗口任意位置：交给文本编辑器打开（含任意扩展名，绕开文件对话框过滤器）
// 例外：服务器模块内部自己处理拖拽（SFTP 上传），不能被编辑器的全屏提示层抢走
function inServerModule(e: DragEvent): boolean {
  const el = e.target as HTMLElement | null
  return !!el?.closest?.('.sv')
}

function onDragOver(e: DragEvent): void {
  if (!e.dataTransfer?.types?.includes('Files')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  dragActive.value = !inServerModule(e)
}

function onDragLeave(e: DragEvent): void {
  if (e.relatedTarget) return
  dragActive.value = false
}

async function onDrop(e: DragEvent): Promise<void> {
  dragActive.value = false
  // 拖进服务器模块：交给 SFTP 面板自己上传，不要切到文本编辑器
  if (inServerModule(e)) return
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  const paths = files
    .map((f) => {
      try { return window.sqlpilot.getPathForFile(f) } catch { return '' }
    })
    .filter(Boolean)
  if (!paths.length) return
  // 文件夹 → 左侧文件夹树；文件 → 标签页
  const dirs: string[] = []
  const plain: string[] = []
  for (const p of paths) {
    try {
      const st = await window.sqlpilot.editorStatPath(p)
      if (st.ok && st.isDir) dirs.push(p)
      else plain.push(p)
    } catch { plain.push(p) }
  }
  if (dirs.length) edState.pendingFolder = dirs[0]
  if (plain.length) edState.pendingOpens.push(...plain)
  store.module = 'editor'
}

// 终端面板首次打开后常驻（v-if 只管挂载，v-show 管显隐）
const wbEverOpen = ref(false)
watch(() => store.workbench, (v) => {
  if (v === 'terminal') wbEverOpen.value = true
})

// 切换会话：终端面板与设置自动隐藏——点会话的意图就是去对话；
// 组件均保活，重开恢复隐藏前的样子（数据库控制台是独立模块，切会话不会动它）
watch(() => store.currentId, () => {
  if (store.workbench) store.workbench = null
  if (store.settingsOpen) store.settingsOpen = false
})

// 切换一级模块：收起底部工作台面板（终端/资源属于 AI 助手模块的会话上下文）。
// 数据库控制台与文本编辑状态由各自组件保活，切回来还是离开前的样子；
// 确认/预览弹窗不收，后台任务与审批跨模块仍可响应
watch(() => store.module, () => {
  if (store.workbench) store.workbench = null
  if (store.settingsOpen) store.settingsOpen = false
})

const boundProject = computed(() => {
  const pid = curSession()?.meta.projectId
  return pid ? (store.cfg?.projects || []).find((p: any) => p.id === pid) : null
})

function applyTheme(t: 'dark' | 'light') {
  theme.value = t
  document.documentElement.setAttribute('data-theme', t)
}

async function toggleTheme() {
  const next = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  store.cfg.theme = next
  await window.sqlpilot.setConfig(toPlain(store.cfg))
}

async function onProviderChange(e: Event) {
  await setSessionProvider((e.target as HTMLSelectElement).value)
}

function openConnModal(editing: any = null) {
  connModalEditing.value = editing
  connModal.value = true
}
function closeConnModal() {
  connModal.value = false
}

/** 顶栏「＋ 新建会话」：按钮只在服务器模块出现，走的也是模块内的 ServerSessionModal */
function newServerSession(): void {
  srvState.editingNew = true
  srvState.editing = { id: `srv_${Date.now()}_${Math.floor(Math.random() * 1000)}` }
}
// 主题状态注入 ModuleNav（底部工具组用）
provide('themeState', { theme, toggle: toggleTheme })
provide('openConnModal', openConnModal)
// 服务器全局注册表的编辑弹窗（侧栏/项目编辑器/模块顶栏共用同一个新弹窗，
// 旧 ServerManager 只有密码认证 + 基础字段，改一次会把跳板机/编码等字段写丢）
function openServerModalFn(server: any = null) {
  srvState.editingNew = !server
  srvState.editing = server ? { ...server } : { id: `srv_${Date.now()}_${Math.floor(Math.random() * 1000)}` }
}

async function reloadServerCfg(): Promise<void> {
  try { store.cfg = await window.sqlpilot.getConfig() } catch { /* 保留旧配置 */ }
}
provide('openServerModal', openServerModalFn)
function openProjectModalFn() {
  projectModal.value = true
}
function openSessionModal(mode: 'new' | 'switch') {
  sessionModal.value = mode
}
provide('openProjectModal', openProjectModalFn)
provide('openProjectEditor', (p: any) => { projectEditorTarget.value = p })
provide('openSessionModal', openSessionModal)
provide('openArchiveView', (p: any) => { archiveView.value = { id: p.id, name: p.name } })

async function onProjectCreated(project: any) {
  // 建好项目直接在该项目下开会话，一步到位
  projectModal.value = false
  sessionModal.value = null
  await createSessionInProject(project.id)
}

async function onSessionPick(projectId: string) {
  const mode = sessionModal.value
  sessionModal.value = null
  if (mode === 'switch') {
    await bindSessionProject(projectId)
  } else {
    await createSessionInProject(projectId)
  }
}

init().then(async () => {
  applyTheme(store.cfg.theme === 'light' ? 'light' : 'dark')
  // 以文件启动（双击关联/命令行）：直接切到文本编辑并打开
  try {
    const pending = await window.sqlpilot.editorPendingOpens()
    const ws = await window.sqlpilot.editorPendingWorkspace()
    if (pending?.length) edState.pendingOpens.push(...pending)
    if (ws) edState.pendingFolder = ws
    if (pending?.length || ws) store.module = 'editor'
  } catch { /* 忽略 */ }
})

// 二次实例再打开文件：同样切到编辑器
window.sqlpilot.onEditorOpenRequest((p) => {
  if (p?.paths?.length) edState.pendingOpens.push(...p.paths)
  if (p?.folder) edState.pendingFolder = p.folder
  if (p?.paths?.length || p?.folder) store.module = 'editor'
})
</script>

<style scoped>
/* 启动遮罩还在时主界面藏在它后面；遮罩开始退场，这里同步淡入，两段叠成一次交叉溶解。
   只动 opacity：给 .layout 加 transform 会让内部 position:fixed 的弹层失去视口基准。 */
.layout {
  opacity: 0;
  transition: opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1) 0.14s;
}
.layout.app-revealed {
  opacity: 1;
}

.drop-hint {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 10, 18, 0.55);
  backdrop-filter: blur(3px);
  pointer-events: none;
}
.drop-box {
  padding: 26px 38px;
  border-radius: 16px;
  border: 1.5px dashed var(--accent);
  background: var(--bg-card);
  color: var(--text);
  font-size: 15px;
  text-align: center;
  box-shadow: var(--shadow-lg);
}
.drop-sub {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--text-dim);
}
.toast-stack {
  position: fixed;
  right: 18px;
  bottom: 22px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 320;
  pointer-events: none;
  max-width: 380px;
}
.ui-toast {
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-lg);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.55;
  word-break: break-word;
}
.toast-enter-active, .toast-leave-active { transition: all 0.25s ease; }
.toast-enter-from { opacity: 0; transform: translateX(14px); }
.toast-leave-to { opacity: 0; transform: translateY(6px); }
.archive-toast {
  position: fixed;
  bottom: 26px;
  left: 50%;
  transform: translateX(-50%);
  /* 纯提示不拦截交互：toast 位于输入框上方区域，可点性必须穿透 */
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 18px;
  border-radius: 99px;
  background: var(--bg-card);
  border: 1px solid var(--accent);
  color: var(--text);
  font-size: 12.5px;
  box-shadow: var(--shadow-lg);
  z-index: 300;
  max-width: 80vw;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.archive-toast .spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--accent-dim);
  border-top-color: var(--accent);
  border-radius: 50%;
  flex-shrink: 0;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
