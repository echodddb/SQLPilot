import fs from 'node:fs'
import path from 'node:path'

/** 原子写：先写临时文件再 rename，进程中断不会留下截断的半份文件（Windows 下 rename 覆盖已有文件） */
export function writeFileAtomic(file: string, data: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, file)
}
