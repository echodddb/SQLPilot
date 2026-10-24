/**
 * Oracle 云平台的数据契约。
 *
 * 与 OCP 那种「调平台 REST 接口」不同，这里所有数据都是直接查库（v$ / dba_ 视图）。
 * 因此每个分区都带 warnings：某项视图无权限或版本不支持时，其余数据照常返回。
 */

export type OraSectionKey =
  | 'env'
  | 'overview'
  | 'rac'
  | 'instances'
  | 'pdb'
  | 'storage'
  | 'sessions'
  | 'sql'
  | 'perf'
  | 'alerts'
  | 'backup'
  | 'dg'
  | 'jobs'
  | 'params'
  | 'users'

export interface CloudOraclePlatform {
  id: string
  name: string
  type: 'oracle'
  host: string
  port: number
  serviceName: string
  username: string
  /** 连接身份：普通 / SYSDBA / SYSOPER */
  role?: 'default' | 'sysdba' | 'sysoper'
  /** 11g 等老版本不支持 thin 模式，需要 Instant Client 目录（thick 模式） */
  instantClientDir?: string
}

/** 单个分区的一次采集结果 */
export interface OraSectionResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  /** 部分视图不可用时的降级说明（不影响 ok） */
  warnings: string[]
  /** 本次采集耗时（毫秒） */
  ms: number
  /** 采集完成时间（ISO） */
  at: string
}

export interface OraInstanceRow {
  instId: number
  instanceNumber: number
  instanceName: string
  hostName: string
  version: string
  status: string
  instanceRole: string
  activeState: string
  databaseStatus: string
  startupTime: string
}

export interface OraInfo {
  /** 库基本信息 */
  dbName: string
  dbUniqueName: string
  databaseRole: string
  openMode: string
  protectionMode: string
  logMode: string
  flashbackOn: string
  forceLogging: string
  platformName: string
  created: string
  dbid: number
  version: string
  edition: string
  /** 拓扑判定 */
  isRac: boolean
  isCdb: boolean
  instances: OraInstanceRow[]
  /** 采集通道：thin / thick */
  mode: string
  collectedAt: string
  /** 降级/权限提示 */
  warnings: string[]
}

// ---------- 总览 ----------

export interface OraKpi {
  label: string
  value: string
  sub?: string
  tone?: 'ok' | 'warn' | 'bad'
  /** 采集来源 key（渲染层磁贴的 data-src）：悬浮时只显示这个指标的视图与 SQL */
  src?: string
}

export interface OraOverview {
  info: OraInfo
  kpis: OraKpi[]
  /** 各实例会话数 / 活跃数 */
  instances: { name: string; host: string; status: string; sessions: number; active: number }[]
  /** 表空间水位（TOP） */
  tablespaces: { name: string; usedPct: number; usedMb: number; sizeMb: number; autoext: number }[]
  /** 近 12 小时告警条数 */
  alertHours: { hour: string; count: number }[]
  /** 等待事件 TOP */
  waits: { event: string; waitClass: string; timeS: number }[]
  /** 关键运行指标 */
  metrics: { name: string; value: number; unit: string }[]
  /** 需要关注的问题（本地规则推导，不依赖平台） */
  issues: { level: 'bad' | 'warn' | 'info'; title: string; detail: string }[]
}

// ---------- RAC ----------

export interface OraRacNode {
  instId: number
  instanceName: string
  hostName: string
  status: string
  instanceRole: string
  activeState: string
  databaseStatus: string
  startupTime: string
  version: string
  sessions: number
  active: number
}

export interface OraRacService {
  instId: number
  serviceId: number
  name: string
  networkName: string
}

export interface OraRac {
  /** cluster_database 参数值（TRUE 才是 RAC） */
  clusterDatabase: string
  configuredInstances: number
  nodes: OraRacNode[]
  services: OraRacService[]
  interconnects: { instId: number; name: string; ip: string; isPublic: string; source: string }[]
  /** 活跃实例（v$active_instances） */
  activeInstances: { instNumber: number; instName: string }[]
}

// ---------- 实例 ----------

export interface OraInstanceDetail {
  instId: number
  instanceName: string
  hostName: string
  status: string
  startupTime: string
  version: string
  instanceRole: string
  activeState: string
  dbStatus: string
  sgaMb: number
  pgaMb: number
  processes: string
  sessions: string
  dbBlockSize: string
  compat: string
  optimizerMode: string
  cursorSharing: string
  openCursors: string
  undoTablespace: string
  defaultTempTs: string
  osCpus: number
  osMemGb: number
  load: number
  /** 资源使用率 */
  resource: { name: string; current: number; max: number }[]
  /** SGA 组成 */
  sga: { name: string; mb: number }[]
  /** PGA 汇总 */
  pga: { name: string; mb: number }[]
  /** 缓冲池命中 */
  bufferHit: { name: string; missPct: number; gets: number }[]
}

