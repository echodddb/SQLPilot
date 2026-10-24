/**
 * 云管平台接入的配置与会话管理（electron 侧）。
 * 平台清单存 config.json（不含密码），密码走 DPAPI 加密存 secrets.json（键 cloud:<id>）。
 * 客户端按平台缓存，会话 Cookie 复用；同一平台凭据变化时自动重建。
 */

import crypto from 'node:crypto'
import { loadConfig, saveConfig } from '../config'
import { getPassword, setPassword, deletePassword, secretsAvailable } from '../secrets'
import {
  OcpClient,
  normalizeBase,
  ocpTest,
  ocpOverview,
  ocpClusters,
  ocpClusterDetail,
  ocpTenants,
  ocpTenantDetail,
  ocpHosts,
  ocpAlarms,
  ocpAlarmHistory,
  ocpAlarmDetail,
  ocpAlarmRules,
  ocpAlarmTrend,
  ocpAlarmLevelCounts,
  ocpTasks,
  ocpTaskDetail,
  ocpTaskStats,
  ocpTaskCreators,
  type AlarmQuery,
  type AlarmListResult,
  type AlarmHistoryResult,
  type AlarmRuleQuery,
  type AlarmRule,
  type AlarmTrend,
  type TaskQuery,
  type TaskListResult,
  type CloudTaskDetail,
  ocpMetrics,
  ocpClusterAction,
  ocpCreateTenant,
  ocpDeleteTenant,
  ocpPackages,
  ocpClusterCreatePreCheck,
  ocpClusterCreate,
  ocpClusterParameters,
  ocpTenantParameters,
  ocpTenantUpdateParameters,
  ocpClusterUpdateParameters,
  ocpTopSql,
  ocpSlowSql,
  ocpSqlText,
  ocpTenantSqlStats,
  type TopSqlRow,
  type SqlTextInfo,
  type TenantSqlStat,
  ocpTenantChangePassword,
  ocpTenantModifyWhitelist,
  ocpTenantModifyReplica,
  ocpTenantAddReplica,
  ocpTenantDeleteReplica,
  ocpTenantSetLocked,
  ocpTenantSessions,
  ocpTenantCloseSessions,
  type OcpPlatform,
  type OcpInfo,
  type CloudOverview,
  type CloudCluster,
  type CloudClusterDetail,
  type CloudTenant,
  type CloudTenantDetail,
  type CloudHost,
  type CloudAlarm,
  type CloudTask,
  type MetricQuery,
  type MetricSeries,
  type CreateTenantInput,
  type ClusterCreateInput,
  type TenantReplicaInput,
  type CloudTenantSession,
  type ParamRow
} from './ocp'
import {
  ocpTenantDatabases,
  ocpTenantTables,
  ocpTenantTableSchema,
  ocpTenantStandbyTopo,
  ocpTenantSessionStats,
  ocpTenantCloseQuery,
  ocpTenantRowLocks,
  ocpTenantTransactions,
  ocpTenantCloseTransactions,
  ocpTenantNewSql,
  ocpTenantHighRiskSql,
  ocpTenantParallelSql,
  ocpTenantOutlines,
  ocpTenantSqlDiagnosis,
  ocpTenantCompaction,
  ocpTenantCompactionSettings,
  ocpTenantUpdateCompactionSettings,
  ocpTenantRecentCompactions,
  ocpTenantMiniCompactions,
  ocpTenantCompactionAction,
  ocpTenantGatherOverview,
  ocpTenantGatherTables,
  ocpTenantGatherAuto,
  ocpTenantGatherPrefs,
  ocpBackupAbility,
  ocpBackupOverview,
  ocpBackupStrategy,
  ocpBackupDataTasks,
  ocpBackupLogTasks,
  ocpTenantUsers,
  ocpTenantTde,
  type TenantDatabase,
  type TenantTableList,
  type TenantTableSchema,
  type TenantStandbyTopo,
  type TenantSessionStats,
  type TenantRowLock,
  type TenantTransaction,
  type TenantOutline,
  type TenantSqlDiagnosis,
  type TenantCompaction,
  type TenantCompactionSettings,
  type TenantMajorCompaction,
  type TenantMinorCompaction,
  type TenantGatherOverview,
  type TenantGatherTable,
  type TenantGatherWindow,
  type TenantGatherPref,
  type TenantBackupOverview,
  type TenantBackupStrategy,
  type TenantBackupTask,
  type TenantUser,
  type TenantTde,
  ocpUnitSpecs,
  ocpUnitSpecCreate,
  ocpUnitSpecUpdate,
  ocpUnitSpecDelete,
  ocpTenantClonePreCheck,
  ocpTenantClone,
  ocpPrimaryTenantInfo,
  ocpCreateStandbyTenant,
  type UnitSpecRow,
  type UnitSpecInput,
  type TenantPreCheckResult,
  type TenantCloneInput,
  type PrimaryTenantInfo,
  type StandbyTenantInput
} from './tenant'
import { ocpBackupBundle, ocpBackupTasks, type BackupBundle, type BackupTaskKind, type BackupTaskRow } from './backup'
import { ocpObproxyBundle, ocpObproxyCluster, ocpObproxyParams, type ObproxyCluster, type ObproxyParam } from './obproxy'
import {
  ocpInspectionBundle,
  ocpInspectionReport,
  ocpInspectionTasks,
  type InspectionBundle,
  type InspectionReport,
  type InspectionReportRef
} from './inspection'
import {
  ocpPlatformBundle,
  ocpPlatformLogins,
  ocpPlatformProperties,
  type PlatformBundle,
  type PlatformLoginRecord,
  type PlatformProperty
} from './platform'
import type { CloudPlatform } from '../types'
import {
  oracleSection,
  oracleSqlDetail,
  oracleStatus,
  dropOracleCache,
  type CloudOraclePlatform,
  type OraSectionKey,
  type OraSectionResult,
  type OraSections
} from './oracle'
import { dropOracleConn, oraTestConn } from './oracle/conn'

