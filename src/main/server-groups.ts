import type { AppConfig, ServerGroup } from './types'
import {
  UNGROUPED,
  normalizeGroupName,
  validateGroupName,
  foldersOf as foldersOfCfg,
  groupNamesOf,
  hasGroupOf,
  ensureGroupOf,
  renameGroupOf,
  deleteGroupOf,
  moveItemsOf,
  normalizeFoldersOf,
  type GroupSpec
} from './group-folders'

/**
 * 服务器分组：核心逻辑在 group-folders.ts（与数据库连接分组共用），
 * 这里只绑定"哪张集合、哪份清单"。
 *
 * 分组是"名字即身份"：SshServer.group 存分组名，config.serverGroups 只负责保存文件夹的存在性
 * 与顺序（否则空文件夹会从侧栏消失，用户没法先建分组再往里拖机器）。
 */

export { UNGROUPED, normalizeGroupName, validateGroupName }

const SPEC: GroupSpec = { items: 'servers', folders: 'serverGroups' }

type CfgLike = Pick<AppConfig, 'servers'> & { serverGroups?: ServerGroup[] }

/** 文件夹清单（就地补齐成数组） */
export function foldersOf(cfg: CfgLike): ServerGroup[] {
  return foldersOfCfg(cfg, SPEC) as ServerGroup[]
}

/** 已存在的分组名（文件夹清单在前，记录上独有但未登记的补在后面） */
export function groupNames(cfg: CfgLike): string[] {
  return groupNamesOf(cfg, SPEC)
}

export function hasGroup(cfg: CfgLike, raw: unknown): boolean {
  return hasGroupOf(cfg, SPEC, raw)
}

/** 登记一个文件夹（已存在则不动）。返回是否真的新增 */
export function ensureGroup(cfg: CfgLike, raw: unknown): boolean {
  return ensureGroupOf(cfg, SPEC, raw)
}

/** 改名：文件夹清单 + 所有引用该名字的服务器一起改。返回受影响的服务器数 */
export function renameGroup(cfg: CfgLike, rawFrom: unknown, rawTo: unknown): number {
  return renameGroupOf(cfg, SPEC, rawFrom, rawTo)
}

/** 删除文件夹：里面的服务器搬到 moveTo（空=变成未分组）。返回被搬动的服务器数 */
export function deleteGroup(cfg: CfgLike, rawName: unknown, rawMoveTo?: unknown): number {
  return deleteGroupOf(cfg, SPEC, rawName, rawMoveTo)
}

/** 把服务器移进分组（空串 = 移出分组）。返回实际变更的数量 */
export function moveServers(cfg: CfgLike, ids: string[], rawGroup: unknown): number {
  return moveItemsOf(cfg, SPEC, ids, rawGroup)
}

/** 载入配置时整理：清掉非法/重复项，并把只在服务器上出现的分组补登记（旧配置迁移） */
export function normalizeServerGroups(cfg: CfgLike): void {
  normalizeFoldersOf(cfg, SPEC)
}
