/**
 * 直连模式的租户管理状态与动作。
 *
 * 刻意与 `cloud/state.ts` 里的 OCP 租户动作分开：
 *   - OCP：cloudCreateTenant / cloudDeleteTenant / cloudTenantSetLocked，走 REST + 任务框架，返回 taskId；
 *   - 直连：cloudDirectCreateTenant / cloudDirectDropTenant / cloudDirectSetTenantLocked，
 *           在 sys 租户里直接执行 DDL，**没有回滚**；删除/锁定已改为后台任务（返回 taskId，
 *           结果落本地任务日志），建租户仍是同步逐条执行 + 进度事件。
 * 两者返回结构不同，混在一个函数里做隐式分派只会让调用方猜。这里显式分开。
 */

import { reactive } from 'vue'
import { cloud } from './state'

export const directTenant = reactive({
  /** 新建租户弹窗 */
  createOpen: false,
  /** 新建租户的目标平台（直连平台 = 一个集群） */
  createPlatformId: '',
  /** 从详情页「查看任务」跳过来时要展开的任务 id（任务日志页消费后清空） */
  focusTaskId: '' as string,
  /** 租户页的集群范围：0 表示「全部集群」合并展示 */
  scopeClusterId: 0,
  /**
   * Unit / 资源池管理页的集群范围（与租户列表分开）。
   * 默认 0，进入页面时自动落到第一个集群——这两页必须落到具体集群才有意义。
   */
  adminScopeClusterId: 0
})

/** clusterId → 直连平台 id（cloud.directOf 由 loadDirect 填充） */
export function platformOfCluster(clusterId: number): string {
  return cloud.directOf[clusterId] || ''
}

/** 当前范围内的集群名，用于弹窗标题 */
export function clusterNameOf(clusterId: number): string {
  return cloud.clusters.find((c) => c.id === clusterId)?.name || ''
}

/** 是否某个集群能定位到直连平台（决定「新建租户」是否可点） */
export function canManage(clusterId: number): boolean {
  return !!platformOfCluster(clusterId)
}

export function openCreate(clusterId: number): boolean {
  const pid = platformOfCluster(clusterId)
  if (!pid) return false
  directTenant.createPlatformId = pid
  directTenant.createOpen = true
  return true
}

export function closeCreate(): void {
  directTenant.createOpen = false
  directTenant.createPlatformId = ''
}

export interface DirectCreateResult {
  ok: boolean
  message?: string
  warning?: string
  steps?: string[]
  error?: string
  /** 成功后的连接串（Oracle / MySQL / OBProxy 三种形态） */
  connections?: { label: string; command: string }[]
}

/** 建租户：失败时把已执行的语句一起带回，方便用户判断要不要手工清理 */
export async function createDirectTenant(
  platformId: string,
  input: CloudDirectCreateTenantInput,
  runId?: string
): Promise<DirectCreateResult> {
  const r = await window.sqlpilot.cloudDirectCreateTenant(platformId, input, runId)
  if (!r.ok) return { ok: false, error: r.error || '创建失败', steps: (r as any).steps || [] }
  return {
    ok: true,
    message: r.data?.message,
    warning: r.data?.warning,
    steps: r.data?.steps,
    connections: r.data?.connections
  }
}

/** 订阅建租户的执行进度；返回取消订阅函数 */
export function onDirectTenantLog(
  cb: (e: { runId: string; at: number; phase: string; status: 'start' | 'ok' | 'warn' | 'fail'; title: string; sql?: string; message?: string }) => void
): () => void {
  return window.sqlpilot.onDirectTenantLog(cb)
}

/**
 * 删除租户：主进程只做「提交」，真正的 DROP TENANT 在后台跑，
 * 立即返回 taskId。界面据此关闭弹窗，去「任务日志」看执行结果。
 */
export async function dropDirectTenant(
  platformId: string,
  tenantName: string
): Promise<{ ok: boolean; message?: string; taskId?: string; error?: string }> {
  const r = await window.sqlpilot.cloudDirectDropTenant(platformId, tenantName)
  return r.ok
    ? { ok: true, message: r.data?.message, taskId: r.data?.taskId }
    : { ok: false, error: r.error || '删除失败' }
}

