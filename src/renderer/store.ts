import { reactive, nextTick } from 'vue'

/** 子代理实时状态（挂在对应 agent_spawn 工具卡片上，按 toolCallId 关联） */
export interface UiSub {
  agentType: string
  description: string
  status: 'running' | 'done' | 'stopped' | 'error'
  /** 每次子代理工具调用一行摘要 */
  activity: string[]
  /** 结束摘要："7 轮 · 23 次工具 · 95s" */
  summary?: string
}

export interface UiTool {
  name: string
  args: string
  status: 'running' | 'ok' | 'error'
  result?: string
  /** 对应主进程 toolCallId：子代理 sub-* 事件据此挂到本卡片 */
  toolCallId?: string
  sub?: UiSub
}

export interface UiMsg {
  id: number
  role: 'user' | 'assistant' | 'reasoning' | 'error'
  text: string
  tools: UiTool[]
  /** 已追加过工具卡片，后续文本需另起新消息 */
  closed?: boolean
  /** 思考过程折叠状态：流式输出时展开，助手正文开始/回合结束后自动折叠，可手动切换 */
  collapsed?: boolean
  /** 用户手动切换过折叠：此后自动折叠跳过该条（尊重手动展开） */
  manualToggle?: boolean
  /** 所属回合已结束（含从历史恢复）：展开态据此显示"收起"入口 */
  settled?: boolean
}

export interface SessionMeta {
  id: string
  title: string
  mode: string
  providerId: string | null
  projectId: string | null
  effort: string | null
}

export interface UiSession {
  meta: SessionMeta
  msgs: UiMsg[]
  running: boolean
  /** 本会话的后台子代理任务（任务条展示，registry 快照） */
  subTasks: any[]
  /** 上下文占用徽标：est=估算 tokens，windowK=模型窗口，usage=最近一次真实计量 */
  ctx?: { est: number; windowK: number; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }
}

let msgSeq = 0

/** Vue reactive Proxy 无法跨 contextBridge/IPC（结构化克隆）——调用桥接 API 前先纯对象化 */
export function toPlain<T>(v: T): T {
  if (v === null || v === undefined || typeof v !== 'object') return v
  return JSON.parse(JSON.stringify(v))
}

export const store = reactive({
  ready: false,
  view: 'chat' as 'chat' | 'db' | 'settings',
  cfg: null as any,
  sessions: {} as Record<string, UiSession>,
  sessionOrder: [] as string[],
  currentId: '' as string,
  /** 确认请求队列：多会话并发时依次处理，互不覆盖 */
  confirmQueue: [] as { requestId: string; sessionId?: string; tool: string; conn: string; sql: string; kind: string; risk: number; origin?: string }[],
  /** LLM 发送前预览队列（开启 previewLlm 时每次请求弹出） */
  previewQueue: [] as { requestId: string; sessionId?: string; url: string; body: any }[],
  /** 归档进行中的前台提示（阶段事件驱动；done/error 时清除） */
  archiveProgress: null as { sessionId: string; stage: string; note: string } | null,
  secretsAvailable: false,
  // 侧边栏 schema 树状态: connId -> { expanded, schemas?, loading, tables, opened }
  tree: {} as Record<string, { expanded: boolean; schemas?: string[]; loading: boolean; tables: Record<string, any[]>; opened: string | null }>,
  drafts: {} as Record<string, string>,
  /** 底部工作台面板：SSH 终端（数据库相关窗口都在数据库工作台视图里） */
  workbench: null as 'terminal' | null,
  /** 子代理完整过程查看弹窗（审计 JSONL 实时读取） */
  subRun: null as { runId: string; title: string } | null
})

export function curSession(): UiSession {
  return store.sessions[store.currentId]
}

export function curDraft(): string {
  return store.drafts[store.currentId] || ''
}

