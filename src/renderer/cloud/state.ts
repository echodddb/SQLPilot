/**
 * 云管平台模块状态（模块级 reactive store）。
 * 与数据库控制台同样的约定：状态放在模块级 store，切换一级模块时组件卸载也不丢。
 * 数据全部由主进程聚合后下发，这里只做缓存、切换与请求编排。
 */

import { reactive } from 'vue'
import { METRIC_SETS, type MonitorScope } from './metrics'
import type { EngineId } from './engines'

export type CloudView =
  | 'overview'
  | 'clusters'
  | 'tenants'
  | 'obproxy'
  | 'hosts'
  | 'backup'
  | 'inspection'
  | 'monitor'
  | 'sqldiag'
  | 'alarms'
  | 'tasks'
  | 'platform'

export const CLOUD_VIEWS: { key: CloudView; label: string; icon: string; desc: string }[] = [
  { key: 'overview', label: '总览', icon: '◎', desc: '集群健康 / 容量水位 / 活跃告警 / 最近任务' },
  { key: 'clusters', label: '集群', icon: '▦', desc: 'OB 集群列表与详情：Zone / OBServer / 租户' },
  { key: 'tenants', label: '租户', icon: '❐', desc: '跨集群租户总览，含资源池与副本分布' },
  { key: 'obproxy', label: 'OBProxy', icon: '⇄', desc: 'OBProxy 集群：代理实例、连接 OB 集群、参数' },
  { key: 'hosts', label: '主机', icon: '▤', desc: 'OCP 纳管主机：Agent 状态、机型、承载服务' },
  { key: 'backup', label: '备份恢复', icon: '⛁', desc: '备份策略与对象、备份/恢复任务、备份存储与告警' },
  { key: 'inspection', label: '巡检', icon: '✓', desc: '集群 / 租户 / OBProxy 巡检概览与巡检报告' },
  { key: 'monitor', label: '资源监控', icon: '∿', desc: '集群 / 租户 / 主机的性能指标曲线（QPS、TPS、会话、CPU、内存、IO）' },
  { key: 'sqldiag', label: 'SQL 诊断', icon: '⌁', desc: 'TopSQL / 慢 SQL：按 CPU、耗时、执行次数排序，定位吃资源的语句' },
  { key: 'alarms', label: '告警', icon: '⚠', desc: '当前活跃告警，按级别筛选' },
  { key: 'tasks', label: '任务', icon: '⟳', desc: 'OCP 运维任务流水与子任务进度' },
  { key: 'platform', label: '平台管理', icon: '⚙', desc: 'OCP 用户 / 角色 / 平台参数 / 登录审计' }
]

/** 云管平台的两类厂商入口：OceanBase（调 OCP 接口）/ Oracle（直连查库） */
export type CloudVendor = 'ocp' | 'oracle'

export const cloud = reactive({
  /** 平台清单（config.json） */
  platforms: [] as CloudPlatformView[],
  /** 当前选中的厂商入口（左侧「OceanBase / Oracle」同级切换） */
  vendor: 'ocp' as CloudVendor,
  /** 是否停在「选择数据库云平台」整页（进来了但还没选类型） */
  picking: true,
  /** 选完类型后的架构装配动画；null = 已经进到控制台 */
  intro: null as EngineId | null,
  /** 只做了架构预览的引擎（还没接真实接口）：非空时渲染占位控制台 */
  preview: null as EngineId | null,
  activeId: '' as string,
  /** 当前平台登录态 */
  status: null as { ok: boolean; info?: CloudOcpInfo; error?: string; oracle?: { version?: string; mode?: string } } | null,
  view: 'overview' as CloudView,

  loading: false,
  error: '',
  /** 最近一次成功刷新的时间戳（毫秒） */
  updatedAt: 0,

  overview: null as CloudOverview | null,
  clusters: [] as CloudCluster[],
  hosts: [] as CloudHost[],
  tenants: [] as CloudTenant[],
  alarms: [] as CloudAlarm[],
  alarmTotal: 0,
  alarmLevel: 0,
  /** 告警对象类型筛选：'' 全部 / Host / Cluster / Tenant / Service */
  alarmScope: '',
  alarmKeyword: '',
  /** 应用筛选：OCP / OceanBase …（OCP 告警事件页的「应用」列） */
  alarmAppType: '',
  /** 告警类型下钻（点分类或「同类型」时带上） */
  alarmType: '',
  /** 告警子 tab：活跃 / 历史（已恢复） */
  alarmTab: 'active' as 'active' | 'history',
  /** 告警页一级 tab：事件 / 规则 */
  alarmSubTab: 'event' as 'event' | 'rule',
  alarmLevelCounts: [] as { level: number; count: number }[],
  alarmHistory: { items: [] as CloudAlarm[], total: 0, page: 1, size: 50, hours: 24 },
  /** 近 N 小时分布：趋势 / 分类 / Top 告警类型 */
  alarmTrend: null as CloudAlarmTrend | null,
  alarmTrendHours: 24,
  /** 单条告警详情（点开时单独拉 /alarm/alarms/{id}） */
  alarmDetail: null as CloudAlarm | null,
  alarmDetailLoading: false,
  /** 同类型告警近 7 天统计（详情抽屉里用） */
  alarmSameType: { alarmType: '', total: 0, hours: 168, loading: false },
  /** 告警规则（只读列表） */
  alarmRules: {
    items: [] as CloudAlarmRule[],
    total: 0,
    page: 1,
    size: 20,
    level: 0,
    scope: '',
    keyword: '',
    /** '' 全部 / true 仅启用 / false 仅停用 */
    enabled: '' as '' | boolean
  },
  rulesUpdatedAt: 0,
  tasks: { items: [] as CloudTask[], total: 0, page: 1, size: 20, status: '', name: '' },
  /** 任务筛选：服务端只认 clusterId / tenantId，其余由主进程在候选集里过滤 */
  taskFilter: {
    clusterId: 0,
    creator: '',
    objType: '',
    type: '' as '' | 'MANUAL' | 'AUTO',
    hours: 0,
    sort: 'start_desc' as 'start_desc' | 'start_asc' | 'duration_desc'
  },
  taskScanned: 0,
  taskTruncated: false,
  /** 任务详情抽屉 */
  taskDetail: null as CloudTaskDetail | null,
  taskDetailLoading: false,
  taskStats: [] as { status: string; count: number }[],
  taskCreators: [] as string[],
  taskUpdatedAt: 0,

  /** 下钻：集群详情 */
  clusterId: null as number | null,
  cluster: null as CloudClusterDetail | null,
  /** 下钻：租户详情（抽屉） */
  tenant: null as CloudTenantDetail | null,
  /** 下钻：主机详情（抽屉，数据取自 hosts 列表，不额外请求） */
  host: null as CloudHost | null,

  /** 资源监控 */
  monitor: {
    scope: 'CLUSTER' as MonitorScope,
    entityKey: '',
    rangeSec: 1800,
    metrics: ['sql_all_count', 'tps', 'active_session', 'cpu_percent'] as string[],
    series: [] as CloudMetricSeries[],
    warnings: [] as string[],
    loading: false,
    updatedAt: 0,
    error: ''
  },

  /** SQL 诊断（TopSQL / 慢 SQL） */
  sqldiag: {
    /** 0 表示未选，加载时自动取第一个业务集群 */
    clusterId: 0,
    /** 0 表示全部租户（走集群级 TopSQL） */
    tenantId: 0,
    rangeSec: 3600,
    /** 客户端的排序维度（OCP 的 topSql 端点不支持服务端排序） */
    sort: 'cpu' as 'cpu' | 'avg' | 'max' | 'exec',
    /** 默认隐藏 sys 租户与内部 SQL（定时任务、统计采集会把列表淹掉） */
    hideInner: true,
    search: '',
    rows: [] as CloudTopSqlRow[],
    slow: [] as CloudTopSqlRow[],
    stats: [] as CloudTenantSqlStat[],
    /** 展开行时按 sqlId 懒加载的完整 SQL（key = tenantId|sqlId） */
    sqlText: {} as Record<string, CloudSqlTextInfo & { loading?: boolean; error?: string }>,
    loading: false,
    error: '',
    updatedAt: 0
  },

  settingsOpen: false,
  /** 全局搜索面板（Ctrl+K） */
  searchOpen: false,

  /** 备份恢复（对齐 OCP「备份恢复」：核心指标 / 对象 / 任务 / 存储 / 告警） */
  backup: {
    bundle: null as CloudBackupBundle | null,
    /** 对象页签：全部 / 已建策略 / 未建策略 */
    objFilter: 'all' as 'all' | 'has' | 'none',
    /** 任务页签 */
    taskKind: 'data' as CloudBackupTaskKind,
    loading: false,
    error: '',
    updatedAt: 0
  },

  /** OBProxy：集群列表 + 详情抽屉（实例 / 连接 / 参数） */
  obproxy: {
    clusters: [] as CloudObproxyCluster[],
    drawerId: 0,
    detail: null as CloudObproxyCluster | null,
    params: [] as CloudObproxyParam[],
    paramKeyword: '',
    loading: false,
    detailLoading: false,
    error: '',
    updatedAt: 0
  },

  /** 巡检：对象概览（集群/租户/Proxy）+ 报告历史 + 报告详情 */
  inspection: {
    bundle: null as CloudInspectionBundle | null,
    type: 'OB_CLUSTER' as CloudInspectionObjectType,
    report: null as CloudInspectionReport | null,
    reportOpen: false,
    /** 报告明细过滤：'' 全部 / 'abnormal' 只看异常结果 */
    riskFilter: '' as '' | 'abnormal',
    loading: false,
    reportLoading: false,
    error: '',
    updatedAt: 0
  },

  /** 平台管理：用户 / 角色 / 平台参数 / 登录审计 */
  platform: {
    bundle: null as CloudPlatformBundle | null,
    tab: 'users' as 'users' | 'roles' | 'properties' | 'logins' | 'system',
    propKeyword: '',
    propPage: 1,
    propSize: 100,
    loading: false,
    error: '',
    updatedAt: 0
  }
})

