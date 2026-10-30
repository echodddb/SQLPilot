/**
 * 云管平台接入的配置与会话管理（electron 侧）。
 * 平台清单存 config.json（不含密码），密码走 DPAPI 加密存 secrets.json（键 cloud:<id>）。
 * 客户端按平台缓存，会话 Cookie 复用；同一平台凭据变化时自动重建。
 */

import crypto from 'node:crypto'
import { loadConfig, saveConfig } from '../config'
import { appendAudit } from '../audit'
import { getPassword, setPassword, deletePassword, secretsAvailable } from '../secrets'
import * as obd from './obdirect'
import type { ObDirectPlatform } from './obdirect'
import * as obin from './obdirect/tenantIn'
import type { TenantLogin } from './obdirect/conn'
import { appendTask, finishTask, listTasks, getTask, clearTasks, taskActions, configureTaskLog } from './obdirect/tasklog'
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
export function getOraclePlatform(id: string): CloudOraclePlatform {  const p = (loadConfig().cloudPlatforms || []).find((x) => x.id === id)
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

/**
 * OceanBase 直连平台（没有 OCP，直接连 SQL 端口读系统视图）。
 * 与 OCP 平台互不影响：同一个应用里可以同时配一个 OCP 平台和一个直连平台。
 */
export function getObDirectPlatform(id: string): ObDirectPlatform {
  const p = (loadConfig().cloudPlatforms || []).find((x) => x.id === id)
  if (!p) throw new Error('云管平台未配置或已被删除')
  if (p.type !== 'obdirect') throw new Error(`该平台类型为 ${p.type}，不是 OceanBase 直连平台`)
  if (!p.host || !p.username) throw new Error('直连平台缺少主机或用户名，请在平台设置里补全')
  return {
    id: p.id,
    name: p.name,
    type: 'obdirect',
    host: p.host,
    port: Number(p.port) || 2881,
    username: p.username,
    defaultTenant: String((p as any).defaultTenant || '')
  }
}

/** 该平台是否走直连模式（所有数据入口据此分派，避免每个函数都去 loadConfig） */
export function isDirectPlatform(id: string): boolean {
  const p = (loadConfig().cloudPlatforms || []).find((x) => x.id === id)
  return !!p && p.type === 'obdirect'
}

/** 直连平台的密码：没有 OCP 的会话概念，每次取用即可（DPAPI 解密） */
function directPassword(id: string): string {
  const pw = getPassword(secretKey(id))
  if (!pw) throw new Error('平台尚未保存密码，请先在云管平台设置中填写')
  return pw
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
  if (input.type === 'obdirect') {
    return saveObDirectPlatform(cfg, input, effPassword, id, exists, password !== undefined && password !== '')
  }

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

/** OceanBase 直连平台的保存：先真连一次拿到版本与拓扑，再落盘 */
async function saveObDirectPlatform(
  cfg: any,
  input: CloudPlatform,
  effPassword: string,
  id: string,
  exists: boolean,
  newPassword: boolean
): Promise<SaveResult> {
  const host = String(input.host || '').trim()
  const username = String(input.username || '').trim()
  const port = Number(input.port) || 2881
  if (!host) return { ok: false, error: '请填写 OceanBase 主机' }
  if (!username) return { ok: false, error: '请填写用户名（形如 root@sys）' }
  if (!username.includes('@')) return { ok: false, error: '用户名需带租户后缀，例如 root@sys' }

  const platform: CloudPlatform = {
    id,
    name: String(input.name || '').trim() || `${host}:${port}`,
    type: 'obdirect',
    host,
    port,
    username
  }

  try {
    await obd.test({ id, name: platform.name, type: 'obdirect', host, port, username }, effPassword)
  } catch (e: any) {
    return { ok: false, error: e?.message || '连接 OceanBase 失败' }
  }

  if (newPassword) setPassword(secretKey(id), effPassword)
  if (exists) {
    cfg.cloudPlatforms = cfg.cloudPlatforms.map((p: CloudPlatform) => (p.id === id ? platform : p))
  } else {
    cfg.cloudPlatforms.push(platform)
  }
  saveConfig(cfg)
  // 换目标或换密码后旧连接池必须失效
  obd.dropPool(id)
  obd.dropCapability(id)
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
  obd.dropPool(id)
  obd.dropCapability(id)
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
  const usingSaved = !(password && password !== '')
  const eff = usingSaved ? (input.id ? getPassword(secretKey(input.id)) : '') : password!
  if (!eff) return { ok: false, error: '请填写密码' }
  if (usingSaved) {
    // 用已保存密码测试时不允许换目标：否则渲染层传一个别的 host/baseUrl，
    // 主进程就把 DPAPI 里的管理员口令发给了攻击者主机（conn:test 已有同款校验）
    const saved = (loadConfig().cloudPlatforms || []).find((x) => x.id === input.id)
    if (!saved) return { ok: false, error: '平台不存在，请重新填写密码后测试' }
    const sameTarget =
      saved.type === input.type &&
      String(saved.host || '') === String(input.host || '') &&
      Number(saved.port || 0) === Number(input.port || 0) &&
      String(saved.username || '') === String(input.username || '') &&
      String(saved.baseUrl || '') === String(input.baseUrl || '') &&
      String(saved.serviceName || '') === String(input.serviceName || '')
    if (!sameTarget) {
      return { ok: false, error: '使用已保存密码时不能修改地址/端口/用户名/服务名；测试新目标请先填写密码。' }
    }
  }
  if (input.type === 'obdirect') {
    if (!input.host || !input.username) return { ok: false, error: '请填写主机与用户名（形如 root@sys）' }
    try {
      const r = await obd.test({
        id: input.id || 'tmp-obdirect',
        name: input.name,
        type: 'obdirect',
        host: String(input.host),
        port: Number(input.port) || 2881,
        username: String(input.username)
      }, eff)
      return {
        ok: true,
        version: r.version,
        mode: 'direct',
        note: `集群 ${r.clusterName} · ${r.topology.servers} 台 OBServer / ${r.topology.zones} 个 Zone / ${r.topology.tenants} 个租户 · 可用视图 ${r.capability.available}/${r.capability.total}`
      }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }
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
    if (p?.type === 'obdirect') {
      // 直连模式"登录"就是连通性检查：没有会话，也不缓存登录态
      const st = await obd.status(getObDirectPlatform(id), directPassword(id))
      if (!st.ok) return { ok: false, error: st.error || '连接 OceanBase 失败' }
      return {
        ok: true,
        info: { version: st.version || '', edition: `OceanBase 直连 · ${st.clusterName || ''}`, buildTime: '' }
      }
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
  isDirectPlatform(id)
    ? wrap(() => obd.overview(getObDirectPlatform(id), directPassword(id)))
    : wrap(() => ocpOverview(clientOf(id)))

export const clusters = (id: string): Promise<{ ok: boolean; data?: CloudCluster[]; error?: string }> =>
  isDirectPlatform(id)
    ? wrap(() => obd.clusters(getObDirectPlatform(id), directPassword(id)))
    : wrap(() => ocpClusters(clientOf(id)))

export const clusterDetail = (id: string, clusterId: number): Promise<{ ok: boolean; data?: CloudClusterDetail; error?: string }> =>
  isDirectPlatform(id)
    ? wrap(() => obd.clusterDetail(getObDirectPlatform(id), directPassword(id), clusterId))
    : wrap(() => ocpClusterDetail(clientOf(id), clusterId))

export const tenants = (id: string): Promise<{ ok: boolean; data?: CloudTenant[]; error?: string }> =>
  isDirectPlatform(id)
    ? wrap(() => obd.tenants(getObDirectPlatform(id), directPassword(id)))
    : wrap(() => ocpTenants(clientOf(id)))

export const tenantDetail = (id: string, clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: CloudTenantDetail; error?: string }> =>
  isDirectPlatform(id)
    ? wrap(async () => {
        const d = await obd.tenantDetail(getObDirectPlatform(id), directPassword(id), tenantId)
        if (!d) throw new Error('租户不存在或已删除')
        return d
      })
    : wrap(() => ocpTenantDetail(clientOf(id), clusterId, tenantId))

export const hosts = (id: string): Promise<{ ok: boolean; data?: CloudHost[]; error?: string }> =>
  isDirectPlatform(id)
    ? wrap(() => obd.hosts(getObDirectPlatform(id), directPassword(id)))
    : wrap(() => ocpHosts(clientOf(id)))

export const alarms = (id: string, opts: AlarmQuery = {}): Promise<{ ok: boolean; data?: AlarmListResult; error?: string }> =>
  isDirectPlatform(id)
    ? wrap(async () => {
        // 直连模式的告警是规则引擎算出来的当前状态，没有分页与"历史"概念，
        // 这里按 AlarmQuery 的级别过滤后整包返回，保持与 OCP 分支同形。
        const r = await obd.alarms(getObDirectPlatform(id), directPassword(id))
        const level = Number((opts as any)?.level) || 0
        const items = level ? r.items.filter((a) => a.level === level) : r.items
        return { items, total: items.length, warnings: r.skipped } as unknown as AlarmListResult
      })
    : wrap(() => ocpAlarms(clientOf(id), opts))

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

// ---------- 直连模式（无 OCP）专有接口 ----------
// 这些接口只对 type === 'obdirect' 的平台有意义，OCP 平台调用会直接报错，
// 避免渲染层误用时拿到一堆空数据而不是明确的提示。

function requireDirect(id: string): { p: ObDirectPlatform; pw: string } {
  if (!isDirectPlatform(id)) throw new Error('该平台不是 OceanBase 直连模式')
  return { p: getObDirectPlatform(id), pw: directPassword(id) }
}

/** 能力探测结果：界面据此裁决哪些页签可用 */
export const directCapability = (id: string): Promise<{ ok: boolean; data?: any; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    const cap = await obd.capability(p, pw)
    return { version: cap.version, clusterName: cap.clusterName, tenant: cap.tenant, views: cap.views, at: cap.at }
  })

export const directTopSql = (
  id: string,
  opts: { hours?: number; limit?: number; minElapsedMs?: number } = {}
): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.topSqlOf(p, pw, opts)
  })

export const directSqlText = (id: string, sqlId: string): Promise<{ ok: boolean; data?: string; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.sqlTextOf(p, pw, String(sqlId || ''))
  })

export const directParameters = (
  id: string,
  opts: { keyword?: string; limit?: number } = {}
): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.parametersOf(p, pw, opts)
  })

