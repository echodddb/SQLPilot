<template>
  <div class="sv">
    <ServerSessionList
      @open="openServer"
      @new="newSession"
      @import="srv.importOpen = true"
      @prefs="srv.prefsOpen = true"
      @edit="editSession"
      @deleted="afterDelete"
      @sftp="srv.sftpOpen = true"
      @refresh="refreshCfg"
    />

    <div class="sv-main">
      <div class="sv-tabs">
        <div
          v-for="t in srv.tabs"
          :key="t.id"
          class="sv-tab"
          :class="{ active: t.id === srv.activeId, err: t.status === 'error', down: t.status === 'closed' }"
          :style="tabStyle(t)"
          :title="tabTitle(t)"
          @click="srv.activeId = t.id"
          @mousedown.middle.prevent="closeTab(t.id)"
        >
          <span class="sv-tab-dot" :class="t.status"></span>
          <span class="sv-tab-name">{{ t.title }}</span>
          <button class="sv-tab-x" title="关闭（中键也可）" @click.stop="closeTab(t.id)">✕</button>
        </div>

        <button v-if="activeServerCfg" class="sv-tab-new" title="同一台服务器再开一个终端" @click="openServer(activeServerCfg, true)">＋</button>

        <span style="flex:1"></span>

        <button class="sv-mini" :class="{ on: srv.sftpOpen }" title="SFTP 文件管理（左侧双栏）" @click="toggleSftp">SFTP</button>
      </div>

      <div class="sv-body">
        <!-- SFTP 在终端左侧（对齐 MobaXterm）：只在终端连接成功后挂载，连接中拉远程目录
             必然失败，提前挂载只会先闪一片红字错误 -->
        <template v-if="srv.sftpOpen && activeTabState && activeTabState.status === 'open'">
          <div class="sv-sftp" :style="{ width: srv.sftpW + 'px' }">
            <ServerSftpPane :key="activeTabState.serverId" :server-id="activeTabState.serverId" />
          </div>
          <div class="sv-drag" @mousedown="startSftpDrag" title="拖拽调整宽度"></div>
        </template>

        <div
          class="sv-term"
          :style="termStyle"
          @dragover.prevent="termDragOver = true"
          @dragleave="termDragLeave"
          @drop.prevent="dropToTerm"
        >
          <ServerTermPane
            v-for="t in srv.tabs"
            :key="t.id"
            :tab="t"
            :active="t.id === srv.activeId"
            @close="closeTab(t.id)"
          />

          <!-- 拖文件到终端 = 上传到当前远程目录（DBA 最常见的手势） -->
          <div v-if="termDragOver && activeTabState && activeTabState.status === 'open'" class="sv-drop">
            <div class="sv-drop-box">
              松开鼠标上传到
              <code>{{ termDropDir }}</code>
            </div>
          </div>

          <div v-if="!srv.tabs.length" class="sv-empty">
            <div class="sv-empty-icon">⌨</div>
            <div class="sv-empty-title">服务器</div>
            <div class="sv-empty-desc">
              从左侧选择一台服务器打开终端；本模块同时管理 SSH 会话、交互式终端与 SFTP 文件传输。
            </div>
            <div class="sv-empty-acts">
              <button class="sv-btn primary" @click="newSession">新建会话</button>
              <button class="sv-btn" @click="srv.importOpen = true">从 ~/.ssh/config 导入</button>
            </div>
            <div class="sv-empty-tip">
              支持密码 / 私钥（含口令）认证、跳板机登录、GBK 等非 UTF-8 编码、多标签、会话标识色、SFTP 双栏拖拽传输。
            </div>
          </div>
        </div>
      </div>

      <div v-if="srv.status || srv.toast" class="sv-status">
        <span class="sv-toast" v-if="srv.toast">{{ srv.toast }}</span>
        <span v-else>{{ srv.status }}</span>
        <span style="flex:1"></span>
        <span class="sv-count">{{ srv.tabs.length }} 个终端</span>
      </div>
    </div>

    <!-- 模块过场：切到「服务器」时播一次，涵盖全部发行版；不是每台服务器一个 -->
    <ServerIntro v-if="intro" @done="intro = false" />

    <!-- 会话编辑弹窗只在 App.vue 挂一份（同一个 srv.editing 状态，两边都渲染会叠两层遮罩） -->
    <ServerPrefsModal v-if="srv.prefsOpen" @close="srv.prefsOpen = false" @saved="refreshCfg" />
    <ServerImportModal v-if="srv.importOpen" @close="srv.importOpen = false" @imported="refreshCfg" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SshServerCfg } from '../../main/types'
import { store } from '../../store'
import {
  activeTab as activeTabOf, closeTabState, findServer, openTabState, srv, flash, pathFor, upsertTransfer, type TermTabState
} from '../../server/state'
import { startUpload } from '../../server/transfer-api'
import { colorOf } from '../../server/colors'
import ServerSessionList from './ServerSessionList.vue'
import ServerTermPane from './ServerTermPane.vue'
import ServerSftpPane from './ServerSftpPane.vue'
import ServerPrefsModal from './ServerPrefsModal.vue'
import ServerImportModal from './ServerImportModal.vue'
import ServerIntro from './ServerIntro.vue'
import '../../server/ui.css'