export type CloudPlatformView = CloudPlatform & { hasPassword: boolean }

const secretKey = (id: string) => `cloud:${id}`

/** 客户端缓存：登录一次可复用 Cookie 约 30 分钟，这里 10 分钟主动重建一次，避免用到过期会话 */
const CLIENT_TTL_MS = 10 * 60 * 1000
const clients = new Map<string, { client: OcpClient; at: number; fp: string }>()

function fingerprint(p: OcpPlatform, password: string): string {
  // 密码只取摘要：既不落明文，也能在"改了密码但长度与末两位相同"时正确重建客户端
  const pw = password ? crypto.createHash('sha256').update(password).digest('hex').slice(0, 16) : ''
  return `${p.baseUrl}|${p.username}|${p.insecure ? 1 : 0}|${pw}`
}

export function listPlatforms(): CloudPlatformView[] {
  const cfg = loadConfig()
  return (cfg.cloudPlatforms || []).map((p) => ({ ...p, hasPassword: !!getPassword(secretKey(p.id)) }))
}

export function getPlatform(id: string): OcpPlatform {
  const p = (loadConfig().cloudPlatforms || []).find((x) => x.id === id)
  if (!p) throw new Error('云管平台未配置或已被删除')
  if (p.type !== 'ocp') throw new Error(`该平台类型为 ${p.type}，不是 OCP 平台`)
  return p as unknown as OcpPlatform
}

/** Oracle 直连平台（查库而不是调接口） */
export function getOraclePlatform(id: string): CloudOraclePlatform {
  const p = (loadConfig().cloudPlatforms || []).find((x) => x.id === id)
  if (!p) throw new Error('云管平台未配置或已被删除')
  if (p.type !== 'oracle') throw new Error(`该平台类型为 ${p.type}，不是 Oracle 平台`)
  if (!p.host || !p.username) throw new Error('Oracle 平台缺少主机或用户名，请在平台设置里补全')
  return {
    id: p.id,
    name: p.name,
    type: 'oracle',
    host: p.host,
    port: Number(p.port) || 1521,
    serviceName: String(p.serviceName || ''),
    username: p.username,
    role: p.role || 'default',
    instantClientDir: p.instantClientDir || ''
  }
}

function clientOf(id: string): OcpClient {
  const platform = getPlatform(id)
  const password = getPassword(secretKey(id))
  if (!password) throw new Error(`平台「${platform.name}」尚未保存密码，请先在云管平台设置中填写`)
  const fp = fingerprint(platform, password)
  const hit = clients.get(id)
  if (hit && hit.fp === fp && Date.now() - hit.at < CLIENT_TTL_MS) return hit.client
  const client = new OcpClient(platform, password)
  clients.set(id, { client, at: Date.now(), fp })
  return client
}

export function dropClient(id: string): void {
  clients.delete(id)
}

export interface SaveResult { ok: boolean; error?: string; platform?: CloudPlatformView; warning?: string }

