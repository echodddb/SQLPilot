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
import ObAgentPanel from './ObAgentPanel.vue'
</script>

<style>
/* 只作用于独立浮窗这个窗口（主窗口没有 data-shell 属性）：
   窗口本身必须透明，否则圆角外面是一块直角实色。 */
html[data-shell='panel'],
html[data-shell='panel'] body {
  background: transparent !important;
  margin: 0 !important;
  padding: 0 !important;
  height: 100%;
  overflow: hidden;
  cursor: default;
}
html[data-shell='panel'] #app { height: 100%; }
html[data-shell='panel'] ::-webkit-scrollbar-corner { background: transparent; }
</style>

<style scoped>
.oaw {
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  /* 留白给阴影：透明窗口没有系统阴影，全靠这圈空间把浮层托起来 */
  padding: 9px;
  display: flex;
}
</style>