srv.mounted = true

const activeTabState = computed(() => activeTabOf())
const activeServerCfg = computed(() => {
  const t = activeTabState.value
  return t ? findServer(t.serverId) : undefined
})

/** 模块过场动画：每次切进「服务器」都播；播完停在就绪态等点击，也可直接跳过 */
const intro = ref(false)
watch(
  () => store.module,
  (v, old) => {
    // 动画不盖导航栏，播放期间用户可能直接切走：离开就卸掉，回来重新播一遍
    if (v !== 'server') intro.value = false
    else if (old !== 'server') intro.value = true
  },
  { immediate: true }
)

function tabTitle(t: { serverId: string; title: string }): string {
  const s = findServer(t.serverId)
  return s ? `${s.user}@${s.host}:${s.port || 22}` : t.title
}

/** 标签左侧的会话标识色（生产红/测试黄…）；没设色就不画条 */
function tabStyle(t: TermTabState): Record<string, string> {
  const c = colorOf(findServer(t.serverId))
  return c ? { '--tab-color': c } : {}
}

/** 终端顶部那条细色带：跟随当前激活会话的标识色，切标签立刻能看出"现在在哪台机器上" */
const termStyle = computed<Record<string, string>>(() => {
  const c = colorOf(activeServerCfg.value)
  return c ? { '--term-accent': c } : {}
})

// ---------- 拖文件到终端 = 上传到当前远程目录 ----------
const termDragOver = ref(false)
const termDropDir = computed(() => {
  const t = activeTabState.value
  return t ? (pathFor(t.serverId).remote || '/') : '/'
})

function termDragLeave(e: DragEvent): void {
  // 在子元素之间移动不算离开，否则提示框会闪
  const to = e.relatedTarget as Node | null
  if (to && (e.currentTarget as HTMLElement)?.contains(to)) return
  termDragOver.value = false
}

async function dropToTerm(e: DragEvent): Promise<void> {
  termDragOver.value = false
  const t = activeTabState.value
  if (!t) return
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  const paths = files.map((f) => window.sqlpilot.getPathForFile(f)).filter(Boolean)
  if (!paths.length) {
    await window.sqlpilot.uiAlert('无法获取拖入文件的本地路径', '请改用左侧 SFTP 面板的「上传」按钮。')
    return
  }
  if (t.status !== 'open') {
    await window.sqlpilot.uiAlert('终端尚未连接，无法上传')
    return
  }
  await startUpload(t.serverId, paths, pathFor(t.serverId).remote || '/')
  srv.remoteRefresh++
}

function openServer(server: SshServerCfg, newTab = false): void {
  if (!newTab) {
    const existed = srv.tabs.find((t) => t.serverId === server.id)
    if (existed) {
      srv.activeId = existed.id
      return
    }
  }
  srv.status = ''
  openTabState(server)
}

function closeTab(id: string): void {
  closeTabState(id)
}

function newSession(): void {
  srv.editingNew = true
  srv.editing = { id: `srv_${Date.now()}_${Math.floor(Math.random() * 1000)}` }
}

function editSession(server: SshServerCfg): void {
  srv.editingNew = false
  srv.editing = { ...server }
}

async function afterDelete(): Promise<void> {
  // 被删服务器的终端全部关闭，避免留下连不上的死标签
  await refreshCfg()
  const alive = new Set((store.cfg?.servers || []).map((s: any) => s.id))
  for (const t of [...srv.tabs]) {
    if (!alive.has(t.serverId)) closeTab(t.id)
  }
}

async function refreshCfg(): Promise<void> {
  try {
    store.cfg = await window.sqlpilot.getConfig()
  } catch { /* 保留旧配置 */ }
}

function toggleSftp(): void {
  srv.sftpOpen = !srv.sftpOpen
}

