/**
 * OCP 租户详情页的数据采集（对齐 OCP 4.4 / 4.4.1 的租户详情各 tab）。
 *
 * 与 ocp.ts 的分工：ocp.ts 负责连接、登录、集群与基础租户 CRUD；
 * 这里只放「租户详情页」这一层的读接口（及其少量低风险写接口），便于单独维护。
 * 不依赖 electron，可单独 esbuild 后在 node 里联调。
 *
 * 实测约定（OCP 4.4.1，OB 4.2/4.3）：
 *   · 时间参数一律 OffsetDateTime（2026-10-21T02:33:56.895+00:00），毫秒时间戳报 400；
 *   · 分页参数是 page/size，部分接口用 pageable；
 *   · 不存在的路径返回 HTTP 200 + SPA HTML，client.call 只会说「响应无法解析」；
 *   · 合并/统计/备份类接口多数要求显式时间窗，缺参会 400。
 */

import { OcpClient, OcpError, ocpAtLeast, toTopSql, type TopSqlRow } from './ocp'

const num = (v: any): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const str = (v: any): string => (v === undefined || v === null ? '' : String(v))
const arr = (v: any): any[] => (Array.isArray(v) ? v : [])

/** OCP 只认 OffsetDateTime */
function isoOffset(ms: number): string {
  return new Date(ms).toISOString().replace('Z', '+00:00')
}

// ---------------------------------------------------------------- 数据库 / 表

export interface TenantDatabase {
  name: string
  charset: string
  collation: string
  readonly: boolean
  /** 逻辑数据量（字节） */
  requiredSize: number
  createTime: string
  /** 连接串：直连 / OBProxy */
  connections: { type: string; url: string }[]
}

/** 租户内库列表：GET /ob/clusters/{cid}/tenants/{tid}/databases */
export async function ocpTenantDatabases(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantDatabase[]> {
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/databases`, { query: { page: 1, size: 500 } })
  return arr(data?.contents).map((o: any) => ({
    name: str(o?.dbName),
    charset: str(o?.charset),
    collation: str(o?.collation),
    readonly: !!o?.readonly,
    requiredSize: num(o?.requiredSize),
    createTime: str(o?.createTime),
    connections: arr(o?.connectionUrls).map((c: any) => ({
      type: str(c?.type) || (c?.obProxyAddress ? 'OBPROXY' : 'DIRECT'),
      url: str(c?.connectionString)
    }))
  }))
}

export interface TenantTable {
  id: string
  name: string
  partitions: number
  rows: number
  /** 数据量（字节） */
  size: number
  requiredSize: number
  /** 宏块利用率（%） */
  macroBlockRatio: number
}

export interface TenantTableList {
  database: string
  lastUpdateTime: string
  tables: TenantTable[]
}

/** 库内表清单：GET /ob/clusters/{cid}/tenants/{tid}/database/{dbName}（注意单数 database） */
export async function ocpTenantTables(client: OcpClient, clusterId: number, tenantId: number, dbName: string): Promise<TenantTableList> {
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/database/${encodeURIComponent(dbName)}`, {
    query: { page: 1, size: 2000 }
  })
  return {
    database: str(data?.databaseName) || dbName,
    lastUpdateTime: str(data?.lastUpdateTime),
    tables: arr(data?.tableInfoList).map((o: any) => ({
      id: str(o?.tableId),
      name: str(o?.tableName),
      partitions: num(o?.partitionCount),
      rows: num(o?.rowCount),
      size: num(o?.size),
      requiredSize: num(o?.requiredSize),
      macroBlockRatio: num(o?.macroBlockUseRatio)
    }))
  }
}

export interface TenantTableColumn {
  name: string
  type: string
  nullable: boolean
  key: string
  def: string
  comment: string
}

export interface TenantTableSchema {
  ddl: string
  columns: TenantTableColumn[]
  indexes: { name: string; columns: string; unique: boolean }[]
}

/**
 * 单表结构：GET /ob/clusters/{cid}/tenants/{tid}/obTableSchema?databaseName=&tableName=
 * 返回的是**数组**，取第一项；createTableStr 是完整 DDL。
 */