let seq = 0

export const activePlatform = (): CloudPlatformView | undefined =>
  cloud.platforms.find((p) => p.id === cloud.activeId)

/** 某个厂商下的所有平台：OCP 通常一个，Oracle 可能有多套环境 */
export const platformsOf = (vendor: CloudVendor): CloudPlatformView[] =>
  cloud.platforms.filter((p) => (p.type === 'oracle' ? 'oracle' : 'ocp') === vendor)

/** 清空 OCP 各页缓存（切平台/切厂商时用，避免看到上一家的数据） */
function resetOcpData(): void {
  cloud.overview = null
  cloud.clusters = []
  cloud.hosts = []
  cloud.tenants = []
  cloud.alarms = []
  cloud.alarmHistory = { items: [], total: 0, page: 1, size: 50, hours: 24 }
  cloud.alarmLevelCounts = []
  cloud.tasks = { items: [], total: 0, page: 1, size: 20, status: '', name: '' }
  cloud.taskStats = []
  cloud.taskCreators = []
  cloud.taskUpdatedAt = 0
  cloud.clusterId = null
  cloud.cluster = null
  cloud.tenant = null
  cloud.host = null
  cloud.backup.bundle = null
  cloud.obproxy.clusters = []
  cloud.obproxy.drawerId = 0
  cloud.obproxy.detail = null
  cloud.obproxy.params = []
  cloud.inspection.bundle = null
  cloud.inspection.report = null
  cloud.inspection.reportOpen = false
  cloud.platform.bundle = null
  cloud.error = ''
}

export async function loadPlatforms(): Promise<void> {
  cloud.platforms = await window.sqlpilot.cloudPlatforms()
  const list = platformsOf(cloud.vendor)
  if (!cloud.activeId) {
    // 首次进入：取清单里第一条（可能是 Oracle 环境），厂商入口随后由 initCloud 按它的类型决定
    cloud.activeId = (cloud.platforms[0] || list[0])?.id || ''
    return
  }
  // 之后 activeId 必须落在当前厂商下，否则切厂商后又跳回上一家的平台
  if (!list.some((p) => p.id === cloud.activeId)) cloud.activeId = list[0]?.id || ''
}

/** 切换厂商入口（OceanBase / Oracle 同级）：换到该厂商的第一个平台并清空缓存 */
export async function setVendor(vendor: CloudVendor): Promise<void> {
  if (cloud.vendor === vendor) return
  cloud.vendor = vendor
  cloud.view = 'overview'
  resetOcpData()
  const list = platformsOf(vendor)
  cloud.activeId = list[0]?.id || ''
  if (!cloud.activeId) return
  if (vendor === 'ocp') {
    await checkStatus()
    if (cloud.status?.ok) await load()
  } else {
    // Oracle 没有单一"登录态"：每套环境各自探活，交给环境列表
    cloud.status = null
  }
}