export async function savePlatform(input: CloudPlatform & { hasPassword?: boolean }, password?: string): Promise<SaveResult> {
  const cfg = loadConfig()
  if (!Array.isArray(cfg.cloudPlatforms)) cfg.cloudPlatforms = []
  const id = input.id || `cl_${Date.now().toString(36)}`
  const exists = cfg.cloudPlatforms.some((p) => p.id === id)
  const effPassword = password !== undefined && password !== '' ? password : getPassword(secretKey(id))
  if (!effPassword) return { ok: false, error: '请填写密码' }
  if (password && !secretsAvailable()) {
    return { ok: false, error: '系统加密不可用（DPAPI），为避免密码明文落盘，本次保存已取消' }
  }
  if (input.type === 'oracle') return saveOraclePlatform(cfg, input, effPassword, id, exists)

  // 地址归一化：允许用户直接粘浏览器地址栏（带 /login、#/overview 之类的网页路由）
  let baseUrl = ''
  try { baseUrl = normalizeBase(String(input.baseUrl || '')) } catch (e: any) { return { ok: false, error: e?.message || 'OCP 地址格式不正确' } }
  const username = String(input.username || '').trim()
  if (!baseUrl) return { ok: false, error: '请填写 OCP 地址' }
  if (!username) return { ok: false, error: '请填写 OCP 用户名' }

  let fallbackName = baseUrl
  try { fallbackName = new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`).host } catch { /* 非法地址交由下一步连接测试报错 */ }
  const platform: OcpPlatform = {
    id,
    name: String(input.name || '').trim() || fallbackName,
    type: 'ocp',
    baseUrl,
    username,
    insecure: !!input.insecure
  }

  // 先验证连通与凭据，通过后才写配置——避免存下一组永远连不上的地址
  const test = await ocpTest(platform, effPassword)
  if (!test.ok) return { ok: false, error: test.error || '连接 OCP 失败' }

  if (password) setPassword(secretKey(id), password)
  if (exists) {
    cfg.cloudPlatforms = cfg.cloudPlatforms.map((p) => (p.id === id ? platform : p))
  } else {
    cfg.cloudPlatforms.push(platform)
  }
  saveConfig(cfg)
  dropClient(id)
  return { ok: true, platform: { ...platform, hasPassword: true } }
}

/** Oracle 直连平台的保存：先真连一次库拿到版本，再落盘 */
async function saveOraclePlatform(cfg: any, input: CloudPlatform, effPassword: string, id: string, exists: boolean): Promise<SaveResult> {
  const host = String(input.host || '').trim()
  const username = String(input.username || '').trim()
  if (!host) return { ok: false, error: '请填写数据库主机' }
  if (!username) return { ok: false, error: '请填写数据库用户名' }
  const platform: CloudPlatform = {
    id,
    name: String(input.name || '').trim() || `${host}:${input.port || 1521}`,
    type: 'oracle',
    host,
    port: Number(input.port) || 1521,
    serviceName: String(input.serviceName || '').trim(),
    username,
    role: input.role || 'default',
    instantClientDir: String(input.instantClientDir || '').trim()
  }
  const test = await oraTestConn({ ...platform, type: 'oracle' } as CloudOraclePlatform, effPassword)
  if (!test.ok) return { ok: false, error: test.error || '连接 Oracle 失败' }
  // 选了 SYSDBA 但账号没有该特权时按普通身份落盘：看板只读视图，普通 DBA 账号即可，
  // 落盘后再提示用户，避免下次进模块又连不上
  let warning: string | undefined
  if (test.downgraded) {
    platform.role = 'default'
    warning = `${test.note || '该账号未被授予 SYSDBA 特权'}平台已按「普通用户」身份保存（Oracle 看板只读 v$ / dba_ 视图，不需要 SYSDBA）。`
  }

  if (effPassword) setPassword(secretKey(id), effPassword)
  if (exists) {
    cfg.cloudPlatforms = cfg.cloudPlatforms.map((p: CloudPlatform) => (p.id === id ? platform : p))
  } else {
    cfg.cloudPlatforms.push(platform)
  }
  saveConfig(cfg)
  dropOracleConn(id)
  dropOracleCache(id)
  return { ok: true, platform: { ...platform, hasPassword: true } as CloudPlatformView, warning }
}

export function deletePlatform(id: string): { ok: boolean; error?: string } {
  const cfg = loadConfig()
  const list = cfg.cloudPlatforms || []
  if (!list.some((p) => p.id === id)) return { ok: false, error: '平台不存在' }
  cfg.cloudPlatforms = list.filter((p) => p.id !== id)
  saveConfig(cfg)
  deletePassword(secretKey(id))
  dropClient(id)
  dropOracleConn(id)
  dropOracleCache(id)
  return { ok: true }
}

export async function testPlatform(input: CloudPlatform, password?: string): Promise<{
  ok: boolean
  info?: OcpInfo
  error?: string
  baseUrl?: string
  version?: string
  mode?: string
  /** Oracle：请求了 SYSDBA 但账号没这特权，已按普通身份连通 */
  downgraded?: boolean
  note?: string
  privileges?: { dba: boolean; sysdba: boolean; sysoper: boolean }
}> {
  const eff = password && password !== '' ? password : input.id ? getPassword(secretKey(input.id)) : ''
  if (!eff) return { ok: false, error: '请填写密码' }
  if (input.type === 'oracle') {
    const r = await oraTestConn(input as CloudOraclePlatform, eff)
    return { ok: r.ok, error: r.error, version: r.version, mode: r.mode, downgraded: r.downgraded, note: r.note, privileges: r.privileges }
  }
  let baseUrl = ''
  try { baseUrl = normalizeBase(String(input.baseUrl || '')) } catch (e: any) { return { ok: false, error: e?.message || 'OCP 地址格式不正确' } }
  const r = await ocpTest({ ...input, baseUrl } as OcpPlatform, eff)
  return { ...r, baseUrl }
}

/** 已保存平台的登录测试（会建立并缓存会话，界面进入模块时用它探活） */
export async function loginStatus(id: string): Promise<{ ok: boolean; info?: OcpInfo; error?: string; oracle?: { version?: string; mode?: string } }> {
  try {
    const p = (loadConfig().cloudPlatforms || []).find((x) => x.id === id)
    if (p?.type === 'oracle') {
      const st = await oracleStatus(getOraclePlatform(id))
      if (!st.ok) return { ok: false, error: st.error || '连接 Oracle 失败' }
      return { ok: true, oracle: { version: st.version, mode: st.mode } }
    }
    const client = clientOf(id)
    const info = await client.ensureLogin()
    return { ok: true, info }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// ---------- Oracle 直连平台的数据入口 ----------

/** 取一个分区的数据（section 见 OraSectionKey）；force=true 绕过 45 秒缓存 */
export async function cloudOracleSection<K extends OraSectionKey>(
  id: string,
  section: K,
  opts: Record<string, any> = {},
  force = false
): Promise<OraSectionResult<OraSections[K]>> {
  const p = getOraclePlatform(id)
  return oracleSection(p, section, opts, force)
}

/** 单条 SQL 的全文 + 执行计划 */
export async function cloudOracleSqlDetail(id: string, sqlId: string): Promise<{ ok: boolean; text?: string; plan?: any[]; error?: string }> {
  return oracleSqlDetail(getOraclePlatform(id), sqlId)
}

// ---------- 业务数据（全部把异常收敛成 { ok, error } 交给界面提示） ----------

async function wrap<T>(fn: () => Promise<T>): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    return { ok: true, data: await fn() }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export const overview = (id: string): Promise<{ ok: boolean; data?: CloudOverview; error?: string }> =>
  wrap(() => ocpOverview(clientOf(id)))

export const clusters = (id: string): Promise<{ ok: boolean; data?: CloudCluster[]; error?: string }> =>
  wrap(() => ocpClusters(clientOf(id)))

export const clusterDetail = (id: string, clusterId: number): Promise<{ ok: boolean; data?: CloudClusterDetail; error?: string }> =>
  wrap(() => ocpClusterDetail(clientOf(id), clusterId))

export const tenants = (id: string): Promise<{ ok: boolean; data?: CloudTenant[]; error?: string }> =>
  wrap(() => ocpTenants(clientOf(id)))

export const tenantDetail = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: CloudTenantDetail; error?: string }> =>
  wrap(() => ocpTenantDetail(clientOf(id), clusterId, tenantId))

export const hosts = (id: string): Promise<{ ok: boolean; data?: CloudHost[]; error?: string }> =>
  wrap(() => ocpHosts(clientOf(id)))

export const alarms = (id: string, opts: AlarmQuery = {}): Promise<{ ok: boolean; data?: AlarmListResult; error?: string }> =>
  wrap(() => ocpAlarms(clientOf(id), opts))

export const alarmHistory = (id: string, opts: { page?: number; size?: number; hours?: number; level?: number; scope?: string; keyword?: string; alarmType?: string; appType?: string } = {}): Promise<{ ok: boolean; data?: AlarmHistoryResult; error?: string }> =>
  wrap(() => ocpAlarmHistory(clientOf(id), opts))

export const alarmDetail = (id: string, alarmId: number): Promise<{ ok: boolean; data?: CloudAlarm; error?: string }> =>
  wrap(() => ocpAlarmDetail(clientOf(id), alarmId))

export const alarmRules = (id: string, opts: AlarmRuleQuery = {}): Promise<{ ok: boolean; data?: { items: AlarmRule[]; total: number; page: number; size: number }; error?: string }> =>
  wrap(() => ocpAlarmRules(clientOf(id), opts))

export const alarmTrend = (id: string, hours = 24): Promise<{ ok: boolean; data?: AlarmTrend; error?: string }> =>
  wrap(() => ocpAlarmTrend(clientOf(id), hours))

export const alarmLevelCounts = (id: string): Promise<{ ok: boolean; data?: { level: number; count: number }[]; error?: string }> =>
  wrap(() => ocpAlarmLevelCounts(clientOf(id)))

export const tasks = (id: string, opts: TaskQuery = {}): Promise<{ ok: boolean; data?: TaskListResult; error?: string }> =>
  wrap(() => ocpTasks(clientOf(id), opts))

export const taskDetail = (id: string, taskId: number): Promise<{ ok: boolean; data?: CloudTaskDetail; error?: string }> =>
  wrap(() => ocpTaskDetail(clientOf(id), taskId))

export const taskStats = (id: string): Promise<{ ok: boolean; data?: { status: string; count: number }[]; error?: string }> =>
  wrap(() => ocpTaskStats(clientOf(id)))

export const taskCreators = (id: string): Promise<{ ok: boolean; data?: string[]; error?: string }> =>
  wrap(() => ocpTaskCreators(clientOf(id)))


// ---------- 监控 ----------

export const metrics = (id: string, q: MetricQuery): Promise<{ ok: boolean; data?: { series: MetricSeries[]; warnings: string[]; step: number }; error?: string }> =>
  wrap(() => ocpMetrics(clientOf(id), q))

// ---------- 运维动作 ----------

export const clusterAction = (id: string, clusterId: number, action: string): Promise<{ ok: boolean; data?: { taskId?: number; message?: string }; error?: string }> =>
  wrap(() => ocpClusterAction(clientOf(id), clusterId, action))

export const createTenant = (id: string, clusterId: number, input: CreateTenantInput): Promise<{ ok: boolean; data?: { taskId?: number }; error?: string }> =>
  wrap(() => ocpCreateTenant(clientOf(id), clusterId, input))

export const deleteTenant = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: { taskId?: number }; error?: string }> =>
  wrap(() => ocpDeleteTenant(clientOf(id), clusterId, tenantId))

export const packages = (id: string): Promise<{ ok: boolean; data?: { id: number; name: string; version: string; architecture: string }[]; error?: string }> =>
  wrap(() => ocpPackages(clientOf(id)))


// ---------- 创建集群 / 参数 ----------

export const clusterPreCheck = (id: string, input: ClusterCreateInput): Promise<{ ok: boolean; data?: { checkId?: string; items: { key: string; name: string; status: string; message?: string }[] }; error?: string }> =>
  wrap(() => ocpClusterCreatePreCheck(clientOf(id), input))

export const clusterCreate = (id: string, input: ClusterCreateInput, checkId?: string): Promise<{ ok: boolean; data?: { taskId?: number }; error?: string }> =>
  wrap(() => ocpClusterCreate(clientOf(id), input, checkId))

export const clusterParams = (id: string, clusterId: number): Promise<{ ok: boolean; data?: ParamRow[]; error?: string }> =>
  wrap(() => ocpClusterParameters(clientOf(id), clusterId))

export const clusterUpdateParams = (id: string, clusterId: number, items: { name: string; value: string }[]): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpClusterUpdateParameters(clientOf(id), clusterId, items) })

export const tenantParams = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: { name: string; value: string; def: string; type: string; description: string }[]; error?: string }> =>
  wrap(() => ocpTenantParameters(clientOf(id), clusterId, tenantId))


// ---------- 租户管理（对齐 OCP 租户详情页） ----------

export const tenantUpdateParams = (id: string, clusterId: number, tenantId: number, items: { name: string; value: string }[]): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpTenantUpdateParameters(clientOf(id), clusterId, tenantId, items) })

export const tenantChangePassword = (id: string, clusterId: number, tenantId: number, newPassword: string): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpTenantChangePassword(clientOf(id), clusterId, tenantId, newPassword) })

export const tenantModifyWhitelist = (id: string, clusterId: number, tenantId: number, whitelist: string): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpTenantModifyWhitelist(clientOf(id), clusterId, tenantId, whitelist) })

export const tenantModifyReplica = (id: string, clusterId: number, tenantId: number, replicas: TenantReplicaInput[]): Promise<{ ok: boolean; data?: { taskId?: number }; error?: string }> =>
  wrap(() => ocpTenantModifyReplica(clientOf(id), clusterId, tenantId, replicas))

export const tenantAddReplica = (id: string, clusterId: number, tenantId: number, replicas: TenantReplicaInput[]): Promise<{ ok: boolean; data?: { taskId?: number }; error?: string }> =>
  wrap(() => ocpTenantAddReplica(clientOf(id), clusterId, tenantId, replicas))

export const tenantDeleteReplica = (id: string, clusterId: number, tenantId: number, zoneNames: string[]): Promise<{ ok: boolean; data?: { taskId?: number }; error?: string }> =>
  wrap(() => ocpTenantDeleteReplica(clientOf(id), clusterId, tenantId, zoneNames))

export const tenantSetLocked = (id: string, clusterId: number, tenantId: number, locked: boolean): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpTenantSetLocked(clientOf(id), clusterId, tenantId, locked) })

export const tenantSessions = (id: string, clusterId: number, tenantId: number, page = 1, size = 200): Promise<{ ok: boolean; data?: { items: CloudTenantSession[]; total: number }; error?: string }> =>
  wrap(() => ocpTenantSessions(clientOf(id), clusterId, tenantId, page, size))

export const tenantCloseSessions = (id: string, clusterId: number, tenantId: number, sessionIds: number[]): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpTenantCloseSessions(clientOf(id), clusterId, tenantId, sessionIds) })

// ---------- SQL 诊断 ----------

export const topSql = (id: string, clusterId: number, tenantId: number, opts: { from: number; to: number; sqlText?: string; limit?: number }): Promise<{ ok: boolean; data?: TopSqlRow[]; error?: string }> =>
  wrap(() => ocpTopSql(clientOf(id), clusterId, tenantId, opts))

export const slowSql = (id: string, clusterId: number, tenantId: number, opts: { from: number; to: number }): Promise<{ ok: boolean; data?: TopSqlRow[]; error?: string }> =>
  wrap(() => ocpSlowSql(clientOf(id), clusterId, tenantId, opts))

/** 单条 SQL 的完整文本（OCP 列表接口只给截断版，展开时才取全文） */
export const sqlText = (id: string, clusterId: number, tenantId: number, sqlId: string, opts: { from: number; to: number }): Promise<{ ok: boolean; data?: SqlTextInfo; error?: string }> =>
  wrap(() => ocpSqlText(clientOf(id), clusterId, tenantId, sqlId, opts))

export const tenantSqlStats = (id: string, clusterId: number, from: number, to: number): Promise<{ ok: boolean; data?: TenantSqlStat[]; error?: string }> =>
  wrap(() => ocpTenantSqlStats(clientOf(id), clusterId, from, to))

// ---------- 租户详情：库表 / 拓扑 / 会话 / 事务 / SQL / 合并 / 统计 / 备份 / 用户 / TDE ----------

export const tenantDbs = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: TenantDatabase[]; error?: string }> =>
  wrap(() => ocpTenantDatabases(clientOf(id), clusterId, tenantId))

export const tenantTables = (id: string, clusterId: number, tenantId: number, db: string): Promise<{ ok: boolean; data?: TenantTableList; error?: string }> =>
  wrap(() => ocpTenantTables(clientOf(id), clusterId, tenantId, db))

export const tenantTableSchema = (id: string, clusterId: number, tenantId: number, db: string, table: string): Promise<{ ok: boolean; data?: TenantTableSchema; error?: string }> =>
  wrap(() => ocpTenantTableSchema(clientOf(id), clusterId, tenantId, db, table))

export const tenantTopo = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: TenantStandbyTopo; error?: string }> =>
  wrap(() => ocpTenantStandbyTopo(clientOf(id), clusterId, tenantId))

export const tenantSessionStats = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: TenantSessionStats; error?: string }> =>
  wrap(() => ocpTenantSessionStats(clientOf(id), clusterId, tenantId))

export const tenantCloseQuery = (id: string, clusterId: number, tenantId: number, sessionIds: number[]): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpTenantCloseQuery(clientOf(id), clusterId, tenantId, sessionIds) })

export const tenantRowLocks = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: TenantRowLock[]; error?: string }> =>
  wrap(() => ocpTenantRowLocks(clientOf(id), clusterId, tenantId))

export const tenantTxns = (id: string, clusterId: number, tenantId: number, thresholdMs: number): Promise<{ ok: boolean; data?: TenantTransaction[]; error?: string }> =>
  wrap(() => ocpTenantTransactions(clientOf(id), clusterId, tenantId, thresholdMs))

export const tenantCloseTxns = (id: string, clusterId: number, tenantId: number, list: { sessionId: number; transId?: string }[]): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpTenantCloseTransactions(clientOf(id), clusterId, tenantId, list) })

export const tenantNewSql = (id: string, clusterId: number, tenantId: number, from: number, to: number, limit?: number): Promise<{ ok: boolean; data?: TopSqlRow[]; error?: string }> =>
  wrap(() => ocpTenantNewSql(clientOf(id), clusterId, tenantId, from, to, limit))

export const tenantHighRiskSql = (id: string, clusterId: number, tenantId: number, from: number, to: number, limit?: number): Promise<{ ok: boolean; data?: TopSqlRow[]; error?: string }> =>
  wrap(() => ocpTenantHighRiskSql(clientOf(id), clusterId, tenantId, from, to, limit))

export const tenantParallelSql = (id: string, clusterId: number, tenantId: number, from: number, to: number, limit?: number): Promise<{ ok: boolean; data?: TopSqlRow[]; error?: string }> =>
  wrap(() => ocpTenantParallelSql(clientOf(id), clusterId, tenantId, from, to, limit))

export const tenantOutlines = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: TenantOutline[]; error?: string }> =>
  wrap(() => ocpTenantOutlines(clientOf(id), clusterId, tenantId))

export const tenantSqlDiagnosis = (id: string, clusterId: number, tenantId: number, sqlId: string, from: number, to: number): Promise<{ ok: boolean; data?: TenantSqlDiagnosis; error?: string }> =>
  wrap(() => ocpTenantSqlDiagnosis(clientOf(id), clusterId, tenantId, sqlId, from, to))

/** 合并 tab 的整包：状态 + 设置 + 主合并历史 + 转储历史（4 个请求并行，任一失败不影响其余） */
export interface TenantCompactionBundle {
  status: TenantCompaction | null
  settings: TenantCompactionSettings | null
  majors: TenantMajorCompaction[]
  minors: TenantMinorCompaction[]
  errors: string[]
}
export const tenantCompactionAll = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: TenantCompactionBundle; error?: string }> =>
  wrap(async () => {
    const c = clientOf(id)
    const errors: string[] = []
    const grab = async <T>(fn: () => Promise<T>, label: string, fallback: T): Promise<T> => {
      try { return await fn() } catch (e: any) { errors.push(`${label}：${e?.message || e}`); return fallback }
    }
    const [status, settings, majors, minors] = await Promise.all([
      grab(() => ocpTenantCompaction(c, clusterId, tenantId), '合并状态', null),
      grab(() => ocpTenantCompactionSettings(c, clusterId, tenantId), '合并设置', null),
      grab(() => ocpTenantRecentCompactions(c, clusterId, tenantId), '合并历史', [] as TenantMajorCompaction[]),
      grab(() => ocpTenantMiniCompactions(c, clusterId, tenantId), '转储历史', [] as TenantMinorCompaction[])
    ])
    return { status, settings, majors, minors, errors }
  })

export const tenantUpdateCompactionSettings = (id: string, clusterId: number, tenantId: number, patch: Partial<TenantCompactionSettings>): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpTenantUpdateCompactionSettings(clientOf(id), clusterId, tenantId, patch) })

export const tenantCompactionAction = (id: string, clusterId: number, tenantId: number, action: 'trigger' | 'suspend' | 'resume' | 'clearError'): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpTenantCompactionAction(clientOf(id), clusterId, tenantId, action) })

/** 统计信息 tab 整包 */
export interface TenantGatherBundle {
  overview: TenantGatherOverview | null
  tables: TenantGatherTable[]
  windows: TenantGatherWindow[]
  prefs: TenantGatherPref[]
  errors: string[]
}
export const tenantGatherAll = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: TenantGatherBundle; error?: string }> =>
  wrap(async () => {
    const c = clientOf(id)
    const errors: string[] = []
    const grab = async <T>(fn: () => Promise<T>, label: string, fallback: T): Promise<T> => {
      try { return await fn() } catch (e: any) { errors.push(`${label}：${e?.message || e}`); return fallback }
    }
    const [overview, tables, windows, prefs] = await Promise.all([
      grab(() => ocpTenantGatherOverview(c, tenantId), '统计概况', null),
      grab(() => ocpTenantGatherTables(c, tenantId), '表统计', [] as TenantGatherTable[]),
      grab(() => ocpTenantGatherAuto(c, tenantId), '自动收集窗口', [] as TenantGatherWindow[]),
      grab(() => ocpTenantGatherPrefs(c, tenantId), '收集策略', [] as TenantGatherPref[])
    ])
    return { overview, tables, windows, prefs, errors }
  })

/** 备份 tab 整包（备份是集群级能力，按 tenantId 过滤策略与任务） */
export interface TenantBackupBundle {
  ability: TenantBackupOverview['ability'] | null
  overview: TenantBackupOverview | null
  strategy: TenantBackupStrategy | null
  dataTasks: TenantBackupTask[]
  logTasks: TenantBackupTask[]
  errors: string[]
}
export const tenantBackupAll = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: TenantBackupBundle; error?: string }> =>
  wrap(async () => {
    const c = clientOf(id)
    const errors: string[] = []
    const grab = async <T>(fn: () => Promise<T>, label: string, fallback: T): Promise<T> => {
      try { return await fn() } catch (e: any) { errors.push(`${label}：${e?.message || e}`); return fallback }
    }
    const [ability, overview, strategy, dataTasks, logTasks] = await Promise.all([
      grab(() => ocpBackupAbility(c, clusterId), '备份能力', null),
      grab(() => ocpBackupOverview(c, clusterId), '备份总览', null),
      grab(() => ocpBackupStrategy(c, clusterId, tenantId), '备份策略', null),
      grab(() => ocpBackupDataTasks(c, clusterId, tenantId), '数据备份任务', [] as TenantBackupTask[]),
      grab(() => ocpBackupLogTasks(c, clusterId, tenantId), '日志备份任务', [] as TenantBackupTask[])
    ])
    return { ability: (overview as TenantBackupOverview | null)?.ability || ability, overview, strategy, dataTasks, logTasks, errors }
  })

export const tenantUsers = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: TenantUser[]; error?: string }> =>
  wrap(() => ocpTenantUsers(clientOf(id), clusterId, tenantId))

export const tenantTde = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: TenantTde | null; error?: string }> =>
  wrap(() => ocpTenantTde(clientOf(id), clusterId, tenantId))

// ---------- Unit 规格 / 克隆租户 / 创建备租户 ----------

export const unitSpecs = (id: string): Promise<{ ok: boolean; data?: UnitSpecRow[]; error?: string }> =>
  wrap(() => ocpUnitSpecs(clientOf(id)))

export const unitSpecCreate = (id: string, input: UnitSpecInput): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpUnitSpecCreate(clientOf(id), input) })

export const unitSpecUpdate = (id: string, specId: number, input: UnitSpecInput): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpUnitSpecUpdate(clientOf(id), specId, input) })

export const unitSpecDelete = (id: string, specId: number): Promise<{ ok: boolean; error?: string }> =>
  wrap(async () => { await ocpUnitSpecDelete(clientOf(id), specId) })

export const tenantClonePreCheck = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: TenantPreCheckResult; error?: string }> =>
  wrap(() => ocpTenantClonePreCheck(clientOf(id), clusterId, tenantId))

export const tenantClone = (id: string, clusterId: number, tenantId: number, input: TenantCloneInput): Promise<{ ok: boolean; data?: { taskId?: number; tenantId?: number }; error?: string }> =>
  wrap(() => ocpTenantClone(clientOf(id), clusterId, tenantId, input))

export const primaryTenantInfo = (id: string, clusterId: number, primaryTenantId: number): Promise<{ ok: boolean; data?: PrimaryTenantInfo; error?: string }> =>
  wrap(() => ocpPrimaryTenantInfo(clientOf(id), clusterId, primaryTenantId))

export const createStandbyTenant = (id: string, clusterId: number, input: StandbyTenantInput): Promise<{ ok: boolean; data?: { taskId?: number; tenantId?: number }; error?: string }> =>
  wrap(() => ocpCreateStandbyTenant(clientOf(id), clusterId, input))

// ---------- 备份恢复 / OBProxy / 巡检 / 平台管理（对齐 OCP 官方导航补齐的四个模块） ----------

export const backupBundle = (id: string): Promise<{ ok: boolean; data?: BackupBundle; error?: string }> =>
  wrap(() => ocpBackupBundle(clientOf(id)))

export const backupTasks = (id: string, kind: BackupTaskKind, size?: number): Promise<{ ok: boolean; data?: BackupTaskRow[]; error?: string }> =>
  wrap(() => ocpBackupTasks(clientOf(id), kind, size))

export const obproxyBundle = (id: string): Promise<{ ok: boolean; data?: { clusters: ObproxyCluster[]; updatedAt: number }; error?: string }> =>
  wrap(() => ocpObproxyBundle(clientOf(id)))

export const obproxyDetail = (id: string, clusterId: number): Promise<{ ok: boolean; data?: ObproxyCluster; error?: string }> =>
  wrap(() => ocpObproxyCluster(clientOf(id), clusterId))

export const obproxyParams = (id: string, clusterId: number): Promise<{ ok: boolean; data?: ObproxyParam[]; error?: string }> =>
  wrap(() => ocpObproxyParams(clientOf(id), clusterId))

export const inspectionBundle = (id: string): Promise<{ ok: boolean; data?: InspectionBundle; error?: string }> =>
  wrap(() => ocpInspectionBundle(clientOf(id)))

export const inspectionReport = (id: string, reportId: number): Promise<{ ok: boolean; data?: InspectionReport; error?: string }> =>
  wrap(() => ocpInspectionReport(clientOf(id), reportId))

export const inspectionTasks = (id: string, page?: number, size?: number): Promise<{ ok: boolean; data?: { items: InspectionReportRef[]; total: number }; error?: string }> =>
  wrap(() => ocpInspectionTasks(clientOf(id), page, size))

export const platformBundle = (id: string): Promise<{ ok: boolean; data?: PlatformBundle; error?: string }> =>
  wrap(() => ocpPlatformBundle(clientOf(id)))

export const platformProperties = (id: string, page?: number, size?: number): Promise<{ ok: boolean; data?: { items: PlatformProperty[]; total: number }; error?: string }> =>
  wrap(() => ocpPlatformProperties(clientOf(id), page, size))

export const platformLogins = (id: string, page?: number, size?: number): Promise<{ ok: boolean; data?: { items: PlatformLoginRecord[]; total: number }; error?: string }> =>
  wrap(() => ocpPlatformLogins(clientOf(id), page, size))
