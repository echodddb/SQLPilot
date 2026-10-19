import fs from 'node:fs'
import path from 'node:path'

/** 原子写：先写临时文件再 rename，进程中断不会留下截断的半份文件（Windows 下 rename 覆盖已有文件）。
 * 写入后 fsync：writeFileSync 返回不代表数据已落盘，断电后 rename 成功也可能读到 0 字节。 */
export function writeFileAtomic(file: string, data: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  let fd: number | null = null
  try {
    fd = fs.openSync(tmp, 'w')
    fs.writeFileSync(fd, data, 'utf8')
    try { fs.fsyncSync(fd) } catch { /* 部分文件系统不支持，忽略 */ }
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
  } catch (e) {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* 忽略 */ }
    }
    // 失败时清理临时文件，避免反复保存后堆积
    try { fs.unlinkSync(tmp) } catch { /* 可能已 rename 或从未创建 */ }
    throw e
  }
}