/** 进入模块时的初始化：拉平台清单 → 探活 → 载入当前视图 */
export async function initCloud(): Promise<void> {
  try {
    await loadPlatforms()
  } catch (e: any) {
    cloud.error = `读取云管平台配置失败：${e?.message || e}`
    return
  }
  // 记住上次用的厂商：activeId 指向 Oracle 平台就直接进 Oracle 入口
  const cur = activePlatform()
  if (cur?.type === 'oracle') cloud.vendor = 'oracle'
  if (!cloud.activeId) {
    // 没有任何平台时：哪个厂商有平台就进哪个，都没有则停在 OceanBase 的空态
    cloud.vendor = platformsOf('ocp').length || !platformsOf('oracle').length ? 'ocp' : 'oracle'
    return
  }
  if (cloud.vendor === 'oracle') return
  await checkStatus()
  if (cloud.status?.ok) await load()
}

export async function checkStatus(): Promise<void> {
  if (!cloud.activeId) return
  if (cloud.vendor === 'oracle') return
  cloud.status = { ok: false }
  const r = await window.sqlpilot.cloudStatus(cloud.activeId)
  cloud.status = { ok: r.ok, info: r.info, error: r.error, oracle: r.oracle }
  if (!r.ok) cloud.error = r.error || 'OCP 连接失败'
}

export async function selectPlatform(id: string): Promise<void> {
  if (id === cloud.activeId) return
  cloud.activeId = id
  resetOcpData()
  await checkStatus()
  if (cloud.status?.ok) await load()
}

export function setView(v: CloudView): void {
  if (cloud.view === v) return
  cloud.view = v
  cloud.clusterId = null
  cloud.cluster = null
  cloud.tenant = null
  cloud.host = null
  cloud.error = ''
  void load()
}

/** 告警页数据：活跃 / 历史两个子 tab，筛选条件共用 */
async function loadAlarms(my: number): Promise<void> {
  const common = {
    level: cloud.alarmLevel || undefined,
    scope: cloud.alarmScope || undefined,
    keyword: cloud.alarmKeyword.trim() || undefined,
    alarmType: cloud.alarmType || undefined,
    appType: cloud.alarmAppType || undefined
  }
  if (cloud.alarmTab === 'active') {
    const r = await window.sqlpilot.cloudAlarms(cloud.activeId, { ...common, hours: cloud.alarmHistory.hours || undefined })
    if (my !== seq) return
    if (!r.ok) { cloud.error = r.error || '获取告警失败'; return }
    cloud.alarms = r.data?.items || []
    cloud.alarmTotal = r.data?.total || cloud.alarms.length
    // 顺带同步历史告警总数（只取 1 条），让「历史告警」tab 上的计数有意义
    const h = await window.sqlpilot.cloudAlarmHistory(cloud.activeId, { page: 1, size: 1, hours: cloud.alarmHistory.hours, ...common }).catch(() => null)
    if (h?.ok && h.data) cloud.alarmHistory.total = h.data.total
  } else {
    const h = cloud.alarmHistory
    const r = await window.sqlpilot.cloudAlarmHistory(cloud.activeId, { page: h.page, size: h.size, hours: h.hours, ...common })
    if (my !== seq) return
    if (!r.ok) { cloud.error = r.error || '获取历史告警失败'; return }
    h.items = r.data?.items || []
    h.total = r.data?.total || 0
  }
  const [c, t] = await Promise.all([
    window.sqlpilot.cloudAlarmLevelCounts(cloud.activeId).catch(() => null),
    cloud.alarmSubTab === 'event'
      ? window.sqlpilot.cloudAlarmTrend(cloud.activeId, cloud.alarmTrendHours).catch(() => null)
      : Promise.resolve(null)
  ])
  if (my !== seq) return
  if (c?.ok) cloud.alarmLevelCounts = c.data || []
  if (t?.ok && t.data) cloud.alarmTrend = t.data
}

/** 告警规则列表（只读）：独立于告警事件，切换 tab 时才拉 */
export async function loadAlarmRules(): Promise<void> {
  if (!cloud.activeId) return
  const r = cloud.alarmRules
  r.total = r.total || 0
  const res = await window.sqlpilot.cloudAlarmRules(cloud.activeId, {
    page: r.page,
    size: r.size,
    level: r.level || undefined,
    scope: r.scope || undefined,
    keyword: r.keyword.trim() || undefined,
    enabled: r.enabled === '' ? undefined : r.enabled
  })
  if (!res.ok) { cloud.error = res.error || '获取告警规则失败'; return }
  cloud.error = ''
  r.items = res.data?.items || []
  r.total = res.data?.total || 0
  cloud.rulesUpdatedAt = Date.now()
}

export async function setAlarmSubTab(tab: 'event' | 'rule'): Promise<void> {
  if (cloud.alarmSubTab === tab) return
  cloud.alarmSubTab = tab
  cloud.error = ''
  if (tab === 'rule') { await loadAlarmRules(); return }
  await load()
}

export async function setAlarmRuleFilter(patch: Partial<{ level: number; scope: string; keyword: string; enabled: '' | boolean }>): Promise<void> {
  Object.assign(cloud.alarmRules, patch, { page: 1 })
  await loadAlarmRules()
}

export async function setAlarmRulePage(page: number): Promise<void> {
  cloud.alarmRules.page = Math.max(1, page)
  await loadAlarmRules()
}

/** 打开告警详情：列表数据先顶上，再用详情接口补齐指标分组/标签 */
export async function openAlarm(a: CloudAlarm): Promise<void> {
  cloud.alarmDetail = a
  cloud.alarmDetailLoading = true
  cloud.alarmSameType = { alarmType: a.alarmType, total: 0, hours: 168, loading: true }
  const [r, same] = await Promise.all([
    window.sqlpilot.cloudAlarmDetail(cloud.activeId, a.id).catch(() => null),
    a.alarmType
      ? window.sqlpilot.cloudAlarmHistory(cloud.activeId, { alarmType: a.alarmType, hours: 168, page: 1, size: 1 }).catch(() => null)
      : Promise.resolve(null)
  ])
  cloud.alarmDetailLoading = false
  if (r?.ok && r.data) cloud.alarmDetail = r.data
  cloud.alarmSameType = { alarmType: a.alarmType, total: same?.ok ? (same.data?.total || 0) : 0, hours: 168, loading: false }
}

export function closeAlarm(): void {
  cloud.alarmDetail = null
  cloud.alarmDetailLoading = false
}

export async function setAlarmAppType(appType: string): Promise<void> {
  cloud.alarmAppType = appType
  cloud.alarmHistory.page = 1
  await load()
}

