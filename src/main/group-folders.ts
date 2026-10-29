import type { GroupFolder } from './types'

/**
 * 分组文件夹的通用逻辑（服务器 SSH 会话、数据库连接共用一套）。
 *
 * 分组是"名字即身份"：每条记录上的 group 存分组名，配置里的 folders 清单只负责保存
 * 文件夹的存在性与顺序（否则空文件夹会立刻消失，用户没法先建分组再往里放东西）。
 * 改名要同时改两处，所以这段逻辑统一收在这里，IPC handler 只做参数校验 + loadConfig/saveConfig。
 *
 * 具体是哪一张集合、哪一份清单，由 GroupSpec 指定（见 server-groups.ts / conn-groups.ts）。
 * 全部函数就地改传入的 cfg（主进程惯用法是 load→mutate→save），返回值只用来给界面报数。
 */

/** 内置兜底桶：没有分组的记录归到这里。不是用户建的文件夹，不能改名/删除 */
export const UNGROUPED = '未分组'

const MAX_NAME = 40

/** 分组名清洗：去控制字符、首尾空白，内部连续空白折叠成一个空格 */
export function normalizeGroupName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_NAME)
}

/** 新建/改名前的合法性检查（空串合法=未分组，由调用方决定是否允许） */
export function validateGroupName(raw: unknown): { ok: boolean; name: string; error?: string } {
  const name = normalizeGroupName(raw)
  if (!name) return { ok: false, name, error: '分组名不能为空' }
  if (name === UNGROUPED) return { ok: false, name, error: `「${UNGROUPED}」是内置分组名，请换一个` }
  return { ok: true, name }
}

/** 一张集合（服务器/连接）对应哪份文件夹清单 */
export interface GroupSpec {
  /** 持有 group 字段的数组在配置里的键名，如 servers / connections */
  items: string
  /** 文件夹清单在配置里的键名，如 serverGroups / connGroups */
  folders: string
}

/** 清单项可能是 { name } 也可能是手改 config.json 留下的裸字符串 */
const folderName = (g: unknown): string => normalizeGroupName((g as any)?.name ?? g)

/** 分组文件夹清单（就地补齐成数组） */
export function foldersOf(cfg: any, spec: GroupSpec): GroupFolder[] {
  if (!Array.isArray(cfg[spec.folders])) cfg[spec.folders] = []
  return cfg[spec.folders] as GroupFolder[]
}

function itemsOf(cfg: any, spec: GroupSpec): any[] {
  return Array.isArray(cfg[spec.items]) ? cfg[spec.items] : []
}

/**
 * 已存在的分组名：文件夹清单在前（保持用户排序），记录上引用但未登记的追加在后面。
 * 追加这段是给旧配置兜底的——分组信息最初只存在记录对象上。
 */
