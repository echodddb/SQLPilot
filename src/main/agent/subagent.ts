// 子代理（sub-agent）：由主会话通过 agent_spawn 工具派生的独立执行体。
// 设计参考 ZCode（github.com/zai-org/ZCode）：
//  - 子代理拥有独立上下文（看不到父会话历史），只收到自包含的任务书
//  - 工具面强制剔除规划工具与 agent_spawn（禁嵌套，防失控）
//  - 权限钳制"子 ≤ 父"：explore 强制只读；plan 模式下子代理按只读行事
//  - 确认弹窗路由回父会话并标注来源；共享父会话的 sessionApproved
//  - 结束只回传最终报告（最后一条 assistant 文本），中间工具结果不进父上下文
//  - 过程审计落盘（JSONL，供人查看/单条检索，不整读回模型——ZCode 明确警告会撑爆上下文）
//  - 前台超时自动转后台 + 显式后台派生（launchSubagent，对标 ZCode autoBackgroundMs）
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentEvent, RunDeps } from './loop'
import { TOOLS, executeTool } from '../tools'
import type { ApprovalRequest, ToolContext } from '../tools'
import type { ChatMsg, ConnProfile, PermissionMode, ProviderConfig, SshServer, ThinkingEffort } from '../types'
import { callLlm } from './llm'
import { appendAudit } from '../audit'
import { finishSubagentTask, markNotified, registerSubagentTask } from './subtask-registry'
import { AUDIT_RESULT_HEAD, logRunLine, writeReportArtifact } from './subagent-audit'

export interface SubagentProfile {
  name: string
  description: string
  /** 正文 = 子代理专属系统提示词（前置在通用规则之上） */
  systemPrompt: string
  /** 工具白名单（缺省 = 全量工具减 CHILD_BANNED） */
  allow?: string[]
  /** true = 无论父会话什么权限模式都按只读运行 */
  forceReadonly: boolean
  maxTurns: number
}

/** 子代理统一禁用的工具：规划工具（子代理没有计划批准面，暴露会挂起父回合）+
 *  agent_spawn（v1 禁嵌套）+ 任务收割工具（兄弟任务互不干涉，收割权在主代理） */
const CHILD_BANNED = ['enter_plan_mode', 'exit_plan_mode', 'agent_spawn', 'task_output', 'task_stop']

/** explore 工具面：只读 + memory_append（记忆写入是应用内事实库，非破坏性，readonly 模式也放行） */
const READONLY_TOOLS = [
  'db_list_schemas', 'db_list_tables', 'db_describe_table', 'db_get_ddl', 'db_query',
  'fs_list', 'fs_read', 'server_read_file', 'server_tail', 'read_skill', 'memory_append'
]

const BUILTIN_SUBAGENTS: SubagentProfile[] = [
  {
    name: 'explore',
    description: '只读探索与采集代理（对标 ZCode Explore）：扫 schema/找表/确认结构/采集状态数据/读日志。工具面仅限只读查询与文件读取，任何权限模式下都不能写。适合会产生大量中间工具结果、只需要结论的探索任务；可一次派多个并行采集（如每个连接一个），也可 run_in_background 后台执行。',
    systemPrompt: `你是数据库只读探索与采集专家。
【严格只读】本次任务禁止对数据库/文件系统做任何写操作：不执行 DML/DDL，不写/删文件，不运行改变系统状态的命令；你的工具面已限定为只读，尝试写操作会被拒绝。
你的强项：
- 大范围扫 schema/表/列结构，快速定位目标对象（先 list 再 describe，禁止凭猜测拼表名列名）
- 采集状态数据（会话/存储/参数/等待事件等）并提炼结论
- 读取并消化日志与文件内容，返回异常摘要
工作要求：
- 尽量在一条回复里并行发多个无依赖的工具调用，快速收敛，不逐个串行探索
- 查询带 WHERE 条件与行数限制
- 结论里的对象名写全（schema.table），数字给量级与单位
- 探索中确认的稳定环境事实（库版本/规模/性能坑等）可用 memory_append 直接记录（带 conn 参数注明来源连接）
- 不臆测：凡未确认的结构先用工具核实`,
    allow: READONLY_TOOLS,
    forceReadonly: true,
    maxTurns: 12
  },
  {
    name: 'general',
    description: '通用代理：继承本会话权限模式，适合委托独立完整的子任务（如"在测试库验证这批 SQL"）。写操作仍受权限模式与确认弹窗约束，不会比本会话更宽松；不要用它绕过本会话的任何限制。支持 run_in_background 后台执行。',
    systemPrompt: `你是通用子代理，负责独立完成主代理委托的一项完整子任务（探索、验证、分析，或按任务书执行操作）。
工作要求：
- 任务要么做完，要么明确说明卡在哪里与已确认的部分，不擅自扩大范围
- 缺失的信息用工具自行确认，不臆测表结构
- 探索中确认的稳定环境事实（库版本/规模/约定/坑）可用 memory_append 直接记录（带 conn 参数注明来源连接）
- 你的最终回复就是提交给主代理的报告：完成了什么、关键发现与数字、遗留问题；内容直接写在回复里，不要写报告文件`,
    forceReadonly: false,
    maxTurns: 12
  }
]

