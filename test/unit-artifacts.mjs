// 会话产物推导单测：从消息里的工具调用推结果预览（纯函数，不依赖 electron/vue）。
// 重点：只认成功且有内容的结果；表格/代码/图片分类要准；CSV 解析要能处理引号与换行。
import assert from 'node:assert/strict'
import { collectArtifacts, parseCsv } from '../src/renderer/artifacts.ts'

let passed = 0
function eq(actual, expected, why) {
  assert.equal(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
function ok(cond, why) {
  assert.ok(cond, why)
  passed++
}

/** 造一条助手消息，tools 里放一个工具调用 */
function msg(id, name, args, result, status = 'ok') {
  return { id, role: 'assistant', tools: [{ name, args: JSON.stringify(args), result: JSON.stringify(result), status }] }
}

// ---------- db_query：结果集 ----------
{
  const m = msg(1, 'db_query', { conn: 'LIS 生产', sql: 'select id, name from t' }, {
    columns: ['id', 'name'], rows: [[1, 'a'], [2, null]], rowCount: 5000, ms: 12, truncated: true, artifactId: 't_1700000000_abc123'
  })
  const list = collectArtifacts([m])
  eq(list.length, 1, '一条查询产出一个产物')
  const a = list[0]
  eq(a.kind, 'table', 'db_query → 表格')
  eq(a.title, '结果集 · LIS 生产', '标题带连接名')
  eq(a.table.columns.length, 2, '列数')
  eq(a.table.rowCount, 5000, '总行数来自 rowCount')
  eq(a.table.artifactId, 't_1700000000_abc123', '带上完整结果 id')
  eq(a.sql, 'select id, name from t', '保留 SQL')
  ok(a.subtitle.includes('5,000 行'), `副标题显示行数（实际 ${a.subtitle}）`)
}

// ---------- 失败 / 进行中的工具不产生产物 ----------
{
  eq(collectArtifacts([msg(2, 'db_query', {}, { error: '权限不足' })]).length, 0, 'error 结果不产生产物')
  const running = { id: 3, role: 'assistant', tools: [{ name: 'db_query', args: '{}', status: 'running' }] }
  eq(collectArtifacts([running]).length, 0, 'running 状态不产生产物')
  eq(collectArtifacts([{ id: 4, role: 'assistant', tools: [{ name: 'db_query', args: '{}', result: 'not-json', status: 'ok' }] }]).length, 0, '结果不是 JSON 时跳过')
}

// ---------- 表结构 / 对象清单 / schema ----------
{
  const d = collectArtifacts([
    msg(5, 'db_describe_table', { schema: 'lis', table: 'orders' }, {
      columns: [{ name: 'id', type: 'bigint', nullable: 'NO' }, { name: 'amt', type: 'decimal(18,2)', nullable: 'YES' }],
      approxRows: 120000
    })
  ])[0]
  eq(d.kind, 'table', 'describe → 表格')
  eq(d.title, '表结构 · lis.orders', '标题 库.表')
  eq(d.table.columns.join('/'), '列名/类型/可空', '表头固定三列')
  eq(d.table.rows[1][2], 'YES', '可空列取值')
  ok(d.subtitle.includes('约 120,000 行'), `近似行数（实际 ${d.subtitle}）`)

  const t = collectArtifacts([msg(6, 'db_list_tables', { schema: 'lis' }, { schema: 'lis', tables: ['a', 'b'], total: 300 })])[0]
  eq(t.table.columns[0], '对象名', '对象清单单列')
  eq(t.table.rowCount, 300, '总数取 total')
  ok(t.subtitle.includes('仅列前 2'), `截断提示（实际 ${t.subtitle}）`)

  const s = collectArtifacts([msg(7, 'db_list_schemas', {}, { schemas: ['lis', 'his'], total: 2 })])[0]
  eq(s.table.rows.length, 2, 'schema 行数')
}

// ---------- DDL / 写操作 ----------
{
  const ddl = collectArtifacts([msg(8, 'db_get_ddl', { schema: 'lis', table: 'orders' }, { ddl: 'CREATE TABLE orders (id bigint);' })])[0]
  eq(ddl.kind, 'code', 'DDL → 代码')
  eq(ddl.lang, 'sql', 'DDL 语言 sql')
  eq(ddl.text, 'CREATE TABLE orders (id bigint);', 'DDL 正文')

  const w = collectArtifacts([msg(9, 'db_write', { conn: 'LIS', sql: 'update t set a=1 where id=2' }, { affected: 1, ms: 5 })])[0]
  eq(w.kind, 'code', '变更 → 代码')
  ok(w.text.includes('影响行数: 1'), `变更结果附影响行数（实际 ${w.text}）`)
}

// ---------- 读文件：按扩展名分类 ----------
{
  const sqlFile = collectArtifacts([msg(10, 'fs_read', { path: 'E:/p/a.sql' }, { path: 'E:/p/a.sql', size: 20, content: 'select 1' })])[0]
  eq(sqlFile.kind, 'code', '.sql → 代码')
  eq(sqlFile.lang, 'sql', '.sql 语言')

  const md = collectArtifacts([msg(11, 'fs_read', { path: '/p/report.md' }, { path: '/p/report.md', size: 20, content: '# 标题' })])[0]
  eq(md.kind, 'markdown', '.md → markdown')

  const img = collectArtifacts([msg(12, 'fs_read', { path: 'E:/p/a.png' }, { path: 'E:/p/a.png', size: 99 })])[0]
  eq(img.kind, 'image', '.png → 图片')
  eq(img.path, 'E:/p/a.png', '图片路径')

  const remote = collectArtifacts([msg(13, 'server_read_file', { path: '/etc/nginx.conf' }, { path: '/etc/nginx.conf', content: 'server {}' })])[0]
  eq(remote.kind, 'code', '远程读文件 → 代码')
  eq(remote.lang, 'ini', '.conf → ini')
  ok(remote.subtitle.includes('远程'), `标出远程来源（实际 ${remote.subtitle}）`)
}

// ---------- 写文件：内容在参数里 ----------
{
  const csv = collectArtifacts([
    msg(14, 'fs_write', { path: 'E:/p/out.csv', content: 'id,name\n1,"a,b"\n2,"带""引号"""\n' }, { path: 'out.csv', written: 40 })
  ])[0]
  eq(csv.kind, 'table', '.csv 写入 → 表格预览')
  eq(csv.table.columns.join('/'), 'id/name', 'CSV 表头')
  eq(csv.table.rows[0][1], 'a,b', '引号内的逗号不被切开')
  eq(csv.table.rows[1][1], '带"引号"', '双引号转义')

  const mdWrite = collectArtifacts([msg(15, 'fs_write', { path: 'E:/p/r.md', content: '# 报告' }, { path: 'r.md', written: 4 })])[0]
  eq(mdWrite.kind, 'markdown', '写 md → markdown 产物')
  eq(mdWrite.text, '# 报告', '正文来自参数')

  const got = collectArtifacts([msg(16, 'server_get_file', { remotePath: '/var/log/a.log', localPath: 'downloads/a.log' }, { remotePath: '/var/log/a.log', savedTo: 'downloads/a.log' })])[0]
  eq(got.kind, 'file', '下载到本机 → 文件')
  eq(got.path, 'downloads/a.log', '保存路径')
  ok(got.subtitle.includes('已下载'), `标注已下载（实际 ${got.subtitle}）`)
}

// ---------- 命令输出 ----------
{
  const r = collectArtifacts([msg(17, 'server_run', { command: 'df -h' }, { exitCode: 0, stdout: '/dev/vda1 40G 21G 19G 53% /\n', stderr: '' })])[0]
  eq(r.kind, 'code', '命令输出 → 代码')
  ok(r.title.includes('df -h'), `标题带命令（实际 ${r.title}）`)
  ok(r.subtitle.includes('exit 0'), `显示退出码（实际 ${r.subtitle}）`)

  const err = collectArtifacts([msg(18, 'run_command', { command: 'dir' }, { stdout: 'ok', stderr: 'warn', exitCode: 1 })])[0]
  ok(err.text.includes('stderr'), 'stderr 单独分段')
  eq(collectArtifacts([msg(19, 'server_run', { command: 'true' }, { exitCode: 0, stdout: '  ', stderr: '' })]).length, 0, '空输出不产生产物')
}

// ---------- CSV 解析边界 ----------
{
  eq(parseCsv('\uFEFFa,b\n1,2\n').columns.join('/'), 'a/b', '去掉 BOM')
  const p = parseCsv('a,b\n"x\ny",2\n')
  eq(p.rows.length, 1, '引号内换行算同一行')
  eq(p.rows[0][0], 'x\ny', '引号内换行保留')
  eq(parseCsv('a\tb\n1\t2\n', '\t').columns.join('/'), 'a/b', 'TSV 分隔符')
  eq(parseCsv('').columns.length, 0, '空文本')
  eq(parseCsv('a,b\n\n1,2\n').rows.length, 1, '跳过空行')
}

// ---------- 多条消息：id 稳定且唯一 ----------
{
  const msgs = [
    msg(20, 'db_get_ddl', { table: 'a' }, { ddl: 'create table a(id int);' }),
    msg(21, 'fs_read', { path: 'x.sql' }, { path: 'x.sql', content: 'select 1' }),
    { id: 22, role: 'user', tools: [] }
  ]
  const first = collectArtifacts(msgs)
  const second = collectArtifacts(msgs)
  eq(first.length, 2, '两个产物')
  eq(first.map((a) => a.id).join(','), second.map((a) => a.id).join(','), '同样输入得到同样 id（刷新不变）')
  eq(new Set(first.map((a) => a.id)).size, 2, 'id 唯一')
  eq(first[0].msgId, 20, '归属消息 id')
}

console.log(`artifacts 单测：${passed} 组断言全部通过`)