/** 按告警类型下钻（点分类标签 / 详情里的「同类型」） */
export async function setAlarmType(alarmType: string): Promise<void> {
  cloud.alarmType = alarmType
  cloud.alarmHistory.page = 1
  await load()
}

export async function resetAlarmFilters(): Promise<void> {
  cloud.alarmLevel = 0
  cloud.alarmScope = ''
  cloud.alarmKeyword = ''
  cloud.alarmAppType = ''
  cloud.alarmType = ''
  cloud.alarmHistory.hours = 24
  cloud.alarmHistory.page = 1
  await load()
}

// ---------------------------------------------------------------- 任务详情与导出

export async function openTask(id: number): Promise<void> {
  cloud.taskDetailLoading = true
  const r = await window.sqlpilot.cloudTaskDetail(cloud.activeId, id).catch(() => null)
  cloud.taskDetailLoading = false
  if (r?.ok && r.data) cloud.taskDetail = r.data
  else cloud.error = r?.error || '获取任务详情失败'
}

export function closeTask(): void {
  cloud.taskDetail = null
  cloud.taskDetailLoading = false
}

/** 导出当前列表（告警事件 / 任务）为 CSV；列与行由调用方给出，主进程负责落盘 */
export async function exportCsv(fileName: string, columns: string[], rows: (string | number)[][]): Promise<{ ok: boolean; error?: string; canceled?: boolean; path?: string }> {
  const r = await window.sqlpilot.cloudExportCsv(fileName, columns, rows)
  return r
}

export async function load(): Promise<void> {
  if (!cloud.activeId) return
  // Oracle 直连平台不走 OCP 接口：它的数据由 OracleConsole 按环境/分区分批查库
  if (cloud.vendor === 'oracle' || activePlatform()?.type === 'oracle') return
  const my = ++seq
  cloud.loading = true
  cloud.error = ''
  try {
    if (cloud.view === 'overview') {
      const r = await window.sqlpilot.cloudOverview(cloud.activeId)
      if (my !== seq) return
      if (!r.ok || !r.data) { cloud.error = r.error || '获取 OCP 概览失败'; return }
      cloud.overview = r.data
    } else if (cloud.view === 'clusters') {
      if (cloud.clusterId !== null) {
        const r = await window.sqlpilot.cloudCluster(cloud.activeId, cloud.clusterId)
        if (my !== seq) return
        if (!r.ok || !r.data) { cloud.error = r.error || '获取集群详情失败'; return }
        cloud.cluster = r.data
      } else {
        const r = await window.sqlpilot.cloudClusters(cloud.activeId)
        if (my !== seq) return
        if (!r.ok || !r.data) { cloud.error = r.error || '获取集群列表失败'; return }
        cloud.clusters = r.data
      }
    } else if (cloud.view === 'hosts') {
      const r = await window.sqlpilot.cloudHosts(cloud.activeId)
      if (my !== seq) return
      if (!r.ok || !r.data) { cloud.error = r.error || '获取主机列表失败'; return }
      cloud.hosts = r.data
    } else if (cloud.view === 'tenants') {
      const r = await window.sqlpilot.cloudTenants(cloud.activeId)
      if (my !== seq) return
      if (!r.ok || !r.data) { cloud.error = r.error || '获取租户列表失败'; return }
      cloud.tenants = r.data
    } else if (cloud.view === 'alarms') {
      await loadAlarms(my)
    } else if (cloud.view === 'monitor') {
      await loadMonitorInner(my)
    } else if (cloud.view === 'sqldiag') {
      await loadSqlDiag()
    } else if (cloud.view === 'tasks') {
      const f = cloud.taskFilter
      // 「执行中 / 暂停中」在 OCP 里是多个状态，服务端不支持多值，交给主进程本地过滤
      const statusKey = cloud.tasks.status
      const statusIn = statusKey === 'RUNNING' ? ['RUNNING', 'PENDING', 'EXECUTING'] : statusKey === 'PAUSED' ? ['PAUSED', 'CANCELED', 'CANCELLED'] : undefined
      const r = await window.sqlpilot.cloudTasks(cloud.activeId, {
        page: cloud.tasks.page,
        size: cloud.tasks.size,
        status: statusIn ? undefined : (statusKey || undefined),
        statusIn,
        name: cloud.tasks.name.trim() || undefined,
        clusterId: f.clusterId || undefined,
        creator: f.creator || undefined,
        objType: f.objType || undefined,
        type: f.type || undefined,
        hours: f.hours || undefined,
        sort: f.sort
      })
      if (my !== seq) return
      if (!r.ok || !r.data) { cloud.error = r.error || '获取任务失败'; return }
      cloud.tasks.items = r.data.items
      cloud.tasks.total = r.data.total
      cloud.taskScanned = r.data.scanned
      cloud.taskTruncated = r.data.truncated
      cloud.taskUpdatedAt = Date.now()
      // 状态计数用作 tab 上的数字，失败不影响主列表
      const [st, cr] = await Promise.all([
        window.sqlpilot.cloudTaskStats(cloud.activeId).catch(() => null),
        cloud.taskCreators.length ? Promise.resolve(null) : window.sqlpilot.cloudTaskCreators(cloud.activeId).catch(() => null)
      ])
      if (st?.ok) cloud.taskStats = st.data || []
      if (cr?.ok) cloud.taskCreators = cr.data || []
    } else if (cloud.view === 'backup') {
      const r = await window.sqlpilot.cloudBackupBundle(cloud.activeId)
      if (my !== seq) return
      if (!r.ok || !r.data) { cloud.error = r.error || '获取备份恢复数据失败'; return }
      cloud.backup.bundle = r.data
      cloud.backup.updatedAt = Date.now()
      cloud.backup.error = ''
    } else if (cloud.view === 'obproxy') {
      const r = await window.sqlpilot.cloudObproxyBundle(cloud.activeId)
      if (my !== seq) return
      if (!r.ok || !r.data) { cloud.error = r.error || '获取 OBProxy 集群失败'; return }
      cloud.obproxy.clusters = r.data.clusters
      cloud.obproxy.updatedAt = Date.now()
      cloud.obproxy.error = ''
      // 抽屉开着就顺带刷新详情，避免切走再回来看到旧数据
      if (cloud.obproxy.drawerId) await loadObproxyDetail(cloud.obproxy.drawerId)
    } else if (cloud.view === 'inspection') {
      const r = await window.sqlpilot.cloudInspectionBundle(cloud.activeId)
      if (my !== seq) return
      if (!r.ok || !r.data) { cloud.error = r.error || '获取巡检数据失败'; return }
      cloud.inspection.bundle = r.data
      cloud.inspection.updatedAt = Date.now()
      cloud.inspection.error = ''
    } else if (cloud.view === 'platform') {
      const r = await window.sqlpilot.cloudPlatformBundle(cloud.activeId)
      if (my !== seq) return
      if (!r.ok || !r.data) { cloud.error = r.error || '获取平台管理数据失败'; return }
      cloud.platform.bundle = r.data
      cloud.platform.updatedAt = Date.now()
      cloud.platform.error = ''
    }
    if (my === seq) {
      cloud.updatedAt = Date.now()
      cloud.status = { ...(cloud.status || { ok: true }), ok: true, error: undefined }
    }
  } finally {
    if (my === seq) cloud.loading = false
  }
}