export async function ocpTenantTableSchema(
  client: OcpClient, clusterId: number, tenantId: number, dbName: string, tableName: string
): Promise<TenantTableSchema> {
  const raw = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/obTableSchema`, {
    query: { databaseName: dbName, tableName }
  })
  const d = arr(raw)[0] || {}
  const columns = arr(d?.columnList).map((c: any) => ({
    name: str(c?.columnName ?? c?.name),
    type: str(c?.dataType ?? c?.type ?? c?.columnType),
    nullable: c?.nullable === undefined ? !/not null/i.test(str(c?.columnType)) : !!c?.nullable,
    key: str(c?.columnKey ?? c?.key),
    def: str(c?.columnDefault ?? c?.defaultValue),
    comment: str(c?.comment)
  }))
  const indexes = arr(d?.indexList ?? d?.indexes).map((i: any) => ({
    name: str(i?.indexName ?? i?.name),
    columns: arr(i?.columnNames ?? i?.columns).map(str).join(', ') || str(i?.columns),
    unique: !!(i?.unique ?? i?.nonUnique === false)
  }))
  return { ddl: str(d?.createTableStr ?? d?.ddl), columns, indexes }
}

// ---------------------------------------------------------------- 主备关系 / 拓扑

export interface TenantRelationNode {
  id: number
  name: string
  clusterId: number
  clusterName: string
  role: string
  status: string
  locality: string
  createTime: string
  /** 同步状态（备租户特有） */
  syncStatus: string
}

export interface TenantStandbyTopo {
  current: TenantRelationNode | null
  /** 主租户（当前是备租户时才有） */
  primary: TenantRelationNode | null
  /** 备租户列表（当前是主租户时才有） */
  standbys: TenantRelationNode[]
  /** 同集群内其他租户（便于挑选切换目标） */
  siblings: TenantRelationNode[]
}

function toRelationNode(o: any): TenantRelationNode {
  return {
    id: num(o?.id),
    name: str(o?.name),
    clusterId: num(o?.clusterId),
    clusterName: str(o?.clusterName),
    role: str(o?.role ?? o?.tenantRole),
    status: str(o?.status),
    locality: str(o?.locality),
    createTime: str(o?.createTime),
    syncStatus: str(o?.syncStatus)
  }
}

/**
 * 主备关系：GET /tenants/{tid}/standbyRelationTopo + listRelationTenants + siblingTenants
 * standbyRelationTopo 在无备租户时返回当前租户自身，listRelationTenants 为空数组。
 */
export async function ocpTenantStandbyTopo(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantStandbyTopo> {
  const base = `/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}`
  const [topo, relations, siblings] = await Promise.all([
    client.call<any>(`${base}/standbyRelationTopo`).catch(() => null),
    client.call<any>(`${base}/listRelationTenants`).catch(() => null),
    client.call<any>(`${base}/siblingTenants`).catch(() => null)
  ])
  const topoList = arr(topo?.contents).map(toRelationNode)
  const relList = arr(relations?.contents).map(toRelationNode)
  const self = topoList.find((n) => n.id === tenantId) || topoList[0] || null
  const primary = relList.find((n) => /PRIMARY/i.test(n.role)) || null
  const standbys = relList.filter((n) => /STANDBY/i.test(n.role))
  return {
    current: self,
    primary: primary && primary.id !== tenantId ? primary : null,
    standbys,
    siblings: arr(siblings?.contents).map(toRelationNode).filter((n) => n.id !== tenantId)
  }
}

// ---------------------------------------------------------------- 会话 / 事务 / 锁

export interface TenantSessionStats {
  total: number
  active: number
  maxActiveTime: number
  byUser: { name: string; total: number; active: number }[]
  byDb: { name: string; total: number; active: number }[]
  byClient: { name: string; total: number; active: number }[]
}

/** 会话统计：GET /tenants/{tid}/sessions/stats（按用户/库/客户端三向聚合） */
export async function ocpTenantSessionStats(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantSessionStats> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/sessions/stats`)
  return {
    total: num(d?.totalCount),
    active: num(d?.activeCount),
    maxActiveTime: num(d?.maxActiveTime),
    byUser: arr(d?.userStats).map((o: any) => ({ name: str(o?.dbUser), total: num(o?.totalCount), active: num(o?.activeCount) })),
    byDb: arr(d?.dbStats).map((o: any) => ({ name: str(o?.dbName), total: num(o?.totalCount), active: num(o?.activeCount) })),
    byClient: arr(d?.clientStats).map((o: any) => ({ name: str(o?.clientIp), total: num(o?.totalCount), active: num(o?.activeCount) }))
  }
}

/** 结束查询（只杀当前语句，不断连接）：POST /tenants/{tid}/sessions/closeQuery {sessionIds} */
export async function ocpTenantCloseQuery(client: OcpClient, clusterId: number, tenantId: number, sessionIds: number[]): Promise<void> {
  if (!sessionIds.length) return
  await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/sessions/closeQuery`, { method: 'POST', body: { sessionIds } })
}

export interface TenantRowLock {
  sessionId: number
  user: string
  host: string
  table: string
  /** 锁模式（SHARE / EXCLUSIVE 等） */
  lockMode: string
  lockType: string
  /** 持锁时间（秒） */
  time: number
  info: string
}

/** 行锁等待：GET /tenants/{tid}/rowlock（4.3 无此端点，直接返回空） */
export async function ocpTenantRowLocks(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantRowLock[]> {
  if (!(await ocpAtLeast(client, 4, 4))) return []
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/rowlock`, { query: { page: 1, size: 200 } })
  return arr(d?.contents).map((o: any) => ({
    sessionId: num(o?.sessionId ?? o?.transSessionId),
    user: str(o?.dbUser ?? o?.user),
    host: str(o?.clientIp ?? o?.host),
    table: str(o?.tableName ?? o?.table),
    lockMode: str(o?.lockMode),
    lockType: str(o?.lockType),
    time: num(o?.time ?? o?.lockTime),
    info: str(o?.sqlText ?? o?.info)
  }))
}

export interface TenantTransaction {
  id: string
  sessionId: number
  user: string
  host: string
  /** 事务持续时间（秒） */
  duration: number
  /** 已耗时（毫秒） */
  elapsedMs: number
  state: string
  info: string
}

/**
 * 事务列表：GET /tenants/{tid}/transactions
 * timeMsThreshold 必填（毫秒），0 表示不限；字段名各版本略有差异，这里做多别名兜底。
 */
