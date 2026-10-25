/**
 * 文本编辑器文件引擎（主进程）
 *
 * 设计要点：
 * - 普通文件（≤ FULL_MODE_MAX）整篇解码成字符串交给渲染层，编辑在内核里完成；
 * - 超大文件（日志/导出文件）不整篇解码：只在字节层面建立「行起始偏移索引」，
 *   渲染层按可视窗口请求若干行，内存 ≈ 文件大小 + 4 字节/行，打开与滚动都是毫秒级；
 * - 编码：UTF-8 / UTF-8 BOM / UTF-16 LE·BE / GBK / GB18030 / BIG5 / Latin-1，读写同编码；
 * - 换行：CRLF / LF / CR 自动探测，保存时按用户选择写回。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, dialog, BrowserWindow } from 'electron'
import iconv from 'iconv-lite'

export type EncodingId = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'gbk' | 'gb18030' | 'big5' | 'latin1'
export type EolId = 'CRLF' | 'LF' | 'CR'

export const ENCODINGS: EncodingId[] = ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'gbk', 'gb18030', 'big5', 'latin1']

/** 超过该大小走窗口模式（只读 + 按需取行）；可用「载入完整内容」强制整篇加载 */
export const FULL_MODE_MAX = 24 * 1024 * 1024

export interface EditorDocMeta {
  id: string
  path: string | null
  name: string
  size: number
  mtimeMs: number
  encoding: EncodingId
  eol: EolId
  lineCount: number
  mode: 'full' | 'window'
  /** 无扩展名/未知扩展名时按内容猜测的语言 id（渲染层优先使用） */
  langHint?: string
  /** 整篇文本（仅 full 模式，打开时一次性下发） */
  text?: string
}

interface DocEntry {
  id: string
  path: string | null
  name: string
  size: number
  mtimeMs: number
  encoding: EncodingId
  eol: EolId
  mode: 'full' | 'window'
  lineCount: number
  /** window 模式：原始字节 + 行起始字节偏移 */
  buf?: Buffer
  offsets?: Uint32Array
  /** 探测到的 BOM 长度（window 模式解码用） */
  bomLen: number
  /** 内容嗅探出的语言（仅未知扩展名时） */
  langHint?: string
}

const docs = new Map<string, DocEntry>()
let seq = 0

/** 启动参数/二次实例带来的待打开文件（渲染层挂载后取走） */
let pendingOpens: string[] = []

export function setPendingOpens(list: string[]): void {
  pendingOpens = list.slice()
}

export function takePendingOpens(): string[] {
  const out = pendingOpens
  pendingOpens = []
  return out
}

/** 命令行/拖入传入的文件夹：作为左侧文件夹树打开 */
let pendingWorkspace = ''

export function setPendingWorkspace(dir: string): void {
  pendingWorkspace = dir || ''
}

export function takePendingWorkspace(): string {
  const d = pendingWorkspace
  pendingWorkspace = ''
  return d
}

/** 从命令行参数里挑出真实存在的文件夹 */
export function dirsFromArgv(argv: string[]): string[] {
  const self = path.resolve(process.execPath).toLowerCase()
  const out: string[] = []
  for (const a of argv) {
    if (!a || a.startsWith('-') || !path.isAbsolute(a)) continue
    if (path.resolve(a).toLowerCase() === self) continue
    try { if (fs.statSync(a).isDirectory()) out.push(a) } catch { /* 忽略 */ }
  }
  return out
}

/** 从命令行参数里挑出真实存在的文件（忽略开关与目录） */
export function filesFromArgv(argv: string[]): string[] {
  const out: string[] = []
  // argv[0] 是可执行文件自身（electron.exe / SQLPilot.exe），绝不能当成待打开文件
  const self = path.resolve(process.execPath).toLowerCase()
  for (const a of argv) {
    if (!a || a.startsWith('-')) continue
    if (!path.isAbsolute(a)) continue
    if (path.resolve(a).toLowerCase() === self) continue
    try {
      if (fs.statSync(a).isFile()) out.push(a)
    } catch { /* 不存在则忽略 */ }
  }
  return out
}

function newId(): string {
  return 'doc_' + Date.now().toString(36) + '_' + (++seq).toString(36)
}

function stateFile(): string {
  return path.join(app.getPath('userData'), 'editor-recents.json')
}

export interface RecentEntry {
  path: string
  name: string
  at: number
  line?: number
  col?: number
}

export function listRecents(): RecentEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (Array.isArray(raw?.recents)) {
      return raw.recents.filter((r: any) => r && typeof r.path === 'string').slice(0, 40)
    }
  } catch { /* 无记录或损坏 */ }
  return []
}

