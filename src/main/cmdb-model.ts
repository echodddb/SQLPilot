/**
 * CMDB 纯逻辑层（无 electron 依赖，单测可直接 bundle 导入）
 * ─────────────────────────────────────────────────────────
 * 台账本体、关系图投影、导入导出都在这里；落盘在 cmdb.ts。
 * 拆成两层的理由：图投影/规范化是纯函数，能在 node 里跑断言，
 * 不用为了测一条关系去起 Electron。
 *
 * 两条硬规则（三维视图和台账都依赖它）：
 *  1. 客户与机房是**正交维度**，不是父子——一个机房可同时服务多个客户。
 *     资产同时挂 customerId 与 idcId，树上的"客户 → 机房"只是视图分组。
 *  2. 关系独立成边，可跨客户跨机房；端点缺失或已软删的边一律不进图。
 */

export type CmdbAssetKind = 'hardware' | 'software' | 'logical'
export type CmdbStatus = 'running' | 'stopped' | 'maintenance' | 'planned' | 'retired'
export type CmdbRelationKind = 'physical' | 'hosting' | 'dependency'

export interface Vec3 {
  x: number
  y: number
  z: number
}

// ---------------------------------------------------------------- 网络 / 规格字典
//
// 机房 3D 视图的"现实感"全靠这两张表：设备规格决定它在机柜里占几 U、多深，
// 网络类型决定线路颜色。界面、渲染、表单都从这里取，别再各写一份。

/** 网络类型（决定网线颜色）。同一物理链路上可能跑多个网络，建线时二选一 */
export type CmdbNetKind = 'biz' | 'backup' | 'storage' | 'mgmt' | 'private' | 'heartbeat' | 'other'

export interface CmdbNetDef {
  id: CmdbNetKind
  name: string
  color: string
  colorDark: string
  hint: string
}

export const NETWORKS: CmdbNetDef[] = [
  { id: 'biz', name: '业务网', color: '#0284c7', colorDark: '#38bdf8', hint: '对外提供服务的业务流量' },
  { id: 'backup', name: '备份网', color: '#7c3aed', colorDark: '#a78bfa', hint: '备份 / 归档专用链路' },
  { id: 'storage', name: '存储网', color: '#059669', colorDark: '#34d399', hint: 'SAN / NAS / 分布式存储' },
  { id: 'mgmt', name: '管理网', color: '#d97706', colorDark: '#fbbf24', hint: '带外管理 / 堡垒机 / 监控采集' },
  { id: 'private', name: '私网', color: '#db2777', colorDark: '#f472b6', hint: '客户私网 / VPC / 内网互联' },
  { id: 'heartbeat', name: '心跳网', color: '#dc2626', colorDark: '#f87171', hint: '集群心跳 / RAC 私网互联' },
  { id: 'other', name: '其他', color: '#64748b', colorDark: '#94a3b8', hint: '未归类链路' }
]

export const NET_KIND_IDS = NETWORKS.map((n) => n.id)

export function netOf(id: string): CmdbNetDef {
  return NETWORKS.find((n) => n.id === id) || NETWORKS[NETWORKS.length - 1]
}

/** 端口族：决定它在面板上画成什么样子（RJ45 方口 / SFP 笼子 / 电源插座 / 盘位） */
export type CmdbPortGroup = 'nic' | 'sfp' | 'power' | 'disk' | 'console' | 'mgmt'

export const PORT_GROUPS: { id: CmdbPortGroup; name: string; short: string }[] = [
  { id: 'nic', name: '电口（RJ45）', short: '电口' },
  { id: 'sfp', name: '光口（SFP/SFP+）', short: '光口' },
  { id: 'power', name: '电源口', short: '电源' },
  { id: 'disk', name: '硬盘位', short: '盘位' },
  { id: 'mgmt', name: '管理口（IPMI/iDRAC）', short: '管理口' },
  { id: 'console', name: 'Console 口', short: 'Console' }
]

/** 设备规格：拖拽安装时按它决定占几 U、多深、前面板长什么样。
 *  数值取真实机型量级（19 英寸 = 482.6mm，1U = 44.45mm），不是随手编的。 */
export interface CmdbSpecDef {
  id: string
  name: string
  /** 对应资产类型（ASSET_TYPES 的 id） */
  type: string
  /** 占 U 数（机柜外设备为 0，例如塔式 UPS） */
  u: number
  widthMm: number
  depthMm: number
  /** 默认用途 / 默认架构 */
  role?: string
  arch?: string
  note?: string
  /** 前面板端口布局：按数组顺序从上到下排布 */
  ports: { group: CmdbPortGroup; count: number; label: string }[]
}

export const SPECS: CmdbSpecDef[] = [
  {
    id: 'srv-1u', name: '1U 通用机架服务器', type: 'server', u: 1, widthMm: 482, depthMm: 750, role: 'app',
    note: '4 电口 + 2 光口 + 双电源 + 4 盘位',
    ports: [
      { group: 'nic', count: 4, label: 'GE' },
      { group: 'sfp', count: 2, label: '10GE' },
      { group: 'mgmt', count: 1, label: 'IPMI' },
      { group: 'power', count: 2, label: 'PSU' },
      { group: 'disk', count: 4, label: '2.5"' }
    ]
  },
  {
    id: 'srv-2u', name: '2U 数据库服务器', type: 'server', u: 2, widthMm: 482, depthMm: 790, role: 'db',
    note: '2 电口 + 4 光口 + 双电源 + 12 盘位（典型 RAC 节点）',
    ports: [
      { group: 'nic', count: 2, label: 'GE' },
      { group: 'sfp', count: 4, label: '25GE' },
      { group: 'mgmt', count: 1, label: 'IPMI' },
      { group: 'power', count: 2, label: 'PSU' },
      { group: 'disk', count: 12, label: '2.5"' }
    ]
  },
  {
    id: 'srv-4u', name: '4U 存储 / GPU 服务器', type: 'server', u: 4, widthMm: 482, depthMm: 880, role: 'storage',
    note: '24 盘位 + 4 光口',
    ports: [
      { group: 'sfp', count: 4, label: '25GE' },
      { group: 'power', count: 2, label: 'PSU' },
      { group: 'disk', count: 24, label: '3.5"' }
    ]
  },
  {
    id: 'sw-1u-24', name: '1U 24 口千兆交换机', type: 'switch', u: 1, widthMm: 442, depthMm: 420,
    ports: [
      { group: 'nic', count: 24, label: 'GE' },
      { group: 'sfp', count: 4, label: '10GE' },
      { group: 'console', count: 1, label: 'CON' },
      { group: 'power', count: 2, label: 'PSU' }
    ]
  },
  {
    id: 'sw-1u-48', name: '1U 48 口千兆交换机', type: 'switch', u: 1, widthMm: 442, depthMm: 440,
    ports: [
      { group: 'nic', count: 48, label: 'GE' },
      { group: 'sfp', count: 4, label: '10GE' },
      { group: 'console', count: 1, label: 'CON' },
      { group: 'power', count: 2, label: 'PSU' }
    ]
  },
  {
    id: 'sw-1u-spine', name: '1U 32 口 100G 核心交换机', type: 'switch', u: 1, widthMm: 442, depthMm: 550,
    ports: [
      { group: 'sfp', count: 32, label: '100G' },
      { group: 'mgmt', count: 1, label: 'MGMT' },
      { group: 'console', count: 1, label: 'CON' },
      { group: 'power', count: 2, label: 'PSU' }
    ]
  },
  {
    id: 'fw-1u', name: '1U 防火墙', type: 'firewall', u: 1, widthMm: 442, depthMm: 500,
    ports: [
      { group: 'nic', count: 8, label: 'GE' },
      { group: 'sfp', count: 4, label: '10GE' },
      { group: 'mgmt', count: 1, label: 'MGMT' },
      { group: 'power', count: 2, label: 'PSU' }
    ]
  },
  {
    id: 'lb-1u', name: '1U 负载均衡', type: 'loadbalancer', u: 1, widthMm: 442, depthMm: 600,
    ports: [
      { group: 'nic', count: 8, label: 'GE' },
      { group: 'sfp', count: 4, label: '10GE' },
      { group: 'power', count: 2, label: 'PSU' }
    ]
  },
  {
    id: 'pdu-1u', name: '机柜 PDU（1U 横装）', type: 'pdu', u: 1, widthMm: 440, depthMm: 120,
    ports: [{ group: 'power', count: 8, label: 'C13' }]
  },
  {
    id: 'patch-1u', name: '24 口配线架', type: 'other-hw', u: 1, widthMm: 440, depthMm: 100,
    ports: [{ group: 'nic', count: 24, label: 'RJ45' }]
  },
  {
    id: 'ups-rack-3u', name: '机架式 UPS（3U）', type: 'ups', u: 3, widthMm: 440, depthMm: 650,
    ports: [{ group: 'power', count: 8, label: 'C13' }]
  },
  {
    id: 'ups-tower', name: '塔式 UPS（落地）', type: 'ups', u: 0, widthMm: 480, depthMm: 700,
    note: '落地安装，占 1×2 格地板',
    ports: [{ group: 'power', count: 8, label: 'C13' }]
  },
  {
    id: 'storage-2u', name: '2U 磁盘阵列', type: 'storage', u: 2, widthMm: 482, depthMm: 630, role: 'storage',
    ports: [
      { group: 'sfp', count: 4, label: 'FC/25GE' },
      { group: 'power', count: 2, label: 'PSU' },
      { group: 'disk', count: 24, label: '2.5"' }
    ]
  },
  {
    id: 'other-1u', name: '自定义 1U 设备', type: 'other-hw', u: 1, widthMm: 482, depthMm: 600,
    ports: [{ group: 'nic', count: 2, label: 'GE' }, { group: 'power', count: 1, label: 'PSU' }]
  }
]