export async function ocpTenantTransactions(
  client: OcpClient, clusterId: number, tenantId: number, timeMsThreshold = 0
): Promise<TenantTransaction[]> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/transactions`, {
    query: { timeMsThreshold, page: 1, size: 200 }
  })
  return arr(d?.contents).map((o: any) => ({
    id: str(o?.transId ?? o?.transactionId ?? o?.id),
    sessionId: num(o?.sessionId ?? o?.transSessionId),
    user: str(o?.dbUser ?? o?.user),
    host: str(o?.clientIp ?? o?.host),
    duration: num(o?.duration ?? o?.transTime),
    elapsedMs: num(o?.elapsedTime ?? o?.timeMs ?? o?.costTime),
    state: str(o?.state ?? o?.status),
    info: str(o?.sqlText ?? o?.info)
  }))
}

/** 批量结束事务：POST /tenants/{tid}/transactions/batchClose {transSessionList:[…]} */
export async function ocpTenantCloseTransactions(
  client: OcpClient, clusterId: number, tenantId: number, transSessionList: { sessionId: number; transId?: string }[]
): Promise<void> {
  if (!transSessionList.length) return
  await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/transactions/batchClose`, {
    method: 'POST',
    body: { transSessionList }
  })
}

// ---------------------------------------------------------------- SQL 诊断（租户维度）

/** 新增 SQL / 高危 SQL / 并行 SQL 与 TopSQL 同构，统一复用 toTopSql 映射 */
async function sqlRows(client: OcpClient, path: string, from: number, to: number, limit = 200, extra: Record<string, any> = {}): Promise<TopSqlRow[]> {
  const d = await client.call<any>(path, {
    query: { startTime: isoOffset(from), endTime: isoOffset(to), limit, sqlTextLength: 4000, ...extra }
  })
  return arr(d?.contents).map(toTopSql)
}

/** 新增 SQL：GET /tenants/{tid}/newSql */
export const ocpTenantNewSql = (client: OcpClient, clusterId: number, tenantId: number, from: number, to: number, limit = 200): Promise<TopSqlRow[]> =>
  sqlRows(client, `/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/newSql`, from, to, limit)

/** 高危 SQL：GET /tenants/{tid}/highRiskSql */
export const ocpTenantHighRiskSql = (client: OcpClient, clusterId: number, tenantId: number, from: number, to: number, limit = 200): Promise<TopSqlRow[]> =>
  sqlRows(client, `/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/highRiskSql`, from, to, limit)

/** 并行 SQL：GET /tenants/{tid}/parallelSql（服务端限制时间窗 ≤ PT24H，调用方别传超过 23h） */
export const ocpTenantParallelSql = (client: OcpClient, clusterId: number, tenantId: number, from: number, to: number, limit = 200): Promise<TopSqlRow[]> =>
  sqlRows(client, `/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/parallelSql`, from, to, limit)

export interface TenantOutline {
  id: number
  sqlId: string
  dbName: string
  outlineName: string
  /** 绑定的执行计划 */
  outlineContent: string
  createTime: string
  enabled: boolean
}

/** 执行计划绑定（Outline）：GET /tenants/{tid}/outlines */
export async function ocpTenantOutlines(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantOutline[]> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/outlines`, { query: { page: 1, size: 200 } })
  return arr(d?.contents).map((o: any) => ({
    id: num(o?.id),
    sqlId: str(o?.sqlId),
    dbName: str(o?.dbName),
    outlineName: str(o?.outlineName ?? o?.name),
    outlineContent: str(o?.outlineContent ?? o?.content),
    createTime: str(o?.createTime),
    enabled: o?.enabled === undefined ? true : !!o?.enabled
  }))
}

export interface TenantSqlDiagnosis {
  /** 诊断结论条目 */
  advices: { level: string; title: string; content: string }[]
  /** 可能的性能瓶颈维度（CPU / IO / 锁等待…） */
  bottleneck: string
}

/** 单条 SQL 的诊断建议：GET /tenants/{tid}/sqls/{sqlId}/advices 与 diagnosis */
export async function ocpTenantSqlDiagnosis(
  client: OcpClient, clusterId: number, tenantId: number, sqlId: string, from: number, to: number
): Promise<TenantSqlDiagnosis> {
  const base = `/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/sqls/${sqlId}`
  const [adv, diag] = await Promise.all([
    client.call<any>(`${base}/advices`, { query: { startTime: isoOffset(from), endTime: isoOffset(to) } }).catch(() => null),
    client.call<any>(`${base}/diagnosis`, { query: { startTime: isoOffset(from), endTime: isoOffset(to) } }).catch(() => null)
  ])
  const advices: { level: string; title: string; content: string }[] = []
  const pushAdv = (o: any): void => {
    if (!o) return
    if (typeof o === 'string') { advices.push({ level: 'info', title: '建议', content: o }); return }
    const content = str(o?.content ?? o?.message ?? o?.advice ?? o?.suggestion)
    if (!content) return
    advices.push({ level: str(o?.level ?? o?.type).toLowerCase() || 'info', title: str(o?.title ?? o?.name) || '建议', content })
  }
  const advList = arr(adv?.contents ?? adv?.adviceList ?? adv?.data)
  advList.forEach(pushAdv)
  if (!advices.length && adv) pushAdv(adv)
  const diagList = arr(diag?.contents ?? diag?.diagnosisList ?? diag?.data)
  diagList.forEach(pushAdv)
  return { advices, bottleneck: str(diag?.bottleneck ?? diag?.conclusion) }
}

// ---------------------------------------------------------------- 合并（Compaction）

export interface TenantCompaction {
  status: string
  suspend: boolean
  error: boolean
  errorInfo: string
  /** 本轮合并的开始 / 结束时间 */
  startTime: string
  lastFinishTime: string
  frozenScn: string
  broadcastScn: string
  lastScn: string
}

/** 合并状态：GET /tenants/{tid}/compaction */
export async function ocpTenantCompaction(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantCompaction> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/compaction`)
  return {
    status: str(d?.status),
    suspend: !!d?.suspend,
    error: !!d?.error,
    errorInfo: str(d?.errorInfo),
    startTime: str(d?.startTime),
    lastFinishTime: str(d?.lastFinishTime),
    frozenScn: str(d?.frozenScn),
    broadcastScn: str(d?.broadcastScn),
    lastScn: str(d?.lastScn)
  }
}

