/**
 * OB 故障排查 Agent · 渲染层状态
 *
 * 浮窗只做三件事：把问题发出去、把命令卡片按顺序摆出来、把确认按钮的点击回传。
 * 真正的判断（能不能跑）全在主进程：这里不缓存任何「放行」状态，
 * 刷新界面也不会让一条被拦的命令变得可执行。
 */
import { reactive } from 'vue'

export type ObRisk = 'safe' | 'confirm' | 'deny'
export type ObCmdStatus = 'waiting' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped'

export interface ObAgentCmd {
  cmdId: string
  command: string
  why: string
  risk: ObRisk
  rule: string
  reason: string
  status: ObCmdStatus
  exitCode?: number | null
  ms?: number
  output?: string
  note?: string
  /** 输出区是否展开（失败/被拦时默认展开） */
  open: boolean
}

export interface ObTextItem {
  kind: 'text'
  key: string
  role: 'user' | 'assistant'
  text: string
  /** 流式中（决定是否显示光标） */
  live?: boolean
}

export interface ObCmdItem {
  kind: 'cmd'
  key: string
  cmdId: string
  /** 直接引用同一份命令对象：状态更新时界面自动重渲染，不用按 id 再查一遍 */
  cmd: ObAgentCmd
}

export type ObItem = ObTextItem | ObCmdItem

export interface ObAgentContext {
  serverName?: string
  host?: string
  logDir?: string
  scope?: string
  windowStart?: string
  windowEnd?: string
  total?: number
  linesPerHour?: number
  filesScanned?: number
  bytesScanned?: number
  truncated?: boolean
  disk?: { usePct: number; avail: number; mount?: string } | null
  levels?: { key: string; count: number }[]
  summary?: { level: string; headline: string; points: string[] }
  hotSpots?: { key: string; count: number; verdict?: string; what?: string; advice?: string; sample?: string }[]
  errCodes?: { key: string; count: number; msg?: string; verdict?: string; what?: string; advice?: string; sample?: string }[]
}

const MODE_KEY = 'sqlpilot.obagent.mode'
const LAYOUT_KEY = 'sqlpilot.obagent.layout'

function readMode(): 'auto' | 'confirm' {
  try {
    return localStorage.getItem(MODE_KEY) === 'confirm' ? 'confirm' : 'auto'
  } catch {
    return 'auto'
  }
}

interface Layout {
  x: number | null
  y: number | null
  w: number | null
  h: number | null
}

function readLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return { x: null, y: null, w: null, h: null }
    const j = JSON.parse(raw)
    const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
    return { x: num(j.x), y: num(j.y), w: num(j.w), h: num(j.h) }
  } catch {
    return { x: null, y: null, w: null, h: null }
  }
}

const layout = readLayout()

export const obAgent = reactive({
  open: false,
  serverId: '',
  serverName: '',
  host: '',
  mode: readMode() as 'auto' | 'confirm',
  items: [] as ObItem[],
  /** 命令卡片按 cmdId 索引（同一条命令的状态会更新多次） */
  cmds: {} as Record<string, ObAgentCmd>,
  draft: '',
  busy: false,
  error: '',
  /** 模型思考字数（只显示一个量级，不展示思考内容） */
  reasoningChars: 0,
  context: null as ObAgentContext | null,
  /** 本次浮窗累计执行/拦截的命令数 */
  cmdTotal: 0,
  // 位置与尺寸（null = 用默认的右下角定位）
  x: layout.x,
  y: layout.y,
  w: layout.w,
  h: layout.h
})

/** 当前正在流式写入的助手气泡 */
let streamItem: ObTextItem | null = null
let reqSeq = 0
let currentId = ''
let unsubscribe: (() => void) | null = null

export function saveObAgentLayout(): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ x: obAgent.x, y: obAgent.y, w: obAgent.w, h: obAgent.h }))
  } catch { /* 存不上只影响下次位置 */ }
}

export function resetObAgentLayout(): void {
  obAgent.x = null
  obAgent.y = null
  obAgent.w = null
  obAgent.h = null
  saveObAgentLayout()
}

