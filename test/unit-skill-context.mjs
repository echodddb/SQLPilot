/**
 * 技能正文注入 · 单测
 *
 * 只测纯组装逻辑（frontmatter 剥离、裁剪口径、数量上限）；
 * 「按 id 读文件」依赖 userData，由界面自检覆盖。
 */
import { build } from 'esbuild'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(import.meta.dirname, '.skill-context.mjs')

await build({
  entryPoints: [path.join(root, 'src/main/skill-context.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  alias: { electron: path.join(import.meta.dirname, 'stub-electron.mjs') },
  external: ['oracledb', 'extract-zip'],
  logLevel: 'warning'
})

const M = await import(`file://${out.replace(/\\/g, '/')}?t=${Date.now()}`)

const cases = []
const test = (name, fn) => cases.push({ name, fn })

test('frontmatter 被剥掉，正文保留', () => {
  const body = M.stripFrontmatter('---\nname: 巡检\ndescription: 表空间\n---\n\n## 步骤\n1. 查水位')
  assert.ok(!body.includes('name: 巡检'), 'frontmatter 应被去掉')
  assert.ok(body.startsWith('## 步骤'), `正文应从标题开始，实际 ${JSON.stringify(body.slice(0, 12))}`)
})

test('单技能：标题用 name + 描述，正文跟在后面', () => {
  const block = M.composeSkillBlock([
    { id: 'chk', name: '表空间巡检', description: '按水位分级处理', content: '---\nname: x\n---\n先查 dba_tablespace_usage_metrics，再按 85/95 分级。' }
  ])
  assert.ok(block.includes('## 参考技能'), '应有段落标题')
  assert.ok(block.includes('### 表空间巡检：按水位分级处理'), '技能标题应带描述')
  assert.ok(block.includes('85/95'), '正文应保留')
  assert.ok(block.includes('必须遵循'), '应写明这是回答规范')
  assert.ok(block.includes('读不到那些文件'), '应说明资源文件读不到')
})

test('多个技能按传入顺序拼接', () => {
  const block = M.composeSkillBlock([
    { id: 'a', name: 'A', description: '', content: '甲' },
    { id: 'b', name: 'B', description: '', content: '乙' }
  ])
  assert.ok(block.indexOf('### A') < block.indexOf('### B'), '顺序应与勾选一致')
  assert.equal((block.match(/### /g) || []).length, 2)
})

test('最多 4 个技能', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, description: '', content: 'x' }))
  const block = M.composeSkillBlock(items)
  assert.equal((block.match(/### /g) || []).length, 4)
  assert.ok(!block.includes('### S4'), '第 5 个起不注入')
})

test('单技能超长被裁剪，并注明', () => {
  const block = M.composeSkillBlock([{ id: 'big', name: 'BIG', description: '', content: 'x'.repeat(9000) }])
  assert.ok(block.includes('已截断'), '应提示截断')
  assert.ok(block.length < 5200, `单技能应压到 4200 左右，实际 ${block.length}`)
})

test('总预算：多个长技能不叠加爆掉', () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, description: '', content: 'y'.repeat(6000) }))
  const block = M.composeSkillBlock(items)
  assert.ok(block.length < 10500, `总量应受控，实际 ${block.length}`)
})

test('空正文 / 空列表：返回空串（调用方据此不拼这段）', () => {
  assert.equal(M.composeSkillBlock([]), '')
  assert.equal(M.composeSkillBlock([{ id: 'e', name: 'E', description: '', content: '---\nname: e\n---\n' }]), '')
  assert.equal(M.skillBlockFor([]), '')
  assert.equal(M.skillBlockFor(undefined), '')
})

let failed = 0
for (const c of cases) {
  try {
    c.fn()
    console.log(`  ✓ ${c.name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${c.name}\n    ${e.message}`)
  }
}
console.log(`unit-skill-context: ${cases.length - failed}/${cases.length} 组断言通过`)
process.exit(failed ? 1 : 0)