function ensureSessionRecord(meta: SessionMeta): UiSession {
  if (!store.sessions[meta.id]) {
    store.sessions[meta.id] = { meta, msgs: [], running: false, subTasks: [] }
    if (!store.sessionOrder.includes(meta.id)) store.sessionOrder.push(meta.id)
  } else {
    store.sessions[meta.id].meta = meta
  }
  return store.sessions[meta.id]
}

function lastMsgOf(s: UiSession): UiMsg | undefined {
  return s.msgs[s.msgs.length - 1]
}

/** 把主进程持久化的会话历史（含工具调用与结果）还原为界面消息 */
function historyToUi(history: any[]): UiMsg[] {
  const out: UiMsg[] = []
  const mk = (role: UiMsg['role'], text: string, tools: UiTool[] = []): UiMsg => ({ id: ++msgSeq, role, text, tools })
  for (const m of history) {
    if (m.role === 'user') {
      out.push(mk('user', m.content || ''))
    } else if (m.role === 'assistant') {
      // 思考块恢复为折叠态消息（正文/结论已就位，按需展开）；无签名的思考来自
      // OpenAI 协议历史，仅用于界面展示，不会回传给 Anthropic（见 llm.ts）
      if (m.thinking) {
        const r = mk('reasoning', m.thinking)
        r.collapsed = true
        r.settled = true
        out.push(r)
      }
      if (m.content) out.push(mk('assistant', m.content))
      if (m.toolCalls?.length) {
        const tools: UiTool[] = m.toolCalls.map((tc: any) => {
          const res = history.find((x: any) => x.role === 'tool' && x.toolCallId === tc.id)
          const result = res?.content ?? ''
          let ok = true
          try { ok = !JSON.parse(result)?.error } catch { ok = true }
          return { name: tc.name, args: tc.args, status: ok ? ('ok' as const) : ('error' as const), result, toolCallId: tc.id }
        })
        const last = out[out.length - 1]
        if (last && last.role === 'assistant' && last.tools.length === 0 && !last.closed) {
          last.tools.push(...tools)
          last.closed = true
        } else {
          out.push({ ...mk('assistant', ''), tools, closed: true })
        }
      }
    }
  }
  return out
}

