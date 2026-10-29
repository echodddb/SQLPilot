/**
 * 直连模式的采集器：把 oceanbase 库的系统视图映射成 OCP 那套数据结构
 * （CloudCluster / CloudTenant / CloudHost / CloudOverview …），
 * 让渲染层完全不用改就能渲染。
 *
 * 单机语义：一条连接 = 一个集群；OBServer 即主机（没有 OCP Agent）。
 */

import { q, q1, type ObDirectPlatform } from './conn'
import { capabilityOf, has, sqlAuditView, type ObCapability } from './capability'
import type {
  AlarmLevelCount,
  CapacityStat,
  CloudCluster,
  CloudClusterDetail,
  CloudHost,
  CloudOverview,
  CloudTenant,
  CloudTenantDetail
} from '../ocp'

// ---------------------------------------------------------------- 工具

/** 稳定数值 id：OCP 的 id 是数字，渲染层按数字做 key 与路由，这里用哈希保证同地址每次一致 */
export function hashId(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h % 2_000_000_000
}

const num = (v: any): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const str = (v: any): string => (v === undefined || v === null ? '' : String(v))

const cap = (used: number, total: number): CapacityStat => ({
  used,
  total,
  pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0
})

/** BUILD_VERSION 形如 4.3.5.2_102010032025052623-c719105...，取版本号前缀 */
const versionOf = (build: string): string => {
  const m = /^([\d.]+)_/.exec(build)
  return m ? m[1] : build.slice(0, 16)
}

// ---------------------------------------------------------------- 快照

export interface ObSnapshot {
  cap: ObCapability
  clusterId: number
  servers: any[]
  gvServers: any[]
  zones: any[]
  tenants: any[]
  units: any[]
}

/**
 * 一次把总览/集群/租户/主机要用的几张表拉齐。
 * 这几张表都是个位数到几十行，合并取比每个页面各自查更省往返。
 */
export async function snapshotOf(p: ObDirectPlatform, password: string): Promise<ObSnapshot> {
  const capa = await capabilityOf(p, password)
  const [servers, gvServers, zones, tenants, units] = await Promise.all([
    q(p, password, 'SELECT * FROM oceanbase.DBA_OB_SERVERS ORDER BY ID'),
    q(p, password, 'SELECT * FROM oceanbase.GV$OB_SERVERS'),
    q(p, password, 'SELECT * FROM oceanbase.DBA_OB_ZONES ORDER BY ZONE').catch(() => []),
    q(p, password, 'SELECT * FROM oceanbase.DBA_OB_TENANTS ORDER BY TENANT_ID'),
    q(p, password, 'SELECT * FROM oceanbase.DBA_OB_UNITS ORDER BY UNIT_ID').catch(() => [])
  ])
  return {
    cap: capa,
    clusterId: hashId(`${p.host}:${p.port}`),
    servers,
    gvServers,
    zones,
    tenants,
    units
  }
}

/** 服务器资源容量（GV$OB_SERVERS 才有 CPU/MEM/DISK 的容量与已分配） */
const capacityOf = (s: ObSnapshot): { cpu: CapacityStat; memory: CapacityStat; disk: CapacityStat; health: string } => {
  let cpuUsed = 0, cpuTotal = 0, memUsed = 0, memTotal = 0, diskUsed = 0, diskTotal = 0
  let health = 'NORMAL'
  for (const r of s.gvServers) {
    cpuUsed += num(r.CPU_ASSIGNED)
    cpuTotal += num(r.CPU_CAPACITY)
    memUsed += num(r.MEM_ASSIGNED)
    memTotal += num(r.MEM_CAPACITY)
    diskUsed += num(r.DATA_DISK_IN_USE)
    diskTotal += num(r.DATA_DISK_CAPACITY)
    if (str(r.DATA_DISK_HEALTH_STATUS) && str(r.DATA_DISK_HEALTH_STATUS) !== 'NORMAL') {
      health = str(r.DATA_DISK_HEALTH_STATUS)
    }
  }
  return { cpu: cap(cpuUsed, cpuTotal), memory: cap(memUsed, memTotal), disk: cap(diskUsed, diskTotal), health }
}