export const SPEC_IDS = SPECS.map((s) => s.id)

export function specOf(id?: string): CmdbSpecDef | undefined {
  if (!id) return undefined
  return SPECS.find((s) => s.id === id)
}

/** 设备用途：数据库服务器 / 应用服务器… 3D 里用色带 + 图例区分 */
export const ROLES: { id: string; name: string; hint: string }[] = [
  { id: 'db', name: '数据库', hint: 'Oracle / MySQL / PG / OB 等' },
  { id: 'app', name: '应用', hint: '业务应用 / 中间件' },
  { id: 'web', name: 'Web / 接入', hint: '反向代理 / 网关' },
  { id: 'storage', name: '存储', hint: 'SAN / NAS / 分布式存储' },
  { id: 'backup', name: '备份', hint: '备份服务器 / 磁带库' },
  { id: 'network', name: '网络', hint: '交换机 / 路由 / 防火墙' },
  { id: 'virt', name: '虚拟化', hint: '虚拟化宿主机' },
  { id: 'other', name: '其他', hint: '未归类' }
]

export const ROLE_NAME: Record<string, string> = ROLES.reduce((m, r) => ((m[r.id] = r.name), m), {} as Record<string, string>)

/** 数据库 / 集群架构：同一架构组的设备在 3D 里用同色描边连成一组 */
export const ARCHS: { id: string; name: string; hint: string; color: string; colorDark: string }[] = [
  { id: 'oracle-rac', name: 'Oracle RAC', hint: '多节点共享存储，节点间走私网心跳', color: '#dc2626', colorDark: '#f87171' },
  { id: 'oracle-dg', name: 'Oracle DataGuard', hint: '主库 → 备库 日志传输', color: '#ea580c', colorDark: '#fb923c' },
  { id: 'oracle-rac-dg', name: 'RAC + DG', hint: 'RAC 主集群 + 单机备库', color: '#b91c1c', colorDark: '#fca5a5' },
  { id: 'mysql-mgr', name: 'MySQL MGR', hint: '组复制三节点', color: '#0891b2', colorDark: '#22d3ee' },
  { id: 'mysql-ms', name: 'MySQL 主从', hint: '一主多从异步复制', color: '#0e7490', colorDark: '#67e8f9' },
  { id: 'pg-stream', name: 'PG 流复制', hint: '主备流复制', color: '#3b82f6', colorDark: '#93c5fd' },
  { id: 'mssql-ag', name: 'SQL Server AG', hint: '可用性组', color: '#6366f1', colorDark: '#a5b4fc' },
  { id: 'ob-cluster', name: 'OceanBase 集群', hint: '多 Zone 多副本', color: '#0d9488', colorDark: '#2dd4bf' },
  { id: 'other', name: '其他架构', hint: '自定义集群', color: '#64748b', colorDark: '#94a3b8' }
]

export function archOf(id?: string) {
  if (!id) return undefined
  return ARCHS.find((a) => a.id === id)
}

/** 一条网线：端口到端口。关系表管"逻辑关系"，这里管"物理链路"。 */
export interface CmdbCable {
  id: string
  fromId: string
  /** 端口 id（见 portsOf：如 `nic-1` / `sfp-2` / `power-1`） */
  fromPort: string
  toId: string
  toPort: string
  net: CmdbNetKind
  label?: string
  note?: string
  createdAt: number
}

/** 生成一台设备的端口清单（确定性：同一 spec + 同一 id 永远得到同一批端口 id）。
 *  端口 id 形如 `nic-1`；面板布局（x/y 相对位置）由渲染层按分组算。 */
export function portsOf(asset: Partial<CmdbAsset>): { id: string; group: CmdbPortGroup; index: number; label: string }[] {
  const spec = specOf(asset.spec)
  const out: { id: string; group: CmdbPortGroup; index: number; label: string }[] = []
  const groups = spec?.ports || [{ group: 'nic' as CmdbPortGroup, count: 2, label: 'GE' }, { group: 'power' as CmdbPortGroup, count: 1, label: 'PSU' }]
  for (const g of groups) {
    for (let i = 1; i <= g.count; i++) {
      out.push({ id: `${g.group}-${i}`, group: g.group, index: i, label: `${g.label}${g.count > 1 ? ` ${i}` : ''}` })
    }
  }
  return out
}

/** 同架构组的设备（RAC / DG / MGR…）：颜色分组 + 互相连线用 */
export function archGroupsOf(doc: CmdbDoc): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const a of doc.assets) {
    if (a.deletedAt || !a.arch || !a.archGroup) continue
    const key = `${a.arch}::${a.archGroup}`
      ; (out[key] = out[key] || []).push(a.id)
  }
  return out
}

export interface CmdbAssetTypeDef {
  id: string
  name: string
  kind: CmdbAssetKind
  /** 界面上的单字符标记（不用 emoji：canvas 里画字形会因字体回退抖） */
  glyph: string
}

/** 资产类型字典：**唯一源**。新增类型只改这一处（校验、表单、图例、3D 着色全跟着走） */
export const ASSET_TYPES: CmdbAssetTypeDef[] = [
  { id: 'server', name: '服务器', kind: 'hardware', glyph: '▤' },
  { id: 'switch', name: '交换机', kind: 'hardware', glyph: '⇉' },
  { id: 'router', name: '路由器', kind: 'hardware', glyph: '⇋' },
  { id: 'firewall', name: '防火墙', kind: 'hardware', glyph: '⛨' },
  { id: 'loadbalancer', name: '负载均衡', kind: 'hardware', glyph: '⇶' },
  { id: 'storage', name: '存储', kind: 'hardware', glyph: '▥' },
  { id: 'ups', name: 'UPS', kind: 'hardware', glyph: '⚡' },
  { id: 'pdu', name: 'PDU', kind: 'hardware', glyph: '⌁' },
  { id: 'other-hw', name: '其他硬件', kind: 'hardware', glyph: '▢' },
  { id: 'db-instance', name: '数据库实例', kind: 'software', glyph: '◉' },
  { id: 'middleware', name: '中间件', kind: 'software', glyph: '◍' },
  { id: 'os', name: '操作系统', kind: 'software', glyph: '▣' },
  { id: 'app', name: '应用', kind: 'software', glyph: '◆' },
  { id: 'cluster', name: '集群', kind: 'logical', glyph: '⬡' },
  { id: 'tenant', name: '租户', kind: 'logical', glyph: '⬢' },
  { id: 'biz-system', name: '业务系统', kind: 'logical', glyph: '✦' }
]

export const ASSET_TYPE_IDS = ASSET_TYPES.map((t) => t.id)

export function assetTypeOf(id: string): CmdbAssetTypeDef {
  return ASSET_TYPES.find((t) => t.id === id) || ASSET_TYPES[ASSET_TYPES.length - 1]
}

export const STATUSES: { id: CmdbStatus; name: string }[] = [
  { id: 'running', name: '运行中' },
  { id: 'stopped', name: '已停止' },
  { id: 'maintenance', name: '维护中' },
  { id: 'planned', name: '待上线' },
  { id: 'retired', name: '已下线' }
]

export const STATUS_IDS = STATUSES.map((s) => s.id)

