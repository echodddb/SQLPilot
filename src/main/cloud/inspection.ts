/**
 * OCP · 巡检（对齐官方「巡检」模块：巡检对象概览 / 巡检历史 / 巡检报告）。
 *
 * 实测于 OCP 4.4.1（2026-10-21）：
 *   GET /api/v2/inspection/overview?inspectionObjectType=OB_CLUSTER|OB_TENANT|OB_PROXY
 *   GET /api/v2/inspection/task?page=&size=            报告列表（id 是 reportId，taskId 是运维任务号）
 *   GET /api/v2/inspection/report/{reportId}           报告全文（inspectionItems 定义 + reportItems 结果）
 *   GET /api/v2/inspection/tag                        内置/自定义巡检项集合
 *   /api/v2/inspection/item 必须带 inspectionObjectType + objectId，页面用不上（报告里已含条目定义）
 */

import type { OcpClient } from './ocp'

export type InspectionObjectType = 'OB_CLUSTER' | 'OB_TENANT' | 'OB_PROXY'

export const INSPECTION_TYPES: { key: InspectionObjectType; label: string }[] = [
  { key: 'OB_CLUSTER', label: '集群' },
  { key: 'OB_TENANT', label: '租户' },
  { key: 'OB_PROXY', label: 'OBProxy' }
]

export interface InspectionObjectRef {
  type: string
  objectId: number
  name: string
  obClusterId: number
  parent: string
}

export interface InspectionReportRef {
  /** 报告 id（= 列表里的 id） */
  id: number
  taskId: number
  state: string
  startTime: string
  endTime: string
  high: number
  medium: number
  low: number
  itemFinished: number
  itemTotal: number
  tag: string
  object: InspectionObjectRef
}

export interface InspectionOverviewRow {
  object: InspectionObjectRef
  /** 最近一份报告（可能没有） */
  latest: InspectionReportRef | null
  reportCount: number
  /** 调度状态：ACTIVE / INACTIVE / EXPIRED… */
  scheduleState: string
}

export interface InspectionItemResult {
  itemId: number
  name: string
  description: string
  targetType: string
  unit: string
  /** 巡检项分类（BUILTIN / CUSTOM…） */
  category: string
  target: string
  /** 可读结果，如「NORMAL (0)」「pass」 */
  value: string
  rawValue: string
  /** 结果是否为异常（OCP 报告明细不给风险等级，只能从结果值判断明显异常） */
  abnormal: boolean
}

export interface InspectionReport extends InspectionReportRef {
  items: InspectionItemResult[]
  /** 报告里出现过的风险等级统计（报告级 high/medium/low 之外的自算值） */
  risk: { high: number; medium: number; low: number }
}

export const INSPECTION_TAG_DEFAULT = '未分类'

const num = (v: any): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const str = (v: any): string => (v === undefined || v === null ? '' : String(v))
const rows = (d: any): any[] => (Array.isArray(d) ? d : Array.isArray(d?.contents) ? d.contents : [])

function toObject(raw: any): InspectionObjectRef {
  return {
    type: str(raw?.inspectionObjectType),
    objectId: num(raw?.objectId),
    name: str(raw?.name),
    obClusterId: num(raw?.info?.obClusterId),
    parent: str(raw?.parent?.name ?? raw?.parent)
  }
}

function toReportRef(raw: any): InspectionReportRef {
  return {
    id: num(raw?.id),
    taskId: num(raw?.taskId),
    state: str(raw?.taskState ?? raw?.state),
    startTime: str(raw?.startTime),
    endTime: str(raw?.endTime),
    high: num(raw?.highRiskCount),
    medium: num(raw?.mediumRiskCount),
    low: num(raw?.lowRiskCount),
    itemFinished: num(raw?.itemFinishedCount),
    itemTotal: num(raw?.itemTotalCount),
    tag: str(raw?.tag?.name),
    object: toObject(raw?.inspectionObject)
  }
}

export async function ocpInspectionOverview(client: OcpClient, type: InspectionObjectType): Promise<InspectionOverviewRow[]> {
  const d = await client.call<any>('/api/v2/inspection/overview', {
    query: { inspectionObjectType: type, page: 1, size: 200 }
  })
  return rows(d).map((x: any) => {
    const reports: InspectionReportRef[] = (Array.isArray(x?.reportOverviews) ? x.reportOverviews : []).map(toReportRef)
    // 报告按开始时间倒序，第一份就是「最近一次」
    reports.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))
    return {
      object: toObject(x?.inspectionObject),
      latest: reports[0] || null,
      reportCount: reports.length,
      scheduleState: str(x?.scheduleState)
    }
  })
}