function startSftpDrag(e: MouseEvent): void {
  const startX = e.clientX
  const startW = srv.sftpW
  // SFTP 在左侧：向右拖 = 变宽（方向与放在右侧时相反）；上限与 CSS 的 max-width 60% 对齐
  const move = (ev: MouseEvent) => {
    srv.sftpW = Math.min(Math.max(startW + (ev.clientX - startX), 300), Math.round(window.innerWidth * 0.6))
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

/** 外部入口（AI 助手侧栏点服务器）也走这里：pendingTermServer 消费一次 */
watch(() => store.pendingTermServer, (s) => {
  if (!s) return
  // 只在本模块可见时消费，避免和 WorkbenchPanel 抢同一个槽
  if (store.module !== 'server') return
  store.pendingTermServer = null
  openServer(s as SshServerCfg)
}, { immediate: true })

/** 传输进度事件：模块级订阅一次（ServerView 常驻），SFTP 面板重挂载也不丢进度 */
let offProgress: (() => void) | null = null

onMounted(() => {
  offProgress = window.sqlpilot.onSftpProgress((p) => { upsertTransfer(p) })
  void refreshCfg()
})

onBeforeUnmount(() => {
  offProgress?.()
  offProgress = null
})
</script>

<style scoped>
/* position: relative 是过场动画的定位基准：ServerIntro 用 absolute inset:0 只盖模块内容区，
   不再压住左侧大模块导航（与数据库侧的架构动画摆放一致） */
.sv { position: relative; display: flex; height: 100%; min-height: 0; background: var(--bg); }
.sv-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }

.sv-tabs {
  display: flex; align-items: center; gap: 3px; padding: 5px 8px 0;
  background: var(--bg-side); border-bottom: 1px solid var(--border);
  overflow-x: auto; flex-shrink: 0; min-height: 34px;
}
.sv-tab {
  position: relative;
  display: flex; align-items: center; gap: 6px; padding: 4px 9px 4px 13px;
  border: 1px solid var(--border); border-bottom: none;
  border-radius: 7px 7px 0 0; cursor: pointer; font-size: 12px;
  color: var(--text-dim); background: var(--bg-card); max-width: 220px; flex-shrink: 0;
}
/* 会话标识色：左侧 3px 竖条，标签栏一眼区分生产/测试 */
.sv-tab::before {
  content: ''; position: absolute; left: 3px; top: 4px; bottom: 4px; width: 3px;
  border-radius: 2px; background: var(--tab-color, transparent);
}
.sv-tab:hover { color: var(--text); }
.sv-tab.active { color: var(--text); background: var(--bg); border-color: var(--border-strong); }
.sv-tab-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.sv-tab-dot.open { background: var(--green); }
.sv-tab-dot.connecting { background: var(--yellow); animation: sv-pulse 1s ease-in-out infinite; }
.sv-tab-dot.error { background: var(--red); }
.sv-tab-dot.closed { background: var(--text-faint); }
@keyframes sv-pulse { 50% { opacity: .3; } }
.sv-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sv-tab-x {
  border: none; background: none; color: var(--text-faint); cursor: pointer;
  font-size: 10px; padding: 0 1px; line-height: 1; font-family: inherit;
}
.sv-tab-x:hover { color: var(--red); }
.sv-tab-new {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; width: 22px; height: 22px; cursor: pointer; font-size: 12px;
  line-height: 1; font-family: inherit; flex-shrink: 0;
}
.sv-tab-new:hover { color: var(--accent); border-color: var(--accent); }
.sv-mini {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 2px 9px; cursor: pointer; font-family: inherit;
  flex-shrink: 0; margin-bottom: 3px;
}
.sv-mini:hover { color: var(--accent); border-color: var(--accent); }
.sv-mini.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }

.sv-body { flex: 1; display: flex; min-height: 0; }
.sv-term { flex: 1; position: relative; min-width: 0; background: var(--bg); }
/* 激活会话的标识色带（2px，贴在终端顶部，不占字符空间） */
.sv-term::after {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px;
  background: var(--term-accent, transparent); pointer-events: none; z-index: 3;
}
/* 拖文件到终端的落点提示 */
.sv-drop {
  position: absolute; inset: 6px; z-index: 6; display: flex; align-items: center; justify-content: center;
  border: 2px dashed var(--accent); border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  pointer-events: none;
}
.sv-drop-box {
  padding: 10px 18px; border-radius: 9px; font-size: 13px;
  background: var(--bg-card); border: 1px solid var(--border-strong); color: var(--text-dim);
  box-shadow: var(--shadow);
}
.sv-drop-box code { font-family: var(--mono); color: var(--accent); }
.sv-drag { width: 5px; cursor: ew-resize; flex-shrink: 0; background: transparent; }
.sv-drag:hover { background: var(--accent-dim); }
/* SFTP 在左侧：宽度上限 60%，再宽就把终端挤没了 */
.sv-sftp { flex-shrink: 0; border-right: 1px solid var(--border); min-width: 0; max-width: 60%; }

.sv-empty {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px; padding: 30px; text-align: center;
}
.sv-empty-icon { font-size: 40px; opacity: .35; }
.sv-empty-title { font-size: 16px; font-weight: 600; color: var(--text-dim); letter-spacing: 2px; }
.sv-empty-desc { font-size: 12.5px; color: var(--text-faint); max-width: 460px; line-height: 1.8; }
.sv-empty-acts { display: flex; gap: 8px; margin-top: 4px; }
.sv-empty-tip { font-size: 11.5px; color: var(--text-faint); margin-top: 6px; opacity: .8; }
.sv-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 7px; padding: 6px 16px; font-size: 12.5px; cursor: pointer; font-family: inherit;
}
.sv-btn:hover { color: var(--text); border-color: var(--border-strong); }
.sv-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }

.sv-status {
  display: flex; align-items: center; gap: 10px; padding: 3px 12px;
  font-size: 11px; color: var(--text-faint); background: var(--bg-side);
  border-top: 1px solid var(--border); flex-shrink: 0; min-height: 22px;
}
.sv-toast { color: var(--accent); }
.sv-count { color: var(--text-faint); }
</style>