// ---------- PDB ----------

export interface OraPdb {
  conId: number
  name: string
  openMode: string
  restricted: string
  openTime: string
  /** v$containers 有的话补充 */
  conType?: string
}

export interface OraPdbSection {
  isCdb: boolean
  /** 非 CDB 时给出说明 */
  note: string
  pdbs: OraPdb[]
  /** 每个容器的数据文件占用（12c+） */
  files: { conId: number; name: string; sizeMb: number }[]
}

// ---------- 存储 ----------

export interface OraTablespace {
  name: string
  contents: string
  status: string
  bigfile: string
  logging: string
  sizeMb: number
  usedMb: number
  freeMb: number
  usedPct: number
  maxMb: number
  files: number
  autoext: number
}

export interface OraDatafile {
  fileId: number
  fileName: string
  tablespace: string
  sizeMb: number
  autoextensible: string
  maxMb: number
  incMb: number
  status: string
  onlineStatus: string
}

export interface OraStorage {
  tablespaces: OraTablespace[]
  temp: { name: string; totalMb: number; usedMb: number; freeMb: number; usedPct: number }[]
  undo: {
    segments: { status: string; count: number }[]
    recent: { begin: string; end: string; undoblks: number; txnCount: number; maxQueryLen: number; ssolderrcnt: number; nospaceerrcnt: number }[]
  }
  datafiles: OraDatafile[]
  asm: { name: string; state: string; type: string; totalMb: number; freeMb: number; usableMb: number; usedPct: number; disks: number }[]
  /** 归档与 FRA */
  archive: {
    dests: { destId: number; status: string; destination: string; syncStatus: string; synchronized: string; error: string; dbUnique: string; gapStatus: string; archivedSeq: number; appliedSeq: number }[]
    last24h: { count: number; gb: number }
  }
  fra: { name: string; limitGb: number; usedGb: number; reclaimGb: number; files: number; usage: { type: string; usedPct: number; reclaimPct: number; files: number }[] } | null
  redo: { group: number; thread: number; sequence: number; mb: number; members: number; status: string; archived: string; firstTime: string }[]
}

// ---------- 会话 ----------

export interface OraSessionRow {
  instId: number
  sid: number
  serial: number
  username: string
  status: string
  machine: string
  program: string
  sqlId: string
  event: string
  waitClass: string
  secondsInWait: number
  blockingSession: number | null
  lastCallEt: number
  spid: string
  logonTime: string
}

export interface OraSessions {
  summary: { status: string; type: string; count: number }[]
  waitClass: { waitClass: string; count: number }[]
  list: OraSessionRow[]
  blocking: { instId: number; sid: number; type: string; lmode: string; request: string; ctime: number; blockerSid: number; blockerUser: string; blockerSql: string; username: string; sqlId: string; event: string }[]
  longops: { instId: number; sid: number; opname: string; target: string; pct: number; timeRemaining: number; elapsed: number; sqlId: string }[]
}

// ---------- SQL ----------

export interface OraSqlRow {
  sqlId: string
  planHash: number
  executions: number
  elapsedS: number
  cpuS: number
  avgMs: number
  bufferGets: number
  diskReads: number
  getsPerExec: number
  readsPerExec: number
  rowsProcessed: number
  schema: string
  module: string
  lastActive: string
}

export interface OraSqlSection {
  /** 当前排序维度：elapsed / cpu / gets / disk */
  by: string
  rows: OraSqlRow[]
  /** AWR 历史 TOP（近 N 个快照） */
  awr: { sqlId: string; executions: number; elapsedS: number; cpuS: number; gets: number; reads: number }[]
  /** 最近快照区间说明 */
  awrRange: string
  /** 单条 SQL 详情（点开时单独查） */
  detail?: {
    sqlId: string
    text: string
    plan: { id: number; depth: number; operation: string; options: string; objectName: string; cost: number; cardinality: number; bytes: number }[]
  }
}

// ---------- 性能 ----------