export interface TenantCompactionSettings {
  /** 冻结触发阈值（memstore 占用 %） */
  freezeTriggerPercentage: number
  /** 转储触发（0=默认） */
  minorCompactTrigger: number
  /** 合并触发（0=默认） */
  majorCompactTrigger: number
  /** 每日合并时间点 HH:mm */
  majorFreezeDutyTime: string
  majorCompactionThreadScore: number
  miniCompactionThreadScore: number
}

/** 合并设置：GET /tenants/{tid}/compactionSettings */
export async function ocpTenantCompactionSettings(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantCompactionSettings> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/compactionSettings`)
  return {
    freezeTriggerPercentage: num(d?.freezeTriggerPercentage),
    minorCompactTrigger: num(d?.minorCompactTrigger),
    majorCompactTrigger: num(d?.majorCompactTrigger),
    majorFreezeDutyTime: str(d?.majorFreezeDutyTime),
    majorCompactionThreadScore: num(d?.majorCompactionThreadScore),
    miniCompactionThreadScore: num(d?.miniCompactionThreadScore)
  }
}

/** 修改合并设置（PATCH，只提交改动字段；空对象实测返回 200 且无副作用） */
export async function ocpTenantUpdateCompactionSettings(
  client: OcpClient, clusterId: number, tenantId: number, patch: Partial<TenantCompactionSettings>
): Promise<void> {
  await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/compactionSettings`, { method: 'PATCH', body: patch })
}

export interface TenantMajorCompaction {
  startTime: string
  endTime: string
  result: string
  reason: string
  errorInfo: string
  frozenScn: string
}

export interface TenantMinorCompaction {
  startTime: string
  endTime: string
  totalRows: number
  dataSize: number
}

/** 合并历史：GET /tenants/{tid}/recentCompactions（times/startTime/endTime 均有必填校验） */
export async function ocpTenantRecentCompactions(
  client: OcpClient, clusterId: number, tenantId: number, hours = 72, times = 10
): Promise<TenantMajorCompaction[]> {
  const to = Date.now()
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/recentCompactions`, {
    query: { startTime: isoOffset(to - hours * 3600e3), endTime: isoOffset(to), times }
  })
  return arr(d?.compactionList).map((o: any) => ({
    startTime: str(o?.startTime),
    endTime: str(o?.endTime),
    result: str(o?.result),
    reason: str(o?.reason),
    errorInfo: str(o?.errorInfo),
    frozenScn: str(o?.frozenScn)
  }))
}

/** 转储历史：GET /tenants/{tid}/miniCompactions */
export async function ocpTenantMiniCompactions(
  client: OcpClient, clusterId: number, tenantId: number, hours = 12
): Promise<TenantMinorCompaction[]> {
  const to = Date.now()
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/miniCompactions`, {
    query: { startTime: isoOffset(to - hours * 3600e3), endTime: isoOffset(to) }
  })
  return arr(d?.miniCompactionList).map((o: any) => ({
    startTime: str(o?.startTime),
    endTime: str(o?.endTime),
    totalRows: num(o?.totalRows),
    dataSize: num(o?.dataSize)
  }))
}

