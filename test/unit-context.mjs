// 上下文截断/摘要算法冒烟测试：镜像 src/main/agent/loop.ts 中的纯函数实现（改动那里时同步这里）
import assert from 'node:assert'

function estimateTokens(text) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 3.8)
}

const MAX_MESSAGES = 200
const SUMMARY_MAX_CHARS = 3500

function indexAtUserBoundary(msgs, from) {
  let i = Math.max(0, from)
  while (i < msgs.length && msgs[i].role !== 'user') i++
  return i
}
function lastUserIndex(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return i
  return 0
}
function trimHistory(msgs, maxTokens) {
  let cut = 0
  if (msgs.length > MAX_MESSAGES) {
    const fwd = indexAtUserBoundary(msgs, msgs.length - MAX_MESSAGES)
    cut = fwd < msgs.length ? fwd : lastUserIndex(msgs)
  }
  if (maxTokens && msgs.length > 1) {
    const cost = msgs.map((m) => estimateTokens(m.content || '') + (m.toolCalls ? m.toolCalls.reduce((a, tc) => a + estimateTokens(tc.args || ''), 0) : 0))
    let acc = 0
    let start = msgs.length
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (acc + cost[i] > maxTokens) break
      acc += cost[i]
      start = i
    }
    if (start > 0) {
      const bounded = indexAtUserBoundary(msgs, start)
      start = bounded < msgs.length ? bounded : lastUserIndex(msgs)
      cut = Math.max(cut, start)
    }
  }
  if (cut <= 0) return { kept: msgs, dropped: [] }
  return { kept: msgs.slice(cut), dropped: msgs.slice(0, cut) }
}

