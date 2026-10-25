/**
 * 本地路径小工具（SFTP 左栏用）。
 *
 * 单独抽出来是因为"上一级"这种逻辑用正则在组件里写太容易出错：
 * 早期实现用 `lastIndexOf` 切父目录并加了 `if (i <= 2) return` 的守卫，
 * 结果 `C:\Users` 想再上一级到 `C:\` 时被守卫拦死——二级目录往上就卡住不动了。
 */

/** 盘符根：C: 或 C:\ 或 C:/ */
const DRIVE_ROOT = /^[a-zA-Z]:[\\/]?$/
/** UNC 根：\\server\share */
const UNC_ROOT = /^\\\\[^\\]+\\[^\\]+\\?$/

/** 取盘符（含反斜杠），拿不到时返回空串 */
export function driveOf(p: string): string {
  const m = String(p || '').match(/^([a-zA-Z]:)[\\/]?/)
  return m ? m[1].toUpperCase() + '\\' : ''
}

/**
 * 上一级目录。
 * 返回 null 表示已经在根（盘符根 / UNC 共享根 / POSIX 根），界面上应该禁用按钮。
 */
export function parentLocalPath(p: string): string | null {
  let s = String(p || '').trim()
  if (!s) return null
  // 去掉尾部多余分隔符，但保留根形态（C:\ 或 \\server\share\）
  const stripped = s.replace(/[\\/]+$/, '')
  if (!stripped) return null

  if (DRIVE_ROOT.test(s) || DRIVE_ROOT.test(stripped)) return null
  if (UNC_ROOT.test(s) || UNC_ROOT.test(stripped)) return null
  if (stripped === '/') return null

  const i = Math.max(stripped.lastIndexOf('\\'), stripped.lastIndexOf('/'))
  if (i < 0) return null

  const parent = stripped.slice(0, i)
  // C:\Users → C:  需要补成 C:\ 才能被 readdir 接受
  if (/^[a-zA-Z]:$/.test(parent)) return parent + '\\'
  if (!parent) return null
  return parent
}

/** 路径是否已经在根（用于禁用"上一级"按钮） */
export function atLocalRoot(p: string): boolean {
  return parentLocalPath(p) === null
}

/** 拼接本地路径（避免出现 C:\\a\\\\b 这种重复分隔符） */
export function joinLocal(dir: string, name: string): string {
  const d = String(dir || '').replace(/[\\/]+$/, '')
  return d ? `${d}\\${name}` : name
}
