/**
 * 租户「模式差异」的唯一来源。
 *
 * Oracle 租户和 MySQL 租户在 OCP 里不是同一套界面（实测 4.3）：
 *   · 管理用户：MySQL 是 root，Oracle 是 SYS，且 SYS 不允许锁定
 *   · 用户管理：Oracle 有「角色」，MySQL 调 /roles 会 400
 *   · 库表：Oracle 租户官方直接空态（/databases 400）
 *   · 参数：Oracle 194 条带默认值/是否需重启/取值范围，MySQL 826 条只有现值
 *   · 资源维度：Oracle 叫 Schema，MySQL 叫数据库
 *   · 标识符：Oracle 的用户名/角色名不区分大小写但回显大写，比较前统一 toUpperCase
 * 组件不要各自写 if (mode === 'ORACLE')，统一从这里取能力与文案。
 */

export type TenantMode = 'MYSQL' | 'ORACLE'

export interface TenantCapability {
  mode: TenantMode
  /** 模式的中文名 */
  label: string
  /** 能改密码/被统计的管理用户 */
  adminUser: string
  /** 「数据库」在这个模式下的叫法（MySQL 数据库 / Oracle Schema） */
  dbWord: string
  /** 是否支持库表管理（Oracle 官方不支持） */
  dbManagement: boolean
  /** 是否有角色管理 */
  roles: boolean
  /** 是否用「对象权限」（表/视图/存储过程级授权） */
  objectPrivileges: boolean
  /** 是否有库级权限（MySQL 专属概念） */
  dbPrivileges: boolean
  /** 该用户能否锁定（Oracle 的 SYS 不行） */
  canLock(user: string): boolean
  /** 用户名规整：Oracle 一律大写 */
  normUser(name: string): string
}

const MYSQL_CAPS: TenantCapability = {
  mode: 'MYSQL',
  label: 'MySQL',
  adminUser: 'root',
  dbWord: '数据库',
  dbManagement: true,
  roles: false,
  objectPrivileges: false,
  dbPrivileges: true,
  canLock: () => true,
  normUser: (n) => String(n || '').trim()
}

const ORACLE_CAPS: TenantCapability = {
  mode: 'ORACLE',
  label: 'Oracle',
  adminUser: 'SYS',
  dbWord: 'Schema',
  dbManagement: false,
  roles: true,
  objectPrivileges: true,
  dbPrivileges: false,
  // OCP 原文：SYS 用户（相当于 MySQL 租户的 root 用户）不支持锁定
  canLock: (n) => String(n || '').trim().toUpperCase() !== 'SYS',
  normUser: (n) => String(n || '').trim().toUpperCase()
}

/** 从任意来源（CloudTenant.mode / tenant.mode）归一模式，未知一律按 MySQL 处理 */
export function tenantModeOf(mode?: string): TenantMode {
  return String(mode || '').trim().toUpperCase() === 'ORACLE' ? 'ORACLE' : 'MYSQL'
}

export function tenantCaps(mode?: string): TenantCapability {
  return tenantModeOf(mode) === 'ORACLE' ? ORACLE_CAPS : MYSQL_CAPS
}

/** 租户详情 tab 的可用性（key 与 TenantDrawer 的组件表对应） */
export interface TenantTabRule {
  key: string
  label: string
  /** 不写 = 两种模式都有 */
  modes?: TenantMode[]
}

/**
 * tab 顺序照官方 OCP 4.3 租户详情页：
 * 概览 / 资源 / 副本与资源 / 拓扑 / 库表 / 会话 / 事务 / SQL 诊断 / 参数 / 合并 / 监控 / 备份 / 用户 / 资源管理
 * 说明：官方的「资源」是资源用量 TOP（可按 Schema/数据库 → 表组 → 表 → 分区 钻取），
 * 与我们原来的「副本与资源」（Unit/副本配置）是两件事，所以两个都留。
 * 「库表」在 Oracle 下**保留 tab 但渲染空态**（官方就是空态，隐藏 tab 会让人以为我们没做）；
 * 「统计信息」官方并入库表，我们保留独立入口；「安全」是我们的额外入口（改密/白名单/TDE）。
 */
export const TENANT_TABS: TenantTabRule[] = [
  { key: 'overview', label: '概览' },
  { key: 'usage', label: '资源' },
  { key: 'resource', label: '副本与资源' },
  { key: 'topo', label: '拓扑' },
  { key: 'database', label: '库表' },
  { key: 'gather', label: '统计信息' },
  { key: 'session', label: '会话' },
  { key: 'txn', label: '事务' },
  { key: 'sql', label: 'SQL 诊断' },
  { key: 'params', label: '参数' },
  { key: 'compaction', label: '合并' },
  { key: 'monitor', label: '监控' },
  { key: 'backup', label: '备份' },
  { key: 'users', label: '用户' },
  { key: 'rsrc', label: '资源管理' },
  { key: 'security', label: '安全' }
]

export function tabsFor(mode?: string): TenantTabRule[] {
  const m = tenantModeOf(mode)
  return TENANT_TABS.filter((t) => !t.modes || t.modes.includes(m))
}