export const RELATION_KINDS: { id: CmdbRelationKind; name: string; hint: string }[] = [
  { id: 'physical', name: '物理连接', hint: '上联 / 互联 / 堆叠（交换机 ↔ 服务器 ↔ 防火墙）' },
  { id: 'hosting', name: '运行承载', hint: '数据库实例运行在某台服务器、某台服务器在某个机柜' },
  { id: 'dependency', name: '逻辑依赖', hint: '应用依赖数据库、主备复制、备份到存储' }
]

export const RELATION_KIND_IDS = RELATION_KINDS.map((r) => r.id)

/** 关系标签的常用预设（自由文本，这只是输入提示） */
export const RELATION_LABELS: Record<CmdbRelationKind, string[]> = {
  physical: ['上联', '下联', '互联', '堆叠', '光纤', 'bond'],
  hosting: ['运行于', '承载', '虚拟化', '容器宿主'],
  dependency: ['依赖', '主备复制', '备份到', '调用', '订阅']
}

export interface CmdbCustomer {
  id: string
  name: string
  code?: string
  /** 隔离色（3D 里区分客户；留空按调色板轮转） */
  color?: string
  contact?: string
  note?: string
  createdAt: number
  updatedAt: number
}

export interface CmdbIdc {
  id: string
  name: string
  region?: string
  address?: string
  room?: string
  /** 机房地板 = cols × rows 块正方形地砖（默认 600mm 一块），3D 里就是可视化的房间尺寸 */
  cols?: number
  rows?: number
  /** 单块地砖边长（mm），默认 600（标准架空地板） */
  tileMm?: number
  note?: string
  createdAt: number
  updatedAt: number
}

export interface CmdbRack {
  id: string
  idcId: string
  code: string
  uTotal?: number
  row?: string
  /** 在地砖网格上的落位（左上角格子，0 基）。没设置时按顺序自动排 */
  gridCol?: number
  gridRow?: number
  /** 机柜物理尺寸（mm）：宽 600 / 深 1200 是常见值 */
  widthMm?: number
  depthMm?: number
  /** 额定功率 kW，供容量视图用 */
  powerKw?: number
  note?: string
  createdAt: number
  updatedAt: number
}

export interface CmdbAsset {
  id: string
  customerId: string
  idcId?: string
  rackId?: string
  /** 起始 U 位（1 基） */
  u?: number
  uHeight?: number
  /** 规格 id（见 SPECS）：决定占几 U、多深、前面板端口 */
  spec?: string
  /** 落地设备（塔式 UPS 等）在地砖网格上的位置；机柜内设备用 rackId + u */
  floorCol?: number
  floorRow?: number
  /** 用途：db / app / web / storage / backup / network / virt / other */
  role?: string
  /** 架构：oracle-rac / oracle-dg / mysql-mgr… */
  arch?: string
  /** 架构组名：同架构 + 同组名 = 一个集群（如 RAC 的 rac-prod） */
  archGroup?: string
  type: string
  name: string
  hostname?: string
  sn?: string
  vendor?: string
  model?: string
  ips: string[]
  os?: string
  status: CmdbStatus
  owner?: string
  tags: string[]
  note?: string
  meta: Record<string, string>
  /** 与 SSH 服务器注册表 / 数据库连接注册表的关联（不是复制，是引用） */
  linkServerId?: string
  linkConnId?: string
  /** 云管平台纳管来源：`<platformId>:<hostId>` */
  cloudRef?: string
  /** 告警等级 0=正常（云平台纳管时带过来） */
  alarmLevel?: number
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

export interface CmdbRelation {
  id: string
  fromId: string
  toId: string
  kind: CmdbRelationKind
  label?: string
  directed?: boolean
  note?: string
  createdAt: number
}

export interface CmdbDoc {
  version: number
  customers: CmdbCustomer[]
  idcs: CmdbIdc[]
  racks: CmdbRack[]
  assets: CmdbAsset[]
  relations: CmdbRelation[]
  /** 物理链路（端口到端口）。老台账没有这个字段，normalize 时补空数组 */
  cables: CmdbCable[]
}

export interface CmdbCamera {
  yaw: number
  pitch: number
  dist: number
  tx: number
  ty: number
  tz: number
}

export type CmdbViewMode = 'table' | 'room' | '3d' | '2d' | 'rack'

export interface CmdbViewDoc {
  version: number
  /** 仅记录**人工拖动过**的节点坐标；其余节点由布局算法生成，避免每次算法调整都失效 */
  positions: Record<string, Vec3>
  camera: CmdbCamera
  mode: CmdbViewMode
  hiddenKinds: CmdbRelationKind[]
  /** 机房 3D 视图当前打开的机房（空 = 第一个） */
  roomId?: string
}

export interface CmdbLogEntry {
  ts: string
  action: string
  target: string
  detail: string
  assetId?: string
}

// ---------------------------------------------------------------- 基础工具

export function uid(prefix = 'x'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function str(v: unknown, max = 400): string {
  if (typeof v === 'string') return v.slice(0, max)
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : undefined
}

/** 有界整数：磁盘里被手改成 9999 格地板的话，3D 房间会直接卡死 */
function clampInt(v: number | undefined, lo: number, hi: number, dflt: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

function strArr(v: unknown): string[] {  if (Array.isArray(v)) return v.map((x) => str(x, 200)).filter(Boolean)
  if (typeof v === 'string' && v.trim()) {
    // 导入时常把多个 IP 塞在一个单元格里
    return v.split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean)
  }
  return []
}

export function emptyDoc(): CmdbDoc {
  return { version: 2, customers: [], idcs: [], racks: [], assets: [], relations: [], cables: [] }
}

/** 机房 3D 的相机：世界单位是 cm，默认从 45° 侧面看一个 8×6 格的房间 */
const ROOM_CAMERA: CmdbCamera = { yaw: 0.62, pitch: 0.5, dist: 780, tx: 0, ty: 90, tz: 0 }

export function emptyView(): CmdbViewDoc {
  return {
    version: 2,
    positions: {},
    camera: { ...ROOM_CAMERA },
    mode: 'room',
    hiddenKinds: [],
    roomId: ''
  }
}

// ---------------------------------------------------------------- 规范化

/** 把磁盘上可能被手改坏的文档拉回可用形态：去重 / 清悬空 / 收敛枚举。
 *  任何一步都不能扔数据（除重复项），否则用户会看到"资产莫名消失"。 */
export function normalizeDoc(raw: any): CmdbDoc {
  const doc = emptyDoc()
  if (!raw || typeof raw !== 'object') return doc
  const seen = new Set<string>()
  const push = <T extends { id: string }>(arr: T[], item: T): void => {
    if (!item.id || seen.has(item.id)) return
    seen.add(item.id)
    arr.push(item)
  }

  for (const c of Array.isArray(raw.customers) ? raw.customers : []) {
    const name = str(c?.name, 120).trim()
    if (!name) continue
    push(doc.customers, {
      id: str(c.id) || uid('cu'),
      name,
      code: str(c.code, 60) || undefined,
      color: str(c.color, 30) || undefined,
      contact: str(c.contact, 120) || undefined,
      note: str(c.note, 1000) || undefined,
      createdAt: num(c.createdAt) || Date.now(),
      updatedAt: num(c.updatedAt) || Date.now()
    })
  }

  for (const d of Array.isArray(raw.idcs) ? raw.idcs : []) {
    const name = str(d?.name, 120).trim()
    if (!name) continue
    push(doc.idcs, {
      id: str(d.id) || uid('idc'),
      name,
      region: str(d.region, 120) || undefined,
      address: str(d.address, 300) || undefined,
      room: str(d.room, 120) || undefined,
      cols: clampInt(num(d.cols), 4, 40, 8),
      rows: clampInt(num(d.rows), 4, 40, 6),
      tileMm: clampInt(num(d.tileMm), 300, 1200, 600),
      note: str(d.note, 1000) || undefined,
      createdAt: num(d.createdAt) || Date.now(),
      updatedAt: num(d.updatedAt) || Date.now()
    })
  }

  const idcIds = new Set(doc.idcs.map((d) => d.id))
  for (const r of Array.isArray(raw.racks) ? raw.racks : []) {
    const code = str(r?.code, 80).trim()
    const idcId = str(r?.idcId)
    // 机房不存在的机柜没有落脚点：丢掉，别让它挂在树上变成幽灵
    if (!code || !idcIds.has(idcId)) continue
    push(doc.racks, {
      id: str(r.id) || uid('rk'),
      idcId,
      code,
      uTotal: num(r.uTotal) && num(r.uTotal)! > 0 ? Math.min(120, Math.floor(num(r.uTotal)!)) : 42,
      row: str(r.row, 40) || undefined,
      gridCol: num(r.gridCol) !== undefined ? clampInt(num(r.gridCol), 0, 39, 0) : undefined,
      gridRow: num(r.gridRow) !== undefined ? clampInt(num(r.gridRow), 0, 39, 0) : undefined,
      widthMm: num(r.widthMm) ? clampInt(num(r.widthMm), 300, 900, 600) : undefined,
      depthMm: num(r.depthMm) ? clampInt(num(r.depthMm), 300, 1400, 1200) : undefined,
      powerKw: num(r.powerKw) ? Math.max(0, Math.min(100, num(r.powerKw)!)) : undefined,
      note: str(r.note, 500) || undefined,
      createdAt: num(r.createdAt) || Date.now(),
      updatedAt: num(r.updatedAt) || Date.now()
    })
  }

  const rackIds = new Set(doc.racks.map((r) => r.id))
  for (const a of Array.isArray(raw.assets) ? raw.assets : []) {
    const name = str(a?.name, 160).trim()
    if (!name) continue
    const type = ASSET_TYPE_IDS.includes(str(a.type)) ? str(a.type) : 'other-hw'
    const status = (STATUS_IDS as string[]).includes(str(a.status)) ? (str(a.status) as CmdbStatus) : 'running'
    const idcId = idcIds.has(str(a.idcId)) ? str(a.idcId) : undefined
    const rackId = idcId && rackIds.has(str(a.rackId)) ? str(a.rackId) : undefined
    const spec = SPEC_IDS.includes(str(a.spec)) ? str(a.spec) : undefined
    const uHeight = num(a.uHeight) && num(a.uHeight)! > 0
      ? Math.min(20, Math.floor(num(a.uHeight)!))
      : specOf(spec)?.u || undefined
    push(doc.assets, {
      id: str(a.id) || uid('as'),
      customerId: str(a.customerId),
      idcId,
      rackId,
      u: num(a.u) && num(a.u)! > 0 ? Math.floor(num(a.u)!) : undefined,
      uHeight,
      spec,
      floorCol: num(a.floorCol) !== undefined ? clampInt(num(a.floorCol), 0, 39, 0) : undefined,
      floorRow: num(a.floorRow) !== undefined ? clampInt(num(a.floorRow), 0, 39, 0) : undefined,
      role: ROLES.some((r) => r.id === str(a.role)) ? str(a.role) : undefined,
      arch: archOf(str(a.arch)) ? str(a.arch) : undefined,
      archGroup: str(a.archGroup, 80) || undefined,
      type,
      name,
      hostname: str(a.hostname, 160) || undefined,
      sn: str(a.sn, 120) || undefined,
      vendor: str(a.vendor, 120) || undefined,
      model: str(a.model, 120) || undefined,
      ips: strArr(a.ips).slice(0, 16),
      os: str(a.os, 120) || undefined,
      status,
      owner: str(a.owner, 80) || undefined,
      tags: strArr(a.tags).slice(0, 24),
      note: str(a.note, 2000) || undefined,
      meta: a && typeof a.meta === 'object' && !Array.isArray(a.meta) ? plainMeta(a.meta) : {},
      linkServerId: str(a.linkServerId) || undefined,
      linkConnId: str(a.linkConnId) || undefined,
      cloudRef: str(a.cloudRef) || undefined,
      alarmLevel: num(a.alarmLevel) || undefined,
      createdAt: num(a.createdAt) || Date.now(),
      updatedAt: num(a.updatedAt) || Date.now(),
      deletedAt: num(a.deletedAt) || undefined
    })
  }

  const assetIds = new Set(doc.assets.map((a) => a.id))
  const relSeen = new Set<string>()
  for (const r of Array.isArray(raw.relations) ? raw.relations : []) {
    const fromId = str(r?.fromId)
    const toId = str(r?.toId)
    if (!assetIds.has(fromId) || !assetIds.has(toId) || fromId === toId) continue
    const kind = (RELATION_KIND_IDS as string[]).includes(str(r.kind)) ? (str(r.kind) as CmdbRelationKind) : 'physical'
    const key = `${fromId}|${toId}|${kind}`
    if (relSeen.has(key)) continue
    relSeen.add(key)
    doc.relations.push({
      id: str(r.id) || uid('rl'),
      fromId,
      toId,
      kind,
      label: str(r.label, 60) || undefined,
      directed: r.directed === undefined ? true : !!r.directed,
      note: str(r.note, 500) || undefined,
      createdAt: num(r.createdAt) || Date.now()
    })
  }

  // 网线：端点必须是**活着**的设备，端口缺省填 nic-1（老数据/手写导入常见）
  const cableSeen = new Set<string>()
  for (const c of Array.isArray(raw.cables) ? raw.cables : []) {
    const fromId = str(c?.fromId)
    const toId = str(c?.toId)
    if (!assetIds.has(fromId) || !assetIds.has(toId) || fromId === toId) continue
    const fromPort = str(c.fromPort, 40) || 'nic-1'
    const toPort = str(c.toPort, 40) || 'nic-1'
    const key = `${fromId}|${fromPort}|${toId}|${toPort}`
    if (cableSeen.has(key)) continue
    cableSeen.add(key)
    doc.cables.push({
      id: str(c.id) || uid('cb'),
      fromId,
      fromPort,
      toId,
      toPort,
      net: (NET_KIND_IDS as string[]).includes(str(c.net)) ? (str(c.net) as CmdbNetKind) : 'biz',
      label: str(c.label, 60) || undefined,
      note: str(c.note, 300) || undefined,
      createdAt: num(c.createdAt) || Date.now()
    })
  }

  return doc
}

function plainMeta(v: any): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(v).slice(0, 40)) {
    const val = v[k]
    if (val === null || val === undefined) continue
    if (typeof val === 'object') continue
    out[str(k, 60)] = str(val, 400)
  }
  return out
}

