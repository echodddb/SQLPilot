/** 画布调色板：Canvas 读不到 CSS 变量的实时变化，必须在主题切换后
 *  重新 getComputedStyle 取一次并重绘，否则亮色主题下画布还是一块黑。 */
export interface Palette {
  dark: boolean
  bg: string
  surface: string
  text: string
  dim: string
  faint: string
  border: string
  accent: string
  grid: string
}

const FALLBACK: Record<string, string> = {
  '--bg': '#060910',
  '--bg-card': '#0c111c',
  '--text': '#dbe7f7',
  '--text-dim': '#93a6c2',
  '--text-faint': '#63758f',
  '--border': '#1b2438',
  '--accent': '#38bdf8'
}

export function isDarkTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') !== 'light'
}

export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string): string => cs.getPropertyValue(name).trim() || FALLBACK[name] || '#888'
  const dark = isDarkTheme()
  return {
    dark,
    bg: v('--bg'),
    surface: v('--bg-card'),
    text: v('--text'),
    dim: v('--text-dim'),
    faint: v('--text-faint'),
    border: v('--border'),
    accent: v('--accent'),
    grid: dark ? 'rgba(255,255,255,0.07)' : 'rgba(2,20,45,0.08)'
  }
}
