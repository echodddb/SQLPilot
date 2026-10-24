/**
 * OCP · 平台管理（对齐官方「平台管理」：用户 / 角色 / 平台参数 / 登录审计 / 系统信息）。
 *
 * 实测于 OCP 4.4.1（2026-10-21）：
 *   GET /api/v2/iam/users?page=&size=
 *   GET /api/v2/iam/roles?page=&size=
 *   GET /api/v2/iam/user/loginRecords?page=&size=     登录审计（本实例已有 500+ 条）
 *   GET /api/v2/config/properties?page=&size=         平台参数（336 条，keyword 参数不生效，前端过滤）
 *   GET /api/v2/config/systemInfo                     系统能力开关（多集群/仲裁/升级/审计…）
 */

import type { OcpClient } from './ocp'

export interface PlatformUser {
  id: number
  username: string
  email: string
  organization: string
  department: string
  description: string
  enabled: boolean
  locked: boolean
  accountExpired: boolean
  credentialsExpired: boolean
  /** LOCAL / LDAP / SSO… */
  origin: string
  roles: string[]
  createTime: string
  lastPasswordChange: string
}

export interface PlatformRole {
  id: number
  name: string
  /** DEFAULT 内置 / CUSTOM 自定义 */
  type: string
  description: string
  organization: string
  userCount: number
  permissionCount: number
  createTime: string
}

export interface PlatformProperty {
  id: number
  key: string
  value: string
  runningValue: string
  type: string
  label: string
  profile: string
  application: string
  needRestart: boolean
  visibleLevel: string
  description: string
}

export interface PlatformLoginRecord {
  userId: number
  username: string
  clientAddress: string
  loginResult: string
  loginTime: string
  userAgent: string
}

export interface PlatformSystemInfo {
  authType: string
  monitorInterval: number
  vpcModeEnabled: boolean
  multiClusterEnabled: boolean
  readOnly: boolean
  aiAssistantStatus: string
  auditEnabled: boolean
  analyzeEnabled: boolean
  fileServerType: string
  /** 其它未归类的开关，原样带出来给「系统信息」表 */
  others: { key: string; value: string }[]
}

export interface PlatformBundle {
  users: PlatformUser[]
  roles: PlatformRole[]
  properties: PlatformProperty[]
  propertyTotal: number
  logins: PlatformLoginRecord[]
  loginTotal: number
  system: PlatformSystemInfo | null
  updatedAt: number
}

const num = (v: any): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const str = (v: any): string => (v === undefined || v === null || v === 'null' ? '' : String(v))
const bool = (v: any): boolean => v === true || v === 'true'
const rows = (d: any): any[] => (Array.isArray(d) ? d : Array.isArray(d?.contents) ? d.contents : [])

function toUser(raw: any): PlatformUser {
  return {
    id: num(raw?.id),
    username: str(raw?.username),
    email: str(raw?.email),
    organization: str(raw?.organization),
    department: str(raw?.department?.name ?? raw?.department),
    description: str(raw?.description),
    enabled: bool(raw?.enabled),
    locked: bool(raw?.accountLocked),
    accountExpired: bool(raw?.accountExpired),
    credentialsExpired: bool(raw?.credentialsExpired),
    origin: str(raw?.origin),
    roles: (Array.isArray(raw?.roles) ? raw.roles : []).map((r: any) => str(r?.name ?? r)),
    createTime: str(raw?.createTime),
    lastPasswordChange: str(raw?.lastPasswordChangeTime)
  }
}

function toRole(raw: any): PlatformRole {
  return {
    id: num(raw?.id),
    name: str(raw?.name),
    type: str(raw?.type),
    description: str(raw?.description),
    organization: str(raw?.organization?.name ?? raw?.organization),
    userCount: Array.isArray(raw?.users) ? raw.users.length : num(raw?.userCount),
    permissionCount: Array.isArray(raw?.permissions) ? raw.permissions.length : num(raw?.permissionCount),
    createTime: str(raw?.createTime)
  }
}