export async function init(): Promise<void> {
  store.cfg = await window.sqlpilot.getConfig()
  const info = await window.sqlpilot.appInfo()
  store.secretsAvailable = info.secretsAvailable

  // 恢复会话列表与各会话历史
  const list = await window.sqlpilot.listSessions()
  if (!list.length) {
    const s = await window.sqlpilot.newSession()
    list.push(s)
  }
  for (const meta of list) {
    const rec = ensureSessionRecord(meta)
    try {
      const hist = await window.sqlpilot.getHistory(meta.id)
      if (hist.ok && Array.isArray(hist.messages)) rec.msgs = historyToUi(hist.messages)
    } catch { /* 忽略单会话恢复失败 */ }
  }
  store.currentId = list[list.length - 1].id

  window.sqlpilot.onAgentEvent((ev: any) => {
    const s = store.sessions[ev.sessionId]
    if (!s) return
    if (ev.type === 'text') {
      const last = lastMsgOf(s)
      if (!last || last.role !== 'assistant' || last.tools.length > 0 || last.closed) {
        s.msgs.push({ id: ++msgSeq, role: 'assistant', text: '', tools: [] })
        // 正文开始输出：此前所有思考过程自动折叠（手动展开过的不动）
        for (const m of s.msgs) if (m.role === 'reasoning' && !m.manualToggle) m.collapsed = true
      }
      lastMsgOf(s)!.text += ev.text
    } else if (ev.type === 'reasoning') {
      const last = lastMsgOf(s)
      if (!last || last.role !== 'reasoning') {
        s.msgs.push({ id: ++msgSeq, role: 'reasoning', text: '', tools: [] })
      }
      lastMsgOf(s)!.text += ev.text
    } else if (ev.type === 'tool-start') {
      const last = lastMsgOf(s)
      const target =
        last && last.role === 'assistant'
          ? last
          : s.msgs[s.msgs.push({ id: ++msgSeq, role: 'assistant', text: '', tools: [] }) - 1]
      target.tools.push({ name: ev.tool, args: ev.args, status: 'running', toolCallId: ev.toolCallId })
      target.closed = true
    } else if (ev.type === 'sub-start' || ev.type === 'sub-activity' || ev.type === 'sub-end') {
      // 子代理事件按 subId(=agent_spawn 的 toolCallId) 定位卡片；旧历史无 id 时兜底最后一个运行中的 spawn 卡片
      const findSub = (): UiTool | undefined => {
        for (let i = s.msgs.length - 1; i >= 0; i--) {
          for (const t of s.msgs[i].tools) {
            if (t.toolCallId && t.toolCallId === ev.subId) return t
          }
        }
        for (let i = s.msgs.length - 1; i >= 0; i--) {
          for (const t of s.msgs[i].tools) {
            if (t.name === 'agent_spawn' && t.status === 'running') return t
          }
        }
        return undefined
      }
      const t = findSub()
      if (!t) return
      if (ev.type === 'sub-start') {
        t.sub = { agentType: ev.agentType, description: ev.description, status: 'running', activity: [] }
      } else if (ev.type === 'sub-activity') {
        if (!t.sub) t.sub = { agentType: '', description: '', status: 'running', activity: [] }
        t.sub.activity.push(ev.note)
        if (t.sub.activity.length > 300) t.sub.activity.splice(0, t.sub.activity.length - 300)
      } else {
        if (!t.sub) t.sub = { agentType: '', description: '', status: 'running', activity: [] }
        // 区分收尾形态：stopped=用户停止 / exhausted=迭代或预算收口，都不是错误
        t.sub.status = ev.status === 'completed' ? 'done' : ev.status === 'failed' ? 'error' : 'stopped'
        t.sub.summary = ev.summary
      }
    } else if (ev.type === 'tool-end') {
      // 优先按 toolCallId 精确匹配：并发扇出时同名工具卡片（如多个 agent_spawn）同时 running，
      // 按名字从后往前匹配会把结果挂到错误的卡片上
      let target: UiTool | undefined
      if (ev.toolCallId) {
        for (let i = s.msgs.length - 1; i >= 0 && !target; i--) {
          for (const t of s.msgs[i].tools) {
            if (t.toolCallId === ev.toolCallId && t.status === 'running') { target = t; break }
          }
        }
      }
      if (!target) {
        for (let i = s.msgs.length - 1; i >= 0 && !target; i--) {
          const m = s.msgs[i]
          for (let j = m.tools.length - 1; j >= 0; j--) {
            if (m.tools[j].name === ev.tool && m.tools[j].status === 'running') { target = m.tools[j]; break }
          }
        }
      }
      if (target) {
        target.status = ev.ok ? 'ok' : 'error'
        target.result = ev.result
      }
    } else if (ev.type === 'notice') {
      s.msgs.push({ id: ++msgSeq, role: 'error', text: ev.text, tools: [] })
    } else if (ev.type === 'sub-tasks') {
      s.subTasks = ev.tasks || []
    } else if (ev.type === 'session-updated') {
      const target = store.sessions[ev.sessionId]
      if (target) target.meta = ev.meta
    } else if (ev.type === 'context') {
      const target = store.sessions[ev.sessionId]
      if (target) {
        // usage 只在响应后的事件携带；估算事件到达时保留上一次的真实计量
        target.ctx = { est: ev.est, windowK: ev.windowK, usage: ev.usage || target.ctx?.usage }
      }
    } else if (ev.type === 'done') {
      s.running = false
      // 回合结束（含无正文的收尾）：折叠未手动展开过的思考过程
      for (const m of s.msgs) if (m.role === 'reasoning') {
        if (!m.manualToggle) m.collapsed = true
        m.settled = true
      }
      if (ev.note) s.msgs.push({ id: ++msgSeq, role: 'error', text: ev.note, tools: [] })
    } else if (ev.type === 'error') {
      s.running = false
      for (const m of s.msgs) if (m.role === 'reasoning') {
        if (!m.manualToggle) m.collapsed = true
        m.settled = true
      }
      s.msgs.push({ id: ++msgSeq, role: 'error', text: ev.error, tools: [] })
    }
  })

  window.sqlpilot.onSubtasks(({ sessionId, tasks }: any) => {
    const t = store.sessions[sessionId]
    if (t) t.subTasks = tasks || []
  })

  window.sqlpilot.onConfirm((req: any) => {
    store.confirmQueue.push(req)
  })

  window.sqlpilot.onConfirmExpired(({ requestId }: any) => {
    store.confirmQueue = store.confirmQueue.filter((c) => c.requestId !== requestId)
  })

  window.sqlpilot.onLlmPreview((p: any) => {
    store.previewQueue.push(p)
  })

  // 归档阶段提示：summary/save 阶段展示，done/error 清除（结果通知由归档调用方 pushNotice）
  window.sqlpilot.onArchiveProgress((p) => {
    store.archiveProgress = p.stage === 'done' || p.stage === 'error' ? null : { sessionId: p.id, stage: p.stage, note: p.note }
  })

  window.sqlpilot.onLlmPreviewExpired(({ requestId }: any) => {
    store.previewQueue = store.previewQueue.filter((c) => c.requestId !== requestId)
  })

  store.ready = true
}

