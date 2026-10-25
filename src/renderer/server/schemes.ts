import type { ITheme } from '@xterm/xterm'
import type { TermScheme } from '../../main/types'

/**
 * 终端配色。
 *
 * 只有 `follow` 需要区分日夜（取主题变量解析出的实际颜色）；其余都是固定色板——
 * 用户选「Monokai」就是要在白天也看到 Monokai，不该被主题漂白。
 *
 * ANSI 16 色必须成套给：只改背景不动调色板会让 `ls` 的红色目录在浅色板上看不见。
 */

export interface TermSchemeDef {
  id: TermScheme
  name: string
  /** 固定色板；follow 为 null，运行时从 CSS 变量取 */
  theme: ITheme | null
}

export const TERM_SCHEMES: TermSchemeDef[] = [
  { id: 'follow', name: '跟随主题', theme: null },
  {
    id: 'github',
    name: 'GitHub',
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      cursorAccent: '#0d1117',
      selectionBackground: '#264f78',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
      brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
    }
  },
  {
    id: 'mobaxterm',
    name: 'MobaXterm',
    theme: {
      background: '#000000',
      foreground: '#d9d9d9',
      cursor: '#00ff00',
      cursorAccent: '#000000',
      selectionBackground: '#264478',
      black: '#000000', red: '#cd0000', green: '#00cd00', yellow: '#cdcd00',
      blue: '#1e90ff', magenta: '#cd00cd', cyan: '#00cdcd', white: '#e5e5e5',
      brightBlack: '#7f7f7f', brightRed: '#ff0000', brightGreen: '#00ff00',
      brightYellow: '#ffff00', brightBlue: '#5c5cff', brightMagenta: '#ff00ff',
      brightCyan: '#00ffff', brightWhite: '#ffffff'
    }
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    theme: {
      background: '#fdf6e3',
      foreground: '#586e75',
      cursor: '#586e75',
      cursorAccent: '#fdf6e3',
      selectionBackground: '#dfd9c5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'monokai',
    name: 'Monokai',
    theme: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      cursorAccent: '#272822',
      selectionBackground: '#49483e',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
      blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e',
      brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4', brightWhite: '#f9f8f5'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff'
    }
  }
]

export function schemeName(id?: TermScheme): string {
  return TERM_SCHEMES.find((s) => s.id === id)?.name || '跟随主题'
}

/** 「跟随主题」时从 CSS 变量取色，保证和界面同源（换了主题变量这里自动跟着走） */
function followTheme(isLight: boolean): ITheme {
  const cs = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null
  const v = (name: string, fallback: string) => (cs?.getPropertyValue(name) || '').trim() || fallback
  return {
    background: v('--bg-code', isLight ? '#ffffff' : '#0d1117'),
    foreground: v('--text', isLight ? '#1f2433' : '#e6edf3'),
    cursor: v('--accent', isLight ? '#0969da' : '#1f6feb'),
    cursorAccent: v('--bg-code', isLight ? '#ffffff' : '#0d1117'),
    selectionBackground: isLight ? 'rgba(9,105,218,.22)' : 'rgba(31,111,235,.38)',
    // ANSI 用固定值：主题变量里没有 16 色语义，硬取会导致红色报错字与绿色成功字同色
    black: '#3b4048', red: '#e5534b', green: '#3fb950', yellow: '#c69026',
    blue: '#4184e4', magenta: '#a371f7', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ff938a', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
  }
}

export function themeFor(scheme: TermScheme | undefined, isLight: boolean): ITheme {
  if (!scheme || scheme === 'follow') return followTheme(isLight)
  return TERM_SCHEMES.find((s) => s.id === scheme)?.theme || followTheme(isLight)
}