/** 合并控制：action ∈ trigger / suspend / resume / clearError（状态不允许时 OCP 返回 500，原样抛出） */
export async function ocpTenantCompactionAction(
  client: OcpClient, clusterId: number, tenantId: number, action: 'trigger' | 'suspend' | 'resume' | 'clearError'
): Promise<void> {
  const path = action === 'clearError' ? 'clearCompactionError' : `${action}Compaction`
  await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/${path}`, { method: 'POST', body: {} })
}

// ---------------------------------------------------------------- 统计信息（DBMS_STATS）

export interface TenantGatherOverview {
  totalTables: number
  /** 各时间窗内未收集统计信息的表数 */
  buckets: { days: number; count: number; percent: number }[]
}

/** 统计信息概况：GET /api/v2/stats/gather/overview/{tid}（4.3 无此模块） */
export async function ocpTenantGatherOverview(client: OcpClient, tenantId: number): Promise<TenantGatherOverview> {
  if (!(await ocpAtLeast(client, 4, 4))) return { totalTables: 0, buckets: [] }
  const d = await client.call<any>(`/api/v2/stats/gather/overview/${tenantId}`)
  return {
    totalTables: num(d?.totalCount),
    buckets: arr(d?.details).map((o: any) => ({ days: num(o?.noUpdatedDays), count: num(o?.noUpdatedCount), percent: num(o?.noUpdatedPercent) }))
  }
}

export interface TenantGatherTable {
  database: string
  table: string
  /** 上次收集时间 */
  lastGatherTime: string
  /** 统计信息是否过期 */
  stale: boolean
  rowCount: number
}

/** 表统计信息：GET /api/v2/stats/gather/table/{tid}（可按 dbName 过滤；4.3 无此模块） */
export async function ocpTenantGatherTables(client: OcpClient, tenantId: number, dbName?: string): Promise<TenantGatherTable[]> {
  if (!(await ocpAtLeast(client, 4, 4))) return []
  const d = await client.call<any>(`/api/v2/stats/gather/table/${tenantId}`, {
    query: { page: 1, size: 1000, ...(dbName ? { dbName } : {}) }
  })
  return arr(d?.contents).map((o: any) => ({
    database: str(o?.dbName ?? o?.databaseName),
    table: str(o?.tableName),
    lastGatherTime: str(o?.lastGatherTime ?? o?.lastAnalyzed),
    stale: !!o?.stale,
    rowCount: num(o?.rowCount ?? o?.numRows)
  }))
}

export interface TenantGatherWindow {
  windowName: string
  enabled: boolean
  freq: string
  startDate: string
  /** 收集时长（秒） */
  duration: number
}

/** 自动收集窗口：GET /api/v2/stats/gather/auto/{tid}（4.3 无此模块） */
export async function ocpTenantGatherAuto(client: OcpClient, tenantId: number): Promise<TenantGatherWindow[]> {
  if (!(await ocpAtLeast(client, 4, 4))) return []
  const d = await client.call<any>(`/api/v2/stats/gather/auto/${tenantId}`)
  return arr(d?.contents).map((o: any) => ({
    windowName: str(o?.windowName),
    enabled: !!o?.enabled,
    freq: str(o?.freq),
    startDate: str(o?.startDate),
    duration: num(o?.duration)
  }))
}

export interface TenantGatherPref {
  name: string
  defaultValue: string
  description: string
  type: string
  /** 取值范围描述 */
  range: string
}

/** 收集策略参数（estimate_percent / degree / cascade …）：GET /api/v2/stats/gather/prefs/{tid}（4.3 无此模块） */
export async function ocpTenantGatherPrefs(client: OcpClient, tenantId: number): Promise<TenantGatherPref[]> {
  if (!(await ocpAtLeast(client, 4, 4))) return []
  const d = await client.call<any>(`/api/v2/stats/gather/prefs/${tenantId}`)
  return arr(d?.contents).map((o: any) => {
    const r = o?.valueRange || {}
    const range = r.min !== undefined || r.max !== undefined ? `${str(r.min) || '-∞'} ~ ${str(r.max) || '+∞'}` : str(o?.valueRange)
    return {
      name: str(o?.name),
      defaultValue: str(o?.defaultValue),
      description: str(o?.description),
      type: str(o?.componentType),
      range
    }
  })
}

// ---------------------------------------------------------------- 备份与恢复

export interface TenantBackupAbility {
  backupAbility: string
  canDoIncrementalBackup: boolean
  fullBackupEnabled: boolean
  incrementBackupEnabled: boolean
  hint: string
}

/** 备份能力：GET /clusters/{cid}/backup/ability */
export async function ocpBackupAbility(client: OcpClient, clusterId: number): Promise<TenantBackupAbility> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/backup/ability`)
  const a = d?.obDataBackupSupportAbility || {}
  return {
    backupAbility: str(d?.backupAbility),
    canDoIncrementalBackup: !!a?.canDoIncrementalBackup,
    fullBackupEnabled: !!a?.fullBackupEnabled,
    incrementBackupEnabled: !!a?.incrementBackupEnabled,
    hint: str(a?.hint)
  }
}

export interface TenantBackupOverview {
  clusterName: string
  backupStatus: string
  backupScheduleStatus: string
  compactionStatus: string
  obVersion: string
  ability: TenantBackupAbility
}

