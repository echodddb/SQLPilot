/**
 * 直连告警的「规则定义 + 阈值」（纯函数，无 IO）。
 *
 * 为什么单独成文件：alarm.ts 依赖 conn.ts（mysql2）才能评估规则，
 * 而规则清单与阈值合并是纯计算——放这里既能被界面复用（经 service 透出），
 * 也能被单测直接 import（Node 解析不了无扩展名的相对导入）。
 */

/** 阈值默认值与可调范围集中在这里，界面「告警规则」页按 ALARM_RULE_DEFS 渲染 */
export const ALARM_THRESHOLDS = {
  /** 数据盘使用率：≥ warn 警告，≥ crit 严重（百分比） */
  dataDiskWarn: 85,
  dataDiskCrit: 90,
  logDiskWarn: 85,
  logDiskCrit: 90,
  /** 租户内存使用率（占其 Unit 规格） */
  tenantMemWarn: 90,
  /** 长事务：事务状态非空且持续超过该秒数 */
  longTxnSec: 300,
  /** 合并卡住：START_TIME 距今超过该小时且状态仍是 MERGING */
  compactionStalledHours: 6,
  /** 主机 CPU 分配率（CPU_ASSIGNED / CPU_CAPACITY），主机维度 */
  cpuAllocWarn: 85,
  /** 主机内存分配率（MEM_ASSIGNED / MEM_CAPACITY），主机维度 */
  memAllocWarn: 85
}

export type AlarmThresholds = typeof ALARM_THRESHOLDS
export type AlarmThresholdKey = keyof AlarmThresholds

/** 每个阈值键的合法区间：界面输入与后端落盘都按它夹取 */
export const ALARM_THRESHOLD_BOUNDS: Record<AlarmThresholdKey, [number, number]> = {
  dataDiskWarn: [50, 99],
  dataDiskCrit: [51, 100],
  logDiskWarn: [50, 99],
  logDiskCrit: [51, 100],
  tenantMemWarn: [50, 99],
  longTxnSec: [30, 86400],
  compactionStalledHours: [1, 168],
  cpuAllocWarn: [50, 99],
  memAllocWarn: [50, 99]
}

/**
 * 单条规则的界面元数据。
 * 阈值项（thresholds）按 key 指向 ALARM_THRESHOLDS，界面只允许改这里列出的键。
 */
export interface AlarmRuleDef {
  /** 规则标识（与告警对象的 alarmType 一致） */
  key: string
  name: string
  /** 默认等级：1 严重 / 2 警告 / 3 注意 */
  level: number
  scope: string
  /** 判定口径（一句话） */
  detect: string
  /** 数据来源视图 */
  source: string
  /** 一句话说明这条告警在什么场景下要看 */
  desc: string
  thresholds: {
    key: AlarmThresholdKey
    label: string
    unit: string
    min: number
    max: number
  }[]
}

