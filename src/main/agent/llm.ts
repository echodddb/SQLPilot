import type { ChatMsg, ProviderConfig, ToolCall, ThinkingEffort } from '../types'
import type { ToolDef } from '../tools'
import { findVendor, applyOpenAiThinking, anthropicThinking } from './catalog'

export interface LlmStreamEvents {
  onText?: (t: string) => void
  onReasoning?: (t: string) => void
}

/** 外部中断信号（用户点"停止"时触发）；effort 为会话级思考级别覆盖；preview 为发送前预览钩子（false=用户取消） */
export interface LlmCallOptions {
  signal?: AbortSignal
  effort?: import('../types').ThinkingEffort
  preview?: (url: string, body: any) => Promise<boolean>
}

export interface LlmResponse {
  content: string
  toolCalls: ToolCall[]
  stopReason?: string
  /** Anthropic 思考块原文与签名：带工具调用的轮次回传历史时必须原样携带，否则 API 报错 */
  thinking?: string
  thinkingSig?: string
  /** 提供商返回的真实计量（部分厂商流式不含 usage 则为 undefined） */
  usage?: LlmUsage
}

export interface LlmUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const HTTP_TIMEOUT_MS = 300_000
/** 流空闲看门狗：SSE 连续无数据帧超过此时长判定为死流（VPN 断连/网关挂起），
 *  提前中断并给出明确错误，而不是干等 HTTP 总超时 */
const STREAM_IDLE_TIMEOUT_MS = 180_000

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

// ---------- SSE 读取 ----------

async function readSse(res: any, abort: AbortController | undefined, onData: (json: any) => void): Promise<void> {
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf8')
  let buf = ''
  // 看门狗：任何数据帧都刷新活跃时间；空闲超时 abort 整个请求（reader.read 会随之抛错）
  let lastFrame = Date.now()
  let stalled = false
  const idleTimer = setInterval(() => {
    if (Date.now() - lastFrame > STREAM_IDLE_TIMEOUT_MS) {
      stalled = true
      abort?.abort()
    }
  }, 5_000)
  idleTimer.unref?.()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      lastFrame = Date.now()
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let json: any
        try {
          json = JSON.parse(payload)
        } catch {
          continue // 单帧损坏跳过，不影响后续帧
        }
        // 回调抛错（如流中 error 帧）必须向上传播，否则半截内容会被当成完整响应
        onData(json)
      }
    }
  } catch (e: any) {
    try { await reader.cancel().catch(() => {}) } catch { /* 忽略 */ }
    if (stalled) throw new Error(`LLM 流空闲超时（${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s 无数据），已中断`)
    throw e
  } finally {
    clearInterval(idleTimer)
  }
}

async function httpError(res: any): Promise<Error> {
  let body = ''
  try {
    body = await res.text()
  } catch { /* 忽略 */ }
  let msg = body
  try {
    const j = JSON.parse(body)
    msg = j?.error?.message || j?.message || body
  } catch { /* 保持原文 */ }
  return new Error(`LLM 请求失败 HTTP ${res.status}: ${String(msg).slice(0, 500)}`)
}

// ---------- OpenAI 兼容协议 ----------

function toOpenAiMessages(system: string, history: ChatMsg[]): any[] {
  const out: any[] = [{ role: 'system', content: system }]
  for (const m of history) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content ?? '' })
    } else if (m.role === 'assistant') {
      const msg: any = { role: 'assistant', content: m.content ?? '' }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args }
        }))
      }
      out.push(msg)
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, name: m.toolName, content: m.content ?? '' })
    }
  }
  return out
}

async function callOpenAi(p: ProviderConfig, system: string, history: ChatMsg[], tools: ToolDef[], ev: LlmStreamEvents, signal?: AbortSignal, effortOverride?: ThinkingEffort, preview?: LlmCallOptions['preview']): Promise<LlmResponse> {
  const url = trimSlash(p.baseUrl) + '/chat/completions'
  const body: any = {
    model: p.model,
    messages: toOpenAiMessages(system, history),
    stream: true
  }
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }
  applyOpenAiThinking(body, findVendor(p.vendor).thinkingStyle, effortOverride ?? p.effort)
  if (preview) {
    const go = await preview(url, body)
    if (!go) throw new Error('用户在发送前预览中取消了请求')
  }
  // 请求流式 usage（各家兼容性不一：不识别 stream_options 报 400 时去掉重试一次）
  body.stream_options = { include_usage: true }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
  const onExternalAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onExternalAbort)
  let res: any
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    if (!res.ok) {
      const err = await httpError(res)
      if (res.status === 400 && /stream_options/i.test(err.message)) {
        delete body.stream_options
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
          body: JSON.stringify(body),
          signal: ctrl.signal
        })
        if (!res.ok) throw await httpError(res)
      } else {
        throw err
      }
    }

    let content = ''
    let reasoning = ''
    let usage: LlmUsage | undefined
    const tcMap = new Map<number, { id: string; name: string; args: string }>()
    let stopReason: string | undefined

    await readSse(res, ctrl, (j: any) => {
      // 部分兼容网关以 {"error":...} 数据帧下发流中错误（如过载/截断），静默忽略会拿到半截内容
      if (j?.error) {
        throw new Error(`LLM 流中断: ${j.error?.message || JSON.stringify(j.error).slice(0, 300)}`)
      }
      const ch = j?.choices?.[0]
      // 流式 usage 一般在最后一个 chunk（需 stream_options.include_usage）
      if (j?.usage && (j.usage.prompt_tokens != null || j.usage.completion_tokens != null)) {
        usage = {
          input: Number(j.usage.prompt_tokens ?? 0),
          output: Number(j.usage.completion_tokens ?? 0),
          cacheRead: Number(j.usage.prompt_tokens_details?.cached_tokens ?? j.usage.prompt_cache_hit_tokens ?? 0),
          cacheWrite: 0
        }
      }
      if (!ch) return
      const d = ch.delta || {}
      if (typeof d.content === 'string' && d.content) {
        content += d.content
        ev.onText?.(d.content)
      }
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
        reasoning += d.reasoning_content
        ev.onReasoning?.(d.reasoning_content)
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i: number = tc.index ?? 0
          const cur = tcMap.get(i) || { id: tc.id || `call_${i}_${Date.now()}`, name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          tcMap.set(i, cur)
        }
      }
      if (ch.finish_reason) stopReason = ch.finish_reason
    })

    return { content, toolCalls: [...tcMap.values()].filter((t) => t.name), stopReason, usage, thinking: reasoning || undefined }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}

