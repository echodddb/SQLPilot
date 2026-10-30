/**
 * 直连模式的操作任务日志（本地文本存档）。
 *
 * 为什么单独存：OCP 有任务子系统可以查历史；直连只是一串 DDL，
 * 执行完就没了。这里把每次写操作落成一行 JSON（JSONL），既能查看详情，
 * 也方便用户直接拿文本去排查。
 *
 * 任务化之后多了「执行中」这一段：删除租户这类 DDL 可能跑很久，界面提交后应该
 * 立刻可以关掉，回头到任务页看结果。所以一条任务会有两次落盘：
 *   1) 提交时写 status='running'；
 *   2) 结束时再写一条同 id 的终态记录（ok / fail）。
 * 文件本身保持 append-only（不改写历史行），读取时按 id 取最后一条——
 * 这样即使进程在两次写入之间被杀，也还能看到「执行中」，而不是整条记录消失。
 *
 * 存放位置由主进程在启动时通过 configureTaskLog() 指到 userData 目录，
 * 本模块不依赖 electron，方便单测。
 */

import fs from 'node:fs'
import path from 'node:path'

export type TaskStatus = 'running' | 'ok' | 'fail'

export interface TaskRecord {
  id: string
  /** 毫秒时间戳（提交时间） */
  at: number
  /** 结束时间；running 时为空 */
  finishedAt?: number
  platformId: string
  platformName: string
  clusterName: string
  /** 动作名：CREATE TENANT / DROP TENANT / LOCK TENANT / CREATE RESOURCE UNIT … */
  action: string
  /** 操作对象：租户名 / 池名 / 规格名 / 库名 / 账号 */
  target: string
  /** 统一状态：running / ok / fail（旧记录只有 ok 布尔，读取时自动兼容） */
  status: TaskStatus
  /** 兼容字段：旧记录只有 ok。新记录与 status 保持一致 */
  ok: boolean
  message: string
  /** 实际执行的语句（失败时也能看到断在哪一条） */
  steps: string[]
  durationMs: number
}

/** 磁盘上的原始行可能没有 status（旧版本写的），统一补齐 */
function normalize(raw: any): TaskRecord | null {
  if (!raw || !raw.id || typeof raw.at !== 'number') return null
  const ok = !!raw.ok
  const status: TaskStatus =
    raw.status === 'running' || raw.status === 'ok' || raw.status === 'fail'
      ? raw.status
      : ok
        ? 'ok'
        : 'fail'
  return {
    id: String(raw.id),
    at: raw.at,
    finishedAt: typeof raw.finishedAt === 'number' ? raw.finishedAt : undefined,
    platformId: String(raw.platformId || ''),
    platformName: String(raw.platformName || ''),
    clusterName: String(raw.clusterName || ''),
    action: String(raw.action || ''),
    target: String(raw.target || ''),
    status,
    ok,
    message: String(raw.message || ''),
    steps: Array.isArray(raw.steps) ? raw.steps.map((s: any) => String(s)) : [],
    durationMs: Number(raw.durationMs) || 0
  }
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

/**
 * 更新一条任务（同 id 再追加一条终态记录）。
 * 读取时按 id 取最后一条，所以这里不需要重写整个文件。
 */
export function finishTask(
  id: string,
  patch: { status: 'ok' | 'fail'; message: string; steps?: string[]; finishedAt?: number; durationMs?: number }
): void {
  const cur = getTask(id)
  if (!cur) return
  const at = patch.finishedAt || Date.now()
  appendTask({
    ...cur,
    status: patch.status,
    ok: patch.status === 'ok',
    message: patch.message,
    steps: patch.steps && patch.steps.length ? patch.steps : cur.steps,
    finishedAt: at,
    durationMs: patch.durationMs ?? Math.max(0, at - cur.at)
  })
}

/** 读全部记录（倒序：最新在前）；坏行直接跳过，不让一行烂数据毁掉整个列表 */
function readAll(): TaskRecord[] {
  try {
    const raw = fs.readFileSync(taskLogPath(), 'utf8')
    // 同 id 多次写入时后写的覆盖先写的（append-only + 读时合并）
    const byId = new Map<string, TaskRecord>()
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const rec = normalize(JSON.parse(s))
        if (rec) byId.set(rec.id, rec)
      } catch {
        // 跳过损坏行
      }
    }
    return [...byId.values()].sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}

export interface TaskStats {
  total: number
  running: number
  ok: number
  fail: number
}

/** 状态计数（任务页顶部胶囊用），不随筛选变化 */
export function taskStats(): TaskStats {
  const all = readAll()
  return {
    total: all.length,
    running: all.filter((r) => r.status === 'running').length,
    ok: all.filter((r) => r.status === 'ok').length,
    fail: all.filter((r) => r.status === 'fail').length
  }
}

export interface TaskQuery {
  page?: number
  size?: number
  keyword?: string
  action?: string
  /** '' 全部 / 'ok' 成功 / 'fail' 失败 / 'running' 执行中 */
  status?: string
  /** 集群名（直连模式下等于平台名） */
  cluster?: string
  /** 只看该时间点之后的记录（毫秒） */
  since?: number
}

export function listTasks(q: TaskQuery = {}): {
  items: TaskRecord[]
  total: number
  page: number
  size: number
  stats: TaskStats
  clusters: string[]
} {
  const page = Math.max(1, Math.trunc(Number(q.page) || 1))
  const size = Math.max(1, Math.min(200, Math.trunc(Number(q.size) || 20)))
  const kw = String(q.keyword || '').trim().toLowerCase()
  const action = String(q.action || '').trim()
  const status = String(q.status || '').trim()
  const cluster = String(q.cluster || '').trim()
  const since = Number(q.since) || 0

  const all = readAll()
  const clusters = [...new Set(all.map((r) => r.clusterName).filter(Boolean))].sort()

  let rows = all
  if (since > 0) rows = rows.filter((r) => r.at >= since)
  if (kw) {
    rows = rows.filter((r) =>
      `${r.action} ${r.target} ${r.message} ${r.clusterName} ${r.platformName} ${r.id}`.toLowerCase().includes(kw)
    )
  }
  if (action) rows = rows.filter((r) => r.action === action)
  if (cluster) rows = rows.filter((r) => r.clusterName === cluster)
  if (status === 'ok' || status === 'fail' || status === 'running') {
    rows = rows.filter((r) => r.status === status)
  }

  const total = rows.length
  const start = (page - 1) * size
  return { items: rows.slice(start, start + size), total, page, size, stats: taskStats(), clusters }
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
