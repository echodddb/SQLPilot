/**
 * OB 故障排查 Agent · 共享类型
 *
 * 放在单独文件里，是为了让 prompt.ts（纯逻辑、可单测）能引用上下文结构，
 * 而不用把 index.ts 里那堆 ssh / electron 依赖一起拖进测试。
 */

import type { ObCmdRisk } from './policy'

export type ObAgentStatus = 'waiting' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped'

export interface ObAgentContext {
  /** 服务器显示名，提示词里用来称呼目标机 */
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

export interface ObAgentAskInput {
  id: string
  serverId: string
  question: string
  /** 当前页面上的日志分析结论（渲染层传过来，避免主进程重扫一遍） */
  context?: ObAgentContext
  /** 同一浮窗里的历史问答（纯文本） */
  history?: { role: 'user' | 'assistant'; text: string }[]
  /** auto=只读命令自动跑；confirm=每条都点一下。deny 级永远拦 */
  mode?: 'auto' | 'confirm'
}

export type ObAgentEvent =
  | { type: 'start'; id: string }
  | { type: 'reasoning'; id: string; chars: number }
  | { type: 'delta'; id: string; text: string }
  | { type: 'round-end'; id: string; text: string }
  | {
      type: 'cmd'
      id: string
      cmdId: string
      command: string
      why: string
      risk: ObCmdRisk
      rule: string
      reason: string
      status: ObAgentStatus
    }
  | { type: 'cmd-update'; id: string; cmdId: string; status: ObAgentStatus; exitCode?: number | null; ms?: number; output?: string; note?: string }
  | { type: 'done'; id: string; text: string; commands: number }
  | { type: 'error'; id: string; error: string }