export function setObAgentMode(m: 'auto' | 'confirm'): void {
  obAgent.mode = m
  try {
    localStorage.setItem(MODE_KEY, m)
  } catch { /* 忽略 */ }
}

function pushText(role: 'user' | 'assistant', text: string): ObTextItem {
  const item: ObTextItem = { kind: 'text', key: `t${Date.now()}_${obAgent.items.length}`, role, text }
  obAgent.items.push(item)
  return item
}

function upsertCmd(ev: { cmdId: string; command: string; why: string; risk: ObRisk; rule: string; reason: string; status: ObCmdStatus }): ObAgentCmd {
  const exist = obAgent.cmds[ev.cmdId]
  if (exist) {
    // 同一条命令先等待后执行：只更新状态，不重复插卡片
    exist.status = ev.status
    if (ev.why) exist.why = ev.why
    return exist
  }
  const cmd: ObAgentCmd = {
    cmdId: ev.cmdId,
    command: ev.command,
    why: ev.why,
    risk: ev.risk,
    rule: ev.rule,
    reason: ev.reason,
    status: ev.status,
    open: ev.status === 'blocked'
  }
  obAgent.cmds[ev.cmdId] = cmd
  obAgent.items.push({ kind: 'cmd', key: `c_${ev.cmdId}`, cmdId: ev.cmdId, cmd })
  obAgent.cmdTotal++
  return cmd
}

function handleEvent(ev: any): void {
  if (!ev || ev.id !== currentId) return
  switch (ev.type) {
    case 'start':
      obAgent.busy = true
      obAgent.error = ''
      obAgent.reasoningChars = 0
      break
    case 'reasoning':
      obAgent.reasoningChars = Number(ev.chars) || 0
      break
    case 'delta': {
      if (!streamItem) {
        streamItem = pushText('assistant', '')
        streamItem.live = true
      }
      streamItem.text += String(ev.text || '')
      break
    }
    case 'round-end': {
      const t = String(ev.text || '').trim()
      if (streamItem) {
        streamItem.live = false
        if (!streamItem.text.trim()) {
          // 这一轮只提了命令、没有正文：不留下空气泡
          const i = obAgent.items.indexOf(streamItem)
          if (i >= 0) obAgent.items.splice(i, 1)
        }
      }
      streamItem = null
      void t
      break
    }
    case 'cmd':
      upsertCmd(ev)
      break
    case 'cmd-update': {
      const c = obAgent.cmds[ev.cmdId]
      if (!c) break
      c.status = ev.status
      if (ev.exitCode !== undefined) c.exitCode = ev.exitCode
      if (ev.ms !== undefined) c.ms = ev.ms
      if (ev.output !== undefined) c.output = ev.output
      if (ev.note !== undefined) c.note = ev.note
      if ((ev.status === 'failed' || ev.status === 'blocked') && ev.output) c.open = true
      // 跑完的短输出直接摊开：那是「证据」，藏起来等于让人多点一次
      else if (ev.status === 'done' && ev.output && String(ev.output).length <= 1200) c.open = true
      break
    }
    case 'done':
      obAgent.busy = false
      streamItem = null
      if (ev.text && !obAgent.items.some((x) => x.kind === 'text' && x.role === 'assistant' && x.text.trim())) {
        pushText('assistant', String(ev.text))
      }
      break
    case 'error':
      obAgent.busy = false
      streamItem = null
      obAgent.error = String(ev.error || '排查失败')
      break
    default:
      break
  }
}

/** 订阅主进程事件（浮窗挂载时调，卸载时撤销） */
export function bindObAgentEvents(): void {
  if (unsubscribe) return
  unsubscribe = window.sqlpilot.onObAgentEvent(handleEvent)
}

export function unbindObAgentEvents(): void {
  if (unsubscribe) unsubscribe()
  unsubscribe = null
}

export interface OpenObAgentOptions {
  serverId: string
  serverName: string
  host: string
  context?: ObAgentContext | null
  /** 打开后立刻问的问题（从热点/错误码点进来时用） */
  preset?: string
}

