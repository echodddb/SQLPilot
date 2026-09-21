import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

// 跨会话记忆（轻量版 agent memory）：三个维度——全局 MEMORY.md、按连接 conn/<名>.md、
// 按项目 project/<名>.md，存 userData/memory/。注入系统提示词时只取文件尾部（近期事实优先），
// agent 通过 memory_append 工具追加带日期的条目。

/** 单条记忆上限（字符）：超长截断，防一次写入撑爆后续所有会话的提示词 */
const MAX_ENTRY_CHARS = 500
/** 全局记忆注入上限（取文件尾部） */
const MAX_GLOBAL_INJECT = 3000
/** 单连接记忆注入上限 */
const MAX_CONN_INJECT = 1200

export function memoryDir(): string {
  return path.join(app.getPath('userData'), 'memory')
}

function globalFile(): string {
  return path.join(memoryDir(), 'MEMORY.md')
}

/** Windows 文件名非法字符替换为下划线；名称即文件名，读取时按同名连接/项目寻址 */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 60) || '_'
}

/** 记忆归属：全局 / 某数据库连接 / 某项目 */
export type MemoryTarget = { kind: 'global' } | { kind: 'conn'; name: string } | { kind: 'project'; name: string }

function fileOf(target: MemoryTarget): string {
  if (target.kind === 'global') return globalFile()
  return path.join(memoryDir(), target.kind, `${safeName(target.name)}.md`)
}

/** 追加一条记忆；返回写入的文件（相对 userData）与当前条目总数 */
export function appendMemory(target: MemoryTarget, text: string): { file: string; entries: number } {
  const file = fileOf(target)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const oneLine = text.replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_CHARS)
  fs.appendFileSync(file, `- [${date}] ${oneLine}\n`, 'utf8')
  return { file: path.relative(app.getPath('userData'), file), entries: countEntries(file) }
}

function countEntries(file: string): number {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('- [')).length
  } catch {
    return 0
  }
}

/** 取文件尾部（近期事实优先），按字符数截断 */
function tail(file: string, maxChars: number): string | undefined {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8').trim()
  } catch {
    return undefined
  }
  if (!raw) return undefined
  if (raw.length <= maxChars) return raw
  const cut = raw.slice(-maxChars)
  const nl = cut.indexOf('\n')
  return nl >= 0 ? cut.slice(nl + 1) : cut
}

export function readGlobalMemory(): string | undefined {
  return tail(globalFile(), MAX_GLOBAL_INJECT)
}

export function readConnMemory(conn: string): string | undefined {
  return tail(fileOf({ kind: 'conn', name: conn }), MAX_CONN_INJECT)
}

export function readProjectMemory(project: string): string | undefined {
  return tail(fileOf({ kind: 'project', name: project }), MAX_CONN_INJECT)
}

// ---------- 会话归档：按项目一份，每条归档是"时间 · 会话标题 + 总结"小节 ----------

/** 归档注入上限（取文件尾部：最近的归档优先） */
const MAX_ARCHIVE_INJECT = 4000

function archiveFile(project: string): string {
  return path.join(memoryDir(), 'archive', `${safeName(project)}.md`)
}

/** 追加一条会话归档；返回写入文件（相对 userData） */
export function appendArchive(project: string, title: string, summary: string): string {
  const file = archiveFile(project)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const heading = title.replace(/\r?\n/g, ' ').trim().slice(0, 60) || '（未命名会话）'
  fs.appendFileSync(file, `## ${ts} · ${heading}\n${summary.trim()}\n\n`, 'utf8')
  return path.relative(app.getPath('userData'), file)
}

/** 读取项目归档尾部（注入该项目会话的系统提示词） */
export function readProjectArchive(project: string): string | undefined {
  return tail(archiveFile(project), MAX_ARCHIVE_INJECT)
}

/** 读取项目归档全文（查看弹窗用） */
export function readProjectArchiveFull(project: string): string | undefined {
  try {
    return fs.readFileSync(archiveFile(project), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}
