import { srv, flash } from './state'
import { fmtBytes } from './prefs'

/**
 * 传输任务发起层：SFTP 面板与「拖文件到终端」共用。
 *
 * 之前上传逻辑只写在 ServerSftpPane 里，终端区域无法复用；抽出来之后
 * 两处入口的队列项、审计、状态提示完全一致。
 */

export function newJobId(kind: 'up' | 'down'): string {
  return `${kind}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** 入队一条初始记录（主进程的进度事件会就地更新它） */
export function enqueueTransfer(kind: 'upload' | 'download', jobId: string, name: string, fileCount: number): void {
  srv.transfers.push({
    id: jobId,
    kind,
    name,
    index: 0,
    fileCount: Math.max(1, fileCount),
    transferred: 0,
    fileSize: 0,
    status: 'running',
    startedAt: Date.now()
  })
}

export interface TransferResult {
  ok: boolean
  files?: number
  bytes?: number
  dir?: string
  error?: string
}

/** 上传本地文件/目录到远端目录 */
export async function startUpload(serverId: string, localPaths: string[], remoteDir: string): Promise<TransferResult> {
  const list = localPaths.filter(Boolean)
  if (!list.length) return { ok: false, error: '没有可上传的文件' }
  const jobId = newJobId('up')
  enqueueTransfer('upload', jobId, list[0].split(/[\\/]/).pop() || '', list.length)
  const r = await window.sqlpilot.sftpUploadPaths(serverId, list, remoteDir || '.', jobId)
  if (!r.ok) {
    srv.status = `上传失败：${r.error || '未知错误'}`
    return r
  }
  srv.status = `上传完成：${r.files} 个文件 / ${fmtBytes(r.bytes || 0)} → ${remoteDir}`
  flash(`已上传 ${r.files} 个文件`)
  return r
}

/** 下载远端条目到本地目录 */
export async function startDownload(serverId: string, remotePaths: string[], localDir: string): Promise<TransferResult> {
  const list = remotePaths.filter(Boolean)
  if (!list.length) return { ok: false, error: '没有可下载的文件' }
  const jobId = newJobId('down')
  enqueueTransfer('download', jobId, list[0].split('/').pop() || '', list.length)
  const r = await window.sqlpilot.sftpDownloadPaths(serverId, list, localDir, jobId)
  if (!r.ok) {
    srv.status = `下载失败：${r.error || '未知错误'}`
    return r
  }
  srv.status = `下载完成：${r.files} 个文件 / ${fmtBytes(r.bytes || 0)} → ${r.dir}`
  return r
}
