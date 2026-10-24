/**
 * OCP · OBProxy 集群（对齐官方「OBProxy」导航：集群 + 实例 + 连接 OB 集群 + 参数）。
 *
 * 实测于 OCP 4.4.1（2026-10-21）：
 *   GET /api/v2/obproxy/clusters                  列表（含 obproxies / obLinks / topo / versions）
 *   GET /api/v2/obproxy/clusters/{id}             详情（同上，字段更全）
 *   GET /api/v2/obproxy/clusters/{id}/parameters  参数（key/valueString/configLevel/needReboot…）
 * 不存在的路径（/obproxies、/obLinks 独立端点）会返回 SPA HTML，别照抄。
 */

import type { OcpClient } from './ocp'

export interface ObproxyInstance {
  id: number
  proxyId: number
  ip: string
  hostId: number
  sqlPort: number
  rpcPort: number
  exporterPort: number
  version: string
  /** RUNNING / STOPPED… */
  status: string
  /** NORMAL / UPGRADING… */
  operateStatus: string
  idcName: string
  architecture: string
  runPath: string
  offline: boolean
  lastActiveTime: string
}

export interface ObproxyLink {
  clusterId: number
  clusterName: string
  obClusterId: number
  clusterType: string
  status: string
  connections: number
  username: string
  version: string
}

export interface ObproxyCluster {
  id: number
  name: string
  address: string
  port: number
  status: string
  workMode: string
  version: string
  maxVersion: string
  parameterVersion: number
  createTime: string
  updateTime: string
  creatorName: string
  vpcName: string
  os: string
  configUrl: string
  instances: ObproxyInstance[]
  links: ObproxyLink[]
  /** 按 IDC 的实例分布 */
  topo: { idcName: string; count: number }[]
  /** 按版本的实例分布（滚动升级时用） */
  versions: { version: string; count: number }[]
}

export interface ObproxyParam {
  name: string
  value: string
  /** LEVEL_GLOBAL / LEVEL_TENANT… */
  configLevel: string
  needReboot: boolean
  readonly: boolean
  description: string
  /** 该参数在哪些实例上生效（OCP 用它做「按实例改」） */
  targets: number
  tenantName: string
  vip: string
  vport: number
}

const num = (v: any): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const str = (v: any): string => (v === undefined || v === null ? '' : String(v))
const rows = (d: any): any[] => (Array.isArray(d) ? d : Array.isArray(d?.contents) ? d.contents : [])

function toInstance(raw: any): ObproxyInstance {
  return {
    id: num(raw?.id),
    proxyId: num(raw?.proxyId),
    ip: str(raw?.ip),
    hostId: num(raw?.hostId),
    sqlPort: num(raw?.sqlPort),
    rpcPort: num(raw?.rpcPort),
    exporterPort: num(raw?.exporterPort),
    version: str(raw?.version),
    status: str(raw?.status),
    operateStatus: str(raw?.operateStatus),
    idcName: str(raw?.idcName),
    architecture: str(raw?.architecture),
    runPath: str(raw?.runPath),
    offline: !!raw?.offline,
    lastActiveTime: str(raw?.lastActiveTime)
  }
}

function toLink(raw: any): ObproxyLink {
  return {
    clusterId: num(raw?.clusterId),
    clusterName: str(raw?.clusterName),
    obClusterId: num(raw?.obClusterId),
    clusterType: str(raw?.clusterType),
    status: str(raw?.status),
    connections: num(raw?.connections),
    username: str(raw?.username),
    version: str(raw?.version)
  }
}

function toCluster(raw: any): ObproxyCluster {
  const instances = (Array.isArray(raw?.obproxies) ? raw.obproxies : []).map(toInstance)
  const topo = (Array.isArray(raw?.topo) ? raw.topo : []).map((t: any) => ({ idcName: str(t?.idcName), count: num(t?.count) }))
  const versions = (Array.isArray(raw?.versions) ? raw.versions : []).map((v: any) => ({ version: str(v?.version), count: num(v?.count) }))
  return {
    id: num(raw?.id),
    name: str(raw?.name),
    address: str(raw?.address),
    port: num(raw?.port),
    status: str(raw?.clusterStatus ?? raw?.status),
    workMode: str(raw?.workMode),
    version: str(raw?.minVersion ?? raw?.version),
    maxVersion: str(raw?.maxVersion),
    parameterVersion: num(raw?.parameterVersion),
    createTime: str(raw?.createTime),
    updateTime: str(raw?.updateTime),
    creatorName: str(raw?.creatorName),
    vpcName: str(raw?.vpcName),
    os: str(raw?.packageOperatingSystem),
    configUrl: str(raw?.configUrl),
    instances,
    links: (Array.isArray(raw?.obLinks) ? raw.obLinks : []).map(toLink),
    topo: topo.length ? topo : instances.reduce((acc: { idcName: string; count: number }[], i: ObproxyInstance) => {
      const hit = acc.find((x) => x.idcName === i.idcName)
      if (hit) hit.count += 1
      else acc.push({ idcName: i.idcName || '-', count: 1 })
      return acc
    }, []),
    versions: versions.length
      ? versions
      : instances.reduce((acc: { version: string; count: number }[], i: ObproxyInstance) => {
          const hit = acc.find((x) => x.version === i.version)
          if (hit) hit.count += 1
          else acc.push({ version: i.version || '-', count: 1 })
          return acc
        }, [])
  }
}

export async function ocpObproxyClusters(client: OcpClient): Promise<ObproxyCluster[]> {
  const d = await client.call<any>('/api/v2/obproxy/clusters', { query: { page: 1, size: 100 } })
  return rows(d).map(toCluster).sort((a, b) => a.name.localeCompare(b.name))
}

export async function ocpObproxyCluster(client: OcpClient, id: number): Promise<ObproxyCluster> {
  const d = await client.call<any>(`/api/v2/obproxy/clusters/${id}`)
  return toCluster(d)
}

export async function ocpObproxyParams(client: OcpClient, id: number): Promise<ObproxyParam[]> {
  const d = await client.call<any>(`/api/v2/obproxy/clusters/${id}/parameters`, { query: { page: 1, size: 500 } })
  return rows(d).map((p: any) => ({
    name: str(p?.name),
    value: str(p?.valueString ?? p?.value),
    configLevel: str(p?.configLevel),
    needReboot: !!p?.needReboot,
    readonly: !!p?.readonly,
    description: str(p?.description),
    targets: Array.isArray(p?.values) ? p.values.length : 0,
    tenantName: str(p?.tenantName),
    vip: str(p?.vip),
    vport: num(p?.vport)
  }))
}

/** OBProxy 页一次拉齐：集群列表 + 每个集群的参数按需在抽屉里单独拉 */
export async function ocpObproxyBundle(client: OcpClient): Promise<{ clusters: ObproxyCluster[]; updatedAt: number }> {
  return { clusters: await ocpObproxyClusters(client), updatedAt: Date.now() }
}