/** 任务/租户页要用集群下拉，但 cloud.clusters 只在集群页填充，这里按需补一次 */
export async function ensureClusters(): Promise<void> {
  if (cloud.clusters.length || !cloud.activeId) return
  const r = await window.sqlpilot.cloudClusters(cloud.activeId).catch(() => null)
  if (r?.ok && r.data) cloud.clusters = r.data
}

/** 告警详情里的「定位对象」需要集群/租户/主机三个列表，按需补一次（各自只请求一次） */
export async function ensureRefData(): Promise<void> {
  if (!cloud.activeId) return
  const jobs: Promise<unknown>[] = []
  if (!cloud.clusters.length) {
    jobs.push(window.sqlpilot.cloudClusters(cloud.activeId).then((r) => { if (r.ok && r.data) cloud.clusters = r.data }).catch(() => null))
  }
  if (!cloud.hosts.length) {
    jobs.push(window.sqlpilot.cloudHosts(cloud.activeId).then((r) => { if (r.ok && r.data) cloud.hosts = r.data }).catch(() => null))
  }
  if (!cloud.tenants.length) {
    jobs.push(window.sqlpilot.cloudTenants(cloud.activeId).then((r) => { if (r.ok && r.data) cloud.tenants = r.data }).catch(() => null))
  }
  await Promise.all(jobs)
}

export async function openCluster(id: number): Promise<void> {
  cloud.clusterId = id
  cloud.cluster = null
  cloud.error = ''
  await load()
}

export function closeCluster(): void {
  cloud.clusterId = null
  cloud.cluster = null
  cloud.error = ''
  void load()
}

export async function openTenant(clusterId: number, tenantId: number): Promise<void> {
  const r = await window.sqlpilot.cloudTenant(cloud.activeId, clusterId, tenantId)
  if (!r.ok || !r.data) {
    cloud.error = r.error || '获取租户详情失败'
    return
  }
  cloud.tenant = r.data
}

export function closeTenant(): void {
  cloud.tenant = null
}

/** 打开主机抽屉：主机数据已在列表里，直接引用（不额外请求 OCP） */
export function openHost(h: CloudHost): void {
  cloud.host = h
}

export function closeHost(): void {
  cloud.host = null
}

export async function setAlarmLevel(level: number): Promise<void> {
  cloud.alarmLevel = level
  await load()
}

/** 切换活跃 / 历史告警（历史从第 1 页看起） */
export async function setAlarmTab(tab: 'active' | 'history'): Promise<void> {
  if (cloud.alarmTab === tab) return
  cloud.alarmTab = tab
  cloud.alarmHistory.page = 1
  await load()
}

export async function setAlarmScope(scope: string): Promise<void> {
  cloud.alarmScope = scope
  cloud.alarmHistory.page = 1
  await load()
}

/** 关键词搜索（回车触发，避免逐字请求） */
export async function setAlarmKeyword(keyword: string): Promise<void> {
  cloud.alarmKeyword = keyword
  cloud.alarmHistory.page = 1
  await load()
}

export async function setAlarmPage(page: number): Promise<void> {
  cloud.alarmHistory.page = Math.max(1, page)
  await load()
}

/** 历史告警时间窗（小时，0 表示不传时间参数由 OCP 决定） */
export async function setAlarmHours(hours: number): Promise<void> {
  cloud.alarmHistory.hours = hours
  cloud.alarmHistory.page = 1
  await load()
}

export async function setTaskStatus(status: string): Promise<void> {
  cloud.tasks.status = status
  cloud.tasks.page = 1
  await load()
}

export async function setTaskName(name: string): Promise<void> {
  cloud.tasks.name = name
  cloud.tasks.page = 1
  await load()
}

export async function setTaskPage(page: number): Promise<void> {
  cloud.tasks.page = Math.max(1, page)
  await load()
}

/** 任务筛选：集群走服务端，其余由主进程在候选集里过滤 */
export async function setTaskFilter(patch: Partial<{ clusterId: number; creator: string; objType: string; type: '' | 'MANUAL' | 'AUTO'; hours: number; sort: 'start_desc' | 'start_asc' | 'duration_desc' }>): Promise<void> {
  Object.assign(cloud.taskFilter, patch)
  cloud.tasks.page = 1
  await load()
}

export async function resetTaskFilters(): Promise<void> {
  cloud.tasks.status = ''
  cloud.tasks.name = ''
  cloud.tasks.page = 1
  cloud.taskFilter.clusterId = 0
  cloud.taskFilter.creator = ''
  cloud.taskFilter.objType = ''
  cloud.taskFilter.type = ''
  cloud.taskFilter.hours = 0
  cloud.taskFilter.sort = 'start_desc'
  await load()
}

/** 保存/新增平台（密码留空 = 沿用已存密码） */
export async function savePlatform(input: Partial<CloudPlatformView>, password?: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
  const r = await window.sqlpilot.cloudSave(input as any, password)
  if (!r.ok) return { ok: false, error: r.error }
  await loadPlatforms()
  if (r.platform) cloud.activeId = r.platform.id
  await checkStatus()
  if (cloud.status?.ok) await load()
  return { ok: true, warning: r.warning }
}

export async function deletePlatform(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await window.sqlpilot.cloudDelete(id)
  if (!r.ok) return r
  if (cloud.activeId === id) {
    cloud.activeId = ''
    cloud.overview = null
    cloud.cluster = null
    cloud.tenant = null
    cloud.status = null
  }
  await loadPlatforms()
  if (cloud.activeId) {
    await checkStatus()
    if (cloud.status?.ok) await load()
  }
  return { ok: true }
}


// ---------------------------------------------------------------- 资源监控

export interface MonitorEntity {
  key: string
  label: string
  sub: string
  labels: string
  groupBy: string
}