function oneLine(s, max) {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
function summarizeDropped(prev, dropped) {
  const users = [], wrote = [], ran = [], conclusions = []
  const explored = new Set()
  for (const m of dropped) {
    if (m.role === 'user' && m.content) users.push(oneLine(m.content, 100))
    else if (m.role === 'assistant') {
      if (m.content && !m.toolCalls?.length) conclusions.push(oneLine(m.content, 200))
      for (const tc of m.toolCalls || []) {
        let a
        try { a = JSON.parse(tc.args || '{}') } catch { continue }
        if (tc.name === 'db_write') wrote.push(oneLine(String(a.sql || ''), 160))
        else if (tc.name === 'db_describe_table' || tc.name === 'db_get_ddl') explored.add(`${a.schema ? `${a.schema}.` : ''}${a.table}`)
        else if (tc.name === 'run_command' || tc.name === 'server_run') ran.push(oneLine(String(a.command || ''), 100))
      }
    }
  }
  const uniq = (arr) => [...new Set(arr)]
  const parts = []
  if (users.length) parts.push(`用户此前要求：\n${uniq(users).map((u) => `- ${u}`).join('\n')}`)
  if (explored.size) parts.push(`已确认结构的表（勿重复探索）：${[...explored].slice(0, 40).join('、')}`)
  if (wrote.length) parts.push(`已执行的写操作：\n${uniq(wrote).slice(-10).map((s) => `- ${s}`).join('\n')}`)
  if (ran.length) parts.push(`执行过的命令：${uniq(ran).slice(-5).join('；')}`)
  if (conclusions.length) parts.push(`此前结论：\n${conclusions.slice(-3).map((c) => `- ${c}`).join('\n')}`)
  const fresh = parts.join('\n\n')
  const merged = prev ? `${prev}\n\n${fresh}` : fresh
  return merged.length > SUMMARY_MAX_CHARS ? merged.slice(-SUMMARY_MAX_CHARS) : merged
}

function shortVersionLabel(raw) {
  if (raw.length <= 28) return raw
  const m = raw.match(/\d+(\.\d+){1,4}/)
  const head = raw.match(/^[A-Za-z]+/)?.[0] || ''
  return m ? `${head} ${m[0]}`.trim() : raw.slice(0, 28)
}

// ---- 用例 ----
const U = (t) => ({ role: 'user', content: t })
const A = (t) => ({ role: 'assistant', content: t })
const T = (id, name, args) => ({ role: 'tool', content: '{"ok":1}', toolCallId: id, toolName: name })
const AT = (calls) => ({ role: 'assistant', content: null, toolCalls: calls.map((c, i) => ({ id: `c${i}`, name: c[0], args: JSON.stringify(c[1]) })) })

// 1. 未超限：原样保留
let r = trimHistory([U('hi'), A('ok')], 100000)
assert.deepStrictEqual([r.kept.length, r.dropped.length], [2, 0])

// 2. token 预算触发：从 user 边界截断，无孤儿 tool
const big = [U('第一问'), AT([['db_describe_table', { conn: 'x', schema: 'S', table: 'T1' }]]), T('c0'), A('结论一'),
  U('第二问'), AT([['db_write', { conn: 'x', sql: 'UPDATE big_table SET a=1' }]]), T('c0'), A('结论二，这条很长'.repeat(50))]
r = trimHistory(big, estimateTokens('第二问') + estimateTokens(JSON.stringify({ conn: 'x', sql: 'UPDATE big_table SET a=1' })) + estimateTokens('{"ok":1}') + estimateTokens('结论二，这条很长'.repeat(50)) + 10)
assert.ok(r.dropped.length >= 3, '应截掉前一轮')
assert.strictEqual(r.kept[0].role, 'user')
assert.strictEqual(r.kept[0].content, '第二问')
// 摘要覆盖被截内容（db_write 属于保留段，不进摘要）
const s = summarizeDropped(undefined, r.dropped)
assert.ok(s.includes('第一问') && s.includes('S.T1') && s.includes('结论一'), '摘要应含用户诉求/探索表/结论')
assert.ok(!s.includes('UPDATE'), '保留段内的写操作不应重复进摘要')

// 3. 预算装不下最近一回合：退而保留最后一回合（不产出孤儿 tool）
r = trimHistory(big, estimateTokens('结论二，这条很长'.repeat(50)) - 10)
assert.strictEqual(r.kept[0].content, '第二问', '兜底保留最后回合')
assert.ok(r.kept.some((m) => m.role === 'tool'), '回合内 tool 消息保留')

// 4. 条数上限（>200 条时截到 user 边界）
const many = []
for (let i = 0; i < 60; i++) many.push(U(`q${i}`), AT([['db_query', { sql: `SELECT ${i}` }]]), T(`c${i}`), A(`a${i}`))
r = trimHistory(many, undefined)
assert.strictEqual(many.length - r.kept.length, 40, '条数超限时恰好在 user 边界截断（240→200）')
assert.strictEqual(r.kept.length, 200)
assert.strictEqual(r.kept[0].role, 'user')
const s2 = summarizeDropped(undefined, r.dropped)
assert.ok(s2.includes('q0') && s2.includes('q9') && !s2.includes('q59'), '摘要覆盖被截的 q0..q9，保留段不重复')

// 5. 摘要累积 + 截尾（近期优先）：每条入摘要时已被 oneLine 截到 100 字符，
//    需累积超过 3500 字符后旧内容才被挤出（~30+ 轮）
let acc = summarizeDropped(undefined, [U('旧问题'.repeat(400))])
for (let i = 0; i < 60; i++) acc = summarizeDropped(acc, [U(`问题${i}${'x'.repeat(300)}`)])
assert.ok(!acc.includes('旧问题') && acc.includes('问题59') && acc.length <= 3500)

// 6. 版本标签压缩
assert.strictEqual(shortVersionLabel('Oracle Database 11g Enterprise Edition Release 11.2.0.4.0 - 64bit Production'), 'Oracle 11.2.0.4.0')
assert.strictEqual(shortVersionLabel('MySQL 8.0.36'), 'MySQL 8.0.36')
assert.ok(shortVersionLabel('OceanBase 4.2.1.0 (MySQL 租户兼容)').startsWith('OceanBase 4'))

console.log('all context-algorithm tests passed')