export interface OraPerf {
  metrics: { name: string; value: number; unit: string; pct?: number }[]
  sysstat: { name: string; value: number }[]
  systemEvent: { event: string; waitClass: string; totalWaits: number; timeS: number; avgMs: number }[]
  ash: { sqlId: string; event: string; state: string; samples: number }[]
  ashWindow: string
  osstat: { name: string; value: number }[]
  sga: { name: string; mb: number }[]
  pga: { name: string; mb: number }[]
}

// ---------- 告警日志 ----------

export interface OraAlertGroup {
  pattern: string
  count: number
  firstTs: string
  lastTs: string
  /** 是否含 ORA- 错误 */
  isError: boolean
}

export interface OraAlerts {
  hours: number
  total: number
  errorCount: number
  groups: OraAlertGroup[]
  byHour: { hour: string; count: number; errors: number }[]
  recent: { ts: string; type: number; level: number; msg: string }[]
  ora: { ts: string; msg: string }[]
}

// ---------- 备份 ----------

export interface OraBackup {
  jobs: { sessionKey: number; commandId: string; status: string; startTime: string; endTime: string; elapsedS: number; inputType: string; device: string; outputGb: number }[]
  sets: { recid: number; backupType: string; incremental: string; done: string; gb: number; pieces: number }[]
  archive: { count24h: number; gb24h: number }
  /** 最近一次成功/失败 */
  lastFull: string
  lastStatus: string
  fra: { usedGb: number; limitGb: number; usedPct: number } | null
}

// ---------- Data Guard ----------

export interface OraDg {
  /** v$dataguard_stats 是否为空（没有备库/未采集） */
  available: boolean
  stats: { name: string; value: string; unit: string; timeComputed: string }[]
  dests: { destId: number; status: string; type: string; dbMode: string; recoveryMode: string; protectionMode: string; destination: string; error: string; dbUnique: string; synchronized: string; gapStatus: string; archivedSeq: number; appliedSeq: number }[]
  processes: { process: string; status: string; thread: number; sequence: number; block: number }[]
  role: string
  protectionMode: string
}

// ---------- 作业 ----------

export interface OraJobs {
  scheduler: { owner: string; jobName: string; enabled: string; state: string; runCount: number; failureCount: number; lastStart: string; nextRun: string }[]
  dbms: { job: number; logUser: string; broken: string; failures: number; lastDate: string; nextDate: string; what: string }[]
  runs: { owner: string; jobName: string; status: string; startTime: string; durationS: number; info: string }[]
}

// ---------- 参数 ----------

export interface OraParams {
  /** 非默认值参数 */
  changed: { name: string; value: string; modifiable: string; desc: string }[]
  /** 关键参数（无论是否默认） */
  key: { name: string; value: string; isDefault: string; modifiable: string }[]
}

// ---------- 用户与对象 ----------

export interface OraUsers {
  users: { username: string; status: string; expiry: string; defaultTs: string; tempTs: string; profile: string; created: string; authType: string }[]
  pwfile: { username: string; sysdba: string; sysoper: string; admin: string }[]
  roles: { role: string; adminOption: string; defaultRole: string }[]
  privs: { privilege: string; adminOption: string }[]
  invalid: { owner: string; objectType: string; count: number }[]
  objectTypes: { objectType: string; count: number }[]
  segments: { owner: string; name: string; type: string; tablespace: string; mb: number }[]
  totalObjects: number
}

/** 环境列表用的轻量概要：只用 7 条 SQL，列表页每套环境各查一次 */
export interface OraEnvSummary {
  dbName: string
  dbUniqueName: string
  databaseRole: string
  openMode: string
  logMode: string
  version: string
  isRac: boolean
  isCdb: boolean
  /** 实例数 / 处于 OPEN 的实例数 */
  instances: number
  instancesOpen: number
  /** 最早与最晚的启动时间（RAC 下节点重启时间不同，给个区间） */
  startupTime: string
  sessions: number
  activeSessions: number
  /** 水位最高的表空间 */
  tsWorst: { name: string; usedPct: number } | null
  blocking: number
  invalid: number
  longops: number
  collectedAt: string
}

/** 各分区数据结构的汇总表（渲染层按 key 取用） */
export interface OraSections {
  env: OraEnvSummary
  overview: OraOverview
  rac: OraRac
  instances: OraInstanceDetail[]
  pdb: OraPdbSection
  storage: OraStorage
  sessions: OraSessions
  sql: OraSqlSection
  perf: OraPerf
  alerts: OraAlerts
  backup: OraBackup
  dg: OraDg
  jobs: OraJobs
  params: OraParams
  users: OraUsers
}
