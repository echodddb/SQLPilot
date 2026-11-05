/**
 * OB 故障排查 Agent · 渲染层状态
 *
 * 浮窗只做三件事：把问题发出去、把命令卡片按顺序摆出来、把确认按钮的点击回传。
 * 真正的判断（能不能跑）全在主进程：这里不缓存任何「放行」状态，
 * 刷新界面也不会让一条被拦的命令变得可执行。
 *
 * 关于「脱离主窗口」：DOM 元素画不出窗口边界，所以脱离时主进程会开一个真正的
 * 独立窗口，界面代码（ObAgentPanel）和这份状态机一模一样的搬过去。
 * 两份状态靠「同一份事件流 + 交接快照」收敛：
 *   · 主进程把 obagent:event 广播给所有窗口（带递增 seq）；
 *   · 脱离/停靠时把整份状态序列化过去（snapshot / hydrate）；
 *   · hydrate 之后用 seq 把「快照之后才到的事件」补上（recent 队列），不漏一条。
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

/** 交接快照：脱离/停靠时两边交换的全部状态 */
export interface ObAgentSnapshot {
  seq: number
  runId: string
  serverId: string
  serverName: string
  host: string
  mode: 'auto' | 'confirm'
  context: ObAgentContext | null
  items: ObItem[]
  busy: boolean
  error: string
  reasoningChars: number
  cmdTotal: number
  draft: string
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
  /** true = 界面已经搬到独立窗口，主窗口里不再画浮窗 */
  detached: false,
  /** 独立窗口是否置顶（只有脱离时有意义） */
  pinned: true,
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
let unsubscribeUi: (() => void) | null = null

/** 已折叠到的最大事件序号（交接时用来对齐） */
let lastSeq = 0
/** 最近应用过的事件：hydrate 时补那些「比快照新」的（一场排查最多几百条） */
const recent: any[] = []
const RECENT_MAX = 160

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

function applyMode(m: 'auto' | 'confirm'): void {
  obAgent.mode = m === 'confirm' ? 'confirm' : 'auto'
  try {
    localStorage.setItem(MODE_KEY, obAgent.mode)
  } catch { /* 忽略 */ }
}

/** 切模式：另一侧窗口也要跟着切（否则两个窗口对同一条命令的处置不一致） */
export function setObAgentMode(m: 'auto' | 'confirm'): void {
  applyMode(m)
  void window.sqlpilot.obagentMirror({ kind: 'mode', mode: obAgent.mode })
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

/** 把一条事件折叠进状态（不含序号判断，交接补事件时也走这里） */
function applyEvent(ev: any): void {
  if (!ev) return
  // 只认当前这场对话：别的会话（另一条提问）的事件不能混进来。
  // currentId 为空时（刚脱离/还没提问）放行 —— 快照里带着 runId，正常不会为空。
  if (currentId && ev.id && ev.id !== currentId) return
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
      if (streamItem) {
        streamItem.live = false
        if (!streamItem.text.trim()) {
          // 这一轮只提了命令、没有正文：不留下空气泡
          const i = obAgent.items.indexOf(streamItem)
          if (i >= 0) obAgent.items.splice(i, 1)
        }
      }
      streamItem = null
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

function handleEvent(ev: any): void {
  if (!ev) return
  if (typeof ev.seq === 'number') {
    if (ev.seq <= lastSeq) return
    lastSeq = ev.seq
    recent.push(ev)
    if (recent.length > RECENT_MAX) recent.shift()
  }
  applyEvent(ev)
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

// ---------------------------------------------------------------- 交接（脱离 / 停靠）

/** 把当前状态压成一份可序列化的快照（命令卡片里的引用会被 JSON 拍平，hydrate 时重建） */
export function snapshotObAgent(): ObAgentSnapshot {
  return JSON.parse(JSON.stringify({
    seq: lastSeq,
    runId: currentId,
    serverId: obAgent.serverId,
    serverName: obAgent.serverName,
    host: obAgent.host,
    mode: obAgent.mode,
    context: obAgent.context,
    items: obAgent.items,
    busy: obAgent.busy,
    error: obAgent.error,
    reasoningChars: obAgent.reasoningChars,
    cmdTotal: obAgent.cmdTotal,
    draft: obAgent.draft
  })) as ObAgentSnapshot
}

/** 用另一侧的快照接管：先整体替换，再把「比快照新」的事件补回来 */
export function hydrateObAgent(snap: ObAgentSnapshot | null | undefined): void {
  if (!snap || !Array.isArray(snap.items)) return
  const items = snap.items as ObItem[]
  // JSON 拍平后 items[i].cmd 与 cmds 表不再共享引用，这里按 cmdId 重新绑一次，
  // 否则后续 cmd-update 只改到表里那份，卡片上永远不会变。
  const cmds: Record<string, ObAgentCmd> = {}
  for (const it of items) {
    if (it && it.kind === 'cmd' && it.cmd) cmds[it.cmdId] = it.cmd
  }
  currentId = String(snap.runId || '')
  obAgent.items = items
  obAgent.cmds = cmds
  obAgent.serverId = String(snap.serverId || '')
  obAgent.serverName = String(snap.serverName || '')
  obAgent.host = String(snap.host || '')
  obAgent.context = snap.context || null
  obAgent.busy = !!snap.busy
  obAgent.error = String(snap.error || '')
  obAgent.reasoningChars = Number(snap.reasoningChars) || 0
  obAgent.cmdTotal = Number(snap.cmdTotal) || 0
  obAgent.draft = String(snap.draft || '')
  obAgent.open = true
  applyMode(snap.mode === 'confirm' ? 'confirm' : 'auto')
  streamItem = (items.filter((x) => x.kind === 'text' && x.live).pop() as ObTextItem | undefined) || null
  lastSeq = Number(snap.seq) || 0
  // 快照之后才到的事件：本窗口已经折叠过，直接补一层（seq 保证不重复）
  for (const ev of recent) {
    if (typeof ev.seq === 'number' && ev.seq > lastSeq) {
      lastSeq = ev.seq
      applyEvent(ev)
    }
  }
}

/** 订阅「另一侧窗口」的界面动作（脱离/停靠/清空/切模式/关窗） */
export function bindObAgentUi(): void {
  if (unsubscribeUi) return
  unsubscribeUi = window.sqlpilot.onObAgentUi((msg: any) => {
    if (!msg || typeof msg !== 'object') return
    switch (msg.kind) {
      case 'hydrate':
        hydrateObAgent(msg.snapshot)
        obAgent.detached = !!msg.detached
        break
      case 'asked':
        // 另一侧发起的提问：这边补一条用户气泡，两边对话才一致
        if (String(msg.text || '').trim()) pushText('user', String(msg.text).trim())
        break
      case 'clear':
        clearLocal()
        break
      case 'mode':
        applyMode(msg.mode === 'confirm' ? 'confirm' : 'auto')
        break
      case 'panel-closed':
        // 独立窗口被关掉（✕ / 系统关闭）：主窗口这边也收起来，但保留对话内容
        obAgent.detached = false
        obAgent.open = false
        break
      default:
        break
    }
  })
}

/** 脱离主窗口：换成一个真正能在桌面任意位置摆放的窗口 */
export async function detachObAgent(): Promise<void> {
  if (obAgent.detached) return
  const snap = snapshotObAgent()
  // 先把窗口内的浮窗收掉：两个界面同时显示同一场对话会让人不知道该点哪边
  obAgent.detached = true
  try {
    const r = await window.sqlpilot.obagentDetach(snap)
    if (!r?.ok) {
      obAgent.detached = false
      obAgent.error = r?.error || '无法打开独立窗口'
    } else if (typeof (r as any).pin === 'boolean') {
      obAgent.pinned = (r as any).pin
    }
  } catch (e: any) {
    obAgent.detached = false
    obAgent.error = String(e?.message || e)
  }
}

/** 停靠回主窗口 */
export async function dockObAgent(): Promise<void> {
  const snap = snapshotObAgent()
  try {
    await window.sqlpilot.obagentDock(snap)
  } catch { /* 窗口已经不在了 */ }
}

export async function setObAgentPinned(v: boolean): Promise<void> {
  try {
    const r = await window.sqlpilot.obagentPanelPin(v)
    obAgent.pinned = !!r?.pin
  } catch {
    obAgent.pinned = v
  }
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
  bindObAgentUi()
  obAgent.open = true
  obAgent.serverId = o.serverId
  obAgent.serverName = o.serverName
  obAgent.host = o.host
  obAgent.context = o.context || null
  if (o.preset) obAgent.draft = o.preset
  // 已经脱离出去了：把人送到那个窗口去，别在主窗口里干等
  if (obAgent.detached) void window.sqlpilot.obagentPanelFocus()
}

export function closeObAgent(): void {
  if (obAgent.busy) void stopObAgent()
  if (obAgent.detached) {
    obAgent.detached = false
    obAgent.open = false
    void window.sqlpilot.obagentPanelClose()
    return
  }
  obAgent.open = false
}

function clearLocal(): void {
  obAgent.items = []
  obAgent.cmds = {}
  obAgent.error = ''
  obAgent.reasoningChars = 0
  obAgent.cmdTotal = 0
  streamItem = null
  recent.length = 0
}

export function clearObAgent(): void {
  if (obAgent.busy) void stopObAgent()
  clearLocal()
  void window.sqlpilot.obagentMirror({ kind: 'clear' })
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
  bindObAgentUi()
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
      // 没发出去就别把问题吞掉：放回输入框，人还能改一改再发
      if (!obAgent.draft) obAgent.draft = q
      const i = obAgent.items.findIndex((x) => x.kind === 'text' && x.role === 'user' && x.text === q)
      if (i >= 0) obAgent.items.splice(i, 1)
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
