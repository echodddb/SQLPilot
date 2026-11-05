/**
 * OB 故障排查 Agent · 历史会话（主进程）
 *
 * 为什么存档放主进程而不是渲染层：
 *   1. 会话里有「agent 在目标机上跑了什么、输出是什么」，属于证据，需要落盘可追溯；
 *   2. 独立浮窗脱离/停靠会换窗口，渲染层内存里的东西会随窗口销毁，
 *      而历史必须跨窗口、跨重启都在；
 *   3. 主进程手上没有对话内容（事件是流式折叠在渲染层的），所以由渲染层
 *      在「本轮结束 / 清空 / 关窗」时把整场状态提上来存一次。
 *
 * 落盘策略与 notebook 类工具一致：单文件、有上限、超了就丢最旧的。
 * 不做的：全文检索、增量追加、多设备同步 —— 这是排障记录，不是知识库。
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../atomic'

/** 一条命令在历史里的样子（与渲染层 ObAgentCmd 对齐，output 会被截断） */
export interface StoredCmd {
  cmdId: string
  command: string
  why: string
  risk: 'safe' | 'confirm' | 'deny'
  /** 被拦/需确认时给用户看的理由（历史里必须留着，否则事后看不出为什么没跑） */
  reason?: string
  status: string
  exitCode?: number | null
  ms?: number
  note?: string
  output?: string
}

export interface StoredItem {
  kind: 'text' | 'cmd'
  key: string
  role?: 'user' | 'assistant'
  text?: string
  cmdId?: string
  cmd?: StoredCmd
  open?: boolean
}

export interface ObSessionMeta {
  id: string
  title: string
  serverId: string
  serverName: string
  host: string
  createdAt: number
  updatedAt: number
  /** 命令条数（执行过 / 被拦的都算，方便扫一眼哪场动过手） */
  cmdCount: number
  blocked: number
  status: 'running' | 'done' | 'error'
  /** 首问摘要，列表里第二行展示 */
  excerpt: string
}

export interface ObSession extends ObSessionMeta {
  mode: 'auto' | 'confirm'
  items: StoredItem[]
  /** 日志现场的静态快照（不含大数组，只留摘要与关键结论） */
  context: any
}

// ---------------------------------------------------------------- 上限
/** 最多留多少场对话 */
const MAX_SESSIONS = 60
/** 单条命令输出在历史里最多留多少字符（完整输出只在本轮界面上看） */
const MAX_OUTPUT = 6000
/** 单场对话最多留多少条 item */
const MAX_ITEMS = 240
/** 单场标题/摘要长度 */
const MAX_TITLE = 48
const MAX_EXCERPT = 120
/** 整个历史文件的目标上限（字节），超了从最旧的开始丢 */
const MAX_FILE_BYTES = 6 * 1024 * 1024

interface StoreShape {
  version: 1
  sessions: ObSession[]
}

let cache: StoreShape | null = null

function storeFile(): string {
  return path.join(app.getPath('userData'), 'obagent-sessions.json')
}

function str(v: any, max = 400): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function num(v: any, d = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}

function pickRisk(v: any): StoredCmd['risk'] {
  return v === 'confirm' || v === 'deny' ? v : 'safe'
}

function normalizeCmd(raw: any): StoredCmd | null {
  if (!raw || typeof raw.command !== 'string' || !raw.command.trim()) return null
  return {
    cmdId: str(raw.cmdId, 80),
    command: str(raw.command, 4000),
    why: str(raw.why, 300),
    risk: pickRisk(raw.risk),
    reason: str(raw.reason, 300) || undefined,
    status: str(raw.status, 20) || 'done',
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
    ms: typeof raw.ms === 'number' ? Math.round(raw.ms) : undefined,
    note: str(raw.note, 200) || undefined,
    output: typeof raw.output === 'string' ? raw.output.slice(0, MAX_OUTPUT) : undefined
  }
}

export function normalizeItem(raw: any): StoredItem | null {
  if (!raw || typeof raw !== 'object') return null
  if (raw.kind === 'text') {
    const text = str(raw.text, 20000)
    if (!text.trim()) return null
    return {
      kind: 'text',
      key: str(raw.key, 60) || `t_${Math.random().toString(36).slice(2, 8)}`,
      role: raw.role === 'assistant' ? 'assistant' : 'user',
      text
    }
  }
  if (raw.kind === 'cmd') {
    const cmd = normalizeCmd(raw.cmd)
    if (!cmd) return null
    return { kind: 'cmd', key: str(raw.key, 60) || `c_${cmd.cmdId}`, cmdId: cmd.cmdId, cmd, open: !!raw.open }
  }
  return null
}

