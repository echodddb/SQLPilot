/**
 * 直连模式的告警规则引擎。
 *
 * OCP 有独立的告警中心（阈值可配、可推送、可抑制）；直连模式没有这层，
 * 只能把系统视图里的现状按规则算成告警。因此这里的规则是**内置**的，
 * 每条规则都标注数据来源，阈值取运维常规值，后续可在设置里开放。
 *
 * 与 OCP 的差异必须在界面上说清楚：这些是"当前状态判定"，不是历史事件流，
 * 同一问题在未恢复前会一直存在，恢复后自然消失（不保留历史）。
 */

import { q, type ObDirectPlatform } from './conn'
import { capabilityOf, has } from './capability'
import { hashId, type ObSnapshot } from './collect'
import type { AlarmLevelCount, CloudAlarm } from '../ocp'

// 规则定义与阈值计算是纯函数，放在 ./alarmRules（可脱离数据库单测）；
// 本文件只负责「按快照查视图 -> 判定 -> 产出告警对象」。
import { mergeThresholds, thresholdOverridesOf } from './alarmRules'
export {
  ALARM_RULE_DEFS,
  ALARM_THRESHOLDS,
  ALARM_THRESHOLD_BOUNDS,
  mergeThresholds,
  setAlarmThresholdResolver
} from './alarmRules'
export type { AlarmRuleDef, AlarmThresholds, AlarmThresholdKey } from './alarmRules'

const str = (v: any): string => (v === undefined || v === null ? '' : String(v))
const num = (v: any): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 组装一条告警：CloudAlarm 字段多，这里统一补默认值，避免调用处重复 */
function alarmOf(input: {
  rule: string
  level: number
  name: string
  summary: string
  target: string
  scope: string
  clusterName: string
  labels: Record<string, string>
  tenantName?: string
}): CloudAlarm {
  const now = new Date().toISOString()
  const key = `${input.rule}|${input.target}|${input.tenantName ?? ''}`
  return {
    id: hashId(key),
    level: input.level,
    name: input.name,
    description: input.summary,
    // 直连模式没有告警状态机：算出来就是 ACTIVE，条件不再满足即消失
    status: 'ACTIVE',
    appType: 'OceanBase',
    scope: input.scope,
    target: input.target,
    alarmType: input.rule,
    summary: input.summary,
    labels: { ...input.labels, 数据来源: '直连系统视图' },
    groups: ['OceanBase'],
    autoResolved: true,
    activeAt: now,
    updatedAt: now,
    templateId: 0,
    push: { configured: false, successCount: 0, noSuccessCount: 0 },
    resolvedAt: '',
    targetInfo: {
      scope: input.scope,
      names: [input.target],
      clusterName: input.clusterName,
      obClusterId: null,
      tenantName: input.tenantName ?? ''
    },
    metricGroup: null,
    obCluster: input.clusterName,
    targetLabels: input.labels
  }
}

const countLevels = (alarms: CloudAlarm[]): AlarmLevelCount[] => {
  const m = new Map<number, number>()
  for (const a of alarms) m.set(a.level, (m.get(a.level) ?? 0) + 1)
  return [...m.entries()].map(([level, count]) => ({ level, count })).sort((a, b) => a.level - b.level)
}

export interface AlarmResult {
  alarms: CloudAlarm[]
  total: number
  critical: number
  levels: AlarmLevelCount[]
  /** 因视图缺失而跳过的规则，界面上要提示"未覆盖" */
  skipped: string[]
}

/**
 * 评估全部规则。
 * 拓扑类（服务器状态、容量）直接用快照；租户内存 / 长事务 / 合并状态另查三张表，
 * 任一张查不到只跳过对应规则，不影响其它规则。
 */
