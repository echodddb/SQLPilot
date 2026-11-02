/**
 * OB 故障排查 Agent（主进程）
 *
 * 与「云管 AI」「编辑器 AI」的区别：这个助手会**真的在目标主机上跑命令**，
 * 所以整个设计的重心不是把上下文喂饱，而是「命令能不能跑」这件事有人把关：
 *
 *   1. 模型只能通过 run_commands / run_command 两个工具提命令，一次最多 3 条；
 *   2. 每条命令先过 policy.ts 分档 —— deny 直接拦死（连确认按钮都不给），
 *      confirm 必须人工点，safe 按用户选的模式自动跑或也确认；
 *   3. 执行走 ssh.execCommand（复用连接池、带超时、64KB 头尾裁剪）；
 *   4. 每条命令与结果都进审计日志，事后能查「那天 agent 到底跑了什么」。
 *
 * 事件流与编辑器 AI 一致：ask 只代表「已开始」，正文与命令卡片走 obagent:event。
 */

import { loadConfig } from '../config'
import { callLlm } from '../agent/llm'
import { execCommand } from '../ssh'
import { appendAudit } from '../audit'
import { classifyCommand, splitCommands } from './policy'
import { clipMiddle, obAgentSystemPrompt, obAgentUserMessage } from './prompt'
import type { ObAgentAskInput, ObAgentEvent, ObAgentStatus } from './types'
import type { ChatMsg, ProviderConfig, SshServer, ToolCall } from '../types'
import type { ToolDef } from '../tools'

export type { ObAgentAskInput, ObAgentContext, ObAgentEvent, ObAgentStatus } from './types'
export { clipMiddle, contextBlock, obAgentSystemPrompt, obAgentUserMessage } from './prompt'

let send: (ev: ObAgentEvent) => void = () => {}
export function bindObAgentEmitter(fn: (ev: ObAgentEvent) => void): void {
  send = fn
}

/** 正在跑的对话（点停止时中断） */
const running = new Map<string, AbortController>()

type ApprovalDecision = 'run' | 'skip' | 'always'

/** 等用户点「执行 / 跳过 / 以后同类都执行」的命令 */
const approvals = new Map<string, (d: ApprovalDecision) => void>()

export function resolveObAgentApproval(cmdId: string, decision: string): { ok: boolean } {
  const w = approvals.get(String(cmdId || ''))
  if (!w) return { ok: false }
  w(decision === 'run' ? 'run' : decision === 'always' ? 'always' : 'skip')
  return { ok: true }
}

export function stopObAgent(id: string): { ok: boolean } {
  const ctrl = running.get(String(id || ''))
  if (ctrl) {
    ctrl.abort()
    running.delete(String(id))
  }
  return { ok: true }
}

// ---------------------------------------------------------------- 上限

/** 一个对话最多几轮模型调用（每轮最多 3 条命令，15 条命令够查一个故障了） */
const MAX_STEPS = 6
const MAX_CMDS_PER_ROUND = 3
const MAX_TOTAL_CMDS = 15
/** 单条命令执行超时：只读诊断再慢也不该超过 40s */
const CMD_TIMEOUT_MS = 40_000
/** 回传给模型的输出上限（超了截中间，保留头尾） */
const MODEL_OUTPUT_CAP = 6000
/** 界面展示上限 */
const UI_OUTPUT_CAP = 20_000
/** 等人点确认的最长时间，超时按跳过处理（免得整条链路一直挂着） */
const APPROVAL_TIMEOUT_MS = 300_000

// ---------------------------------------------------------------- 工具

const CMD_ITEM = {
  type: 'object',
  properties: {
    command: { type: 'string', description: '完整 shell 命令，单行；可用管道；不要 sudo，不要重定向写文件' },
    why: { type: 'string', description: '这条命令要查什么，一句话，会展示给用户' }
  },
  required: ['command', 'why']
}

const BATCH_TOOL: ToolDef = {
  name: 'run_commands',
  description:
    '一次提交最多 3 条只读诊断命令（按顺序执行）。排查时优先用它，比一条条提效率高。' +
    '每条命令都会单独过安全检查：被拦的会告诉你原因，被用户跳过的会标记 skipped。',
  parameters: {
    type: 'object',
    properties: { commands: { type: 'array', description: '命令列表（1-3 条），按执行顺序', items: CMD_ITEM } },
    required: ['commands']
  }
}

