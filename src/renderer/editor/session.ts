/** 编辑器跨组件状态：标签页常驻（切到 AI 助手再回来不丢文档），视图偏好持久化 */
import { reactive } from 'vue'
import type { Tab } from './types'

export interface FileHit {
  file: string
  rel: string
  line: number
  col: number
  text: string
}

export interface ResultsState {
  open: boolean
  query: string
  dir: string
  hits: FileHit[]
  files: number
  truncated: boolean
  busy: boolean
  error: string
}

const PREFS_KEY = 'sqlpilot.editor.prefs'

function loadPrefs(): any {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

const prefs = loadPrefs()

/** 旧版本只存了单个 workspaceRoot：迁移成列表，避免升级后丢文件夹 */
const savedRoots: string[] = Array.isArray(prefs.workspaceRoots)
  ? (prefs.workspaceRoots as unknown[]).filter((x): x is string => typeof x === 'string' && !!x)
  : []
const legacyRoot = typeof prefs.workspaceRoot === 'string' ? prefs.workspaceRoot : ''
if (legacyRoot && !savedRoots.some((r) => r.replace(/\\/g, '/').toLowerCase() === legacyRoot.replace(/\\/g, '/').toLowerCase())) {
  savedRoots.unshift(legacyRoot)
}

export const edState = reactive({
  tabs: [] as Tab[],
  activeId: '' as string,
  findOpen: false,
  replaceMode: false,
  /** 查找面板输入（跨标签共享，和 Notepad++ 一致） */
  query: '',
  replacement: '',
  matchCase: !!prefs.matchCase,
  wholeWord: !!prefs.wholeWord,
  regex: !!prefs.regex,
  results: {
    open: false,
    query: '',
    dir: '',
    hits: [],
    files: 0,
    truncated: false,
    busy: false,
    error: ''
  } as ResultsState,
  view: {
    lineNumbers: prefs.lineNumbers !== false,
    wrap: !!prefs.wrap,
    invisibles: !!prefs.invisibles,
    curLine: prefs.curLine !== false,
    brackets: prefs.brackets !== false
  },
  fontSize: typeof prefs.fontSize === 'number' ? prefs.fontSize : 13.5,
  tabSize: typeof prefs.tabSize === 'number' ? prefs.tabSize : 4,
  useSpaces: prefs.useSpaces !== false,
  autoClose: prefs.autoClose !== false,
  /** Markdown 显示方式：off=源码，live=即时渲染（Typora 式），preview=整页预览，split=左源码右预览 */
  mdView: (['live', 'preview', 'split'].includes(prefs.mdView) ? prefs.mdView : 'off') as 'off' | 'live' | 'preview' | 'split',
  recents: [] as { path: string; name: string; at: number }[],
  /** 启动参数/二次实例带来的待打开文件 */
  pendingOpens: [] as string[],
  /** 左侧文件夹树：可保存多个根目录，切换当前工作区 */
  workspaceRoots: savedRoots,
  workspaceRoot: (legacyRoot || savedRoots[0] || '') as string,
  workspaceOpen: !!(legacyRoot || savedRoots.length),
  /** 拖入文件夹时由 App 写入，编辑器消费 */
  pendingFolder: '' as string
})

export function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      lineNumbers: edState.view.lineNumbers,
      wrap: edState.view.wrap,
      invisibles: edState.view.invisibles,
      curLine: edState.view.curLine,
      brackets: edState.view.brackets,
      fontSize: edState.fontSize,
      tabSize: edState.tabSize,
      useSpaces: edState.useSpaces,
      autoClose: edState.autoClose,
      workspaceRoot: edState.workspaceRoot,
      workspaceRoots: edState.workspaceRoots,
      mdView: edState.mdView,
      matchCase: edState.matchCase,
      wholeWord: edState.wholeWord,
      regex: edState.regex
    }))
  } catch { /* 忽略 */ }
}

export function activeTab(): Tab | null {
  return (edState.tabs.find((t) => t.id === edState.activeId) as unknown as Tab) || null
}

export function removeTab(id: string): void {
  const i = edState.tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  edState.tabs.splice(i, 1)
  if (edState.activeId === id) {
    const next = edState.tabs[i] || edState.tabs[i - 1]
    edState.activeId = next ? next.id : ''
  }
}
