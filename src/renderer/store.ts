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
  /** 进入计划模式前的模式（批准计划后恢复；null = 无恢复点，批准后回落确认执行） */
  prePlanMode?: string | null
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
  /** 一级功能模块：AI 助手（对话/工作台/终端）/ 脱敏工具 / 巡检报告（规划中） */
  module: 'agent' as 'agent' | 'masking' | 'report',
  view: 'chat' as 'chat' | 'db',
  /** 设置浮窗（横切关注点，不占主视图轨道；对话/工作台保持原样在浮窗下方） */
  settingsOpen: false,
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
  /** 全局浮窗提示（UI 操作反馈：归档/模式切换等；不进会话消息流，数秒自动消失） */
  toasts: [] as { id: number; text: string }[],
  secretsAvailable: false,
  // 侧边栏 schema 树状态: connId -> { expanded, schemas?, loading, tables, opened }
  tree: {} as Record<string, { expanded: boolean; schemas?: string[]; loading: boolean; tables: Record<string, any[]>; opened: string | null }>,
  drafts: {} as Record<string, string>,
  /** 底部工作台面板：SSH 终端（数据库相关窗口都在数据库工作台视图里） */
  workbench: null as 'terminal' | null,
  /** 任务栏（Windows 式）：从连接/服务器打开的窗口入口；− 隐藏保留状态，✕ 关闭销毁 */
  tasks: [] as { id: string; kind: 'db' | 'server'; refId: string; title: string; icon: string }[],
  /** 数据库工作台是否挂载（✕ 掉最后一个数据库任务时销毁，释放 tab 状态） */
  dbOpen: false,
  /** 任务栏激活态：最近的数据库任务连接 / 当前终端服务器 */
  lastDbConn: null as string | null,
  activeTermServerId: null as string | null,
  /** 打开任务时的工作台定位请求（DbWorkbenchView / WorkbenchPanel watch 消费后清空） */
  pendingDbConn: null as string | null,
  pendingKillTermServer: null as string | null,
  /** 侧栏服务器点击 → 终端面板打开该服务器的 shell（WorkbenchPanel 消费后清空） */
  pendingTermServer: null as any,
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

  // ---------- 流式文本节流 ----------
  // 每 token 直接 text += 会触发 mdLite 全量重跑（O(n²)，长回答卡 UI）。
  // 缓冲 100ms 批量落地：渲染重算次数从"每 token 一次"降为 10 次/秒。
  const textBuf = new Map<UiMsg, string>()
  let textFlushTimer: ReturnType<typeof setTimeout> | null = null
  function flushTextBuf(): void {
    if (textFlushTimer) {
      clearTimeout(textFlushTimer)
      textFlushTimer = null
    }
    for (const [msg, buf] of textBuf) msg.text += buf
    textBuf.clear()
  }
  function queueText(msg: UiMsg, chunk: string): void {
    if (!chunk) return
    textBuf.set(msg, (textBuf.get(msg) || '') + chunk)
    if (!textFlushTimer) textFlushTimer = setTimeout(flushTextBuf, 100)
  }

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
      queueText(lastMsgOf(s)!, ev.text)
    } else if (ev.type === 'reasoning') {
      const last = lastMsgOf(s)
      if (!last || last.role !== 'reasoning') {
        s.msgs.push({ id: ++msgSeq, role: 'reasoning', text: '', tools: [] })
      }
      queueText(lastMsgOf(s)!, ev.text)
    } else if (ev.type === 'tool-start') {
      flushTextBuf() // 消息边界：缓冲落地后再挂卡片，保证顺序
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
      flushTextBuf() // 回合结束：最后一批缓冲必须落地
      s.running = false
      // 回合结束（含无正文的收尾）：折叠未手动展开过的思考过程
      for (const m of s.msgs) if (m.role === 'reasoning') {
        if (!m.manualToggle) m.collapsed = true
        m.settled = true
      }
      if (ev.note) s.msgs.push({ id: ++msgSeq, role: 'error', text: ev.note, tools: [] })
    } else if (ev.type === 'error') {
      flushTextBuf() // 出错也要先落地已收到的内容（半截回答保留）
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

/** 基于一条归档继续工作：在归档所属项目下新建会话，并把归档总结作为背景注入。
 *  归档语义是"总结后清空原对话"，原始消息不可恢复——"继续"= 以总结为起点的新任务。 */
export async function continueFromArchive(projectId: string, entry: { ts: string; title: string; summary: string }): Promise<void> {
  await createSessionInProject(projectId)
  await sendMessage(`请基于以下历史归档继续工作（${entry.ts} · ${entry.title}）：\n\n${entry.summary}\n\n——请先简要确认你从中掌握的背景，然后等我给出具体任务。`)
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

/** 归档会话（ZCode 式标记移除，消息保留可在归档区恢复）并从列表移除。
 *  归档的是最后一个会话时自动新建兜底会话，保证界面始终有当前会话 */
export async function removeSession(id: string): Promise<void> {
  const title = store.sessions[id]?.meta.title || '会话'
  const pid = store.sessions[id]?.meta.projectId
  const projName = (store.cfg?.projects || []).find((p: any) => p.id === pid)?.name
  const arch = projName ? `对话内容将总结归档到项目「${projName}」，供该项目其他会话参考；` : '该会话未绑定项目，内容不会归档；'
  if (!(await window.sqlpilot.uiConfirm(`归档会话「${title}」？`, `${arch}会话将从列表移除。`, true))) return
  const r = await window.sqlpilot.archiveSession(id, true)
  if (!r.ok) {
    await window.sqlpilot.uiAlert(r.error || '归档失败')
    return
  }
  // 归档瞬时完成（消息保留在 sessions.json，可在项目树归档区 ↻ 恢复）：立即从活跃列表移除
  delete store.sessions[id]
  store.sessionOrder = store.sessionOrder.filter((x) => x !== id)
  if (!store.sessionOrder.length) {
    await createSession() // 最后一个会话被归档：自动新建兜底，界面不落空
  } else if (store.currentId === id) {
    store.currentId = store.sessionOrder[store.sessionOrder.length - 1]
  }
  pushNotice(r.archived
    ? `会话「${title}」已归档（智能总结后台生成中，可在项目树归档区恢复）`
    : `会话「${title}」${r.note || '已移除'}`)
}

/** 恢复归档会话（ZCode resurrection）：回到活跃列表并切换过去，原对话完整保留 */
export async function restoreArchivedSession(id: string): Promise<void> {
  const r = await window.sqlpilot.unarchiveSession(id)
  if (!r.ok) {
    window.sqlpilot.uiAlert(r.error || '恢复失败')
    return
  }
  ensureSessionRecord(r.session)
  const hist = await window.sqlpilot.getHistory(id)
  if (hist.ok && Array.isArray(hist.messages)) store.sessions[id].msgs = historyToUi(hist.messages)
  store.currentId = id
}

/** 归档当前对话并新开一个会话（原"清空对话"）：
 *  瞬时归档模型下，"归档当前对话" = 当前会话标记归档（可在归档区恢复）+ 自动新建会话接替。
 *  此前 remove=false 只清消息——主进程已标记归档而界面仍显示该会话，状态分裂且看似"归档没反应" */
export async function archiveAndClear(): Promise<void> {
  const s = curSession()
  if (!s) return
  if (s.msgs.length && !(await window.sqlpilot.uiConfirm('归档当前对话？', '对话将归档到项目（可在项目树归档区恢复），并为你新开一个会话。'))) return
  const title = s.meta.title || '会话'
  const id = store.currentId
  const r = await window.sqlpilot.archiveSession(id, true)
  if (!r.ok) {
    await window.sqlpilot.uiAlert(r.error || '归档失败')
    return
  }
  delete store.sessions[id]
  store.sessionOrder = store.sessionOrder.filter((x) => x !== id)
  await createSession()
  pushNotice(r.archived ? `对话「${title}」已归档（可在项目树归档区恢复），已新开会话` : (r.note || '已新开会话'))
}

/** 切换当前会话权限模式；返回是否真的切换（会话放开/完全放开的确认被取消时返回 false，下拉框据此回退显示） */
export async function setSessionMode(mode: string): Promise<boolean> {
  const s = curSession()
  if (!s || s.meta.mode === mode) return true
  if (mode === 'yolo' || mode === 'session') {
    const label = mode === 'yolo' ? '完全放开（所有操作自动执行，含高危）' : '会话放开（普通写操作本会话自动执行）'
    if (!(await window.sqlpilot.uiConfirm(`确认将本会话切换到「${label}」？`, '仅影响当前会话；切换后无需再逐次确认写操作', mode === 'yolo'))) {
      const cur = MODES.find((m) => m.key === s.meta.mode)
      pushNotice(`已取消切换，本会话仍为「${cur?.label || s.meta.mode}」模式`)
      return false
    }
  }
  s.meta.mode = mode
  s.meta.prePlanMode = null
  await window.sqlpilot.updateSession(store.currentId, { mode })
  return true
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
  // 运行中切换会被主进程拒绝（同一回合工具上下文不能中途漂移）；先本地拦截给出直接提示
  if (s.running && projectId !== null) {
    window.sqlpilot.uiAlert('会话执行中不能切换项目：请先停止任务再切换')
    return
  }
  const r = await window.sqlpilot.updateSession(store.currentId, { projectId })
  if (!r.ok) {
    window.sqlpilot.uiAlert((r as any).error || '切换项目失败')
    return
  }
  s.meta.projectId = projectId
}

/** 计划模式：批准最后一版计划并恢复计划前的权限模式开始执行。
 *  计划前是会话放开/完全放开时恢复原选择（用户的显式选择不该被自动规划降级）；
 *  其余情况（只读/无记录）回落到确认执行——批准计划本身就是执行意图 */
export async function approvePlan(): Promise<void> {
  const s = curSession()
  if (!s || s.meta.mode !== 'plan') return
  const target = s.meta.prePlanMode === 'session' || s.meta.prePlanMode === 'yolo' ? s.meta.prePlanMode : 'confirm'
  s.meta.mode = target
  s.meta.prePlanMode = null
  await window.sqlpilot.updateSession(store.currentId, { mode: target })
  await sendMessage('批准以上计划，请严格按计划开始执行。')
}

/** 打开/关闭子代理完整过程弹窗 */
export function openSubRun(runId: string, title: string): void {
  store.subRun = { runId, title }
}

export function closeSubRun(): void {
  store.subRun = null
}

// ---------- 任务栏 ----------
function upsertTask(kind: 'db' | 'server', refId: string, title: string, icon: string): void {
  const id = kind + ':' + refId
  if (!store.tasks.some((t) => t.id === id)) store.tasks.push({ id, kind, refId, title, icon })
}

/** 从连接打开数据库工作台任务：挂载工作台 + 切换视图 + 定位该连接 */
export function openDbTask(conn: { id: string; name: string }): void {
  upsertTask('db', conn.id, conn.name, '🗄')
  store.lastDbConn = conn.id
  store.dbOpen = true
  store.view = 'db'
  store.pendingDbConn = conn.id
}

/** 从服务器打开终端任务：确保终端面板打开并激活该服务器 shell */
export function openServerTask(server: { id: string; name: string }): void {
  upsertTask('server', server.id, server.name, '🖥')
  store.activeTermServerId = server.id
  const full = (store.cfg?.servers || []).find((s: any) => s.id === server.id)
  if (full) store.pendingTermServer = full
  store.workbench = 'terminal'
}

/** 任务栏主体点击：显示对应窗口 */
export function activateTask(t: { kind: 'db' | 'server'; refId: string }): void {
  if (t.kind === 'db') {
    store.dbOpen = true
    store.view = 'db'
    store.lastDbConn = t.refId
    store.pendingDbConn = t.refId
  } else {
    store.activeTermServerId = t.refId
    const full = (store.cfg?.servers || []).find((s: any) => s.id === t.refId)
    if (full) store.pendingTermServer = full
    store.workbench = 'terminal'
  }
}

/** 任务栏 −：隐藏窗口（状态保留：工作台 v-show / shell 常驻） */
export function minimizeTask(t: { kind: 'db' | 'server' }): void {
  if (t.kind === 'db') {
    if (store.view === 'db') store.view = 'chat'
  } else {
    if (store.workbench) store.workbench = null
  }
}

/** 关闭整个数据库工作台（窗口 ✕）：移除全部数据库任务并销毁挂载 */
export function closeDbWorkbench(): void {
  store.tasks = store.tasks.filter((t) => t.kind !== 'db')
  store.lastDbConn = null
  store.dbOpen = false
  if (store.view === 'db') store.view = 'chat'
}

/** 任务栏 ✕：关闭并销毁（数据库任务最后一个时销毁工作台；服务器任务关闭对应 shell） */
export function closeTask(t: { id: string; kind: 'db' | 'server'; refId: string }): void {
  store.tasks = store.tasks.filter((x) => x.id !== t.id)
  if (t.kind === 'db') {
    store.lastDbConn = null
    if (!store.tasks.some((x) => x.kind === 'db')) {
      store.dbOpen = false
      if (store.view === 'db') store.view = 'chat'
    }
  } else {
    if (store.activeTermServerId === t.refId) store.activeTermServerId = null
    store.pendingKillTermServer = t.refId // WorkbenchPanel 消费：关 shell + 移 tab
  }
}

/** 全局浮窗提示（右下角 toast，4 秒自动消失）：
 *  此前以 error 消息塞进当前会话——归档空会话等操作反馈会在对话流顶部弹红条，
 *  语义误导（不是错误）且污染会话视图；操作反馈一律走浮窗 */
let toastSeq = 0
export function pushNotice(text: string): void {
  const t = { id: ++toastSeq, text }
  store.toasts.push(t)
  if (store.toasts.length > 4) store.toasts.splice(0, store.toasts.length - 4)
  setTimeout(() => {
    store.toasts = store.toasts.filter((x) => x.id !== t.id)
  }, 4_000)
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