export async function sendMessage(text: string): Promise<void> {
  const s = curSession()
  if (!s || s.running || !text.trim()) return
  s.msgs.push({ id: ++msgSeq, role: 'user', text, tools: [] })
  s.running = true
  await window.sqlpilot.sendChat(store.currentId, text)
  // 刷新标题（首条消息截断）
  const list = await window.sqlpilot.listSessions()
  for (const m of list) if (store.sessions[m.id]) store.sessions[m.id].meta = m
  await nextTick()
}

export async function newChat(): Promise<void> {
  await window.sqlpilot.resetChat(store.currentId)
  curSession().msgs = []
}

export async function stop(): Promise<void> {
  await window.sqlpilot.stopChat(store.currentId)
}

export async function createSession(): Promise<void> {
  const meta = await window.sqlpilot.newSession()
  ensureSessionRecord(meta)
  store.currentId = meta.id
}

/** 在指定项目下新建会话（会话必须挂项目） */
export async function createSessionInProject(projectId: string): Promise<void> {
  const meta = await window.sqlpilot.newSession()
  const r = await window.sqlpilot.updateSession(meta.id, { projectId })
  ensureSessionRecord((r as any).session || { ...meta, projectId })
  store.currentId = meta.id
}

/** 归档会话（总结对话到项目归档，该项目其他会话可读）并从列表移除。
 *  最后一个会话不删除，只归档清空（保证界面始终有当前会话） */
export async function removeSession(id: string): Promise<void> {
  if (Object.keys(store.sessions).length <= 1) {
    await archiveAndClear()
    return
  }
  const title = store.sessions[id]?.meta.title || '会话'
  const pid = store.sessions[id]?.meta.projectId
  const projName = (store.cfg?.projects || []).find((p: any) => p.id === pid)?.name
  const arch = projName ? `对话内容将总结归档到项目「${projName}」，供该项目其他会话参考；` : '该会话未绑定项目，内容不会归档；'
  if (!window.confirm(`归档会话「${title}」？\n${arch}会话将从列表移除。`)) return
  const r = await window.sqlpilot.archiveSession(id, true)
  if (!r.ok) {
    window.alert(r.error || '归档失败')
    return
  }
  delete store.sessions[id]
  store.sessionOrder = store.sessionOrder.filter((x) => x !== id)
  if (store.currentId === id) store.currentId = store.sessionOrder[store.sessionOrder.length - 1]
  if (!r.archived) window.alert(r.note || '会话内容未归档')
  else pushNotice(`会话「${title}」${r.note}${r.preview ? `：${r.preview}…` : ''}`)
}

