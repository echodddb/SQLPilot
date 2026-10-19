import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { writeFileAtomic } from './atomic'

// 跨会话记忆（轻量版 agent memory）：三个维度——全局 MEMORY.md、按连接 conn/<名>.md、
// 按项目 project/<名>.md，存 userData/memory/。注入系统提示词时只取文件尾部（近期事实优先），
// agent 通过 memory_append 工具追加带日期的条目。

/** 单条记忆上限（字符）：超长截断，防一次写入撑爆后续所有会话的提示词 */
const MAX_ENTRY_CHARS = 500
/** 全局记忆注入上限（取文件尾部） */
const MAX_GLOBAL_INJECT = 3000
/** 单连接记忆注入上限 */
const MAX_CONN_INJECT = 1200
/** 单项目记忆注入上限：项目记忆承载任务背景（表约定/运维惯例），量级大于连接事实 */
const MAX_PROJECT_INJECT = 2400

export function memoryDir(): string {
  return path.join(app.getPath('userData'), 'memory')
}

function globalFile(): string {
  return path.join(memoryDir(), 'MEMORY.md')
}

/** Windows 文件名非法字符替换为下划线；名称即文件名，读取时按同名连接/项目寻址 */
function safeName(name: string): string {
  const raw = String(name ?? '')
  const clean = raw.replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 60) || '_'
  // 清洗/截断会碰撞（a:b 与 a/b、超长名截断）：附加原始名短哈希保证唯一，
  // 否则两个连接/项目共用一份记忆，A 库的运维事实会被注入 B 库会话
  if (clean !== raw || raw.length > 60) {
    return `${clean.slice(0, 48)}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)}`
  }
  return clean
}

/** 记忆归属：全局 / 某数据库连接 / 某项目 */
export type MemoryTarget = { kind: 'global' } | { kind: 'conn'; name: string } | { kind: 'project'; name: string }

function fileOf(target: MemoryTarget): string {
  if (!target || typeof target !== 'object') throw new Error('记忆归属无效')
  if (target.kind === 'global') return globalFile()
  // kind 是 TS 联合类型，运行时不生效：必须显式收口，防 `../../` 之类越出 memory 目录
  if (target.kind !== 'conn' && target.kind !== 'project') throw new Error(`非法记忆归属: ${String((target as any).kind)}`)
  const dir = path.join(memoryDir(), target.kind)
  const file = path.join(dir, `${safeName(target.name)}.md`)
  // 旧版文件名不带哈希：首次访问时迁移到新名，避免改名后旧记忆"消失"
  const legacyName = String(target.name ?? '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 60) || '_'
  const legacy = path.join(dir, `${legacyName}.md`)
  if (file !== legacy && !fs.existsSync(file) && fs.existsSync(legacy)) {
    try { fs.renameSync(legacy, file) } catch { /* 迁移失败仍用新名，旧文件保留 */ }
  }
  return file
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
  return tail(fileOf({ kind: 'project', name: project }), MAX_PROJECT_INJECT)
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

// ---------- 归档条目化（侧栏项目树内的归档区：列表/单条删除/清空） ----------

export interface ArchiveEntry {
  /** 归档时间（## 行原文，如 2026-10-11 09:30） */
  ts: string
  /** 会话标题 */
  title: string
  /** 总结正文 */
  summary: string
  /** 原始小节全文（删除时按内容校验，避免并发写导致错删） */
  raw: string
}

/** 解析归档文件为条目列表（倒序：最近的在前，与侧栏展示一致） */
export function listProjectArchiveEntries(project: string): ArchiveEntry[] {
  const full = readProjectArchiveFull(project)
  if (!full) return []
  const out: ArchiveEntry[] = []
  for (const part of full.split(/\n(?=## )/)) {
    const m = part.match(/^## (.+?) · (.+)$/m)
    if (!m) continue
    const summary = part.split(/\n/).slice(1).join('\n').trim()
    out.push({ ts: m[1], title: m[2].trim(), summary, raw: part.trim() })
  }
  return out.reverse()
}

/** 删除一条归档（按倒序 index + raw 内容校验；不一致时拒绝，防并发写错删） */
export function deleteProjectArchiveEntry(project: string, reverseIndex: number, rawCheck: string): boolean {
  const entries = listProjectArchiveEntries(project)
  const entry = entries[reverseIndex]
  if (!entry || entry.raw !== rawCheck) return false
  const remain = entries.filter((_, i) => i !== reverseIndex).reverse() // 恢复正序（旧→新）
  const file = archiveFile(project)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeFileAtomic(file, remain.length ? remain.map((e) => e.raw).join('\n\n') + '\n\n' : '')
  return true
}

/** 清空项目归档 */
export function clearProjectArchive(project: string): void {
  const file = archiveFile(project)
  try { writeFileAtomic(file, '') } catch { /* 无文件视为已空 */ }
}

/** LLM 增强总结完成后更新对应条目（按 ts+title 定位；找不到跳过） */
export function updateArchiveEntry(project: string, ts: string, title: string, newSummary: string): boolean {
  const entries = listProjectArchiveEntries(project)
  const hit = entries.find((e) => e.ts === ts && e.title === title)
  if (!hit) return false
  hit.summary = newSummary.trim()
  hit.raw = `## ${hit.ts} · ${hit.title}\n${hit.summary}`
  const file = archiveFile(project)
  writeFileAtomic(file, entries.slice().reverse().map((e) => e.raw).join('\n\n') + '\n\n')
  return true
}

/** 删除归档会话时清理对应 md 条目（best-effort：按 ts+title 定位，找不到跳过） */
export function deleteArchiveEntryByHead(project: string, ts: string, title: string): void {
  const entries = listProjectArchiveEntries(project)
  const idx = entries.findIndex((e) => e.ts === ts && e.title === title)
  if (idx < 0) return
  deleteProjectArchiveEntry(project, idx, entries[idx].raw)
}
