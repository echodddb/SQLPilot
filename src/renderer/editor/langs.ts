/** 语言定义与按扩展名识别（对应 Notepad++ 的 Language 菜单，覆盖 DBA 常用语法） */

export type SpecialKind = 'xml' | 'markdown' | 'log' | 'ini' | 'diff' | 'json' | 'yaml' | 'shell'

export interface LangDef {
  id: string
  label: string
  exts: string[]
  lineComment?: string[]
  blockComment?: [string, string]
  quotes?: string[]
  /** 跨行字符串定界符（Python 三引号等） */
  triple?: string[]
  keywords?: string[]
  types?: string[]
  constants?: string[]
  ignoreCase?: boolean
  special?: SpecialKind
  dollarQuote?: boolean
  /** Tab 替换宽度 */
  tabSize?: number
}

const C_KEYWORDS = ('if else for while do switch case default break continue return goto sizeof typedef struct union enum class public private protected ' +
  'static const void int char short long float double unsigned signed extern inline new delete this namespace using template try catch throw operator virtual override').split(' ')

const SQL_KEYWORDS = ('select from where insert into values update set delete create alter drop table view index sequence trigger procedure function package body begin end declare ' +
  'if then else elsif loop while for exit return is as and or not null in like between exists join left right inner outer full cross on group by order having union all distinct ' +
  'commit rollback savepoint grant revoke truncate merge using when matched case when then else end with recursive connect start prior level rownum rowid sysdate dual ' +
  'cursor open fetch close exception raise pragma execute immediate bulk collect limit partition over window rows range unbounded preceding following current row ' +
  'asc desc primary key foreign references constraint default check unique cascade replace temporary local global tablespace storage pctfree initrans logging nologging parallel ' +
  'analyze explain plan autotrace set define variable spool whenever sqlerror feedback timing show describe desc').split(' ')

const SQL_TYPES = ('number numeric integer int smallint decimal float binary_float binary_double varchar varchar2 nvarchar2 char nchar clob nclob blob bfile raw long date timestamp ' +
  'interval boolean rowtype ref xmltype json').split(' ')

function cLike(id: string, label: string, exts: string[], keywords: string[], types: string[], opts: Partial<LangDef> = {}): LangDef {
  return {
    id, label, exts,
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    keywords,
    types,
    tabSize: 4,
    ...opts
  }
}

