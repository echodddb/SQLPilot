// 编辑器内核单测：直接导入真实 TS 模块（Node 24 原生类型剥离）
import assert from 'node:assert/strict'
import { LineDoc, UndoStack, indentOf, wordRangeAt, selStart, selEnd } from '../src/renderer/editor/model.ts'
import { SearchMatcher } from '../src/renderer/editor/search.ts'
import { tokenize } from '../src/renderer/editor/highlight.ts'
import { langById, detectLang } from '../src/renderer/editor/langs.ts'

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
const ok = (cond, why) => {
  assert.ok(cond, why)
  passed++
}

// ---------- 行文档：插入 / 删除 / 长度 ----------
{
  const d = new LineDoc('select 1\nfrom dual\n', 'CRLF')
  eq(d.lineCount, 3, '结尾换行后还有一个空行')
  eq(d.charCount, 'select 1from dual'.length, '长度按行内字符统计')

  const p = d.insertText({ line: 0, col: 8 }, ' 2')
  eq(p, { line: 0, col: 10 }, '单行插入光标位置')
  eq(d.line(0), 'select 1 2', '单行插入内容')

  const q = d.insertText({ line: 0, col: 10 }, '\nwhere x = 1')
  eq(q, { line: 1, col: 11 }, '多行插入光标位置')
  eq(d.line(1), 'where x = 1', '多行插入首行')
  eq(d.line(2), 'from dual', '多行插入后续行')

  const r = d.deleteRange({ line: 0, col: 8 }, { line: 1, col: 6 })
  eq(r, { line: 0, col: 8 }, '跨行删除返回起点')
  eq(d.line(0), 'select 1x = 1', '跨行删除合并内容')
  eq(d.lineCount, 3, '跨行删除后行数')
}

// ---------- 行文档：往返转换 ----------
{
  const text = 'a\r\nb\rc\nd'
  const d = new LineDoc(text, 'CRLF')
  eq(d.lines, ['a', 'b', 'c', 'd'], '混合换行统一拆行')
  eq(d.toText(), 'a\nb\nc\nd', 'toText 使用 \\n 统一表示')
}

// ---------- 撤销 / 重做 ----------
{
  const d = new LineDoc('abc\ndef', 'LF')
  const u = new UndoStack()
  const p0 = { line: 0, col: 3 }
  const before0 = d.lines.slice(0, 1)
  const p1 = d.insertText(p0, 'X')
  u.push({ start: 0, before: before0, after: d.lines.slice(0, 1), beforePos: p0, afterPos: p1, time: 1, kind: 'type' })
  eq(d.line(0), 'abcX', '插入生效')

  const r1 = u.undo(d)
  eq(r1.pos, p0, '撤销回到插入前光标')
  eq(d.line(0), 'abc', '撤销恢复内容')
  eq(d.charCount, 6, '撤销恢复长度')

  const r2 = u.redo(d)
  eq(r2.pos, p1, '重做回到插入后光标')
  eq(d.line(0), 'abcX', '重做恢复内容')

  // 连续输入合并为一步
  u.push({ start: 0, before: ['abcX'], after: ['abcXY'], beforePos: { line: 0, col: 4 }, afterPos: { line: 0, col: 5 }, time: 2, kind: 'type' })
  ok(u.canUndo, '撤销栈可用')
  u.undo(d)
  eq(d.line(0), 'abc', '连续输入合并后一次撤销清空整段')
}

// ---------- 单词 / 缩进 ----------
{
  eq(wordRangeAt('select  ename from emp', 9), { a: 8, b: 13 }, '英文单词范围')
  eq(wordRangeAt('中文标识 后面', 1), { a: 0, b: 4 }, '中文按词内字符处理')
  eq(indentOf('\t  select 1'), '\t  ', '缩进识别')
}

// ---------- 选区方向 ----------
{
  const s = { anchor: { line: 3, col: 1 }, head: { line: 1, col: 5 } }
  eq(selStart(s), { line: 1, col: 5 }, '选区起点规范化')
  eq(selEnd(s), { line: 3, col: 1 }, '选区终点规范化')
}

// ---------- 查找匹配 ----------
{
  const m = new SearchMatcher('select', { matchCase: false, wholeWord: false, regex: false })
  ok(m.ok, '普通查找可用')
  eq(m.one('SELECT 1'), { start: 0, end: 6 }, '不区分大小写命中')
  eq(new SearchMatcher('select', { matchCase: true, wholeWord: false, regex: false }).one('SELECT 1'), null, '区分大小写不命中')

  const w = new SearchMatcher('emp', { matchCase: false, wholeWord: true, regex: false })
  eq(w.one('employee emp'), { start: 9, end: 12 }, '全字匹配跳过 employee')
  eq(w.all('emp employee emp'), [{ start: 0, end: 3 }, { start: 13, end: 16 }], '全字全部命中')

  const re = new SearchMatcher('\\bORA-\\d{5}\\b', { matchCase: true, wholeWord: false, regex: true })
  eq(re.all('x ORA-00942 y ORA-00942'), [{ start: 2, end: 11 }, { start: 14, end: 23 }], '正则全部命中')

  const bad = new SearchMatcher('([', { matchCase: true, wholeWord: false, regex: true })
  ok(!bad.ok && !!bad.error, '非法正则给出错误')

  const zero = new SearchMatcher('^', { matchCase: true, wholeWord: false, regex: true })
  ok(zero.all('abc').length >= 1, '零宽匹配不陷入死循环')

  const rep = new SearchMatcher('(\\w+)@(\\w+)', { matchCase: true, wholeWord: false, regex: true })
  eq(rep.expand('$2/$1', 'a@b', { start: 0, end: 3 }), 'b/a', '正则分组替换')
  const rep2 = new SearchMatcher('x', { matchCase: true, wholeWord: false, regex: false })
  eq(rep2.expand('y', 'x', { start: 0, end: 1 }), 'y', '普通替换')
}

// ---------- 语法高亮 ----------
{
  const sql = langById('sql')
  const l1 = tokenize("select 'a' from dual -- note", 0, sql)
  ok(l1.tokens.some((t) => t.c === 'kw' && t.s === 0), 'SQL 关键字着色')
  ok(l1.tokens.some((t) => t.c === 'str'), 'SQL 字符串着色')
  ok(l1.tokens.some((t) => t.c === 'com' && t.s > 10), 'SQL 行注释着色')

  const l2 = tokenize('/* open comment', 0, sql)
  eq(l2.state, 1, '未闭合块注释进入跨行状态')
  const l3 = tokenize('still comment */ select 1', l2.state, sql)
  eq(l3.state, 0, '块注释闭合回到普通状态')
  ok(l3.tokens[0].c === 'com', '跨行注释续行着色')

  const py = langById('python')
  const p1 = tokenize('x = """doc', 0, py)
  ok(p1.state >= 2, 'Python 三引号进入跨行状态')
  const p2 = tokenize('end""" + 1', p1.state, py)
  eq(p2.state, 0, 'Python 三引号闭合')
}

// ---------- 语言识别 ----------
{
  eq(detectLang('E:/a/b/script.sql'), 'sql', '按扩展名识别 SQL')
  eq(detectLang('/tmp/app.log'), 'log', '按扩展名识别日志')
  eq(detectLang('C:/x/Dockerfile'), 'shell', '特殊文件名识别')
  eq(detectLang('C:/x/unknown.zzz'), 'text', '未知扩展名回落纯文本')
}

console.log(`editor unit: ${passed} assertions passed`)