/** 归档当前对话到项目并清空本会话（原"清空对话"，内容不再直接丢弃） */
export async function archiveAndClear(): Promise<void> {
  const s = curSession()
  if (!s) return
  if (s.msgs.length && !window.confirm('归档当前对话？\n内容将总结归档到项目后清空本会话，可重新开始。')) return
  const r = await window.sqlpilot.archiveSession(store.currentId, false)
  if (!r.ok) {
    window.alert(r.error || '归档失败')
    return
  }
  s.msgs = []
  pushNotice(`${r.note}${r.preview ? `：${r.preview}…` : ''}`)
}

export async function setSessionMode(mode: string): Promise<void> {
  const s = curSession()
  if (!s || s.meta.mode === mode) return
  if (mode === 'yolo' || mode === 'session') {
    const label = mode === 'yolo' ? '完全放开（所有操作自动执行，含高危）' : '会话放开（普通写操作本会话自动执行）'
    if (!window.confirm(`确认将本会话切换到「${label}」？（仅影响当前会话）`)) return
  }
  s.meta.mode = mode
  await window.sqlpilot.updateSession(store.currentId, { mode })
}

export async function setSessionProvider(providerId: string): Promise<void> {
  const s = curSession()
  if (!s) return
  s.meta.providerId = providerId || null
  await window.sqlpilot.updateSession(store.currentId, { providerId: providerId || null })
}

/** 会话级思考级别：'' = 跟随默认，off/low/medium/high 显式覆盖 */
export async function setSessionEffort(effort: string): Promise<void> {
  const s = curSession()
  if (!s) return
  s.meta.effort = effort || null
  await window.sqlpilot.updateSession(store.currentId, { effort: effort || null })
}

export async function bindSessionProject(projectId: string | null): Promise<void> {
  const s = curSession()
  if (!s) return
  s.meta.projectId = projectId
  await window.sqlpilot.updateSession(store.currentId, { projectId })
}

/** 计划模式：批准最后一版计划并切到确认执行模式开始执行 */
export async function approvePlan(): Promise<void> {
  const s = curSession()
  if (!s || s.meta.mode !== 'plan') return
  s.meta.mode = 'confirm'
  await window.sqlpilot.updateSession(store.currentId, { mode: 'confirm' })
  await sendMessage('批准以上计划，请严格按计划开始执行。')
}

/** 打开/关闭子代理完整过程弹窗 */
export function openSubRun(runId: string, title: string): void {
  store.subRun = { runId, title }
}

export function closeSubRun(): void {
  store.subRun = null
}

/** 在当前会话里追加一条系统提示（功能开关提醒等，不进入真实对话历史） */
export function pushNotice(text: string): void {
  const s = store.sessions[store.currentId]
  if (s) s.msgs.push({ id: ++msgSeq, role: 'error', text, tools: [] })
}

export const MODES = [
  { key: 'plan', label: '计划', tip: '只读探索并输出执行计划，批准后才动手' },
  { key: 'readonly', label: '只读', tip: '仅允许只读查询' },
  { key: 'confirm', label: '确认执行', tip: '写操作需逐次确认' },
  { key: 'session', label: '会话放开', tip: '普通写本会话自动，高危仍确认' },
  { key: 'yolo', label: '完全放开', tip: '全部自动执行（危险）' }
]

export const TYPE_LABELS: Record<string, string> = {
  oracle: 'Oracle',
  mysql: 'MySQL',
  'ob-mysql': 'OceanBase·MySQL租户',
  'ob-oracle': 'OceanBase·Oracle租户'
}