export function groupNamesOf(cfg: any, spec: GroupSpec): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const g of foldersOf(cfg, spec)) {
    const n = folderName(g)
    if (!n || n === UNGROUPED || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  for (const item of itemsOf(cfg, spec)) {
    const n = normalizeGroupName(item?.group)
    if (!n || n === UNGROUPED || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

export function hasGroupOf(cfg: any, spec: GroupSpec, raw: unknown): boolean {
  const n = normalizeGroupName(raw)
  return !!n && n !== UNGROUPED && groupNamesOf(cfg, spec).includes(n)
}

/**
 * 登记一个文件夹（已存在则不动）。返回是否真的新增。
 * 只比对清单本身，不看记录上的 group：save 是先把记录塞进集合再调这里，
 * 用 hasGroupOf 判断会把"刚写进去那条记录的分组"当成已登记，文件夹永远进不了清单。
 */
export function ensureGroupOf(cfg: any, spec: GroupSpec, raw: unknown): boolean {
  const n = normalizeGroupName(raw)
  if (!n || n === UNGROUPED) return false
  if (foldersOf(cfg, spec).some((g) => folderName(g) === n)) return false
  foldersOf(cfg, spec).push({ name: n })
  dedupeFolders(cfg, spec)
  return true
}

/** 改名：文件夹清单 + 所有引用该名字的记录一起改。返回受影响的记录数 */
export function renameGroupOf(cfg: any, spec: GroupSpec, rawFrom: unknown, rawTo: unknown): number {
  const from = normalizeGroupName(rawFrom)
  const to = normalizeGroupName(rawTo)
  if (!from || !to || from === to) return 0
  let hit = 0
  for (const g of foldersOf(cfg, spec)) {
    if (folderName(g) === from) {
      g.name = to
      hit++
    }
  }
  // 文件夹清单里没有（旧配置只有记录上有分组）也要登记新名字，否则改完就丢了
  if (!hit) ensureGroupOf(cfg, spec, to)
  let moved = 0
  for (const item of itemsOf(cfg, spec)) {
    if (normalizeGroupName(item?.group) === from) {
      item.group = to
      moved++
    }
  }
  dedupeFolders(cfg, spec)
  return moved
}

/** 删除文件夹：里面的记录搬到 moveTo（空=变成未分组）。返回被搬动的记录数 */
export function deleteGroupOf(cfg: any, spec: GroupSpec, rawName: unknown, rawMoveTo?: unknown): number {
  const name = normalizeGroupName(rawName)
  if (!name || name === UNGROUPED) return 0
  const moveTo = normalizeGroupName(rawMoveTo)
  if (moveTo && moveTo !== name) ensureGroupOf(cfg, spec, moveTo)
  cfg[spec.folders] = foldersOf(cfg, spec).filter((g) => folderName(g) !== name)
  let moved = 0
  for (const item of itemsOf(cfg, spec)) {
    if (normalizeGroupName(item?.group) === name) {
      if (moveTo && moveTo !== UNGROUPED) item.group = moveTo
      else delete item.group
      moved++
    }
  }
  return moved
}

/** 把记录移进分组（空串 = 移出分组）。返回实际变更的数量 */
export function moveItemsOf(cfg: any, spec: GroupSpec, ids: string[], rawGroup: unknown): number {
  const group = normalizeGroupName(rawGroup)
  const want = new Set((ids || []).map((x) => String(x)))
  if (!want.size) return 0
  if (group && group !== UNGROUPED) ensureGroupOf(cfg, spec, group)
  let moved = 0
  for (const item of itemsOf(cfg, spec)) {
    if (!want.has(String(item?.id))) continue
    if (group && group !== UNGROUPED) item.group = group
    else delete item.group
    moved++
  }
  return moved
}

/** 改名可能撞出重名（A→B 而 B 本来就存在时调用方已拦截，这里只兜底去重） */
function dedupeFolders(cfg: any, spec: GroupSpec): void {
  const seen = new Set<string>()
  cfg[spec.folders] = foldersOf(cfg, spec).filter((g) => {
    const n = folderName(g)
    if (!n || n === UNGROUPED || seen.has(n)) return false
    seen.add(n)
    return true
  })
}

/** 载入配置时整理：清掉非法/重复项，并把只在记录上出现的分组补登记（旧配置迁移） */
export function normalizeFoldersOf(cfg: any, spec: GroupSpec): void {
  const seen = new Set<string>()
  const out: GroupFolder[] = []
  for (const raw of foldersOf(cfg, spec)) {
    const n = folderName(raw)
    if (!n || n === UNGROUPED || seen.has(n)) continue
    seen.add(n)
    out.push({ name: n })
  }
  for (const item of itemsOf(cfg, spec)) {
    const n = normalizeGroupName(item?.group)
    if (!n) continue
    if (n === UNGROUPED) {
      delete item.group // 名字叫「未分组」= 等于没分组，落回兜底桶
      continue
    }
    if (seen.has(n)) {
      // 顺手把记录上的脏名字（多余空白）对齐到清单里的写法
      if (item.group !== n) item.group = n
      continue
    }
    if (item.group !== n) item.group = n // 新登记的分组同样要对齐
    seen.add(n)
    out.push({ name: n })
  }
  cfg[spec.folders] = out
}
