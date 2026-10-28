/**
 * 直连模式（无 OCP）的对外门面。
 *
 * service.ts 只跟这里打交道：函数签名刻意与 ocp.ts 对齐（同样的入参、同样的返回结构），
 * 这样 service 里的分派就是一层 if，渲染层完全不用区分数据来自 OCP 还是直连。
 */

import {
  dropPool,
  ping,
  type ObDirectPlatform
} from './conn'
import { capabilityOf, dropCapability, type ObCapability } from './capability'
import {
  clusterDetailOf,
  clustersOf,
  eventsOf,
  hostsOf,
  overviewOf,
  snapshotOf,
  sqlTextOf,
  tenantDetailOf,
  tenantsOf,
  topSqlOf,
  parametersOf,
  type ObSnapshot
} from './collect'
import { alarmSummaryOf, evaluateAlarms } from './alarm'
import type {
  AlarmLevelCount,
  CloudAlarm,
  CloudCluster,
  CloudClusterDetail,
  CloudHost,
  CloudOverview,
  CloudTenant,
  CloudTenantDetail
} from '../ocp'

export type { ObDirectPlatform } from './conn'
export { dropPool, dropCapability }
export { topSqlOf, sqlTextOf, parametersOf, eventsOf }
export { majorFreeze, setMergeSuspended, setParameter, killSession, openTransactions } from './write'
export type { WriteResult } from './write'

/** 供上层判断"这条连接是否直连模式" */
export const isObDirect = (type: string): boolean => type === 'obdirect'

/** 测试连接：返回版本与能力概要，失败抛原始错误由 service 包装 */
export async function test(p: ObDirectPlatform, password: string): Promise<{
  version: string
  clusterName: string
  tenant: string
  topology: { servers: number; zones: number; tenants: number }
  capability: { total: number; available: number }
}> {
  const { version } = await ping(p, password)
  const cap = await capabilityOf(p, password, true)
  const s = await snapshotOf(p, password)
  const total = Object.keys(cap.views).length
  const available = Object.values(cap.views).filter(Boolean).length
  return {
    version,
    clusterName: cap.clusterName,
    tenant: cap.tenant,
    topology: { servers: s.servers.length, zones: s.zones.length, tenants: s.tenants.length },
    capability: { total, available }
  }
}

/** 登录态：直连没有会话概念，能查通即为在线 */
export async function status(p: ObDirectPlatform, password: string): Promise<{
  ok: boolean
  version?: string
  clusterName?: string
  error?: string
}> {
  try {
    const { version } = await ping(p, password)
    const cap = await capabilityOf(p, password)
    return { ok: true, version, clusterName: cap.clusterName }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

export function capability(p: ObDirectPlatform, password: string, force = false): Promise<ObCapability> {
  return capabilityOf(p, password, force)
}

export async function overview(p: ObDirectPlatform, password: string): Promise<CloudOverview> {
  const ov = await overviewOf(p, password, async (s: ObSnapshot) => {
    const a = await alarmSummaryOf(p, password, s)
    return { total: a.total, levels: a.levels, critical: a.critical }
  })
  // 总览要带前几条活跃告警，单独补一次（overviewOf 内部为避免重复查询只给了计数）
  try {
    const s = await snapshotOf(p, password)
    const a = await alarmSummaryOf(p, password, s)
    ov.alarms = a.alarms.slice(0, 20)
    ov.warnings = [...ov.warnings, ...a.skipped.map((x) => `告警规则跳过：${x}`)]
  } catch {
    // 告警拿不到不影响总览主体
  }
  return ov
}

export async function clusters(p: ObDirectPlatform, password: string): Promise<CloudCluster[]> {
  const s = await snapshotOf(p, password)
  const a = await alarmSummaryOf(p, password, s)
  return clustersOf(s, { total: a.total, levels: a.levels })
}

export async function clusterDetail(
  p: ObDirectPlatform,
  password: string,
  clusterId: number
): Promise<CloudClusterDetail> {
  return clusterDetailOf(p, password, clusterId, async (s: ObSnapshot) => {
    const a = await alarmSummaryOf(p, password, s)
    return { total: a.total, levels: a.levels, critical: a.critical }
  })
}

export async function tenants(p: ObDirectPlatform, password: string): Promise<CloudTenant[]> {
  const s = await snapshotOf(p, password)
  const cluster = clustersOf(s, { total: 0, levels: [] })[0]
  return tenantsOf(s, cluster)
}

export async function tenantDetail(
  p: ObDirectPlatform,
  password: string,
  tenantId: number
): Promise<CloudTenantDetail | null> {
  return tenantDetailOf(p, password, tenantId)
}

export async function hosts(p: ObDirectPlatform, password: string): Promise<CloudHost[]> {
  const s = await snapshotOf(p, password)
  const cluster = clustersOf(s, { total: 0, levels: [] })[0]
  return hostsOf(s, cluster)
}

export async function alarms(p: ObDirectPlatform, password: string): Promise<{
  items: CloudAlarm[]
  total: number
  levels: AlarmLevelCount[]
  skipped: string[]
}> {
  const s = await snapshotOf(p, password)
  const r = await evaluateAlarms(p, password, s)
  return { items: r.alarms, total: r.total, levels: r.levels, skipped: r.skipped }
}
