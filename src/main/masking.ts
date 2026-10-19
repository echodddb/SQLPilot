export type MaskingFileType = 'oracle_awr' | 'generic_log'

export interface MaskingRule {
  id: string
  name: string
  description?: string
  kind: 'builtin' | 'custom'
  /** builtin 规则的内置算法标识；custom 规则使用 pattern */
  builtinId?: string
  pattern?: string
  flags?: string
  /** custom 规则的替换文本；内置规则按类别自动生成语义代称 */
  replacement: string
  enabled: boolean
}

export interface MaskingFileTypeConfig {
  enabled: boolean
  rules: MaskingRule[]
}

export type MaskingConfig = Record<MaskingFileType, MaskingFileTypeConfig>

export interface MaskingStat {
  ruleId: string
  name: string
  count: number
}

export interface MaskingEdit {
  ruleId: string
  category: string
  original: string
  replacement: string
  originalStart: number
  originalEnd: number
  outputStart: number
  outputEnd: number
}

export interface MaskingMapping {
  category: string
  label: string
  original: string
  replacement: string
  count: number
}

export interface MaskingResult {
  content: string
  stats: MaskingStat[]
  edits: MaskingEdit[]
  mappings: MaskingMapping[]
}

export const MASKING_FILE_TYPES: { id: MaskingFileType; label: string; ext: string; desc: string }[] = [
  { id: 'oracle_awr', label: 'Oracle AWR 报告', ext: 'AWR / TXT / HTML', desc: '支持纯文本与 HTML 格式的 Oracle AWR 报告' },
  { id: 'generic_log', label: '普通日志（规划中）', ext: 'LOG / TXT', desc: '后续支持应用、数据库与操作系统日志' }
]

const CATEGORY_META: Record<string, { label: string; prefix: string; rank: number }> = {
  PASSWORD:  { label: '口令', prefix: 'password', rank: 0 },
  DBUSER:   { label: '数据库用户 / Schema', prefix: 'dbuser', rank: 1 },
  OSUSER:   { label: '操作系统用户', prefix: 'osuser', rank: 2 },
  INSTANCE: { label: '实例名', prefix: 'instance', rank: 3 },
  DB_NAME:  { label: '数据库名 / PDB', prefix: 'db', rank: 4 },
  DBID:     { label: '数据库 DBID', prefix: 'dbid', rank: 5 },
  CLUSTER:  { label: '集群名', prefix: 'cluster', rank: 6 },
  ASM_DG:   { label: 'ASM 磁盘组', prefix: 'asm', rank: 7 },
  SERVICE:  { label: '服务名 / TNS', prefix: 'service', rank: 8 },
  HOSTNAME: { label: '主机名', prefix: 'host', rank: 9 },
  DOMAIN:   { label: '域名', prefix: 'domain', rank: 10 },
  IPV4:     { label: 'IPv4 地址', prefix: 'ip', rank: 11 },
  IPV6:     { label: 'IPv6 地址', prefix: 'ipv6', rank: 12 },
  MAC:      { label: 'MAC 地址', prefix: 'mac', rank: 13 },
  EMAIL:    { label: '邮箱', prefix: 'email', rank: 14 },
  PHONE:    { label: '手机号', prefix: 'phone', rank: 15 },
  MANUAL:   { label: '自定义匹配', prefix: 'custom', rank: 20 }
}

function categoryMeta(category: string) {
  return CATEGORY_META[category] || { label: category, prefix: 'item', rank: 99 }
}

function rule(
  id: string,
  name: string,
  description: string,
  builtinId: string
): MaskingRule {
  return { id, name, description, kind: 'builtin', builtinId, replacement: '', enabled: true }
}

