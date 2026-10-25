/**
 * 传输队列的纯逻辑（不依赖 Vue / store，可直接单测）。
 *
 * 字段语义必须分清，否则进度条会乱跳：
 * - index / fileCount：本批第几个文件、共几个
 * - transferred / fileSize：**当前这个文件**已传字节 / 总字节
 * 早期把"文件数"和"文件字节数"都塞进一个 total，两边互相覆盖，进度永远是 0——
 * 这就是"队列里有一条一直 0%"的根因。
 */

export interface TransferItem {
  id: string
  kind: 'upload' | 'download'
  name: string
  /** 当前文件索引（0 基） */
  index: number
  /** 本批总文件数 */
  fileCount: number
  /** 当前文件已传字节 */
  transferred: number
  /** 当前文件总字节 */
  fileSize: number
  status: 'running' | 'done' | 'error' | 'canceled'
  error?: string
  startedAt: number
}

/** 进度事件的最小形状（主进程 sftp:progress 的负载） */
export interface ProgressEvent {
  jobId: string
  kind?: 'upload' | 'download'
  phase: 'start' | 'progress' | 'done' | 'error' | 'canceled'
  index?: number
  fileCount?: number
  name?: string
  transferred?: number
  total?: number
  files?: number
  bytes?: number
  error?: string
}

/**
 * 把一条进度事件并入队列（就地修改并返回该条）。
 * 面板重挂载 / 队列被清空后，靠事件里的 kind 重新建条。
 */
export function applyProgress(list: TransferItem[], p: ProgressEvent, now = Date.now()): TransferItem {
  let t = list.find((x) => x.id === p.jobId)
  if (!t) {
    // 队列只增不减会长期吃掉内存（DBA 一天可能传几十个 dump）：
    // 新任务进来时顺手淘汰最早的已结束条目，保留最近 60 条
    if (list.length >= 60) {
      const finished = list.filter((x) => x.status !== 'running')
      for (const old of finished.slice(0, Math.max(1, list.length - 59))) {
        const i = list.indexOf(old)
        if (i >= 0) list.splice(i, 1)
      }
    }
    t = {
      id: p.jobId,
      kind: p.kind === 'download' ? 'download' : 'upload',
      name: p.name || '',
      index: p.index ?? 0,
      fileCount: Math.max(1, p.fileCount ?? 1),
      transferred: 0,
      fileSize: 0,
      status: 'running',
      startedAt: now
    }
    list.push(t)
  }
  if (p.name) t.name = p.name
  if (p.index !== undefined) t.index = p.index
  if (p.fileCount !== undefined) t.fileCount = Math.max(1, p.fileCount)
  if (p.total !== undefined) t.fileSize = p.total
  if (p.transferred !== undefined) t.transferred = p.transferred

  if (p.phase === 'start') {
    // 换文件：单文件进度重置（事件里已带 fileCount，不会丢总数）
    t.index = p.index ?? t.index
    t.transferred = 0
    t.fileSize = 0
    t.status = 'running'
  } else if (p.phase === 'done') {
    t.status = 'done'
    t.transferred = t.fileSize || t.transferred
  } else if (p.phase === 'error') {
    t.status = 'error'
    t.error = p.error || '未知错误'
  } else if (p.phase === 'canceled') {
    t.status = 'canceled'
  }
  return t
}

/** 整体进度（0-100）：已完成文件数 + 当前文件的小数部分 */
export function transferPercent(t: TransferItem): number {
  if (t.status === 'done') return 100
  const frac = t.fileSize > 0 ? Math.min(1, Math.max(0, t.transferred / t.fileSize)) : 0
  return Math.min(99, Math.round(((t.index + frac) / Math.max(1, t.fileCount)) * 100))
}

/** 队列里是否还有进行中的任务（状态栏/角标用） */
export function runningCount(list: TransferItem[]): number {
  return list.filter((t) => t.status === 'running').length
}