function firstUserText(items: StoredItem[]): string {
  const t = items.find((x) => x.kind === 'text' && x.role === 'user' && (x.text || '').trim())
  return (t?.text || '').replace(/\s+/g, ' ').trim()
}

/** 会话摘要 —— 列表只吃这个，不把 items 传过 IPC */
export function metaOf(s: ObSession): ObSessionMeta {
  return {
    id: s.id,
    title: s.title,
    serverId: s.serverId,
    serverName: s.serverName,
    host: s.host,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    cmdCount: s.cmdCount,
    blocked: s.blocked,
    status: s.status,
    excerpt: s.excerpt
  }
}

/** 归一化一整场会话：非法条目丢掉、超长截断、命令计数重算 */
export function normalizeSession(raw: any): ObSession | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null
  const rawItems: any[] = Array.isArray(raw.items) ? raw.items : []
  const items: StoredItem[] = rawItems
    .map((x: any) => normalizeItem(x))
    .filter((x): x is StoredItem => !!x)
    .slice(-MAX_ITEMS)
  if (!items.length) return null
  const firstAsk = firstUserText(items)
  const cmds = items.filter((x: StoredItem) => x.kind === 'cmd')
  const status = raw.status === 'running' || raw.status === 'error' ? raw.status : 'done'
  return {
    id: raw.id,
    title: str(raw.title, MAX_TITLE) || firstAsk.slice(0, MAX_TITLE) || '未命名排查',
    serverId: str(raw.serverId, 80),
    serverName: str(raw.serverName, 120),
    host: str(raw.host, 200),
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: num(raw.updatedAt, Date.now()),
    cmdCount: cmds.length,
    blocked: cmds.filter((x: StoredItem) => x.cmd?.status === 'blocked' || x.cmd?.risk === 'deny').length,
    status,
    excerpt: str(raw.excerpt, MAX_EXCERPT) || firstAsk.slice(0, MAX_EXCERPT),
    mode: raw.mode === 'confirm' ? 'confirm' : 'auto',
    items,
    context: raw.context && typeof raw.context === 'object' ? raw.context : null
  }
}

function loadStore(): StoreShape {
  if (cache) return cache
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    const list = Array.isArray(data?.sessions)
      ? (data.sessions.map(normalizeSession).filter((s: ObSession | null): s is ObSession => !!s))
      : []
    cache = { version: 1, sessions: list }
  } catch {
    cache = { version: 1, sessions: [] }
  }
  return cache
}

function saveStore(): void {
  if (!cache) return
  // 先按时间排（新的在前），再按体积从最旧的丢，最后按条数封顶
  cache.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  let text = JSON.stringify(cache)
  while (text.length > MAX_FILE_BYTES && cache.sessions.length > 1) {
    cache.sessions.pop()
    text = JSON.stringify(cache)
  }
  try {
    writeFileAtomic(storeFile(), text)
  } catch {
    /* 写不进去不影响本轮排查，下次保存再试 */
  }
}

/** 列表（新的在前），只回摘要 */
export function listSessions(): ObSessionMeta[] {
  return loadStore().sessions.map(metaOf).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 读整场（找不到 / 已删除返回 null） */
export function getSession(id: string): ObSession | null {
  return loadStore().sessions.find((s) => s.id === String(id || '')) || null
}

/**
 * 存一场对话（有则覆盖）。
 * 会话 id 由渲染层生成并在整场里保持不变，所以「中途存 running、结束存 done」是同一场。
 */
export function saveSession(raw: any): { ok: boolean; id?: string; error?: string } {
  const s = normalizeSession(raw)
  if (!s) return { ok: false, error: '这场对话没有可保存的内容' }
  const store = loadStore()
  const i = store.sessions.findIndex((x) => x.id === s.id)
  if (i >= 0) store.sessions[i] = s
  else store.sessions.unshift(s)
  if (store.sessions.length > MAX_SESSIONS) store.sessions = store.sessions.slice(0, MAX_SESSIONS)
  saveStore()
  return { ok: true, id: s.id }
}

export function deleteSession(id: string): { ok: boolean; removed: number } {
  const store = loadStore()
  const before = store.sessions.length
  store.sessions = store.sessions.filter((s) => s.id !== String(id || ''))
  saveStore()
  return { ok: true, removed: before - store.sessions.length }
}

export function clearSessions(): { ok: boolean; removed: number } {
  const store = loadStore()
  const n = store.sessions.length
  store.sessions = []
  saveStore()
  return { ok: true, removed: n }
}

/** 给单测用：清掉内存缓存（改文件后重新读） */
export function resetSessionCacheForTest(): void {
  cache = null
}