/** 锁定 / 解锁：同样后台执行，返回 taskId */
export async function lockDirectTenant(
  platformId: string,
  tenantName: string,
  locked: boolean
): Promise<{ ok: boolean; message?: string; taskId?: string; error?: string }> {
  const r = await window.sqlpilot.cloudDirectSetTenantLocked(platformId, tenantName, locked)
  return r.ok
    ? { ok: true, message: r.data?.message, taskId: r.data?.taskId }
    : { ok: false, error: r.error || (locked ? '锁定失败' : '解锁失败') }
}

export async function unitConfigsOf(platformId: string): Promise<CloudDirectUnitConfig[]> {
  const r = await window.sqlpilot.cloudDirectUnitConfigs(platformId)
  return r.ok ? r.data || [] : []
}

/** 新建 Unit 规格：属于某个集群，独立于建租户流程 */
export async function createUnitConfig(
  platformId: string,
  spec: { name: string; maxCpu: number; minMemory: number; maxMemory: number; logDiskSize: number }
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const r = await window.sqlpilot.cloudDirectCreateUnitConfig(platformId, spec)
  return r.ok ? { ok: true, message: r.data?.message } : { ok: false, error: r.error || '创建失败' }
}

export async function dropUnitConfig(platformId: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const r = await window.sqlpilot.cloudDirectDropUnitConfig(platformId, name)
  return r.ok ? { ok: true } : { ok: false, error: r.error || '删除失败' }
}

export interface DirectResourcePool {
  id: number
  name: string
  tenantId: number
  tenantName: string
  unitCount: number
  unitConfigId: number
  unitConfigName: string
  zoneList: string
  status: string
}

export async function resourcePoolsOf(platformId: string): Promise<DirectResourcePool[]> {
  const r = await window.sqlpilot.cloudDirectResourcePools(platformId)
  return r.ok ? (r.data as DirectResourcePool[]) || [] : []
}

export async function dropResourcePool(platformId: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const r = await window.sqlpilot.cloudDirectDropResourcePool(platformId, name)
  return r.ok ? { ok: true } : { ok: false, error: r.error || '删除失败' }
}

// ---------------- 租户内部数据（直连只读） ----------------

export async function tenantSessions(platformId: string, tenantName: string, limit = 200) {
  const r = await window.sqlpilot.cloudDirectTenantSessions(platformId, tenantName, limit)
  return r.ok ? r.data || [] : []
}

export async function tenantDatabases(platformId: string, tenantId: number) {
  const r = await window.sqlpilot.cloudDirectTenantDbs(platformId, tenantId)
  return r.ok ? r.data || [] : []
}

export async function tenantUsers(platformId: string, tenantId: number) {
  const r = await window.sqlpilot.cloudDirectTenantUsers(platformId, tenantId)
  return r.ok ? r.data || [] : []
}

export async function tenantParams(platformId: string, tenantId: number, keyword?: string) {
  const r = await window.sqlpilot.cloudDirectTenantParams(platformId, tenantId, { keyword, limit: 300 })
  return r.ok ? r.data || [] : []
}

export async function tenantTopSql(platformId: string, tenantId: number, hours = 24) {
  const r = await window.sqlpilot.cloudDirectTenantTopSql(platformId, tenantId, { hours, limit: 50 })
  return r.ok ? r.data || [] : []
}

/** 详情页「连接」tab：三种连接串（Oracle/MySQL/OBProxy） */
export async function tenantConnections(platformId: string, tenant: string, mode: 'MYSQL' | 'ORACLE') {
  const r = await window.sqlpilot.cloudDirectTenantConnections(platformId, tenant, mode)
  return r.ok ? r.data || [] : []
}

// ---------------- 业务租户凭据 ----------------

export async function tenantCredStatus(platformId: string, tenant: string): Promise<{ has: boolean; user?: string }> {
  const r = await window.sqlpilot.cloudTenantCredStatus(platformId, tenant)
  return r.ok && r.data ? r.data : { has: false }
}