/** 当前维度下的可选实体（集群按名称过滤，租户按租户名，主机按 IP） */
export function monitorEntities(scope: MonitorScope): MonitorEntity[] {
  if (scope === 'CLUSTER') {
    return cloud.clusters.map((c) => ({ key: `c${c.id}`, label: c.name, sub: `v${c.version} · ${c.serverCount} 节点`, labels: `ob_cluster_name:${c.name}`, groupBy: 'ob_cluster_id' }))
  }
  if (scope === 'TENANT') {
    return cloud.tenants.map((t) => ({ key: `t${t.id}`, label: t.name, sub: `${t.clusterName} · ${t.mode}`, labels: `tenant_name:${t.name}`, groupBy: 'tenant_name' }))
  }
  return cloud.hosts.map((h) => ({ key: `h${h.id}`, label: h.alias || h.ip, sub: `${h.ip} · ${h.idc || h.region}`, labels: `svr_ip:${h.ip}`, groupBy: 'svr_ip' }))
}

/** 监控页需要的实体清单：按当前维度按需拉取 */
async function ensureMonitorData(scope: MonitorScope): Promise<void> {
  if (!cloud.activeId) return
  if (scope === 'CLUSTER' && !cloud.clusters.length) {
    const r = await window.sqlpilot.cloudClusters(cloud.activeId)
    if (r.ok && r.data) cloud.clusters = r.data
  } else if (scope === 'TENANT' && !cloud.tenants.length) {
    const r = await window.sqlpilot.cloudTenants(cloud.activeId)
    if (r.ok && r.data) cloud.tenants = r.data
  } else if (scope === 'HOST' && !cloud.hosts.length) {
    const r = await window.sqlpilot.cloudHosts(cloud.activeId)
    if (r.ok && r.data) cloud.hosts = r.data
  }
}

async function loadMonitorInner(my: number): Promise<void> {
  const m = cloud.monitor
  m.error = ''
  if (!cloud.activeId) return
  await ensureMonitorData(m.scope)
  const list = monitorEntities(m.scope)
  if (!list.length) { m.series = []; return }
  const ent = list.find((e) => e.key === m.entityKey) || list[0]
  m.entityKey = ent.key
  const defs = METRIC_SETS[m.scope].filter((d) => m.metrics.includes(d.key))
  if (!defs.length) { m.series = []; return }
  const to = Date.now()
  const from = to - m.rangeSec * 1000
  const r = await window.sqlpilot.cloudMetrics(cloud.activeId, {
    scope: m.scope,
    metrics: defs,
    labels: ent.labels,
    groupBy: ent.groupBy,
    from,
    to,
    maxPoints: 120
  })
  if (my !== seq) return
  if (!r.ok || !r.data) { m.error = r.error || '获取监控数据失败'; return }
  m.series = r.data.series
  m.warnings = r.data.warnings || []
  m.updatedAt = Date.now()
}

export async function reloadMonitor(): Promise<void> {
  mLoading()
  const my = ++seq
  try { await loadMonitorInner(my) } finally { if (my === seq) cloud.monitor.loading = false }
}
function mLoading(): void { cloud.monitor.loading = true }

export async function setMonitorScope(scope: MonitorScope): Promise<void> {
  if (cloud.monitor.scope === scope) return
  cloud.monitor.scope = scope
  cloud.monitor.entityKey = ''
  cloud.monitor.series = []
  cloud.monitor.metrics = METRIC_SETS[scope].slice(0, 4).map((d) => d.key)
  await reloadMonitor()
}

export async function setMonitorEntity(key: string): Promise<void> {
  if (cloud.monitor.entityKey === key) return
  cloud.monitor.entityKey = key
  await reloadMonitor()
}

export async function setMonitorRange(sec: number): Promise<void> {
  cloud.monitor.rangeSec = sec
  await reloadMonitor()
}

export async function toggleMonitorMetric(key: string): Promise<void> {
  const cur = cloud.monitor.metrics
  cloud.monitor.metrics = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
  await reloadMonitor()
}

// ---------------------------------------------------------------- 运维动作

export async function runClusterAction(clusterId: number, action: string): Promise<{ ok: boolean; error?: string; taskId?: number }> {
  const r = await window.sqlpilot.cloudClusterAction(cloud.activeId, clusterId, action)
  if (!r.ok) return { ok: false, error: r.error }
  cloud.cluster = null
  void load()
  return { ok: true, taskId: r.data?.taskId }
}

/** 创建租户：clusterId 不传时用当前打开的集群（集群详情页入口），租户页入口显式传入 */
export async function createTenant(input: CloudCreateTenantInput, clusterId?: number): Promise<{ ok: boolean; error?: string; taskId?: number }> {
  const cid = clusterId ?? cloud.clusterId
  if (cid === null) return { ok: false, error: '未选择集群' }
  const r = await window.sqlpilot.cloudCreateTenant(cloud.activeId, cid, input)
  if (!r.ok) return { ok: false, error: r.error }
  void load()
  // 若正在看该集群的详情，顺带刷新它的租户列表
  if (cloud.clusterId === cid && cloud.cluster) await openCluster(cid)
  return { ok: true, taskId: r.data?.taskId }
}

export async function deleteTenant(clusterId: number, tenantId: number): Promise<{ ok: boolean; error?: string; taskId?: number }> {
  const r = await window.sqlpilot.cloudDeleteTenant(cloud.activeId, clusterId, tenantId)
  if (!r.ok) return { ok: false, error: r.error }
  cloud.tenant = null
  void load()
  return { ok: true, taskId: r.data?.taskId }
}

/** 刷新当前打开的租户抽屉（运维动作后回读最新副本/状态） */
export async function refreshTenant(): Promise<void> {
  const t = cloud.tenant?.tenant
  if (!t) return
  await openTenant(t.clusterId, t.id)
}