const clusterStatusOf = (s: ObSnapshot): string => {
  if (!s.servers.length) return 'UNKNOWN'
  return s.servers.every((r) => str(r.STATUS) === 'ACTIVE') ? 'RUNNING' : 'DEGRADED'
}

// ---------------------------------------------------------------- 集群

export function clustersOf(s: ObSnapshot, alarms: { total: number; levels: AlarmLevelCount[] }): CloudCluster[] {
  if (!s.servers.length) return []
  const c = capacityOf(s)
  const root = s.servers.find((r) => str(r.WITH_ROOTSERVER) === 'YES')
  const newest = s.servers.reduce((a, b) => (str(a.CREATE_TIME) > str(b.CREATE_TIME) ? a : b))
  const zoneSet = new Set(s.zones.map((z) => str(z.ZONE)))
  return [{
    id: s.clusterId,
    name: s.cap.clusterName,
    status: clusterStatusOf(s),
    // 单机 / 分布式按 OBServer 数区分，OCP 的 type 字段沿用同样的语义
    type: s.servers.length > 1 ? 'DISTRIBUTED' : 'SINGLE',
    obClusterId: 0,
    version: versionOf(str(s.servers[0].BUILD_VERSION)),
    clusterMode: s.servers.length > 1 ? '多副本' : '单机单副本',
    origin: 'obdirect',
    createTime: str(newest.CREATE_TIME),
    creator: '',
    regionCount: zoneSet.size || 1,
    serverCount: s.servers.length,
    tenantCount: s.tenants.length,
    rootServer: root ? str(root.SVR_IP) : '',
    cpu: c.cpu,
    memory: c.memory,
    disk: c.disk,
    alarms
  }]
}

// ---------------------------------------------------------------- 租户

export function tenantsOf(s: ObSnapshot, cluster: CloudCluster | undefined): CloudTenant[] {
  const zoneByTenant = new Map<number, Set<string>>()
  for (const u of s.units) {
    const id = num(u.TENANT_ID)
    if (!zoneByTenant.has(id)) zoneByTenant.set(id, new Set())
    if (u.ZONE) zoneByTenant.get(id)!.add(str(u.ZONE))
  }
  return s.tenants.map((t) => {
    const id = num(t.TENANT_ID)
    const zones = [...(zoneByTenant.get(id) ?? new Set<string>())]
    return {
      id,
      name: str(t.TENANT_NAME),
      clusterId: cluster?.id ?? s.clusterId,
      clusterName: cluster?.name ?? s.cap.clusterName,
      clusterStatus: cluster?.status ?? 'RUNNING',
      mode: str(t.COMPATIBILITY_MODE),
      status: str(t.STATUS),
      obTenantId: id,
      locality: str(t.LOCALITY),
      primaryZone: str(t.PRIMARY_ZONE),
      zoneList: zones.join(',') || str(t.LOCALITY),
      version: str(t.COMPATIBLE),
      createTime: str(t.CREATE_TIME),
      loadType: str(t.TENANT_TYPE) === 'SYS' ? '系统租户' : '用户租户',
      role: str(t.TENANT_ROLE),
      clusterType: str(t.TENANT_ROLE) === 'STANDBY' ? 'STANDBY' : 'PRIMARY',
      locked: str(t.LOCKED) === 'YES',
      description: `${str(t.TENANT_TYPE)} · ${str(t.LOG_MODE)}`
    }
  })
}

// ---------------------------------------------------------------- 主机