function pushRecent(file: string, line?: number, col?: number): void {
  try {
    const list = listRecents().filter((r) => r.path.toLowerCase() !== file.toLowerCase())
    list.unshift({ path: file, name: path.basename(file), at: Date.now(), line, col })
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify({ recents: list.slice(0, 40) }, null, 2), 'utf8')
  } catch { /* 最近列表写失败不影响打开 */ }
}

export function clearRecents(): void {
  try { fs.unlinkSync(stateFile()) } catch { /* 忽略 */ }
}

// ---------------- 编码 / 换行 ----------------

function stripBom(buf: Buffer, enc: EncodingId): { buf: Buffer; bomLen: number } {
  if (enc === 'utf8bom' && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { buf: buf.subarray(3), bomLen: 3 }
  if ((enc === 'utf16le' || enc === 'utf16be') && buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return { buf: buf.subarray(2), bomLen: 2 }
    if (buf[0] === 0xfe && buf[1] === 0xff) return { buf: buf.subarray(2), bomLen: 2 }
  }
  return { buf, bomLen: 0 }
}

/** 编码探测：BOM 优先；无 BOM 时用严格 UTF-8 解码**扫全文件**（只看前 1MB 会把"前段英文、后面中文"的 GBK 文件误判成 UTF-8） */
export function detectEncoding(buf: Buffer): EncodingId {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8bom'
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be'
  if (buf.length === 0) return 'utf8'
  try {
    const dec = new TextDecoder('utf-8', { fatal: true })
    const STEP = 1 << 20
    for (let i = 0; i < buf.length; i += STEP) {
      // stream 模式：分块边界上的半个字符会被缓存到下一块，不会误报
      dec.decode(buf.subarray(i, Math.min(i + STEP, buf.length)), { stream: true })
    }
    // 不 flush：文件末尾若被截断在字符中间，也不该把整个文件判成 GBK
    return 'utf8'
  } catch {
    // 中文 Windows 的 ANSI 文件绝大多数是 GBK；GB18030 是其超集但解码更慢，先按 GBK
    return 'gbk'
  }
}

function decode(buf: Buffer, enc: EncodingId): string {
  switch (enc) {
    case 'utf8':
    case 'utf8bom':
      return new TextDecoder('utf-8').decode(buf)
    case 'utf16le':
      return iconv.decode(buf, 'utf16le')
    case 'utf16be':
      return iconv.decode(buf, 'utf16-be')
    case 'gbk':
      return iconv.decode(buf, 'gbk')
    case 'gb18030':
      return iconv.decode(buf, 'gb18030')
    case 'big5':
      return iconv.decode(buf, 'big5')
    case 'latin1':
      return buffer_latin1(buf)
    default:
      return new TextDecoder('utf-8').decode(buf)
  }
}

/** 分块解码：每 2MB 让出一次事件循环，避免整篇解码把主进程卡住（重新打开编码时尤其明显） */
async function decodeAsync(buf: Buffer, enc: EncodingId): Promise<string> {
  const CH = 2 * 1024 * 1024
  const yieldNow = () => new Promise<void>((r) => setImmediate(r))
  if (enc === 'utf8' || enc === 'utf8bom') {
    const dec = new TextDecoder('utf-8')
    let out = ''
    for (let i = 0; i < buf.length; i += CH) {
      out += dec.decode(buf.subarray(i, i + CH), { stream: true })
      await yieldNow()
    }
    out += dec.decode()
    return out
  }
  const label = enc === 'utf16le' ? 'utf16le'
    : enc === 'utf16be' ? 'utf16-be'
    : enc === 'gb18030' ? 'gb18030'
    : enc === 'big5' ? 'big5'
    : enc === 'latin1' ? 'latin1'
    : 'gbk'
  const dec = iconv.getDecoder(label)
  let out = ''
  for (let i = 0; i < buf.length; i += CH) {
    out += dec.write(buf.subarray(i, i + CH))
    await yieldNow()
  }
  out += dec.end()
  return out
}

function buffer_latin1(buf: Buffer): string {
  // 分块避免 String.fromCharCode 参数过多爆栈
  let out = ''
  const CH = 8192
  for (let i = 0; i < buf.length; i += CH) {
    out += String.fromCharCode.apply(null, buf.subarray(i, i + CH) as unknown as number[])
  }
  return out
}

function encode(text: string, enc: EncodingId): Buffer {
  switch (enc) {
    case 'utf8':
      return Buffer.from(text, 'utf8')
    case 'utf8bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf16-be')])
    case 'gbk':
      return iconv.encode(text, 'gbk')
    case 'gb18030':
      return iconv.encode(text, 'gb18030')
    case 'big5':
      return iconv.encode(text, 'big5')
    case 'latin1':
      return Buffer.from(text, 'latin1')
    default:
      return Buffer.from(text, 'utf8')
  }
}

