import { BrowserWindow, nativeTheme } from 'electron'

/**
 * 窗口标题栏（- □ × 那一条）配色。
 *
 * 默认原生标题栏是系统白/浅灰，和应用暗色主题并排时像贴了一条白纸。
 * 这里用 `titleBarStyle: 'hidden' + titleBarOverlay` 保留系统按钮、把底色交给我们，
 * 应用重启/切主题都要同步一次，否则切到浅色后按钮区还是深的。
 */

export type ThemeName = 'dark' | 'light'

/** 与 styles.css 里的 --bg-side 保持一致，标题栏才能和顶栏无缝 */
export const TITLEBAR_HEIGHT = 54

export const TITLEBAR_COLORS: Record<ThemeName, { color: string; symbolColor: string }> = {
  dark: { color: '#04060c', symbolColor: '#93a6c2' },
  light: { color: '#e9f0f9', symbolColor: '#52627a' }
}

/** 把标题栏配色同步到窗口（找不到窗口时静默跳过） */
export function applyTitleBar(theme: ThemeName, win?: BrowserWindow | null): void {
  const target = win || BrowserWindow.getAllWindows()[0]
  // 让原生控件（下拉箭头、滚动条、系统对话框）也跟着主题走
  nativeTheme.themeSource = theme
  if (!target || target.isDestroyed()) return
  const c = TITLEBAR_COLORS[theme]
  try {
    target.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: TITLEBAR_HEIGHT })
  } catch {
    // 窗口不是 hidden 标题栏时该 API 不可用（或旧系统不支持），忽略即可
  }
}
