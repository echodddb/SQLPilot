<template>
  <div v-if="sessions.length" class="wrap" :class="{ min }" :style="min ? undefined : { height: cloud.hostSshH + 'px' }">
    <!-- 上边界：仅在展开时存在，向下贴住窗口底部 -->
    <div v-if="!min" class="grip" title="拖动调整高度（向上=变高，双击复位）" @mousedown.prevent="startDrag" @dblclick="reset">
      <i></i>
    </div>

    <!-- 会话标签栏：最小化后它就是"任务栏"，每个连接都有独立标识 -->
    <div class="tabs">
      <span class="tabs-ico">⌗</span>
      <span class="tabs-lbl">SSH<em v-if="sessions.length > 1">{{ sessions.length }}</em></span>
      <button
        v-for="s in sessions"
        :key="s.id"
        class="tab"
        :class="{ on: cloud.hostSshActive === s.id, min }"
        :title="`${s.ip} · ${s.clusterName || '云管主机'}`"
        @click="selectHostSsh(s.id)"
      >
        <i class="dot" :class="s.id === cloud.hostSshActive ? 'on' : ''"></i>
        <span class="tab-ip mono">{{ s.ip }}</span>
        <span v-if="sessions.length > 1" class="tab-cl">{{ s.clusterName }}</span>
        <span class="tab-x" title="关闭该会话" @click.stop="closeHostSsh(s.id)">✕</span>
      </button>
      <span class="sp"></span>
      <button v-if="!min" class="hbtn" title="最小化到任务栏（会话保留）" @click="minimize">—</button>
      <button v-else class="hbtn" title="展开终端" @click="expand">▲</button>
    </div>

    <!-- 终端本体：所有会话都保持挂载，只是隐藏，切换/最小化都不断开 -->
    <div class="panes" v-show="!min">
      <div v-for="s in sessions" v-show="cloud.hostSshActive === s.id" :key="s.id" class="pane">
        <HostSshPane
          :platform-id="s.platformId"
          :ip="s.ip"
          :cluster-name="s.clusterName"
          :port="s.port"
          :active="cloud.hostSshActive === s.id && !min"
          @close="closeHostSsh(s.id)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 主机 SSH 分窗（多会话版，停靠在云管主区底部）。
 *
 * 三条硬约束：
 *   1) 最小化 = 收成任务栏，**不卸载组件**：xterm 缓冲与远端 shell 都保留，展开即恢复上次内容；
 *   2) 切换模块自动最小化，不回话、不断连；
 *   3) 每个会话在任务栏里都有独立 tab（IP + 集群 + 关闭 ✕），可随时切回来。
 * 分窗挂在 CloudView 层：放在页面内会跟着内容滚动，且变高只能向下生长。
 */
import { computed, onBeforeUnmount, watch } from 'vue'
import HostSshPane from './HostSshPane.vue'
import { cloud } from '../../../cloud/state'
import { closeHostSsh, selectHostSsh } from '../../../cloud/hostSsh'

const DEFAULT_H = 320
const MIN_H = 180

const sessions = computed(() => cloud.hostSshSessions)
const min = computed(() => cloud.hostSshMin)

let dragging = false
let startY = 0
let startH = 0

function reset(): void {
  cloud.hostSshH = DEFAULT_H
}
function minimize(): void {
  cloud.hostSshMin = true
}
function expand(): void {
  cloud.hostSshMin = false
}

/** 切模块就收成任务栏：不打断工作，也不让终端一直占半个屏幕 */
watch(
  () => cloud.view,
  () => {
    if (sessions.value.length) cloud.hostSshMin = true
  }
)

function startDrag(e: MouseEvent): void {
  dragging = true
  startY = e.clientY
  startH = cloud.hostSshH
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onDrag)
  window.addEventListener('mouseup', endDrag)
}

function onDrag(e: MouseEvent): void {
  if (!dragging) return
  const next = startH + (startY - e.clientY)
  const maxH = Math.round(window.innerHeight * 0.82)
  cloud.hostSshH = Math.min(Math.max(next, MIN_H), maxH)
}

function endDrag(): void {
  if (!dragging) return
  dragging = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', endDrag)
}

onBeforeUnmount(endDrag)
</script>

<style scoped>
.wrap {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-side);
  border-top: 1px solid var(--border-strong);
}
.wrap.min { height: 30px; }
.grip {
  height: 9px; margin: 0;
  display: flex; align-items: center; justify-content: center;
  cursor: row-resize; flex-shrink: 0; background: var(--bg-side);
}
.grip i { width: 46px; height: 3px; border-radius: 2px; background: var(--border-strong); opacity: 0.75; transition: background 0.12s, opacity 0.12s; }
.grip:hover i { background: var(--accent); opacity: 1; }

/* 会话标签栏 / 任务栏 */
.tabs {
  display: flex; align-items: center; gap: 4px;
  padding: 0 10px 6px; flex-shrink: 0; overflow-x: auto;
}
.wrap.min .tabs { height: 30px; padding: 0 10px; }
.tabs-ico { color: var(--accent); font-size: 12px; margin-right: 2px; }
/* 任务栏标识：SSH 字样 + 会话数，最小化时也能一眼看出"这里还挂着终端" */
.tabs-lbl {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600; color: var(--text); letter-spacing: 0.3px; margin-right: 4px;
}
.tabs-lbl em {
  font-style: normal; font-family: var(--mono); font-size: 9.5px;
  background: var(--accent-dim); color: var(--accent); border-radius: 99px; padding: 0 5px;
}
.tab {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 6px; padding: 2px 7px; font-size: 11px; font-family: inherit; cursor: pointer;
  white-space: nowrap; max-width: 240px;
}
.tab:hover { color: var(--text); border-color: var(--border-strong); }
.tab.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
/* 最小化态：卡片更像"任务栏项"，给一点存在感 */
.tab.min { border-radius: 5px; }
.tab.min.on { box-shadow: inset 0 -2px 0 var(--accent); }
.tab-ip { font-size: 11px; }
.tab-cl { font-size: 10px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; }
.tab.on .tab-cl { color: color-mix(in srgb, var(--accent) 70%, var(--text-faint)); }
.tab .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.tab .dot.on { background: var(--green); box-shadow: 0 0 0 2px var(--green-dim); }
.tab-x { font-size: 10px; color: var(--text-faint); padding: 0 1px; }
.tab-x:hover { color: var(--red); }
.sp { flex: 1; }
.hbtn {
  width: 22px; height: 20px; border-radius: 5px; border: 1px solid var(--border); background: var(--bg-input);
  color: var(--text-dim); font-size: 11px; line-height: 1; cursor: pointer; font-family: inherit; flex-shrink: 0;
}
.hbtn:hover { color: var(--text); border-color: var(--border-strong); }

/* 终端区：每个会话一层，非活动会话隐藏但保持挂载 */
.panes { flex: 1; min-height: 0; display: flex; padding: 0 10px 10px; }
.pane { flex: 1; min-width: 0; min-height: 0; display: flex; }
</style>
