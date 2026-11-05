/**
 * OB 排障浮窗 · 状态机单测（脱离/停靠的交接逻辑）
 *
 * 这里锁的是「两个窗口各折叠一遍同一份事件流」能否收敛：
 *   · 交接快照落后于本窗口已折叠位置时，必须把差的那几条补回来（否则命令永远停在「执行中」）；
 *   · hydrate 之后 items[i].cmd 必须重新绑到 cmds 表（JSON 拍平会拆掉引用，绑不回去就再也不更新）；
 *   · 另一侧窗口的动作（提问/清空/切模式/关窗）要能落到本窗口。
 *
 * 运行：node test/unit-obagent-panel.mjs
 */
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------- 浏览器环境打桩
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)) },
  removeItem: (k) => { mem.delete(k) }
}

const calls = []
let onEvent = null
let onUi = null
let detachReply = { ok: true, pin: true }
let detachThrows = false

const sqlpilot = {
  onObAgentEvent: (cb) => { onEvent = cb; return () => { onEvent = null } },
  onObAgentUi: (cb) => { onUi = cb; return () => { onUi = null } },
  obagentAsk: async (input) => { calls.push(['ask', input]); return { ok: true } },
  obagentStop: async (id) => { calls.push(['stop', id]); return { ok: true } },
  obagentApprove: async (cmdId, d) => { calls.push(['approve', cmdId, d]); return { ok: true } },
  obagentDetach: async (snap) => {
    calls.push(['detach', snap])
    if (detachThrows) throw new Error('boom')
    return detachReply
  },
  obagentDock: async (snap) => { calls.push(['dock', snap]); return { ok: true } },
  obagentPanelHello: async () => ({ ok: true, snapshot: null, pin: true }),
  obagentPanelPin: async (pin) => { calls.push(['pin', pin]); return { ok: true, pin } },
  obagentPanelResize: async () => ({ ok: true }),
  obagentPanelMove: async () => ({ ok: true }),
  obagentPanelClose: async () => { calls.push(['panelClose']); return { ok: true } },
  obagentPanelFocus: async () => { calls.push(['focus']); return { ok: true } },
  obagentMirror: async (payload) => { calls.push(['mirror', payload]); return { ok: true } },
  openExternal: async () => ({ ok: true })
}
globalThis.window = {
  sqlpilot,
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1400,
  innerHeight: 900
}
// Node 22 自带只读的 navigator，用 defineProperty 盖掉
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true
})

