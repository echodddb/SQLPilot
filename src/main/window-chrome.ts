import { BrowserWindow, nativeTheme } from 'electron'

/**
 * 窗口标题栏（- □ ×）。
 *
 * 早期用 `titleBarOverlay` 让系统画按钮，但原生非客户区永远浮在网页之上：
 * 抽屉/弹窗的毛玻璃遮罩盖不住它、颜色也对不上（虚化背景上贴一块实色，很突兀），
 * 且那个角落的点击会被系统吃掉，抽屉头部控件会被压住。
 * 现改为渲染层自绘按钮（WindowControls.vue）+ IPC 控制窗口，本文件只负责
 * 让系统原生控件（下拉箭头、滚动条、系统对话框）跟随主题。
 */

export type ThemeName = 'dark' | 'light'

/** 与 styles.css 里的 --titlebar-h / .topbar 高度保持一致 */
export const TITLEBAR_HEIGHT = 54

/** 让原生控件跟随主题（自绘按钮的配色由渲染层 CSS 变量负责） */
export function applyTitleBar(theme: ThemeName, _win?: BrowserWindow | null): void {
  nativeTheme.themeSource = theme
}
