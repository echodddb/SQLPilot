<template>
  <div class="layout" v-if="store.ready && curSession()">
    <Sidebar />
    <div class="main-area">
      <div class="topbar">
        <span class="logo">◆ SQLPilot</span>

        <div class="mode-group" title="当前会话的权限模式（各会话独立）">
          <button
            v-for="m in MODES"
            :key="m.key"
            :title="m.tip"
            :class="{
              active: curSession().meta.mode === m.key,
              ok: m.key === 'readonly' && curSession().meta.mode === 'readonly',
              plan: m.key === 'plan' && curSession().meta.mode === 'plan',
              warn: m.key === 'session' && curSession().meta.mode === 'session',
              danger: m.key === 'yolo' && curSession().meta.mode === 'yolo'
            }"
            @click="setSessionMode(m.key)"
          >{{ m.label }}</button>
        </div>

        <span
          v-if="boundProject"
          class="badge blue"
          :title="`${boundProject.rootPath}（点击切换项目）`"
          style="cursor: pointer"
          @click="openSessionModal('switch')"
        >📁 {{ boundProject.name }}</span>
        <span
          v-else
          class="badge yellow"
          title="会话必须挂在一个项目下，点击选择"
          style="cursor: pointer"
          @click="openSessionModal('switch')"
        >⚠ 未选择项目</span>

        <span class="spacer"></span>

        <select
          :value="curSession().meta.providerId || store.cfg.activeProviderId || ''"
          style="min-width: 190px"
          title="当前会话使用的模型（各会话可不同）"
          @change="onProviderChange"
        >
          <option value="" disabled>— 选择模型 —</option>
          <option v-for="p in store.cfg.providers" :key="p.id" :value="p.id">{{ p.name }}（{{ p.model }}）</option>
        </select>

        <button class="theme-toggle" :title="theme === 'dark' ? '切换到日间模式' : '切换到夜间模式'" @click="toggleTheme">
          {{ theme === 'dark' ? '☀️' : '🌙' }}
        </button>

        <button
          class="btn ghost"
          :class="{ 'term-active': panel === 'terminal' }"
          title="底部工作台：SSH 终端（当前会话项目的服务器）"
          @click="panel = panel === 'terminal' ? null : 'terminal'"
        >
          🖥 终端
        </button>

        <button
          class="btn ghost"
          :class="{ 'term-active': panel === 'sql' }"
          title="底部工作台：SQL 控制台（直接执行语句）"
          @click="panel = panel === 'sql' ? null : 'sql'"
        >
          🗄 SQL
        </button>

        <button
          class="btn ghost"
          :class="{ 'term-active': store.view === 'objects' }"
          title="对象浏览器：双击表查看数据/结构/DDL（Navicat 式）"
          @click="store.view = store.view === 'objects' ? 'chat' : 'objects'"
        >
          🗃 对象
        </button>

        <button
          class="btn ghost"
          @click="store.view = store.view === 'settings' ? 'chat' : 'settings'" title="设置">
          ⚙ 设置
        </button>
      </div>

      <ChatView v-if="store.view === 'chat'" style="flex: 1; min-height: 0" />
      <ObjectsView v-else-if="store.view === 'objects'" style="flex: 1; min-height: 0" />
      <SettingsView v-else style="flex: 1; min-height: 0; display: flex; flex-direction: column" />
      <!-- 工作台面板独立于上方视图，切设置页不断开终端 -->
      <WorkbenchPanel v-if="panel" :tab="panel" @close="panel = null" @update:tab="(t) => (panel = t)" />
    </div>

    <ConnManager v-if="connModal" :editing="connModalEditing" @close="closeConnModal" />
    <ConfirmModal v-if="store.confirmQueue.length" />
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
</template>

<script setup lang="ts">
import { computed, provide, ref } from 'vue'
import { store, curSession, init, setSessionMode, setSessionProvider, MODES, toPlain, createSessionInProject, bindSessionProject } from './store'
import Sidebar from './components/Sidebar.vue'
import ChatView from './components/ChatView.vue'
import SettingsView from './components/SettingsView.vue'
import ObjectsView from './components/ObjectsView.vue'
import WorkbenchPanel from './components/WorkbenchPanel.vue'
import ConnManager from './components/ConnManager.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import ProjectModal from './components/ProjectModal.vue'
import ProjectEditor from './components/ProjectEditor.vue'
import SessionModal from './components/SessionModal.vue'

const connModal = ref(false)
const connModalEditing = ref<any>(null)
const theme = ref<'dark' | 'light'>('dark')
const projectModal = ref(false)
const projectEditorTarget = ref<any>(null)
const sessionModal = ref<'new' | 'switch' | null>(null)
const panel = ref<'terminal' | 'sql' | null>(null)

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
provide('openConnModal', openConnModal)
function openProjectModalFn() {
  projectModal.value = true
}
function openSessionModal(mode: 'new' | 'switch') {
  sessionModal.value = mode
}
provide('openProjectModal', openProjectModalFn)
provide('openProjectEditor', (p: any) => { projectEditorTarget.value = p })
provide('openSessionModal', openSessionModal)

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
