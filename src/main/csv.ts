// CSV 导出构造：UTF-8 BOM + CRLF，Excel 双击打开不乱码。
// 独立纯函数模块（无 electron 依赖），便于单测。

/**
 * 单元格转义：含引号/逗号/换行时整体加引号，内部引号翻倍。
 * 公式注入防护（OWASP CSV Injection）：=、+、@ 及制表符/回车开头的值加 "'" 前缀，
 * 防导出的恶意数据在 Excel/WPS 中被当公式执行（如 =cmd|'/c calc'）。
 * "-" 开头仅当不是纯数字样式（负数/百分比/金额是 DBA 数据常态，不能误伤）时加前缀。
 */
export function csvCell(v: any): string {
  let s: string
  if (v === null || v === undefined) s = ''
  else if (v instanceof Date) s = v.toISOString().replace('T', ' ').slice(0, 19)
  else if (Buffer.isBuffer(v)) s = `[binary ${v.length} bytes]`
  else if (typeof v === 'object') s = JSON.stringify(v)
  else s = String(v)
  if (/^[=+@\t\r]/.test(s)) s = "'" + s
  // "-" 开头：只放行严格数字样式（负数/百分比/千分位金额），其余（-2+3 等）一律加前缀
  else if (/^-/.test(s) && !/^(?:-\d+(?:\.\d+)?%?|-\d{1,3}(?:,\d{3})+(?:\.\d+)?)$/.test(s)) s = "'" + s
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 按选定列（顺序保持选择顺序）构造完整 CSV 文本（含表头，带 BOM，CRLF 行尾）。
 *  selected 支持列下标或列名：列名匹配必须"逐个占用"，否则 `SELECT a.id, b.id` 里
 *  两个 id 都会命中第 0 列，导出的数据是静默错误的。 */
export function buildCsv(columns: string[], rows: any[][], selected: (string | number)[]): string {
  const used = new Set<number>()
  const idx: number[] = []
  const missing: string[] = []
  for (const sel of selected) {
    let hit = -1
    if (typeof sel === 'number' && Number.isInteger(sel)) {
      if (sel >= 0 && sel < columns.length && !used.has(sel)) hit = sel
    } else {
      const want = String(sel).toLowerCase()
      for (let c = 0; c < columns.length; c++) {
        if (!used.has(c) && String(columns[c]).toLowerCase() === want) {
          hit = c
          break
        }
      }
    }
    if (hit >= 0) {
      used.add(hit)
      idx.push(hit)
    } else {
      missing.push(String(sel))
    }
  }
  if (missing.length) throw new Error(`结果集中找不到所选列：${missing.join(', ')}（列名可能重复或已被重命名，请刷新结果后重试）`)
  if (!idx.length) throw new Error('所选列都不在结果集中')
  const lines = [idx.map((i) => csvCell(columns[i])).join(',')]
  for (const row of rows) lines.push(idx.map((i) => csvCell(row[i])).join(','))
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}