export function detectEol(text: string): EolId {
  const sample = text.length > 262144 ? text.slice(0, 262144) : text
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c === 13) {
      if (sample.charCodeAt(i + 1) === 10) { crlf++; i++ } else cr++
    } else if (c === 10) lf++
  }
  if (crlf >= lf && crlf >= cr && crlf > 0) return 'CRLF'
  if (lf >= cr && lf > 0) return 'LF'
  if (cr > 0) return 'CR'
  return 'CRLF'
}

function eolBytes(eol: EolId, enc: EncodingId): Buffer {
  const s = eol === 'CRLF' ? '\r\n' : eol === 'LF' ? '\n' : '\r'
  return enc === 'utf16le' || enc === 'utf16be' ? iconv.encode(s, enc === 'utf16le' ? 'utf16le' : 'utf16-be') : Buffer.from(s, 'latin1')
}

/** 字节层面的行起始索引（仅 window 模式使用）。UTF-16 需校验对齐，避免错位匹配 */
async function buildLineOffsets(buf: Buffer, enc: EncodingId, eol: EolId): Promise<Uint32Array> {
  const pat = eolBytes(eol, enc)
  const utf16 = enc === 'utf16le' || enc === 'utf16be'
  const starts: number[] = [0]
  let idx = buf.indexOf(pat, 0)
  let n = 0
  while (idx !== -1) {
    if (utf16 && idx % 2 !== 0) {
      idx = buf.indexOf(pat, idx + 1)
      continue
    }
    const next = idx + pat.length
    starts.push(next)
    idx = buf.indexOf(pat, next)
    // 每 5 万行让出一次：150MB / 166 万行的索引扫描不再整段阻塞主进程
    if ((++n % 50000) === 0) await new Promise<void>((r) => setImmediate(r))
  }
  // 与 Scintilla/Notepad++ 一致：文件以换行结尾时，换行后还有一个空行
  return Uint32Array.from(starts)
}