export const directEvents = (
  id: string,
  opts: { limit?: number; hours?: number; keyword?: string } = {}
): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.eventsOf(p, pw, opts)
  })

export const directOpenTransactions = (id: string): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.openTransactions(p, pw)
  })

/**
 * 写操作统一走这里：记录审计 + 落一条本地任务日志，失败也留痕。
 * 任务日志与审计是两套：审计面向追责（精简），任务日志面向“我点了什么、执行了哪些语句”（可查详情）。
 */
async function runWrite(
  id: string,
  action: string,
  detail: string,
  run: (p: ObDirectPlatform, pw: string) => Promise<{ ok: boolean; message: string; steps?: string[] }>
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> {
  const started = Date.now()
  try {
    const { p, pw } = requireDirect(id)
    const r = await run(p, pw)
    appendAudit({
      kind: 'ui.error',
      detail: `[直连写操作] ${action} ${detail} → ${r.ok ? '成功' : '失败'}：${r.message}`
    } as any)
    appendTask({
      id: taskId(started),
      at: started,
      platformId: id,
      platformName: p.name,
      clusterName: p.name,
      action,
      target: detail,
      status: r.ok ? 'ok' : 'fail',
      ok: r.ok,
      message: r.message,
      steps: r.steps || [],
      durationMs: Date.now() - started
    })
    return r.ok ? { ok: true, data: { message: r.message } } : { ok: false, error: r.message }
  } catch (e: any) {
    const msg = e?.message || String(e)
    appendAudit({ kind: 'ui.error', detail: `[直连写操作] ${action} ${detail} → 异常：${msg}` } as any)
    appendTask({
      id: taskId(started),
      at: started,
      platformId: id,
      platformName: platformNameSafe(id),
      clusterName: platformNameSafe(id),
      action,
      target: detail,
      status: 'fail',
      ok: false,
      message: msg,
      steps: [],
      durationMs: Date.now() - started
    })
    return { ok: false, error: msg }
  }
}

/** 任务 id：时间戳 36 进制 + 随机后缀，足够避免同毫秒撞车 */
function taskId(at: number): string {
  return `t${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 后台任务：提交时落一条 running 记录并立即返回 taskId，执行完再追加终态记录。
 *
 * 为什么需要：删除租户是 DROP TENANT，实例忙时要跑几十秒；早先界面同步等它，
 * 弹窗整个执行期间既不能关也没有进度，观感就是"卡死、关不掉"。
 * 现在提交即返回，用户可以直接关掉页面，回「任务日志」看结果。
 */
function startBackgroundTask(
  id: string,
  action: string,
  target: string,
  run: (p: ObDirectPlatform, pw: string) => Promise<{ ok: boolean; message: string; steps?: string[] }>
): { taskId: string; platformName: string } {
  // 平台不存在/没密码这类错误要在提交阶段就报出来，而不是写一条注定失败的任务
  const { p, pw } = requireDirect(id)
  const started = Date.now()
  const tid = taskId(started)
  appendTask({
    id: tid,
    at: started,
    platformId: id,
    platformName: p.name,
    clusterName: p.name,
    action,
    target,
    status: 'running',
    ok: false,
    message: '已提交，正在执行…',
    steps: [],
    durationMs: 0
  })
  void (async () => {
    try {
      const r = await run(p, pw)
      appendAudit({
        kind: 'ui.error',
        detail: `[直连写操作] ${action} ${target} → ${r.ok ? '成功' : '失败'}：${r.message}`
      } as any)
      finishTask(tid, { status: r.ok ? 'ok' : 'fail', message: r.message, steps: r.steps })
    } catch (e: any) {
      const msg = e?.message || String(e)
      appendAudit({ kind: 'ui.error', detail: `[直连写操作] ${action} ${target} → 异常：${msg}` } as any)
      finishTask(tid, { status: 'fail', message: msg })
    }
  })()
  return { taskId: tid, platformName: p.name }
}

function platformNameSafe(id: string): string {
  try {
    return (loadConfig().cloudPlatforms || []).find((x) => x.id === id)?.name || id
  } catch {
    return id
  }
}

export const directMajorFreeze = (id: string): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runWrite(id, 'ALERT SYSTEM MAJOR FREEZE', '', (p, pw) => obd.majorFreeze(p, pw))

export const directMergeSuspend = (
  id: string,
  suspended: boolean
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runWrite(id, suspended ? 'SUSPEND MERGE' : 'RESUME MERGE', '', (p, pw) => obd.setMergeSuspended(p, pw, suspended))

export const directSetParameter = (
  id: string,
  name: string,
  value: string,
  tenant?: string
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runWrite(id, 'SET PARAMETER', `${tenant ? `租户 ${tenant} ` : ''}${name}=${value}`, (p, pw) =>
    obd.setParameter(p, pw, name, value, tenant)
  )

export const directKillSession = (
  id: string,
  sessionId: number
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runWrite(id, 'KILL SESSION', String(sessionId), (p, pw) => obd.killSession(p, pw, sessionId))

// ---------- 直连任务日志（本地 JSONL） ----------
// 直连没有 OCP 的任务子系统，这里用本地文本存档：能分页查、能看详情、能一键清理。

export const initDirectTaskLog = (dir: string): void => configureTaskLog(dir)

export const directTasks = (q: any): Promise<{ ok: boolean; data?: any; error?: string }> =>
  wrap(async () => listTasks(q || {}))

export const directTaskDetail = (id: string): Promise<{ ok: boolean; data?: any; error?: string }> =>
  wrap(async () => getTask(String(id || '')))

export const directTaskActions = (): Promise<{ ok: boolean; data?: string[]; error?: string }> =>
  wrap(async () => taskActions())

export const directClearTasks = (
  opts: { before?: number } = {}
): Promise<{ ok: boolean; data?: { removed: number; kept: number }; error?: string }> =>
  wrap(async () => clearTasks(opts || {}))

// ---------- 业务租户凭据 ----------
// 用于「租户内部」操作（建库、建账号、授权）。密码走 DPAPI 加密存储，与平台密码同一套机制。

const tenantCredKey = (id: string, tenant: string): string => `obtenant:${id}:${tenant}`

export function tenantLoginOf(id: string, tenant: string): TenantLogin | null {
  const raw = getPassword(tenantCredKey(id, tenant))
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as { user?: string; password?: string }
    if (!j.user || j.password === undefined) return null
    return { user: String(j.user), password: String(j.password), tenant }
  } catch {
    return null
  }
}

export const saveTenantCredential = (
  id: string,
  tenant: string,
  user: string,
  password: string
): { ok: boolean; error?: string; keptPassword?: boolean } => {
  if (!secretsAvailable()) return { ok: false, error: '系统加密不可用（DPAPI），为避免密码明文落盘，本次保存已取消' }
  const u = String(user || '').trim()
  if (!u) return { ok: false, error: '请填写账号' }
  const key = tenantCredKey(id, tenant)
  const pw = String(password ?? '')
  // 「密码留空」在界面上的语义是"只改账号，密码不动"。
  // 早先直接覆盖成空串，凭据就变成空密码，之后所有租户内查询都报
  // Access denied ... (using password: NO)，而界面上仍显示"已录入"。
  if (!pw) {
    const prev = tenantLoginOf(id, tenant)
    setPassword(key, JSON.stringify({ user: u, password: prev ? prev.password : '' }))
    return { ok: true, keptPassword: !!prev }
  }
  setPassword(key, JSON.stringify({ user: u, password: pw }))
  return { ok: true }
}

export const tenantCredentialStatus = (id: string, tenant: string): { has: boolean; user?: string } => {
  const login = tenantLoginOf(id, tenant)
  return login ? { has: true, user: login.user } : { has: false }
}

export const clearTenantCredential = (id: string, tenant: string): { ok: boolean } => {
  deletePassword(tenantCredKey(id, tenant))
  return { ok: true }
}

/**
 * 把驱动抛出的英文鉴权错误转成可操作的中文提示。
 *
 * 典型现场：凭据里密码存成了空串，mysql2 就不发密码包，OB 回
 * `Access denied for user 'root'@'x.x.x.x' (using password: NO)`——
 * 字面上看不出"密码为空"，用户只会以为账号不对。
 */
function friendlyTenantLoginError(tenant: string, user: string, err: any): Error {
  const raw = String((err && err.message) || err || '')
  if (/Access denied/i.test(raw) && /using password:\s*NO/i.test(raw)) {
    return new Error(
      `租户 ${tenant} 的账号 ${user} 未携带密码（using password: NO）。` +
        '本机保存的凭据里密码为空，请到租户详情「连接」页重新填写密码并保存。'
    )
  }
  if (/Access denied/i.test(raw)) {
    return new Error(`租户 ${tenant} 的账号 ${user} 登录被拒绝：账号或密码不正确。原始错误：${raw}`)
  }
  if (/Unknown MySQL server host|ECONNREFUSED|ETIMEDOUT|timeout/i.test(raw)) {
    return new Error(`连接租户 ${tenant} 失败：${raw}。请确认实例地址、端口与连接白名单。`)
  }
  return err instanceof Error ? err : new Error(raw)
}

/** 带凭据执行租户内部操作：没有凭据时给出统一的可操作提示 */
async function withTenantLogin<T>(
  id: string,
  tenant: string,
  fn: (p: ObDirectPlatform, login: TenantLogin) => Promise<T>
): Promise<T> {
  const login = tenantLoginOf(id, tenant)
  if (!login) {
    throw new Error(`尚未录入租户 ${tenant} 的凭据。请先在租户详情里录入业务账号，再执行租户内部操作。`)
  }
  const { p } = requireDirect(id)
  try {
    return await fn(p, login)
  } catch (e: any) {
    throw friendlyTenantLoginError(tenant, login.user, e)
  }
}

/** 租户内部写操作：统一记任务日志 */
async function runTenantWrite(
  id: string,
  tenant: string,
  action: string,
  target: string,
  run: (p: ObDirectPlatform, login: TenantLogin) => Promise<{ ok: boolean; message: string; steps: string[] }>
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> {
  const started = Date.now()
  try {
    const r = await withTenantLogin(id, tenant, run)
    appendTask({
      id: taskId(started),
      at: started,
      platformId: id,
      platformName: platformNameSafe(id),
      clusterName: platformNameSafe(id),
      action,
      target: `${tenant} / ${target}`,
      status: r.ok ? 'ok' : 'fail',
      ok: r.ok,
      message: r.message,
      steps: r.steps,
      durationMs: Date.now() - started
    })
    return r.ok ? { ok: true, data: { message: r.message } } : { ok: false, error: r.message }
  } catch (e: any) {
    const msg = e?.message || String(e)
    appendTask({
      id: taskId(started),
      at: started,
      platformId: id,
      platformName: platformNameSafe(id),
      clusterName: platformNameSafe(id),
      action,
      target: `${tenant} / ${target}`,
      status: 'fail',
      ok: false,
      message: msg,
      steps: [],
      durationMs: Date.now() - started
    })
    return { ok: false, error: msg }
  }
}

export const directTestTenantLogin = (
  id: string,
  tenant: string,
  mode: 'MYSQL' | 'ORACLE' = 'MYSQL'
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  wrap(async () => {
    // Oracle 模式的探测语句与 MySQL 不同，必须把模式透传下去
    const r = await withTenantLogin(id, tenant, (p, login) => obin.testTenantLogin(p, login, mode))
    if (!r.ok) throw new Error(r.message)
    return { message: r.message }
  })

/** 库列表（含系统内置库）：只读，不记任务日志 */
export const directTenantDbsAs = (id: string, tenant: string): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => withTenantLogin(id, tenant, (p, login) => obin.databasesAs(p, login)))

export const directCreateDb = (
  id: string,
  tenant: string,
  input: { name: string; charset?: string }
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runTenantWrite(id, tenant, 'CREATE DATABASE', String(input?.name || ''), (p, login) =>
    obin.createDatabaseAs(p, login, input)
  )

export const directDropDb = (
  id: string,
  tenant: string,
  name: string
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runTenantWrite(id, tenant, 'DROP DATABASE', name, (p, login) => obin.dropDatabaseAs(p, login, name))

export const directTenantUsersAs = (
  id: string,
  tenant: string,
  mode: 'MYSQL' | 'ORACLE'
): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => withTenantLogin(id, tenant, (p, login) => obin.usersAs(p, login, mode)))

export const directCreateUser = (
  id: string,
  tenant: string,
  input: { name: string; host?: string; password: string; mode: 'MYSQL' | 'ORACLE' }
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runTenantWrite(id, tenant, 'CREATE USER', String(input?.name || ''), (p, login) =>
    obin.createUserAs(p, login, input)
  )

export const directDropUser = (
  id: string,
  tenant: string,
  input: { name: string; host?: string; mode: 'MYSQL' | 'ORACLE' }
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runTenantWrite(id, tenant, 'DROP USER', String(input?.name || ''), (p, login) => obin.dropUserAs(p, login, input))

export const directGrant = (
  id: string,
  tenant: string,
  input: {
    name: string
    host?: string
    database?: string
    databases?: string[]
    privileges: string | string[]
    mode: 'MYSQL' | 'ORACLE'
  }
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runTenantWrite(id, tenant, 'GRANT', String(input?.name || ''), (p, login) => obin.grantAs(p, login, input))

export const directGrants = (
  id: string,
  tenant: string,
  input: { name: string; host?: string }
): Promise<{ ok: boolean; data?: string[]; error?: string }> =>
  wrap(async () => withTenantLogin(id, tenant, (p, login) => obin.grantsAs(p, login, input)))

// ---------- 直连模式的租户生命周期 ----------
// 与上面的 createTenant / deleteTenant / tenantSetLocked（OCP 任务框架）**互不复用**：
// 直连是直接在 sys 租户里跑 DDL，没有任务 ID、没有回滚，返回结构也不一样。
// 渲染层按 access === 'direct' 显式选边，不做「一个函数两种后端」的隐式分派。

/** Unit 规格清单：新建租户向导用 */
export const directUnitConfigs = (id: string): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.unitConfigsOf(p, pw)
  })

/** 资源池清单：向导里做重名提示 */
export const directResourcePools = (id: string): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.resourcePoolsOf(p, pw)
  })

/**
 * 建租户。失败时也把 data.steps 带回来——直连没有回滚，
 * 用户需要知道前面已经建了哪些对象才能手工收尾。
 */
export const directCreateTenant = (
  id: string,
  input: any,
  onStep?: (e: any) => void
): Promise<{ ok: boolean; data?: { message: string; steps: string[]; warning?: string; connections?: { label: string; command: string }[] }; error?: string; steps?: string[] }> => {
  if (!isDirectPlatform(id)) return Promise.resolve({ ok: false, error: '该平台不是 OceanBase 直连模式' })
  let p: ObDirectPlatform
  let pw: string
  try {
    p = getObDirectPlatform(id)
    pw = directPassword(id)
  } catch (e: any) {
    return Promise.resolve({ ok: false, error: e?.message || String(e) })
  }
  const started = Date.now()
  return obd.createTenantDirect(p, pw, input, onStep).then((r) => {
    appendAudit({
      kind: 'ui.error',
      detail: `[直连租户] 创建 ${input?.name ?? ''} → ${r.ok ? '成功' : '失败'}：${r.message}${r.warning ? `（${r.warning}）` : ''}`
    } as any)
    appendTask({
      id: taskId(started),
      at: started,
      platformId: id,
      platformName: p.name,
      clusterName: p.name,
      action: 'CREATE TENANT',
      target: String(input?.name || ''),
      status: r.ok ? 'ok' : 'fail',
      ok: r.ok,
      message: r.warning ? `${r.message}（${r.warning}）` : r.message,
      steps: r.steps,
      durationMs: Date.now() - started
    })
    return r.ok
      ? { ok: true, data: { message: r.message, steps: r.steps, warning: r.warning, connections: r.connections } }
      : { ok: false, error: r.message, steps: r.steps }
  })
}

/** 删除租户：提交到后台执行，立即返回 taskId（结果在「任务日志」里看） */
export const directDropTenant = async (
  id: string,
  tenantName: string
): Promise<{ ok: boolean; data?: { message: string; taskId?: string }; error?: string }> => {
  try {
    const name = String(tenantName || '').trim()
    const { taskId: tid } = startBackgroundTask(id, 'DROP TENANT', name, async (p, pw) => {
      const r = await obd.dropTenantDirect(p, pw, name)
      // 凭据的键是「平台 + 租户名」，没有租户 ID 参与。删除后若再建同名租户，
      // 旧凭据会被新租户直接继承（表现为新租户莫名其妙能登进旧账号）。
      // 删除成功即清除，保证同名新租户从"未录入"开始。
      if (r.ok) clearTenantCredential(id, name)
      return r
    })
    return { ok: true, data: { taskId: tid, message: `已提交删除租户 ${name}，可在「任务日志」查看结果` } }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 锁定 / 解锁：同样后台执行，避免实例慢时把弹窗卡住 */
export const directSetTenantLocked = async (
  id: string,
  tenantName: string,
  locked: boolean
): Promise<{ ok: boolean; data?: { message: string; taskId?: string }; error?: string }> => {
  try {
    const name = String(tenantName || '').trim()
    const action = locked ? 'LOCK TENANT' : 'UNLOCK TENANT'
    const { taskId: tid } = startBackgroundTask(id, action, name, (p, pw) =>
      obd.setTenantLockedDirect(p, pw, name, locked)
    )
    return { ok: true, data: { taskId: tid, message: `${locked ? '锁定' : '解锁'}请求已提交，可在「任务日志」查看结果` } }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 新建 Unit 规格（某个集群内，独立于建租户流程） */
export const directCreateUnitConfig = (
  id: string,
  spec: any
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runWrite(id, 'CREATE RESOURCE UNIT', String(spec?.name || ''), (p, pw) =>
    obd.createUnitConfigDirect(p, pw, spec)
  )

export const directDropUnitConfig = (
  id: string,
  name: string
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runWrite(id, 'DROP RESOURCE UNIT', name, (p, pw) => obd.dropUnitConfigDirect(p, pw, name))

/** 新建资源池：池的生命周期独立于租户，建租户时只挑空闲池 */
export const directCreateResourcePool = (
  id: string,
  input: any
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runWrite(id, 'CREATE RESOURCE POOL', String(input?.name || ''), (p, pw) =>
    obd.createResourcePoolDirect(p, pw, input)
  )

// ---------- 直连：租户内部数据（只读） ----------
// 与 OCP 的 cloudTenantDbs / cloudTenantSessions 等是两套接口：
// 那边按 clusterId+tenantId 走 OCP REST，这边直接在 sys 租户里查系统视图。

export const directTenantSessions = (
  id: string,
  tenantName: string,
  limit = 200
): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.tenantSessionsOf(p, pw, tenantName, limit)
  })

export const directTenantDatabases = (
  id: string,
  tenantId: number
): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.tenantDatabasesOf(p, pw, Number(tenantId) || 0)
  })

export const directTenantUsers = (
  id: string,
  tenantId: number
): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.tenantUsersOf(p, pw, Number(tenantId) || 0)
  })

export const directTenantParams = (
  id: string,
  tenantId: number,
  opts: { keyword?: string; limit?: number } = {}
): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.tenantParametersOf(p, pw, Number(tenantId) || 0, opts)
  })

/** 租户连接串（详情页「连接」tab）：按兼容模式区分 oracle / mysql / obproxy 三种形态 */
export const directTenantConnections = (
  id: string,
  tenant: string,
  mode: 'MYSQL' | 'ORACLE'
): Promise<{ ok: boolean; data?: { label: string; command: string }[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.tenantConnectionsOf(p, pw, String(tenant || ''), mode === 'ORACLE' ? 'ORACLE' : 'MYSQL')
  })

export const directTenantTopSql = (  id: string,
  tenantId: number,
  opts: { hours?: number; limit?: number } = {}
): Promise<{ ok: boolean; data?: any[]; error?: string }> =>
  wrap(async () => {
    const { p, pw } = requireDirect(id)
    return obd.tenantTopSqlOf(p, pw, Number(tenantId) || 0, opts)
  })

/** 回收资源池：DROP TENANT 不会自动删池，残留的池需在这里清理 */export const directDropResourcePool = (
  id: string,
  name: string
): Promise<{ ok: boolean; data?: { message: string }; error?: string }> =>
  runWrite(id, 'DROP RESOURCE POOL', name, (p, pw) => obd.dropResourcePoolDirect(p, pw, name))