export const ALARM_RULE_DEFS: AlarmRuleDef[] = [
  {
    key: 'OB_DATA_DISK_HIGH',
    name: '数据盘使用率偏高',
    level: 2,
    scope: 'Host',
    detect: 'DATA_DISK_IN_USE / DATA_DISK_CAPACITY ≥ 阈值',
    source: 'GV$OB_SERVERS',
    desc: '数据盘写满会直接导致该 OBServer 上的写入失败，扩容前先看这条。',
    thresholds: [
      { key: 'dataDiskWarn', label: '警告阈值', unit: '%', min: 50, max: 99 },
      { key: 'dataDiskCrit', label: '严重阈值', unit: '%', min: 51, max: 100 }
    ]
  },
  {
    key: 'OB_LOG_DISK_HIGH',
    name: '日志盘使用率偏高',
    level: 2,
    scope: 'Host',
    detect: 'LOG_DISK_IN_USE / LOG_DISK_CAPACITY ≥ 阈值',
    source: 'GV$OB_SERVERS',
    desc: '日志盘（clog）打满会让副本同步停滞，通常比数据盘更早出问题。',
    thresholds: [
      { key: 'logDiskWarn', label: '警告阈值', unit: '%', min: 50, max: 99 },
      { key: 'logDiskCrit', label: '严重阈值', unit: '%', min: 51, max: 100 }
    ]
  },
  {
    key: 'OB_TENANT_MEM_HIGH',
    name: '租户内存接近上限',
    level: 2,
    scope: 'Tenant',
    detect: 'V$OB_TENANT_MEMORY.HOLD 合计 / Unit 规格 MEMORY_SIZE ≥ 阈值',
    source: 'V$OB_TENANT_MEMORY + DBA_OB_UNITS',
    desc: '租户内存吃满会触发写入限流（memory limit exceeded），先看是哪条租户。',
    thresholds: [{ key: 'tenantMemWarn', label: '警告阈值', unit: '%', min: 50, max: 99 }]
  },
  {
    key: 'OB_LONG_TRANSACTION',
    name: '长事务',
    level: 2,
    scope: 'Tenant',
    detect: 'TRANS_STATE 非空且 TIME ≥ 阈值',
    source: 'GV$OB_PROCESSLIST',
    desc: '长事务持有快照会拖慢合并、膨胀多版本数据，超过 4 倍阈值自动升为严重。',
    thresholds: [{ key: 'longTxnSec', label: '持续时间', unit: '秒', min: 30, max: 86400 }]
  },
  {
    key: 'OB_COMPACTION_ABNORMAL',
    name: '合并异常',
    level: 3,
    scope: 'Cluster',
    detect: 'IS_ERROR=YES / IS_SUSPENDED=YES / MERGING 超过阈值小时',
    source: 'DBA_OB_MAJOR_COMPACTION',
    desc: '合并卡住会让转储无法回收，磁盘使用率会持续上涨。',
    thresholds: [{ key: 'compactionStalledHours', label: '卡住判定', unit: '小时', min: 1, max: 168 }]
  },
  {
    key: 'OB_CPU_ALLOC_HIGH',
    name: '主机 CPU 分配率偏高',
    level: 2,
    scope: 'Host',
    detect: 'CPU_ASSIGNED / CPU_CAPACITY ≥ 阈值',
    source: 'GV$OB_SERVERS',
    desc: '分配率接近 100% 时新租户/新 Unit 无法再扩容，需要先清理或加机器。',
    thresholds: [{ key: 'cpuAllocWarn', label: '警告阈值', unit: '%', min: 50, max: 99 }]
  },
  {
    key: 'OB_MEM_ALLOC_HIGH',
    name: '主机内存分配率偏高',
    level: 2,
    scope: 'Host',
    detect: 'MEM_ASSIGNED / MEM_CAPACITY ≥ 阈值',
    source: 'GV$OB_SERVERS',
    desc: '内存先行分配、难以回收，分配率过高时后续扩租户会直接失败。',
    thresholds: [{ key: 'memAllocWarn', label: '警告阈值', unit: '%', min: 50, max: 99 }]
  },
  {
    key: 'OB_DISK_HEALTH_BAD',
    name: '主机磁盘健康状态异常',
    level: 1,
    scope: 'Host',
    detect: 'DATA_DISK_HEALTH_STATUS ≠ NORMAL',
    source: 'GV$OB_SERVERS',
    desc: '磁盘报错会引发副本降级甚至不可写，属于最高优先级，先换盘再谈其它。',
    thresholds: []
  },
  {
    key: 'OB_SERVER_NOT_ACTIVE',
    name: 'OBServer 状态异常',
    level: 3,
    scope: 'Host',
    detect: 'DBA_OB_SERVERS.STATUS ≠ ACTIVE',
    source: 'DBA_OB_SERVERS',
    desc: '节点掉线或正在重启；多副本集群下先确认副本是否仍在多数派。',
    thresholds: []
  },
  {
    key: 'OB_LS_NOT_NORMAL',
    name: '日志流状态异常',
    level: 3,
    scope: 'Tenant',
    detect: 'DBA_OB_LS.STATUS 不在正常状态集合内',
    source: 'DBA_OB_LS',
    desc: '日志流异常通常伴随副本不可用，需结合 Zone 状态一起看。',
    thresholds: []
  }
]

/** 合并用户配置：只认白名单键，并按 [min,max] 夹取，脏值回落默认 */
export function mergeThresholds(raw: Partial<AlarmThresholds> | undefined): AlarmThresholds {
  const out: AlarmThresholds = { ...ALARM_THRESHOLDS }
  if (!raw) return out
  for (const k of Object.keys(out) as AlarmThresholdKey[]) {
    const v = Number(raw[k])
    if (!Number.isFinite(v)) continue
    const [min, max] = ALARM_THRESHOLD_BOUNDS[k]
    out[k] = Math.min(Math.max(v, min), max)
  }
  return out
}

/**
 * 阈值来源注入点：obdirect 模块刻意不依赖 electron/config（单测要能直接 import），
 * 由 service 在启动时注入「按平台读配置」的实现；未注入时用默认值。
 */
let thresholdResolver: (platformId: string) => Partial<AlarmThresholds> = () => ({})
export function setAlarmThresholdResolver(fn: (platformId: string) => Partial<AlarmThresholds>): void {
  thresholdResolver = fn
}
export function thresholdOverridesOf(platformId: string): Partial<AlarmThresholds> {
  try {
    return thresholdResolver(platformId) || {}
  } catch {
    return {}
  }
}