export function normalizeView(raw: any): CmdbViewDoc {
  const v = emptyView()
  if (!raw || typeof raw !== 'object') return v
  const positions: Record<string, Vec3> = {}
  const src = raw.positions && typeof raw.positions === 'object' ? raw.positions : {}
  for (const id of Object.keys(src).slice(0, 20000)) {
    const p = src[id]
    const x = num(p?.x)
    const y = num(p?.y)
    const z = num(p?.z)
    if (x === undefined || y === undefined || z === undefined) continue
    positions[id] = { x, y, z }
  }
  const cam = raw.camera && typeof raw.camera === 'object' ? raw.camera : {}
  return {
    version: 1,
    positions,
    camera: {
      yaw: num(cam.yaw) ?? v.camera.yaw,
      pitch: num(cam.pitch) ?? v.camera.pitch,
      dist: Math.min(20000, Math.max(200, num(cam.dist) ?? v.camera.dist)),
      tx: num(cam.tx) ?? 0,
      ty: num(cam.ty) ?? 0,
      tz: num(cam.tz) ?? 0
    },
    mode: (['table', 'room', '3d', '2d', 'rack'] as string[]).includes(str(raw.mode)) ? (str(raw.mode) as CmdbViewMode) : 'room',
    hiddenKinds: Array.isArray(raw.hiddenKinds)
      ? raw.hiddenKinds.filter((k: any) => (RELATION_KIND_IDS as string[]).includes(str(k))) as CmdbRelationKind[]
      : [],
    roomId: str(raw.roomId, 60) || ''
  }
}

// ---------------------------------------------------------------- 校验

export interface CmdbResult<T = void> {
  ok: boolean
  error?: string
  value?: T
}

export function validateCustomer(c: Partial<CmdbCustomer>, doc: CmdbDoc): CmdbResult {
  const name = str(c.name, 120).trim()
  if (!name) return { ok: false, error: '客户名称不能为空' }
  const dup = doc.customers.find((x) => x.name === name && x.id !== c.id)
  if (dup) return { ok: false, error: `已存在同名客户「${name}」` }
  return { ok: true }
}

export function validateIdc(d: Partial<CmdbIdc>, doc: CmdbDoc): CmdbResult {
  const name = str(d.name, 120).trim()
  if (!name) return { ok: false, error: '机房名称不能为空' }
  const dup = doc.idcs.find((x) => x.name === name && x.id !== d.id)
  if (dup) return { ok: false, error: `已存在同名机房「${name}」` }
  return { ok: true }
}