/** 备份总览：GET /clusters/{cid}/backup/overview */
export async function ocpBackupOverview(client: OcpClient, clusterId: number): Promise<TenantBackupOverview> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/backup/overview`)
  const a = d?.obBackupAbility?.obDataBackupSupportAbility || {}
  return {
    clusterName: str(d?.clusterName),
    backupStatus: str(d?.backupStatus),
    backupScheduleStatus: str(d?.backupScheduleStatus),
    compactionStatus: str(d?.compactionStatus),
    obVersion: str(d?.minObBuildVersion),
    ability: {
      backupAbility: str(d?.obBackupAbility?.backupAbility),
      canDoIncrementalBackup: !!a?.canDoIncrementalBackup,
      fullBackupEnabled: !!a?.fullBackupEnabled,
      incrementBackupEnabled: !!a?.incrementBackupEnabled,
      hint: str(a?.hint)
    }
  }
}

export interface TenantBackupStrategy {
  backupEnabled: boolean
  physical: boolean
  logical: boolean
  physicalAndWasLogical: boolean
  /** 保留策略（RESERVE_ALL / CUSTOMIZE…） */
  retainMode: string
  autoCompactEnabled: boolean
  /** 各租户的备份策略明细 */
  tenants: { tenantId: number; tenantName: string; tenantMode: string }[]
}

/** 备份策略：GET /clusters/{cid}/backup/config/backupStrategy?tenantId= */
export async function ocpBackupStrategy(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantBackupStrategy> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/backup/config/backupStrategy`, { query: { tenantId } })
  return {
    backupEnabled: !!d?.backupEnabled,
    physical: !!d?.physical,
    logical: !!d?.logical,
    physicalAndWasLogical: !!d?.physicalAndWasLogical,
    retainMode: str(d?.retainMode),
    autoCompactEnabled: !!d?.autoCompactEnabled,
    tenants: arr(d?.tenantBackupStrategyList).map((o: any) => ({
      tenantId: num(o?.tenantId),
      tenantName: str(o?.tenantName),
      tenantMode: str(o?.tenantMode)
    }))
  }
}

export interface TenantBackupTask {
  id: number
  type: string
  status: string
  startTime: string
  endTime: string
  /** 数据量（字节） */
  size: number
  result: string
  message: string
}

/** 数据备份任务：GET /clusters/{cid}/backup/task/dataBackupTasks?tenantId= */
export async function ocpBackupDataTasks(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantBackupTask[]> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/backup/task/dataBackupTasks`, {
    query: { tenantId, page: 1, size: 50 }
  })
  return arr(d?.contents).map(toBackupTask)
}

/** 日志备份任务：GET /clusters/{cid}/backup/task/logBackupTasks?tenantId= */
export async function ocpBackupLogTasks(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantBackupTask[]> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/backup/task/logBackupTasks`, {
    query: { tenantId, page: 1, size: 50 }
  })
  return arr(d?.contents).map(toBackupTask)
}

function toBackupTask(o: any): TenantBackupTask {
  return {
    id: num(o?.id ?? o?.taskId),
    type: str(o?.type ?? o?.backupType ?? o?.taskType),
    status: str(o?.status ?? o?.state),
    startTime: str(o?.startTime ?? o?.startTimestamp),
    endTime: str(o?.endTime ?? o?.endTimestamp),
    size: num(o?.dataSize ?? o?.size),
    result: str(o?.result),
    message: str(o?.message ?? o?.errorMessage)
  }
}

// ---------------------------------------------------------------- 用户与权限

export interface TenantUser {
  username: string
  host: string
  locked: boolean
  accessibleDatabases: string[]
  globalPrivileges: string[]
  dbPrivileges: { db: string; privileges: string[] }[]
  connections: { type: string; url: string }[]
}

/** 租户内数据库用户：GET /tenants/{tid}/users */
export async function ocpTenantUsers(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantUser[]> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/users`, { query: { page: 1, size: 200 } })
  return arr(d?.contents).map((o: any) => ({
    username: str(o?.username),
    host: str(o?.hostName ?? o?.host) || '%',
    locked: !!o?.isLocked,
    accessibleDatabases: arr(o?.accessibleDatabases).map(str),
    globalPrivileges: arr(o?.globalPrivileges).map(str),
    dbPrivileges: arr(o?.dbPrivileges).map((p: any) => ({ db: str(p?.dbName), privileges: arr(p?.privileges).map(str) })),
    connections: arr(o?.connectionStrings).map((c: any) => ({
      type: str(c?.type) || (c?.obProxyAddress ? 'OBPROXY' : 'DIRECT'),
      url: str(c?.connectionString)
    }))
  }))
}

// ---------------------------------------------------------------- 透明加密（只读）

export interface TenantTde {
  tenantId: number
  tenantName: string
  tenantRole: string
  obTenantId: number
  obVersion: string
  /** 是否已启用 */
  enabled: boolean
  /** NORMAL / TDE_ENABLING / TDE_ENABLED / TDE_DISABLING */
  status: string
  /** 密钥类型：NONE / INTERNAL / OBCLOUD */
  secretKeyType: string
  kmsValidType: string
}

/**
 * TDE 状态：GET /clusters/{cid}/tenants/tde（集群内全租户，返回后按 tenantId 过滤）
 * 注意：开启 TDE 不可逆，SqlPilot 只做展示，不提供开启入口。
 */
export async function ocpTenantTde(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantTde | null> {
  // /tenants/tde 是 4.4 才有的端点；4.3 上会落到 SPA 路由（200 + HTML），直接跳过
  if (!(await ocpAtLeast(client, 4, 4))) return null
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/tde`, { query: { page: 1, size: 200 } })
  const hit = arr(d?.contents).find((o: any) => num(o?.tenantId) === tenantId)
  if (!hit) return null
  return {
    tenantId: num(hit.tenantId),
    tenantName: str(hit.tenantName),
    tenantRole: str(hit.tenantRole),
    obTenantId: num(hit.obTenantId),
    obVersion: str(hit.obVersion),
    enabled: !!hit.tdeEnabled,
    status: str(hit.status),
    secretKeyType: str(hit.secretKeyType),
    kmsValidType: str(hit.kmsValidType)
  }
}

