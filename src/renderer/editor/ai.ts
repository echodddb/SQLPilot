/**
 * 文本编辑器 · 选中文本 AI 问答（渲染层状态）
 *
 * 与三个云管助手不同：这里没有「读取范围」，上下文就是选中的那段文本（或选中的几个文件），
 * 所以只有一个可拖动/缩放的浮窗 + 多轮问答 + 历史会话。
 *
 * 历史会话存在主进程（userData/editor-ai.json），这里只维护列表与当前会话 id；
 * 浮窗位置与大小存 localStorage（纯界面偏好，丢了不影响功能）。
 */

import { reactive } from 'vue'

export interface EdAiSelection {
  /** 选中的原文 */
  text: string
  /** 文件名（只用于提示词与标题，不带绝对路径） */
  file: string
  /** 语言显示名（SQL / Markdown ...） */
  lang: string
  /** 选区行号（1-based） */
  start: number
  end: number
  /** 选区太长被截断了（只读了前 800 行） */
  truncated?: boolean
  /** 上下文是「整个文件」而不是一段选区 */
  wholeFile?: boolean
}

/** 一个文件作为上下文（由选择器读好正文后交进来） */
export interface EdAiFile {
  /** 绝对路径（只在本机用于去重 / 再次勾选，不进提示词） */
  path: string
  /** 文件名（不带目录） */
  name: string
  /** 语言显示名 */
  lang: string
  text: string
  /** 行数 */
  lines: number
  /** 超过单文件上限被截断 */
  truncated?: boolean
}

/** 浮窗上下文：一段选区，或选中的若干个文件 */
export interface EdAiMeta {
  /** 显示名：单文件是文件名，多文件是「a.sql 等 3 个文件」 */
  file: string
  lang: string
  start: number
  end: number
  truncated?: boolean
  wholeFile?: boolean
  /** 多文件时的文件名列表（提示词与历史条目都用它） */
  files?: string[]
}

/** 浮窗最小尺寸：再小对话就没法看了 */
export const EAI_MIN_W = 360
export const EAI_MIN_H = 300
/** 离窗口边缘留多少 */
const EDGE = 14
const POS_KEY = 'sqlpilot.editor.ai.pos'

export const edAi = reactive({
  open: false,
  selection: '' as string,
  meta: null as EdAiMeta | null,
  /** 多文件上下文（选区模式为空） */
  files: [] as EdAiFile[],
  /** 本次对话启用的技能（默认不勾；正文由主进程拼进系统提示） */
  skills: [] as string[],
  /** 文件选择器 */
  pickerOpen: false,
  /** 打开选择器时预勾的路径（点文件行 ✦ 进来的那个文件） */
  pickerSeed: [] as string[],
  /** 选择器正在读取文件 */
  pickerBusy: false,
  messages: [] as { id: string; role: 'user' | 'assistant'; text: string; at: number }[],
  input: '',
  streaming: false,
  streamText: '',
  reasoning: 0,
  error: '',
  /** 当前请求 id（流式事件按它匹配） */
  reqId: null as string | null,
  /** 当前会话 id（第一次回答成功后由主进程返回，用于继续这段对话） */
  sessionId: null as string | null,
  /** 历史会话面板 */
  historyOpen: false,
  history: [] as EditorAiSessionMeta[],
  historyLoading: false,
  /** 浮窗位置与大小；null = 默认贴在右下角 */
  x: null as number | null,
  y: null as number | null,
  w: null as number | null,
  h: null as number | null
})

let inited = false

export function initEditorAi(): void {
  if (inited) return
  inited = true
  restorePos()
  window.sqlpilot.onEditorAiEvent(onEvent)
}

// ---------------------------------------------------------------- 位置 / 大小

export function clampSize(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.max(min, max), v))
}

function restorePos(): void {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return
    const p = JSON.parse(raw) as { x: number; y: number; w?: number; h?: number }
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) {
      edAi.x = Math.max(EDGE, Math.min(Math.max(EDGE, window.innerWidth - 120), p.x))
      edAi.y = Math.max(EDGE, Math.min(Math.max(EDGE, window.innerHeight - 80), p.y))
    }
    if (Number.isFinite(p?.w)) edAi.w = Math.round(clampSize(p.w as number, EAI_MIN_W, window.innerWidth - EDGE * 2))
    if (Number.isFinite(p?.h)) edAi.h = Math.round(clampSize(p.h as number, EAI_MIN_H, window.innerHeight - EDGE * 2))
  } catch {
    /* 位置只是体验项 */
  }
}

export function saveEdAiPos(): void {
  try {
    if (edAi.x === null || edAi.y === null) localStorage.removeItem(POS_KEY)
    else localStorage.setItem(POS_KEY, JSON.stringify({ x: edAi.x, y: edAi.y, w: edAi.w, h: edAi.h }))
  } catch {
    /* 忽略 */
  }
}