export function hostsOf(s: ObSnapshot, cluster: CloudCluster | undefined): CloudHost[] {
  const byIp = new Map<string, any>()
  for (const g of s.gvServers) byIp.set(str(g.SVR_IP), g)
  const clusterName = cluster?.name ?? s.cap.clusterName
  const version = cluster?.version ?? ''
  return s.servers.map((r) => {
    const ip = str(r.SVR_IP)
    const g = byIp.get(ip)
    return {
      id: hashId(`${ip}:${num(r.SVR_PORT)}`),
      ip,
      alias: ip,
      name: ip,
      status: str(r.STATUS) === 'ACTIVE' ? 'ONLINE' : 'OFFLINE',
      // 直连模式没有 OCP Agent，这里如实标注，别让界面误报成"Agent 异常"
      agentStatus: '无 Agent',
      agentVersion: '',
      typeName: 'OBServer',
      kind: 'OBServer',
      region: str(r.ZONE),
      idc: '',
      os: '',
      sshPort: 22,
      createTime: str(r.CREATE_TIME),
      services: [{ name: 'OBServer', type: 'OB_SERVER', version }],
      clusters: [clusterName],
      obproxies: [],
      // 附加：磁盘健康度取自 GV$OB_SERVERS
      diskHealth: g ? str(g.DATA_DISK_HEALTH_STATUS) : ''
    } as CloudHost
  })
}

// ---------------------------------------------------------------- 总览

export async function overviewOf(
  p: ObDirectPlatform,
  password: string,
  evaluate: (s: ObSnapshot) => Promise<{ total: number; levels: AlarmLevelCount[]; critical: number }>
): Promise<CloudOverview> {
  const s = await snapshotOf(p, password)
  const al = await evaluate(s)
  const clusters = clustersOf(s, { total: al.total, levels: al.levels })
  const hosts = hostsOf(s, clusters[0])
  const c = capacityOf(s)
  return {
    info: {
      version: s.cap.version,
      edition: 'OceanBase 直连模式',
      buildTime: ''
    },
    kpis: {
      clusters: clusters.length,
      clustersRunning: clusters.filter((x) => x.status === 'RUNNING').length,
      hosts: hosts.length,
      hostsOnline: hosts.filter((x) => x.status === 'ONLINE').length,
      tenants: s.tenants.length,
      alarms: al.total,
      alarmsCritical: al.critical,
      cpuUsed: c.cpu.used,
      cpuTotal: c.cpu.total
    },
    hosts: {
      total: hosts.length,
      online: hosts.filter((x) => x.status === 'ONLINE').length,
      offline: hosts.filter((x) => x.status !== 'ONLINE').length,
      agentAbnormal: 0
    },
    clusters,
    alarms: [],
    tasks: [],
    warnings: warningsOf(s)
  }
}

/** 能力缺失时给界面的提示，避免用户以为是应用 bug */
function warningsOf(s: ObSnapshot): string[] {
  const out: string[] = []
  if (!has(s.cap, 'GV$OB_SQL_AUDIT') && !has(s.cap, 'V$OB_SQL_AUDIT')) {
    out.push('当前实例未开放 SQL 审计视图，SQL 诊断页不可用')
  }
  if (!has(s.cap, 'DBA_OB_BACKUP_JOBS')) {
    out.push('当前实例无备份视图，备份恢复页不可用')
  }
  if (!has(s.cap, 'GV$OB_SERVERS')) {
    out.push('缺少 GV$OB_SERVERS，CPU / 内存 / 磁盘容量将显示为未知')
  }
  return out
}

// ---------------------------------------------------------------- 详情

