<template>
  <nav class="module-nav" aria-label="功能模块">
    <button
      v-for="m in modules"
      :key="m.key"
      class="mn-item"
      :class="{ active: store.module === m.key }"
      :title="m.desc"
      @click="store.module = m.key"
    >
      <span class="mn-icon">{{ m.icon }}</span>
      <span class="mn-label">{{ m.label }}</span>
    </button>

    <span style="flex:1"></span>

    <!-- 底部：全局工具（非模块）——与上方模块入口明确分区 -->
    <button
      class="mn-item mn-tool"
      :title="theme === 'dark' ? '切换到日间模式' : '切换到夜间模式'"
      @click="toggleTheme()"
    >
      <span class="mn-icon">{{ theme === 'dark' ? '☀' : '☾' }}</span>
      <span class="mn-label">主题</span>
    </button>
    <button
      class="mn-item mn-tool"
      :class="{ active: store.settingsOpen }"
      title="设置（模型厂商 / 连接 / 审计 / 技能 / 通用）"
      @click="store.settingsOpen = !store.settingsOpen"
    >
      <span class="mn-icon">⚙</span>
      <span class="mn-label">设置</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { store } from '../store'

// 主题状态与切换由 App.vue 持有（applyTheme/setConfig 在那侧），此处仅注入使用
const { theme, toggle: toggleTheme } = inject<{ theme: { value: 'dark' | 'light' }; toggle: () => void }>('themeState')!

/** 一级功能模块：只做导航切换，模块内容渲染在 App.vue 按 module 分发 */
const modules = [
  { key: 'agent', icon: '◆', label: 'AI 助手', desc: 'AI 对话 · 数据库工作台 · SSH 终端（会话/项目/连接管理）' },
  { key: 'report', icon: '▤', label: '巡检报告', desc: '基于模板的数据库巡检报告生成（规划中，与 AI 无关）' }
] as const
</script>

<style scoped>
.module-nav {
  width: 64px;
  min-width: 64px;
  background: var(--bg-side);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 10px 0;
  gap: 4px;
}
.mn-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 10px 0 8px;
  border: none;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
  font-family: inherit;
  border-radius: 0;
  transition: color 0.14s ease, background 0.14s ease;
}
.mn-item:hover { color: var(--text); background: var(--bg-card-hover); }
.mn-item.active { color: var(--accent); background: var(--bg-card-hover); }
/* 左侧竖条指示当前模块 */
.mn-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2.5px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}
.mn-icon { font-size: 17px; line-height: 1; }
.mn-label { font-size: 10.5px; letter-spacing: 0.5px; }
</style>
