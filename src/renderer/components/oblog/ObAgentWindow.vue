<template>
  <div class="oaw">
    <ObAgentPanel detached />
  </div>
</template>

<script setup lang="ts">
/**
 * 独立浮窗的根组件（主进程用 `?panel=obagent` 加载同一个 index.html）。
 *
 * 只做两件事：铺一层透明留白（圆角与阴影才不会被窗口边缘切掉）、
 * 把 ObAgentPanel 以 detached 模式挂上去。状态由主窗口通过主进程交接过来。
 */
import { watch } from 'vue'
import { obAgent } from '../../oblog/agent'
import ObAgentPanel from './ObAgentPanel.vue'

// 任务栏按钮的标题就是页面标题：带上目标服务器，一眼看出这一格在排哪台机器
watch(
  () => [obAgent.serverName, obAgent.host],
  () => {
    const w = [obAgent.serverName, obAgent.host].filter(Boolean).join(' ')
    document.title = w ? `故障排查 · ${w}` : '故障排查'
  },
  { immediate: true }
)
</script>

<style>
/* 只作用于独立浮窗这个窗口（主窗口没有 data-shell 属性）：
   窗口本身必须透明，否则圆角外面是一块直角实色。 */
html[data-shell='panel'],
html[data-shell='panel'] body,
html[data-shell='panel'] #app {
  background: transparent !important;
  margin: 0 !important;
  padding: 0 !important;
  height: 100%;
  overflow: hidden;
  cursor: default;
}
/* 主界面背景是「细网格 + 两支氛围光」，画在 body 的伪元素上（fixed + inset:0）。
   只清 body 的 background 洗不掉它们，透明留白里会浮出一层灰蓝色底 —— 这就是
   独立窗口周围那圈「奇怪的背影」。浮窗里必须整层摘掉。 */
html[data-shell='panel'] body::before,
html[data-shell='panel'] body::after {
  display: none !important;
}


html[data-shell='panel'] ::-webkit-scrollbar-corner { background: transparent; }
</style>

<style scoped>
.oaw {
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  /* 只留一点点，避免圆角边缘被窗口边界切硬；不再需要给阴影留白 */
  padding: 3px;
  display: flex;
}
</style>