/** 双击标题栏：回到默认的右下角 + 默认尺寸 */
export function resetEdAiSize(): void {
  edAi.x = null
  edAi.y = null
  edAi.w = null
  edAi.h = null
  saveEdAiPos()
}

/** 窗口变小或改分辨率时把浮窗收回来，别让它飘到看不见的地方 */
export function clampEdAiToViewport(): void {
  const maxW = Math.max(EAI_MIN_W, window.innerWidth - EDGE * 2)
  const maxH = Math.max(EAI_MIN_H, window.innerHeight - EDGE * 2)
  if (edAi.w !== null) edAi.w = Math.round(clampSize(edAi.w, EAI_MIN_W, maxW))
  if (edAi.h !== null) edAi.h = Math.round(clampSize(edAi.h, EAI_MIN_H, maxH))
  if (edAi.x !== null) edAi.x = Math.max(EDGE, Math.min(Math.max(EDGE, window.innerWidth - (edAi.w || 430) - EDGE), edAi.x))
  if (edAi.y !== null) edAi.y = Math.max(EDGE, Math.min(Math.max(EDGE, window.innerHeight - (edAi.h || 520) - EDGE), edAi.y))
}

// ---------------------------------------------------------------- 打开 / 关闭

/** 打开浮窗并换掉上下文（选新的文本再问 = 开一段新会话） */
export function openEditorAi(sel: EdAiSelection): void {
  if (edAi.selection && edAi.selection !== sel.text) {
    // 换了一段文本：上一段的问答不能留着，否则回答会张冠李戴
    edAi.messages = []
    edAi.streamText = ''
    edAi.error = ''
    edAi.reasoning = 0
    edAi.sessionId = null
  }
  edAi.selection = sel.text
  edAi.files = []
  edAi.meta = { file: sel.file, lang: sel.lang, start: sel.start, end: sel.end, truncated: !!sel.truncated, wholeFile: !!sel.wholeFile }
  edAi.open = true
  edAi.error = ''
  edAi.historyOpen = false
  // 顺手拉一下历史条数，头部「历史」上能直接看到有多少条
  void loadEditorAiHistory()
}

/**
 * 用若干个文件当上下文（选择器确认后调这里）。
 *
 * 正文按 `===== 文件：x =====` 分隔拼成一条 selection：
 * 主进程只认「一段上下文文本」，历史里也能原样回看是哪些文件。
 */
export function openEditorAiFiles(files: EdAiFile[]): void {
  const list = files.filter((f) => f && f.text.trim())
  if (!list.length) return
  const text = list.map((f) => `===== 文件：${f.name} =====\n${f.text}`).join('\n\n')
  const totalLines = list.reduce((a, f) => a + (f.lines || 0), 0)
  const langs = [...new Set(list.map((f) => f.lang).filter(Boolean))]
  const display = list.length === 1 ? list[0].name : `${list[0].name} 等 ${list.length} 个文件`
  if (edAi.selection && edAi.selection !== text) {
    edAi.messages = []
    edAi.streamText = ''
    edAi.error = ''
    edAi.reasoning = 0
    edAi.sessionId = null
  }
  edAi.files = list
  edAi.selection = text
  edAi.meta = {
    file: display,
    lang: langs.join(' / '),
    start: 1,
    end: totalLines || 1,
    truncated: list.some((f) => f.truncated),
    wholeFile: true,
    files: list.map((f) => f.name)
  }
  edAi.open = true
  edAi.error = ''
  edAi.historyOpen = false
  void loadEditorAiHistory()
}

/** 打开文件选择器（seed = 预先勾上的文件路径） */
export function openEditorAiPicker(seed: string[] = []): void {
  edAi.pickerSeed = seed
  edAi.pickerOpen = true
}

export function closeEditorAiPicker(): void {
  edAi.pickerOpen = false
  edAi.pickerBusy = false
}

export function closeEditorAi(): void {
  if (edAi.streaming) void stopEditorAi()
  edAi.open = false
  edAi.historyOpen = false
}

/** 清空当前这段对话（历史里已落盘的记录不受影响） */
export function clearEditorAi(): void {
  if (edAi.streaming) return
  edAi.messages = []
  edAi.streamText = ''
  edAi.error = ''
  edAi.reasoning = 0
  edAi.sessionId = null
}

// ---------------------------------------------------------------- 历史会话

export async function loadEditorAiHistory(): Promise<void> {
  edAi.historyLoading = true
  try {
    edAi.history = (await window.sqlpilot.editorAiSessions()) || []
  } catch {
    edAi.history = []
  } finally {
    edAi.historyLoading = false
  }
}

/** 没选中文本时点 AI 图标：直接打开浮窗并停在历史列表 */
export async function openEditorAiHistory(): Promise<void> {
  edAi.open = true
  edAi.historyOpen = true
  await loadEditorAiHistory()
}

export async function toggleEditorAiHistory(): Promise<void> {
  edAi.historyOpen = !edAi.historyOpen
  if (edAi.historyOpen) await loadEditorAiHistory()
}

