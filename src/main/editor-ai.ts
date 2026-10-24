/**
 * 文本编辑器 · 「针对选中文本提问」的 AI 通道（主进程）
 *
 * 与云管 AI 不同：这里没有平台数据、没有会话落盘，
 * 一次请求的上下文就是「用户选中的那段文本 + 浮窗里的几轮问答」，
 * 目的是解释 / 改写 / 找问题，而不是查库。
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config'
import { callLlm } from './agent/llm'
import { skillBlockFor } from './skill-context'
import { writeFileAtomic } from './atomic'
import type { ChatMsg } from './types'

export interface EditorAiTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface EditorAiAskInput {
  /** 本次请求 id（流式事件按它匹配，支持同时只有一问） */
  id: string
  /** 选中的文本 */
  selection: string
  question: string
  /** 文件显示名（不含绝对路径，只用于提示词里的「来自哪个文件」） */
  file?: string
  /** 语言显示名（Markdown / SQL / TypeScript ...） */
  lang?: string
  /** 选区行号（1-based），跨行时给范围 */
  lines?: { start: number; end: number }
  /** 同一浮窗里的历史问答（不含本次）；传了它就是「这段对话的完整前文」 */
  history?: EditorAiTurn[]
  /** 继续某段历史会话（不传则新建） */
  sessionId?: string | null
  /** 选区是否被截断（会话里记下来，历史列表能提示） */
  truncated?: boolean
  /** 上下文是整个文件（从工作区文件树发起），不是一段选区 */
  wholeFile?: boolean
  /** 多文件上下文：文件名列表（正文已经在 selection 里，按 ===== 文件：x ===== 分隔） */
  files?: string[]
  /** 本次启用的技能 id（正文拼进系统提示，不挂工具） */
  skills?: string[]
}

export type EditorAiEvent =
  | { type: 'start'; id: string }
  | { type: 'reasoning'; id: string; chars: number }
  | { type: 'delta'; id: string; text: string }
  | { type: 'done'; id: string; text: string }
  | { type: 'error'; id: string; error: string }

let send: (ev: EditorAiEvent) => void = () => {}
export function bindEditorAiEmitter(fn: (ev: EditorAiEvent) => void): void {
  send = fn
}

/** 正在生成的请求（点「停止」时中断） */
const running = new Map<string, AbortController>()

/** 选中文本上限：再长就不是「针对这段提问」而是「读整个文件」了 */
const MAX_SELECTION = 12000
/** 历史只带最近几轮，避免浮窗开久了把上下文撑爆 */
const MAX_HISTORY = 8

export function stopEditorAi(id: string): { ok: boolean } {
  const ctrl = running.get(String(id || ''))
  if (ctrl) {
    ctrl.abort()
    running.delete(String(id))
  }
  return { ok: true }
}