/** v1 仅内置类型；M2 在此扩展 userData/agents/*.md 自定义 profile（同名覆盖内置） */
export function resolveSubagent(typeName: string): SubagentProfile | undefined {
  const key = String(typeName || '').trim().toLowerCase()
  return BUILTIN_SUBAGENTS.find((p) => p.name === key)
}

/** 供系统提示词"可用子代理"清单与 agent_spawn 工具描述使用 */
export function listSubagentsForPrompt(): { name: string; description: string; tools: string }[] {
  return BUILTIN_SUBAGENTS.map((p) => ({
    name: p.name,
    description: p.description,
    tools: subagentToolset(p).join(', ')
  }))
}

export function subagentToolset(p: SubagentProfile): string[] {
  const all = TOOLS.map((t) => t.name).filter((n) => !CHILD_BANNED.includes(n))
  if (!p.allow) return all
  // 白名单 ∩ 实际工具集：拼写错误或越权的名字直接失效
  const valid = new Set(all)
  return p.allow.filter((n) => valid.has(n))
}

export interface SubagentRunInput {
  /** 父会话 id（事件与确认弹窗归属） */
  sessionId: string
  /** = agent_spawn 的 toolCallId（渲染层据此把 sub-* 事件挂到对应工具卡片；也是任务 id 与审计文件名） */
  subId: string
  profile: SubagentProfile
  description: string
  prompt: string
  provider: ProviderConfig
  /** 继承父会话的思考级别 */
  effort: ThinkingEffort | null
  parentMode: PermissionMode
  /** 停止信号（父会话停止或 task_stop；launchSubagent 会代理成任务级控制器） */
  cancelSignal: AbortSignal
  /** 共享父会话的放行集合："本会话均允许"对子代理生效，不重复弹窗 */
  sessionApproved: Set<string>
  requestApproval: RunDeps['requestApproval']
  previewLlm?: RunDeps['previewLlm']
  emit: (ev: AgentEvent) => void
  estimateTokens: (text: string) => number
  /** 模型窗口（K tokens），子代理上下文预算用 */
  windowK: number
  /** 构建通用系统提示词（loop 注入，避免循环依赖；mode 为子代理钳制后的模式） */
  buildSystem: (mode: PermissionMode) => string
  connections: ConnProfile[]
  globalClientDir?: string
  project?: { id: string; name: string; rootPath: string }
  servers: SshServer[]
  /** false = 后台任务：不发 sub-* 卡片事件（卡片已以 async_launched 关闭），可见性由任务条承担 */
  emitEvents?: boolean
}

/** 迭代与墙钟硬顶：防子代理失控空转 */
const SUBAGENT_MAX_MS = 15 * 60_000
/** 回传父上下文的报告上限（字符） */
const REPORT_MAX_CHARS = 8000
/** 子代理上下文预算：系统提示词+历史的估算超窗口 70% 即停 */
const CONTEXT_BUDGET_RATIO = 0.7
/** 前台子代理跑超此时长自动转后台（ZCode autoBackgroundMs） */
export const AUTO_BACKGROUND_MS = 120_000

type ChildStatus = 'completed' | 'stopped' | 'failed' | 'exhausted'

function buildPreamble(profile: SubagentProfile, childMode: PermissionMode): string {
  return `你是「${profile.name}」子代理——由主会话的 SQLPilot 派生出来独立执行一项子任务。

${profile.systemPrompt}

子代理守则：
- 你看不到主会话的任何对话历史，仅依据下面的任务书工作；信息不足时用工具自行探索确认，不要反问。
- 无依赖的工具调用尽量在一条回复里并行发出，快速收敛。
- 你的最终回复就是提交给主代理的报告：先结论与关键数字，再给依据；涉及的对象写全名。不要写报告文件，内容直接写在最终回复里。
- 当前实际权限模式：${childMode}（可能与主会话不同，以本段为准）。下方通用规则中涉及计划模式/规划工具的条目对你不适用——你没有这些工具。

────────以下为通用环境与工作规则（与主会话共用同一份事实）────────
`
}

