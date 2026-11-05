/**
 * OB 排障历史会话 · 存储层单测
 *
 * 锁三件事：
 *   1. 归一化 —— 脏数据（空文本、缺命令、超长输出）不能把整条记录带崩，
 *      也不能让「一条被拦的 rm -rf」在历史里丢失（它是证据）；
 *   2. 上限 —— 单场条数、会话数、文件体积都要封顶，否则跑几个月后打开就卡死；
 *   3. 落盘 —— 存过的东西换个进程读还在（用临时目录模拟 userData）。
 *
 * electron 只在 sessions.ts 里用来取 userData 路径，这里用 esbuild 打桩。
 * 运行：node test/unit-obagent-sessions.mjs
 */
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-sess-'))
process.env.OB_SESS_DIR = DIR

const out = path.join(ROOT, 'output/.unit-obagent-sessions.mjs')
await build({
  entryPoints: [path.join(ROOT, 'src/main/obagent/sessions.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
  plugins: [
    {
      name: 'stub-electron',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const app = { getPath: () => process.env.OB_SESS_DIR }'
        }))
      }
    }
  ]
})

const S = await import('file://' + out.replace(/\\/g, '/') + `?t=${Date.now()}`)

let n = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  n++
}
const eq = (a, b, msg) => {
  assert.deepEqual(a, b, msg)
  n++
}

// ---------------------------------------------------------------- 归一化：条目
eq(S.normalizeItem(null), null, '空条目丢掉')
eq(S.normalizeItem({ kind: 'text', text: '   ' }), null, '空白正文丢掉')

const t = S.normalizeItem({ kind: 'text', role: 'user', text: '为什么刷屏', key: 'k1' })
eq(t.role, 'user', '用户气泡保留角色')
eq(t.key, 'k1', '保留原 key')

eq(S.normalizeItem({ kind: 'cmd', cmd: { command: '  ' } }), null, '没有命令原文的卡片丢掉')

const longOut = 'x'.repeat(9000)
const c = S.normalizeItem({
  kind: 'cmd',
  cmdId: 'c1',
  cmd: { cmdId: 'c1', command: 'rm -rf /data', why: '清日志', risk: 'deny', status: 'blocked', reason: '写操作', output: longOut }
})
ok(!!c, '被拦的命令也要进历史（它是证据）')
eq(c.cmd.risk, 'deny', '风险等级保留')
eq(c.cmd.status, 'blocked', '拦截状态保留')
eq(c.cmd.output.length, 6000, '输出截断到 6000 字')
eq(c.cmd.reason, '写操作', '拦截原因保留')

// ---------------------------------------------------------------- 归一化：整场
eq(S.normalizeSession({ id: '' }), null, '没有 id 丢掉')
eq(S.normalizeSession({ id: 'a', items: [] }), null, '没有内容的会话不落盘')

const many = []
for (let i = 0; i < 300; i++) many.push({ kind: 'text', role: 'user', text: `第 ${i} 条` })
const capped = S.normalizeSession({ id: 'cap', items: many })
eq(capped.items.length, 240, '单场条目封顶 240')
eq(capped.items[capped.items.length - 1].text, '第 299 条', '封顶保留最新的那批')

const s1 = S.normalizeSession({
  id: 's1',
  serverName: 'obs1',
  host: 'root@10.0.0.1',
  mode: 'confirm',
  createdAt: 1000,
  updatedAt: 2000,
  items: [
    { kind: 'text', role: 'user', text: '  为什么 03:10 之后开始刷屏  ' },
    { kind: 'cmd', cmdId: 'c1', cmd: { command: 'uptime', risk: 'safe', status: 'done', ms: 12 } },
    { kind: 'cmd', cmdId: 'c2', cmd: { command: 'rm -rf /log', risk: 'deny', status: 'blocked' } }
  ]
})
eq(s1.title, '为什么 03:10 之后开始刷屏', '标题取首问（去空白）')
eq(s1.cmdCount, 2, '命令数按卡片算')
eq(s1.blocked, 1, '被拦条数单独统计')
eq(s1.mode, 'confirm', '执行模式保留')
eq(s1.status, 'done', '缺 status 视作已完成')

// ---------------------------------------------------------------- 落盘：增删查
S.saveSession({ id: 's1', serverName: 'obs1', host: 'root@10.0.0.1', createdAt: 1000, updatedAt: 2000, items: s1.items })
S.saveSession({ id: 's2', serverName: 'obs2', createdAt: 1000, updatedAt: 3000, items: [{ kind: 'text', role: 'user', text: '磁盘满了' }] })

let list = S.listSessions()
eq(list.length, 2, '两场都存下来了')
eq(list[0].id, 's2', '列表按更新时间倒序（新的在前）')
ok(!('items' in list[0]), '列表只回摘要，不带 items')

eq(S.getSession('s1').serverName, 'obs1', '按 id 取整场')
eq(S.getSession('nope'), null, '取不到返回 null')

// 同一个 id 再存 = 覆盖，不新增
S.saveSession({ id: 's1', serverName: 'obs1-改名', createdAt: 1000, updatedAt: 4000, items: [{ kind: 'text', role: 'user', text: '接着查' }] })
eq(S.listSessions().length, 2, '同 id 覆盖不新增')
eq(S.getSession('s1').serverName, 'obs1-改名', '覆盖后的内容生效')

// 会话数上限
for (let i = 0; i < 70; i++) {
  S.saveSession({ id: `bulk${i}`, updatedAt: 5000 + i, items: [{ kind: 'text', role: 'user', text: `批量 ${i}` }] })
}
eq(S.listSessions().length, 60, '会话数封顶 60')

// 换进程视角读文件：清缓存后还在
S.resetSessionCacheForTest()
ok(S.listSessions().length === 60, '缓存清掉后仍能从文件读回')
const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'obagent-sessions.json'), 'utf8'))
ok(Array.isArray(raw.sessions) && raw.sessions.length === 60, '文件里就是 60 场')

// 删 / 清
const id = S.listSessions()[0].id
eq(S.deleteSession(id).removed, 1, '删除成功一条')
ok(!S.listSessions().some((x) => x.id === id), '删掉的不在列表里')
eq(S.deleteSession('不存在').removed, 0, '删不存在的返回 0')
eq(S.clearSessions().removed, 59, '清空返回条数')
eq(S.listSessions().length, 0, '清空后空列表')

fs.rmSync(DIR, { recursive: true, force: true })
console.log(`unit-obagent-sessions: ${n} 项通过`)