function toProperty(raw: any): PlatformProperty {
  return {
    id: num(raw?.id),
    key: str(raw?.key),
    value: str(raw?.value),
    runningValue: str(raw?.runningValue),
    type: str(raw?.type),
    label: str(raw?.label),
    profile: str(raw?.profile),
    application: str(raw?.application),
    needRestart: bool(raw?.needRestart),
    visibleLevel: str(raw?.visibleLevel),
    description: str(raw?.description)
  }
}

function toLogin(raw: any): PlatformLoginRecord {
  return {
    userId: num(raw?.userId),
    username: str(raw?.username),
    clientAddress: str(raw?.clientAddress),
    loginResult: str(raw?.loginResult),
    loginTime: str(raw?.loginTime),
    userAgent: str(raw?.userAgent)
  }
}

function toSystem(raw: any): PlatformSystemInfo {
  const known = new Set(['authInfo', 'monitorInfo', 'vpcModeInfo', 'ocpServerInfo', 'aiAssistantInfo', 'operationInfo', 'analyzeInfo', 'fileServerInfo'])
  const others: { key: string; value: string }[] = []
  for (const [k, v] of Object.entries(raw || {})) {
    if (known.has(k)) continue
    others.push({ key: k, value: v && typeof v === 'object' ? JSON.stringify(v) : str(v) })
  }
  return {
    authType: str(raw?.authInfo?.authType),
    monitorInterval: num(raw?.monitorInfo?.collectInterval),
    vpcModeEnabled: bool(raw?.vpcModeInfo?.vpcModeEnabled),
    multiClusterEnabled: bool(raw?.multiClusterInfo?.multiClusterEnabled),
    readOnly: bool(raw?.ocpServerInfo?.ocpReadOnlyEnabled),
    aiAssistantStatus: str(raw?.aiAssistantInfo?.aiAssistantStatus),
    auditEnabled: bool(raw?.analyzeInfo?.logEnabled ?? raw?.auditInfo?.enabled),
    analyzeEnabled: bool(raw?.analyzeInfo?.analyzeEnabled),
    fileServerType: str(raw?.fileServerInfo?.fileServerType),
    others
  }
}

export async function ocpPlatformUsers(client: OcpClient): Promise<PlatformUser[]> {
  const d = await client.call<any>('/api/v2/iam/users', { query: { page: 1, size: 200 } })
  return rows(d).map(toUser)
}

export async function ocpPlatformRoles(client: OcpClient): Promise<PlatformRole[]> {
  const d = await client.call<any>('/api/v2/iam/roles', { query: { page: 1, size: 200 } })
  return rows(d).map(toRole)
}

export async function ocpPlatformProperties(client: OcpClient, page = 1, size = 100): Promise<{ items: PlatformProperty[]; total: number }> {
  const d = await client.call<any>('/api/v2/config/properties', { query: { page, size } })
  return { items: rows(d).map(toProperty), total: num(d?.page?.totalElements ?? rows(d).length) }
}

export async function ocpPlatformLogins(client: OcpClient, page = 1, size = 50): Promise<{ items: PlatformLoginRecord[]; total: number }> {
  const d = await client.call<any>('/api/v2/iam/user/loginRecords', { query: { page, size } })
  return { items: rows(d).map(toLogin), total: num(d?.page?.totalElements ?? rows(d).length) }
}

export async function ocpPlatformSystemInfo(client: OcpClient): Promise<PlatformSystemInfo> {
  const d = await client.call<any>('/api/v2/config/systemInfo')
  return toSystem(d)
}

/** 平台页一次拉齐（参数只取第一页：336 条全拉没必要，界面支持翻页/搜索时再单独调） */
export async function ocpPlatformBundle(client: OcpClient): Promise<PlatformBundle> {
  const [users, roles, props, logins, system] = await Promise.all([
    ocpPlatformUsers(client).catch(() => []),
    ocpPlatformRoles(client).catch(() => []),
    ocpPlatformProperties(client, 1, 100).catch(() => ({ items: [], total: 0 })),
    ocpPlatformLogins(client, 1, 50).catch(() => ({ items: [], total: 0 })),
    ocpPlatformSystemInfo(client).catch(() => null)
  ])
  return {
    users,
    roles,
    properties: props.items,
    propertyTotal: props.total,
    logins: logins.items,
    loginTotal: logins.total,
    system,
    updatedAt: Date.now()
  }
}