export async function saveTenantCred(platformId: string, tenant: string, user: string, password: string) {
  const r = await window.sqlpilot.cloudTenantCredSave(platformId, tenant, user, password)
  // keptPassword：密码框留空时后端沿用了原密码（不是把密码清空）
  return r.ok
    ? { ok: true, keptPassword: !!r.data?.keptPassword }
    : { ok: false, keptPassword: false, error: r.error || '保存失败' }
}

export async function clearTenantCred(platformId: string, tenant: string) {
  const r = await window.sqlpilot.cloudTenantCredClear(platformId, tenant)
  return r.ok ? { ok: true } : { ok: false, error: r.error || '清除失败' }
}

/**
 * 试连业务租户。
 * mode 必须传：Oracle 模式的探测语句与 MySQL 不同（SELECT 1 没有 FROM 会报语法错，
 * 之前就因此把「凭据其实可用」误判成连接失败）。
 */
export async function testTenantLogin(platformId: string, tenant: string, mode: 'MYSQL' | 'ORACLE' = 'MYSQL') {
  const r = await window.sqlpilot.cloudDirectTestTenantLogin(platformId, tenant, mode)
  return r.ok ? { ok: true, message: r.data?.message || '连接成功' } : { ok: false, message: r.error || '连接失败' }
}

// ---------------- 租户内部对象（需凭据） ----------------

export interface TenantDbRow {
  name: string
  charset: string
  collation: string
  system: boolean
}

export async function tenantDbsAs(platformId: string, tenant: string): Promise<{ rows: TenantDbRow[]; error?: string }> {
  const r = await window.sqlpilot.cloudDirectTenantDbsAs(platformId, tenant)
  return r.ok ? { rows: (r.data || []) as TenantDbRow[] } : { rows: [], error: r.error }
}

/** 库 / Schema 下的表清单（MySQL 走 information_schema，Oracle 走 DBA_/ALL_TABLES） */
export async function tenantTables(
  platformId: string,
  tenant: string,
  input: { schema: string; mode: 'MYSQL' | 'ORACLE'; limit?: number }
): Promise<{ rows: CloudTenantTableRow[]; error?: string }> {
  const r = await window.sqlpilot.cloudDirectTenantTables(platformId, tenant, input)
  return r.ok ? { rows: r.data || [] } : { rows: [], error: r.error }
}

export async function createDbAs(platformId: string, tenant: string, input: { name: string; charset?: string }) {
  const r = await window.sqlpilot.cloudDirectCreateDb(platformId, tenant, input)
  return r.ok ? { ok: true, message: r.data?.message } : { ok: false, error: r.error || '创建失败' }
}

export async function dropDbAs(platformId: string, tenant: string, name: string) {
  const r = await window.sqlpilot.cloudDirectDropDb(platformId, tenant, name)
  return r.ok ? { ok: true } : { ok: false, error: r.error || '删除失败' }
}

export interface TenantUserRow {
  user: string
  host: string
  status: string
}

export async function tenantUsersAs(
  platformId: string,
  tenant: string,
  mode: 'MYSQL' | 'ORACLE'
): Promise<{ rows: TenantUserRow[]; error?: string }> {
  const r = await window.sqlpilot.cloudDirectTenantUsersAs(platformId, tenant, mode)
  return r.ok ? { rows: (r.data || []) as TenantUserRow[] } : { rows: [], error: r.error }
}

export async function createUserAs(
  platformId: string,
  tenant: string,
  input: { name: string; host?: string; password: string; mode: 'MYSQL' | 'ORACLE' }
) {
  const r = await window.sqlpilot.cloudDirectCreateUser(platformId, tenant, input)
  return r.ok ? { ok: true, message: r.data?.message } : { ok: false, error: r.error || '创建失败' }
}

export async function dropUserAs(
  platformId: string,
  tenant: string,
  input: { name: string; host?: string; mode: 'MYSQL' | 'ORACLE' }
) {
  const r = await window.sqlpilot.cloudDirectDropUser(platformId, tenant, input)
  return r.ok ? { ok: true } : { ok: false, error: r.error || '删除失败' }
}

