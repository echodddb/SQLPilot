import { store } from './store'

/**
 * 分组文件夹的渲染侧工具（数据库连接 / SSH 服务器共用）。
 *
 * 主进程负责落盘与改名，这里只把「文件夹清单 + 记录上的 group」拼成可直接渲染的分桶列表。
 * 文件夹顺序跟配置走（= 用户创建顺序），空文件夹也保留；没有分组的记录进兜底桶「未分组」。
 */

export const UNGROUPED = '未分组'

export interface FolderBucket<T> {
  name: string
  items: T[]
  /** 兜底桶（没有分组的记录）：不是用户建的文件夹，不能改名/删除 */
  virtual?: boolean
}

/** 清单项可能是 { name }，也兼容手改 config.json 留下的裸字符串 */
function folderNameOf(raw: unknown): string {
  return String((raw as any)?.name ?? raw ?? '').trim()
}

function folderNames(folders: unknown, items: { group?: string }[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: unknown): void => {
    const n = folderNameOf(raw)
    if (!n || n === UNGROUPED || seen.has(n)) return
    seen.add(n)
    out.push(n)
  }
  for (const g of (folders as unknown[]) || []) push(g)
  for (const it of items) push(it?.group)
  return out
}

/** 数据库连接的分组文件夹顺序（connGroups 清单 + 连接上出现的分组） */
export function connGroupFolders(): string[] {
  return folderNames((store.cfg as any)?.connGroups, (store.cfg?.connections || []) as any[])
}

/** SSH 服务器的分组文件夹顺序（serverGroups 清单 + 服务器上出现的分组） */
export function serverGroupFolders(): string[] {
  return folderNames((store.cfg as any)?.serverGroups, (store.cfg?.servers || []) as any[])
}

/**
 * 按文件夹分桶。filter 为空时保留空文件夹（便于"先建组再放东西"），
 * 搜索/筛选时要传 filter，否则满屏空文件夹。
 */
export function bucketByFolder<T extends { group?: string }>(
  folders: string[],
  items: T[],
  opts: { sort?: (a: T, b: T) => number; keepEmpty?: boolean } = {}
): FolderBucket<T>[] {
  const bucket = new Map<string, T[]>()
  for (const it of items) {
    const g = String(it.group || '').trim() || UNGROUPED
    if (!bucket.has(g)) bucket.set(g, [])
    bucket.get(g)!.push(it)
  }
  const sort = opts.sort
  const out: FolderBucket<T>[] = folders.map((name) => ({
    name,
    items: (bucket.get(name) || []).slice().sort(sort)
  }))
  const visible = opts.keepEmpty === false ? out.filter((g) => g.items.length) : out
  const rest = bucket.get(UNGROUPED) || []
  if (rest.length) visible.push({ name: UNGROUPED, items: rest.slice().sort(sort), virtual: true })
  return visible
}
