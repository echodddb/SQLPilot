import type { AppConfig, ServerGroup, SshServer } from './types'

/**
 * 服务器分组文件夹的纯逻辑。
 *
 * 分组是"名字即身份"：SshServer.group 存分组名，config.serverGroups 只负责保存文件夹的存在性
 * 与顺序（否则空文件夹会从侧栏消失，用户没法先建分组再往里拖机器）。改名要同时改两处，
 * 所以这段逻辑统一收在这里，IPC handler 只做参数校验 + loadConfig/saveConfig。
 *
 * 全部函数就地改传入的 cfg（主进程惯用法是 load→mutate→save），返回值只用来给界面报数。
 */

/** 内置兜底桶：没有分组的服务器归到这里。不是用户建的文件夹，不能改名/删除 */
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

type CfgLike = Pick<AppConfig, 'servers'> & { serverGroups?: ServerGroup[] }

/** 清单项可能是 { name } 也可能是手改 config.json 留下的裸字符串 */
const folderName = (g: unknown) => normalizeGroupName((g as any)?.name ?? g)

/** 文件夹清单（就地补齐成数组） */
export function foldersOf(cfg: CfgLike): ServerGroup[] {
  if (!Array.isArray(cfg.serverGroups)) cfg.serverGroups = []
  return cfg.serverGroups
}

/**
 * 已存在的分组名：文件夹清单在前（保持用户排序），服务器上引用但未登记的追加在后面。
 * 追加这段是给旧配置兜底的——分组信息最初只存在服务器对象上。
 */
export function groupNames(cfg: CfgLike): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const g of foldersOf(cfg)) {
    const n = folderName(g)
    if (!n || n === UNGROUPED || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  for (const s of cfg.servers || []) {
    const n = normalizeGroupName(s.group)
    if (!n || n === UNGROUPED || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

export function hasGroup(cfg: CfgLike, raw: unknown): boolean {
  const n = normalizeGroupName(raw)
  return !!n && n !== UNGROUPED && groupNames(cfg).includes(n)
}

/**
 * 登记一个文件夹（已存在则不动）。返回是否真的新增。
 * 只比对清单本身，不看服务器上的 group：server:save 是先把机器塞进 cfg.servers 再调这里，
 * 用 hasGroup 判断会把"刚写进去的那台机器的分组"当成已登记，文件夹永远进不了清单。
 */
export function ensureGroup(cfg: CfgLike, raw: unknown): boolean {
  const n = normalizeGroupName(raw)
  if (!n || n === UNGROUPED) return false
  if (foldersOf(cfg).some((g) => folderName(g) === n)) return false
  foldersOf(cfg).push({ name: n })
  dedupeFolders(cfg)
  return true
}

/** 改名：文件夹清单 + 所有引用该名字的服务器一起改。返回受影响的服务器数 */
export function renameGroup(cfg: CfgLike, rawFrom: unknown, rawTo: unknown): number {
  const from = normalizeGroupName(rawFrom)
  const to = normalizeGroupName(rawTo)
  if (!from || !to || from === to) return 0
  const folders = foldersOf(cfg)
  let hit = 0
  for (const g of folders) {
    if (folderName(g) === from) {
      g.name = to
      hit++
    }
  }
  // 文件夹清单里没有（旧配置只有服务器上有分组）也要登记新名字，否则改完就丢了
  if (!hit) ensureGroup(cfg, to)
  let moved = 0
  for (const s of cfg.servers || []) {
    if (normalizeGroupName(s.group) === from) {
      s.group = to
      moved++
    }
  }
  dedupeFolders(cfg)
  return moved
}

/** 删除文件夹：里面的服务器搬到 moveTo（空=变成未分组）。返回被搬动的服务器数 */
export function deleteGroup(cfg: CfgLike, rawName: unknown, rawMoveTo?: unknown): number {
  const name = normalizeGroupName(rawName)
  if (!name || name === UNGROUPED) return 0
  const moveTo = normalizeGroupName(rawMoveTo)
  if (moveTo && moveTo !== name) ensureGroup(cfg, moveTo)
  cfg.serverGroups = foldersOf(cfg).filter((g) => folderName(g) !== name)
  let moved = 0
  for (const s of cfg.servers || []) {
    if (normalizeGroupName(s.group) === name) {
      if (moveTo && moveTo !== UNGROUPED) s.group = moveTo
      else delete s.group
      moved++
    }
  }
  return moved
}

/** 把服务器移进分组（空串 = 移出分组）。返回实际变更的数量 */
export function moveServers(cfg: CfgLike, ids: string[], rawGroup: unknown): number {
  const group = normalizeGroupName(rawGroup)
  const want = new Set((ids || []).map((x) => String(x)))
  if (!want.size) return 0
  if (group && group !== UNGROUPED) ensureGroup(cfg, group)
  let moved = 0
  for (const s of cfg.servers || []) {
    if (!want.has(s.id)) continue
    if (group && group !== UNGROUPED) s.group = group
    else delete s.group
    moved++
  }
  return moved
}

/** 改名可能撞出重名（A→B 而 B 本来就存在时调用方已拦截，这里只兜底去重） */
function dedupeFolders(cfg: CfgLike): void {
  const seen = new Set<string>()
  cfg.serverGroups = foldersOf(cfg).filter((g) => {
    const n = folderName(g)
    if (!n || n === UNGROUPED || seen.has(n)) return false
    seen.add(n)
    return true
  })
}

/** 载入配置时整理：清掉非法/重复项，并把只在服务器上出现的分组补登记（旧配置迁移） */
export function normalizeServerGroups(cfg: CfgLike): void {
  const seen = new Set<string>()
  const out: ServerGroup[] = []
  for (const raw of foldersOf(cfg)) {
    const n = folderName(raw)
    if (!n || n === UNGROUPED || seen.has(n)) continue
    seen.add(n)
    out.push({ name: n })
  }
  for (const s of (cfg.servers || []) as SshServer[]) {
    const n = normalizeGroupName(s.group)
    if (!n) continue
    if (n === UNGROUPED) {
      delete s.group // 名字叫「未分组」= 等于没分组，落回兜底桶
      continue
    }
    if (seen.has(n)) {
      // 顺手把服务器上的脏名字（多余空白）对齐到清单里的写法
      if (s.group !== n) s.group = n
      continue
    }
    if (s.group !== n) s.group = n // 新登记的分组同样要对齐
    seen.add(n)
    out.push({ name: n })
  }
  cfg.serverGroups = out
}