export async function tenantChangePassword(clusterId: number, tenantId: number, newPassword: string): Promise<{ ok: boolean; error?: string }> {
  const r = await window.sqlpilot.cloudTenantChangePassword(cloud.activeId, clusterId, tenantId, newPassword)
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

export async function tenantModifyWhitelist(clusterId: number, tenantId: number, whitelist: string): Promise<{ ok: boolean; error?: string }> {
  const r = await window.sqlpilot.cloudTenantModifyWhitelist(cloud.activeId, clusterId, tenantId, whitelist)
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

export type TenantReplica = { zoneName: string; replicaType: string; unitSpecName: string; unitCount: number }

export async function tenantModifyReplica(clusterId: number, tenantId: number, replicas: TenantReplica[]): Promise<{ ok: boolean; error?: string; taskId?: number }> {
  const r = await window.sqlpilot.cloudTenantModifyReplica(cloud.activeId, clusterId, tenantId, replicas)
  if (!r.ok) return { ok: false, error: r.error }
  await refreshTenant()
  return { ok: true, taskId: r.data?.taskId }
}

export async function tenantAddReplica(clusterId: number, tenantId: number, replicas: TenantReplica[]): Promise<{ ok: boolean; error?: string; taskId?: number }> {
  const r = await window.sqlpilot.cloudTenantAddReplica(cloud.activeId, clusterId, tenantId, replicas)
  if (!r.ok) return { ok: false, error: r.error }
  await refreshTenant()
  return { ok: true, taskId: r.data?.taskId }
}

export async function tenantDeleteReplica(clusterId: number, tenantId: number, zones: string[]): Promise<{ ok: boolean; error?: string; taskId?: number }> {
  const r = await window.sqlpilot.cloudTenantDeleteReplica(cloud.activeId, clusterId, tenantId, zones)
  if (!r.ok) return { ok: false, error: r.error }
  await refreshTenant()
  return { ok: true, taskId: r.data?.taskId }
}

export async function tenantSetLocked(clusterId: number, tenantId: number, locked: boolean): Promise<{ ok: boolean; error?: string }> {
  const r = await window.sqlpilot.cloudTenantSetLocked(cloud.activeId, clusterId, tenantId, locked)
  if (!r.ok) return { ok: false, error: r.error }
  await refreshTenant()
  return { ok: true }
}

export async function tenantSessions(clusterId: number, tenantId: number): Promise<{ ok: boolean; data?: { items: CloudTenantSession[]; total: number }; error?: string }> {
  return window.sqlpilot.cloudTenantSessions(cloud.activeId, clusterId, tenantId)
}

export async function tenantCloseSessions(clusterId: number, tenantId: number, sessionIds: number[]): Promise<{ ok: boolean; error?: string }> {
  const r = await window.sqlpilot.cloudTenantCloseSessions(cloud.activeId, clusterId, tenantId, sessionIds)
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

export async function tenantUpdateParams(clusterId: number, tenantId: number, items: { name: string; value: string }[]): Promise<{ ok: boolean; error?: string }> {
  const r = await window.sqlpilot.cloudTenantUpdateParams(cloud.activeId, clusterId, tenantId, items)
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

/** 修改集群参数（按参数名下发给该集群全部 OBServer） */
export async function updateClusterParams(clusterId: number, items: { name: string; value: string }[]): Promise<{ ok: boolean; error?: string }> {
  const r = await window.sqlpilot.cloudClusterUpdateParams(cloud.activeId, clusterId, items)
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

// ---------------------------------------------------------------- SQL 诊断（TopSQL / 慢 SQL）

/** 诊断页需要集群与租户清单，缺则补拉（不污染当前视图的 loading） */
async function ensureSqlCatalogs(): Promise<void> {
  if (!cloud.activeId) return
  if (!cloud.clusters.length) {
    const r = await window.sqlpilot.cloudClusters(cloud.activeId)
    if (r.ok && r.data) cloud.clusters = r.data
  }
  if (!cloud.tenants.length) {
    const r = await window.sqlpilot.cloudTenants(cloud.activeId)
    if (r.ok && r.data) cloud.tenants = r.data
  }
}

/** 诊断页可选集群：排除承载 OCP 元数据的那个集群 */
export function sqlClusters(): CloudCluster[] {
  const biz = cloud.clusters.filter((c) => c.name !== 'metadb_cluster')
  return biz.length ? biz : cloud.clusters
}

/** 当前选中集群下可诊断的租户（sys 不参与业务诊断） */
export function sqlTenants(): CloudTenant[] {
  return cloud.tenants.filter((t) => t.clusterId === cloud.sqldiag.clusterId && t.name !== 'sys')
}

export async function loadSqlDiag(): Promise<void> {
  const s = cloud.sqldiag
  if (!cloud.activeId) return
  s.error = ''
  s.sqlText = {}
  await ensureSqlCatalogs()
  const clusters = sqlClusters()
  if (!clusters.length) {
    s.rows = []; s.slow = []; s.stats = []
    return
  }
  if (!clusters.some((c) => c.id === s.clusterId)) s.clusterId = clusters[0].id
  const tenants = sqlTenants()
  if (s.tenantId !== 0 && !tenants.some((t) => t.id === s.tenantId)) s.tenantId = tenants[0]?.id ?? 0

  const to = Date.now()
  const from = to - s.rangeSec * 1000
  s.loading = true
  try {
    const [top, stats] = await Promise.all([
      window.sqlpilot.cloudTopSql(cloud.activeId, s.clusterId, s.tenantId, {
        from,
        to,
        sqlText: s.search.trim() || undefined,
        limit: 500
      }),
      window.sqlpilot.cloudTenantSqlStats(cloud.activeId, s.clusterId, from, to)
    ])
    if (!top.ok) { s.error = top.error || '读取 TopSQL 失败'; return }
    s.rows = top.data || []
    s.stats = stats.ok ? stats.data || [] : []
    s.slow = []
    s.updatedAt = Date.now()
  } finally {
    s.loading = false
  }
}

export function setSqlCluster(id: number): void {
  if (cloud.sqldiag.clusterId === id) return
  cloud.sqldiag.clusterId = id
  cloud.sqldiag.tenantId = 0
  void loadSqlDiag()
}

export function setSqlTenant(id: number): void {
  if (cloud.sqldiag.tenantId === id) return
  cloud.sqldiag.tenantId = id
  void loadSqlDiag()
}

export function setSqlRange(sec: number): void {
  if (cloud.sqldiag.rangeSec === sec) return
  cloud.sqldiag.rangeSec = sec
  void loadSqlDiag()
}

/** 排序在前端做（OCP 的 topSql 端点不接受排序参数） */
export function setSqlSort(sort: 'cpu' | 'avg' | 'max' | 'exec'): void {
  cloud.sqldiag.sort = sort
}

export function setSqlSearch(text: string): void {
  cloud.sqldiag.search = text
  void loadSqlDiag()
}

/**
 * 展开某行时按需取完整 SQL：OCP 的 topSql 列表只给截断文本（sqlTextShort），
 * 完整语句要单独走 /sqls/{sqlId}/text（必须带时间窗）。结果按 tenantId|sqlId 缓存。
 */
export async function loadSqlText(row: CloudTopSqlRow): Promise<void> {
  const s = cloud.sqldiag
  if (!cloud.activeId) return
  const key = `${row.tenantId}|${row.sqlId}`
  const hit = s.sqlText[key]
  if (hit?.fulltext || hit?.loading) return
  s.sqlText[key] = {
    fulltext: '',
    statement: '',
    sqlId: row.sqlId,
    sqlType: row.sqlType,
    dbName: row.dbName,
    userName: row.userName,
    tables: [],
    supportOutline: false,
    loading: true
  }
  const to = Date.now()
  const from = to - s.rangeSec * 1000
  const r = await window.sqlpilot.cloudSqlText(cloud.activeId, s.clusterId, row.tenantId, row.sqlId, { from, to })
  if (!r.ok || !r.data) {
    s.sqlText[key] = { ...s.sqlText[key], loading: false, error: r.error || '读取完整 SQL 失败' }
    return
  }
  s.sqlText[key] = { ...r.data, loading: false }
}

/** 当前租户的 SQL 概况（KPI 磁贴用）；全部租户时汇总各租户 */export function sqlStatSummary(): CloudTenantSqlStat {
  const s = cloud.sqldiag
  const list = s.tenantId > 0 ? s.stats.filter((x) => x.tenantId === s.tenantId) : s.stats.filter((x) => x.tenantName !== 'sys')
  return list.reduce(
    (acc, x) => ({
      tenantId: 0,
      tenantName: '',
      newSqlCount: acc.newSqlCount + x.newSqlCount,
      slowSqlCount: acc.slowSqlCount + x.slowSqlCount,
      anomalySqlCount: acc.anomalySqlCount + x.anomalySqlCount,
      highRiskSqlCount: acc.highRiskSqlCount + x.highRiskSqlCount
    }),
    { tenantId: 0, tenantName: '', newSqlCount: 0, slowSqlCount: 0, anomalySqlCount: 0, highRiskSqlCount: 0 }
  )
}

// ---------------------------------------------------------------- 备份恢复

/** 备份对象按状态过滤（对齐 OCP「已备份集群(n) / 未备份集群(n)」两个入口） */
export function backupObjects(): CloudBackupObjRow[] {
  const all = cloud.backup.bundle?.objects || []
  const f = cloud.backup.objFilter
  if (f === 'has') return all.filter((o) => o.backupStatus === 'HAS_BACKUP_STRATEGY')
  if (f === 'none') return all.filter((o) => o.backupStatus !== 'HAS_BACKUP_STRATEGY')
  return all
}

export function setBackupObjFilter(f: 'all' | 'has' | 'none'): void {
  cloud.backup.objFilter = f
}

export function setBackupTaskKind(k: CloudBackupTaskKind): void {
  cloud.backup.taskKind = k
}

/** 备份任务：切换页签时按需补拉（首屏只带了四类里各 50 条） */
export async function reloadBackupTasks(kind: CloudBackupTaskKind = cloud.backup.taskKind): Promise<void> {
  const b = cloud.backup
  if (!b.bundle || !cloud.activeId) return
  const r = await window.sqlpilot.cloudBackupTasks(cloud.activeId, kind, 100)
  if (!r.ok || !r.data) {
    b.error = r.error || '获取备份任务失败'
    return
  }
  b.error = ''
  b.bundle.tasks[kind] = r.data
}

// ---------------------------------------------------------------- OBProxy

export async function loadObproxyDetail(id: number): Promise<void> {
  const o = cloud.obproxy
  o.detailLoading = true
  const [d, p] = await Promise.all([
    window.sqlpilot.cloudObproxyDetail(cloud.activeId, id).catch(() => null),
    window.sqlpilot.cloudObproxyParams(cloud.activeId, id).catch(() => null)
  ])
  o.detailLoading = false
  if (d?.ok && d.data) o.detail = d.data
  o.params = p?.ok ? (p.data || []) : []
}

export async function openObproxy(id: number): Promise<void> {
  cloud.obproxy.drawerId = id
  cloud.obproxy.detail = null
  cloud.obproxy.params = []
  cloud.obproxy.error = ''
  await loadObproxyDetail(id)
}

export function closeObproxy(): void {
  cloud.obproxy.drawerId = 0
  cloud.obproxy.detail = null
  cloud.obproxy.params = []
  cloud.obproxy.paramKeyword = ''
}

// ---------------------------------------------------------------- 巡检

export function setInspectionType(t: CloudInspectionObjectType): void {
  cloud.inspection.type = t
}

export function inspectionRows(): CloudInspectionOverviewRow[] {
  return cloud.inspection.bundle?.overviews[cloud.inspection.type] || []
}

export async function openInspectionReport(reportId: number): Promise<void> {
  const s = cloud.inspection
  s.reportOpen = true
  s.reportLoading = true
  s.report = null
  s.riskFilter = ''
  s.error = ''
  const r = await window.sqlpilot.cloudInspectionReport(cloud.activeId, reportId)
  s.reportLoading = false
  if (!r.ok || !r.data) {
    s.error = r.error || '读取巡检报告失败'
    return
  }
  s.report = r.data
}

export function closeInspectionReport(): void {
  cloud.inspection.reportOpen = false
  cloud.inspection.report = null
  cloud.inspection.riskFilter = ''
}

export function setInspectionRiskFilter(f: '' | 'abnormal'): void {
  cloud.inspection.riskFilter = f
}

/** 报告明细：可按「只看异常结果」过滤 */
export function inspectionItems(): CloudInspectionItemResult[] {
  const items = cloud.inspection.report?.items || []
  return cloud.inspection.riskFilter === 'abnormal' ? items.filter((x) => x.abnormal) : items
}

// ---------------------------------------------------------------- 平台管理

export function setPlatformTab(t: 'users' | 'roles' | 'properties' | 'logins' | 'system'): void {
  cloud.platform.tab = t
}

export async function loadPlatformProperties(page = cloud.platform.propPage, size = cloud.platform.propSize): Promise<void> {
  const p = cloud.platform
  p.propPage = page
  p.propSize = size
  const r = await window.sqlpilot.cloudPlatformProperties(cloud.activeId, page, size)
  if (!r.ok || !r.data) {
    p.error = r.error || '获取平台参数失败'
    return
  }
  p.error = ''
  if (p.bundle) {
    p.bundle.properties = r.data.items
    p.bundle.propertyTotal = r.data.total
  }
}

/** 平台参数搜索：OCP 的 keyword 参数不生效（实测返回同样结果），在前端过滤 */
export function platformProperties(): CloudPlatformProperty[] {
  const list = cloud.platform.bundle?.properties || []
  const k = cloud.platform.propKeyword.trim().toLowerCase()
  if (!k) return list
  return list.filter((x) => `${x.key} ${x.description} ${x.label}`.toLowerCase().includes(k))
}