const RUN_CMD: ToolDef = {
  name: 'run_command',
  description:
    '在目标 OBServer 主机上执行一条只读诊断命令，并把输出返回给你。' +
    '只允许查询类命令（查看进程、资源、日志、OB 视图）；任何写文件、重启、改配置、提权的命令都会被拦截。' +
    '需要多条时请用 run_commands 一次提交。',
  parameters: {
    type: 'object',
    properties: CMD_ITEM.properties,
    required: ['command', 'why']
  }
}

/** 兼容两种工具名：单条 / 批量 */
function parseCalls(tc: ToolCall): { command: string; why: string }[] {
  let args: any = {}
  try {
    args = JSON.parse(tc.args || '{}')
  } catch {
    return []
  }
  if (Array.isArray(args?.commands)) {
    return args.commands
      .filter((c: any) => c && typeof c.command === 'string')
      .slice(0, MAX_CMDS_PER_ROUND)
      .map((c: any) => ({ command: String(c.command), why: String(c.why || '') }))
  }
  if (typeof args?.command === 'string') return [{ command: String(args.command), why: String(args.why || '') }]
  return []
}

// ---------------------------------------------------------------- 执行

function waitApproval(cmdId: string, signal: AbortSignal): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    let done = false
    const finish = (d: ApprovalDecision) => {
      if (done) return
      done = true
      approvals.delete(cmdId)
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(d)
    }
    const timer = setTimeout(() => finish('skip'), APPROVAL_TIMEOUT_MS)
    const onAbort = () => finish('skip')
    approvals.set(cmdId, finish)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}


interface RanCmd {
  status: ObAgentStatus
  output: string
  exitCode?: number | null
  ms?: number
  note?: string
}

interface RunOneOpts {
  id: string
  cmdId: string
  server: SshServer
  command: string
  why: string
  signal: AbortSignal
  /** true = 不弹确认直接跑（safe 级 / 用户点过「以后同类都执行」） */
  autoRun: boolean
  /** 用户点「以后同类都执行」时回调，把规则记进本次对话 */
  markAuto: (rule: string) => void
}

async function runOne(o: RunOneOpts): Promise<RanCmd> {
  const { id, cmdId, server, signal } = o
  const shown = o.command.replace(/\s+/g, ' ').trim()
  const verdict = classifyCommand(o.command)
  const auditBase = {
    kind: 'tool' as const,
    actor: 'agent',
    tool: 'ob_troubleshoot',
    conn: `${server.name} (${server.host})`,
    sql: maskCmdSecrets(shown)
  }

  // 1) 硬拦截：连确认按钮都不给
  if (verdict.risk === 'deny') {
    send({ type: 'cmd', id, cmdId, command: shown, why: o.why, risk: 'deny', rule: verdict.rule, reason: verdict.reason, status: 'blocked' })
    appendAudit({ ...auditBase, mode: 'readonly', approved: false, detail: `被安全策略拦截（${verdict.rule}）：${verdict.reason}` })
    return { status: 'blocked', output: `[已拦截] ${verdict.reason}。请换一条只读命令。` }
  }

  // 2) 需要人点
  if (!o.autoRun) {
    send({ type: 'cmd', id, cmdId, command: shown, why: o.why, risk: verdict.risk, rule: verdict.rule, reason: verdict.reason, status: 'waiting' })
    const decision = await waitApproval(cmdId, signal)
    if (decision === 'skip') {
      send({ type: 'cmd-update', id, cmdId, status: 'skipped', note: signal.aborted ? '已停止' : '用户跳过' })
      return { status: 'skipped', output: `$ ${shown}\n[用户跳过] 这条命令没有被执行，请换别的手段或直接说明结论。` }
    }
    if (decision === 'always') o.markAuto(verdict.rule)
    send({ type: 'cmd-update', id, cmdId, status: 'running' })
  } else {
    send({ type: 'cmd', id, cmdId, command: shown, why: o.why, risk: verdict.risk, rule: verdict.rule, reason: verdict.reason, status: 'running' })
  }

  // 3) 执行
  const t0 = Date.now()
  try {
    const r = await execCommand(server, o.command, CMD_TIMEOUT_MS, undefined, signal, 'utf-8')
    const ms = Date.now() - t0
    const raw = String(r.stdout || '') + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')
    const ok = r.exitCode === 0 && !r.timedOut && !r.aborted
    const status: ObAgentStatus = ok ? 'done' : 'failed'
    const note = r.timedOut ? `超时（${Math.round(CMD_TIMEOUT_MS / 1000)}s）` : r.aborted ? '已停止' : ok ? '' : `退出码 ${r.exitCode ?? 'null'}`
    send({ type: 'cmd-update', id, cmdId, status, exitCode: r.exitCode, ms, output: clipMiddle(raw, UI_OUTPUT_CAP).text, note })
    appendAudit({
      ...auditBase,
      ms,
      mode: verdict.risk === 'safe' ? 'readonly' : 'confirm',
      approved: true,
      error: ok ? undefined : note || undefined,
      detail: `Agent 排障命令（${verdict.rule}）`
    })
    const meta = [`退出码 ${r.exitCode ?? 'null'}`, `${ms}ms`].join(' · ')
    return {
      status,
      exitCode: r.exitCode,
      ms,
      note,
      output: `$ ${shown}\n${meta}${note ? ` · ${note}` : ''}\n${clipMiddle(raw, MODEL_OUTPUT_CAP).text || '（无输出）'}`
    }
  } catch (e: any) {
    const ms = Date.now() - t0
    const msg = String(e?.message || e)
    send({ type: 'cmd-update', id, cmdId, status: 'failed', ms, note: msg.slice(0, 200) })
    appendAudit({ ...auditBase, ms, mode: verdict.risk === 'safe' ? 'readonly' : 'confirm', approved: true, error: msg.slice(0, 300), detail: 'Agent 排障命令执行失败' })
    return { status: 'failed', ms, note: msg, output: `$ ${shown}\n执行失败：${msg}` }
  }
}