export async function ocpInspectionTasks(client: OcpClient, page = 1, size = 20): Promise<{ items: InspectionReportRef[]; total: number }> {
  const d = await client.call<any>('/api/v2/inspection/task', { query: { page, size } })
  return {
    items: rows(d).map(toReportRef),
    total: num(d?.page?.totalElements ?? rows(d).length)
  }
}

export async function ocpInspectionTags(client: OcpClient): Promise<{ id: number; name: string; configType: string; description: string }[]> {
  const d = await client.call<any>('/api/v2/inspection/tag', { query: { page: 1, size: 100 } })
  return rows(d).map((t: any) => ({
    id: num(t?.id),
    name: str(t?.name),
    configType: str(t?.configType),
    description: str(t?.description)
  }))
}

/**
 * 结果值里的异常特征。OCP 的 reportItems 只有 value / rawValue，没有逐项风险等级
 * （高/中/低计数在报告顶层），所以明细只做「是否明显异常」的标注，不臆造等级。
 */
const ABNORMAL_RE = /(fail|error|abnormal|unavailable|not[\s_-]?exist|invalid|denied|\b(?:high|critical|warning)\b|超限|异常|失败)/i
const isAbnormal = (value: string, raw: string): boolean => ABNORMAL_RE.test(value) || ABNORMAL_RE.test(raw)

/** 报告详情：reportItems 只有 itemId + 结果，名称/说明/风险等级来自 inspectionItems 的定义 */
export async function ocpInspectionReport(client: OcpClient, reportId: number): Promise<InspectionReport> {
  const d = await client.call<any>(`/api/v2/inspection/report/${reportId}`)
  const defs = new Map<number, any>()
  for (const it of Array.isArray(d?.inspectionItems) ? d.inspectionItems : []) defs.set(num(it?.id), it)

  const items: InspectionItemResult[] = (Array.isArray(d?.reportItems) ? d.reportItems : []).map((r: any) => {
    const def = defs.get(num(r?.itemId)) || {}
    const v = str(r?.value)
    const raw = str(r?.rawValue)
    return {
      itemId: num(r?.itemId),
      name: str(def?.name ?? r?.key),
      description: str(def?.description),
      targetType: str(def?.targetType ?? r?.targetType),
      unit: str(def?.unit),
      category: str(def?.configType),
      target: str(r?.target),
      value: v,
      rawValue: raw,
      abnormal: isAbnormal(v, raw)
    }
  })

  // 风险计数用报告顶层的权威值（与巡检历史列表里的高/中/低一致）
  const risk = { high: num(d?.highRiskCount), medium: num(d?.mediumRiskCount), low: num(d?.lowRiskCount) }

  // 明细把异常项排前面，正常项按巡检项 id 保持稳定顺序
  items.sort((a, b) => Number(b.abnormal) - Number(a.abnormal) || a.itemId - b.itemId)

  return { ...toReportRef(d), items, risk }
}

export interface InspectionBundle {
  /** 三类对象的概览（集群 / 租户 / OBProxy） */
  overviews: Record<InspectionObjectType, InspectionOverviewRow[]>
  tasks: InspectionReportRef[]
  total: number
  tags: { id: number; name: string; configType: string; description: string }[]
  updatedAt: number
}

export async function ocpInspectionBundle(client: OcpClient): Promise<InspectionBundle> {
  const [clusters, tenants, proxies, tasks, tags] = await Promise.all([
    ocpInspectionOverview(client, 'OB_CLUSTER').catch(() => []),
    ocpInspectionOverview(client, 'OB_TENANT').catch(() => []),
    ocpInspectionOverview(client, 'OB_PROXY').catch(() => []),
    ocpInspectionTasks(client).catch(() => ({ items: [], total: 0 })),
    ocpInspectionTags(client).catch(() => [])
  ])
  return {
    overviews: { OB_CLUSTER: clusters, OB_TENANT: tenants, OB_PROXY: proxies },
    tasks: tasks.items,
    total: tasks.total,
    tags,
    updatedAt: Date.now()
  }
}