/** 单次子代理执行：独立消息历史跑完整循环，返回作为 agent_spawn 工具结果的 JSON */
export async function runSubagent(input: SubagentRunInput): Promise<{ ok: boolean; result: string; status: ChildStatus }> {
  const startedAt = Date.now()
  // 权限钳制：explore/readonly profile 强制只读；plan 模式下的子代理按只读行事（子代理不产出计划）
  const childMode: PermissionMode = input.profile.forceReadonly || input.parentMode === 'plan' ? 'readonly' : input.parentMode
  const childTools = TOOLS.filter((t) => subagentToolset(input.profile).includes(t.name))
  const system = buildPreamble(input.profile, childMode) + input.buildSystem(childMode)
  const messages: ChatMsg[] = [{ role: 'user', content: input.prompt }]

  const childAbort = new AbortController()
  const onParentAbort = () => childAbort.abort()
  input.cancelSignal.addEventListener('abort', onParentAbort)
  // AbortSignal 对"注册前已中止"的信号不触发监听器（扇出排队期间父会话可能已停止），补查一次
  if (input.cancelSignal.aborted) childAbort.abort()
  const wallClock = setTimeout(() => childAbort.abort(), SUBAGENT_MAX_MS)
  wallClock.unref?.()

  logRunLine(input.subId, { t: 'start', agentType: input.profile.name, sessionId: input.sessionId, description: input.description, prompt: input.prompt, mode: childMode })
  if (input.emitEvents !== false) {
    input.emit({ type: 'sub-start', sessionId: input.sessionId, subId: input.subId, agentType: input.profile.name, description: input.description })
  }
  appendAudit({ kind: 'subagent', actor: `sub:${input.profile.name}`, sessionId: input.sessionId, runId: input.subId, detail: `启动：${input.description}` })

  let iterations = 0
  let toolUse = 0
  let lastText = ''
  let status: ChildStatus = 'exhausted'
  let note = ''

  const ctx: ToolContext = {
    connections: input.connections,
    globalClientDir: input.globalClientDir,
    mode: childMode,
    sessionApproved: input.sessionApproved,
    requestApproval: (req: ApprovalRequest) =>
      input.requestApproval({ ...req, origin: `子代理 ${input.profile.name}` }, input.sessionId),
    project: input.project,
    servers: input.servers,
    origin: `sub:${input.profile.name}`,
    sessionId: input.sessionId,
    runId: input.subId
  }

  try {
    for (let i = 0; i < input.profile.maxTurns; i++) {
      if (childAbort.signal.aborted) {
        status = 'stopped'
        note = '父会话已停止，子代理中止'
        break
      }
      // 上下文预算：子代理历史只增不减，超窗前主动收口
      const est = input.estimateTokens(system) + messages.reduce((a, m) => a + input.estimateTokens(m.content || '') + (m.toolCalls ? m.toolCalls.reduce((x, tc) => x + input.estimateTokens(tc.args || ''), 0) : 0), 0)
      if (i > 0 && est > input.windowK * 1024 * CONTEXT_BUDGET_RATIO) {
        status = 'exhausted'
        note = `子代理上下文接近窗口上限（估算 ${est} tokens），提前收口`
        break
      }
      const res = await callLlm(input.provider, system, messages, childTools, {}, {
        signal: childAbort.signal,
        effort: input.effort ?? undefined,
        preview: input.previewLlm
      })
      iterations++
      messages.push({ role: 'assistant', content: res.content || null, toolCalls: res.toolCalls, thinking: res.thinking, thinkingSig: res.thinkingSig })
      if (res.content) lastText = res.content

      if (!res.toolCalls.length) {
        status = 'completed'
        break
      }
      let interrupted = false
      for (const tc of res.toolCalls) {
        if (childAbort.signal.aborted) {
          messages.push({ role: 'tool', content: JSON.stringify({ error: '任务被中止，本工具未执行' }), toolCallId: tc.id, toolName: tc.name })
          interrupted = true
          continue
        }
        const t0 = Date.now()
        const r = await executeTool(tc.name, tc.args, ctx)
        const ms = Date.now() - t0
        toolUse++
        logRunLine(input.subId, { t: 'tool', iter: i + 1, tool: tc.name, args: tc.args, ok: r.ok, ms, resultHead: r.result.slice(0, AUDIT_RESULT_HEAD) })
        if (input.emitEvents !== false) {
          input.emit({ type: 'sub-activity', sessionId: input.sessionId, subId: input.subId, note: activityLine(tc.name, r.ok, r.result) })
        }
        messages.push({ role: 'tool', content: r.result, toolCallId: tc.id, toolName: tc.name })
      }
      if (interrupted) {
        status = 'stopped'
        note = '父会话已停止，子代理中止'
        break
      }
    }
    if (status === 'exhausted' && !note) note = `达到子代理最大迭代次数（${input.profile.maxTurns}）`
  } catch (e: any) {
    if (childAbort.signal.aborted) {
      status = 'stopped'
      note = '父会话已停止，子代理中止'
    } else {
      status = 'failed'
      note = String(e?.message || e).slice(0, 500)
    }
  } finally {
    clearTimeout(wallClock)
    input.cancelSignal.removeEventListener('abort', onParentAbort)
  }

  const durationMs = Date.now() - startedAt
  const truncated = lastText.length > REPORT_MAX_CHARS
  const report = lastText
    ? (truncated ? `${lastText.slice(0, REPORT_MAX_CHARS)}\n…（报告超长已截断）` : lastText)
    : (status === 'completed' ? '（子代理未输出文本报告）' : `（未生成最终报告：${note}）`)

  const ok = status === 'completed'
  const summary = `${iterations} 轮 · ${toolUse} 次工具 · ${Math.round(durationMs / 1000)}s${note ? ` · ${note}` : ''}`
  const header = `# 子代理运行报告\n\n- 类型：${input.profile.name}\n- 任务：${input.description}\n- 状态：${status}${note ? `（${note}）` : ''}\n- 迭代：${iterations} 轮，工具调用 ${toolUse} 次，耗时 ${Math.round(durationMs / 1000)}s\n- 完成时间：${new Date().toLocaleString('zh-CN')}`
  const runFile = writeReportArtifact(input.subId, input.project, header, report)
  logRunLine(input.subId, { t: 'end', status, iterations, toolCalls: toolUse, durationMs, runFile, reportHead: report.slice(0, 2000) })
  const result = JSON.stringify({
    status,
    runId: input.subId,
    agentType: input.profile.name,
    description: input.description,
    note: note || undefined,
    report,
    runFile,
    iterations,
    toolCalls: toolUse,
    durationMs
  })
  if (input.emitEvents !== false) {
    input.emit({ type: 'sub-end', sessionId: input.sessionId, subId: input.subId, ok, summary, status })
  }
  appendAudit({ kind: 'subagent', actor: `sub:${input.profile.name}`, sessionId: input.sessionId, runId: input.subId, detail: `${ok ? '完成' : `结束（${status}）`}：${summary}`, ms: durationMs, rows: toolUse, error: ok ? undefined : (note || status) })
  return { ok, result, status }
}