// ---------------------------------------------------------------- Unit 规格（全局，非租户级）

export interface UnitSpecRow {
  id: number
  name: string
  /** SYSTEM = OCP 内置（不可删改），USER = 自定义 */
  type: string
  minCpu: number
  maxCpu: number
  /** 内存单位是 GiB（注意与集群详情里的 memory 字节不同） */
  minMemory: number
  maxMemory: number
  /** 日志盘（GiB），null 表示不限制 */
  logDisk: number | null
  maxIops: number | null
  iopsWeight: number | null
  notRecommended: boolean
}

function toUnitSpec(o: any): UnitSpecRow {
  return {
    id: num(o?.id),
    name: str(o?.name),
    type: str(o?.type) || 'USER',
    minCpu: num(o?.minCpuCoreCount),
    maxCpu: num(o?.maxCpuCoreCount),
    minMemory: num(o?.minMemorySize),
    maxMemory: num(o?.maxMemorySize),
    logDisk: o?.logDiskSize === null || o?.logDiskSize === undefined ? null : num(o.logDiskSize),
    maxIops: o?.maxIops === null || o?.maxIops === undefined ? null : num(o.maxIops),
    iopsWeight: o?.iopsWeight === null || o?.iopsWeight === undefined ? null : num(o.iopsWeight),
    notRecommended: !!o?.notRecommended
  }
}

/** Unit 规格列表：GET /api/v2/ob/unitSpecs（全局资源规格，含 SYSTEM 内置项） */
export async function ocpUnitSpecs(client: OcpClient): Promise<UnitSpecRow[]> {
  const d = await client.call<any>('/api/v2/ob/unitSpecs', { query: { page: 1, size: 500 } })
  return arr(d?.contents).map(toUnitSpec)
}

export interface UnitSpecInput {
  name: string
  minCpuCoreCount: number
  maxCpuCoreCount: number
  /** GiB */
  minMemorySize: number
  maxMemorySize: number
  /** 日志盘 GiB（可选，OB 4.0+） */
  logDiskSize?: number
  maxIops?: number
  iopsWeight?: number
}

function unitSpecBody(input: UnitSpecInput): Record<string, any> {
  if (!input.name.trim()) throw new OcpError('请填写规格名')
  if (!(input.maxCpuCoreCount >= 0.5)) throw new OcpError('CPU 至少 0.5 核')
  if (!(input.maxMemorySize >= 1)) throw new OcpError('内存至少 1 GiB')
  const body: Record<string, any> = {
    name: input.name.trim(),
    // OCP 只支持固定规格：min = max（前端向导的取值为 0.5 核 / 1 GiB 的整数倍）
    minCpuCoreCount: input.minCpuCoreCount,
    maxCpuCoreCount: input.maxCpuCoreCount,
    minMemorySize: input.minMemorySize,
    maxMemorySize: input.maxMemorySize
  }
  if (input.logDiskSize !== undefined && input.logDiskSize !== null) body.logDiskSize = input.logDiskSize
  if (input.maxIops !== undefined && input.maxIops !== null) body.maxIops = input.maxIops
  if (input.iopsWeight !== undefined && input.iopsWeight !== null) body.iopsWeight = input.iopsWeight
  return body
}

/** 新建 Unit 规格：POST /api/v2/ob/unitSpecs */
export async function ocpUnitSpecCreate(client: OcpClient, input: UnitSpecInput): Promise<void> {
  await client.call<any>('/api/v2/ob/unitSpecs', { method: 'POST', body: unitSpecBody(input) })
}

/** 修改 Unit 规格：PUT /api/v2/ob/unitSpecs/{specId}（只能改 USER 规格） */
export async function ocpUnitSpecUpdate(client: OcpClient, specId: number, input: UnitSpecInput): Promise<void> {
  await client.call<any>(`/api/v2/ob/unitSpecs/${specId}`, { method: 'PUT', body: unitSpecBody(input) })
}

/** 删除 Unit 规格：DELETE /api/v2/ob/unitSpecs/{specId}（被租户引用时 OCP 会拒绝） */
export async function ocpUnitSpecDelete(client: OcpClient, specId: number): Promise<void> {
  await client.call<any>(`/api/v2/ob/unitSpecs/${specId}`, { method: 'DELETE' })
}

// ---------------------------------------------------------------- 克隆租户

export interface TenantPreCheckResult {
  valid: boolean
  checkResults: { errorCode: string; errorMessage: string; warning: boolean }[]
}

/**
 * 克隆预检查：POST /tenants/{tid}/clonePreCheck（无 body，只做校验，不改数据）
 * 依赖源租户的日志归档；未开归档会返回 OBE26011「未找到日志归档配置」。
 */
