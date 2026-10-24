// Markdown 渲染器单测：安全（转义/协议白名单）+ 常见语法
import assert from 'node:assert/strict'
import { renderMarkdown, splitBlocks, listMarker, isEmptyListItem } from '../src/renderer/editor/markdown.ts'

let passed = 0
const ok = (cond, why) => {
  assert.ok(cond, `${why}`)
  passed++
}
const has = (html, frag, why) => {
  assert.ok(html.includes(frag), `${why}：未找到 ${frag}\n实际：${html}`)
  passed++
}
const not = (html, frag, why) => {
  assert.ok(!html.includes(frag), `${why}：不应出现 ${frag}\n实际：${html}`)
  passed++
}

// ---------- 安全 ----------
{
  const r = renderMarkdown('<script>alert(1)</script>\n\n普通段落 <img src=x onerror=alert(2)>')
  not(r.html, '<script>', '原始 script 标签必须被转义')
  has(r.html, '&lt;script&gt;', 'script 以文本显示')
  not(r.html, 'onerror=alert(2)>', '正文里的标签被转义')
  ok(!r.html.includes('<img src="x"'), '不要还原未授权的 img')
}
{
  const r = renderMarkdown('[点我](javascript:alert(1))\n\n![图](vbscript:evil)')
  not(r.html, 'javascript:', '禁止 javascript: 协议')
  not(r.html, 'vbscript:', '禁止 vbscript: 协议')
  has(r.html, 'href="#"', '非法链接退化为 #')
}
{
  const r = renderMarkdown('[正常](https://example.com/a?b=1&c=2)')
  has(r.html, 'href="https://example.com/a?b=1&amp;c=2"', '合法链接保留并转义 &')
}

// ---------- 标题 / 分隔线 ----------
{
  const r = renderMarkdown('# 一级\n\n### 三级 ###\n\n---')
  has(r.html, '<h1>一级</h1>', 'H1')
  has(r.html, '<h3>三级</h3>', 'H3 且去掉收尾 #')
  has(r.html, '<hr>', '分隔线')
}

// ---------- 强调 / 行内代码 ----------
{
  const r = renderMarkdown('这是 **粗体**、*斜体*、~~删除~~ 和 `code_x` 混排')
  has(r.html, '<strong>粗体</strong>', '粗体')
  has(r.html, '<em>斜体</em>', '斜体')
  has(r.html, '<del>删除</del>', '删除线')
  has(r.html, '<code>code_x</code>', '行内代码里的下划线不被当成斜体')
}

// ---------- 代码块 ----------
{
  const r = renderMarkdown('```sql\nselect * from t where a < 1;\n```')
  has(r.html, 'md-code-lang">sql<', '代码块语言标记')
  has(r.html, 'a &lt; 1;', '代码块内容被转义')
  not(r.html, '<strong>', '代码块内不解析强调')
}

// ---------- 列表 / 任务列表 / 嵌套 ----------
{
  const r = renderMarkdown('- 一\n- 二\n  - 二点一\n\n1. 甲\n2. 乙')
  has(r.html, '<ul><li>一</li><li>二<ul><li>二点一</li></ul></li></ul>', '嵌套无序列表')
  has(r.html, '<ol><li>甲</li><li>乙</li></ol>', '有序列表')
}
{
  const r = renderMarkdown('- [ ] 待办\n- [x] 已完成')
  has(r.html, 'md-task', '任务列表样式类')
  has(r.html, 'checked', '已完成项带 checked')
  has(r.html, '待办', '任务文本')
}

// ---------- 引用 / 表格 ----------
{
  const r = renderMarkdown('> 引用一行\n> 第二行')
  has(r.html, '<blockquote>', '块引用')
  has(r.html, '引用一行', '引用内容')
}
{
  const r = renderMarkdown('| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n| 梨 | 12 |')
  has(r.html, 'text-align:left', '左对齐')
  has(r.html, 'text-align:right', '右对齐')
  has(r.html, '<tbody><tr><td', '表体渲染')
  has(r.html, '>苹果<', '单元格内容')
}

// ---------- 截断 ----------
{
  const r = renderMarkdown('a'.repeat(500), 100)
  ok(r.truncated === true, '超限标记 truncated')
  ok(r.html.length < 300, '截断后输出不会过长')
}
{
  const r = renderMarkdown('短文本', 100)
  ok(r.truncated === false, '未超限不标记')
}

// ---------- 即时渲染的块切分 ----------
{
  const src = [
    '# 标题',
    '',
    '第一段',
    '第二行',
    '',
    '- 苹果',
    '- 香蕉',
    '  - 嵌套',
    '',
    '```sql',
    'select 1;',
    '```',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '> 引用',
    '',
    '---'
  ].join('\n')
  const bs = splitBlocks(src)
  const kinds = bs.map((b) => b.kind)
  assert.deepEqual(kinds.filter((k) => k !== 'blank'), ['heading', 'paragraph', 'list', 'code', 'table', 'quote', 'hr'], '块类型顺序')
  const code = bs.find((b) => b.kind === 'code')
  assert.equal(code.lang, 'sql', '代码块语言')
  assert.equal(code.text, '```sql\nselect 1;\n```', '代码块保留围栏源码')
  const list = bs.find((b) => b.kind === 'list')
  assert.equal(list.text.split('\n').length, 3, '列表块包含三行')
  // 行号能覆盖整篇且不重叠
  let expect = 0
  for (const b of bs) {
    assert.equal(b.start, expect, '块起点连续')
    assert.ok(b.end >= b.start, '块结束不早于起点')
    expect = b.end + 1
  }
  passed += 4
}
{
  assert.equal(listMarker('- 苹果'), '- ', '无序列表续写')
  assert.equal(listMarker('  3. 第三'), '  4. ', '有序列表编号递增且保留缩进')
  assert.equal(listMarker('- [ ] 任务'), '- [ ] ', '任务列表续写')
  assert.equal(listMarker('普通文本'), '', '非列表无前缀')
  assert.equal(isEmptyListItem('- '), true, '空无序项')
  assert.equal(isEmptyListItem('2. '), true, '空有序项')
  assert.equal(isEmptyListItem('- 内容'), false, '有内容不算空项')
  passed += 7
}

console.log(`markdown unit: ${passed} assertions passed`)
