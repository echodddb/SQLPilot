/**
 * 文本编辑器 AI · 主进程单测
 *
 * 只测不依赖模型的纯逻辑：提示词构造、选区截断口径、入参校验。
 * 真正的流式问答需要大模型，界面链路由 output/editor-ai-check.mjs 覆盖。
 */
import { build } from 'esbuild'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(import.meta.dirname, '.editor-ai.mjs')

await build({
  entryPoints: [path.join(root, 'src/main/editor-ai.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  alias: { electron: path.join(import.meta.dirname, 'stub-electron.mjs') },
  external: ['oracledb'],
  logLevel: 'warning'
})

const M = await import(`file://${out.replace(/\\/g, '/')}?t=${Date.now()}`)

const cases = []
const test = (name, fn) => cases.push({ name, fn })

test('系统提示：带上文件 / 语言 / 选区行号，并约束「只依据选中文本」', () => {
  const sp = M.editorSystemPrompt({
    id: 'r1', selection: 'select 1 from dual', question: '有问题吗', file: 'a.sql', lang: 'SQL', lines: { start: 2, end: 5 }
  })
  assert.ok(sp.includes('a.sql'), '应包含文件名')
  assert.ok(sp.includes('SQL'), '应包含语言')
  assert.ok(sp.includes('第 2-5 行'), '应包含选区行号')
  assert.ok(sp.includes('只依据'), '应约束只依据选中文本')
  assert.ok(sp.includes('中文'), '应要求中文回答')
})

test('系统提示：单行选区不写区间', () => {
  const sp = M.editorSystemPrompt({ id: 'r2', selection: 'x', question: 'q', file: 'b.md', lang: 'Markdown', lines: { start: 3, end: 3 } })
  assert.ok(sp.includes('第 3 行'))
  assert.ok(!sp.includes('第 3-3 行'))
})

test('用户消息：选中文本与问题分段清楚', () => {
  const um = M.editorUserMessage({ id: 'r3', selection: 'const a = 1', question: '  这行有什么用  ' })
  assert.ok(um.includes('【选中文本】'))
  assert.ok(um.includes('const a = 1'))
  assert.ok(um.includes('【问题】'))
  assert.ok(um.endsWith('这行有什么用'), '问题应去掉首尾空白')
})

test('多文件：系统提示说清文件数与文件名，并要求跨文件时点名', () => {
  const sp = M.editorSystemPrompt({
    id: 'm1',
    selection: '===== 文件：a.sql =====\nselect 1\n\n===== 文件：b.sql =====\nselect 2',
    question: '这两个文件对得上吗',
    file: 'a.sql 等 2 个文件',
    lang: 'SQL',
    files: ['a.sql', 'b.sql']
  })
  assert.ok(sp.includes('2 个文件'), '应说明读了几个文件')
  assert.ok(sp.includes('a.sql') && sp.includes('b.sql'), '应列出文件名')
  assert.ok(sp.includes('指明是哪个文件'), '跨文件引用要指明文件')
  assert.ok(!sp.includes('第 1 行'), '多文件不该再写单段选区行号')
})

test('多文件：用户消息用「上下文」抬头，保留文件分隔头', () => {
  const um = M.editorUserMessage({
    id: 'm2',
    selection: '===== 文件：a.sql =====\nselect 1\n\n===== 文件：b.sql =====\nselect 2',
    question: '有冲突吗',
    files: ['a.sql', 'b.sql']
  })
  assert.ok(um.includes('【上下文】共 2 个文件'))
  assert.ok(um.includes('===== 文件：a.sql ====='))
  assert.ok(!um.includes('【选中文本】'), '多文件不该再用「选中文本」抬头')
  assert.ok(um.endsWith('有冲突吗'))
})

test('多文件：上下文超过 24000 字符才截断', () => {
  const ok = M.editorUserMessage({ id: 'm3', selection: 'x'.repeat(20000), question: 'q', files: ['a.sql', 'b.sql'] })
  assert.ok(!ok.includes('已截断'), '20000 字符在多文件预算内，不该截断')
  const cut = M.editorUserMessage({ id: 'm4', selection: 'x'.repeat(40000), question: 'q', files: ['a.sql', 'b.sql'] })
  assert.ok(cut.includes('已截断'))
  assert.ok(cut.length < 26000, `截断后应受控，实际 ${cut.length}`)
})

test('用户消息：超长选区截断，不让 prompt 爆炸', () => {
  const big = 'x'.repeat(20000)
  const um = M.editorUserMessage({ id: 'r4', selection: big, question: 'q' })
  assert.ok(um.includes('已截断'), '应提示已截断')
  assert.ok(um.length < 14000, `截断后长度应受控，实际 ${um.length}`)
})

test('入参校验：缺 id / 缺问题 / 缺选区都直接拒绝', async () => {
  assert.equal((await M.askEditorAi({ id: '', selection: 'a', question: 'q' })).ok, false)
  assert.equal((await M.askEditorAi({ id: 'r5', selection: 'a', question: '   ' })).ok, false)
  const blank = await M.askEditorAi({ id: 'r6', selection: '  \n ', question: 'q' })
  assert.equal(blank.ok, false)
  assert.ok(/选中/.test(blank.error || ''), '空选区应提示先选中文本')
})

test('停止：未知请求也不报错', () => {
  assert.deepEqual(M.stopEditorAi('nope'), { ok: true })
})

let pass = 0
for (const c of cases) {
  try {
    await c.fn()
    pass++
  } catch (e) {
    console.error(`✗ ${c.name}\n`, e)
  }
}
console.log(`unit-editor-ai: ${pass}/${cases.length} 组断言${pass === cases.length ? '通过' : '失败'}`)
if (pass !== cases.length) process.exit(1)