// ---------------------------------------------------------------- 主流程

/**
 * 进审计前抹掉命令里的口令：obclient -p'xxx' / --password=xxx。
 * 命令本身照原样执行与展示，只有落盘的审计要脱敏。
 */
export function maskCmdSecrets(cmd: string): string {
  return String(cmd || '')
    .replace(/(--password[= ])(\S+)/gi, '$1***')
    .replace(/(-p)\s*'[^']*'/g, '$1***')
    .replace(/(\s-p)\s*"[^"]*"/g, '$1***')
    // 只抹「-p 后面紧跟一串非数字」的形态，别把 `ps -p 12345` 也抹了
    .replace(/(\s-p)(?=[^\s\d])\S+/g, '$1***')
}

function pickProvider(): ProviderConfig | { error: string } {
  const cfg = loadConfig()
  const p = cfg.providers.find((x) => x.id === cfg.activeProviderId) || cfg.providers[0]
  if (!p) return { error: '尚未配置大模型：请先在「设置」里选择厂商和模型' }
  return p
}

/**
 * 发起一次排查；返回 ok 只代表「已开始」，正文与命令卡片走 obagent:event。
 */
export async function askObAgent(input: ObAgentAskInput): Promise<{ ok: boolean; error?: string }> {
  const id = String(input?.id || '')
  const question = String(input?.question || '').trim()
  if (!id) return { ok: false, error: '缺少请求 id' }
  if (!question) return { ok: false, error: '请输入要查的问题' }
  if (running.has(id)) return { ok: false, error: '这一条还在排查中' }

  const server = loadConfig().servers.find((s) => s.id === String(input.serverId || ''))
  if (!server) return { ok: false, error: '服务器不存在（可能已删除）' }

  const provider = pickProvider()
  if ('error' in provider) return { ok: false, error: provider.error }

  const mode: 'auto' | 'confirm' = input.mode === 'confirm' ? 'confirm' : 'auto'
  const system = obAgentSystemPrompt(input.context, mode)
  const history: ChatMsg[] = (input.history || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
    .slice(-8)
    .map((m) => ({ role: m.role, content: String(m.text) }))

  const ctrl = new AbortController()
  running.set(id, ctrl)

  void (async () => {
    let step = 0
    let totalCmds = 0
    let cmdSeq = 0
    let finalText = ''
    /** 本对话内用户点过「以后同类都执行」的规则（不落盘，关掉浮窗就忘了） */
    const autoRules = new Set<string>()
    /** 被拦 / 被跳过的命令，避免模型原样重提 */
    const refused = new Set<string>()
    const messages: ChatMsg[] = [...history, { role: 'user', content: obAgentUserMessage(question) }]

    try {
      send({ type: 'start', id })

      while (step < MAX_STEPS) {
        if (ctrl.signal.aborted) throw new Error('已停止')
        step++

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

        const res = await (async () => {
          try {
            return await callLlm(
              provider,
              system,
              messages,
              [BATCH_TOOL, RUN_CMD],
              {
                onText: (t: string) => {
                  pending += t
                  if (!timer) timer = setTimeout(flush, 50)
                },
                onReasoning: (t: string) => {
                  reasoningChars += t.length
                  if (!rtimer) {
                    rtimer = setTimeout(() => {
                      rtimer = null
                      send({ type: 'reasoning', id, chars: reasoningChars })
                    }, 150)
                  }
                }
              },
              { signal: ctrl.signal }
            )
          } finally {
            if (timer) clearTimeout(timer)
            if (rtimer) clearTimeout(rtimer)
            flush()
          }
        })()

        const text = String(res.content || '').trim()
        const toolCalls = res.toolCalls || []
        // 本轮文本先定稿（后面可能跟命令卡片），最终结论取最后一轮
        send({ type: 'round-end', id, text })
        if (text) finalText = text

        if (!toolCalls.length) {
          if (!text) {
            send({ type: 'error', id, error: '模型没有返回内容' })
            return
          }
          send({ type: 'done', id, text: finalText, commands: totalCmds })
          return
        }

        messages.push({
          role: 'assistant',
          content: text || null,
          toolCalls,
          thinking: res.thinking,
          thinkingSig: res.thinkingSig
        })

        // 每个 tool_call 都必须有一条 tool 结果，否则下一轮请求会因消息不配对被拒
        for (const tc of toolCalls) {
          if (tc.name !== RUN_CMD.name && tc.name !== BATCH_TOOL.name) {
            messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: '[工具不存在] 只能用 run_commands 提命令。' })
            continue
          }
          const list = parseCalls(tc)
          if (!list.length) {
            messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: '[参数为空] 没有可执行的命令。' })
            continue
          }
          const results: string[] = []
          for (const item of list) {
            if (totalCmds >= MAX_TOTAL_CMDS) {
              results.push('[已达本次排查的命令上限，请基于现有证据给结论]')
              continue
            }
            const key = item.command.replace(/\s+/g, ' ').trim()
            if (refused.has(key)) {
              results.push(`$ ${key}\n[跳过] 这条命令本次已提过并被拒绝/跳过，请换别的手段。`)
              continue
            }
            totalCmds++
            const cmdId = `${id}_c${++cmdSeq}`
            const verdict = classifyCommand(item.command)
            // 直接跑的条件：安全的只读命令（auto 模式）或用户点过「以后同类都执行」
            const autoRun = verdict.risk !== 'deny' && (autoRules.has(verdict.rule) || (mode === 'auto' && verdict.risk === 'safe'))
            const r = await runOne({
              id,
              cmdId,
              server,
              command: item.command,
              why: item.why,
              signal: ctrl.signal,
              autoRun,
              markAuto: (rule) => autoRules.add(rule)
            })
            if (r.status === 'blocked' || r.status === 'skipped') refused.add(key)
            results.push(r.output)
          }
          messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: results.join('\n\n') })
        }
      }

      // 轮数用完：让模型基于现有证据收个尾（不再给工具）
      const wrap = await callLlm(
        provider,
        system,
        [...messages, { role: 'user', content: '（已达本次排查的轮数上限，请不要再提命令，直接基于上面的证据给结论与建议。）' }],
        [],
        { onText: (t: string) => send({ type: 'delta', id, text: t }) },
        { signal: ctrl.signal }
      )
      const tail = String(wrap.content || '').trim()
      if (tail) {
        finalText = tail
        send({ type: 'round-end', id, text: tail })
      }
      send({ type: 'done', id, text: finalText, commands: totalCmds })
    } catch (e: any) {
      const msg = String(e?.message || e)
      send({ type: 'error', id, error: /abort|取消/i.test(msg) ? '已停止' : msg })
    } finally {
      running.delete(id)
      // 收尾：把还挂着的确认请求放掉，避免 Promise 泄漏
      for (const [, fn] of approvals) fn('skip')
      approvals.clear()
    }
  })()

  return { ok: true }
}

/** 给单测用：命令拆分的快捷入口（与 policy 同源，避免两处口径） */
export { splitCommands }
