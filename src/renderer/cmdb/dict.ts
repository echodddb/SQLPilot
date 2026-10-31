/** CMDB 界面词典：类型/状态/关系的展示层。语义枚举的**唯一源**在 main/cmdb-model.ts，
 *  这里只补颜色、形状、短名，不重复定义 id 列表（避免两处漂移）。 */
import {
  ASSET_TYPES, RELATION_KINDS, RELATION_LABELS, STATUSES, NETWORKS, ROLES, ARCHS,
  SPECS, specOf, archOf, assetTypeOf, netOf
} from '../../main/cmdb-model'

export {
  ASSET_TYPES, RELATION_KINDS, RELATION_LABELS, STATUSES, NETWORKS, ROLES, ARCHS,
  SPECS, specOf, archOf, assetTypeOf, netOf
}

/** 按"资产大类"着色：16 种类型各配一个颜色会糊成调色盘，类型靠字形区分、大类靠颜色区分 */
export const KIND_COLOR: Record<string, string> = {
  hardware: '#0284c7',
  software: '#7c3aed',
  logical: '#0d9488'
}

export const KIND_COLOR_DARK: Record<string, string> = {
  hardware: '#38bdf8',
  software: '#a78bfa',
  logical: '#2dd4bf'
}

export const KIND_NAME: Record<string, string> = {
  hardware: '硬件',
  software: '软件',
  logical: '逻辑'
}

export const STATUS_COLOR: Record<string, string> = {
  running: '#059669',
  stopped: '#64748b',
  maintenance: '#d97706',
  planned: '#0284c7',
  retired: '#94a3b8'
}

export const STATUS_COLOR_DARK: Record<string, string> = {
  running: '#34d399',
  stopped: '#94a3b8',
  maintenance: '#fbbf24',
  planned: '#38bdf8',
  retired: '#64748b'
}

export const REL_COLOR: Record<string, string> = {
  physical: '#0284c7',
  hosting: '#7c3aed',
  dependency: '#d97706'
}

export const REL_COLOR_DARK: Record<string, string> = {
  physical: '#38bdf8',
  hosting: '#a78bfa',
  dependency: '#fbbf24'
}

export function kindColor(kind: string, dark: boolean): string {
  return (dark ? KIND_COLOR_DARK : KIND_COLOR)[kind] || (dark ? '#94a3b8' : '#64748b')
}

export function statusColor(status: string, dark: boolean): string {
  return (dark ? STATUS_COLOR_DARK : STATUS_COLOR)[status] || (dark ? '#94a3b8' : '#64748b')
}

export function relColor(kind: string, dark: boolean): string {
  return (dark ? REL_COLOR_DARK : REL_COLOR)[kind] || (dark ? '#94a3b8' : '#64748b')
}

export function statusName(id: string): string {
  return STATUSES.find((s) => s.id === id)?.name || id
}

export function relKindName(id: string): string {
  return RELATION_KINDS.find((r) => r.id === id)?.name || id
}

export function typeName(id: string): string {
  return assetTypeOf(id).name
}

export function typeGlyph(id: string): string {
  return assetTypeOf(id).glyph
}

/** 关系线型：物理实线 / 承载长虚线 / 依赖点线。颜色之外再给一层编码，
 *  亮色主题与色弱用户都能分辨。 */
export function relDash(kind: string): number[] {
  if (kind === 'hosting') return [7, 5]
  if (kind === 'dependency') return [2, 4]
  return []
}

// ---------------------------------------------------------------- 机房 3D 用色

/** 设备用途色：机柜里那台机器是"数据库"还是"应用"，靠前面板色带一眼区分 */
export const ROLE_COLOR: Record<string, string> = {
  db: '#dc2626',
  app: '#2563eb',
  web: '#0891b2',
  storage: '#059669',
  backup: '#7c3aed',
  network: '#ea580c',
  virt: '#c026d3',
  other: '#64748b'
}

export const ROLE_COLOR_DARK: Record<string, string> = {
  db: '#f87171',
  app: '#60a5fa',
  web: '#22d3ee',
  storage: '#34d399',
  backup: '#a78bfa',
  network: '#fb923c',
  virt: '#e879f9',
  other: '#94a3b8'
}

export function roleColor(role: string | undefined, dark: boolean): string {
  const map = dark ? ROLE_COLOR_DARK : ROLE_COLOR
  return map[role || 'other'] || map.other
}

/** 网络类型颜色（网线） */
export function netColor(id: string, dark: boolean): string {
  const n = netOf(id)
  return dark ? n.colorDark : n.color
}

/** 设备类型 -> 落地/上架的默认躯壳色（真实设备基本是深灰/银灰，不搞彩虹） */
export function deviceBody(type: string, dark: boolean): string {
  if (type === 'ups' || type === 'pdu') return dark ? '#584f39' : '#b8ab8a'
  if (type === 'switch' || type === 'router' || type === 'firewall' || type === 'loadbalancer') return dark ? '#4c5c73' : '#aab4c4'
  if (type === 'storage') return dark ? '#47574f' : '#a8bdb4'
  return dark ? '#5a6678' : '#b4bccb'
}

/** 机柜面板色（侧板/顶板）：真机柜是深灰近黑，太浅会像玻璃展柜 */
export function rackBody(dark: boolean): string {
  return dark ? '#39434f' : '#c2c9d6'
}

/** 机柜框架色（立柱/顶盖/底座）：比面板亮一档，柜子的"骨架"才看得出来 */
export function rackFrame(dark: boolean): string {
  return dark ? '#4d5868' : '#a3acbb'
}
