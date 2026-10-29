/**
 * 数据库连接分组单测。
 *
 * 分组的坑与服务器分组同源：分组名就是身份，改一次名要同时改「文件夹清单」和
 * 每条连接的 group 字段；漏掉一边的表现是"改完分组就空了 / 连接还在旧组里"。
 * 另外空文件夹必须靠清单活着，否则用户没法先建分组再往里放连接。
 *
 * 运行：node test/unit-conn-groups.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// conn-groups 复用了 group-folders.ts 的分组核心，Node 的类型剥离解析不了无扩展名的
// 相对导入 —— 与 unit-server 一样 bundle 后导入真实实现
const root = path.resolve(import.meta.dirname, '..')
const out = path.join(import.meta.dirname, '.cg-bundle.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/conn-groups.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'silent'
})
const cg = await import(`${pathToFileURL(out).href}?t=${Date.now()}`)
fs.unlinkSync(out)

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
const ok = (cond, why) => {
  assert.ok(cond, why)
  passed++
}

const conn = (id, group) => ({ id, name: id.toUpperCase(), type: 'oracle', host: 'h', port: 1521, user: 'u', role: 'readonly', group })

// ---------- 名字清洗（与服务器分组共用一套规则） ----------
{
  eq(cg.normalizeGroupName('  核心   库 '), '核心 库', '分组名去首尾空白并折叠内部空白')
  eq(cg.validateGroupName('未分组').ok, false, '「未分组」是内置兜底桶，不允许当分组名')
  eq(cg.validateGroupName(' 生产 ').name, '生产', '合法分组名返回清洗后的值')
}

// ---------- 旧配置迁移：分组只写在连接上 ----------
{
  const cfg = { connections: [conn('a', ' 生产 '), conn('b', '测试'), conn('c')], connGroups: undefined }
  cg.normalizeConnGroups(cfg)
  eq(cfg.connGroups.map((g) => g.name), ['生产', '测试'], '连接上独有的分组补登记进清单并对齐空白')
  eq(cfg.connections[0].group, '生产', '连接上的脏分组名对齐到清单写法')

  // 空文件夹靠清单活着：连接全删了也不能消失
  const empty = { connections: [], connGroups: [{ name: '空组' }] }
  cg.normalizeConnGroups(empty)
  eq(cg.connGroupNames(empty), ['空组'], '空分组在整理后仍然保留')
  eq(cg.connFoldersOf(empty).length, 1, '文件夹清单就地补齐为数组')
  ok(!cg.hasConnGroup(empty, '未分组'), '兜底桶不算真分组')
}

// ---------- 建组 / 改名 ----------
{
  const cfg = { connections: [conn('a', '生产环境'), conn('b')], connGroups: [{ name: '生产环境' }] }
  eq(cg.ensureConnGroup(cfg, '生产环境'), false, '已登记的分组不重复添加')
  eq(cg.ensureConnGroup(cfg, '开发'), true, '新分组追加')
  eq(cg.connGroupNames(cfg), ['生产环境', '开发'], '文件夹顺序跟着配置走')

  eq(cg.renameConnGroup(cfg, '生产环境', '核心生产'), 1, '改名连带改连接的 group')
  eq(cfg.connections[0].group, '核心生产', '连接跟着改名')
  eq(cg.connGroupNames(cfg), ['核心生产', '开发'], '清单里的名字也改了')
  eq(cg.renameConnGroup(cfg, '不存在的组', 'x'), 0, '改不存在的分组不动任何数据')
}

// ---------- 先写连接再登记分组（回归：不能用 hasConnGroup 判断已登记） ----------
{
  const cfg = { connections: [], connGroups: [] }
  cfg.connections.push(conn('a', '新写的组'))
  eq(cg.ensureConnGroup(cfg, '新写的组'), true, '连接已带上新分组时仍要把它登记进清单')
}

// ---------- 删除 / 搬家 ----------
{
  const cfg = { connections: [conn('a', '生产环境'), conn('b', '生产环境'), conn('c')], connGroups: [{ name: '生产环境' }, { name: '开发' }] }
  eq(cg.deleteConnGroup(cfg, '生产环境', '开发'), 2, '删除分组并搬到目标分组')
  ok(cfg.connections.slice(0, 2).every((c) => c.group === '开发'), '组内连接落到 moveTo')
  eq(cg.connGroupNames(cfg).includes('生产环境'), false, '被删的分组从清单消失')
  eq(cg.deleteConnGroup(cfg, '开发'), 2, '删除分组且不指定目标')
  eq(cfg.connections[0].group, undefined, '移出分组后 group 字段被删掉')
  eq(cg.deleteConnGroup(cfg, '未分组'), 0, '兜底桶不可删除')

  eq(cg.moveConnections(cfg, ['a'], '新组'), 1, '移入新分组')
  eq(cfg.connections[0].group, '新组', 'group 写入目标分组')
  ok(cg.connGroupNames(cfg).includes('新组'), '移入时自动登记文件夹')
  eq(cg.moveConnections(cfg, ['a'], ''), 1, '空分组名 = 移出分组')
  eq(cfg.connections[0].group, undefined, '移出后 group 字段被删掉')
  eq(cg.moveConnections(cfg, [], '新组'), 0, '没有选中连接时不写配置')
}

// ---------- 清理脏清单 ----------
{
  const dirty = {
    connections: [conn('a', ' 生产 '), conn('b', '未分组'), conn('c')],
    connGroups: [{ name: ' 生产 ' }, { name: '生产' }, { name: '未分组' }, { name: '' }, '裸字符串']
  }
  cg.normalizeConnGroups(dirty)
  eq(dirty.connGroups.map((g) => g.name), ['生产', '裸字符串'], '清掉重复/空/保留名，兼容裸字符串')
  eq(dirty.connections[1].group, undefined, '名字叫「未分组」= 等于没分组')
}

console.log(`✓ unit-conn-groups：${passed} 项断言通过`)