export async function clusterDetailOf(
  p: ObDirectPlatform,
  password: string,
  clusterId: number,
  evaluate: (s: ObSnapshot) => Promise<{ total: number; levels: AlarmLevelCount[]; critical: number }>
): Promise<CloudClusterDetail> {
  const s = await snapshotOf(p, password)
  const al = await evaluate(s)
  const cluster = clustersOf(s, { total: al.total, levels: al.levels })[0]
  const tenants = tenantsOf(s, cluster)

  const zones = s.zones.map((z) => {
    const name = str(z.ZONE)
    const servers = s.servers.filter((r) => str(r.ZONE) === name)
    return {
      name,
      idc: str(z.IDC),
      region: str(z.REGION),
      status: str(z.STATUS),
      serverCount: servers.length,
      rootServer: servers.find((r) => str(r.WITH_ROOTSERVER) === 'YES') ? str(servers[0].SVR_IP) : ''
    }
  })

  const servers = s.servers.map((r) => ({
    id: hashId(`${str(r.SVR_IP)}:${num(r.SVR_PORT)}`),
    ip: str(r.SVR_IP),
    zone: str(r.ZONE),
    status: str(r.STATUS),
    hostStatus: str(r.STATUS) === 'ACTIVE' ? 'ONLINE' : 'OFFLINE',
    withRootserver: str(r.WITH_ROOTSERVER) === 'YES',
    version: versionOf(str(r.BUILD_VERSION)),
    startTime: str(r.START_SERVICE_TIME)
  }))

  return {
    cluster,
    attributes: [
      { key: '接入方式', label: '直连（无 OCP）' },
      { key: '集群名', label: cluster.name },
      { key: '版本', label: cluster.version },
      { key: '部署形态', label: cluster.clusterMode },
      { key: 'Zone 数', label: String(zones.length) },
      { key: 'OBServer 数', label: String(servers.length) },
      { key: '租户数', label: String(tenants.length) }
    ],
    zones,
    servers,
    tenants,
    startupParameters: await startupParametersOf(p, password),
    unitSpecs: s.units.map((u) => ({
      name: `unit_${num(u.UNIT_ID)}`,
      cpu: num(u.MAX_CPU),
      memory: num(u.MEMORY_SIZE),
      type: str(u.STATUS)
    }))
  }
}

/** 集群级启动参数：OCP 详情页展示的那一类（EDIT_LEVEL/INFO 里挑常用的） */
async function startupParametersOf(p: ObDirectPlatform, password: string): Promise<{ key: string; value: string }[]> {
  const WANTED = [
    'cluster', 'zone', 'datafile_size', 'datafile_disk_percentage', 'memory_limit',
    'memory_limit_percentage', 'system_memory', 'cpu_count', 'log_disk_size',
    'enable_syslog_recycle', 'max_syslog_file_count', 'ob_query_timeout', 'ob_trx_timeout'
  ]
  try {
    const rows = await q<any>(
      p, password,
      `SELECT NAME, VALUE FROM oceanbase.GV$OB_PARAMETERS
       WHERE SVR_IP = (SELECT MIN(SVR_IP) FROM oceanbase.GV$OB_PARAMETERS) AND NAME IN (${WANTED.map(() => '?').join(',')})`,
      WANTED
    )
    const map = new Map(rows.map((r) => [str(r.NAME), str(r.VALUE)]))
    return WANTED.filter((k) => map.has(k)).map((k) => ({ key: k, value: map.get(k)! }))
  } catch {
    return []
  }
}

export async function tenantDetailOf(
  p: ObDirectPlatform,
  password: string,
  tenantId: number
): Promise<CloudTenantDetail | null> {
  const s = await snapshotOf(p, password)
  const cluster = clustersOf(s, { total: 0, levels: [] })[0]
  const tenant = tenantsOf(s, cluster).find((t) => t.id === tenantId)
  if (!tenant) return null

  const units = s.units.filter((u) => num(u.TENANT_ID) === tenantId)
  // 按 Zone 聚合：OCP 详情页一个 Zone 一行，units 里挂该 Zone 内的 Unit 实例
  const zoneMap = new Map<string, {
    name: string
    replicaType: string
    poolName: string
    unitCount: number
    unitCpu: number
    unitMemory: number
    units: { id: number; ip: string; port: number; status: string }[]
  }>()
  for (const u of units) {
    const zone = str(u.ZONE)
    if (!zoneMap.has(zone)) {
      zoneMap.set(zone, {
        name: zone,
        replicaType: 'FULL',
        poolName: `pool_${num(u.RESOURCE_POOL_ID)}`,
        unitCount: 0,
        unitCpu: 0,
        unitMemory: 0,
        units: []
      })
    }
    const z = zoneMap.get(zone)!
    z.unitCount += 1
    z.unitCpu += num(u.MAX_CPU)
    z.unitMemory += num(u.MEMORY_SIZE)
    z.units.push({
      id: num(u.UNIT_ID),
      ip: str(u.SVR_IP),
      port: num(u.SVR_PORT),
      status: str(u.STATUS)
    })
  }

  // 字符集/排序规则随兼容模式不同：Oracle 模式固定 utf8mb4 + utf8mb4_bin，
  // 之前一律按 MySQL 的 utf8mb4_general_ci 展示，属于错误信息。
  const isOracle = tenant.mode === 'ORACLE'
  return {
    tenant,
    charset: 'utf8mb4',
    collation: isOracle ? 'utf8mb4_bin' : 'utf8mb4_general_ci',
    whitelist: '',
    description: tenant.description ?? '',
    deadLockDetection: false,
    zoneList: [...zoneMap.keys()],
    logBackupRunning: false,
    standbyTenants: [],
    zones: [...zoneMap.values()]
  } as CloudTenantDetail
}