/** 无扩展名 / 未知扩展名的文件：按开头内容猜一个语言，避免一律"普通文本" */
export function guessLangFromContent(sample: string): string | null {
  const s = sample.slice(0, 4000)
  if (!s.trim()) return null
  if (/^\s*[\[{]/.test(s) && /"[^"\n]+"\s*:/.test(s)) return 'json'
  if (/<\?xml|<!DOCTYPE\s+html|<html[\s>]/i.test(s)) return 'xml'
  if (/^#!.*\bpython/i.test(s)) return 'python'
  if (/^#!.*\b(?:ba|z|k)?sh\b/i.test(s)) return 'shell'
  if (/^\s*(?:--|\/\*)/.test(s) && /\b(?:select|insert|update|delete|create|alter|declare|begin)\b/i.test(s)) return 'sql'
  if (/^\s*(?:select|insert|update|delete|create|alter|drop|declare|begin|merge|with)\b/im.test(s)) return 'sql'
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/m.test(s) && /\b(?:INFO|WARN|WARNING|ERROR|DEBUG|FATAL)\b/.test(s)) return 'log'
  if (/^\s*\[[^\]]+\]\s*$/m.test(s) && /^\s*[\w.-]+\s*=/m.test(s)) return 'ini'
  return null
}

function makeMeta(d: DocEntry): EditorDocMeta {
  return {
    id: d.id,
    path: d.path,
    name: d.name,
    size: d.size,
    mtimeMs: d.mtimeMs,
    encoding: d.encoding,
    eol: d.eol,
    lineCount: d.lineCount,
    mode: d.mode,
    ...(d.langHint ? { langHint: d.langHint } : {})
  }
}

// ---------------- 打开 / 关闭 ----------------

export async function openPath(file: string, forceEncoding?: EncodingId): Promise<{ ok: boolean; doc?: EditorDocMeta; error?: string }> {
  try {
    const st = await fsp.stat(file)
    if (!st.isFile()) return { ok: false, error: '不是文件：' + file }
    // 先按大小分流：readFile 对 >2GiB 直接抛 ERR_FS_FILE_TOO_LARGE（原始英文报错），
    // 而窗口模式本来就是给这种大日志设计的；这里给一条能看懂的提示而不是让它炸在 Buffer 上限上
    if (st.size > 1_500 * 1024 * 1024) {
      return { ok: false, error: `文件 ${(st.size / 1024 / 1024 / 1024).toFixed(2)} GB，超过编辑器 1.5GB 上限；请用「服务器」模块的 tail 或命令行分段查看` }
    }
    const raw = await fsp.readFile(file)
    const encoding = forceEncoding || detectEncoding(raw)
    const stripped = stripBom(raw, encoding)
    const bomLen = stripped.bomLen
    const body = stripped.buf
    const knownExt = /\.[A-Za-z0-9]{1,8}$/.test(file)
    const langHint = knownExt ? undefined : guessLangFromContent(decode(body.subarray(0, Math.min(body.length, 8192)), encoding)) || undefined

    if (raw.length > FULL_MODE_MAX) {
      // 先按采样探测换行，再建字节行索引
      const sample = decode(body.subarray(0, Math.min(body.length, 262144)), encoding)
      const eol = detectEol(sample)
      const offsets = await buildLineOffsets(body, encoding, eol)
      const d: DocEntry = {
        id: newId(), path: file, name: path.basename(file), size: raw.length, mtimeMs: st.mtimeMs,
        encoding, eol, mode: 'window', lineCount: offsets.length, buf: body, offsets, bomLen, langHint
      }
      docs.set(d.id, d)
      pushRecent(file)
      return { ok: true, doc: makeMeta(d) }
    }

    // 整篇解码（分块让出，避免重开编码时主进程假死）
    const text = await decodeAsync(body, encoding)
    const eol = detectEol(text)
    const lineCount = countLines(text)
    const d: DocEntry = {
      id: newId(), path: file, name: path.basename(file), size: raw.length, mtimeMs: st.mtimeMs,
      encoding, eol, mode: 'full', lineCount, bomLen, langHint
    }
    docs.set(d.id, d)
    pushRecent(file)
    return { ok: true, doc: { ...makeMeta(d), text } }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export function countLines(text: string): number {
  if (!text) return 1
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 || (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) !== 10)) n++
  return n
}

export async function openDialog(multi = true): Promise<{ ok: boolean; canceled?: boolean; docs?: EditorDocMeta[]; errors?: string[] }> {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  // 只给一个「全部文件」过滤器：Windows 的文件对话框会"记住"上次的类型，
  // 多过滤器时上次选过 SQL 就会默认只剩 .sql 可见（用户实际踩到的坑）。
  // 文本编辑器本来就应该能打开任意文件，单一过滤器最稳。
  const recent = listRecents().find((r) => {
    try { return fs.statSync(r.path).isFile() } catch { return false }
  })
  const startDir = recent ? path.dirname(recent.path) : app.getPath('documents')
  const r = await dialog.showOpenDialog(win, {
    title: '打开文件',
    defaultPath: startDir,
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: '全部文件', extensions: ['*'] }]
  })
  if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true }
  const out: EditorDocMeta[] = []
  const errors: string[] = []
  for (const p of r.filePaths) {
    const one = await openPath(p)
    if (one.ok && one.doc) out.push(one.doc)
    else errors.push(`${path.basename(p)}：${one.error}`)
  }
  return { ok: errors.length === 0, docs: out, errors }
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  /** 隐藏项（. 开头）由渲染层淡化显示 */
  hidden: boolean
}

