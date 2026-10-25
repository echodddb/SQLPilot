<template>
  <nav class="module-nav" :style="navPaint" aria-label="功能模块">
    <button
      v-for="m in modules"
      :key="m.key"
      class="mn-item"
      :class="{ active: store.module === m.key }"
      :title="m.desc"
      @click="go(m.key)"
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
import { nextTick, ref, watch, inject } from 'vue'
import { store, openDbConsole } from '../store'

// 主题状态与切换由 App.vue 持有（applyTheme/setConfig 在那侧），此处仅注入使用
const { theme, toggle: toggleTheme } = inject<{ theme: { value: 'dark' | 'light' }; toggle: () => void }>('themeState')!

/**
 * 切主题时这一列（首列独立合成层）出现过"computed 已是新底色、屏幕/截图仍是旧底色"的不同步；
 * 把主题变量解析后的实际颜色写进行内样式，用行内赋值确保重新绘制。值仍取自主题变量，不硬编码色板。
 */
const navPaint = ref<Record<string, string>>({})
function repaintNav(): void {
  const cs = getComputedStyle(document.documentElement)
  const bg = cs.getPropertyValue('--bg-side').trim()
  const border = cs.getPropertyValue('--border').trim()
  navPaint.value = bg ? { background: bg, borderRightColor: border || 'transparent' } : {}
}
watch(theme, () => { void nextTick(repaintNav) }, { immediate: true })

/** 一级功能模块：只做导航切换，模块内容渲染在 App.vue 按 module 分发 */
const modules = [
  { key: 'agent', icon: '◆', label: 'AI 助手', desc: 'AI 对话 · 会话/项目/连接管理' },
  { key: 'db', icon: '🗄', label: '数据库', desc: '数据库控制台：对象树 / 查询窗口 / 表数据编辑 / 库信息（独立模块，标签页保活）' },
  // 「服务器」是一级模块，入口就在这一列；侧栏底部的「服务器」分组只是全局注册表（AI 助手模块内），
  // 点某台机器会切到本模块并直接开终端，两者并不冲突
  { key: 'server', icon: '🖥', label: '服务器', desc: '服务器：SSH 多标签终端 / SFTP 双栏传输 / 跳板机与编码适配（独立模块，终端保活）' },
  { key: 'cloud', icon: '☁', label: '云管平台', desc: '云管平台：OceanBase（OCP 接口）+ Oracle（直连查 v$ 视图）' },
  { key: 'editor', icon: '✎', label: '文本编辑', desc: 'Notepad++ 式多标签文本编辑器：大文件秒开 / 语法高亮 / 正则替换 / 编码转换' },
  { key: 'masking', icon: '⛨', label: '脱敏工具', desc: '本地脱敏 Oracle AWR 等运维文件，规则按文件类型独立配置' },
  { key: 'report', icon: '▤', label: '巡检报告', desc: '基于模板的数据库巡检报告生成（规划中，与 AI 无关）' }
] as const

/** 数据库控制台首次进入要先挂载（之后由 v-show 保活），其余模块直接切 */
function go(key: (typeof modules)[number]['key']): void {
  if (key === 'db') openDbConsole()
  else store.module = key
}
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
  /* 与 body 的主题过渡一致；同时保证切主题时该列（独立合成层）每帧重新栅格化，
     不会残留上一主题的底色 */
  transition: background-color 0.25s ease, border-color 0.25s ease;
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