export async function grantAs(
  platformId: string,
  tenant: string,
  input: {
    name: string
    host?: string
    /** MySQL：勾选的库；空数组 = 所有库（*.*） */
    databases?: string[]
    /** 勾选的权限 / 角色（主进程按模式白名单校验） */
    privileges: string[]
    mode: 'MYSQL' | 'ORACLE'
  }
) {
  const r = await window.sqlpilot.cloudDirectGrant(platformId, tenant, input)
  return r.ok
    ? { ok: true, message: r.data?.message, steps: (r.data as any)?.steps as string[] | undefined }
    : { ok: false, error: r.error || '授权失败', steps: (r as any).steps as string[] | undefined }
}

/** 权限回收：与授权一一对应，MySQL 走 ON <db>.*，Oracle 走 FROM "user" */
export async function revokeAs(
  platformId: string,
  tenant: string,
  input: {
    name: string
    host?: string
    databases?: string[]
    privileges: string[]
    mode: 'MYSQL' | 'ORACLE'
    /** Oracle 对象权限：owner.table */
    table?: string
  }
) {
  const r = await window.sqlpilot.cloudDirectRevoke(platformId, tenant, input)
  return r.ok
    ? { ok: true, message: r.data?.message, steps: (r.data as any)?.steps as string[] | undefined }
    : { ok: false, error: r.error || '回收失败', steps: (r as any).steps as string[] | undefined }
}

/** 连接自检：谁在连、有没有 GRANT OPTION —— 授权失败时先看这个 */
export async function tenantSelfCheck(platformId: string, tenant: string, mode: 'MYSQL' | 'ORACLE') {
  const r = await window.sqlpilot.cloudDirectTenantSelfCheck(platformId, tenant, mode)
  return r.ok && r.data ? { ok: true as const, ...r.data } : { ok: false as const, error: r.error || '自检失败' }
}

/** 已授权限：MySQL 解析 SHOW GRANTS，Oracle 读 DBA_ROLE_PRIVS / DBA_SYS_PRIVS / DBA_TAB_PRIVS */
export async function grantsOf(
  platformId: string,
  tenant: string,
  input: { name: string; host?: string; mode: 'MYSQL' | 'ORACLE' }
): Promise<{ rows: CloudDirectGrantRow[]; error?: string }> {
  const r = await window.sqlpilot.cloudDirectGrants(platformId, tenant, input)
  return r.ok ? { rows: r.data || [] } : { rows: [], error: r.error }
}

/** 直连内置告警规则与当前阈值 */
export async function directAlarmRules(platformId: string) {
  const r = await window.sqlpilot.cloudDirectAlarmRules(platformId)
  return r.ok && r.data ? r.data : { rules: [] as CloudDirectAlarmRule[], thresholds: {} as Record<string, number> }
}

export async function saveDirectAlarmThresholds(platformId: string, patch: Record<string, number>) {
  const r = await window.sqlpilot.cloudDirectSetAlarmThresholds(platformId, patch)
  return r.ok ? { ok: true, thresholds: r.data?.thresholds || {} } : { ok: false, error: r.error || '保存失败' }
}

// ---------------- 任务日志（本地 JSONL） ----------------

export async function directTasks(q: {
  page?: number
  size?: number
  keyword?: string
  action?: string
  status?: string
  cluster?: string
  since?: number
}) {
  const r = await window.sqlpilot.cloudDirectTasks(q)
  return r.ok && r.data
    ? r.data
    : { items: [], total: 0, page: 1, size: q.size || 20, stats: { total: 0, running: 0, ok: 0, fail: 0 }, clusters: [] }
}

export async function directTaskDetail(id: string): Promise<CloudDirectTaskRow | null> {
  const r = await window.sqlpilot.cloudDirectTaskDetail(id)
  return r.ok ? (r.data as CloudDirectTaskRow | null) : null
}

export async function directTaskActions(): Promise<string[]> {
  const r = await window.sqlpilot.cloudDirectTaskActions()
  return r.ok ? r.data || [] : []
}

/** 新建资源池：池独立于租户存在，建租户时只挑空闲池 */export async function createResourcePool(
  platformId: string,
  input: { name: string; unitConfigName: string; unitCount: number; zoneList: string[] }
): Promise<{ ok: boolean; error?: string }> {
  const r = await window.sqlpilot.cloudDirectCreateResourcePool(platformId, input)
  return r.ok ? { ok: true } : { ok: false, error: r.error || '创建失败' }
}