// ---------------------------------------------------------------- SQL 诊断

export interface TopSqlRowLite {
  sqlId: string
  sqlText: string
  executions: number
  avgElapsedMs: number
  maxElapsedMs: number
  avgCpuMs: number
  rowsExamined: number
  retCode: number
  tenantId: number
  lastActiveTime: string
}

/**
 * TopSQL：按平均耗时倒序取窗口内有执行的语句。
 *
 * 两个实测坑（OB 4.3.5.2）：
 *   1) REQUEST_TIME 是**微秒级 epoch 整数**，不是 datetime —— 与 NOW() 比较恒为假，
 *      必须换算成 (UNIX_TIMESTAMP() - 小时*3600) * 1000000。
 *   2) 不能 GROUP BY QUERY_SQL：对长文本列做分组会让查询挂住数分钟，
 *      改成按 SQL_ID 聚合、MIN(QUERY_SQL) 取一条代表文本。
 */
export async function topSqlOf(
  p: ObDirectPlatform,
  password: string,
  opts: { hours?: number; limit?: number; minElapsedMs?: number } = {}
): Promise<TopSqlRowLite[]> {
  const capa = await capabilityOf(p, password)
  const view = sqlAuditView(capa)
  if (!view) return []
  const hours = Math.max(1, Math.min(24 * 7, opts.hours ?? 24))
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
  const minMs = Math.max(0, opts.minElapsedMs ?? 0)

  const rows = await q<any>(
    p, password,
    `SELECT SQL_ID, MIN(QUERY_SQL) AS QUERY_SQL, COUNT(*) AS EXEC,
            AVG(ELAPSED_TIME)/1000 AS AVG_MS, MAX(ELAPSED_TIME)/1000 AS MAX_MS,
            AVG(EXECUTE_TIME)/1000 AS AVG_CPU_MS, SUM(RETURN_ROWS) AS ROWS_OUT,
            MIN(RET_CODE) AS RC, MAX(TENANT_ID) AS TID, MAX(REQUEST_TIME) AS LAST_US
       FROM oceanbase.${view}
      WHERE REQUEST_TIME >= (UNIX_TIMESTAMP() - ? * 3600) * 1000000
        AND SQL_ID IS NOT NULL AND SQL_ID <> ''
        AND ELAPSED_TIME/1000 >= ?
      GROUP BY SQL_ID
      ORDER BY AVG_MS DESC
      LIMIT ?`,
    [hours, minMs, limit]
  )

  return rows.map((r) => ({
    sqlId: str(r.SQL_ID),
    sqlText: str(r.QUERY_SQL).slice(0, 2000),
    executions: num(r.EXEC),
    avgElapsedMs: Math.round(num(r.AVG_MS) * 100) / 100,
    maxElapsedMs: Math.round(num(r.MAX_MS) * 100) / 100,
    avgCpuMs: Math.round(num(r.AVG_CPU_MS) * 100) / 100,
    rowsExamined: num(r.ROWS_OUT),
    retCode: num(r.RC),
    tenantId: num(r.TID),
    // LAST_US 是微秒 epoch，转成本地可读时间
    lastActiveTime: num(r.LAST_US) > 0
      ? new Date(Math.floor(num(r.LAST_US) / 1000)).toISOString()
      : ''
  }))
}

