/**
 * 直连模式的租户「运维视图」：事务 / 合并 / 监控 / 备份 / 资源管理。
 *
 * 全部 SQL 都在真库（OceanBase 4.2.1.7，192.168.10.165:2881，root@sys）跑通过，
 * 视图名与列名按实测写，不要照 OCP 的接口猜：
 *   · 事务   GV$OB_TRANSACTION_PARTICIPANTS（4.2 没有 GV$OB_TRANS_STAT）
 *   · 合并   GV$OB_COMPACTION_PROGRESS / GV$OB_COMPACTION_SUGGESTIONS / DBA_OB_MAJOR_COMPACTION
 *            （注意是 SUGGESTIONS 复数，GV$OB_COMPACTION_SUGGESTED_TABLE 不存在）
 *   · 监控   GV$OB_MEMSTORE / GV$OB_TENANT_MEMORY / GV$OB_UNITS / GV$OB_PROCESSLIST / GV$OB_SQL_AUDIT
 *            （4.2 没有 GV$OB_SYSSTAT，只有 GV$SYSSTAT / V$SYSSTAT）
 *   · 备份   CDB_OB_BACKUP_JOBS / CDB_OB_BACKUP_TASKS（sys 身份读）
 *   · 资源   资源隔离计划是**租户内部对象**，必须以业务账号连进去读
 *            DBA_RSRC_PLANS / DBA_RSRC_PLAN_DIRECTIVES / DBA_RSRC_CONSUMER_GROUPS / DBA_OB_RSRC_IO_DIRECTIVES
 */

import { q, qAs, type ObDirectPlatform, type TenantLogin } from './conn'

const str = (v: any): string => (v === undefined || v === null ? '' : String(v))
const num = (v: any): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ---------------------------------------------------------------- 事务

export interface ObTenantTxn {
  sessionId: number
  txId: string
  state: string
  txType: string
  lsId: number
  participants: string
  createTime: string
  expireTime: string
  lastRequestTime: string
  svrIp: string
  svrPort: number
}

export async function tenantTxnsOf(
  p: ObDirectPlatform,
  password: string,
  tenantId: number,
  limit = 200
): Promise<ObTenantTxn[]> {
  const rows = await q(
    p,
    password,
    `SELECT SVR_IP, SVR_PORT, SESSION_ID, TX_ID, STATE, TX_TYPE, LS_ID, PARTICIPANTS,
            CTX_CREATE_TIME, TX_EXPIRED_TIME, LAST_REQUEST_TIME
       FROM oceanbase.GV$OB_TRANSACTION_PARTICIPANTS
      WHERE TENANT_ID = ?
      ORDER BY LAST_REQUEST_TIME DESC
      LIMIT ?`,
    [tenantId, limit]
  )
  return rows.map((r: any) => ({
    svrIp: str(r.SVR_IP),
    svrPort: num(r.SVR_PORT),
    sessionId: num(r.SESSION_ID),
    txId: str(r.TX_ID),
    state: str(r.STATE),
    txType: str(r.TX_TYPE),
    lsId: num(r.LS_ID),
    participants: str(r.PARTICIPANTS),
    createTime: str(r.CTX_CREATE_TIME),
    expireTime: str(r.TX_EXPIRED_TIME),
    lastRequestTime: str(r.LAST_REQUEST_TIME)
  }))
}

// ---------------------------------------------------------------- 合并

export interface ObCompactionProgress {
  svrIp: string
  zone: string
  type: string
  status: string
  totalTablets: number
  unfinishedTablets: number
  dataSize: number
  unfinishedSize: number
  compressionRatio: number
  startTime: string
  estimatedFinish: string
}

export interface ObCompactionSuggestion {
  svrIp: string
  type: string
  lsId: number
  tabletId: number
  startTime: string
  finishTime: string
  suggestion: string
}

