<template>
  <!-- 自绘窗口控制按钮：替代原生 titleBarOverlay（原生按钮浮在一切之上，
       抽屉/弹窗的毛玻璃遮罩盖不住它、配色也对不上）。挂在 fixed 顶右，
       z-index 低于各弹层遮罩 —— 打开抽屉时按钮跟顶栏一起被虚化压暗，视觉统一 -->
  <div class="wc">
    <button class="wc-btn" title="最小化" aria-label="最小化" @click="min">
      <svg viewBox="0 0 10 10"><path d="M0 5 H10" /></svg>
    </button>
    <button class="wc-btn" :title="maxed ? '向下还原' : '最大化'" :aria-label="maxed ? '向下还原' : '最大化'" @click="max">
      <svg viewBox="0 0 10 10">
        <rect v-if="!maxed" x="0.5" y="0.5" width="9" height="9" />
        <template v-else>
          <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" />
          <rect class="wc-front" x="0.5" y="2.5" width="7" height="7" />
        </template>
      </svg>
    </button>
    <button class="wc-btn wc-x" title="关闭" aria-label="关闭" @click="close">
      <svg viewBox="0 0 10 10"><path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" /></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const maxed = ref(false)
let offMax: (() => void) | null = null

async function min(): Promise<void> { try { await window.sqlpilot.winMinimize() } catch { /* 忽略 */ } }
async function max(): Promise<void> { try { await window.sqlpilot.winMaxToggle() } catch { /* 忽略 */ } }
async function close(): Promise<void> { try { await window.sqlpilot.winClose() } catch { /* 忽略 */ } }

onMounted(async () => {
  try { maxed.value = !!(await window.sqlpilot.winIsMaximized()) } catch { /* 忽略 */ }
  offMax = window.sqlpilot.onWinMaxState((v) => { maxed.value = v })
})
onBeforeUnmount(() => { offMax?.() })
</script>

<style scoped>
.wc {
  position: fixed;
  top: 0;
  right: 0;
  height: var(--titlebar-h);
  display: flex;
  align-items: stretch;
  z-index: 80;
  /* 缝隙处仍是拖动区；按钮本体 no-drag。双击按钮区外的空隙=原生标题栏语义，双击可最大化 */
  -webkit-app-region: drag;
}
.wc-btn {
  width: 46px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: default;
  -webkit-app-region: no-drag;
}
.wc-btn svg { width: 10px; height: 10px; stroke: currentColor; stroke-width: 1; fill: none; }
.wc-btn:hover { background: color-mix(in srgb, var(--text) 12%, transparent); color: var(--text); }
.wc-btn:active { opacity: 0.65; }
/* 关闭键沿用 Windows 惯例的红色悬停 */
.wc-btn.wc-x:hover { background: #e81123; color: #fff; }
/* 还原态图标的前方块要盖住后面那圈的线，填顶栏同色 */
.wc-btn :deep(.wc-front) { fill: var(--bg-side); }
</style>