export function openObAgent(o: OpenObAgentOptions): void {
  // 浮窗是 v-if 挂载的，等 onMounted 再订阅会漏掉「点开就发问」时的前几帧流式文本，
  // 所以在打开这一刻就把订阅挂上（幂等）。
  bindObAgentEvents()
  obAgent.open = true
  obAgent.serverId = o.serverId
  obAgent.serverName = o.serverName
  obAgent.host = o.host
  obAgent.context = o.context || null
  if (o.preset) obAgent.draft = o.preset
}

export function closeObAgent(): void {
  if (obAgent.busy) void stopObAgent()
  obAgent.open = false
}

export function clearObAgent(): void {
  if (obAgent.busy) void stopObAgent()
  obAgent.items = []
  obAgent.cmds = {}
  obAgent.error = ''
  obAgent.reasoningChars = 0
  obAgent.cmdTotal = 0
  streamItem = null
}

/** 把当前对话里的纯文本收成历史（命令卡片与输出不进上下文，避免撑爆） */
function historyOf(): { role: 'user' | 'assistant'; text: string }[] {
  return obAgent.items
    .filter((x): x is ObTextItem => x.kind === 'text' && !!x.text.trim())
    .slice(-8)
    .map((x) => ({ role: x.role, text: x.text }))
}

/** 跨进程前必须去除 Vue 响应式代理（Electron 无法结构化克隆 Proxy） */
function toPlain<T>(v: T): T {
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return v
  }
}

export async function askObAgent(text?: string): Promise<void> {
  const q = String(text ?? obAgent.draft).trim()
  if (!q || obAgent.busy) return
  if (!obAgent.serverId) {
    obAgent.error = '先选一台服务器'
    return
  }
  bindObAgentEvents()
  obAgent.draft = ''
  obAgent.error = ''
  obAgent.reasoningChars = 0
  const history = historyOf()
  pushText('user', q)
  streamItem = null
  obAgent.busy = true
  const id = `oba_${Date.now().toString(36)}_${++reqSeq}`
  currentId = id
  try {
    const r = await window.sqlpilot.obagentAsk({
      id,
      serverId: obAgent.serverId,
      question: q,
      // 必须转纯对象：obAgent.context 是 reactive 代理，直接过 IPC 会报 "could not be cloned"
      context: toPlain(obAgent.context) || undefined,
      history: toPlain(history),
      mode: obAgent.mode
    })
    if (!r.ok) {
      obAgent.busy = false
      obAgent.error = r.error || '启动失败'
    }
  } catch (e: any) {
    obAgent.busy = false
    obAgent.error = String(e?.message || e)
  }
}

export async function stopObAgent(): Promise<void> {
  if (!currentId) return
  try {
    await window.sqlpilot.obagentStop(currentId)
  } catch { /* 已经停了 */ }
  obAgent.busy = false
}

export async function approveCmd(cmdId: string, decision: 'run' | 'skip' | 'always'): Promise<void> {
  try {
    await window.sqlpilot.obagentApprove(cmdId, decision)
  } catch (e: any) {
    obAgent.error = String(e?.message || e)
  }
}

export function toggleCmdOutput(cmdId: string): void {
  const c = obAgent.cmds[cmdId]
  if (c) c.open = !c.open
}

export async function copyText(s: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(s)
  } catch { /* 剪贴板不可用时静默 */ }
}

/** 空态快捷问题：按当前上下文给，不堆一排无关按钮 */
export function quickPrompts(): string[] {
  const out = ['这台机器现在有没有明显的资源瓶颈？', '日志刷得这么快，根因可能在哪个模块？']
  const err = obAgent.context?.errCodes?.[0]
  if (err) out.push(`错误码 ${err.key} 反复出现，要不要处理？`)
  const hot = obAgent.context?.hotSpots?.[0]
  if (hot) out.push(`${hot.key.split('(')[0].trim()} 这一处在刷什么？`)
  const disk = obAgent.context?.disk
  if (disk && disk.usePct >= 85) out.push('日志盘快满了，先清哪些文件安全？')
  return out.slice(0, 4)
}
