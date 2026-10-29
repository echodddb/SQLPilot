import type { AppConfig, ConnGroup } from './types'
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
 * 数据库连接分组：与服务器分组同一套语义（名字即身份），
 * 核心逻辑在 group-folders.ts，这里只绑定 connections / connGroups。
 *
 * ConnProfile.group 存分组名，config.connGroups 保存文件夹清单（顺序 + 空文件夹）。
 */

export { UNGROUPED, normalizeGroupName, validateGroupName }

const SPEC: GroupSpec = { items: 'connections', folders: 'connGroups' }

type CfgLike = Pick<AppConfig, 'connections'> & { connGroups?: ConnGroup[] }

/** 文件夹清单（就地补齐成数组） */
export function connFoldersOf(cfg: CfgLike): ConnGroup[] {
  return foldersOfCfg(cfg, SPEC) as ConnGroup[]
}

/** 已存在的分组名（文件夹清单在前，连接上独有但未登记的补在后面） */
export function connGroupNames(cfg: CfgLike): string[] {
  return groupNamesOf(cfg, SPEC)
}

export function hasConnGroup(cfg: CfgLike, raw: unknown): boolean {
  return hasGroupOf(cfg, SPEC, raw)
}

/** 登记一个文件夹（已存在则不动）。返回是否真的新增 */
export function ensureConnGroup(cfg: CfgLike, raw: unknown): boolean {
  return ensureGroupOf(cfg, SPEC, raw)
}

/** 改名：文件夹清单 + 所有引用该名字的连接一起改。返回受影响的连接数 */
export function renameConnGroup(cfg: CfgLike, rawFrom: unknown, rawTo: unknown): number {
  return renameGroupOf(cfg, SPEC, rawFrom, rawTo)
}

/** 删除文件夹：里面的连接搬到 moveTo（空=变成未分组）。返回被搬动的连接数 */
export function deleteConnGroup(cfg: CfgLike, rawName: unknown, rawMoveTo?: unknown): number {
  return deleteGroupOf(cfg, SPEC, rawName, rawMoveTo)
}

/** 把连接移进分组（空串 = 移出分组）。返回实际变更的数量 */
export function moveConnections(cfg: CfgLike, ids: string[], rawGroup: unknown): number {
  return moveItemsOf(cfg, SPEC, ids, rawGroup)
}

/** 载入配置时整理：清掉非法/重复项，并把只在连接上出现的分组补登记（旧配置迁移） */
export function normalizeConnGroups(cfg: CfgLike): void {
  normalizeFoldersOf(cfg, SPEC)
}
