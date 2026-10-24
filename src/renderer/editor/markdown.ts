/**
 * 轻量 Markdown 渲染（无第三方依赖）
 *
 * 安全策略：**先把整段文本做 HTML 转义**，再按语法生成标签，因此原文里的
 * `<script>` 只会出现在文本节点里；链接地址额外做协议白名单（禁止 javascript:）。
 */

export interface MdResult {
  html: string
  /** 超过渲染上限被截断 */
  truncated: boolean
  /** 原文字符数 */
  size: number
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c])
}

/**
 * 链接/图片地址白名单：http(s) / mailto / 锚点 / 相对路径
 * 注意：传入的已经是 HTML 转义过的文本（inline 先整体转义），这里不能再转义一次
 */
function safeUrl(raw: string): string {
  const u = raw.trim()
  if (!u) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) {
    // 允许 https?: 与 mailto:，其余协议（javascript:/vbscript:/data:…）一律退化
    return /^(?:https?:|mailto:)/i.test(u) ? u : '#'
  }
  if (u.startsWith('//')) return 'https:' + u
  return u
}

/* ---------------- 行内 ---------------- */

function inline(src: string): string {
  let s = esc(src)

  // 行内代码：先抽出来，避免里面的 * _ [ ] 被当成语法
  const codes: string[] = []
  s = s.replace(/(`+)([\s\S]*?)\1/g, (_m, _t, code: string) => {
    codes.push(code.replace(/^ | $/g, ''))
    return `\u0000C${codes.length - 1}\u0000`
  })

  // 图片 → 链接 → 自动链接
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^)]*)&quot;)?\)/g, (_m, alt: string, url: string) =>
    `<img src="${safeUrl(url)}" alt="${alt}" loading="lazy">`)
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^)]*)&quot;)?\)/g, (_m, txt: string, url: string) =>
    `<a href="${safeUrl(url)}">${txt}</a>`)
  s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (_m, url: string) =>
    `<a href="${safeUrl(url)}">${url}</a>`)

  // 强调
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([\s\S]+?)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
  s = s.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>')
  s = s.replace(/==([^=\n]+)==/g, '<mark>$1</mark>')

  // 行内代码回填
  s = s.replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)] ?? ''}</code>`)
  return s
}

/* ---------------- 块级 ---------------- */

interface LItem {
  indent: number
  ordered: boolean
  text: string
  /** 任务列表：' ' 未完成 / 'x' 完成；普通列表为 undefined */
  task?: string
}

interface LNode {
  ordered: boolean
  items: { text: string; task?: string; children: LNode[] }[]
}

function buildList(items: LItem[], pos: number, indent: number): [LNode, number] {
  const node: LNode = { ordered: items[pos].ordered, items: [] }
  let i = pos
  while (i < items.length) {
    const it = items[i]
    if (it.indent < indent) break
    if (it.indent > indent) {
      const [child, next] = buildList(items, i, it.indent)
      const last = node.items[node.items.length - 1]
      if (last) last.children.push(child)
      else node.items.push({ text: '', children: [child] })
      i = next
      continue
    }
    if (it.ordered !== node.ordered) break
    node.items.push({ text: it.text, task: it.task, children: [] })
    i++
  }
  return [node, i]
}

function renderList(node: LNode): string {
  const tag = node.ordered ? 'ol' : 'ul'
  let out = `<${tag}>`
  for (const it of node.items) {
    const kids = it.children.map(renderList).join('')
    if (it.task !== undefined) {
      const checked = it.task.toLowerCase() === 'x'
      out += `<li class="md-task${checked ? ' done' : ''}"><input type="checkbox" disabled${checked ? ' checked' : ''}> <span>${inline(it.text)}</span>${kids}</li>`
    } else {
      out += `<li>${inline(it.text)}${kids}</li>`
    }
  }
  return out + `</${tag}>`
}

const RE_UL = /^(\s*)([-*+])\s+(.*)$/
const RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const RE_TASK = /^\[([ xX])\]\s+(.*)$/

function isBlockStart(line: string): boolean {
  return (
    /^\s{0,3}(```+|~~~+)/.test(line) ||
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(line) ||
    /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)
  )
}

function splitRow(row: string): string[] {
  let s = row.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

export function renderMarkdown(src: string, maxChars = 800_000): MdResult {
  const size = src.length
  const truncated = size > maxChars
  let text = truncated ? src.slice(0, maxChars) : src
  text = text.replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) { i++; continue }

    // 代码围栏
    const fence = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      const mark = fence[1][0]
      const lang = fence[2] || ''
      i++
      const body: string[] = []
      while (i < lines.length && !new RegExp('^\\s{0,3}' + mark + '{3,}\\s*$').test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // 跳过收尾围栏
      out.push(
        `<div class="md-code"><div class="md-code-lang">${esc(lang || 'code')}</div>` +
        `<pre><code>${esc(body.join('\n'))}</code></pre></div>`
      )
      continue
    }

    // 标题
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      const lv = h[1].length
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`)
      i++
      continue
    }

    // 分隔线
    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    // 引用（可嵌套）
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (body.length && lines[i].trim() && !isBlockStart(lines[i])))) {
        body.push(lines[i].replace(/^\s{0,3}>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), maxChars).html}</blockquote>`)
      continue
    }

    // 表格（表头 + 分隔行）
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':')
        const r = c.endsWith(':')
        return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
      })
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]))
        i++
      }
      const th = head.map((c, k) => `<th${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</th>`).join('')
      const tb = rows
        .map((r) => '<tr>' + head.map((_c, k) => `<td${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(r[k] || '')}</td>`).join('') + '</tr>')
        .join('')
      out.push(`<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`)
      continue
    }

    // 列表
    if (RE_UL.test(line) || RE_OL.test(line)) {
      const items: LItem[] = []
      const firstOrdered = RE_OL.test(line)
      while (i < lines.length) {
        const l = lines[i]
        if (!l.trim()) {
          // 空行后若仍是同类型列表则继续（loose list），换类型（- → 1.）就结束
          if (i + 1 < lines.length && RE_OL.test(lines[i + 1]) === firstOrdered && (RE_UL.test(lines[i + 1]) || RE_OL.test(lines[i + 1]))) {
            i++
            continue
          }
          break
        }
        const mu = RE_UL.exec(l)
        const mo = RE_OL.exec(l)
        if (!mu && !mo) break
        const indent = Math.floor((mu ? mu[1] : mo![1]).replace(/\t/g, '    ').length / 2) * 2
        let content = mu ? mu[3] : mo![3]
        let task: string | undefined
        const mt = RE_TASK.exec(content)
        if (mt) {
          task = mt[1]
          content = mt[2]
        }
        items.push({ indent, ordered: !!mo, text: content, task })
        i++
      }
      // 同一段里可能出现「- 列表」紧接「1. 列表」：按类型切成多个列表，别丢内容
      let pos = 0
      while (pos < items.length) {
        const [node, next] = buildList(items, pos, items[pos].indent)
        out.push(renderList(node))
        if (next <= pos) break
        pos = next
      }
      continue
    }

    // 段落：直到空行/下一个块起始
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      // 表格起头也让位
      if (lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) break
      para.push(lines[i].trim())
      i++
    }
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    else i++ // 兜底，避免死循环
  }

  return { html: out.join('\n'), truncated, size }
}

/* ---------------- 块切分（即时渲染模式用） ---------------- */

export type MdBlockKind = 'heading' | 'paragraph' | 'list' | 'quote' | 'table' | 'code' | 'hr' | 'blank'

export interface MdBlock {
  /** 起始行（0 基，文档行号） */
  start: number
  /** 结束行（含） */
  end: number
  kind: MdBlockKind
  /** 原始 Markdown 源码（不含尾部换行） */
  text: string
  /** 代码块语言 */
  lang?: string
}

const RE_FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/

/**
 * 把 Markdown 按"块"切开，给 Typora 式即时渲染用：
 * 标题/段落/列表/引用/表格/代码块/分隔线/空行各成一块，块内保留原始源码。
 */
export function splitBlocks(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      const s = i
      while (i < lines.length && !lines[i].trim()) i++
      out.push({ start: s, end: i - 1, kind: 'blank', text: lines.slice(s, i).join('\n') })
      continue
    }

    const fence = RE_FENCE.exec(line)
    if (fence) {
      const s = i
      const mark = fence[1][0]
      i++
      while (i < lines.length && !new RegExp('^\\s{0,3}' + mark + '{3,}\\s*$').test(lines[i])) i++
      if (i < lines.length) i++
      out.push({ start: s, end: i - 1, kind: 'code', text: lines.slice(s, i).join('\n'), lang: fence[2] || '' })
      continue
    }

    if (/^\s{0,3}#{1,6}\s+/.test(line)) {
      out.push({ start: i, end: i, kind: 'heading', text: line })
      i++
      continue
    }

    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      out.push({ start: i, end: i, kind: 'hr', text: line })
      i++
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const s = i
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) i++
      out.push({ start: s, end: i - 1, kind: 'table', text: lines.slice(s, i).join('\n') })
      continue
    }

    if (/^\s{0,3}>/.test(line)) {
      const s = i
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) i++
      out.push({ start: s, end: i - 1, kind: 'quote', text: lines.slice(s, i).join('\n') })
      continue
    }

    if (/^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(line)) {
      const s = i
      while (i < lines.length) {
        const l = lines[i]
        if (!l.trim()) break
        if (/^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(l) || /^\s{2,}\S/.test(l)) { i++; continue }
        break
      }
      out.push({ start: s, end: i - 1, kind: 'list', text: lines.slice(s, i).join('\n') })
      continue
    }

    const s = i
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      if (lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) break
      i++
    }
    if (i === s) i++
    out.push({ start: s, end: i - 1, kind: 'paragraph', text: lines.slice(s, i).join('\n') })
  }

  return out
}

/** 列表项的续行前缀（回车时自动补下一项） */
export function listMarker(line: string): string {
  const m = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(\s+)(\[[ xX]\]\s+)?/.exec(line)
  if (!m) return ''
  const indent = m[1]
  const bullet = m[2] ? m[2] + ' ' : `${Number(m[3]) + 1}${m[4]} `
  const task = m[6] ? '[ ] ' : ''
  return indent + bullet + task
}

/** 行内是否只有列表标记（用来判断"空项再回车退出列表"） */
export function isEmptyListItem(line: string): boolean {
  return /^\s*(?:[-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s*)?$/.test(line)
}
