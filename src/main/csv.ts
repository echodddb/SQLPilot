// CSV 导出构造：UTF-8 BOM + CRLF，Excel 双击打开不乱码。
// 独立纯函数模块（无 electron 依赖），便于单测。

/** 单元格转义：含引号/逗号/换行时整体加引号，内部引号翻倍 */
export function csvCell(v: any): string {
  let s: string
  if (v === null || v === undefined) s = ''
  else if (v instanceof Date) s = v.toISOString().replace('T', ' ').slice(0, 19)
  else if (typeof v === 'object') s = JSON.stringify(v)
  else s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 按选定列（顺序保持选择顺序）构造完整 CSV 文本（含表头，带 BOM，CRLF 行尾） */
export function buildCsv(columns: string[], rows: any[][], selected: string[]): string {
  const wanted = selected.map((c) => String(c).toLowerCase())
  const idx = wanted
    .map((w) => columns.findIndex((c) => String(c).toLowerCase() === w))
    .filter((i) => i >= 0)
  if (!idx.length) throw new Error('所选列都不在结果集中')
  const lines = [idx.map((i) => csvCell(columns[i])).join(',')]
  for (const row of rows) lines.push(idx.map((i) => csvCell(row[i])).join(','))
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}