export function validateRack(r: Partial<CmdbRack>, doc: CmdbDoc): CmdbResult {
  if (!str(r.code, 80).trim()) return { ok: false, error: '机柜编号不能为空' }
  if (!doc.idcs.some((d) => d.id === r.idcId)) return { ok: false, error: '机柜必须属于一个机房' }
  const dup = doc.racks.find((x) => x.idcId === r.idcId && x.code === str(r.code).trim() && x.id !== r.id)
  if (dup) return { ok: false, error: '该机房下已有同名机柜' }
  return { ok: true }
}

export function validateAsset(a: Partial<CmdbAsset>, doc: CmdbDoc): CmdbResult {
  const name = str(a.name, 160).trim()
  if (!name) return { ok: false, error: '资产名称不能为空' }
  if (!str(a.customerId)) return { ok: false, error: '资产必须归属一个客户' }
  if (!doc.customers.some((c) => c.id === a.customerId)) return { ok: false, error: '所选客户不存在' }
  if (!ASSET_TYPE_IDS.includes(str(a.type))) return { ok: false, error: '资产类型不合法' }
  if (a.idcId && !doc.idcs.some((d) => d.id === a.idcId)) return { ok: false, error: '所选机房不存在' }
  if (a.rackId) {
    const rack = doc.racks.find((r) => r.id === a.rackId)
    if (!rack) return { ok: false, error: '所选机柜不存在' }
    if (a.idcId && rack.idcId !== a.idcId) return { ok: false, error: '机柜与机房不匹配' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------- 增删改

export function upsertCustomer(doc: CmdbDoc, input: Partial<CmdbCustomer>): CmdbResult<CmdbCustomer> {
  const v = validateCustomer(input, doc)
  if (!v.ok) return { ok: false, error: v.error }
  const now = Date.now()
  const old = input.id ? doc.customers.find((c) => c.id === input.id) : undefined
  if (old) {
    Object.assign(old, {
      name: str(input.name).trim(),
      code: str(input.code) || undefined,
      color: str(input.color) || undefined,
      contact: str(input.contact) || undefined,
      note: str(input.note) || undefined,
      updatedAt: now
    })
    return { ok: true, value: old }
  }
  const c: CmdbCustomer = {
    id: uid('cu'),
    name: str(input.name).trim(),
    code: str(input.code) || undefined,
    color: str(input.color) || undefined,
    contact: str(input.contact) || undefined,
    note: str(input.note) || undefined,
    createdAt: now,
    updatedAt: now
  }
  doc.customers.push(c)
  return { ok: true, value: c }
}

/** 删客户：资产不级联删（客户撤场不等于资产记录没价值），改为置空归属，由界面显示「未归属」 */
export function deleteCustomer(doc: CmdbDoc, id: string): number {
  const idx = doc.customers.findIndex((c) => c.id === id)
  if (idx < 0) return 0
  doc.customers.splice(idx, 1)
  let touched = 0
  for (const a of doc.assets) {
    if (a.customerId === id) {
      a.customerId = ''
      a.updatedAt = Date.now()
      touched++
    }
  }
  return touched
}

export function upsertIdc(doc: CmdbDoc, input: Partial<CmdbIdc>): CmdbResult<CmdbIdc> {
  const v = validateIdc(input, doc)
  if (!v.ok) return { ok: false, error: v.error }
  const now = Date.now()
  const geo = {
    cols: clampInt(num(input.cols), 4, 40, 8),
    rows: clampInt(num(input.rows), 4, 40, 6),
    tileMm: clampInt(num(input.tileMm), 300, 1200, 600)
  }
  const old = input.id ? doc.idcs.find((d) => d.id === input.id) : undefined
  if (old) {
    Object.assign(old, {
      name: str(input.name).trim(),
      region: str(input.region) || undefined,
      address: str(input.address) || undefined,
      room: str(input.room) || undefined,
      ...geo,
      note: str(input.note) || undefined,
      updatedAt: now
    })
    return { ok: true, value: old }
  }
  const d: CmdbIdc = {
    id: uid('idc'),
    name: str(input.name).trim(),
    region: str(input.region) || undefined,
    address: str(input.address) || undefined,
    room: str(input.room) || undefined,
    ...geo,
    note: str(input.note) || undefined,
    createdAt: now,
    updatedAt: now
  }
  doc.idcs.push(d)
  return { ok: true, value: d }
}

/** 删机房：连带删机柜，资产保留记录但清空机房/机柜（资产是账，位置是属性） */
export function deleteIdc(doc: CmdbDoc, id: string): { racks: number; assets: number } {
  const idx = doc.idcs.findIndex((d) => d.id === id)
  if (idx < 0) return { racks: 0, assets: 0 }
  doc.idcs.splice(idx, 1)
  const rackIds = new Set(doc.racks.filter((r) => r.idcId === id).map((r) => r.id))
  doc.racks = doc.racks.filter((r) => !rackIds.has(r.id))
  let assets = 0
  for (const a of doc.assets) {
    if (a.idcId !== id && !rackIds.has(a.rackId || '')) continue
    a.idcId = undefined
    a.rackId = undefined
    a.u = undefined
    a.updatedAt = Date.now()
    assets++
  }
  return { racks: rackIds.size, assets }
}

export function upsertRack(doc: CmdbDoc, input: Partial<CmdbRack>): CmdbResult<CmdbRack> {
  const v = validateRack(input, doc)
  if (!v.ok) return { ok: false, error: v.error }
  const now = Date.now()
  const total = num(input.uTotal) && num(input.uTotal)! > 0 ? Math.min(120, Math.floor(num(input.uTotal)!)) : 42
  const geo = {
    gridCol: num(input.gridCol) !== undefined ? clampInt(num(input.gridCol), 0, 39, 0) : undefined,
    gridRow: num(input.gridRow) !== undefined ? clampInt(num(input.gridRow), 0, 39, 0) : undefined,
    widthMm: clampInt(num(input.widthMm), 300, 900, 600),
    depthMm: clampInt(num(input.depthMm), 300, 1400, 1200),
    powerKw: num(input.powerKw) !== undefined ? Math.max(0, Math.min(100, num(input.powerKw)!)) : undefined
  }
  const old = input.id ? doc.racks.find((r) => r.id === input.id) : undefined
  if (old) {
    Object.assign(old, {
      code: str(input.code).trim(),
      idcId: str(input.idcId),
      uTotal: total,
      row: str(input.row) || undefined,
      ...geo,
      note: str(input.note) || undefined,
      updatedAt: now
    })
    return { ok: true, value: old }
  }
  const r: CmdbRack = {
    id: uid('rk'),
    idcId: str(input.idcId),
    code: str(input.code).trim(),
    uTotal: total,
    row: str(input.row) || undefined,
    ...geo,
    note: str(input.note) || undefined,
    createdAt: now,
    updatedAt: now
  }
  doc.racks.push(r)
  return { ok: true, value: r }
}

export function deleteRack(doc: CmdbDoc, id: string): number {
  const idx = doc.racks.findIndex((r) => r.id === id)
  if (idx < 0) return 0
  doc.racks.splice(idx, 1)
  let n = 0
  for (const a of doc.assets) {
    if (a.rackId !== id) continue
    a.rackId = undefined
    a.u = undefined
    a.updatedAt = Date.now()
    n++
  }
  return n
}

export function upsertAsset(doc: CmdbDoc, input: Partial<CmdbAsset>): CmdbResult<CmdbAsset> {
  const v = validateAsset(input, doc)
  if (!v.ok) return { ok: false, error: v.error }
  const now = Date.now()
  const old = input.id ? doc.assets.find((a) => a.id === input.id) : undefined
  const spec = SPEC_IDS.includes(str(input.spec)) ? str(input.spec) : undefined
  const uHeight = num(input.uHeight) && num(input.uHeight)! > 0
    ? Math.min(20, Math.floor(num(input.uHeight)!))
    : specOf(spec)?.u || undefined
  const base = {
    customerId: str(input.customerId),
    idcId: str(input.idcId) || undefined,
    rackId: str(input.rackId) || undefined,
    u: num(input.u) && num(input.u)! > 0 ? Math.floor(num(input.u)!) : undefined,
    uHeight,
    spec,
    floorCol: num(input.floorCol) !== undefined ? clampInt(num(input.floorCol), 0, 39, 0) : undefined,
    floorRow: num(input.floorRow) !== undefined ? clampInt(num(input.floorRow), 0, 39, 0) : undefined,
    role: ROLES.some((r) => r.id === str(input.role)) ? str(input.role) : undefined,
    arch: archOf(str(input.arch)) ? str(input.arch) : undefined,
    archGroup: str(input.archGroup, 80) || undefined,
    type: str(input.type),
    name: str(input.name).trim(),
    hostname: str(input.hostname) || undefined,
    sn: str(input.sn) || undefined,
    vendor: str(input.vendor) || undefined,
    model: str(input.model) || undefined,
    ips: strArr(input.ips).slice(0, 16),
    os: str(input.os) || undefined,
    status: ((STATUS_IDS as string[]).includes(str(input.status)) ? str(input.status) : 'running') as CmdbStatus,
    owner: str(input.owner) || undefined,
    tags: strArr(input.tags).slice(0, 24),
    note: str(input.note, 2000) || undefined,
    meta: input.meta && typeof input.meta === 'object' ? plainMeta(input.meta) : {},
    linkServerId: str(input.linkServerId) || undefined,
    linkConnId: str(input.linkConnId) || undefined,
    cloudRef: str(input.cloudRef) || undefined,
    alarmLevel: num(input.alarmLevel) || undefined
  }
  if (old) {
    Object.assign(old, base, { updatedAt: now })
    return { ok: true, value: old }
  }
  const a: CmdbAsset = { id: uid('as'), ...base, createdAt: now, updatedAt: now }
  doc.assets.push(a)
  return { ok: true, value: a }
}

/** 软删：保留关系边，回收站恢复时关系自动回来。图投影会过滤掉已删节点。 */
export function softDeleteAsset(doc: CmdbDoc, id: string): boolean {
  const a = doc.assets.find((x) => x.id === id)
  if (!a || a.deletedAt) return false
  a.deletedAt = Date.now()
  a.updatedAt = a.deletedAt
  return true
}

export function restoreAsset(doc: CmdbDoc, id: string): boolean {
  const a = doc.assets.find((x) => x.id === id)
  if (!a || !a.deletedAt) return false
  delete a.deletedAt
  a.updatedAt = Date.now()
  // 客户/机房可能在软删期间被删掉了，恢复时把悬空归属清掉，别留下看不见的外键
  if (a.customerId && !doc.customers.some((c) => c.id === a.customerId)) a.customerId = ''
  if (a.idcId && !doc.idcs.some((d) => d.id === a.idcId)) { a.idcId = undefined; a.rackId = undefined }
  if (a.rackId && !doc.racks.some((r) => r.id === a.rackId)) { a.rackId = undefined; a.u = undefined }
  return true
}

/** 彻底删除：连带删掉所有相关关系与网线（否则图里会出现指向虚空的边） */
export function purgeAsset(doc: CmdbDoc, id: string): number {
  const idx = doc.assets.findIndex((a) => a.id === id)
  if (idx < 0) return 0
  doc.assets.splice(idx, 1)
  const before = doc.relations.length
  doc.relations = doc.relations.filter((r) => r.fromId !== id && r.toId !== id)
  doc.cables = doc.cables.filter((c) => c.fromId !== id && c.toId !== id)
  return before - doc.relations.length
}

export function upsertRelation(doc: CmdbDoc, input: Partial<CmdbRelation>): CmdbResult<CmdbRelation> {
  const fromId = str(input.fromId)
  const toId = str(input.toId)
  const kind = ((RELATION_KIND_IDS as string[]).includes(str(input.kind)) ? str(input.kind) : 'physical') as CmdbRelationKind
  if (!fromId || !toId) return { ok: false, error: '关系两端都要有资产' }
  if (fromId === toId) return { ok: false, error: '资产不能与自己建立关系' }
  const live = (id: string): boolean => doc.assets.some((a) => a.id === id && !a.deletedAt)
  if (!live(fromId) || !live(toId)) return { ok: false, error: '关系端点不存在或已删除' }
  const dup = doc.relations.find((r) => r.fromId === fromId && r.toId === toId && r.kind === kind)
  if (dup) {
    // 同向同类型再连一次 = 更新标签，不新增（拖拽重复连线时不能把图弄乱）
    dup.label = str(input.label, 60) || dup.label
    dup.note = str(input.note, 500) || dup.note
    return { ok: true, value: dup }
  }
  const r: CmdbRelation = {
    id: uid('rl'),
    fromId,
    toId,
    kind,
    label: str(input.label, 60) || undefined,
    directed: input.directed === undefined ? true : !!input.directed,
    note: str(input.note, 500) || undefined,
    createdAt: Date.now()
  }
  doc.relations.push(r)
  return { ok: true, value: r }
}

export function deleteRelation(doc: CmdbDoc, id: string): boolean {
  const before = doc.relations.length
  doc.relations = doc.relations.filter((r) => r.id !== id)
  return doc.relations.length !== before
}

// ---------------------------------------------------------------- 网线（物理链路）

/** 一条网线两端必须是活着、且不是同一台设备；端口 id 不校验存在性（换规格后老线不该消失，
 *  渲染层找不到端口时会落到默认锚点，用户还能看见这条线并改掉）。 */
export function upsertCable(doc: CmdbDoc, input: Partial<CmdbCable>): CmdbResult<CmdbCable> {
  const fromId = str(input.fromId)
  const toId = str(input.toId)
  if (!fromId || !toId) return { ok: false, error: '网线两端都要有设备' }
  if (fromId === toId) return { ok: false, error: '设备不能连自己' }
  const live = (id: string): boolean => doc.assets.some((a) => a.id === id && !a.deletedAt)
  if (!live(fromId) || !live(toId)) return { ok: false, error: '网线端点不存在或已删除' }
  const fromPort = str(input.fromPort, 40) || 'nic-1'
  const toPort = str(input.toPort, 40) || 'nic-1'
  const net = ((NET_KIND_IDS as string[]).includes(str(input.net)) ? str(input.net) : 'biz') as CmdbNetKind

  // 同一对端口再连一次 = 改属性，不新增（拖拽重复接线不能把视图弄乱）
  const dup = doc.cables.find(
    (c) => (c.fromId === fromId && c.fromPort === fromPort && c.toId === toId && c.toPort === toPort) ||
      (c.fromId === toId && c.fromPort === toPort && c.toId === fromId && c.toPort === fromPort)
  )
  if (dup) {
    dup.net = net
    dup.label = str(input.label, 60) || dup.label
    dup.note = str(input.note, 300) || dup.note
    return { ok: true, value: dup }
  }
  // 一个物理端口只能插一根线：占用同一端口的旧线自动让位（先拔后插，符合现场）
  doc.cables = doc.cables.filter((c) => {
    const a = `${c.fromId}|${c.fromPort}`
    const b = `${c.toId}|${c.toPort}`
    return !(a === `${fromId}|${fromPort}` || b === `${fromId}|${fromPort}` || a === `${toId}|${toPort}` || b === `${toId}|${toPort}`)
  })

  const c: CmdbCable = {
    id: uid('cb'),
    fromId,
    fromPort,
    toId,
    toPort,
    net,
    label: str(input.label, 60) || undefined,
    note: str(input.note, 300) || undefined,
    createdAt: Date.now()
  }
  doc.cables.push(c)
  return { ok: true, value: c }
}

export function deleteCable(doc: CmdbDoc, id: string): boolean {
  const before = doc.cables.length
  doc.cables = doc.cables.filter((c) => c.id !== id)
  return doc.cables.length !== before
}

/** 某设备参与的所有网线（含对端端口），点设备时列"它连了谁" */
export function cablesOf(doc: CmdbDoc, assetId: string): (CmdbCable & { toName: string; toType: string; dir: 'out' | 'in' })[] {
  const nameOf = new Map(doc.assets.map((a) => [a.id, a]))
  const out: any[] = []
  for (const c of doc.cables) {
    if (c.fromId !== assetId && c.toId !== assetId) continue
    const other = nameOf.get(c.fromId === assetId ? c.toId : c.fromId)
    out.push({ ...c, toName: other?.name || '(已删除)', toType: other?.type || 'other-hw', dir: c.fromId === assetId ? 'out' : 'in' })
  }
  return out
}

// ---------------------------------------------------------------- 图投影

export interface CmdbFilter {
  customerId?: string
  idcId?: string
  /** 资产类型，逗号分隔多选；空 = 全部 */
  types?: string[]
  q?: string
  /** 不含已下线（默认 true：下线资产默认不进图，台账里仍可查） */
  hideRetired?: boolean
  /** 是否包含软删的（回收站视图用） */
  includeDeleted?: boolean
}

export interface CmdbNode {
  id: string
  name: string
  type: string
  kind: CmdbAssetKind
  status: CmdbStatus
  customerId: string
  idcId: string
  rackId: string
  u: number
  alarmLevel: number
  degree: number
}

export interface CmdbEdge {
  id: string
  from: string
  to: string
  kind: CmdbRelationKind
  label: string
}

export interface CmdbGraph {
  nodes: CmdbNode[]
  edges: CmdbEdge[]
  /** 被筛选掉的资产数（界面提示"还有 N 个不满足筛选"） */
  hidden: number
}

export function matchAsset(a: CmdbAsset, f: CmdbFilter): boolean {
  if (a.customerId && f.customerId && a.customerId !== f.customerId) return false
  if (f.customerId === '__none__' && a.customerId) return false
  if (f.idcId && a.idcId !== f.idcId) return false
  if (f.idcId === '__none__' && a.idcId) return false
  if (f.types && f.types.length && !f.types.includes(a.type)) return false
  if (f.hideRetired !== false && a.status === 'retired') return false
  const q = (f.q || '').trim().toLowerCase()
  if (q) {
    // 搜索覆盖类型（id 与中文名都算）：DBA 常按"交换机""数据库实例"找东西
    const t = assetTypeOf(a.type)
    const hay = [a.name, a.hostname, a.sn, a.vendor, a.model, a.os, a.owner, a.type, t.name, ...(a.ips || []), ...(a.tags || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

/** 图投影：一次算完节点+边+度数。3D 画布只吃这个结果，不碰整份台账。 */
export function graphOf(doc: CmdbDoc, f: CmdbFilter = {}): CmdbGraph {
  const visible = doc.assets.filter((a) => (f.includeDeleted ? true : !a.deletedAt))
  const matched = visible.filter((a) => matchAsset(a, f))
  const ids = new Set(matched.map((a) => a.id))
  const degree = new Map<string, number>()
  const edges: CmdbEdge[] = []
  for (const r of doc.relations) {
    if (!ids.has(r.fromId) || !ids.has(r.toId)) continue
    if (f.includeDeleted === undefined) {
      const from = doc.assets.find((a) => a.id === r.fromId)
      const to = doc.assets.find((a) => a.id === r.toId)
      if (from?.deletedAt || to?.deletedAt) continue
    }
    edges.push({ id: r.id, from: r.fromId, to: r.toId, kind: r.kind, label: r.label || '' })
    degree.set(r.fromId, (degree.get(r.fromId) || 0) + 1)
    degree.set(r.toId, (degree.get(r.toId) || 0) + 1)
  }
  const nodes: CmdbNode[] = matched.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    kind: assetTypeOf(a.type).kind,
    status: a.status,
    customerId: a.customerId,
    idcId: a.idcId || '',
    rackId: a.rackId || '',
    u: a.u || 0,
    alarmLevel: a.alarmLevel || 0,
    degree: degree.get(a.id) || 0
  }))
  return { nodes, edges, hidden: visible.length - matched.length }
}

export interface CmdbStats {
  customers: number
  idcs: number
  racks: number
  assets: number
  relations: number
  deleted: number
  orphans: number
  byType: Record<string, number>
  byStatus: Record<string, number>
}

export function statsOf(doc: CmdbDoc): CmdbStats {
  const byType: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  let assets = 0
  let deleted = 0
  let orphans = 0
  for (const a of doc.assets) {
    if (a.deletedAt) { deleted++; continue }
    assets++
    byType[a.type] = (byType[a.type] || 0) + 1
    byStatus[a.status] = (byStatus[a.status] || 0) + 1
    const linked = doc.relations.some((r) => r.fromId === a.id || r.toId === a.id)
    if (!linked) orphans++
  }
  return {
    customers: doc.customers.length,
    idcs: doc.idcs.length,
    racks: doc.racks.length,
    assets,
    relations: doc.relations.length,
    deleted,
    orphans,
    byType,
    byStatus
  }
}

/** 括号里的资产树：客户 → 机房 → 机柜。只做分桶，不做过滤（过滤交给 graphOf/台账） */
export interface CmdbTreeBucket {
  id: string
  name: string
  count: number
  children: CmdbTreeBucket[]
}

export function treeOf(doc: CmdbDoc, includeDeleted = false): CmdbTreeBucket[] {
  const live = doc.assets.filter((a) => (includeDeleted ? true : !a.deletedAt))
  const out: CmdbTreeBucket[] = []
  for (const c of doc.customers) {
    const mine = live.filter((a) => a.customerId === c.id)
    const idcBuckets: CmdbTreeBucket[] = []
    for (const d of doc.idcs) {
      // 机房是跨客户的独立维度，但**在某个客户的树下**只展示这个客户真正放了东西的机房。
      // 否则「客户A → 北京机房 → 0 台」点进去是一片空白，用户会以为筛选坏了。
      const inIdc = mine.filter((a) => a.idcId === d.id)
      if (!inIdc.length) continue
      const rackBuckets = doc.racks
        .filter((r) => r.idcId === d.id)
        .map((r) => ({
          id: r.id,
          name: `机柜 ${r.code}`,
          count: inIdc.filter((a) => a.rackId === r.id).length,
          children: []
        }))
      const loose = inIdc.filter((a) => !a.rackId).length
      if (loose) rackBuckets.push({ id: `${d.id}::loose`, name: '未上架', count: loose, children: [] })
      idcBuckets.push({ id: d.id, name: d.name, count: inIdc.length, children: rackBuckets })
    }
    const noIdc = mine.filter((a) => !a.idcId).length
    if (noIdc) idcBuckets.push({ id: `${c.id}::noidc`, name: '未指定机房', count: noIdc, children: [] })
    out.push({ id: c.id, name: c.name, count: mine.length, children: idcBuckets })
  }
  const homeless = live.filter((a) => !a.customerId).length
  if (homeless) out.push({ id: '__none__', name: '未归属客户', count: homeless, children: [] })
  return out
}

// ---------------------------------------------------------------- 纳管（同步草稿）

export interface SyncItem {
  /** 去重键：云的 `<platformId>:<hostId>`，服务器的 `server:<id>` */
  key: string
  name: string
  ip?: string
  os?: string
  status?: string
  meta?: Record<string, string>
  linkServerId?: string
  cloudRef?: string
}

export interface SyncPlan {
  creates: Partial<CmdbAsset>[]
  skipped: number
  /** 已存在但可更新（云上 os/状态变了）的条数 */
  updates: { id: string; patch: Partial<CmdbAsset> }[]
}

/** 纳管计划：只增不改人工字段。已存在（同 linkServerId / cloudRef / 同 IP）的资产最多补 os、状态、告警，
 *  绝不覆盖 name/vendor/note 这些人工录入的字段。 */
export function planSync(doc: CmdbDoc, items: SyncItem[], opts: { customerId: string; idcId?: string }): SyncPlan {
  const plan: SyncPlan = { creates: [], skipped: 0, updates: [] }
  const byKey = new Map<string, CmdbAsset>()
  for (const a of doc.assets) {
    if (a.deletedAt) continue
    if (a.linkServerId) byKey.set(`server:${a.linkServerId}`, a)
    if (a.cloudRef) byKey.set(a.cloudRef, a)
    for (const ip of a.ips) byKey.set(`ip:${ip}`, a)
  }
  const seen = new Set<string>()
  for (const it of items) {
    const keys = [it.key, it.cloudRef ? it.cloudRef : '', it.linkServerId ? `server:${it.linkServerId}` : '', it.ip ? `ip:${it.ip}` : ''].filter(Boolean)
    const hit = keys.map((k) => byKey.get(k)).find(Boolean)
    if (hit) {
      // 同一台机器在 hosts 里可能出现在多个集群，别重复计入
      if (seen.has(hit.id)) { plan.skipped++; continue }
      seen.add(hit.id)
      const patch: Partial<CmdbAsset> = {}
      if (it.os && hit.os !== it.os) patch.os = it.os
      const st = statusFromCloud(it.status)
      if (st && hit.status !== st) patch.status = st
      if (Object.keys(patch).length) plan.updates.push({ id: hit.id, patch })
      else plan.skipped++
      continue
    }
    const key = it.key
    if (seen.has(key)) { plan.skipped++; continue }
    seen.add(key)
    plan.creates.push({
      customerId: opts.customerId,
      idcId: opts.idcId,
      type: 'server',
      name: it.name || it.ip || '未命名主机',
      hostname: it.name,
      ips: it.ip ? [it.ip] : [],
      os: it.os,
      status: statusFromCloud(it.status) || 'running',
      meta: it.meta || {},
      linkServerId: it.linkServerId,
      cloudRef: it.cloudRef,
      tags: []
    })
  }
  return plan
}

function statusFromCloud(s?: string): CmdbStatus | undefined {
  if (!s) return undefined
  const v = s.toUpperCase()
  if (v.includes('ONLINE') || v.includes('RUNNING') || v.includes('ACTIVE') || v.includes('CONNECTED')) return 'running'
  if (v.includes('OFFLINE') || v.includes('STOP') || v.includes('INACTIVE') || v.includes('DOWN')) return 'stopped'
  if (v.includes('MAINTEN') || v.includes('UPGRAD')) return 'maintenance'
  return undefined
}

// ---------------------------------------------------------------- CSV

const CSV_COLUMNS = [
  '客户', '机房', '机柜', 'U位', '类型', '名称', '主机名', 'IP', '序列号', '厂商', '型号', 'OS', '状态', '负责人', '标签', '备注'
]

export function buildAssetCsv(doc: CmdbDoc, assets: CmdbAsset[]): string {
  const cell = (v: unknown): string => {
    const s = v === undefined || v === null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const cust = new Map(doc.customers.map((c) => [c.id, c.name]))
  const idc = new Map(doc.idcs.map((d) => [d.id, d.name]))
  const rack = new Map(doc.racks.map((r) => [r.id, r.code]))
  const typeName = new Map(ASSET_TYPES.map((t) => [t.id, t.name]))
  const statusName = new Map(STATUSES.map((s) => [s.id, s.name]))
  const lines = [CSV_COLUMNS.join(',')]
  for (const a of assets) {
    lines.push(
      [
        cust.get(a.customerId) || '',
        idc.get(a.idcId || '') || '',
        rack.get(a.rackId || '') || '',
        a.u || '',
        typeName.get(a.type) || a.type,
        a.name,
        a.hostname || '',
        (a.ips || []).join(' '),
        a.sn || '',
        a.vendor || '',
        a.model || '',
        a.os || '',
        statusName.get(a.status) || a.status,
        a.owner || '',
        (a.tags || []).join(' '),
        a.note || ''
      ].map(cell).join(',')
    )
  }
  return lines.join('\r\n')
}

/** 极简 CSV 解析：支持双引号包裹与转义引号，够导入台账用（不做类型推断） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(cell); cell = ''; continue }
    if (ch === '\r') continue
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue }
    cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim()))
}

/** 导入台账：按表头映射，客户/机房/机柜不存在时自动建（导入最怕"少一个客户就整批失败"） */
export function importAssetCsv(doc: CmdbDoc, text: string): { created: number; skipped: number; errors: string[] } {
  const rows = parseCsv(text)
  const out = { created: 0, skipped: 0, errors: [] as string[] }
  if (!rows.length) return out
  const head = rows[0].map((h) => h.trim())
  const col = (name: string): number => head.indexOf(name)
  const idx = {
    customer: col('客户'), idc: col('机房'), rack: col('机柜'), u: col('U位'), type: col('类型'),
    name: col('名称'), hostname: col('主机名'), ip: col('IP'), sn: col('序列号'), vendor: col('厂商'),
    model: col('型号'), os: col('OS'), status: col('状态'), owner: col('负责人'), tags: col('标签'), note: col('备注')
  }
  if (idx.name < 0) { out.errors.push('表头缺少「名称」列'); return out }

  const get = (r: string[], i: number): string => (i >= 0 ? (r[i] || '').trim() : '')
  const typeByName = new Map(ASSET_TYPES.map((t) => [t.name, t.id]))
  const statusByName = new Map(STATUSES.map((s) => [s.name, s.id]))

  const ensureCustomer = (name: string): string => {
    if (!name) return doc.customers[0]?.id || ''
    const hit = doc.customers.find((c) => c.name === name)
    if (hit) return hit.id
    const c: CmdbCustomer = { id: uid('cu'), name, createdAt: Date.now(), updatedAt: Date.now() }
    doc.customers.push(c)
    return c.id
  }
  const ensureIdc = (name: string): string | undefined => {
    if (!name) return undefined
    const hit = doc.idcs.find((d) => d.name === name)
    if (hit) return hit.id
    const d: CmdbIdc = { id: uid('idc'), name, createdAt: Date.now(), updatedAt: Date.now() }
    doc.idcs.push(d)
    return d.id
  }
  const ensureRack = (idcId: string | undefined, code: string): string | undefined => {
    if (!idcId || !code) return undefined
    const hit = doc.racks.find((r) => r.idcId === idcId && r.code === code)
    if (hit) return hit.id
    const r: CmdbRack = { id: uid('rk'), idcId, code, uTotal: 42, createdAt: Date.now(), updatedAt: Date.now() }
    doc.racks.push(r)
    return r.id
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const name = get(r, idx.name)
    if (!name) { out.skipped++; continue }
    const customerId = ensureCustomer(get(r, idx.customer))
    if (!customerId) { out.errors.push(`第 ${i + 1} 行：没有可用客户，已跳过`); out.skipped++; continue }
    const idcId = ensureIdc(get(r, idx.idc))
    const rackId = ensureRack(idcId, get(r, idx.rack))
    const typeRaw = get(r, idx.type)
    const type = ASSET_TYPE_IDS.includes(typeRaw) ? typeRaw : typeByName.get(typeRaw) || 'server'
    const statusRaw = get(r, idx.status)
    const status = ((STATUS_IDS as string[]).includes(statusRaw) ? statusRaw : statusByName.get(statusRaw) || 'running') as CmdbStatus
    const res = upsertAsset(doc, {
      customerId,
      idcId,
      rackId,
      u: Number(get(r, idx.u)) || undefined,
      type,
      name,
      hostname: get(r, idx.hostname) || undefined,
      ips: get(r, idx.ip) ? get(r, idx.ip).split(/[\s,，;；]+/).filter(Boolean) : [],
      sn: get(r, idx.sn) || undefined,
      vendor: get(r, idx.vendor) || undefined,
      model: get(r, idx.model) || undefined,
      os: get(r, idx.os) || undefined,
      status,
      owner: get(r, idx.owner) || undefined,
      tags: get(r, idx.tags) ? get(r, idx.tags).split(/[\s,，;；]+/).filter(Boolean) : [],
      note: get(r, idx.note) || undefined
    })
    if (res.ok) out.created++
    else { out.errors.push(`第 ${i + 1} 行：${res.error}`); out.skipped++ }
  }
  return out
}

/** 资产 → 给 AI 的上下文文本（脱敏由调用方负责：这里只做结构化摘要） */
export function assetContextText(doc: CmdbDoc, id: string, limit = 40): string {
  const a = doc.assets.find((x) => x.id === id)
  if (!a) return ''
  const cust = doc.customers.find((c) => c.id === a.customerId)?.name || '未归属'
  const idc = doc.idcs.find((d) => d.id === a.idcId)?.name || '未指定机房'
  const rack = doc.racks.find((r) => r.id === a.rackId)?.code || ''
  const t = assetTypeOf(a.type)
  const st = STATUSES.find((s) => s.id === a.status)?.name || a.status
  const lines = [
    `# 资产：${a.name}`,
    `- 类型：${t.name}（${t.kind}）｜状态：${st}`,
    `- 归属：客户 ${cust} ｜ 机房 ${idc}${rack ? ` ｜ 机柜 ${rack}${a.u ? ` U${a.u}` : ''}` : ''}`,
    `- IP：${(a.ips || []).join(', ') || '—'} ｜ 主机名：${a.hostname || '—'}`,
    `- 厂商型号：${[a.vendor, a.model].filter(Boolean).join(' ') || '—'} ｜ OS：${a.os || '—'}`
  ]
  if (a.note) lines.push(`- 备注：${a.note}`)
  const rels = doc.relations.filter((r) => r.fromId === id || r.toId === id).slice(0, limit)
  if (rels.length) {
    lines.push('', '## 关系')
    for (const r of rels) {
      const other = doc.assets.find((x) => x.id === (r.fromId === id ? r.toId : r.fromId))
      const dir = r.fromId === id ? '→' : '←'
      const kind = RELATION_KINDS.find((k) => k.id === r.kind)?.name || r.kind
      lines.push(`- ${dir} ${kind}${r.label ? `(${r.label})` : ''} ${other?.name || '(已删除)'} [${other ? assetTypeOf(other.type).name : ''}]`)
    }
  }
  return lines.join('\n')
}
