/**
 * 云管 AI 助手的「模块 → 子模块」目录（界面文案）。
 *
 * key 必须与主进程 `src/main/cloud/ai.ts` 的 `CLOUD_AI_SECTIONS` 完全一致
 * （类型受 `CloudAiSectionKey` 约束，写错会直接 tsc 报错）；主进程拿同一批 key 取数。
 */

export interface AiSectionDef {
  key: CloudAiSectionKey
  label: string
  desc: string
}

export const MODULE_LABEL: Record<CloudAiModuleKey, string> = {
  overview: '总览',
  clusters: '集群',
  tenants: '租户',
  obproxy: 'OBProxy',
  hosts: '主机',
  backup: '备份恢复',
  inspection: '巡检',
  monitor: '资源监控',
  sqldiag: 'SQL 诊断',
  alarms: '告警',
  tasks: '任务',
  platform: '平台管理'
}

/** 每个模块下可单独勾选的子模块（顺序即界面顺序） */
export const AI_SECTIONS: Record<CloudAiModuleKey, AiSectionDef[]> = {
  overview: [
    { key: 'overview.kpi', label: '核心指标', desc: '集群/租户/主机/告警数量、CPU 分配' },
    { key: 'overview.clusters', label: '集群容量', desc: '各集群 CPU / 内存 / 数据盘水位' },
    { key: 'overview.alarms', label: '活跃告警', desc: '最近 12 条活跃告警' },
    { key: 'overview.tasks', label: '最近任务', desc: '最近 10 条运维任务' }
  ],
  clusters: [
    { key: 'clusters.list', label: '集群清单', desc: '状态/模式/版本/节点/租户' },
    { key: 'clusters.capacity', label: '容量水位', desc: 'CPU、内存、数据盘已用与占比' },
    { key: 'clusters.alarms', label: '告警分布', desc: '各集群告警条数与级别分布' },
    { key: 'clusters.topology', label: '拓扑与 OBServer', desc: '前 3 个集群的 Zone / OBServer / 租户' },
    { key: 'clusters.params', label: '启动参数', desc: '前 3 个集群的启动参数' }
  ],
  tenants: [
    { key: 'tenants.list', label: '租户清单', desc: '模式/状态/Locality/主 Zone' },
    { key: 'tenants.distribution', label: '分布统计', desc: '按集群、模式、主/备统计' },
    { key: 'tenants.unitSpecs', label: 'Unit 规格', desc: 'CPU/内存区间、类型' }
  ],
  obproxy: [
    { key: 'obproxy.clusters', label: 'OBProxy 集群', desc: '状态/访问地址/版本/实例与 IDC 分布' },
    { key: 'obproxy.links', label: '连接关系', desc: '反代了哪些 OB 集群、连接数、代理用户' }
  ],
  hosts: [
    { key: 'hosts.list', label: '主机清单', desc: 'IP/别名/状态/机型/区域' },
    { key: 'hosts.agent', label: 'Agent 状态', desc: '可用性汇总与异常主机' },
    { key: 'hosts.services', label: '承载服务', desc: 'OB 集群 / OBProxy 与版本' }
  ],
  backup: [
    { key: 'backup.overview', label: '核心指标', desc: '策略覆盖、本周成功率、日志延时、抽检' },
    { key: 'backup.objects', label: '备份对象', desc: '集群备份策略状态与租户明细' },
    { key: 'backup.tasks', label: '备份/恢复任务', desc: '数据/日志/恢复/清理任务近况' }
  ],
  inspection: [
    { key: 'inspection.overview', label: '巡检对象', desc: '集群/租户/OBProxy 最近风险与调度' },
    { key: 'inspection.reports', label: '巡检报告', desc: '最近 20 份报告的风险统计' }
  ],
  monitor: [
    { key: 'monitor.cluster', label: '集群指标', desc: 'CPU/内存/MemStore/QPS' },
    { key: 'monitor.tenant', label: '租户指标', desc: 'QPS/活跃会话/MemStore' },
    { key: 'monitor.host', label: '主机指标', desc: 'CPU/内存/load1' }
  ],
  sqldiag: [
    { key: 'sqldiag.top', label: 'TopSQL', desc: '按 CPU 排序的 Top 20 语句' },
    { key: 'sqldiag.stats', label: '租户 SQL 概况', desc: '新/慢/异常/高风险计数' }
  ],
  alarms: [
    { key: 'alarms.active', label: '活跃告警', desc: '当前活跃告警明细（最多 30 条）' },
    { key: 'alarms.levels', label: '级别分布', desc: '严重 / 警告 / 注意 条数' },
    { key: 'alarms.trend', label: '24 小时趋势', desc: '按小时分布、Top 类型' },
    { key: 'alarms.rules', label: '告警规则', desc: '规则清单与启用状态' }
  ],
  tasks: [
    { key: 'tasks.list', label: '任务列表', desc: '最近 30 条任务的明细' },
    { key: 'tasks.stats', label: '状态统计', desc: '各状态任务数量' }
  ],
  platform: [
    { key: 'platform.users', label: '用户与角色', desc: '用户状态、角色定义与权限数' },
    { key: 'platform.params', label: '平台参数', desc: '前 60 项参数与运行值' },
    { key: 'platform.logins', label: '登录审计', desc: '最近 20 条登录记录' }
  ]
}

