/**
 * 能力探测：确定当前实例支持哪些系统视图。
 *
 * 为什么必须探测：OB 各版本视图名不一致，实测 4.3.5.2 就缺 DBA_OB_SERVER_EVENTS_HISTORY /
 * GV$OB_SESSIONS / GV$OB_LS_LOCATIONS / V$OB_SYSSTAT / DBA_TABLESPACES /
 * CDB_OB_TENANT_PARAMETERS。硬编码任何一条都会在别的版本上整页报错。
 *
 * 探测方式是逐条 `SELECT 1 FROM <view> LIMIT 0`（information_schema 对虚拟表不可靠），
 * 结果按平台缓存 10 分钟。
 */

import { q, q1, type ObDirectPlatform } from './conn'

/** 需要探测的视图清单（全部位于 oceanbase 库） */
export const PROBE_VIEWS = [
  // 拓扑与租户
  'DBA_OB_SERVERS', 'DBA_OB_ZONES', 'DBA_OB_TENANTS', 'DBA_OB_UNITS',
  'DBA_OB_RESOURCE_POOLS', 'DBA_OB_UNIT_CONFIGS', 'DBA_OB_SERVICES',
  // 日志流
  'DBA_OB_LS', 'CDB_OB_LS', 'DBA_OB_LS_LOCATIONS',
  // 运维事件与任务
  'DBA_OB_ROOTSERVICE_EVENT_HISTORY', 'DBA_OB_TENANT_JOBS',
  'DBA_OB_BALANCE_JOBS', 'DBA_OB_BALANCE_TASKS', 'DBA_OB_SERVER_JOBS',
  // 合并
  'DBA_OB_MAJOR_COMPACTION', 'DBA_OB_ZONE_MAJOR_COMPACTION',
  'V$OB_COMPACTION_PROGRESS', 'GV$OB_COMPACTION_PROGRESS',
  // 资源与指标
  'GV$OB_SERVERS', 'GV$OB_UNITS', 'GV$OB_TENANT_RESOURCE_LIMIT', 'GV$OB_MEMSTORE',
  'V$OB_TENANT_MEMORY', 'GV$OB_TENANT_MEMORY', 'V$OB_MEMORY', 'V$OB_KVCACHE',
  'V$SYSSTAT', 'GV$SYSSTAT',
  // SQL 诊断
  'GV$OB_SQL_AUDIT', 'V$OB_SQL_AUDIT', 'GV$OB_PROCESSLIST', 'V$OB_PROCESSLIST',
  'V$OB_TRANSACTION_PARTICIPANTS',
  // 对象与账号
  'CDB_OB_TABLE_LOCATIONS', 'DBA_OB_DATABASES', 'DBA_OB_USERS', 'DBA_OB_TABLEGROUPS',
  // 参数
  'GV$OB_PARAMETERS',
  // 备份
  'DBA_OB_BACKUP_JOBS', 'DBA_OB_BACKUP_TASKS', 'DBA_OB_BACKUP_SET_FILES',
  'CDB_OB_BACKUP_PARAMETER', 'DBA_OB_ARCHIVELOG'
] as const

export type ProbeView = (typeof PROBE_VIEWS)[number]

export interface ObCapability {
  /** 实例完整版本串，如 4.3.5.2 */
  version: string
  /** 集群名（参数 cluster），取不到时用地址兜底 */
  clusterName: string
  /** 探测时连接的租户名（root@sys → sys） */
  tenant: string
  views: Record<string, boolean>
  at: number
}

interface CacheEntry {
  cap: ObCapability
  at: number
  fp: string
}

const TTL = 10 * 60 * 1000
const CACHE = new Map<string, CacheEntry>()

const tenantOf = (username: string): string => {
  const at = username.indexOf('@')
  return at >= 0 ? username.slice(at + 1) : ''
}

const shortVersion = (v: string): string => {
  // 5.7.25-OceanBase-v4.3.5.2 → 4.3.5.2
  const m = /OceanBase-v?([\d.]+)/i.exec(v)
  return m ? m[1] : v
}

/** 逐条探测（连接池上限 2，串行更快也更稳），任一条失败只标记该项为 false */
async function probeViews(p: ObDirectPlatform, password: string): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {}
  for (const v of PROBE_VIEWS) {
    try {
      await q(p, password, `SELECT 1 FROM oceanbase.${v} LIMIT 0`)
      out[v] = true
    } catch {
      out[v] = false
    }
  }
  return out
}

export async function capabilityOf(
  p: ObDirectPlatform,
  password: string,
  force = false
): Promise<ObCapability> {
  const fp = `${p.host}:${p.port}:${p.username}:${password}`
  const hit = CACHE.get(p.id)
  if (!force && hit && hit.fp === fp && Date.now() - hit.at < TTL) return hit.cap

  const ver = await q1<any>(p, password, 'SELECT VERSION() AS v')
  const version = shortVersion(String(ver?.v ?? ''))

  let clusterName = ''
  try {
    const row = await q1<any>(
      p, password,
      "SELECT VALUE AS v FROM oceanbase.GV$OB_PARAMETERS WHERE NAME = 'cluster' LIMIT 1"
    )
    clusterName = String(row?.v ?? '')
  } catch {
    // 参数读不到就用地址兜底
  }
  if (!clusterName) clusterName = `${p.host}:${p.port}`

  const views = await probeViews(p, password)
  const cap: ObCapability = {
    version,
    clusterName,
    tenant: tenantOf(p.username),
    views,
    at: Date.now()
  }
  CACHE.set(p.id, { cap, at: cap.at, fp })
  return cap
}

export function dropCapability(id: string): void {
  CACHE.delete(id)
}

/** 便捷判定 */
export const has = (cap: ObCapability, view: string): boolean => cap.views[view] === true

/**
 * SQL 诊断用哪个审计视图：GV$ 优先（能跨 OBServer），退化到 V$。
 * 本机实测两者都有，但别的部署不一定开 GV$。
 */
export const sqlAuditView = (cap: ObCapability): string | null => {
  if (has(cap, 'GV$OB_SQL_AUDIT')) return 'GV$OB_SQL_AUDIT'
  if (has(cap, 'V$OB_SQL_AUDIT')) return 'V$OB_SQL_AUDIT'
  return null
}

/** 进程列表同理 */
export const processlistView = (cap: ObCapability): string | null => {
  if (has(cap, 'GV$OB_PROCESSLIST')) return 'GV$OB_PROCESSLIST'
  if (has(cap, 'V$OB_PROCESSLIST')) return 'V$OB_PROCESSLIST'
  return null
}

/** 系统统计项：V$SYSSTAT 与 GV$SYSSTAT 二选一（V$OB_SYSSTAT 在 4.3 不存在） */
export const sysstatView = (cap: ObCapability): string | null => {
  if (has(cap, 'GV$SYSSTAT')) return 'GV$SYSSTAT'
  if (has(cap, 'V$SYSSTAT')) return 'V$SYSSTAT'
  return null
}