export function defaultMaskingConfig(): MaskingConfig {
  return {
    oracle_awr: {
      enabled: true,
      rules: [
        rule('awr_identity', 'AWR 标识', '按报告表格与标题识别 DB、PDB、DBID、实例、主机、集群等标识；相同值全局使用同一个代称', 'awr_identity'),
        rule('awr_network', '网络与连接标识', '识别表格 IP、URL/TNS/JDBC 里的 IP、主机、服务名和域名；避开版本号等数字误报', 'awr_network'),
        rule('awr_account', '账号与 Schema', '识别 Parsing Schema / Owner / Username 表格列、SQL 中 schema.对象 和 user@host', 'awr_account'),
        rule('awr_asm', 'ASM 磁盘组', '识别 +DATA、+ARCH、+FRA 等 ASM 磁盘组与路径前缀', 'awr_asm'),
        rule('awr_secret', '口令与凭据', '识别 password=、IDENTIFIED BY 等明文口令', 'awr_secret'),
        rule('awr_contact', '邮箱', '识别报告与 SQL 文本中的邮箱地址', 'awr_contact')
      ]
    },
    generic_log: {
      enabled: false,
      rules: [
        rule('generic_network', '网络标识', '识别 IP、域名、MAC（普通日志处理能力后续开放）', 'generic_network'),
        rule('generic_account', '账号标识', '识别 user@host（普通日志处理能力后续开放）', 'generic_account'),
        rule('generic_contact', '联系方式', '识别邮箱与手机号（普通日志处理能力后续开放）', 'generic_contact')
      ]
    }
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** 旧版规则迁移：新增内置规则会补齐；用户自定义规则保留。 */
export function normalizeMaskingConfig(raw: unknown): MaskingConfig {
  const out = defaultMaskingConfig()
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<MaskingConfig>
  const builtinMigrate: Record<string, string> = {
    awr_identity: 'awr_identity',
    ip_address: 'awr_network',
    host_fqdn: 'awr_network',
    jdbc_url: 'awr_network',
    oracle_user: 'awr_account',
    email: 'awr_contact',
    phone_cn: ''
  }
  for (const key of Object.keys(out) as MaskingFileType[]) {
    const src = input[key]
    if (!src || !Array.isArray(src.rules)) continue
    out[key].enabled = src.enabled !== false
    const customs: MaskingRule[] = []
    for (const r of src.rules) {
      if (!r || typeof r !== 'object') continue
      if (r.kind === 'custom') {
        customs.push({
          id: typeof r.id === 'string' && r.id ? r.id : `custom_${Date.now()}_${customs.length}`,
          name: typeof r.name === 'string' && r.name.trim() ? r.name : '未命名规则',
          kind: 'custom',
          pattern: typeof r.pattern === 'string' ? r.pattern : '',
          flags: typeof r.flags === 'string' ? r.flags : '',
          replacement: typeof r.replacement === 'string' ? r.replacement.slice(0, 128) : '[MASKED.CUSTOM]',
          enabled: r.enabled !== false
        })
        continue
      }
      const target = builtinMigrate[r.builtinId || ''] ?? (key === 'oracle_awr' ? r.builtinId : undefined)
      const existing = target ? out[key].rules.find(x => x.builtinId === target) : undefined
      // 保留旧配置中的启停状态；内置替换文案已改为语义代称，不再使用占位文本。
      if (existing && typeof r.enabled === 'boolean') existing.enabled = r.enabled
    }
    out[key].rules = [...out[key].rules, ...customs]
  }
  return out
}

function safeFlags(flags: string | undefined): string {
  const allow = new Set(['i', 'm', 's', 'u'])
  const out = new Set<string>()
  for (const ch of flags || '') if (allow.has(ch)) out.add(ch)
  return [...out].join('')
}

export function validateMaskingConfig(cfg: MaskingConfig): string | null {
  for (const key of Object.keys(cfg) as MaskingFileType[]) {
    const ids = new Set<string>()
    for (const r of cfg[key].rules) {
      if (!r.id || ids.has(r.id)) return `${MASKING_FILE_TYPES.find(x => x.id === key)?.label || key}：规则 ID 为空或重复`
      ids.add(r.id)
      if (!r.name?.trim()) return `${r.name || r.id}：规则名称不能为空`
      if (r.kind === 'custom') {
        if (!r.pattern?.trim()) return `${r.name}：自定义规则必须填写正则表达式`
        if (!r.replacement) return `${r.name}：替换文本不能为空`
        try {
          new RegExp(r.pattern, safeFlags(r.flags))
        } catch (e: any) {
          return `${r.name}：正则表达式无效（${e?.message || e}）`
        }
      }
    }
  }
  return null
}

interface Detected {
  value: string
  category: string
  ruleId: string
}

const IP_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/
const BUILTIN_SCHEMAS = new Set([
  'SYS', 'SYSTEM', 'DBSNMP', 'OUTLN', 'XDB', 'MDSYS', 'CTXSYS', 'ORDSYS',
  'ORDDATA', 'WMSYS', 'SYSMAN', 'EXFSYS', 'OLAPSYS', 'LBACSYS', 'DVSYS',
  'AUDSYS', 'ANONYMOUS', 'PUBLIC', 'APEX_PUBLIC_USER', 'FLOWS_FILES',
  'OJVMSYS', 'DIP', 'TSMSYS', 'SYSBACKUP', 'SYSDG', 'SYSKM', 'SYSRAC'
])
const SKIP_VALUES = new Set([
  'PDB$SEED', 'CDB$ROOT', 'SYS$BACKGROUND', 'SYS$USERS', 'SYS$SYSROOT',
  'YES', 'NO', 'OPEN', 'PRIMARY', 'STANDBY', 'ACTIVE', 'INACTIVE', 'LOCAL', 'REMOTE', 'INSTANCE', 'DB', 'HOST', 'SERVICE', 'NAME', 'USERNAME', 'OWNER', 'MACHINE', 'PDB', 'CONTAINER'
])

function normalizeHeader(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim().toLowerCase()
}

function htmlText(text: string): string {
  return normalizeHeader(text)
}

function headerCategory(header: string): string | null {
  const h = normalizeHeader(header)
  const exact: Record<string, string> = {
    'db name': 'DB_NAME', 'database name': 'DB_NAME', 'database uniquename': 'DB_NAME', 'unique name': 'DB_NAME',
    'pdb name': 'DB_NAME', 'container name': 'DB_NAME', 'con name': 'DB_NAME',
    'db id': 'DBID', 'database id': 'DBID', 'container db id': 'DBID',
    'instance': 'INSTANCE', 'instance name': 'INSTANCE', 'target instance': 'INSTANCE',
    'cluster name': 'CLUSTER',
    'host': 'HOSTNAME', 'host name': 'HOSTNAME', 'hostname': 'HOSTNAME',
    'machine': 'HOSTNAME', 'node name': 'HOSTNAME',
    'service': 'SERVICE', 'service name': 'SERVICE',
    'user name': 'OSUSER', 'username': 'DBUSER',
    'parsing schema name': 'DBUSER', 'parsing schema': 'DBUSER',
    'schema name': 'DBUSER', 'owner': 'DBUSER'
  }
  if (exact[h]) return exact[h]
  if (/(?:^|\s)(?:begin|end|current)?\s*(?:ip(?:v4)? address|ipaddress)(?:$|\s)/.test(h)) return 'IPV4'
  return null
}

function validValue(value: string, category: string): boolean {
  const v = value.trim()
  if (!v || v.length > 96) return false
  if (category === 'DBID') return /^\d{5,20}$/.test(v)
  if (category === 'IPV4') return IP_RE.test(v)
  if (category === 'PHONE') return /^(?:\+?86[- ]?)?1[3-9]\d{9}$/.test(v)
  if (SKIP_VALUES.has(v.toUpperCase())) return false
  if ((category === 'DBUSER' || category === 'OSUSER' || category === 'SERVICE') && BUILTIN_SCHEMAS.has(v.toUpperCase())) return false
  if (!/[A-Za-z]/.test(v)) return false
  if (/\s/.test(v)) return false
  if (/[<>&\r\n]/.test(v)) return false
  if (!/^[A-Za-z0-9_$#.@:\\\/+-]+$/.test(v)) return false
  return true
}

class Detector {
  private byKey = new Map<string, Detected>()

  add(value: string, category: string, ruleId: string): void {
    let v = String(value || '').trim().replace(/[，,;；。]+$/, '')
    if (!v) return
    if (category === 'HOSTNAME' && IP_RE.test(v)) category = 'IPV4'
    if (!validValue(v, category)) return
    // user@host / client@host 单元格不能当整体主机名处理，交给专用正则。
    if (v.includes('@') && category !== 'EMAIL') return
    const key = v.toLowerCase()
    const old = this.byKey.get(key)
    if (!old || categoryMeta(category).rank < categoryMeta(old.category).rank) {
      this.byKey.set(key, { value: v, category, ruleId })
    }
  }

  list(): Detected[] {
    return [...this.byKey.values()]
  }
}

function collectHtmlTables(text: string, detector: Detector): void {
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi
  let table: RegExpExecArray | null
  while ((table = tableRe.exec(text))) {
    let headers: string[] = []
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    let row: RegExpExecArray | null
    while ((row = rowRe.exec(table[1]))) {
      const cells: { isHeader: boolean; text: string; attrs: string }[] = []
      const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi
      let cell: RegExpExecArray | null
      while ((cell = cellRe.exec(row[1]))) {
        cells.push({ isHeader: cell[1].toLowerCase() === 'th', text: htmlText(cell[2]), attrs: cell[0] })
      }
      if (!cells.length) continue
      const headerCount = cells.filter(x => x.isHeader).length
      if (headerCount >= Math.ceil(cells.length / 2)) {
        headers = cells.map(x => x.text)
        continue
      }
      cells.forEach((cell, i) => {
        // RAC 汇总报告大量使用 headers="Database Id" 属性而不是每列 th 文本。
        const headerAttr = /headers\s*=\s*["']([^"']+)/i.exec(cell.attrs)?.[1]
        const category = headerCategory(headers[i] || '') || headerCategory(headerAttr || '')
        if (category) detector.add(cell.text, category, category === 'IPV4' ? 'awr_network' : (category === 'DBUSER' || category === 'OSUSER' ? 'awr_account' : 'awr_identity'))
      })
    }
  }
}

function isDashLine(line: string): boolean {
  const s = line.replace(/\r$/, '')
  return !!s && /^[-\s]+$/.test(s) && (s.match(/-{2,}/g) || []).length >= 2
}

function headerLooksSensitive(line: string): boolean {
  if (line.length > 400 || !line.includes('  ')) return false
  return /(?:db\s+name|database\s+name|unique\s+name|pdb\s+name|container\s+name|db\s+id|instance|host(?:\s+name)?|machine|node\s+name|service(?:\s+name)?|cluster\s+name|parsing\s+schema|schema\s+name|username|user\s+name|owner|ip\s*address)/i.test(line)
}

function collectTextTables(text: string, detector: Detector): void {
  const lines = text.split('\n')
  let pendingHeader: string | null = null
  let columns: { start: number; end: number; category: string }[] = []
  let rowsLeft = 0

  for (const line of lines) {
    const raw = line.replace(/\r$/, '')
    if (rowsLeft > 0 && columns.length) {
      if (!raw.trim()) {
        rowsLeft = 0
        columns = []
      } else {
        for (const col of columns) {
          if (col.start >= raw.length) continue
          const lo = Math.max(0, col.start - 1)
          const hi = Math.min(raw.length, col.end + 1)
          for (let i = lo; i < hi; i++) {
            if (i > 0 && !/\s/.test(raw[i - 1])) continue
            let j = i
            while (j < raw.length && !/\s/.test(raw[j])) j++
            if (j > hi) break
            const value = raw.slice(i, j)
            const category = col.category
            detector.add(value, category, category === 'IPV4' ? 'awr_network' : (category === 'DBUSER' || category === 'OSUSER' ? 'awr_account' : 'awr_identity'))
            i = j
          }
        }
        rowsLeft--
      }
      continue
    }

    if (pendingHeader !== null) {
      const headerText = pendingHeader
      if (isDashLine(raw)) {
        const runs = [...raw.matchAll(/-{2,}/g)].map(m => m.index!)
        const labels = [...headerText.matchAll(/\S+(?: \S+)*/g)].map(m => ({ start: m.index!, text: m[0] }))
        const used = new Set<number>()
        columns = []
        runs.forEach((start, idx) => {
          const end = idx + 1 < runs.length ? runs[idx + 1] : headerText.length
          let best = -1
          let bestDistance = 3
          labels.forEach((label, li) => {
            if (used.has(li)) return
            const distance = Math.abs(label.start - start)
            if (distance <= bestDistance) {
              best = li
              bestDistance = distance
            }
          })
          if (best >= 0) {
            used.add(best)
            const category = headerCategory(labels[best].text)
            if (category) columns.push({ start, end, category })
          }
        })
        rowsLeft = columns.length ? 8 : 0
      }
      pendingHeader = null
    } else if (headerLooksSensitive(raw)) {
      pendingHeader = raw
    }
  }
}

function addRegex(source: string, pattern: RegExp, fn: (m: RegExpMatchArray) => void): void {
  for (const m of source.matchAll(pattern)) fn(m)
}

function collectAwrContext(text: string, detector: Detector): void {
  const dbValue = '[A-Za-z][A-Za-z0-9_$#.-]{1,63}'
  const keyValue = '(?:DB\\s+Name|Database\\s+Name|DB\\s+ID|Unique\\s+Name|Cluster\\s+Name|Instance\\s+Name|Instance|Host\\s+Name|Hostname|Host|PDB\\s+Name|Container\\s+Name|Con\\s+Name|Service\\s+Name|Service|Node\\s+Name|Machine|Username|User\\s+Name|OS\\s+User)'

  addRegex(text, /AWR\s+Report\s+for\s+DB:\s*([^,<\r\n]+)/gi, m => detector.add(m[1], 'DB_NAME', 'awr_identity'))
  addRegex(text, /Inst:\s*([^,<\r\n]+)/gi, m => detector.add(m[1], 'INSTANCE', 'awr_identity'))
  addRegex(text, new RegExp(`DB/Inst:\\s*(${dbValue})\\s*/\\s*(${dbValue})`, 'gi'), m => {
    detector.add(m[1], 'DB_NAME', 'awr_identity')
    detector.add(m[2], 'INSTANCE', 'awr_identity')
  })
  addRegex(text, new RegExp(`^\\s*(${keyValue})\\s*(?::|＝|=|(?:\\s{2,}))\\s*(${dbValue})`, 'gim'), m => {
    const key = normalizeHeader(m[1])
    const category = headerCategory(key) || 'HOSTNAME'
    detector.add(m[2], category, category === 'IPV4' ? 'awr_network' : (category === 'DBUSER' || category === 'OSUSER' ? 'awr_account' : 'awr_identity'))
  })

  addRegex(text, /\b(?:HOST|HOSTNAME)\s*=\s*["']?([A-Za-z0-9][A-Za-z0-9._-]{1,127})/gi, m => detector.add(m[1], 'HOSTNAME', 'awr_network'))
  addRegex(text, /\b(?:SERVICE_NAME|SERVICE)\s*=\s*["']?([A-Za-z][A-Za-z0-9_.$-]{1,63})/gi, m => detector.add(m[1], 'SERVICE', 'awr_network'))
  addRegex(text, /\(\s*SID\s*=\s*["']?([A-Za-z][A-Za-z0-9_$#]{1,63})/gi, m => detector.add(m[1], 'DB_NAME', 'awr_network'))
  addRegex(text, /jdbc:oracle:thin:@(?:\/\/)?([A-Za-z0-9][A-Za-z0-9._-]{1,63})(?::\d{1,5})?\/([A-Za-z][A-Za-z0-9_.$-]{1,63})/gi, m => {
    detector.add(m[1], 'HOSTNAME', 'awr_network')
    detector.add(m[2], 'SERVICE', 'awr_network')
  })
  addRegex(text, /jdbc:oracle:thin:@(?:\/\/)?([A-Za-z0-9][A-Za-z0-9._-]{1,63})(?::\d{1,5})?:([A-Za-z][A-Za-z0-9_$#]{1,63})/gi, m => {
    detector.add(m[1], 'HOSTNAME', 'awr_network')
    detector.add(m[2], 'DB_NAME', 'awr_network')
  })
  addRegex(text, /(?:https?:\/\/|jdbc:oracle:thin:@(?:\/\/)?)((?:\d{1,3}\.){3}\d{1,3})/gi, m => detector.add(m[1], 'IPV4', 'awr_network'))
  addRegex(text, /\b(?:ip(?:v4)?|ip\s*address|begin\s*ip(?:v4)?|end\s*ip(?:v4)?)\s*(?::|=|(?:\s{2,}))\s*((?:\d{1,3}\.){3}\d{1,3})/gi, m => detector.add(m[1], 'IPV4', 'awr_network'))
  addRegex(text, /(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|cn|net|org|edu|gov|io|top|xyz|local|internal)(?![\w-])/gi, m => detector.add(m[0], 'DOMAIN', 'awr_network'))

  addRegex(text, /(?<![\w@./-])([A-Za-z][A-Za-z0-9._-]{1,31})@([A-Za-z0-9][A-Za-z0-9.-]{2,63})(?![\w.-])/g, m => {
    detector.add(m[1], 'OSUSER', 'awr_account')
    detector.add(m[2], 'HOSTNAME', 'awr_account')
  })
  addRegex(text, /\b(?:from|join|into|update|table|truncate|alter|drop|references)\s+([A-Z][A-Z0-9_$#]{1,29})\s*\.\s*["']?[A-Za-z][A-Za-z0-9_$#]{1,29}/gi, m => {
    // AWR 说明文字里也有 table scans. Owner 这类句号；只接受明确全大写的 Oracle schema。
    if (m[1] === m[1].toUpperCase()) detector.add(m[1], 'DBUSER', 'awr_account')
  })
  addRegex(text, /\b(?:schema|owner)\s*(?:=|:)\s*["']?([A-Za-z][A-Za-z0-9_$#]{1,63})/gi, m => detector.add(m[1], 'DBUSER', 'awr_account'))

  addRegex(text, /(?<![\w+\/])(\+(?:DATA|FRA|REDO|ARCH|GRID|OCR|MGMT|SYSTEM|[A-Z][A-Z0-9_]{2,29}))\//g, m => detector.add(m[1], 'ASM_DG', 'awr_asm'))
  addRegex(text, /\b(?:password|passwd|pwd)\s*(?:=|:)\s*([^\s"'&]{4,128})/gi, m => detector.add(m[1], 'PASSWORD', 'awr_secret'))
  addRegex(text, /\bidentified\s+by\s+([A-Za-z0-9_$#@"'!-]{2,63})/gi, m => {
    if (/^(?:an?|the|this|that|these|those|its|their|his|her|our|your|my|each|every|some|any|no|not)$/i.test(m[1])) return
    detector.add(m[1], 'PASSWORD', 'awr_secret')
  })
  addRegex(text, /\b(?:contact|phone|mobile|手机)\s*(?::|：|=|(?:\s{2,}))\s*((?:\+?86[- ]?)?1[3-9]\d{9})/gi, m => detector.add(m[1], 'PHONE', 'awr_contact'))
  addRegex(text, /(?<![\w.+-])[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}(?![\w-])/gi, m => detector.add(m[0], 'EMAIL', 'awr_contact'))
}

function detectAwr(text: string): Detected[] {
  const detector = new Detector()
  collectHtmlTables(text, detector)
  // HTML 中内嵌 SQL 也可能像列式文本，避免两套表格解析互相污染。
  if (!/<table\b|<td\b/i.test(text)) collectTextTables(text, detector)
  collectAwrContext(text, detector)
  return detector.list()
}

interface Candidate {
  start: number
  end: number
  value: string
  replacement: string
  category: string
  ruleId: string
}

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function literalMatches(text: string, detected: Detected, replacement: string): Candidate[] {
  const meta = categoryMeta(detected.category)
  let before = '(?<![A-Za-z0-9_$#])'
  let after = '(?![A-Za-z0-9_$#])'
  if (detected.category === 'DBID') {
    before = '(?<!\d)'
    after = '(?!\d)'
  } else if (detected.category === 'ASM_DG') {
    before = '(?<![A-Za-z0-9_+/.])'
    after = '(?![A-Za-z0-9_])'
  } else if (detected.category === 'IPV4' || detected.category === 'DOMAIN') {
    before = '(?<![A-Za-z0-9.-])'
    after = '(?![A-Za-z0-9-])'
  }
  const re = new RegExp(`${before}${escapeRegExp(detected.value)}${after}`, 'gi')
  const out: Candidate[] = []
  for (const m of text.matchAll(re)) {
    out.push({ start: m.index!, end: m.index! + m[0].length, value: detected.value, replacement, category: detected.category, ruleId: detected.ruleId })
  }
  return out
}

class PlaceholderFactory {
  private counters = new Map<string, number>()
  private used = new Set<string>()
  private assigned = new Map<string, string>()

  constructor(text: string) {
    for (const m of text.matchAll(/\b([a-z][a-z0-9_-]*)-tuoming(\d{1,5})\b/gi)) this.used.add(m[0].toLowerCase())
  }

  assign(category: string, value: string): string {
    const key = `${category}:${value.toLowerCase()}`
    const got = this.assigned.get(key)
    if (got) return got
    const prefix = categoryMeta(category).prefix
    let n = this.counters.get(prefix) || 0
    let placeholder = ''
    while (n < 100000) {
      n++
      placeholder = `${prefix}-tuoming${n}`
      if (!this.used.has(placeholder)) break
    }
    this.counters.set(prefix, n)
    this.used.add(placeholder)
    this.assigned.set(key, placeholder)
    return placeholder
  }
}

function genericDetect(text: string, rules: MaskingRule[]): Candidate[] {
  const out: Candidate[] = []
  for (const r of rules) {
    if (!r.enabled || r.kind !== 'custom') continue
    const flags = safeFlags(r.flags)
    const re = new RegExp(r.pattern!, flags.includes('g') ? flags : flags + 'g')
    for (const m of text.matchAll(re)) {
      if (!m[0].length) continue
      const replacement = r.replacement.includes('{n}') ? r.replacement.replace('{n}', String(out.length + 1)) : r.replacement
      out.push({ start: m.index!, end: m.index! + m[0].length, value: m[0], replacement, category: 'MANUAL', ruleId: r.id })
    }
  }
  return out
}

export function maskText(text: string, fileType: MaskingFileType, config: MaskingConfig): MaskingResult {
  const typeCfg = config[fileType]
  if (!typeCfg?.rules?.length) return { content: text, stats: [], edits: [], mappings: [] }
  const ruleById = new Map(typeCfg.rules.map(r => [r.id, r]))
  const factory = new PlaceholderFactory(text)
  let candidates: Candidate[] = []

  if (fileType === 'oracle_awr') {
    const detected = detectAwr(text).filter(x => ruleById.get(x.ruleId)?.enabled !== false)
    for (const item of detected) {
      const replacement = factory.assign(item.category, item.value)
      candidates.push(...literalMatches(text, item, replacement))
    }
  }
  candidates.push(...genericDetect(text, typeCfg.rules))

  // 起点优先、更长命中优先；避免 db-tuoming 与实例名等同屏重叠时重复替换。
  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || categoryMeta(a.category).rank - categoryMeta(b.category).rank)
  const selected: Candidate[] = []
  let selectedEnd = -Infinity
  for (const c of candidates) {
    if (c.start < selectedEnd) continue
    selected.push(c)
    selectedEnd = c.end
  }

  const statMap = new Map<string, MaskingStat>()
  const mappingMap = new Map<string, MaskingMapping>()
  const edits: MaskingEdit[] = []
  let out = ''
  let originalPos = 0
  for (const c of selected) {
    out += text.slice(originalPos, c.start)
    const outputStart = out.length
    out += c.replacement
    const r = ruleById.get(c.ruleId)
    edits.push({
      ruleId: c.ruleId, category: c.category, original: c.value, replacement: c.replacement,
      originalStart: c.start, originalEnd: c.end, outputStart, outputEnd: out.length
    })
    const stat = statMap.get(c.ruleId) || { ruleId: c.ruleId, name: r?.name || c.ruleId, count: 0 }
    stat.count++
    statMap.set(c.ruleId, stat)
    const mapKey = `${c.category}:${c.value.toLowerCase()}`
    const mapping = mappingMap.get(mapKey) || {
      category: c.category, label: categoryMeta(c.category).label,
      original: c.value, replacement: c.replacement, count: 0
    }
    mapping.count++
    mappingMap.set(mapKey, mapping)
    originalPos = c.end
  }
  out += text.slice(originalPos)
  const mappings = [...mappingMap.values()].sort((a, b) => categoryMeta(a.category).rank - categoryMeta(b.category).rank || a.replacement.localeCompare(b.replacement))
  return { content: out, stats: [...statMap.values()], edits, mappings }
}

export function resetMaskingConfig(): MaskingConfig {
  return clone(defaultMaskingConfig())
}


