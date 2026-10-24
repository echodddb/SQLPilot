/**
 * OCP · 备份恢复（对齐官方「备份恢复」模块：核心指标 / 备份对象 / 备份服务 / 存储 / 告警 / 任务）。
 *
 * 端点全部在真实 OCP 4.4.1 上实测过（2026-10-21）：
 *   GET /api/v2/backup/overview                      核心指标
 *   GET /api/v2/backup/backupInfos?backupStatus=...  备份对象（含租户明细 tenantBackupInfoList）
 *   GET /api/v2/backup/config/storages               备份存储
 *   GET /api/v2/backup/services                      备份服务（逻辑备份用）
 *   GET /api/v2/backup/alarms                        备份告警
 *   GET /api/v2/backup/task/{dataBackupTasks|logBackupTasks|restoreTasks|cleanExpirationDataTasks}
 *
 * 注意：backupStatus 是 List 类型，多值用逗号（"A,B"）；传三个单值以外的值会被服务端拒绝。
 */

import type { OcpClient } from './ocp'

export const BACKUP_STATUS = ['HAS_BACKUP_STRATEGY', 'NO_BACKUP_STRATEGY'] as const
export type BackupStatus = (typeof BACKUP_STATUS)[number]

export interface BackupOverview {
  /** 纳管集群总数 */
  totalClusterNum: number
  /** 已创建备份策略的集群数（集群级或租户级都算） */
  hasBackupStrategyClusterNum: number
  /** 日志备份存在延时的对象数 */
  logBackupObjectNum: number
  /** 本周数据备份成功率（%） */
  weekDataSuccessPct: number
  /** 本周恢复抽检任务 / 成功数 */
  samplingTotal: number
  samplingSuccess: number
}

export interface BackupTenantInfo {
  tenantId: number
  tenantName: string
  obTenantId: number
  backupStatus: string
  scheduleStatus: string
}

export interface BackupObjRow {
  clusterId: number
  clusterName: string
  clusterMode: string
  obClusterId: number
  obClusterStatus: string
  obClusterType: string
  obVersion: string
  /** HAS_BACKUP_STRATEGY / NO_BACKUP_STRATEGY */
  backupStatus: string
  /** NONE / RUNNING / SUSPENDED… */
  scheduleStatus: string
  primaryAndStandbyMode: boolean
  compactionStatus: string
  /** OB 侧备份能力（obBackupAbility.backupAbility） */
  ability: string
  tenants: BackupTenantInfo[]
}

export interface BackupServiceRow {
  id: number
  name: string
  type: string
  version: string
  architecture: string
  nodeCount: number
  status: string
}

export interface BackupStorageRow {
  id: number
  name: string
  type: string
  /** 存储地址（不同存储类型字段不同，尽量取一个能看的） */
  endpoint: string
  status: string
  raw: Record<string, unknown>
}

export type BackupTaskKind = 'data' | 'log' | 'restore' | 'clean'

export interface BackupTaskRow {
  /** 该任务属于哪一类（数据 / 日志 / 恢复 / 清理） */
  kind: BackupTaskKind
  id: number
  name: string
  status: string
  startTime: string
  endTime: string
  clusterName: string
  tenantName: string
  message: string
  raw: Record<string, unknown>
}

export interface BackupAlarmRow {
  id: number
  object: string
  alarmType: string
  level: string
  createTime: string
  recoverTime: string
  lastTime: string
  status: string
}

export interface BackupBundle {
  overview: BackupOverview
  /** 已备份 + 未备份的全部对象 */
  objects: BackupObjRow[]
  services: BackupServiceRow[]
  storages: BackupStorageRow[]
  tasks: Record<BackupTaskKind, BackupTaskRow[]>
  alarms: { items: BackupAlarmRow[]; logDelayObjects: number; typeStats: { type: string; count: number }[] }
  /** 数据来源说明（渲染层用来标注「哪些面板当前无数据」） */
  updatedAt: number
}

const num = (v: any): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const str = (v: any): string => (v === undefined || v === null || v === 'string' ? String(v ?? '') : String(v))
const rows = (d: any): any[] => (Array.isArray(d) ? d : Array.isArray(d?.contents) ? d.contents : [])