export async function ocpTenantClonePreCheck(client: OcpClient, clusterId: number, tenantId: number): Promise<TenantPreCheckResult> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/clonePreCheck`, { method: 'POST' })
  return {
    valid: !!d?.valid,
    checkResults: arr(d?.checkResults).map((o: any) => ({
      errorCode: str(o?.errorCode),
      errorMessage: str(o?.errorMessage),
      warning: !!o?.warning
    }))
  }
}

export interface TenantCloneInput {
  name: string
  mode?: string
  charset?: string
  collation?: string
  primaryZone?: string
  description?: string
  whitelist?: string
  /** 4.x 集群的每个 Zone Unit 数（OCP 前端在 OB 版本支持时会带） */
  zonesUnitCount?: number
  zones: { name: string; checked?: boolean; replicaType?: string; unitSpecName?: string; unitCount?: number }[]
}

/**
 * 克隆租户：POST /tenants/{tid}/clone
 * body 形如 { name, zones[{name,checked,replicaType,unitSpecName,unitCount}], mode, charset, collation, primaryZone, description, whitelist }
 */
export async function ocpTenantClone(client: OcpClient, clusterId: number, tenantId: number, input: TenantCloneInput): Promise<{ taskId?: number; tenantId?: number }> {
  if (!input.name.trim()) throw new OcpError('请填写新租户名')
  const body: Record<string, any> = {
    name: input.name.trim(),
    zones: input.zones.map((z) => {
      const item: Record<string, any> = { name: z.name, checked: z.checked !== false }
      if (z.replicaType) item.replicaType = z.replicaType
      if (z.unitSpecName) item.unitSpecName = z.unitSpecName
      if (z.unitCount) item.unitCount = Math.max(1, Number(z.unitCount) || 1)
      return item
    })
  }
  if (input.mode) body.mode = input.mode
  if (input.charset) body.charset = input.charset
  if (input.collation) body.collation = input.collation
  if (input.primaryZone) body.primaryZone = input.primaryZone
  if (input.description) body.description = input.description
  if (input.whitelist) body.whitelist = input.whitelist
  if (input.zonesUnitCount) body.zonesUnitCount = input.zonesUnitCount
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/clone`, { method: 'POST', body })
  return { taskId: d?.taskId ? num(d.taskId) : undefined, tenantId: d?.id ? num(d.id) : undefined }
}

// ---------------------------------------------------------------- 创建备租户（主备）

export interface PrimaryTenantInfo {
  loadType: string
  locality: string
  logBackupOn: boolean
  logComplete: boolean
  canVisitPrimaryBackupStorage: boolean
  canRestoreTenant: boolean
  resourcePools: {
    name: string
    zoneList: string[]
    unitCount: number
    unitCpu: number
    unitMemory: number
    unitSpecName: string
  }[]
}

/** 主租户副本配置：GET /tenants/primaryTenantInfo?primaryTenantId=（备租户向导里展示"主租户副本配置"用） */
export async function ocpPrimaryTenantInfo(client: OcpClient, clusterId: number, primaryTenantId: number): Promise<PrimaryTenantInfo> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/primaryTenantInfo`, {
    query: { primaryTenantId, page: 1, size: 20 }
  })
  return {
    loadType: str(d?.loadType),
    locality: str(d?.locality),
    logBackupOn: !!d?.logBackupOn,
    logComplete: !!d?.logComplete,
    canVisitPrimaryBackupStorage: !!d?.canVisitPrimaryBackupStorage,
    canRestoreTenant: !!d?.canRestoreTenant,
    resourcePools: arr(d?.resourcePoolList).map((o: any) => ({
      name: str(o?.name),
      zoneList: arr(o?.zoneList).map(str),
      unitCount: num(o?.unitCount),
      unitCpu: num(o?.unitConfig?.maxCpuCoreCount),
      unitMemory: num(o?.unitConfig?.maxMemoryByte),
      unitSpecName: str(o?.unitConfig?.name)
    }))
  }
}

export interface StandbyTenantInput {
  name: string
  mode: string
  /** 主租户在该集群内的 OCP 租户 ID（不是 OB 租户 ID） */
  primaryTenantId: number
  /** 主备同步方式：SYNC（强同步）/ ASYNC（异步） */
  logTransportMode?: string
  charset?: string
  collation?: string
  primaryZone?: string
  description?: string
  whitelist?: string
  zones: { name: string; replicaType?: string; unitSpecName?: string; unitCount?: number }[]
}

/**
 * 创建备租户：POST /clusters/{cid}/tenants/createStandbyTenant（在**备集群**下调用）
 * 依赖主租户的日志归档/日志传输，未开归档时后端会拒绝。
 */
export async function ocpCreateStandbyTenant(client: OcpClient, clusterId: number, input: StandbyTenantInput): Promise<{ taskId?: number; tenantId?: number }> {
  if (!input.name.trim()) throw new OcpError('请填写备租户名')
  const body: Record<string, any> = {
    name: input.name.trim(),
    type: 'STANDBY',
    mode: input.mode,
    primaryTenantId: input.primaryTenantId,
    primaryClusterId: clusterId,
    zones: input.zones.map((z) => ({
      name: z.name,
      replicaType: z.replicaType || 'FULL',
      unitSpecName: z.unitSpecName,
      unitCount: Math.max(1, Number(z.unitCount) || 1)
    }))
  }
  if (input.logTransportMode) body.logTransportMode = input.logTransportMode
  if (input.charset) body.charset = input.charset
  if (input.collation) body.collation = input.collation
  if (input.primaryZone) body.primaryZone = input.primaryZone
  if (input.description) body.description = input.description
  if (input.whitelist) body.whitelist = input.whitelist
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/createStandbyTenant`, { method: 'POST', body })
  return { taskId: d?.taskId ? num(d.taskId) : undefined, tenantId: d?.id ? num(d.id) : undefined }
}
