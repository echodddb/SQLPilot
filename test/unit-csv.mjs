// CSV 构造单测：直接导入真实 csv.ts（Node 24 原生 TS 剥离）。
// 重点：公式注入防护（OWASP）不误伤 DBA 常规数据（负数/百分比/金额）。
import assert from 'node:assert/strict'
import { csvCell, buildCsv } from '../src/main/csv.ts'

let passed = 0
function eq(actual, expected, why) {
  assert.equal(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
function ok(cond, why) {
  assert.ok(cond, why)
  passed++
}

// ---------- 公式注入防护 ----------
eq(csvCell('=cmd|\'/c calc\'!A0'), "'=cmd|'/c calc'!A0", '等号公式加前缀')
eq(csvCell('+1+1'), "'+1+1", '加号公式加前缀')
eq(csvCell('@SUM(A1:A9)'), "'@SUM(A1:A9)", 'AT 函数加前缀')
eq(csvCell('\t=hidden()'), "'\t=hidden()", '制表符开头加前缀')
eq(csvCell('-1+cmd'), "'-1+cmd", '负号表达式加前缀')

// ---------- 常规数据不误伤 ----------
eq(csvCell(-123), '-123', '纯负数不加前缀')
eq(csvCell('-12.50'), '-12.50', '负金额不加前缀')
eq(csvCell('-3.14%'), '-3.14%', '负百分比不加前缀') // % 在白名单样式内
eq(csvCell('(1,234.56)'), '"(1,234.56)"', '会计负数括号（含逗号正常加引号，无公式前缀）')
eq(csvCell('正常文本'), '正常文本', '普通文本不动')
eq(csvCell('a=b'), 'a=b', '等号不在开头不动')
eq(csvCell(''), '', '空串')
eq(csvCell(null), '', 'null')
eq(csvCell(new Date('2026-10-11T08:30:00Z')), '2026-10-11 08:30:00', '日期格式化')

// ---------- 转义 ----------
eq(csvCell('含"引号'), '"含""引号"', '引号翻倍')
eq(csvCell('a,b'), '"a,b"', '逗号加引号')
eq(csvCell('a\nb'), '"a\nb"', '换行加引号')
eq(csvCell({ x: 1 }), '"{""x"":1}"', '对象 JSON 化（含引号正常转义）')

// ---------- 整行构造 ----------
const csv = buildCsv(['id', 'formula', 'note'], [[1, '=evil()', 'ok']], ['id', 'formula', 'note'])
assert.ok(csv.includes("'=evil()"), 'buildCsv 同样过防护')
passed++
assert.ok(csv.charCodeAt(0) === 0xfeff, 'BOM 存在')
passed++

// "-" 开头的算术表达式仍可能被 Excel 求值：只放行严格数字样式
eq(csvCell('-2+3'), "'-2+3", '负号+算术表达式必须加前缀')
eq(csvCell('-123.45'), '-123.45', '负数不加前缀')
eq(csvCell('-1,234.50'), '"-1,234.50"', '千分位负数不加前缀（含逗号按 CSV 规则加引号）')

// ---------- 重名列：SELECT a.id, b.id 必须各取一列，不能都落到第一个 ----------
const dupCols = ['id', 'id', 'name']
eq(
  buildCsv(dupCols, [[1, 2, 'x']], ['id', 'id']),
  '\uFEFFid,id\r\n1,2\r\n',
  '重名列按选择顺序各占一列'
)
let dupThrew = false
try { buildCsv(dupCols, [[1, 2, 'x']], ['id', 'id', 'id']) } catch { dupThrew = true }
ok(dupThrew, '超选重名列（没有第三列）必须报错而不是静默少导')
let missThrew = false
try { buildCsv(['a'], [[1]], ['nope']) } catch { missThrew = true }
ok(missThrew, '找不到的列必须报错，不能静默丢弃')

console.log(`csv 单测：${passed} 组断言全部通过`)