/** 系统提示（导出仅供单测检查文案与截断口径） */
export function editorSystemPrompt(input: EditorAiAskInput): string {
  const fileList = (input.files || []).filter(Boolean)
  const multi = fileList.length > 1
  const where = [
    input.file ? `文件：${input.file}` : '',
    multi ? `共 ${fileList.length} 个文件` : '',
    input.lang ? `语言：${input.lang}` : '',
    !multi && input.lines
      ? `选区：第 ${input.lines.start}${input.lines.end && input.lines.end !== input.lines.start ? `-${input.lines.end}` : ''} 行`
      : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const intro = multi
    ? `你是 SQLPilot 文本编辑器内置的 AI 助手：用户从工作区里选了 ${fileList.length} 个文件（${fileList.join('、')}），正在针对这些文件提问。上下文里每个文件以「===== 文件：文件名 =====」开头。`
    : '你是 SQLPilot 文本编辑器内置的 AI 助手：用户在编辑器里选中了一段文本，正在针对它提问。'
  const rule1 = multi
    ? '1. 只依据这几个文件的内容回答；跨文件对比、引用或给建议时，必须指明是哪个文件。需要文件以外的知识时，明确说这是推断。'
    : '1. 只依据「选中文本」回答；需要文本以外的知识时，明确说这是推断。'
  const rule3 = multi
    ? '3. 需要改写时，直接给可替换的完整文本（用 ``` 代码块包住，保留原有语言与缩进），并注明属于哪个文件；不要额外解释改了什么，除非用户问。'
    : '3. 需要改写时，直接给可替换的完整文本（用 ``` 代码块包住，保留原有语言与缩进），不要额外解释改了什么，除非用户问。'
  return [
    intro,
    where ? `\n${where}` : '',
    '',
    '## 回答要求',
    rule1,
    '2. 中文，简洁、可执行。解释类先给结论再给要点；找问题类按严重程度排序。',
    rule3,
    '4. 不要编造文本里不存在的变量名、表名、路径或数字；引用原文时保持原样。',
    multi
      ? '5. 如果用户问的与这些文件无关，一句话带过并提示「可以在左侧文件夹树里勾选相关文件再问」。'
      : '5. 如果用户问的与选中文本无关，一句话带过并提示「可以选中相关段落再问」。'
  ]
    .filter((x) => x !== '')
    .join('\n')
}

/** 多文件上下文的总字数上限：比单段选区宽一些，但也不能无限堆 */
const MAX_FILES_CHARS = 24000

/** 把上下文与问题拼成一条 user 消息（历史里只放纯问答文本） */
export function editorUserMessage(input: EditorAiAskInput): string {
  const fileList = (input.files || []).filter(Boolean)
  const multi = fileList.length > 1
  const cap = multi ? MAX_FILES_CHARS : MAX_SELECTION
  const selected = input.selection.length > cap
    ? `${input.selection.slice(0, cap)}\n…（上下文过长，已截断前 ${cap} 字符）`
    : input.selection
  if (multi) {
    return [
      `【上下文】共 ${fileList.length} 个文件：${fileList.join('、')}`,
      '每个文件以「===== 文件：文件名 =====」开头，内容在代码块里：',
      '```',
      selected,
      '```',
      '',
      '【问题】',
      input.question.trim()
    ].join('\n')
  }
  return ['【选中文本】', '```', selected, '```', '', '【问题】', input.question.trim()].join('\n')
}

// ---------------------------------------------------------------- 会话（历史）

export interface EditorAiSessionMeta {
  id: string
  /** 首个问题前 28 字 */
  title: string
  file: string
  lang: string
  lines: { start: number; end: number }
  /** 选中文本的字符数（列表里给个量级） */
  selectionChars: number
  /** 选区被截断过（只读了前 800 行） */
  truncated: boolean
  /** 整个文件作为上下文 */
  wholeFile: boolean
  /** 多文件上下文时的文件名列表（空数组 = 一段选区/单个文件） */
  files: string[]
  messageCount: number
  createdAt: number
  updatedAt: number
}

export interface EditorAiSessionDetail extends EditorAiSessionMeta {
  /** 选中的原文（新提问时作为上下文带给模型；历史回看也能看到） */
  selection: string
  messages: { id: string; role: 'user' | 'assistant'; text: string; at: number }[]
}

interface StoreShape {
  sessions: EditorAiSessionDetail[]
}

let cache: StoreShape | null = null

/** 会话条数上限：每条约 10KB 量级，留 60 条足够回看，又不至于把配置目录撑大 */
const MAX_SESSIONS = 60

function storeFile(): string {
  return path.join(app.getPath('userData'), 'editor-ai.json')
}

function normalizeSession(raw: any): EditorAiSessionDetail | null {
  if (!raw?.id) return null
  const messages = Array.isArray(raw.messages)
    ? raw.messages
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
        .map((m: any) => ({ id: String(m.id || `m_${Math.random().toString(36).slice(2, 8)}`), role: m.role, text: String(m.text), at: Number(m.at) || Date.now() }))
    : []
  return {
    id: String(raw.id),
    title: String(raw.title || '未命名对话'),
    file: String(raw.file || ''),
    lang: String(raw.lang || ''),
    lines: { start: Number(raw.lines?.start) || 1, end: Number(raw.lines?.end) || Number(raw.lines?.start) || 1 },
    selectionChars: Number(raw.selectionChars) || 0,
    truncated: !!raw.truncated,
    wholeFile: !!raw.wholeFile,
    files: Array.isArray(raw.files) ? raw.files.filter((x: any) => typeof x === 'string') : [],
    messageCount: messages.length,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    selection: String(raw.selection || ''),
    messages
  }
}

function loadStore(): StoreShape {
  if (cache) return cache
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as { sessions?: any[] }
    cache = { sessions: Array.isArray(data?.sessions) ? data.sessions.map(normalizeSession).filter((x): x is EditorAiSessionDetail => !!x) : [] }
  } catch {
    cache = { sessions: [] }
  }
  return cache
}

function saveStore(): void {
  if (!cache) return
  try {
    // 只留最近 N 条，避免无限增长
    cache.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    if (cache.sessions.length > MAX_SESSIONS) cache.sessions = cache.sessions.slice(0, MAX_SESSIONS)
    writeFileAtomic(storeFile(), JSON.stringify(cache, null, 2))
  } catch {
    /* 磁盘异常不影响本轮对话 */
  }
}

function metaOf(s: EditorAiSessionDetail): EditorAiSessionMeta {
  const { selection, messages, ...rest } = s
  return { ...rest, messageCount: messages.length }
}

/** 历史会话列表（最近更新在前） */
export function listEditorAiSessions(): EditorAiSessionMeta[] {
  return loadStore()
    .sessions.slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(metaOf)
}

export function getEditorAiSession(id: string): EditorAiSessionDetail | null {
  return loadStore().sessions.find((s) => s.id === id) || null
}

export function deleteEditorAiSession(id: string): { ok: boolean } {
  const st = loadStore()
  const n = st.sessions.length
  st.sessions = st.sessions.filter((s) => s.id !== id)
  if (st.sessions.length !== n) saveStore()
  return { ok: true }
}

