/**
 * OB 故障排查 Agent · 提示词与文本工具
 *
 * 单独拆出来只为两件事：
 *   1. 可被单测直接 import（index.ts 会拉进 ssh/config/electron，测不动）；
 *   2. 提示词的「现场证据」格式只在这一处定义，主进程与测试不会说两套话。
 */

import type { ObAgentContext } from './types'

/** 级别分布压成一行，免得上下文里堆一堆数组 */
function levelLine(levels: ObAgentContext['levels']): string {
  if (!levels || !levels.length) return ''
  return levels
    .filter((l) => l.count > 0)
    .map((l) => `${l.key} ${l.count}`)
    .join(' · ')
}

function clip(s: string | undefined, n: number): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 把页面上的分析结论写成提示词里的「现场证据」 */
export function contextBlock(ctx: ObAgentContext | undefined): string {
  if (!ctx) return '（当前没有日志分析结果，需要自己先看一眼日志目录）'
  const lines: string[] = []
  const where = [ctx.serverName, ctx.host].filter(Boolean).join(' / ')
  if (where) lines.push(`- 目标主机：${where}`)
  if (ctx.logDir) lines.push(`- 日志目录：${ctx.logDir}（当前查看 ${ctx.scope || 'observer'}.log）`)
  if (ctx.windowStart || ctx.windowEnd) lines.push(`- 时间窗：${ctx.windowStart || '?'} → ${ctx.windowEnd || '?'}`)
  if (typeof ctx.total === 'number') {
    const per = typeof ctx.linesPerHour === 'number' ? `（约 ${ctx.linesPerHour} 行/小时）` : ''
    lines.push(`- 窗口内行数：${ctx.total}${per}`)
  }
  if (typeof ctx.filesScanned === 'number') {
    const kb = Math.round((ctx.bytesScanned || 0) / 1024)
    lines.push(`- 已扫描：${ctx.filesScanned} 个文件 / ${kb} KB${ctx.truncated ? '（达上限截断）' : ''}`)
  }
  if (ctx.disk) {
    lines.push(`- 日志盘：已用 ${ctx.disk.usePct}%（可用 ${Math.round((ctx.disk.avail || 0) / 1024 / 1024)} MB${ctx.disk.mount ? `，挂载 ${ctx.disk.mount}` : ''}）`)
  }
  const lv = levelLine(ctx.levels)
  if (lv) lines.push(`- 级别分布：${lv}`)
  if (ctx.summary) {
    const lvl = ctx.summary.level === 'ok' ? '健康' : ctx.summary.level === 'watch' ? '需留意' : '有问题'
    lines.push('')
    lines.push(`【本地规则引擎的结论】${lvl} · ${ctx.summary.headline}`)
    for (const p of (ctx.summary.points || []).slice(0, 6)) lines.push(`  · ${clip(p, 180)}`)
  }
  const hot = (ctx.hotSpots || []).slice(0, 8)
  if (hot.length) {
    lines.push('')
    lines.push('【刷屏热点 TOP】')
    for (const h of hot) lines.push(`- ${h.key} × ${h.count}${h.verdict ? ` [${h.verdict}]` : ''}${h.what ? `：${clip(h.what, 120)}` : ''}`)
  }
  const errs = (ctx.errCodes || []).slice(0, 8)
  if (errs.length) {
    lines.push('')
    lines.push('【错误码 TOP】')
    for (const e of errs) lines.push(`- ${e.key} × ${e.count}${e.verdict ? ` [${e.verdict}]` : ''}${e.msg ? `：${clip(e.msg, 100)}` : ''}`)
  }
  const samples = [...hot, ...errs].map((x) => x.sample).filter(Boolean) as string[]
  if (samples.length) {
    lines.push('')
    lines.push('【日志原文样例】')
    for (const s of samples.slice(0, 3)) lines.push('```', clip(s, 300), '```')
  }
  return lines.join('\n')
}

/** 系统提示（导出给单测检查口径） */
export function obAgentSystemPrompt(ctx: ObAgentContext | undefined, mode: 'auto' | 'confirm'): string {
  return [
    '你是 SQLPilot 内置的 OceanBase 故障排查助手。用户已经用「OB 日志中心」扫过目标主机的日志，现在要你接着往下查根因。',
    '你能通过 run_commands 工具在目标主机上执行**只读**命令，看到真实输出后继续推理。',
    '',
    '## 现场证据（客户端本地规则引擎扫出来的，不是猜的）',
    contextBlock(ctx),
    '',
    '## 怎么干',
    '1. 先用已有证据形成假设，再提最少的命令去证实/证伪；不要一上来把能想到的命令全跑一遍。',
    '2. 每次最多 3 条命令，按「先看整体、再看局部」的顺序：进程/资源 → 日志现场 → 具体租户/副本 → 相关配置。',
    '3. 命令必须单行、可直接执行、不依赖交互；禁止 sudo/su，禁止任何写文件、重定向、重启、清理、改参数的动作。',
    '4. 拿不到想要的东西就换只读手段（看 /proc、看日志、用 obclient -e "select ..."），不要重复提被拦截或已被跳过的命令。',
    '5. 命令输出会原样回给你（可能被截断）。结论要落在证据上，不要凭经验编数字。',
    mode === 'auto' ? '6. 当前模式：只读命令自动执行，非只读命令仍会被拦下。' : '6. 当前模式：每条命令都要用户点确认，所以一次别提太多。',
    '',
    '## 怎么答',
    '- 中文。先给结论（一句话，说清「最可能是什么问题」），再给证据（哪条输出支持它），最后给处理建议。',
    '- 处理建议只写「该人做什么」，不要假设自己会去改（你只读）。涉及风险的操作要标出风险等级。',
    '- 结论前如果需要先说一句「我先看一下 X」可以，但别长篇铺垫。',
    '- 结尾用「关键命令」小节列出这次排查真正起作用的 2-4 条命令，每条一句说明它看出了什么。',
    '- 证据不足时明确说「证据不足」，并指出还缺哪一项（具体到要看的文件/视图/指标），不要硬凑结论。'
  ].join('\n')
}

/** 本轮用户消息（历史里只放纯问答文本） */
export function obAgentUserMessage(question: string): string {
  return ['【问题】', String(question || '').trim()].join('\n')
}

/** 中间截断：头尾各留一半（错误信息常在尾部） */
export function clipMiddle(s: string, cap: number): { text: string; cut: boolean } {
  const t = String(s || '')
  if (t.length <= cap) return { text: t, cut: false }
  const half = Math.floor(cap / 2)
  return { text: `${t.slice(0, half)}\n…（中间省略 ${t.length - cap} 字符）…\n${t.slice(-half)}`, cut: true }
}
