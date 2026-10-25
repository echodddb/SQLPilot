/**
 * 产物（artifact）落盘：完整结果集不进模型上下文，只把 id 交给工具返回值，
 * 用户在右侧「产物」面板里按需读取。
 *
 * 为什么需要它：db_query 返回给模型的行数被裁到 30 行（PREVIEW_ROWS），
 * 但 DBA 真正要看的是全量结果——把全量塞进对话会直接烧掉上下文，
 * 所以这里单独存一份，面板打开时再取。
 *
 * 约束：只存表数据（JSON），单份 ≤ 24MB / 5 万行，总量按文件数（80）与 7 天 TTL 淘汰。
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic'

const MAX_ROWS = 50_000
const MAX_BYTES = 24 * 1024 * 1024
const MAX_FILES = 80
const TTL_MS = 7 * 24 * 3600 * 1000
const ID_RE = /^t_\d{10,16}_[a-z0-9]{6}$/

export interface TableArtifactData {
  kind: 'table'
  columns: string[]
  rows: any[][]
  /** 服务端返回的总行数（可能大于 rows.length，取决于查询上限） */
  rowCount: number
  ms?: number
  /** 结果被查询上限截断 */
  truncated?: boolean
  /** 来源连接名 */
  conn?: string
  /** 产生该结果的 SQL（面板里可展开查看） */
  sql?: string
  at: number
}

function dir(): string {
  return path.join(app.getPath('userData'), 'artifacts')
}

function fileOf(id: string): string {
  // id 只可能是本进程生成的形态：挡掉 ../ 之类的路径穿越
  if (!ID_RE.test(id)) throw new Error(`非法的产物标识: ${id}`)
  return path.join(dir(), `${id}.json`)
}

/** 淘汰：过期 + 超出保留数量的旧文件（按 mtime 从新到旧） */
function prune(): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json'))
  } catch {
    return
  }
  const now = Date.now()
  const kept: { name: string; mtime: number }[] = []
  for (const n of names) {
    const full = path.join(dir(), n)
    try {
      const st = fs.statSync(full)
      if (now - st.mtimeMs > TTL_MS) {
        fs.rmSync(full, { force: true })
        continue
      }
      kept.push({ name: n, mtime: st.mtimeMs })
    } catch {
      /* 单个文件读不到不影响其它 */
    }
  }
  if (kept.length <= MAX_FILES) return
  kept.sort((a, b) => b.mtime - a.mtime)
  for (const k of kept.slice(MAX_FILES)) {
    try { fs.rmSync(path.join(dir(), k.name), { force: true }) } catch { /* 忽略 */ }
  }
}

/**
 * 单元格归一化：JSON.stringify 对 Buffer/BigInt/Date 的处理结果是给机器看的
 * （Buffer 会被展开成 {"type":"Buffer","data":[…]}}，几 MB 的 BLOB 直接把文件撑爆），
 * 存之前先换成面板能直接显示的形式。
 */
function cellOut(v: any): any {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 23)
  if (Buffer.isBuffer(v)) return `<BLOB ${v.length} bytes>`
  if (ArrayBuffer.isView(v)) return `<BINARY ${(v as any).byteLength} bytes>`
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return v
}

/**
 * 存一份表数据，返回 id 与实际存下的行数。
 * 超限时按行截断（保留前 N 行）而不是整份丢弃——部分数据仍然比没有强。
 */
export function putTable(input: {
  columns: string[]
  rows: any[][]
  rowCount: number
  ms?: number
  truncated?: boolean
  conn?: string
  sql?: string
}): { id: string; rows: number } {
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  let rows = input.rows.map((r) => (Array.isArray(r) ? r.map(cellOut) : [cellOut(r)]))
  let dropped = 0
  if (rows.length > MAX_ROWS) {
    dropped = rows.length - MAX_ROWS
    rows = rows.slice(0, MAX_ROWS)
  }
  let data: TableArtifactData = {
    kind: 'table',
    columns: input.columns,
    rows,
    rowCount: input.rowCount,
    ms: input.ms,
    truncated: !!input.truncated || dropped > 0,
    conn: input.conn,
    sql: input.sql,
    at: Date.now()
  }
  let text = JSON.stringify(data)
  // 单行超长（BLOB/大 JSON 列）时继续减半，直到落进上限
  while (text.length > MAX_BYTES && data.rows.length > 0) {
    const keep = Math.max(1, Math.floor(data.rows.length / 2))
    data = { ...data, rows: data.rows.slice(0, keep), truncated: true }
    text = JSON.stringify(data)
  }
  writeFileAtomic(fileOf(id), text)
  prune()
  return { id, rows: data.rows.length }
}

export function getArtifact(id: string): { ok: boolean; data?: TableArtifactData; error?: string } {
  let file: string
  try {
    file = fileOf(id)
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(raw) as TableArtifactData
    return { ok: true, data }
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, error: '该产物已过期或被清理（重新执行查询即可）' }
    return { ok: false, error: `读取产物失败：${e?.message || e}` }
  }
}
