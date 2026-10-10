<template>
  <div class="layout" v-if="store.ready && curSession()">
    <ModuleNav />
    <Sidebar v-if="store.module === 'agent'" />
    <div class="main-area">
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
          v-if="store.module === 'agent'"
          class="btn ghost"
          :class="{ 'term-active': store.view === 'db' }"
          title="数据库工作台（查询窗口 / 对象树 / 表数据编辑；再点返回对话）"
          @click="store.view = store.view === 'db' ? 'chat' : 'db'">
          数据库
        </button>


      </div>

      <!-- 数据库工作台用 v-show 保活：切到聊天/设置再回来，查询窗口/表数据 tab 不丢 -->
      <!-- 三主视图统一 v-show 保活：切换回来时聊天滚动位置 / 工作台 tab / 设置表单草稿都不丢 -->
      <template v-if="store.module === 'agent'">
        <!-- ChatView 的 attrs 继承在运行中不稳定（style/v-show 未落到根元素），
             改由宿主 div 承担 v-show 与布局，子组件只管内容 -->
        <div v-show="store.view === 'chat'" class="chat-view-host">
          <ChatView />
        </div>
      <DbWorkbenchView v-show="store.view === 'db'" style="flex: 1; min-height: 0" />

      <!-- 底部工作台面板（SSH 终端 / 本机资源）：首次打开后常驻 + v-show 显隐——隐藏不销毁，
           SSH 连接与回滚缓冲保留，重开恢复原样（切会话自动隐藏，见下方 watch） -->
        <WorkbenchPanel v-if="wbEverOpen" v-show="store.workbench === 'terminal'" @close="store.workbench = null" />
      </template>
      <ReportView v-else style="flex: 1; min-height: 0" />
    </div>

    <ConnManager v-if="connModal" :editing="connModalEditing" @close="closeConnModal" />
    <ServerManager v-if="serverModal" :server="serverModalEditing" @close="serverModal = false; serverModalEditing = null" />
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
  <!-- 归档进行中的前台提示（阶段事件驱动，done/error 自动消失） -->
  <div v-if="store.archiveProgress" class="archive-toast">
    <span class="spinner"></span>{{ store.archiveProgress.note }}
  </div>
</template>

<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import { store, curSession, init, setSessionProvider, toPlain, createSessionInProject, bindSessionProject } from './store'
import Sidebar from './components/Sidebar.vue'
import ModuleNav from './components/ModuleNav.vue'
import ReportView from './components/ReportView.vue'
import ChatView from './components/ChatView.vue'
import SettingsView from './components/SettingsView.vue'
import DbWorkbenchView from './components/DbWorkbenchView.vue'
import WorkbenchPanel from './components/WorkbenchPanel.vue'
import ConnManager from './components/ConnManager.vue'
import ServerManager from './components/ServerManager.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import PreviewModal from './components/PreviewModal.vue'
import ArchiveModal from './components/ArchiveModal.vue'
import ProjectModal from './components/ProjectModal.vue'
import ProjectEditor from './components/ProjectEditor.vue'
import SessionModal from './components/SessionModal.vue'

const connModal = ref(false)
const connModalEditing = ref<any>(null)
const serverModal = ref(false)
const serverModalEditing = ref<any>(null)
const theme = ref<'dark' | 'light'>('dark')
const projectModal = ref(false)
const projectEditorTarget = ref<any>(null)
const sessionModal = ref<'new' | 'switch' | null>(null)
const archiveView = ref<{ id: string; name: string } | null>(null)

// 终端面板首次打开后常驻（v-if 只管挂载，v-show 管显隐）
const wbEverOpen = ref(false)
watch(() => store.workbench, (v) => {
  if (v === 'terminal') wbEverOpen.value = true
})

// 切换会话：非聊天视图（数据库工作台/设置）与终端面板自动隐藏——点会话的意图就是去对话；
// 组件均保活，重开恢复隐藏前的样子
watch(() => store.currentId, () => {
  if (store.view !== 'chat') store.view = 'chat'
  if (store.workbench) store.workbench = null
  if (store.settingsOpen) store.settingsOpen = false
})

// 切换一级模块：收起底部工作台面板（终端/资源属于 AI 助手模块的会话上下文）。
// view 保留——切回 AI 助手时回到离开前的工作台/设置页；确认/预览弹窗不收，
// 后台任务与审批跨模块仍可响应
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
// 主题状态注入 ModuleNav（底部工具组用）
provide('themeState', { theme, toggle: toggleTheme })
provide('openConnModal', openConnModal)
// 服务器全局注册表的编辑弹窗（侧栏/项目编辑器共用）
function openServerModalFn(server: any = null) {
  serverModalEditing.value = server
  serverModal.value = true
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

init().then(() => {
  applyTheme(store.cfg.theme === 'light' ? 'light' : 'dark')
})
</script>

<style scoped>
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