const out = path.join(ROOT, 'output/.unit-obagent-panel.mjs')
await build({
  entryPoints: [path.join(ROOT, 'src/renderer/oblog/agent.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: out,
  logLevel: 'error'
})
const M = await import('file://' + out.replace(/\\/g, '/') + `?t=${Date.now()}`)
const { obAgent } = M

let n = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  n++
}
const eq = (a, b, msg) => {
  assert.deepEqual(a, b, msg)
  n++
}
const ev = (seq, o) => ({ seq, id: 'r1', ...o })

// ---------------------------------------------------------------- 折叠事件流
M.bindObAgentEvents()
M.bindObAgentUi()
ok(typeof onEvent === 'function', 'onObAgentEvent 已订阅')
ok(typeof onUi === 'function', 'onObAgentUi 已订阅')

onEvent(ev(1, { type: 'start' }))
onEvent(ev(2, { type: 'cmd', cmdId: 'c1', command: 'uptime', why: '看负载', risk: 'safe', rule: 'readonly', reason: '', status: 'waiting' }))
onEvent(ev(3, { type: 'delta', text: '先看负载' }))
ok(obAgent.busy === true, 'start → busy')
eq(obAgent.items.map((x) => x.kind), ['cmd', 'text'], '命令卡片 + 正文都进来了')
ok(obAgent.items[1].live === true, '流式气泡处于 live')

// 序号更小的事件必须丢掉（重复投递/交接补事件时不能重复折叠）
onEvent(ev(2, { type: 'cmd', cmdId: 'c1', command: 'uptime', why: '看负载', risk: 'safe', rule: 'readonly', reason: '', status: 'waiting' }))
eq(obAgent.items.length, 2, '旧序号事件被忽略')

// ---------------------------------------------------------------- 交接快照
const snap = M.snapshotObAgent()
eq(snap.seq, 3, '快照带已折叠到的序号')
eq(snap.items.length, 2, '快照带全部条目')
eq(snap.runId, '', '还没提问时 runId 为空')
ok(JSON.parse(JSON.stringify(snap)).items.length === 2, '快照可结构化克隆（不含响应式代理）')

// 快照之后又到的事件（另一侧窗口会先折进来，然后靠 seq 补）
onEvent(ev(4, { type: 'cmd-update', cmdId: 'c1', status: 'done', ms: 12, output: 'load 0.1' }))
onEvent(ev(5, { type: 'delta', text: '，一切正常' }))
onEvent(ev(6, { type: 'done', text: '先看负载，一切正常', commands: 1 }))
ok(obAgent.busy === false, 'done → 不忙')

// 用落后的快照接管：必须把 seq>3 的三条补回来
M.hydrateObAgent(snap)
eq(obAgent.cmds.c1.status, 'done', '交接后补上了 cmd-update')
eq(obAgent.items.find((x) => x.kind === 'text').text, '先看负载，一切正常', '交接后补上了后续正文')
ok(obAgent.busy === false, '交接后 busy 与补事件一致')

// hydrate 后 items[i].cmd 必须绑到 cmds 表里同一份对象
const cardCmd = obAgent.items.find((x) => x.kind === 'cmd').cmd
ok(cardCmd === obAgent.cmds.c1, 'hydrate 重建了命令引用（同一对象）')
onEvent(ev(7, { type: 'cmd-update', cmdId: 'c1', status: 'failed', note: '退出码 1' }))
ok(obAgent.items.find((x) => x.kind === 'cmd').cmd.status === 'failed', 'hydrate 之后卡片还能跟着状态更新')

// runId 生效：别的会话的事件不能混进来
M.hydrateObAgent({ ...snap, seq: 100, runId: 'r1' })
onEvent({ seq: 101, id: 'r2', type: 'delta', text: '别的会话' })
ok(!obAgent.items.some((x) => x.kind === 'text' && x.text.includes('别的会话')), '别的会话事件被过滤')

// ---------------------------------------------------------------- 另一侧窗口的动作
onUi({ kind: 'asked', text: '为什么刷屏' })
ok(obAgent.items.some((x) => x.kind === 'text' && x.role === 'user' && x.text === '为什么刷屏'), 'asked → 补一条用户气泡')

onUi({ kind: 'mode', mode: 'confirm' })
eq(obAgent.mode, 'confirm', 'mode → 跟着切')
onUi({ kind: 'mode', mode: 'auto' })
eq(obAgent.mode, 'auto', 'mode 能切回来')

onUi({ kind: 'clear' })
eq(obAgent.items.length, 0, 'clear → 清空')
eq(Object.keys(obAgent.cmds).length, 0, 'clear → 命令表也清空')

onUi({ kind: 'panel-closed' })
ok(obAgent.open === false && obAgent.detached === false, 'panel-closed → 收起且回到停靠态')

onUi({ kind: 'hydrate', snapshot: { ...snap, serverName: 'obs1', host: 'root@10.0.0.1' }, detached: true })
ok(obAgent.detached === true, 'hydrate 带 detached → 切到独立窗口态')
eq(obAgent.serverName, 'obs1', 'hydrate 恢复服务器信息')
ok(obAgent.open === true, 'hydrate 会打开浮窗')

// ---------------------------------------------------------------- 脱离 / 停靠
calls.length = 0
obAgent.detached = false
detachReply = { ok: true, pin: false }
await M.detachObAgent()
ok(obAgent.detached === true, 'detach → detached=true')
ok(obAgent.pinned === false, 'detach 后置顶状态跟主进程一致')
ok(calls.some((c) => c[0] === 'detach' && c[1] && Array.isArray(c[1].items)), 'detach 把快照交给主进程')

calls.length = 0
await M.dockObAgent()
ok(calls.some((c) => c[0] === 'dock' && c[1] && Array.isArray(c[1].items)), 'dock 把快照交回主进程')

// 打不开独立窗口时不能留下「界面已经搬走」的假象
obAgent.detached = false
detachReply = { ok: false, error: '不能开窗' }
await M.detachObAgent()
ok(obAgent.detached === false, 'detach 失败 → 回退到窗口内')
eq(obAgent.error, '不能开窗', 'detach 失败 → 显示原因')

detachThrows = true
await M.detachObAgent()
ok(obAgent.detached === false, 'detach 抛异常也不搬走')
ok(/boom/.test(obAgent.error), 'detach 抛异常 → 显示原因')
detachThrows = false

// 已脱离时再点「打开」应该把独立窗口拎到前面，而不是再开一个
calls.length = 0
obAgent.detached = true
M.openObAgent({ serverId: 's1', serverName: 'obs1', host: 'root@10.0.0.1' })
ok(calls.some((c) => c[0] === 'focus'), '已脱离 → 聚焦独立窗口')

// 脱离状态下关闭：要真的关窗口，不能只把 open 置 false
calls.length = 0
M.closeObAgent()
ok(calls.some((c) => c[0] === 'panelClose'), '脱离态关闭 → 关掉独立窗口')
ok(obAgent.detached === false && obAgent.open === false, '脱离态关闭 → 两个标志都复位')

// ---------------------------------------------------------------- 提问
obAgent.detached = false
calls.length = 0
obAgent.busy = false
await M.askObAgent('  这台机器有什么瓶颈  ')
const asked = calls.find((c) => c[0] === 'ask')
ok(!!asked, 'ask → 发起请求')
eq(asked[1].question, '这台机器有什么瓶颈', '问题去掉首尾空白')
ok(obAgent.items.some((x) => x.kind === 'text' && x.role === 'user' && x.text === '这台机器有什么瓶颈'), '本窗口先给自己的问题气泡')
eq(obAgent.busy, true, 'ask → busy')

// 询问失败：把问题放回输入框，不留空气泡
M.hydrateObAgent({ ...snap, seq: 200, runId: '' })
sqlpilot.obagentAsk = async () => ({ ok: false, error: '没有配置大模型' })
obAgent.busy = false
obAgent.serverId = 's1'
const before = obAgent.items.length
await M.askObAgent('查一下磁盘')
ok(obAgent.items.length === before, '发起失败 → 不留下用户气泡')
eq(obAgent.draft, '查一下磁盘', '发起失败 → 问题放回输入框')
eq(obAgent.error, '没有配置大模型', '发起失败 → 显示原因')

console.log(`unit-obagent-panel: ${n} 项通过`)
