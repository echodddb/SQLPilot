// 后台/自动转后台子代理的任务注册表（对标 ZCode runtime-task registry 的最小化）。
// 独立成模块避免 tools ↔ subagent 循环依赖：task_output/task_stop 工具与 launchSubagent 共用。
// 仅内存态：应用退出即失（后台子代理随主进程终止，属已知边界）。

export type SubtaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface SubagentTaskInfo {
  id: string
  sessionId: string
  agentType: string
  description: string
  status: SubtaskStatus
  startedAt: number
  endedAt?: number
  /** 结束摘要："2 轮 · 5 次工具 · 95s" */
  summary?: string
  /** 报告文件（项目内相对路径，有项目绑定时才有） */
  runFile?: string
  /** 最终报告全文（终态后可经 task_output 取回） */
  report?: string
}

interface TaskEntry extends SubagentTaskInfo {
  abort: AbortController
  /** 完成信号：status 进入终态时 resolve（waitSubagentTask 用） */
  done: Promise<void>
  resolveDone: () => void
  /** 通知已发（ZCode notified 标记：防重复通知） */
  notified: boolean
}

const tasks = new Map<string, TaskEntry>()
const listeners: Array<(ev: { sessionId: string; tasks: SubagentTaskInfo[] }) => void> = []

export function onSubtaskChange(cb: (ev: { sessionId: string; tasks: SubagentTaskInfo[] }) => void): void {
  listeners.push(cb)
}

function notifyChange(sessionId: string): void {
  const snapshot = listSubagentTasks(sessionId)
  for (const cb of listeners) {
    try { cb({ sessionId, tasks: JSON.parse(JSON.stringify(snapshot)) }) } catch { /* 监听器异常不影响任务 */ }
  }
}

export function registerSubagentTask(info: Pick<SubagentTaskInfo, 'id' | 'sessionId' | 'agentType' | 'description'>): AbortController {
  const existing = tasks.get(info.id)
  if (existing) return existing.abort
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((r) => { resolveDone = r })
  const entry: TaskEntry = {
    id: info.id,
    sessionId: info.sessionId,
    agentType: info.agentType,
    description: info.description,
    status: 'running',
    startedAt: Date.now(),
    abort: new AbortController(),
    done,
    resolveDone,
    notified: false
  }
  tasks.set(info.id, entry)
  notifyChange(info.sessionId)
  return entry.abort
}

export function finishSubagentTask(id: string, status: SubtaskStatus, summary?: string, runFile?: string, report?: string): void {
  const t = tasks.get(id)
  if (!t || t.status !== 'running') return
  t.status = status
  t.endedAt = Date.now()
  t.summary = summary
  if (runFile) t.runFile = runFile
  if (report) t.report = report
  t.resolveDone()
  notifyChange(t.sessionId)
}

/** 终态任务保留 30 分钟供 task_output 读取，之后清理防 Map 无限膨胀 */
export function pruneSubagentTasks(maxAgeMs = 30 * 60_000): void {
  const now = Date.now()
  for (const [id, t] of tasks) {
    if (t.status !== 'running' && t.endedAt && now - t.endedAt > maxAgeMs) tasks.delete(id)
  }
}

export function stopSubagentTask(id: string): { ok: boolean; status?: SubtaskStatus } {
  const t = tasks.get(id)
  if (!t) return { ok: false }
  if (t.status === 'running') {
    t.abort.abort()
    // 状态由执行路径的 finalize 落终态；此处立即返回 running 表示已发出中止
    return { ok: true, status: 'running' }
  }
  return { ok: true, status: t.status }
}

/** 停掉某会话全部运行中任务（会话删除/清空时调用） */
export function stopSubtasksOfSession(sessionId: string): void {
  for (const t of tasks.values()) {
    if (t.sessionId === sessionId && t.status === 'running') t.abort.abort()
  }
}

/** 等任务进入终态；超时返回当前仍为 running 的快照 */
export async function waitSubagentTask(id: string, timeoutMs: number): Promise<SubagentTaskInfo | null> {
  const t = tasks.get(id)
  if (!t) return null
  const timer = new Promise<'timeout'>((r) => {
    const h = setTimeout(() => r('timeout'), Math.min(Math.max(timeoutMs, 0), 120_000))
    h.unref?.()
  })
  const winner = await Promise.race([t.done.then(() => 'done' as const), timer])
  return winner === 'done' ? subagentTaskInfo(t) : (t.status === 'running' ? subagentTaskInfo(t) : subagentTaskInfo(t))
}

function subagentTaskInfo(t: TaskEntry): SubagentTaskInfo {
  const { abort: _a, done: _d, resolveDone: _r, notified: _n, ...info } = t
  return { ...info }
}

export function listSubagentTasks(sessionId?: string): SubagentTaskInfo[] {
  pruneSubagentTasks()
  const out: SubagentTaskInfo[] = []
  for (const t of tasks.values()) {
    if (!sessionId || t.sessionId === sessionId) out.push(subagentTaskInfo(t))
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

/** 完成通知是否已发（防重）：标记并返回先前值 */
export function markNotified(id: string): boolean {
  const t = tasks.get(id)
  if (!t) return true
  const was = t.notified
  t.notified = true
  return was
}
