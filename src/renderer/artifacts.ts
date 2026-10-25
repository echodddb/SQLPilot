/**
 * 会话「产物」：从对话里的工具调用推导出可在右侧栏预览的结果。
 *
 * 为什么从消息推导而不是单独维护一份产物列表：
 * 消息本身就是持久化的（工具名 / 参数 / 结果全在会话历史里），再存一份产物索引
 * 就会出现「历史里有结果、产物列表是空的」这种对不齐的状态。推导是纯函数，
 * 刷新、切会话、重启后结果一致，也便于单测。
 */

export type ArtifactKind = 'table' | 'code' | 'markdown' | 'image' | 'file' | 'text'

export interface ArtifactTableData {
  columns: string[]
  rows: any[][]
  /** 服务端返回的总行数 */
  rowCount?: number
  ms?: number
  /** 结果被截断（查询上限 / 落盘上限） */
  truncated?: boolean
  /** 完整结果在主进程的 id：打开面板时按它取全量行 */
  artifactId?: string
  /** 一句话补充（如「结构信息不含索引」） */
  note?: string
}

export interface Artifact {
  /** 会话内唯一且稳定（消息 id + 工具序号），刷新后不变 */
  id: string
  /** 产生它的消息 id：对话里的内联产物卡据此归组 */
  msgId: number
  kind: ArtifactKind
  title: string
  subtitle: string
  /** 来源工具名 */
  tool: string
  /** code/text 的语言标记（sql / json / bash / csv…） */
  lang?: string
  /** code / markdown / text 的正文 */
  text?: string
  /** 产生结果的 SQL（表格产物可展开看） */
  sql?: string
  /** 本机文件路径（image / file） */
  path?: string
  table?: ArtifactTableData
}

interface ToolLike {
  name: string
  args?: string
  result?: string
  status?: string
}

interface MsgLike {
  id: number
  role: string
  tools?: ToolLike[]
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg'])

export function extOf(p: string): string {
  const s = String(p || '')
  const clean = s.split(/[?#]/)[0]
  const i = clean.lastIndexOf('.')
  return i >= 0 ? clean.slice(i).toLowerCase() : ''
}

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.has(extOf(p))
}

/** 文件扩展名 → 代码高亮语言标记（面板只做纯文本着色，不做语法解析） */
const LANG_BY_EXT: Record<string, string> = {
  '.sql': 'sql',
  '.json': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.vue': 'vue',
  '.py': 'python',
  '.sh': 'bash',
  '.bash': 'bash',
  '.ps1': 'powershell',
  '.bat': 'bat',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.xml': 'xml',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.conf': 'ini',
  '.ini': 'ini',
  '.properties': 'ini',
  '.toml': 'toml',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.log': 'text',
  '.txt': 'text'
}

export function langOf(p: string): string {
  return LANG_BY_EXT[extOf(p)] || 'text'
}

/** 一句话说明产物来源（列表里第二行） */
function subtitleOf(parts: (string | undefined | null | false)[]): string {
  return parts.filter((x): x is string => !!x && String(x).trim() !== '').join(' · ')
}

function csvCellText(v: any): string {
  if (v === null || v === undefined) return ''
  return String(v)
}

/** 极简 CSV 解析（支持双引号包裹、引号内逗号与换行、"" 转义） */
export function parseCsv(text: string, sep = ','): { columns: string[]; rows: string[][] } {
  const src = String(text || '').replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === sep) { row.push(cell); cell = ''; continue }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue }
    if (ch === '\r') continue
    cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  const clean = rows.filter((r) => r.some((c) => c !== ''))
  if (!clean.length) return { columns: [], rows: [] }
  const columns = clean[0].map((c, i) => c || `列${i + 1}`)
  return { columns, rows: clean.slice(1) }
}

function tableFromCsv(text: string, sep: ',' | '\t'): ArtifactTableData | null {
  const p = parseCsv(text, sep)
  if (!p.columns.length) return null
  const MAX = 5000
  return { columns: p.columns, rows: p.rows.slice(0, MAX), rowCount: p.rows.length, truncated: p.rows.length > MAX }
}

function sqlDigest(sql: string): string {
  const s = String(sql || '').replace(/\s+/g, ' ').trim()
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}

function fmtNum(n: any): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return String(n ?? '')
  return v.toLocaleString('zh-CN')
}