// ---------- 前台/后台编排（对标 ZCode runner 的 launch 语义） ----------

export interface LaunchOptions extends SubagentRunInput {
  /** true = 立即返回 async_launched，任务后台跑（完成经 onNotice 通知父会话） */
  background: boolean
  /** 前台等待上限，超时自动转后台（默认 AUTO_BACKGROUND_MS；仅 background=false 时生效） */
  autoBackgroundMs?: number
  /** 后台/转后台任务的完成通知（loop 注入：写 pendingNotices + UI 提示） */
  onNotice?: (text: string) => void
}

interface FinalizeInfo {
  ok: boolean
  status: ChildStatus
  resultJson: any
  runFile?: string
  summary: string
}

/** 统一入口：注册任务 → 前台竞速（完成/转后台）或直接后台 → 完成时通知 + 落终态 */
export async function launchSubagent(opts: LaunchOptions): Promise<{ ok: boolean; result: string }> {
  // 任务级中止控制器：父会话停止（cancelSignal）或 task_stop 任一触发
  const taskAbort = registerSubagentTask({ id: opts.subId, sessionId: opts.sessionId, agentType: opts.profile.name, description: opts.description })
  const onParentAbort = () => taskAbort.abort()
  opts.cancelSignal.addEventListener('abort', onParentAbort)
  if (opts.cancelSignal.aborted) taskAbort.abort()

  const isBackground = opts.background
  // 后台任务的活动不挂在卡片上（卡片立即以 async_launched 关闭），前台任务才发 sub-* 事件；
  // 用 description 前缀 hack 不优雅——改为直接传参控制
  const input: SubagentRunInput = { ...opts, cancelSignal: taskAbort.signal, emitEvents: !isBackground }

  const finalize = (r: { ok: boolean; result: string; status: ChildStatus }): FinalizeInfo => {
    let resultJson: any = {}
    try { resultJson = JSON.parse(r.result) } catch { /* 保持空 */ }
    finishSubagentTask(opts.subId, r.status === 'completed' ? 'completed' : r.status === 'failed' ? 'failed' : 'stopped', `${resultJson.iterations ?? 0} 轮 · ${resultJson.toolCalls ?? 0} 次工具 · ${Math.round((resultJson.durationMs ?? 0) / 1000)}s`, resultJson.runFile, resultJson.report)
    opts.cancelSignal.removeEventListener('abort', onParentAbort)
    return { ok: r.ok, status: r.status, resultJson, runFile: resultJson.runFile, summary: `${resultJson.iterations ?? 0} 轮 · ${resultJson.toolCalls ?? 0} 次工具 · ${Math.round((resultJson.durationMs ?? 0) / 1000)}s` }
  }

  const notify = (info: FinalizeInfo) => {
    if (!opts.onNotice) return
    if (markNotified(opts.subId)) return // 防重复通知（ZCode notified 标记）
    const label = info.status === 'completed' ? '完成' : info.status === 'failed' ? '失败' : '已停止'
    const reportHead = String(info.resultJson.report || '').replace(/\s+/g, ' ').slice(0, 300)
    opts.onNotice([
      `[后台子代理${label}] ${opts.profile.name} · ${opts.description}（${info.summary}）`,
      info.runFile ? `报告文件：${info.runFile}` : '',
      reportHead ? `摘要：${reportHead}` : '',
      `可用 task_output(task_id="${opts.subId}") 获取完整报告。`
    ].filter(Boolean).join('\n'))
  }

  if (isBackground) {
    // 后台：不阻塞父回合，完成时通知
    void runSubagent(input).then((r) => {
      const info = finalize(r)
      notify(info)
    }).catch(() => {
      /* runSubagent 内部已全捕获，此为兜底 */
      finishSubagentTask(opts.subId, 'failed', '执行异常')
    })
    const result = JSON.stringify({
      status: 'async_launched',
      runId: opts.subId,
      agentType: opts.profile.name,
      description: opts.description,
      note: '子代理已在后台启动，本会话可继续其他工作。完成后会收到系统通知；也可用 task_output 查询进度（block=true 等待完成）、task_stop 停止。'
    })
    return { ok: true, result }
  }

  // 前台：与自动转后台计时器竞速（ZCode 三方竞速的两者版：完成 / 超时转后台）
  const fgResult = runSubagent(input)
  const timer = new Promise<'timeout'>((r) => {
    const h = setTimeout(() => r('timeout'), opts.autoBackgroundMs ?? AUTO_BACKGROUND_MS)
    h.unref?.()
  })
  const winner = await Promise.race([fgResult.then((x) => ({ kind: 'done' as const, x })), timer.then(() => ({ kind: 'timeout' as const, x: undefined as any }))])
  if (winner.kind === 'done') {
    const info = finalize(winner.x)
    return { ok: info.ok, result: JSON.stringify(info.resultJson) }
  }
  // 超时转后台：任务继续跑，立即返回；完成时通知
  void fgResult.then((r) => {
    const info = finalize(r)
    notify(info)
  }).catch(() => finishSubagentTask(opts.subId, 'failed', '执行异常'))
  const result = JSON.stringify({
    status: 'auto_backgrounded',
    runId: opts.subId,
    agentType: opts.profile.name,
    description: opts.description,
    note: `子代理前台执行超过 ${Math.round((opts.autoBackgroundMs ?? AUTO_BACKGROUND_MS) / 1000)} 秒，已自动转入后台继续。本会话可先做其他事；完成后会收到系统通知，也可用 task_output(task_id="${opts.subId}") 获取结果。`,
    elapsedMs: opts.autoBackgroundMs ?? AUTO_BACKGROUND_MS
  })
  return { ok: true, result }
}

/** sub-activity 单行摘要：工具名 + 成败 + 结果要点 */
function activityLine(tool: string, ok: boolean, resultJson: string): string {
  let brief = ''
  try {
    const r = JSON.parse(resultJson)
    if (r.error) brief = String(r.error).slice(0, 90)
    else if (r.rowCount != null) brief = `${r.rowCount} 行${r.ms != null ? ` ${r.ms}ms` : ''}`
    else if (r.total != null) brief = `${r.total} 项`
    else if (r.schemas) brief = `${r.schemas.length} schema`
    else if (r.written != null) brief = `写入 ${r.written} 字符`
    else if (r.affected != null) brief = `影响 ${r.affected} 行`
    else if (r.columns) brief = `${r.columns.length} 列`
  } catch {
    /* 非_JSON 结果只显示工具名 */
  }
  return `${ok ? '✓' : '✗'} ${tool}${brief ? ` · ${brief}` : ''}`
}