/** 列一层目录（文件夹在前、按名称自然排序）——树面板按需展开，只读当前层 */
export async function listDir(dir: string): Promise<{ ok: boolean; entries?: DirEntry[]; error?: string }> {
  try {
    const st = await fsp.stat(dir)
    if (!st.isDirectory()) return { ok: false, error: '不是文件夹' }
    const items = await fsp.readdir(dir, { withFileTypes: true })
    const entries: DirEntry[] = []
    for (const it of items) {
      // 符号链接按目标类型判断，避免 junction 目录点不开
      let isDir = it.isDirectory()
      if (it.isSymbolicLink()) {
        try { isDir = (await fsp.stat(path.join(dir, it.name))).isDirectory() } catch { isDir = false }
      }
      entries.push({ name: it.name, path: path.join(dir, it.name), isDir, hidden: it.name.startsWith('.') })
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
    })
    return { ok: true, entries }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 拖拽/命令行给的是路径：判断是文件还是文件夹 */
export async function statPath(p: string): Promise<{ ok: boolean; isDir?: boolean; isFile?: boolean; error?: string }> {
  try {
    const st = await fsp.stat(p)
    return { ok: true, isDir: st.isDirectory(), isFile: st.isFile() }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export async function openFolderDialog(): Promise<{ ok: boolean; canceled?: boolean; dir?: string }> {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const r = await dialog.showOpenDialog(win, { title: '选择文件夹', properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true }
  return { ok: true, dir: r.filePaths[0] }
}

/** 窗口模式：按行号区间取文本（渲染层只请求可视区） */
export function getWindow(id: string, start: number, count: number): { ok: boolean; start?: number; lines?: string[]; total?: number; error?: string } {
  const d = docs.get(id)
  if (!d) return { ok: false, error: '文档已关闭' }
  if (d.mode === 'full') return { ok: false, error: '该文档为完整模式，请使用内核数据' }
  const total = d.lineCount
  const from = Math.max(0, Math.min(total, Math.floor(start)))
  const to = Math.max(from, Math.min(total, from + Math.max(0, Math.floor(count))))
  if (!d.buf || !d.offsets) return { ok: false, error: '文档缓冲区不可用' }
  if (from >= to) return { ok: true, start: from, lines: [], total }
  const byteStart = d.offsets[from]
  const byteEnd = to < total ? d.offsets[to] : d.buf.length
  const text = decode(d.buf.subarray(byteStart, byteEnd), d.encoding)
  const parts = text.split(/\r\n|\n|\r/)
  const lines = parts.slice(0, to - from)
  return { ok: true, start: from, lines, total }
}

/** 强制整篇加载（大文件只读模式 → 可编辑模式） */
export async function loadFull(id: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const d = docs.get(id)
  if (!d) return { ok: false, error: '文档已关闭' }
  if (d.mode === 'full') {
    return { ok: false, error: '该文档已是完整模式' }
  }
  if (!d.buf) return { ok: false, error: '文档缓冲区不可用' }
  try {
    const text = await decodeAsync(d.buf, d.encoding)
    d.mode = 'full'
    d.lineCount = countLines(text)
    d.buf = undefined
    d.offsets = undefined
    return { ok: true, text }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export async function closeDoc(id: string): Promise<{ ok: boolean }> {
  docs.delete(id)
  return { ok: true }
}

export async function statDocs(ids: string[]): Promise<Record<string, { mtimeMs: number; size: number; exists: boolean }>> {
  const out: Record<string, { mtimeMs: number; size: number; exists: boolean }> = {}
  for (const id of ids) {
    const d = docs.get(id)
    if (!d?.path) continue
    try {
      const st = await fsp.stat(d.path)
      out[id] = { mtimeMs: st.mtimeMs, size: st.size, exists: true }
    } catch {
      out[id] = { mtimeMs: 0, size: 0, exists: false }
    }
  }
  return out
}

// ---------------- 保存 ----------------

export async function saveDoc(p: {
  id: string
  text: string
  path?: string | null
  encoding?: EncodingId
  eol?: EolId
  markRecentLine?: { line: number; col: number }
}): Promise<{ ok: boolean; doc?: EditorDocMeta; error?: string; conflict?: boolean }> {
  const d = docs.get(p.id)
  if (!d) return { ok: false, error: '文档已关闭' }
  const target = p.path || d.path
  if (!target) return { ok: false, error: '尚未指定保存路径' }
  try {
    // 保存前确认磁盘上还是「我打开时那一份」：同事/发布脚本改过就提示，不能静默覆盖
    if (!p.path && d.mtimeMs > 0) {
      try {
        const cur = await fsp.stat(target)
        if (Math.abs(cur.mtimeMs - d.mtimeMs) > 1) {
          const win = BrowserWindow.getFocusedWindow()
          const choice = win
            ? dialog.showMessageBoxSync(win, {
                type: 'warning',
                title: '文件已在外部修改',
                message: `${path.basename(target)} 已被其他程序修改。`,
                detail: '继续保存会用编辑器里的内容覆盖磁盘上的新内容。',
                buttons: ['仍然覆盖', '取消保存'],
                defaultId: 1,
                cancelId: 1,
                noLink: true
              })
            : 1
          if (choice !== 0) {
            return { ok: false, conflict: true, error: '文件已被外部修改，已取消保存（关闭后重新打开可载入最新内容）' }
          }
        }
      } catch {
        /* stat 失败 = 文件已被删除，按新建写入 */
      }
    }
    const enc = p.encoding || d.encoding
    const eol = p.eol || d.eol
    // 统一换行后再编码：内核里的 text 一律使用 \n
    const text = eol === 'LF' ? p.text : p.text.replace(/\n/g, eol === 'CRLF' ? '\r\n' : '\r')
    const buf = encode(text, enc)
    await writeBufferAtomic(target, buf)
    const st = await fsp.stat(target)
    d.path = target
    d.name = path.basename(target)
    d.size = buf.length
    d.mtimeMs = st.mtimeMs
    d.encoding = enc
    d.eol = eol
    if (d.mode === 'full') d.lineCount = countLines(p.text)
    pushRecent(target, p.markRecentLine?.line, p.markRecentLine?.col)
    return { ok: true, doc: makeMeta(d) }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function writeBufferAtomic(file: string, data: Buffer): Promise<void> {
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  let fh: fsp.FileHandle | null = null
  try {
    fh = await fsp.open(tmp, 'w')
    await fh.writeFile(data)
    try { await fh.sync() } catch { /* 某些文件系统不支持 */ }
    await fh.close()
    fh = null
    await fsp.rename(tmp, file)
  } catch (e) {
    if (fh) { try { await fh.close() } catch { /* 忽略 */ } }
    try { await fsp.unlink(tmp) } catch { /* 忽略 */ }
    throw e
  }
}

export async function saveAsDialog(id: string, suggested?: string): Promise<{ ok: boolean; canceled?: boolean; path?: string }> {
  const d = docs.get(id)
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const r = await dialog.showSaveDialog(win, {
    title: '另存为',
    defaultPath: suggested || d?.path || d?.name || 'untitled.txt',
    filters: [{ name: '全部文件', extensions: ['*'] }]
  })
  if (r.canceled || !r.filePath) return { ok: true, canceled: true }
  return { ok: true, path: r.filePath }
}

/** 新建空白文档（不落盘） */
export function newDoc(name = '未命名', encoding: EncodingId = 'utf8', eol: EolId = 'CRLF'): EditorDocMeta {
  const d: DocEntry = {
    id: newId(), path: null, name, size: 0, mtimeMs: Date.now(),
    encoding, eol, mode: 'full', lineCount: 1, bomLen: 0
  }
  docs.set(d.id, d)
  return { ...makeMeta(d), text: '' }
}

/** 列给 AI 选文件时跳过的目录：体积大、与「问这段代码」无关 */
const AI_LIST_SKIP = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'release', 'target',
  '.idea', '.vscode', '.vs', '__pycache__', '.venv', 'venv', 'env', 'vendor',
  '.next', '.nuxt', '.cache', 'coverage', '.gradle', '.mvn', 'bin', 'obj'
])
/** 一次最多列这么多文件：工作区再大也不至于把选择器拖死 */
const AI_LIST_MAX = 1500
const AI_LIST_MAX_DEPTH = 8

export interface AiFileEntry {
  path: string
  name: string
  /** 相对工作区根的路径（显示用，统一用 /） */
  rel: string
  size: number
}

/**
 * 列工作区里的文件（递归），给「选择文件问 AI」用。
 * 只读目录信息，不读内容；跳过 node_modules / .git 这类目录与隐藏目录。
 */
export async function listFilesForAi(
  dir: string
): Promise<{ ok: boolean; root?: string; files?: AiFileEntry[]; truncated?: boolean; error?: string }> {
  try {
    const st = await fsp.stat(dir)
    if (!st.isDirectory()) return { ok: false, error: '不是文件夹：' + dir }
    const out: AiFileEntry[] = []
    const walk = async (cur: string, depth: number): Promise<void> => {
      if (out.length >= AI_LIST_MAX || depth > AI_LIST_MAX_DEPTH) return
      let items: import('node:fs').Dirent[]
      try {
        items = await fsp.readdir(cur, { withFileTypes: true })
      } catch {
        return
      }
      items.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
      })
      for (const it of items) {
        if (out.length >= AI_LIST_MAX) return
        // 符号链接不跟：既避免绕圈，也避免列出工作区外的文件
        if (it.isSymbolicLink()) continue
        const full = path.join(cur, it.name)
        if (it.isDirectory()) {
          if (AI_LIST_SKIP.has(it.name.toLowerCase())) continue
          if (it.name.startsWith('.')) continue
          await walk(full, depth + 1)
          continue
        }
        if (!it.isFile()) continue
        let size = 0
        try {
          size = (await fsp.stat(full)).size
        } catch {
          continue
        }
        out.push({ path: full, name: it.name, rel: path.relative(dir, full).split(path.sep).join('/'), size })
      }
    }
    await walk(dir, 0)
    return { ok: true, root: dir, files: out, truncated: out.length >= AI_LIST_MAX }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 单个文件读给 AI 的上限：超过就直接建议「打开后选中一部分再问」 */
const AI_READ_MAX_BYTES = 4 * 1024 * 1024

/**
 * 只读一段文本给 AI 用：不建文档、不进「最近打开」、不改编辑器状态。
 * 超过 maxLines 行 / maxChars 字符就截断，返回 truncated 让界面如实标注。
 */
export async function readTextForAi(
  file: string,
  maxChars = 12000,
  maxLines = 800
): Promise<{ ok: boolean; text?: string; name?: string; lineCount?: number; truncated?: boolean; error?: string }> {
  try {
    const st = await fsp.stat(file)
    if (!st.isFile()) return { ok: false, error: '不是文件：' + file }
    if (st.size > AI_READ_MAX_BYTES) {
      return { ok: false, error: `文件过大（${(st.size / 1024 / 1024).toFixed(1)} MB）：请在编辑器里打开后选中一段再问` }
    }
    const raw = await fsp.readFile(file)
    const encoding = detectEncoding(raw)
    const body = stripBom(raw, encoding).buf
    const text = await decodeAsync(body, encoding)
    const all = text.split('\n')
    let out = text
    let lineCount = all.length
    let truncated = false
    if (lineCount > maxLines) {
      out = all.slice(0, maxLines).join('\n')
      lineCount = maxLines
      truncated = true
    }
    if (out.length > maxChars) {
      out = out.slice(0, maxChars)
      truncated = true
    }
    return { ok: true, text: out, name: path.basename(file), lineCount, truncated }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export async function reopen(id: string, encoding?: EncodingId): Promise<{ ok: boolean; doc?: EditorDocMeta; error?: string }> {
  const d = docs.get(id)
  if (!d?.path) return { ok: false, error: '文档没有磁盘路径' }
  const r = await openPath(d.path, encoding)
  if (!r.ok || !r.doc) return { ok: false, error: r.error }
  const created = docs.get(r.doc.id)
  if (!created) return { ok: false, error: '重新打开失败' }
  docs.delete(r.doc.id)
  created.id = id
  docs.set(id, created)
  return { ok: true, doc: { ...makeMeta(created), text: r.doc.text } }
}

// ---------------- 查找（窗口模式 / 文件夹） ----------------

export interface FindOpts {
  matchCase?: boolean
  wholeWord?: boolean
  regex?: boolean
  /** 从该行开始（含） */
  fromLine?: number
  limit?: number
  /** 反向查找 */
  backward?: boolean
  maxLineLen?: number
  /** 扫描行数上限（统计命中数时避免为了一个不存在的内容扫完几个 GB） */
  maxScanLines?: number
}

interface Matcher {
  test(line: string): { start: number; end: number } | null
}

function compileMatcher(query: string, opts: FindOpts): Matcher | { error: string } {
  if (!query) return { error: '查找内容为空' }
  if (opts.regex) {
    let re: RegExp
    try {
      re = new RegExp(query, opts.matchCase ? 'g' : 'gi')
    } catch (e: any) {
      return { error: '正则表达式无效：' + (e?.message || e) }
    }
    return {
      test(line: string) {
        re.lastIndex = 0
        const m = re.exec(line)
        return m ? { start: m.index, end: m.index + m[0].length } : null
      }
    }
  }
  const needle = opts.matchCase ? query : query.toLowerCase()
  const isWord = (ch: string | undefined) => !!ch && /[A-Za-z0-9_\u4e00-\u9fff]/.test(ch)
  return {
    test(line: string) {
      const hay = opts.matchCase ? line : line.toLowerCase()
      let from = 0
      while (true) {
        const i = hay.indexOf(needle, from)
        if (i < 0) return null
        if (!opts.wholeWord || (!isWord(hay[i - 1]) && !isWord(hay[i + needle.length]))) {
          return { start: i, end: i + needle.length }
        }
        from = i + 1
      }
    }
  }
}

/** 窗口模式查找：主进程按块解码扫描，返回命中行（含该行文本，便于结果面板展示） */
export async function findInDoc(id: string, query: string, opts: FindOpts = {}): Promise<{ ok: boolean; hits?: { line: number; start: number; end: number; text: string }[]; total?: number; error?: string }> {
  const d = docs.get(id)
  if (!d) return { ok: false, error: '文档已关闭' }
  if (d.mode !== 'window') return { ok: false, error: '完整模式请在渲染层查找' }
  const m = compileMatcher(query, opts)
  if ('error' in m) return { ok: false, error: m.error }
  const limit = Math.max(1, Math.min(2000, opts.limit || 500))
  const hits: { line: number; start: number; end: number; text: string }[] = []
  const total = d.lineCount
  const step = 4000
  const maxScan = opts.maxScanLines && opts.maxScanLines > 0 ? Math.min(total, opts.maxScanLines) : total
  let scanned = 0
  if (opts.backward) {
    for (let end = Math.min(total, (opts.fromLine ?? total - 1) + 1); end > 0; end -= step) {
      const start = Math.max(0, end - step)
      const w = getWindow(id, start, end - start)
      if (!w.ok || !w.lines) break
      for (let i = w.lines.length - 1; i >= 0; i--) {
        const lineNo = start + i
        const mm = m.test(w.lines[i])
        if (mm) {
          hits.push({ line: lineNo, start: mm.start, end: mm.end, text: w.lines[i].slice(0, 400) })
          if (hits.length >= limit) return { ok: true, hits: hits.reverse(), total }
        }
      }
      scanned += w.lines.length
      if (scanned >= maxScan) break
      await new Promise((r) => setImmediate(r))
    }
    return { ok: true, hits: hits.reverse(), total }
  }
  for (let start = Math.max(0, opts.fromLine || 0); start < total && start < maxScan; start += step) {
    const w = getWindow(id, start, step)
    if (!w.ok || !w.lines) break
    for (let i = 0; i < w.lines.length; i++) {
      const mm = m.test(w.lines[i])
      if (mm) {
        hits.push({ line: start + i, start: mm.start, end: mm.end, text: w.lines[i].slice(0, 400) })
        if (hits.length >= limit) return { ok: true, hits, total }
      }
    }
    await new Promise((r) => setImmediate(r))
  }
  return { ok: true, hits, total }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'release', '.idea', '.vscode', '__pycache__', '.next', 'target', 'out'])

/** 在文件夹中查找：递归遍历文本文件（跳过二进制/超大文件），返回命中与统计 */
export async function findInFiles(p: {
  dir: string
  query: string
  opts?: FindOpts & { filePattern?: string; maxFiles?: number; maxHits?: number; includeSubdirs?: boolean }
}): Promise<{ ok: boolean; hits?: { file: string; rel: string; line: number; col: number; text: string }[]; files?: number; truncated?: boolean; error?: string }> {
  const m = compileMatcher(p.query, p.opts || {})
  if ('error' in m) return { ok: false, error: m.error }
  const maxHits = Math.min(5000, p.opts?.maxHits || 1000)
  const maxFiles = Math.min(5000, p.opts?.maxFiles || 800)
  const pattern = (p.opts?.filePattern || '').trim()
  let extRe: RegExp | null = null
  if (pattern && pattern !== '*.*' && pattern !== '*') {
    const alts = pattern.split(/[;,\s]+/).filter(Boolean).map((s) => s.replace(/^\*\.?/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    if (alts.length) extRe = new RegExp('\\.(' + alts.join('|') + ')$', 'i')
  }
  const hits: { file: string; rel: string; line: number; col: number; text: string }[] = []
  let files = 0
  let truncated = false
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (hits.length >= maxHits || files >= maxFiles) { truncated = true; return }
    let entries: fs.Dirent[]
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (hits.length >= maxHits || files >= maxFiles) { truncated = true; return }
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
        if (p.opts?.includeSubdirs === false && depth > 0) continue
        await walk(full, depth + 1)
      } else if (e.isFile()) {
        if (extRe && !extRe.test(e.name)) continue
        let st: fs.Stats
        try { st = await fsp.stat(full) } catch { continue }
        if (st.size > 12 * 1024 * 1024) continue
        let buf: Buffer
        try { buf = await fsp.readFile(full) } catch { continue }
        if (buf.subarray(0, Math.min(buf.length, 4096)).includes(0)) continue // 二进制
        const enc = detectEncoding(buf)
        const text = decode(stripBom(buf, enc).buf, enc)
        files++
        const lines = text.split(/\r\n|\n|\r/)
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i] || lines[i].length > 20000) continue
          const mm = m.test(lines[i])
          if (mm) {
            hits.push({ file: full, rel: path.relative(p.dir, full), line: i + 1, col: mm.start + 1, text: lines[i].trim().slice(0, 300) })
            if (hits.length >= maxHits) { truncated = true; return }
          }
        }
      }
    }
  }
  try {
    await walk(p.dir, 0)
    return { ok: true, hits, files, truncated }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}