/** 打开一条历史会话：选区与问答都从主进程回读，之后可以继续追问 */
export async function openEditorAiSession(id: string): Promise<void> {
  const s = await window.sqlpilot.editorAiSession(id).catch(() => null)
  if (!s) {
    edAi.error = '这条会话已不存在'
    return
  }
  edAi.selection = s.selection
  edAi.files = []
  edAi.meta = { file: s.file, lang: s.lang, start: s.lines.start, end: s.lines.end, truncated: s.truncated, wholeFile: s.wholeFile, files: s.files }
  edAi.messages = s.messages.map((m) => ({ id: m.id, role: m.role, text: m.text, at: m.at }))
  edAi.sessionId = s.id
  edAi.streamText = ''
  edAi.error = ''
  edAi.reasoning = 0
  edAi.open = true
  edAi.historyOpen = false
}

export async function removeEditorAiSession(id: string): Promise<void> {
  await window.sqlpilot.editorAiDelete(id).catch(() => null)
  if (edAi.sessionId === id) {
    edAi.sessionId = null
    edAi.messages = []
  }
  await loadEditorAiHistory()
}

// ---------------------------------------------------------------- 提问

export async function stopEditorAi(): Promise<void> {
  const id = edAi.reqId
  if (!id) return
  await window.sqlpilot.editorAiStop(id).catch(() => null)
}

/** 发送一条问题（text 为空则用输入框内容） */
export async function askEditorAi(text?: string): Promise<void> {
  const q = String(text ?? edAi.input).trim()
  if (!q || edAi.streaming) return
  if (!edAi.selection.trim()) {
    edAi.error = '先在编辑器里选中要问的文本'
    return
  }
  const history = edAi.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, text: m.text }))
  const id = `eai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  edAi.messages.push({ id: `u_${id}`, role: 'user', text: q, at: Date.now() })
  edAi.input = ''
  edAi.error = ''
  edAi.streamText = ''
  edAi.reasoning = 0
  edAi.streaming = true
  edAi.reqId = id
  const r: { ok: boolean; sessionId?: string; error?: string } = await window.sqlpilot
    .editorAiAsk({
      id,
      sessionId: edAi.sessionId,
      selection: edAi.selection,
      question: q,
      file: edAi.meta?.file,
      lang: edAi.meta?.lang,
      lines: edAi.meta ? { start: edAi.meta.start, end: edAi.meta.end } : undefined,
      truncated: !!edAi.meta?.truncated,
      wholeFile: !!edAi.meta?.wholeFile,
      files: edAi.meta?.files ? [...edAi.meta.files] : [],
      skills: [...edAi.skills],
      history
    })
    .catch((e: any) => ({ ok: false, error: e?.message || String(e) }))
  if (!r.ok) {
    edAi.streaming = false
    edAi.reqId = null
    edAi.error = r.error || '发送失败'
    // 发失败就把刚加的问题撤掉，免得列表里留一条「没有回答」的问题
    edAi.messages.pop()
    return
  }
  if (r.sessionId) edAi.sessionId = r.sessionId
}

function onEvent(ev: EditorAiEvent): void {
  if (!ev || ev.id !== edAi.reqId) return
  if (ev.type === 'start') {
    edAi.streaming = true
    edAi.streamText = ''
    edAi.reasoning = 0
    return
  }
  if (ev.type === 'reasoning') {
    edAi.reasoning = ev.chars
    return
  }
  if (ev.type === 'delta') {
    edAi.streamText += ev.text
    return
  }
  if (ev.type === 'done') {
    edAi.streaming = false
    edAi.streamText = ''
    edAi.reasoning = 0
    edAi.messages.push({ id: `a_${ev.id}`, role: 'assistant', text: ev.text, at: Date.now() })
    // 历史列表里已经多了一条（或标题变了），开着历史面板就顺手刷新
    if (edAi.historyOpen) void loadEditorAiHistory()
    return
  }
  edAi.streaming = false
  edAi.streamText = ''
  edAi.reasoning = 0
  edAi.error = ev.error
}

/** 浮窗标题用的选区摘要（`第 3-8 行 · 214 字符`） */
export function selSummary(meta: { start: number; end: number; wholeFile?: boolean; files?: string[] } | null, chars: number): string {
  if (!meta) return `${chars} 字符`
  if (meta.files && meta.files.length > 1) return `${meta.files.length} 个文件 · ${chars} 字符`
  if (meta.wholeFile) return `整篇 ${meta.end} 行 · ${chars} 字符`
  const range = meta.end > meta.start ? `第 ${meta.start}-${meta.end} 行` : `第 ${meta.start} 行`
  return `${range} · ${chars} 字符`
}

/** 相对时间（历史列表用） */
export function rel(ts: number): string {
  const diff = Date.now() - Number(ts || 0)
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  const d = new Date(Number(ts || 0))
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