export async function evaluateAlarms(
  p: ObDirectPlatform,
  password: string,
  s: ObSnapshot
): Promise<AlarmResult> {
  const alarms: CloudAlarm[] = []
  const skipped: string[] = []
  const clusterName = s.cap.clusterName
  // 阈值优先取用户在「告警规则」里保存的值，未配置时用默认值
  const T = mergeThresholds(thresholdOverridesOf(p.id))

  // --- 1. OBServer 非 ACTIVE
  for (const r of s.servers) {
    const status = str(r.STATUS)
    if (status && status !== 'ACTIVE') {
      alarms.push(alarmOf({
        rule: 'OB_SERVER_NOT_ACTIVE',
        level: 3,
        name: 'OBServer 状态异常',
        summary: `OBServer ${str(r.SVR_IP)}:${num(r.SVR_PORT)} 当前状态为 ${status}，非 ACTIVE`,
        target: str(r.SVR_IP),
        scope: 'Host',
        clusterName,
        labels: { 状态: status, Zone: str(r.ZONE) }
      }))
    }
  }

  // --- 2/3. 数据盘 / 日志盘使用率 + 主机 CPU / 内存分配率 + 磁盘健康
  for (const g of s.gvServers) {
    const ip = str(g.SVR_IP)
    const checks: { label: string; used: number; total: number; warn: number; crit: number; rule: string; name: string }[] = [
      {
        label: '数据盘', used: num(g.DATA_DISK_IN_USE), total: num(g.DATA_DISK_CAPACITY),
        warn: T.dataDiskWarn, crit: T.dataDiskCrit, rule: 'OB_DATA_DISK_HIGH', name: '数据盘使用率偏高'
      },
      {
        label: '日志盘', used: num(g.LOG_DISK_IN_USE), total: num(g.LOG_DISK_CAPACITY),
        warn: T.logDiskWarn, crit: T.logDiskCrit, rule: 'OB_LOG_DISK_HIGH', name: '日志盘使用率偏高'
      }
    ]
    for (const c of checks) {
      if (c.total <= 0) continue
      const pct = Math.round((c.used / c.total) * 1000) / 10
      if (pct < c.warn) continue
      alarms.push(alarmOf({
        rule: c.rule,
        level: pct >= c.crit ? 3 : 2,
        name: c.name,
        summary: `${ip} ${c.label}使用率 ${pct}%（阈值 ${pct >= c.crit ? c.crit : c.warn}%），已用 ${(c.used / 1024 ** 3).toFixed(2)} GB / ${(c.total / 1024 ** 3).toFixed(2)} GB`,
        target: ip,
        scope: 'Host',
        clusterName,
        labels: { 使用率: `${pct}%`, 已用GB: (c.used / 1024 ** 3).toFixed(2), 总量GB: (c.total / 1024 ** 3).toFixed(2) }
      }))
    }

    // 主机维度：CPU / 内存分配率（分配出去就收不回，比"使用率"更值得盯）
    const alloc: { label: string; used: number; total: number; warn: number; rule: string; name: string }[] = [
      {
        label: 'CPU', used: num(g.CPU_ASSIGNED), total: num(g.CPU_CAPACITY),
        warn: T.cpuAllocWarn, rule: 'OB_CPU_ALLOC_HIGH', name: '主机 CPU 分配率偏高'
      },
      {
        label: '内存', used: num(g.MEM_ASSIGNED), total: num(g.MEM_CAPACITY),
        warn: T.memAllocWarn, rule: 'OB_MEM_ALLOC_HIGH', name: '主机内存分配率偏高'
      }
    ]
    for (const a of alloc) {
      if (a.total <= 0) continue
      const pct = Math.round((a.used / a.total) * 1000) / 10
      if (pct < a.warn) continue
      alarms.push(alarmOf({
        rule: a.rule,
        level: pct >= 95 ? 3 : 2,
        name: a.name,
        summary: `${ip} ${a.label}已分配 ${a.used} / ${a.total}（${pct}%，阈值 ${a.warn}%）`,
        target: ip,
        scope: 'Host',
        clusterName,
        labels: { 分配率: `${pct}%`, 已分配: String(a.used), 总量: String(a.total) }
      }))
    }

    // 主机维度：磁盘健康状态（非 NORMAL 一律按严重处理）
    const health = str(g.DATA_DISK_HEALTH_STATUS).toUpperCase()
    if (health && health !== 'NORMAL') {
      alarms.push(alarmOf({
        rule: 'OB_DISK_HEALTH_BAD',
        level: 1,
        name: '主机磁盘健康状态异常',
        summary: `${ip} 数据盘健康状态为 ${health}，存在坏盘风险，请尽快检查并更换`,
        target: ip,
        scope: 'Host',
        clusterName,
        labels: { 健康状态: health }
      }))
    }
  }

  // --- 4. 租户内存接近 Unit 规格上限
  try {
    const memRows = await q<any>(
      p, password,
      'SELECT TENANT_ID, SUM(HOLD) AS HOLD_SUM FROM oceanbase.V$OB_TENANT_MEMORY GROUP BY TENANT_ID'
    )
    const limitByTenant = new Map<number, number>()
    for (const u of s.units) {
      const id = num(u.TENANT_ID)
      limitByTenant.set(id, (limitByTenant.get(id) ?? 0) + num(u.MEMORY_SIZE))
    }
    const nameByTenant = new Map<number, string>()
    for (const t of s.tenants) nameByTenant.set(num(t.TENANT_ID), str(t.TENANT_NAME))

    for (const r of memRows) {
      const id = num(r.TENANT_ID)
      const hold = num(r.HOLD_SUM)
      const limit = limitByTenant.get(id) ?? 0
      if (limit <= 0) continue
      const pct = Math.round((hold / limit) * 1000) / 10
      if (pct < T.tenantMemWarn) continue
      const tname = nameByTenant.get(id) ?? `tenant_${id}`
      alarms.push(alarmOf({
        rule: 'OB_TENANT_MEM_HIGH',
        level: pct >= 95 ? 3 : 2,
        name: '租户内存接近上限',
        summary: `租户 ${tname} 已用内存 ${(hold / 1024 ** 3).toFixed(2)} GB / 规格 ${(limit / 1024 ** 3).toFixed(2)} GB（${pct}%）`,
        target: tname,
        scope: 'Tenant',
        clusterName,
        tenantName: tname,
        labels: { 使用率: `${pct}%`, 已用GB: (hold / 1024 ** 3).toFixed(2), 规格GB: (limit / 1024 ** 3).toFixed(2) }
      }))
    }
  } catch {
    skipped.push('租户内存（V$OB_TENANT_MEMORY 不可用）')
  }

  // --- 5. 长事务：进程列表里处于事务中且持续超阈值
  try {
    const capa = await capabilityOf(p, password)
    const view = has(capa, 'GV$OB_PROCESSLIST') ? 'GV$OB_PROCESSLIST' : null
    if (view) {
      const rows = await q<any>(
        p, password,
        `SELECT ID, TENANT, USER, HOST, TIME, TRANS_STATE, SQL_ID
           FROM oceanbase.${view}
          WHERE TRANS_STATE IS NOT NULL AND TRANS_STATE <> '' AND TIME >= ?`,
        [T.longTxnSec]
      )
      for (const r of rows) {
        const sec = Math.round(num(r.TIME))
        alarms.push(alarmOf({
          rule: 'OB_LONG_TRANSACTION',
          level: sec >= T.longTxnSec * 4 ? 3 : 2,
          name: '长事务',
          summary: `会话 ${num(r.ID)}（租户 ${str(r.TENANT)}）事务持续 ${sec} 秒，状态 ${str(r.TRANS_STATE)}`,
          target: `${str(r.TENANT)}@${str(r.HOST)}`,
          scope: 'Tenant',
          clusterName,
          tenantName: str(r.TENANT),
          labels: { 持续秒数: String(sec), 事务状态: str(r.TRANS_STATE), SQL_ID: str(r.SQL_ID) }
        }))
      }
    } else {
      skipped.push('长事务（无进程列表视图）')
    }
  } catch {
    skipped.push('长事务（进程列表不可用）')
  }

  // --- 6. 合并异常 / 卡住
  try {
    const rows = await q<any>(
      p, password,
      `SELECT STATUS, IS_ERROR, IS_SUSPENDED, START_TIME, LAST_FINISH_TIME, INFO
         FROM oceanbase.DBA_OB_MAJOR_COMPACTION`
    )
    for (const r of rows) {
      const status = str(r.STATUS)
      const isError = str(r.IS_ERROR) === 'YES'
      const suspended = str(r.IS_SUSPENDED) === 'YES'
      let level = 0
      let summary = ''
      if (isError) {
        level = 3
        summary = `合并处于错误状态：${str(r.INFO) || '无附加信息'}`
      } else if (suspended) {
        level = 3
        summary = '合并已被挂起（IS_SUSPENDED=YES）'
      } else if (status === 'MERGING' && str(r.START_TIME)) {
        const start = new Date(str(r.START_TIME).replace(' ', 'T')).getTime()
        const hours = (Date.now() - start) / 3_600_000
        if (hours >= T.compactionStalledHours) {
          level = 2
          summary = `合并已持续 ${hours.toFixed(1)} 小时仍未完成（起始 ${str(r.START_TIME)}）`
        }
      }
      if (!level) continue
      alarms.push(alarmOf({
        rule: 'OB_COMPACTION_ABNORMAL',
        level,
        name: '合并异常',
        summary,
        target: clusterName,
        scope: 'Cluster',
        clusterName,
        labels: { 状态: status, IS_ERROR: str(r.IS_ERROR), IS_SUSPENDED: str(r.IS_SUSPENDED), 起始时间: str(r.START_TIME) }
      }))
    }
  } catch {
    skipped.push('合并状态（DBA_OB_MAJOR_COMPACTION 不可用）')
  }

  // --- 7. 日志流状态异常（副本不可用 / 切换中的直接信号）
  // 视图可用性因版本而异：sys 租户下 DBA_OB_LS 一般存在，普通租户可能只有 CDB_OB_LS，
  // 逐个试，全都没有才算"未覆盖"——否则总览会一直挂一条"规则跳过"的噪音。
  try {
    let rows: any[] = []
    for (const view of ['DBA_OB_LS', 'CDB_OB_LS', 'GV$OB_LS']) {
      try {
        rows = await q<any>(p, password, `SELECT TENANT_ID, LS_ID, STATUS FROM oceanbase.${view}`)
        break
      } catch {
        rows = []
      }
    }
    if (!rows.length) {
      // 查不到就静默跳过：这是"规则未覆盖"，不是"数据取回失败"
      skipped.push('日志流状态（当前版本无 DBA_OB_LS / CDB_OB_LS）')
    } else {
      const normal = new Set(['NORMAL', 'LEADER', 'FOLLOWER', 'CREATING', 'CREATED', 'STARTING', 'TAKEOVER'])
      const tenantName = new Map<number, string>()
      for (const t of s.tenants) tenantName.set(num(t.TENANT_ID), str(t.TENANT_NAME))
      for (const r of rows) {
        const status = str(r.STATUS).toUpperCase()
        if (!status || normal.has(status)) continue
        const tid = num(r.TENANT_ID)
        const tname = tenantName.get(tid) || `tenant_${tid}`
        alarms.push(alarmOf({
          rule: 'OB_LS_NOT_NORMAL',
          level: 3,
          name: '日志流状态异常',
          summary: `租户 ${tname} 的日志流 ${num(r.LS_ID)} 状态为 ${status}`,
          target: `${tname} / LS ${num(r.LS_ID)}`,
          scope: 'Tenant',
          clusterName,
          tenantName: tname,
          labels: { LS_ID: String(num(r.LS_ID)), 状态: status, 租户ID: String(tid) }
        }))
      }
    }
  } catch {
    skipped.push('日志流状态（视图不可读）')
  }

  const levels = countLevels(alarms)
  return {
    alarms,
    total: alarms.length,
    critical: alarms.filter((a) => a.level >= 3).length,
    levels,
    skipped
  }
}

/** 供 overviewOf 注入的轻量签名：只回计数，避免把整套告警对象塞进总览 */
export async function alarmSummaryOf(
  p: ObDirectPlatform,
  password: string,
  s: ObSnapshot
): Promise<{ total: number; levels: AlarmLevelCount[]; critical: number; alarms: CloudAlarm[]; skipped: string[] }> {
  const r = await evaluateAlarms(p, password, s)
  return { total: r.total, levels: r.levels, critical: r.critical, alarms: r.alarms, skipped: r.skipped }
}