function newSession(input: EditorAiAskInput): EditorAiSessionDetail {
  const now = Date.now()
  const title = input.question.replace(/\s+/g, ' ').trim().slice(0, 28) || '新对话'
  const sess: EditorAiSessionDetail = {
    id: `eai_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title,
    file: String(input.file || ''),
    lang: String(input.lang || ''),
    lines: input.lines ? { start: Number(input.lines.start) || 1, end: Number(input.lines.end) || 1 } : { start: 1, end: 1 },
    selectionChars: String(input.selection || '').length,
    truncated: !!input.truncated,
    wholeFile: !!input.wholeFile,
    files: (input.files || []).filter(Boolean),
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    selection: String(input.selection || ''),
    messages: []
  }
  loadStore().sessions.push(sess)
  return sess
}

/**
 * 发起一次提问；正文通过 editor:ai:event 流式回传。
 * 返回 ok 只代表「已开始」，最终结果看 done / error 事件。
 */
export async function askEditorAi(input: EditorAiAskInput): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const id = String(input?.id || '')
  const question = String(input?.question || '').trim()
  if (!id) return { ok: false, error: '缺少请求 id' }
  if (!question) return { ok: false, error: '请输入问题' }

  // 继续历史会话时用会话里存的选区（渲染层回看历史也一样）
  const existing = input.sessionId ? getEditorAiSession(String(input.sessionId)) : null
  const selection = existing ? existing.selection : String(input?.selection || '')
  if (!selection.trim()) return { ok: false, error: '先在编辑器里选中要问的文本' }
  if (running.has(id)) return { ok: false, error: '这一条还在生成中' }

  const cfg = loadConfig()
  const provider = cfg.providers.find((p) => p.id === cfg.activeProviderId) || cfg.providers[0]
  if (!provider) return { ok: false, error: '尚未配置大模型：请先在「设置」里选择厂商和模型' }

  const turns = (input.history || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, text: String(m.text) }))
  const history: ChatMsg[] = turns.map((m) => ({ role: m.role, content: m.text }))

  const ctx: EditorAiAskInput = { ...input, selection }
  const sess = existing || newSession(ctx)
  const ctrl = new AbortController()
  running.set(id, ctrl)

  void (async () => {
    let streamed = ''
    let pending = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    let reasoningChars = 0
    let rtimer: ReturnType<typeof setTimeout> | null = null
    const flush = (): void => {
      timer = null
      if (!pending) return
      send({ type: 'delta', id, text: pending })
      pending = ''
    }
    try {
      send({ type: 'start', id })
      const res = await callLlm(
        provider,
        [editorSystemPrompt(ctx), skillBlockFor(ctx.skills)].filter(Boolean).join('\n\n'),
        [...history, { role: 'user', content: editorUserMessage(ctx) }],
        [],
        {
          onText: (t: string) => {
            streamed += t
            pending += t
            // 合并 50ms 片段再发 IPC：逐字刷新会把渲染层压死
            if (!timer) timer = setTimeout(flush, 50)
          },
          onReasoning: (t: string) => {
            reasoningChars += t.length
            if (!rtimer) {
              rtimer = setTimeout(() => {
                rtimer = null
                send({ type: 'reasoning', id, chars: reasoningChars })
              }, 120)
            }
          }
        },
        { signal: ctrl.signal }
      )
      if (timer) clearTimeout(timer)
      flush()
      const text = (streamed || res.content || '').trim()
      if (!text) {
        if (!existing) deleteEditorAiSession(sess.id)
        send({ type: 'error', id, error: '模型没有返回内容' })
        return
      }
      // 成功才落盘：失败/中途停止不留下「问了没答」的半截会话
      const now = Date.now()
      sess.messages = [
        ...turns.map((m, i) => ({ id: `h_${id}_${i}`, role: m.role, text: m.text, at: now })),
        { id: `u_${id}`, role: 'user', text: question, at: now },
        { id: `a_${id}`, role: 'assistant', text, at: now + 1 }
      ]
      sess.selection = selection
      sess.selectionChars = selection.length
      sess.truncated = !!(existing ? existing.truncated : input.truncated)
      sess.wholeFile = !!(existing ? existing.wholeFile : input.wholeFile)
      if (!existing || (input.files && input.files.length)) sess.files = (input.files || []).filter(Boolean)
      if (!sess.file && input.file) sess.file = String(input.file)
      if (!sess.lang && input.lang) sess.lang = String(input.lang)
      if (input.lines && !existing) sess.lines = { start: Number(input.lines.start) || 1, end: Number(input.lines.end) || 1 }
      sess.updatedAt = now
      saveStore()
      send({ type: 'done', id, text })
    } catch (e: any) {
      if (timer) clearTimeout(timer)
      if (!existing) deleteEditorAiSession(sess.id)
      const msg = String(e?.message || e)
      send({ type: 'error', id, error: /abort/i.test(msg) ? '已停止' : msg })
    } finally {
      if (rtimer) clearTimeout(rtimer)
      running.delete(id)
    }
  })()

  return { ok: true, sessionId: sess.id }
}