/** 把一行对象（describe 结果等）按指定字段拍平成字符串数组 */
function pickFields(row: any, fields: string[]): string[] {
  return fields.map((f) => {
    const v = row?.[f]
    if (v === null || v === undefined) return ''
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  })
}

/**
 * 单个工具调用 → 产物。识别不了就返回 null（噪音工具不产出产物）。
 */
function artifactFromTool(msgId: number, idx: number, t: ToolLike): Artifact | null {
  if (!t || !t.name || t.status === 'error' || t.status === 'running') return null
  let p: any = null
  try { p = JSON.parse(t.result || 'null') } catch { return null }
  if (!p || typeof p !== 'object' || p.error) return null
  let a: any = null
  try { a = JSON.parse(t.args || '{}') } catch { a = {} }
  const id = `a${msgId}_${idx}`
  const base = { id, msgId, tool: t.name }

  switch (t.name) {
    case 'db_query': {
      if (!Array.isArray(p.columns) || !Array.isArray(p.rows)) return null
      const shown = p.rows.length
      return {
        ...base,
        kind: 'table',
        title: `结果集${a.conn ? ' · ' + a.conn : ''}`,
        subtitle: subtitleOf([`${fmtNum(p.rowCount ?? shown)} 行`, p.ms != null ? `${p.ms}ms` : '', shown < (p.rowCount ?? shown) ? `面板可看全量` : '']),
        sql: a.sql ? String(a.sql) : undefined,
        table: {
          columns: p.columns.map((c: any) => String(c)),
          rows: p.rows,
          rowCount: p.rowCount ?? shown,
          ms: p.ms,
          truncated: !!p.truncated,
          artifactId: typeof p.artifactId === 'string' ? p.artifactId : undefined
        }
      }
    }
    case 'db_describe_table': {
      const cols = Array.isArray(p.columns) ? p.columns : null
      if (!cols) return null
      return {
        ...base,
        kind: 'table',
        title: `表结构 · ${a.schema || ''}${a.schema && a.table ? '.' : ''}${a.table || ''}`,
        subtitle: subtitleOf([`${cols.length} 列`, p.approxRows != null ? `约 ${fmtNum(p.approxRows)} 行` : '']),
        table: {
          columns: ['列名', '类型', '可空'],
          rows: cols.map((c: any) => pickFields(c, ['name', 'type', 'nullable'])),
          rowCount: cols.length,
          note: '来自数据字典（列定义）；索引与约束请用 db_get_ddl 查看'
        }
      }
    }
    case 'db_list_tables': {
      if (!Array.isArray(p.tables)) return null
      const list = p.tables.map((x: any) => (typeof x === 'string' ? x : x?.name ?? JSON.stringify(x)))
      return {
        ...base,
        kind: 'table',
        title: `对象清单 · ${a.schema || ''}`.replace(/ · $/, ''),
        subtitle: subtitleOf([`${fmtNum(p.total ?? list.length)} 个`, list.length < (p.total ?? list.length) ? `仅列前 ${list.length}` : '']),
        table: { columns: ['对象名'], rows: list.map((x: string) => [x]), rowCount: p.total ?? list.length }
      }
    }
    case 'db_list_schemas': {
      if (!Array.isArray(p.schemas)) return null
      return {
        ...base,
        kind: 'table',
        title: 'Schema 清单',
        subtitle: subtitleOf([`${fmtNum(p.total ?? p.schemas.length)} 个`, a.conn]),
        table: { columns: ['schema'], rows: p.schemas.map((x: any) => [String(x)]), rowCount: p.total ?? p.schemas.length }
      }
    }
    case 'db_get_ddl': {
      if (typeof p.ddl !== 'string' || !p.ddl.trim()) return null
      return {
        ...base,
        kind: 'code',
        lang: 'sql',
        title: `DDL · ${a.schema || ''}${a.schema && a.table ? '.' : ''}${a.table || ''}`,
        subtitle: subtitleOf([`${p.ddl.split('\n').length} 行`, a.conn]),
        text: p.ddl
      }
    }
    case 'db_write': {
      if (p.affected == null || !a.sql) return null
      const note = p.note ? `-- ${p.note}` : `-- 影响行数: ${p.affected}`
      return {
        ...base,
        kind: 'code',
        lang: 'sql',
        title: `变更 · ${sqlDigest(a.sql)}`,
        subtitle: subtitleOf([`影响 ${fmtNum(p.affected)} 行`, p.ms != null ? `${p.ms}ms` : '', a.conn]),
        sql: String(a.sql),
        text: `${String(a.sql).replace(/;+\s*$/, '')};\n${note}`
      }
    }
    case 'fs_read':
    case 'server_read_file': {
      const pth = String(p.path || a.path || '')
      if (isImagePath(pth) && t.name === 'fs_read') {
        return { ...base, kind: 'image', title: pth.split(/[\\/]/).pop() || pth, subtitle: subtitleOf([pth, p.size != null ? `${fmtNum(p.size)} B` : '']), path: pth }
      }
      if (typeof p.content !== 'string') return null
      const lang = langOf(pth)
      const isMd = lang === 'markdown'
      return {
        ...base,
        kind: isMd ? 'markdown' : 'code',
        lang,
        title: pth.split(/[\\/]/).pop() || pth,
        subtitle: subtitleOf([pth, t.name === 'server_read_file' ? '远程' : '', p.size != null ? `${fmtNum(p.size)} B` : '', String(p.content).length >= 20000 ? '内容已截断到 20000 字符' : '']),
        path: pth,
        text: p.content
      }
    }
    case 'server_tail': {
      if (typeof p.content !== 'string') return null
      return {
        ...base,
        kind: 'code',
        lang: 'text',
        title: `${String(p.path || a.path || '').split(/[\\/]/).pop() || '日志'} 尾部`,
        subtitle: subtitleOf([p.path, p.lines != null ? `末 ${p.lines} 行` : '', '远程']),
        path: String(p.path || ''),
        text: p.content
      }
    }
    case 'run_command':
    case 'server_run': {
      const out = typeof p.stdout === 'string' ? p.stdout : typeof p.content === 'string' ? p.content : ''
      const err = typeof p.stderr === 'string' ? p.stderr : ''
      if (!out.trim() && !err.trim()) return null
      const text = err ? `${out}\n${'—'.repeat(24)} stderr —\n${err}` : out
      return {
        ...base,
        kind: 'code',
        lang: 'text',
        title: `输出 · ${sqlDigest(String(a.command || ''))}`,
        subtitle: subtitleOf([p.exitCode != null ? `exit ${p.exitCode}` : '', `${text.split('\n').length} 行`, p.timedOut ? '超时' : '']),
        text
      }
    }
  }

  // 写文件类：内容在参数里（工具返回值只有路径与字节数）
  const writePath = (() => {
    if (t.name === 'fs_write' || t.name === 'server_write_file') return String(a.path || '')
    if (t.name === 'server_get_file') return String(p.savedTo || a.localPath || '')
    return ''
  })()
  if (writePath) {
    const name = writePath.split(/[\\/]/).pop() || writePath
    const content = typeof a.content === 'string' ? a.content : ''
    const lang = langOf(writePath)
    const common = { ...base, title: name, path: writePath }
    if (isImagePath(writePath)) {
      return { ...common, kind: 'image', subtitle: subtitleOf([writePath, t.name === 'server_get_file' ? '已下载' : '已写入']) }
    }
    if (/\.(csv|tsv)$/i.test(writePath) && content) {
      const tb = tableFromCsv(content, /\.tsv$/i.test(writePath) ? '\t' : ',')
      if (tb) {
        return { ...common, kind: 'table', subtitle: subtitleOf([writePath, `${fmtNum(tb.rowCount)} 行 × ${tb.columns.length} 列`]), table: tb }
      }
    }
    if (content) {
      return {
        ...common,
        kind: lang === 'markdown' ? 'markdown' : 'code',
        lang,
        subtitle: subtitleOf([writePath, t.name === 'server_get_file' ? '已下载' : `${fmtNum(p.written ?? content.length)} 字符`]),
        text: content
      }
    }
    return { ...common, kind: 'file', subtitle: subtitleOf([writePath, t.name === 'server_get_file' ? '已下载到本机' : '已写入']) }
  }
  return null
}

/** 按消息顺序收集全部产物（跨会话共用；调用方只传当前会话的 msgs） */
export function collectArtifacts(msgs: MsgLike[] | undefined | null): Artifact[] {
  const out: Artifact[] = []
  for (const m of msgs || []) {
    if (!Array.isArray(m?.tools) || !m.tools.length) continue
    m.tools.forEach((t, i) => {
      const a = artifactFromTool(m.id, i, t)
      if (a) out.push(a)
    })
  }
  return out
}

/** 标题栏角标用：产物数量 */
export function artifactKinds(list: Artifact[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const a of list) c[a.kind] = (c[a.kind] || 0) + 1
  return c
}