export const LANGS: LangDef[] = [
  {
    id: 'text', label: '普通文本', exts: [], tabSize: 4
  },
  {
    id: 'sql', label: 'SQL', exts: ['sql', 'plsql', 'pkb', 'pks', 'prc', 'fnc', 'trg', 'vw', 'tab', 'typ', 'spc', 'bsq', 'qry', 'dml', 'ddl'],
    lineComment: ['--'], blockComment: ['/*', '*/'], quotes: ["'", '"', '`'], keywords: SQL_KEYWORDS, types: SQL_TYPES,
    constants: ['null', 'true', 'false'], ignoreCase: true, dollarQuote: true, tabSize: 4,
    special: undefined
  },
  {
    id: 'plsql', label: 'PL/SQL', exts: ['pck', 'pkg'], tabSize: 4,
    lineComment: ['--'], blockComment: ['/*', '*/'], quotes: ["'", '"', '`'], keywords: SQL_KEYWORDS, types: SQL_TYPES,
    constants: ['null', 'true', 'false'], ignoreCase: true, dollarQuote: true
  },
  {
    id: 'python', label: 'Python', exts: ['py', 'pyw'],
    lineComment: ['#'], quotes: ['"', "'"], triple: ['"""', "'''"],
    keywords: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '),
    types: ['int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'bytes', 'object', 'None'],
    constants: ['True', 'False', 'None', 'self', 'cls'], tabSize: 4
  },
  {
    id: 'javascript', label: 'JavaScript', exts: ['js', 'mjs', 'cjs', 'jsx'],
    lineComment: ['//'], blockComment: ['/*', '*/'], quotes: ['"', "'", '`'],
    keywords: 'const let var function return if else for while do switch case default break continue class extends new this super import export from as async await try catch finally throw typeof instanceof in of delete void yield static get set'.split(' '),
    types: ['number', 'string', 'boolean', 'any', 'object', 'symbol', 'bigint'],
    constants: ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'], tabSize: 2
  },
  {
    id: 'typescript', label: 'TypeScript', exts: ['ts', 'tsx', 'mts', 'cts'],
    lineComment: ['//'], blockComment: ['/*', '*/'], quotes: ['"', "'", '`'],
    keywords: 'const let var function return if else for while do switch case default break continue class extends implements interface type enum namespace module import export from as async await try catch finally throw typeof instanceof in of delete void yield static public private protected readonly abstract declare satisfies keyof infer is'.split(' '),
    types: ['number', 'string', 'boolean', 'any', 'unknown', 'never', 'void', 'object', 'symbol', 'bigint'],
    constants: ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'], tabSize: 2
  },
  {
    id: 'json', label: 'JSON', exts: ['json', 'jsonc'], quotes: ['"'], keywords: [], types: [], constants: ['true', 'false', 'null'],
    lineComment: ['//'], blockComment: ['/*', '*/'], special: 'json', tabSize: 2
  },
  {
    id: 'xml', label: 'XML', exts: ['xml', 'xsd', 'xsl', 'xslt', 'plist', 'svg', 'config', 'pom', 'wsdl'], special: 'xml',
    blockComment: ['<!--', '-->'], quotes: ['"', "'"], tabSize: 2
  },
  {
    id: 'html', label: 'HTML', exts: ['html', 'htm', 'xhtml', 'vue'], special: 'xml',
    blockComment: ['<!--', '-->'], quotes: ['"', "'"], tabSize: 2
  },
  {
    id: 'css', label: 'CSS', exts: ['css', 'scss', 'less'],
    blockComment: ['/*', '*/'], quotes: ['"', "'"],
    keywords: 'important media import keyframes font-face supports calc var url rgb rgba hsl hsla linear-gradient transition transform animation display position color background border margin padding width height flex grid none block inline absolute relative fixed sticky'.split(' '),
    types: [], tabSize: 2
  },
  {
    id: 'yaml', label: 'YAML', exts: ['yml', 'yaml'], lineComment: ['#'], quotes: ['"', "'"], special: 'yaml', tabSize: 2
  },
  {
    id: 'ini', label: 'INI / 配置', exts: ['ini', 'conf', 'cfg', 'properties', 'env', 'cnf', 'ora', 'tnsnames', 'sqlnet'], special: 'ini',
    lineComment: [';', '#'], tabSize: 4
  },
  {
    id: 'shell', label: 'Shell', exts: ['sh', 'bash', 'zsh', 'ksh', 'bashrc', 'profile'],
    lineComment: ['#'], quotes: ['"', "'"],
    keywords: 'if then else elif fi for in do done while until case esac function return export local readonly declare unset shift exit echo printf cd source alias set trap read'.split(' '),
    special: 'shell', tabSize: 4
  },
  {
    id: 'batch', label: 'Batch', exts: ['bat', 'cmd'], lineComment: ['REM', 'rem', '::'], quotes: ['"'],
    keywords: 'echo set if else goto call exit for in do start cd dir copy move del erase mkdir rmdir type pause shift not exist errorlevel defined'.split(' '),
    ignoreCase: true, tabSize: 4
  },
  {
    id: 'powershell', label: 'PowerShell', exts: ['ps1', 'psm1', 'psd1'],
    lineComment: ['#'], blockComment: ['<#', '#>'], quotes: ['"', "'"],
    keywords: 'function param if else elseif foreach for while switch return try catch finally throw begin process end filter in where select sort group measure'.split(' '),
    types: ['string', 'int', 'bool', 'array', 'hashtable'], ignoreCase: true, tabSize: 4
  },
  cLike('c', 'C', ['c', 'h'], C_KEYWORDS, ['size_t', 'uint8_t', 'int32_t', 'FILE', 'va_list']),
  cLike('cpp', 'C++', ['cpp', 'cxx', 'cc', 'hpp', 'hxx'], [...C_KEYWORDS, 'nullptr', 'constexpr', 'auto', 'decltype', 'noexcept', 'template', 'typename', 'friend', 'explicit'], ['size_t', 'std::string', 'std::vector']),
  cLike('java', 'Java', ['java'], 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits'.split(' '), ['String', 'Integer', 'Long', 'Double', 'Boolean', 'Object', 'List', 'Map', 'Set', 'Optional']),
  cLike('csharp', 'C#', ['cs'], 'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using virtual void volatile while async await var record init'.split(' '), ['string', 'int', 'bool', 'object', 'decimal', 'List', 'Dictionary']),
  cLike('go', 'Go', ['go'], 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'.split(' '), ['string', 'int', 'int64', 'float64', 'bool', 'byte', 'rune', 'error', 'any']),
  cLike('rust', 'Rust', ['rs'], 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while'.split(' '), ['i32', 'i64', 'u8', 'u32', 'u64', 'f32', 'f64', 'bool', 'str', 'String', 'Vec', 'Option', 'Result']),
  cLike('php', 'PHP', ['php', 'phtml'], 'abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield'.split(' '), ['int', 'float', 'string', 'bool', 'array', 'object', 'mixed', 'void']),
  cLike('ruby', 'Ruby', ['rb', 'rake', 'gemspec'], 'alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor attr_reader'.split(' '), ['String', 'Integer', 'Float', 'Array', 'Hash', 'Symbol'], { lineComment: ['#'] }),
  {
    id: 'markdown', label: 'Markdown', exts: ['md', 'markdown', 'mdx'], special: 'markdown', quotes: [], tabSize: 2
  },
  {
    id: 'log', label: '日志', exts: ['log', 'out', 'err', 'trace', 'audit'], special: 'log', tabSize: 4
  },
  {
    id: 'diff', label: 'Diff / Patch', exts: ['diff', 'patch'], special: 'diff', tabSize: 4
  },
  {
    id: 'toml', label: 'TOML', exts: ['toml'], lineComment: ['#'], quotes: ['"', "'"], special: 'ini', tabSize: 2
  },
  {
    id: 'makefile', label: 'Makefile', exts: ['mak', 'make'], lineComment: ['#'], quotes: ['"', "'"],
    keywords: 'all clean install test build run'.split(' '), tabSize: 4
  }
]

const byId = new Map<string, LangDef>()
for (const l of LANGS) if (!byId.has(l.id)) byId.set(l.id, l)

export function langById(id: string): LangDef {
  return byId.get(id) || byId.get('text')!
}

const byExt = new Map<string, string>()
for (const l of LANGS) for (const e of l.exts) if (e && !byExt.has(e)) byExt.set(e, l.id)

const byName: Record<string, string> = {
  dockerfile: 'shell',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.gitignore': 'text',
  '.env': 'ini',
  '.bashrc': 'shell',
  '.profile': 'shell',
  cnf: 'ini'
}

/** 按路径识别语言（扩展名优先，其次特殊文件名） */
export function detectLang(filePath: string | null | undefined, name?: string): string {
  const base = (filePath ? filePath.split(/[\\/]/).pop() : '') || name || ''
  const lower = base.toLowerCase()
  if (byName[lower]) return byName[lower]
  const dot = lower.lastIndexOf('.')
  if (dot >= 0) {
    const ext = lower.slice(dot + 1)
    const id = byExt.get(ext)
    if (id) return id
  }
  // Oracle 导出脚本等无扩展名但内容像 SQL 的情况交给用户手动切换
  return 'text'
}

/** 供语言菜单展示（去重 + 排序） */
export const LANG_MENU: { id: string; label: string }[] = (() => {
  const seen = new Set<string>()
  const out: { id: string; label: string }[] = []
  for (const l of LANGS) {
    if (seen.has(l.id)) continue
    seen.add(l.id)
    out.push({ id: l.id, label: l.label })
  }
  return out
})()