/** 单条 SQL 的完整文本（审计表里 QUERY_SQL 可能被截断，按 SQL_ID 回捞最长的一条） */
export async function sqlTextOf(p: ObDirectPlatform, password: string, sqlId: string): Promise<string> {
  const capa = await capabilityOf(p, password)
  const view = sqlAuditView(capa)
  if (!view || !sqlId) return ''
  const row = await q1<any>(
    p, password,
    `SELECT QUERY_SQL FROM oceanbase.${view} WHERE SQL_ID = ? ORDER BY LENGTH(QUERY_SQL) DESC LIMIT 1`,
    [sqlId]
  )
  return str(row?.QUERY_SQL)
}

// ---------------------------------------------------------------- 参数

export interface ObParameterRow {
  name: string
  value: string
  defaultValue: string
  editLevel: string
  info: string
  zone: string
  server: string
}

export async function parametersOf(
  p: ObDirectPlatform,
  password: string,
  opts: { keyword?: string; limit?: number } = {}
): Promise<ObParameterRow[]> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 300))
  const kw = (opts.keyword ?? '').trim()
  const rows = kw
    ? await q<any>(
        p, password,
        `SELECT * FROM oceanbase.GV$OB_PARAMETERS WHERE NAME LIKE ? OR INFO LIKE ?
          ORDER BY NAME LIMIT ?`,
        [`%${kw}%`, `%${kw}%`, limit]
      )
    : await q<any>(p, password, 'SELECT * FROM oceanbase.GV$OB_PARAMETERS ORDER BY NAME LIMIT ?', [limit])

  // GV$ 每个 OBServer 一行，界面只留一份（取第一台）
  const seen = new Set<string>()
  const out: ObParameterRow[] = []
  for (const r of rows) {
    const name = str(r.NAME)
    if (seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      value: str(r.VALUE),
      defaultValue: str(r.DEFAULT_VALUE),
      editLevel: str(r.EDIT_LEVEL),
      info: str(r.INFO),
      zone: str(r.ZONE),
      server: str(r.SVR_IP)
    })
  }
  return out
}

// ---------------------------------------------------------------- 运维事件

export interface ObEventRow {
  timestamp: string
  module: string
  event: string
  name1: string
  value1: string
  name2: string
  value2: string
  rsSvrIp: string
}

/** 运维任务流水：RS 事件历史（等价于 OCP 任务页的只读版） */
export async function eventsOf(
  p: ObDirectPlatform,
  password: string,
  opts: { limit?: number; hours?: number; keyword?: string } = {}
): Promise<ObEventRow[]> {
  const capa = await capabilityOf(p, password)
  if (!has(capa, 'DBA_OB_ROOTSERVICE_EVENT_HISTORY')) return []
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100))
  const hours = Math.max(1, Math.min(24 * 30, opts.hours ?? 72))
  const kw = (opts.keyword ?? '').trim()
  const rows = await q<any>(
    p, password,
    `SELECT TIMESTAMP, MODULE, EVENT, NAME1, VALUE1, NAME2, VALUE2, RS_SVR_IP
       FROM oceanbase.DBA_OB_ROOTSERVICE_EVENT_HISTORY
      WHERE TIMESTAMP >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        ${kw ? 'AND (EVENT LIKE ? OR NAME1 LIKE ?)' : ''}
      ORDER BY TIMESTAMP DESC LIMIT ?`,
    kw ? [hours, `%${kw}%`, `%${kw}%`, limit] : [hours, limit]
  )
  return rows.map((r) => ({
    timestamp: str(r.TIMESTAMP),
    module: str(r.MODULE),
    event: str(r.EVENT),
    name1: str(r.NAME1),
    value1: str(r.VALUE1),
    name2: str(r.NAME2),
    value2: str(r.VALUE2),
    rsSvrIp: str(r.RS_SVR_IP)
  }))
}
