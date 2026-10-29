/**
 * 直连模式的操作任务日志（本地文本存档）。
 *
 * 为什么单独存：OCP 有任务子系统可以查历史；直连只是一串 DDL，
 * 执行完就没了。这里把每次写操作落成一行 JSON（JSONL），既能查看详情，
 * 也方便用户直接拿文本去排查。
 *
 * 存放位置由主进程在启动时通过 configureTaskLog() 指到 userData 目录，
 * 本模块不依赖 electron，方便单测。
 */

import fs from 'node:fs'
import path from 'node:path'

export interface TaskRecord {
  id: string
  /** 毫秒时间戳 */
  at: number
  platformId: string
  platformName: string
  clusterName: string
  /** 动作名：CREATE TENANT / DROP TENANT / LOCK TENANT / CREATE RESOURCE UNIT … */
  action: string
  /** 操作对象：租户名 / 池名 / 规格名 / 库名 / 账号 */
  target: string
  ok: boolean
  message: string
  /** 实际执行的语句（失败时也能看到断在哪一条） */
  steps: string[]
  durationMs: number
}

let baseDir = ''

/** 由主进程调用：把日志目录指到 userData 下 */
export function configureTaskLog(dir: string): void {
  baseDir = dir
}

export function taskLogPath(): string {
  return path.join(baseDir || process.cwd(), 'direct-task-log.jsonl')
}

/** 追加一条任务记录（失败不抛：日志写不进去不能影响主流程） */
export function appendTask(rec: TaskRecord): void {
  try {
    fs.mkdirSync(path.dirname(taskLogPath()), { recursive: true })
    fs.appendFileSync(taskLogPath(), `${JSON.stringify(rec)}\n`, 'utf8')
  } catch {
    // 磁盘满 / 权限不足时静默，避免把业务操作带崩
  }
}

/** 读全部记录（倒序：最新在前）；坏行直接跳过，不让一行烂数据毁掉整个列表 */
function readAll(): TaskRecord[] {
  try {
    const raw = fs.readFileSync(taskLogPath(), 'utf8')
    const out: TaskRecord[] = []
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const r = JSON.parse(s) as TaskRecord
        if (r && r.id) out.push(r)
      } catch {
        // 跳过损坏行
      }
    }
    out.sort((a, b) => b.at - a.at)
    return out
  } catch {
    return []
  }
}

export interface TaskQuery {
  page?: number
  size?: number
  keyword?: string
  action?: string
  /** '' 全部 / 'ok' 成功 / 'fail' 失败 */
  status?: string
}

export function listTasks(q: TaskQuery = {}): { items: TaskRecord[]; total: number; page: number; size: number } {
  const page = Math.max(1, Math.trunc(Number(q.page) || 1))
  const size = Math.max(1, Math.min(200, Math.trunc(Number(q.size) || 20)))
  const kw = String(q.keyword || '').trim().toLowerCase()
  const action = String(q.action || '').trim()
  const status = String(q.status || '').trim()

  let rows = readAll()
  if (kw) {
    rows = rows.filter((r) =>
      `${r.action} ${r.target} ${r.message} ${r.clusterName} ${r.platformName}`.toLowerCase().includes(kw)
    )
  }
  if (action) rows = rows.filter((r) => r.action === action)
  if (status === 'ok') rows = rows.filter((r) => r.ok)
  else if (status === 'fail') rows = rows.filter((r) => !r.ok)

  const total = rows.length
  const start = (page - 1) * size
  return { items: rows.slice(start, start + size), total, page, size }
}

export function getTask(id: string): TaskRecord | null {
  if (!id) return null
  return readAll().find((r) => r.id === id) || null
}

/** 任务动作清单（界面筛选用） */
export function taskActions(): string[] {
  return [...new Set(readAll().map((r) => r.action))].sort()
}

export interface ClearTasksOptions {
  /** 只清理该时间点（毫秒时间戳）之前的记录；不传或传 0 表示整份清理 */
  before?: number
}

/**
 * 清理任务日志。
 *
 * 两种粒度：
 *   不传 before —— 直接删掉整份文件（最快，也最彻底）；
 *   传 before   —— 只删早期记录，剩余记录按时间正序重写回文件。
 * 重写而不是跳过删除，是因为 JSONL 只能整份替换；写入失败时保持原文件不动并返回 removed:0。
 */
export function clearTasks(opts: ClearTasksOptions = {}): { removed: number; kept: number } {
  const before = Number(opts.before) || 0
  const all = readAll()

  if (!before) {
    try {
      fs.rmSync(taskLogPath(), { force: true })
    } catch {
      // 删不掉就返回 0，界面提示重试
      return { removed: 0, kept: all.length }
    }
    return { removed: all.length, kept: 0 }
  }

  const kept = all.filter((r) => r.at >= before)
  const removed = all.length - kept.length
  if (!removed) return { removed: 0, kept: kept.length }

  try {
    const body = kept
      .slice()
      .sort((a, b) => a.at - b.at)
      .map((r) => `${JSON.stringify(r)}\n`)
      .join('')
    fs.writeFileSync(taskLogPath(), body, 'utf8')
  } catch {
    // 写失败意味着一条都没删掉，如实回报，避免界面显示"已清理"但文件没变
    return { removed: 0, kept: all.length }
  }
  return { removed, kept: kept.length }
}