// ---------- Anthropic 协议 ----------

function toAnthropicMessages(history: ChatMsg[], includeThinking: boolean): any[] {
  const out: any[] = []
  const pushToolResults = (results: ChatMsg[]) => {
    out.push({
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.content ?? '' }))
    })
  }
  let pendingTools: ChatMsg[] = []
  const flush = () => {
    if (pendingTools.length) {
      pushToolResults(pendingTools)
      pendingTools = []
    }
  }
  for (const m of history) {
    if (m.role === 'user') {
      flush()
      out.push({ role: 'user', content: m.content ?? '' })
    } else if (m.role === 'assistant') {
      flush()
      const blocks: any[] = []
      // 思考块必须位于 assistant 消息首位，否则开思考的续轮会被 API 拒绝；
      // 反之本次请求未开思考时必须略去历史思考块（API 同样会拒绝）。
      // 另：无签名的 thinking 来自 OpenAI 协议历史（仅本地展示），回传 Anthropic 会被拒，须跳过
      if (includeThinking && m.thinking && m.thinkingSig) blocks.push({ type: 'thinking', thinking: m.thinking, signature: m.thinkingSig })
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls || []) {
        let input: any = {}
        try { input = JSON.parse(tc.args || '{}') } catch { /* 保持空对象 */ }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] })
    } else {
      pendingTools.push(m)
    }
  }
  flush()
  return out
}

async function callAnthropic(p: ProviderConfig, system: string, history: ChatMsg[], tools: ToolDef[], ev: LlmStreamEvents, signal?: AbortSignal, effortOverride?: ThinkingEffort, preview?: LlmCallOptions['preview']): Promise<LlmResponse> {
  const url = trimSlash(p.baseUrl) + '/v1/messages'
  const think = anthropicThinking(findVendor(p.vendor).thinkingStyle, effortOverride ?? p.effort)
  const body: any = {
    model: p.model,
    max_tokens: 8192,
    system,
    messages: toAnthropicMessages(history, !!think),
    stream: true
  }
  if (tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  }
  if (think) {
    body.thinking = think
    body.max_tokens = 8192 + think.budget_tokens
  }
  if (preview) {
    const go = await preview(url, body)
    if (!go) throw new Error('用户在发送前预览中取消了请求')
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
  const onExternalAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onExternalAbort)
  let res: any
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': p.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    if (!res.ok) throw await httpError(res)

    let content = ''
    let thinking = ''
    let thinkingSig = ''
    let usage: LlmUsage | undefined
    const toolBlocks = new Map<number, { id: string; name: string; args: string }>()
    await readSse(res, ctrl, (j: any) => {
      const t = j?.type
      // Anthropic 流中错误帧（overload 等）：不处理会静默截断内容
      if (t === 'error') {
        throw new Error(`LLM 流中断: ${j.error?.message || JSON.stringify(j.error).slice(0, 300)}`)
      }
      if (t === 'message_start') {
        // usage 随 message_start 下发（含缓存命中字段）
        const u = j.message?.usage
        if (u) {
          usage = {
            input: Number(u.input_tokens ?? 0),
            output: Number(u.output_tokens ?? 0),
            cacheRead: Number(u.cache_read_input_tokens ?? 0),
            cacheWrite: Number(u.cache_creation_input_tokens ?? 0)
          }
        }
      } else if (t === 'message_delta' && usage && j.usage?.output_tokens != null) {
        usage.output = Number(j.usage.output_tokens)
      } else if (t === 'content_block_start') {
        const b = j.content_block
        if (b?.type === 'tool_use') toolBlocks.set(j.index, { id: b.id, name: b.name, args: '' })
      } else if (t === 'content_block_delta') {
        const d = j.delta
        if (d?.type === 'text_delta' && d.text) {
          content += d.text
          ev.onText?.(d.text)
        } else if (d?.type === 'thinking_delta' && d.thinking) {
          thinking += d.thinking
          ev.onReasoning?.(d.thinking)
        } else if (d?.type === 'signature_delta' && d.signature) {
          thinkingSig += d.signature
        } else if (d?.type === 'input_json_delta' && d.partial_json) {
          const cur = toolBlocks.get(j.index)
          if (cur) cur.args += d.partial_json
        }
      }
    })

    return { content, toolCalls: [...toolBlocks.values()].filter((x) => x.name), thinking: thinking || undefined, thinkingSig: thinkingSig || undefined, usage }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}

// ---------- 统一入口 ----------

export async function callLlm(
  provider: ProviderConfig,
  system: string,
  history: ChatMsg[],
  tools: ToolDef[],
  ev: LlmStreamEvents = {},
  options: LlmCallOptions = {}
): Promise<LlmResponse> {
  if (provider.protocol === 'anthropic') {
    return callAnthropic(provider, system, history, tools, ev, options.signal, options.effort, options.preview)
  }
  return callOpenAi(provider, system, history, tools, ev, options.signal, options.effort, options.preview)
}
