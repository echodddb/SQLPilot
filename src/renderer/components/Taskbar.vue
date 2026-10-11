<template>
  <!-- 任务栏（Windows 式）：连接/服务器窗口入口；主体点击显示，− 隐藏保留状态，✕ 关闭销毁 -->
  <div v-if="store.tasks.length" class="taskbar">
    <button
      v-for="t in store.tasks"
      :key="t.id"
      class="task-btn"
      :class="{ active: isActive(t) }"
      :title="`${t.title}\n点击：显示窗口 ｜ −：隐藏（保留状态） ｜ ✕：关闭`"
      @click="activateTask(t)"
    >
      <span class="t-icon">{{ t.icon }}</span>
      <span class="t-title">{{ t.title }}</span>
      <span class="t-ops">
        <button class="t-op" title="隐藏（保留窗口状态）" @click.stop="minimizeTask(t)">−</button>
        <button class="t-op close" title="关闭并销毁" @click.stop="closeTask(t)">✕</button>
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { store, activateTask, minimizeTask, closeTask } from '../store'

/** 激活态：数据库任务 = 当前在工作台视图且是最近定位的连接；服务器任务 = 终端面板可见且为当前终端 */
function isActive(t: { kind: 'db' | 'server'; refId: string }): boolean {
  if (t.kind === 'db') return store.view === 'db' && store.lastDbConn === t.refId
  return store.workbench === 'terminal' && store.activeTermServerId === t.refId
}
</script>

<style scoped>
.taskbar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-side);
  flex-shrink: 0;
  overflow-x: auto;
}
.task-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-card);
  color: var(--text-dim);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  flex-shrink: 0;
  position: relative;
  transition: all 0.14s ease;
}
.task-btn:hover { color: var(--text); border-color: var(--border-strong); }
.task-btn.active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-dim);
}
.t-icon { font-size: 12px; line-height: 1; }
.t-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 操作按钮：默认低调，hover 任务时浮现 */
.t-ops { display: none; align-items: center; gap: 2px; }
.task-btn:hover .t-title { max-width: 120px; }
.task-btn:hover .t-ops { display: flex; }
.t-op {
  width: 18px; height: 18px;
  border: none; border-radius: 5px;
  background: var(--bg-card-hover);
  color: var(--text-faint);
  font-size: 11px; line-height: 1;
  cursor: pointer; padding: 0;
}
.t-op:hover { color: var(--text); background: var(--border); }
.t-op.close:hover { color: var(--red); }
</style>