/** 宽松取字段：不同版本/不同任务类型的字段名不一致，按候选名依次试 */
function pick(o: Record<string, any>, keys: string[]): string {
  for (const k of keys) {
    const v = o?.[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

function toObj(raw: any): BackupObjRow {
  const ability = raw?.obBackupAbility || {}
  const cap = ability.backupAbility
  return {
    clusterId: num(raw?.clusterId ?? raw?.id),
    clusterName: str(raw?.clusterName ?? raw?.name),
    clusterMode: str(raw?.clusterMode),
    obClusterId: num(raw?.obClusterId),
    obClusterStatus: str(raw?.obClusterStatus ?? raw?.status),
    obClusterType: str(raw?.obClusterType),
    obVersion: str(raw?.obVersion),
    backupStatus: str(raw?.backupStatus),
    scheduleStatus: str(raw?.backupScheduleStatus ?? raw?.scheduleStatus),
    primaryAndStandbyMode: !!raw?.primaryAndStandbyMode,
    compactionStatus: str(raw?.compactionStatus),
    ability: typeof cap === 'boolean' ? (cap ? 'SUPPORTED' : 'UNSUPPORTED') : str(cap),
    tenants: (Array.isArray(raw?.tenantBackupInfoList) ? raw.tenantBackupInfoList : []).map((t: any) => ({
      tenantId: num(t?.tenantId),
      tenantName: str(t?.tenantName),
      obTenantId: num(t?.obTenantId),
      backupStatus: str(t?.backupStatus),
      scheduleStatus: str(t?.backupScheduleStatus ?? t?.scheduleStatus)
    }))
  }
}

function toService(raw: any): BackupServiceRow {
  return {
    id: num(raw?.id),
    name: str(raw?.name ?? raw?.serviceName),
    type: str(raw?.serviceType ?? raw?.type),
    version: str(raw?.version ?? raw?.serviceVersion),
    architecture: str(raw?.architecture ?? raw?.hardwareArchitecture),
    nodeCount: num(raw?.nodeCount ?? raw?.nodes),
    status: str(raw?.status)
  }
}

function toStorage(raw: any): BackupStorageRow {
  return {
    id: num(raw?.id),
    name: str(raw?.name ?? raw?.storageName),
    type: str(raw?.type ?? raw?.storageType),
    endpoint: pick(raw, ['endpoint', 'host', 'hostBasePath', 'basePath', 'path', 'ossBucket', 'bucket']),
    status: str(raw?.status),
    raw: raw && typeof raw === 'object' ? raw : {}
  }
}

function toTask(raw: any, kind: BackupTaskKind): BackupTaskRow {
  return {
    kind,
    id: num(raw?.id ?? raw?.taskId ?? raw?.backupTaskId),
    name: pick(raw, ['name', 'taskName', 'backupName', 'restoreName', 'tenantName']),
    status: pick(raw, ['status', 'taskStatus', 'state', 'taskState']),
    startTime: pick(raw, ['startTime', 'startedTime', 'createTime']),
    endTime: pick(raw, ['endTime', 'finishedTime', 'completeTime']),
    clusterName: str(raw?.clusterName),
    tenantName: str(raw?.tenantName),
    message: pick(raw, ['message', 'errorMessage', 'resultMessage']),
    raw: raw && typeof raw === 'object' ? raw : {}
  }
}

function toAlarm(raw: any): BackupAlarmRow {
  return {
    id: num(raw?.id),
    object: pick(raw, ['object', 'alarmTarget', 'target', 'objectName']),
    alarmType: pick(raw, ['alarmType', 'type', 'name']),
    level: pick(raw, ['level', 'alarmLevel']),
    createTime: pick(raw, ['createTime', 'startTime', 'alarmTime']),
    recoverTime: pick(raw, ['recoverTime', 'resolvedTime']),
    lastTime: pick(raw, ['lastTime', 'updateTime', 'lastAlarmTime']),
    status: pick(raw, ['status', 'state'])
  }
}

export async function ocpBackupOverview(client: OcpClient): Promise<BackupOverview> {
  const d = await client.call<any>('/api/v2/backup/overview')
  return {
    totalClusterNum: num(d?.totalClusterNum),
    hasBackupStrategyClusterNum: num(d?.hasBackupStrategyClusterNum),
    logBackupObjectNum: num(d?.logBackupObjectNum),
    weekDataSuccessPct: num(d?.successfulPercentageOfThisWeekDataBackup),
    samplingTotal: num(d?.totalSamplingInspectNum),
    samplingSuccess: num(d?.successfulSamplingInspectNum)
  }
}

/** 备份对象：一次把「已备份 / 未备份」都拿到，前端按 tab 分 */
export async function ocpBackupObjects(client: OcpClient): Promise<BackupObjRow[]> {
  const d = await client.call<any>('/api/v2/backup/backupInfos', {
    query: { backupStatus: BACKUP_STATUS.join(','), page: 1, size: 200 }
  })
  const list = rows(d).map(toObj)
  // 同一个集群在两种状态下不会重复返回，但极端情况下按 clusterId 去重并保留「有策略」那条
  const map = new Map<number, BackupObjRow>()
  for (const o of list) {
    const old = map.get(o.clusterId)
    if (!old || (old.backupStatus === 'NO_BACKUP_STRATEGY' && o.backupStatus === 'HAS_BACKUP_STRATEGY')) map.set(o.clusterId, o)
  }
  return [...map.values()].sort((a, b) => a.clusterName.localeCompare(b.clusterName))
}

export async function ocpBackupServices(client: OcpClient): Promise<BackupServiceRow[]> {
  const d = await client.call<any>('/api/v2/backup/services', { query: { page: 1, size: 100 } })
  return rows(d).map(toService)
}

export async function ocpBackupStorages(client: OcpClient): Promise<BackupStorageRow[]> {
  const d = await client.call<any>('/api/v2/backup/config/storages', { query: { page: 1, size: 100 } })
  // 这个端点没有 page 包装时也可能直接给数组
  return (Array.isArray(d) ? d : rows(d)).map(toStorage)
}

const TASK_PATH: Record<BackupTaskKind, string> = {
  data: '/api/v2/backup/task/dataBackupTasks',
  log: '/api/v2/backup/task/logBackupTasks',
  restore: '/api/v2/backup/task/restoreTasks',
  clean: '/api/v2/backup/task/cleanExpirationDataTasks'
}

export async function ocpBackupTasks(client: OcpClient, kind: BackupTaskKind, size = 50): Promise<BackupTaskRow[]> {
  const d = await client.call<any>(TASK_PATH[kind], { query: { page: 1, size } })
  return rows(d).map((x) => toTask(x, kind))
}

export async function ocpBackupAlarms(client: OcpClient): Promise<BackupBundle['alarms']> {
  const d = await client.call<any>('/api/v2/backup/alarms', { query: { page: 1, size: 100 } })
  const stats = d?.typeNumStatics && typeof d.typeNumStatics === 'object' ? d.typeNumStatics : {}
  return {
    items: (Array.isArray(d?.alarms) ? d.alarms : []).map(toAlarm),
    logDelayObjects: num(d?.currentLogBackupDelayObjectCounts),
    typeStats: Object.entries(stats).map(([type, count]) => ({ type, count: num(count) }))
  }
}

/** 备份页一次拉齐：首屏只发一轮并发请求，比逐块加载更快也更稳 */
export async function ocpBackupBundle(client: OcpClient): Promise<BackupBundle> {
  const [overview, objects, services, storages, alarms, data, log, restore, clean] = await Promise.all([
    ocpBackupOverview(client).catch(() => ({
      totalClusterNum: 0,
      hasBackupStrategyClusterNum: 0,
      logBackupObjectNum: 0,
      weekDataSuccessPct: 0,
      samplingTotal: 0,
      samplingSuccess: 0
    })),
    ocpBackupObjects(client).catch(() => []),
    ocpBackupServices(client).catch(() => []),
    ocpBackupStorages(client).catch(() => []),
    ocpBackupAlarms(client).catch(() => ({ items: [], logDelayObjects: 0, typeStats: [] })),
    ocpBackupTasks(client, 'data').catch(() => []),
    ocpBackupTasks(client, 'log').catch(() => []),
    ocpBackupTasks(client, 'restore').catch(() => []),
    ocpBackupTasks(client, 'clean').catch(() => [])
  ])
  return {
    overview,
    objects,
    services,
    storages,
    alarms,
    tasks: { data, log, restore, clean },
    updatedAt: Date.now()
  }
}