export interface ObMajorCompaction {
  frozenScn: string
  frozenTime: string
  broadcastScn: string
  lastScn: string
  lastFinishTime: string
  startTime: string
  status: string
  isError: string
  isSuspended: string
  info: string
}

export interface ObCompactionBundle {
  progress: ObCompactionProgress[]
  suggestions: ObCompactionSuggestion[]
  major: ObMajorCompaction | null
  settings: { name: string; value: string; scope: string }[]
}

export async function tenantCompactionOf(
  p: ObDirectPlatform,
  password: string,
  tenantId: number
): Promise<ObCompactionBundle> {
  const [progress, suggestions, major, settings] = await Promise.all([
    q(
      p,
      password,
      `SELECT SVR_IP, ZONE, TYPE, STATUS, TOTAL_TABLET_COUNT, UNFINISHED_TABLET_COUNT,
              DATA_SIZE, UNFINISHED_DATA_SIZE, COMPRESSION_RATIO, START_TIME, ESTIMATED_FINISH_TIME
         FROM oceanbase.GV$OB_COMPACTION_PROGRESS
        WHERE TENANT_ID = ?
        ORDER BY START_TIME DESC
        LIMIT 50`,
      [tenantId]
    ),
    q(
      p,
      password,
      `SELECT SVR_IP, TYPE, LS_ID, TABLET_ID, START_TIME, FINISH_TIME, SUGGESTION
         FROM oceanbase.GV$OB_COMPACTION_SUGGESTIONS
        WHERE TENANT_ID = ?
        LIMIT 50`,
      [tenantId]
    ),
    q(
      p,
      password,
      `SELECT FROZEN_SCN, FROZEN_TIME, GLOBAL_BROADCAST_SCN, LAST_SCN, LAST_FINISH_TIME,
              START_TIME, STATUS, IS_ERROR, IS_SUSPENDED, INFO
         FROM oceanbase.DBA_OB_MAJOR_COMPACTION
        LIMIT 1`
    ),
    q(
      p,
      password,
      `SELECT name, value, tenant_id FROM oceanbase.GV$OB_PARAMETERS
        WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId]
    )
  ])

  const WANTED = new Set([
    'merge_thread_count', 'merger_check_interval', 'undo_retention',
    'major_freeze_duty_time', 'enable_major_freeze', 'minor_merge_concurrency',
    'merge_stat_sampling_ratio'
  ])
  const picked = new Map<string, { name: string; value: string; scope: string }>()
  for (const r of settings as any[]) {
    const name = str(r.name ?? r.NAME)
    if (!WANTED.has(name)) continue
    const scope = r.tenant_id === null || r.tenant_id === undefined ? '集群' : '租户'
    // 同名时优先租户级
    if (!picked.has(name) || scope === '租户') picked.set(name, { name, value: str(r.value ?? r.VALUE), scope })
  }

  const m: any = (major as any[])[0]
  return {
    progress: progress.map((r: any) => ({
      svrIp: str(r.SVR_IP),
      zone: str(r.ZONE),
      type: str(r.TYPE),
      status: str(r.STATUS),
      totalTablets: num(r.TOTAL_TABLET_COUNT),
      unfinishedTablets: num(r.UNFINISHED_TABLET_COUNT),
      dataSize: num(r.DATA_SIZE),
      unfinishedSize: num(r.UNFINISHED_DATA_SIZE),
      compressionRatio: num(r.COMPRESSION_RATIO),
      startTime: str(r.START_TIME),
      estimatedFinish: str(r.ESTIMATED_FINISH_TIME)
    })),
    suggestions: suggestions.map((r: any) => ({
      svrIp: str(r.SVR_IP),
      type: str(r.TYPE),
      lsId: num(r.LS_ID),
      tabletId: num(r.TABLET_ID),
      startTime: str(r.START_TIME),
      finishTime: str(r.FINISH_TIME),
      suggestion: str(r.SUGGESTION)
    })),
    major: m
      ? {
          frozenScn: str(m.FROZEN_SCN),
          frozenTime: str(m.FROZEN_TIME),
          broadcastScn: str(m.GLOBAL_BROADCAST_SCN),
          lastScn: str(m.LAST_SCN),
          lastFinishTime: str(m.LAST_FINISH_TIME),
          startTime: str(m.START_TIME),
          status: str(m.STATUS),
          isError: str(m.IS_ERROR),
          isSuspended: str(m.IS_SUSPENDED),
          info: str(m.INFO)
        }
      : null,
    settings: [...picked.values()]
  }
}

// ---------------------------------------------------------------- 监控

export interface ObTenantMetricCard {
  key: string
  label: string
  value: string
  unit: string
  hint: string
  /** 0..1，给了就画进度条 */
  ratio: number | null
}

export interface ObTenantMetrics {
  cards: ObTenantMetricCard[]
  /** 5 分钟窗口的 SQL 审计聚合，用于和「SQL 诊断」对得上 */
  window: { sqlCount: number; errCount: number; avgUs: number; qps: number; windowSec: number } | null
  updatedAt: number
}

const fmtBytes = (b: number): string => {
  const n = Math.max(0, Number(b) || 0)
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

export async function tenantMetricsOf(
  p: ObDirectPlatform,
  password: string,
  tenantId: number,
  tenantName: string
): Promise<ObTenantMetrics> {
  const WINDOW_SEC = 300
  const [memstore, memory, units, sessions, audit] = await Promise.all([
    q(
      p, password,
      `SELECT SUM(MEMSTORE_USED) USED, SUM(MEMSTORE_LIMIT) LIM, SUM(FREEZE_CNT) FREEZES
         FROM oceanbase.GV$OB_MEMSTORE WHERE TENANT_ID = ?`,
      [tenantId]
    ),
    q(
      p, password,
      `SELECT SUM(HOLD) HOLD, SUM(FREE) FREE FROM oceanbase.GV$OB_TENANT_MEMORY WHERE TENANT_ID = ?`,
      [tenantId]
    ),
    q(
      p, password,
      `SELECT SUM(MAX_CPU) CPU, SUM(MEMORY_SIZE) MEM, SUM(DATA_DISK_IN_USE) DATA_USED,
              SUM(LOG_DISK_IN_USE) LOG_USED, SUM(LOG_DISK_SIZE) LOG_SIZE
         FROM oceanbase.GV$OB_UNITS WHERE TENANT_ID = ?`,
      [tenantId]
    ),
    q(p, password, `SELECT COUNT(*) C FROM oceanbase.GV$OB_PROCESSLIST WHERE TENANT = ?`, [tenantName]),
    q(
      p, password,
      `SELECT COUNT(*) CNT, SUM(CASE WHEN RET_CODE <> 0 THEN 1 ELSE 0 END) ERRS,
              AVG(ELAPSED_TIME) AVG_US
         FROM oceanbase.GV$OB_SQL_AUDIT
        WHERE TENANT_ID = ? AND REQUEST_TIME > DATE_SUB(NOW(), INTERVAL ${WINDOW_SEC} SECOND)`,
      [tenantId]
    )
  ])

  const ms: any = (memstore as any[])[0] || {}
  const mem: any = (memory as any[])[0] || {}
  const un: any = (units as any[])[0] || {}
  const ss: any = (sessions as any[])[0] || {}
  const au: any = (audit as any[])[0] || {}

  const msUsed = num(ms.USED)
  const msLim = num(ms.LIM)
  const memHold = num(mem.HOLD)
  const memFree = num(mem.FREE)
  const memTotal = memHold + memFree
  const sqlCount = num(au.CNT)
  const errCount = num(au.ERRS)

  const cards: ObTenantMetricCard[] = [
    {
      key: 'qps', label: 'QPS', unit: '次/秒', hint: `近 ${WINDOW_SEC / 60} 分钟 SQL 审计计数`,
      value: (sqlCount / WINDOW_SEC).toFixed(2), ratio: null
    },
    {
      key: 'err', label: '错误 SQL', unit: '条', hint: `近 ${WINDOW_SEC / 60} 分钟 RET_CODE≠0`,
      value: String(errCount), ratio: sqlCount ? errCount / sqlCount : null
    },
    {
      key: 'avg', label: '平均耗时', unit: 'ms', hint: '近 5 分钟 ELAPSED_TIME 均值',
      value: (num(au.AVG_US) / 1000).toFixed(2), ratio: null
    },
    {
      key: 'sessions', label: '会话数', unit: '个', hint: 'GV$OB_PROCESSLIST 该租户会话',
      value: String(num(ss.C)), ratio: null
    },
    {
      key: 'memstore', label: 'MemStore', unit: '%', hint: `${fmtBytes(msUsed)} / ${fmtBytes(msLim)}`,
      value: msLim ? ((msUsed / msLim) * 100).toFixed(1) : '—',
      ratio: msLim ? msUsed / msLim : null
    },
    {
      key: 'memory', label: '租户内存', unit: '%', hint: `已用 ${fmtBytes(memHold)} / 共 ${fmtBytes(memTotal)}`,
      value: memTotal ? ((memHold / memTotal) * 100).toFixed(1) : '—',
      ratio: memTotal ? memHold / memTotal : null
    },
    {
      key: 'cpu', label: 'CPU 配额', unit: '核', hint: 'GV$OB_UNITS 该租户 SUM(MAX_CPU)',
      value: String(num(un.CPU) || '—'), ratio: null
    },
    {
      key: 'log', label: '日志盘占用', unit: '', hint: `日志已用 / 配额；数据盘 ${fmtBytes(num(un.DATA_USED))}`,
      value: fmtBytes(num(un.LOG_USED)), ratio: num(un.LOG_SIZE) ? num(un.LOG_USED) / num(un.LOG_SIZE) : null
    }
  ]

  return {
    cards,
    window: {
      sqlCount, errCount, avgUs: num(au.AVG_US), qps: sqlCount / WINDOW_SEC, windowSec: WINDOW_SEC
    },
    updatedAt: Date.now()
  }
}

// ---------------------------------------------------------------- 备份

export interface ObBackupJob {
  tenantId: number
  jobId: number
  backupType: string
  level: string
  status: string
  result: string
  startTime: string
  endTime: string
  path: string
  comment: string
}

export async function tenantBackupOf(
  p: ObDirectPlatform,
  password: string,
  tenantId: number
): Promise<{ jobs: ObBackupJob[]; params: { name: string; value: string }[]; available: boolean; note: string }> {
  const toJob = (r: any): ObBackupJob => ({
    tenantId: num(r.TENANT_ID),
    jobId: num(r.JOB_ID),
    backupType: str(r.BACKUP_TYPE),
    level: str(r.JOB_LEVEL),
    status: str(r.STATUS),
    result: str(r.RESULT),
    startTime: str(r.START_TIMESTAMP),
    endTime: str(r.END_TIMESTAMP),
    path: str(r.PATH),
    comment: str(r.COMMENT)
  })

  const jobs: ObBackupJob[] = []
  let available = true
  let note = ''
  try {
    const list = await q(
      p, password,
      `SELECT TENANT_ID, JOB_ID, BACKUP_TYPE, JOB_LEVEL, STATUS, RESULT, START_TIMESTAMP, END_TIMESTAMP, PATH, COMMENT
         FROM oceanbase.CDB_OB_BACKUP_JOBS
        WHERE TENANT_ID = ?
        ORDER BY JOB_ID DESC
        LIMIT 50`,
      [tenantId]
    )
    jobs.push(...list.map(toJob))
  } catch (e: any) {
    available = false
    note = `备份任务视图不可读：${e?.sqlMessage || e?.message || e}`
  }

  let params: { name: string; value: string }[] = []
  try {
    const list = await q(p, password, `SELECT NAME, VALUE FROM oceanbase.DBA_OB_BACKUP_PARAMETER`)
    params = list.map((r: any) => ({ name: str(r.NAME), value: str(r.VALUE) }))
  } catch {
    /* 备份未配置时这张表也可能不可读，忽略 */
  }

  if (!jobs.length && !note) {
    note = '该租户没有备份任务（可能未开启备份或从未备份过）。'
  }
  return { jobs, params, available, note }
}

// ---------------------------------------------------------------- 资源管理（租户内部）

export interface ObRsrcPlan {
  plan: string
  directives: number | null
  comments: string
  status: string
  mandatory: string
}

export interface ObRsrcDirective {
  plan: string
  group: string
  type: string
  cpuP1: number
  cpuP2: number
  mgmtP1: number
  maxIops: number | null
}

export interface ObRsrcBundle {
  plans: ObRsrcPlan[]
  directives: ObRsrcDirective[]
  groups: { name: string; id: number; comments: string; internal: string }[]
  io: { plan: string; group: string; minIops: number; maxIops: number; weight: number }[]
}

/** 资源隔离计划属于租户内部对象，必须用业务账号连进去读（需要先在「连接」页录入凭据） */
export async function tenantRsrcAs(p: ObDirectPlatform, login: TenantLogin): Promise<ObRsrcBundle> {
  const safeQ = async (sql: string): Promise<any[]> => {
    try {
      return await qAs(p, login, sql)
    } catch {
      return []
    }
  }
  const [plans, directives, groups, io] = await Promise.all([
    safeQ(`SELECT PLAN, NUM_PLAN_DIRECTIVES, COMMENTS, STATUS, MANDATORY FROM oceanbase.DBA_RSRC_PLANS`),
    safeQ(`SELECT PLAN, GROUP_OR_SUBPLAN, TYPE, CPU_P1, CPU_P2, MGMT_P1, MAX_IOPS FROM oceanbase.DBA_RSRC_PLAN_DIRECTIVES`),
    safeQ(`SELECT CONSUMER_GROUP_ID, CONSUMER_GROUP, COMMENTS, INTERNAL_USE FROM oceanbase.DBA_RSRC_CONSUMER_GROUPS`),
    safeQ(`SELECT PLAN, GROUP_OR_SUBPLAN, MIN_IOPS, MAX_IOPS, WEIGHT_IOPS FROM oceanbase.DBA_OB_RSRC_IO_DIRECTIVES`)
  ])

  return {
    plans: plans.map((r: any) => ({
      plan: str(r.PLAN),
      directives: r.NUM_PLAN_DIRECTIVES === null ? null : num(r.NUM_PLAN_DIRECTIVES),
      comments: str(r.COMMENTS),
      status: str(r.STATUS),
      mandatory: str(r.MANDATORY)
    })),
    directives: directives.map((r: any) => ({
      plan: str(r.PLAN),
      group: str(r.GROUP_OR_SUBPLAN),
      type: str(r.TYPE),
      cpuP1: num(r.CPU_P1),
      cpuP2: num(r.CPU_P2),
      mgmtP1: num(r.MGMT_P1),
      maxIops: r.MAX_IOPS === null || r.MAX_IOPS === undefined ? null : num(r.MAX_IOPS)
    })),
    groups: groups.map((r: any) => ({
      name: str(r.CONSUMER_GROUP),
      id: num(r.CONSUMER_GROUP_ID),
      comments: str(r.COMMENTS),
      internal: str(r.INTERNAL_USE)
    })),
    io: io.map((r: any) => ({
      plan: str(r.PLAN),
      group: str(r.GROUP_OR_SUBPLAN),
      minIops: num(r.MIN_IOPS),
      maxIops: num(r.MAX_IOPS),
      weight: num(r.WEIGHT_IOPS)
    }))
  }
}