/** 细分参数（`base:arg` 里的 arg）的中文名；集群名/主机 IP 这类动态参数原样显示 */
const ARG_LABEL: Record<string, string> = {
  'overview.kpi:ocp': 'OCP 版本',
  'overview.kpi:clusters': '集群数',
  'overview.kpi:tenants': '租户数',
  'overview.kpi:hosts': '主机数',
  'overview.kpi:alarms': '活跃告警数',
  'overview.kpi:cpu': 'CPU 分配',
  'backup.overview:strategy': '备份策略覆盖',
  'backup.overview:success': '本周备份成功率',
  'backup.overview:logDelay': '日志备份延时',
  'backup.overview:rehearsal': '恢复抽检',
  'sqldiag.stats:slow': '慢 SQL',
  'sqldiag.stats:new': '新 SQL',
  'sqldiag.stats:anomaly': '异常 SQL',
  'sqldiag.stats:risky': '高风险 SQL',
  'alarms.levels:1': '严重告警',
  'alarms.levels:2': '警告告警',
  'alarms.levels:3': '注意告警',
  'alarms.levels:0': '活跃合计'
}

/** 拆出整块 key 与细分参数（`overview.kpi:hosts` → base=overview.kpi, arg=hosts） */
export function splitKey(key: CloudAiSectionKey): { base: CloudAiSectionKey; arg: string } {
  const i = String(key).indexOf(':')
  return i < 0 ? { base: key, arg: '' } : { base: String(key).slice(0, i) as CloudAiSectionKey, arg: String(key).slice(i + 1) }
}

/** 整块 key（用于按模块统计覆盖、找目录项） */
export const baseKey = (key: CloudAiSectionKey): CloudAiSectionKey => splitKey(key).base

/** 一组选择里实际覆盖了哪些整块（细分 key 只算它所属的那一块） */
export function coveredSections(sections: CloudAiSectionKey[]): CloudAiSectionKey[] {
  return [...new Set(sections.map(baseKey))]
}

export const SECTION_MODULE = (key: CloudAiSectionKey): CloudAiModuleKey => (key.split('.')[0] as CloudAiModuleKey)

/** 所有子模块 key（按模块顺序摊平） */
export const ALL_SECTIONS: CloudAiSectionKey[] = (Object.keys(AI_SECTIONS) as CloudAiModuleKey[]).flatMap((m) =>
  AI_SECTIONS[m].map((s) => s.key)
)

export function sectionsOfModule(m: CloudAiModuleKey): CloudAiSectionKey[] {
  return AI_SECTIONS[m].map((s) => s.key)
}

export function sectionLabel(key: CloudAiSectionKey): string {
  const { base, arg } = splitKey(key)
  const m = SECTION_MODULE(base)
  const label = AI_SECTIONS[m]?.find((s) => s.key === base)?.label || String(base)
  if (!arg) return label
  return `${label} · ${ARG_LABEL[`${base}:${arg}`] || arg}`
}

/** 子模块说明（勾选框胶囊的悬停提示，说明这块数据具体是什么） */
export function sectionDesc(key: CloudAiSectionKey): string {
  const { base } = splitKey(key)
  const m = SECTION_MODULE(base)
  return AI_SECTIONS[m]?.find((s) => s.key === base)?.desc || ''
}

/**
 * 默认读取范围：**空**。
 * 进勾选态时一个都不预勾——由用户自己挑要读哪些子模块/指标，
 * 避免「没注意就带了一批数据去提问」。勾选为空时「开始对话」不可点。
 */
export const SCOPE_DEFAULT: CloudAiSectionKey[] = []

/** 「总览 3/4 · 告警 1/4」这种紧凑范围描述（历史列表、顶栏副标题用） */
export function scopeSummary(sections: CloudAiSectionKey[]): string {
  const groups: string[] = []
  const covered = new Set(coveredSections(sections))
  for (const m of Object.keys(AI_SECTIONS) as CloudAiModuleKey[]) {
    const total = AI_SECTIONS[m].length
    const hit = AI_SECTIONS[m].filter((s) => covered.has(s.key)).length
    if (!hit) continue
    groups.push(hit === total ? MODULE_LABEL[m] : `${MODULE_LABEL[m]} ${hit}/${total}`)
  }
  return groups.join(' · ') || '未选择'
}
