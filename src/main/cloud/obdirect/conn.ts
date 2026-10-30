/**
 * OceanBase 直连模式（无 OCP）的连接管理。
 *
 * 场景：单机 / 小型集群没有部署 OCP，直接连 SQL 端口（默认 2881）读 oceanbase 库的系统视图。
 * 与 ocp.ts 一样刻意不依赖 electron：平台配置与密码由 service 层传入，方便脱离应用单独联调。
 *
 * 只读保障：采集走 q()，取到连接后先 SET SESSION TRANSACTION READ ONLY；
 * 写操作必须显式走 execWrite()，它会把会话切成 READ WRITE，执行完再切回只读。
 */

import mysql from 'mysql2/promise'
import type { Pool, PoolConnection } from 'mysql2/promise'

export interface ObDirectPlatform {
  id: string
  name: string
  type: 'obdirect'
  host: string
  port: number
  /** OB 的用户名带租户后缀，形如 root@sys */
  username: string
  /** 默认连接租户（仅用于展示，实际由 username 的后缀决定） */
  defaultTenant?: string
}

interface CacheEntry {
  pool: Pool
  fp: string
}

const CACHE = new Map<string, CacheEntry>()

/** 凭据或地址变了就换池，避免用旧密码反复重试 */
const fpOf = (p: ObDirectPlatform, password: string): string =>
  [p.host, p.port, p.username, password].join('\u0000')

export function poolOf(p: ObDirectPlatform, password: string): Pool {
  const fp = fpOf(p, password)
  const hit = CACHE.get(p.id)
  if (hit && hit.fp === fp) return hit.pool
  if (hit) {
    void hit.pool.end().catch(() => { /* 旧池关闭失败不影响新池 */ })
  }
  const pool = mysql.createPool({
    host: p.host,
    port: p.port,
    user: p.username,
    password,
    connectTimeout: 8000,
    connectionLimit: 2,
    maxIdle: 2,
    idleTimeout: 60_000,
    enableKeepAlive: true,
    waitForConnections: true,
    queueLimit: 8,
    // 系统视图里的时间本身是实例本地时间，按字符串取，避免 Date 与宿主时区互相污染
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false
  })
  CACHE.set(p.id, { pool, fp })
  return pool
}

export function dropPool(id: string): void {
  const hit = CACHE.get(id)
  if (!hit) return
  CACHE.delete(id)
  void hit.pool.end().catch(() => { /* 已关闭 */ })
}

export function dropAllPools(): void {
  for (const id of [...CACHE.keys()]) dropPool(id)
}

/** 借一条连接，失败时把原始错误抛给上层（service 会包装成 { ok:false, error }） */
async function acquire(p: ObDirectPlatform, password: string): Promise<PoolConnection> {
  const pool = poolOf(p, password)
  const conn = await pool.getConnection()
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY')
  } catch {
    // 老版本可能不认这条，只读由后面的白名单兜底
  }
  return conn
}

/**
 * 只读查询。rows 上限由调用方自觉控制——这里只做类型收敛与连接归还。
 * 注意：统一走文本协议（query）而不是预处理（execute），OB 对预处理语句的支持因版本而异。
 */
export async function q<T = any>(
  p: ObDirectPlatform,
  password: string,
  sql: string,
  params: any[] = []
): Promise<T[]> {
  const conn = await acquire(p, password)
  try {
    const [rows] = await conn.query(sql, params)
    return (Array.isArray(rows) ? rows : []) as T[]
  } finally {
    conn.release()
  }
}

/** 取单行单列（COUNT / 参数读取这类），查不到返回 null */
export async function q1<T = any>(
  p: ObDirectPlatform,
  password: string,
  sql: string,
  params: any[] = []
): Promise<T | null> {
  const rows = await q<T>(p, password, sql, params)
  return rows.length ? rows[0] : null
}

/** 写操作：显式切 READ WRITE，执行完切回只读再归还连接 */
export async function execWrite(
  p: ObDirectPlatform,
  password: string,
  sql: string,
  params: any[] = []
): Promise<{ affectedRows: number; info: string }> {
  const conn = await acquire(p, password)
  try {
    await conn.query('SET SESSION TRANSACTION READ WRITE')
    const [res] = await conn.query(sql, params)
    const r = res as any
    return { affectedRows: Number(r?.affectedRows ?? 0), info: String(r?.info ?? '') }
  } finally {
    try {
      await conn.query('SET SESSION TRANSACTION READ ONLY')
    } catch {
      // 归还前切不回只读也不影响，下一位借到时会重新设置
    }
    conn.release()
  }
}

/**
 * 以指定租户身份执行一条语句（临时连接，用完即关）。
 *
 * 只用于「新建租户后设置管理员密码」这类必须落在租户内的动作：
 * sys 租户无法代改用户密码，只能切到新租户执行 ALTER USER。
 * 不走连接池：租户是刚建出来的，池里没有、也不该为它常驻。
 *
 * user 用于改登录账号：Oracle 兼容模式的管理员是 sys（不是 root），
 * 沿用平台用户名（root@sys → root）会得到一个不存在的账号。
 * password 传新租户「当前」的密码——刚建出来时是空串，设完密码后才是新密码。
 */
export async function execAsTenant(
  p: ObDirectPlatform,
  password: string,
  tenant: string,
  sql: string,
  params: any[] = [],
  user?: string
): Promise<void> {
  const at = p.username.indexOf('@')
  const base = user || (at >= 0 ? p.username.slice(0, at) : p.username)
  const conn = await mysql.createConnection({
    host: p.host,
    port: p.port,
    user: `${base}@${tenant}`,
    password,
    connectTimeout: 8000,
    dateStrings: true
  })
  try {
    await conn.query(sql, params)
  } finally {
    await conn.end().catch(() => { /* 已断开 */ })
  }
}

/**
 * 业务租户凭据：用于「租户内部」的操作（建库、建账号、授权等）。
 * 与平台的 sys 连接刻意分开——这些操作必须在租户内执行，密码也可能不同。
 */
export interface TenantLogin {
  /** 登录名（不含 @租户 后缀） */
  user: string
  password: string
  /** 租户名，拼成 user@tenant */
  tenant: string
}

/** 以业务租户凭据开一条临时连接执行只读查询 */
export async function qAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  sql: string,
  params: any[] = []
): Promise<any[]> {
  const conn = await mysql.createConnection({
    host: p.host,
    port: p.port,
    user: `${login.user}@${login.tenant}`,
    password: login.password,
    connectTimeout: 8000,
    dateStrings: true,
    supportBigNumbers: true
  })
  try {
    const [rows] = await conn.query(sql, params)
    return Array.isArray(rows) ? (rows as any[]) : []
  } finally {
    await conn.end().catch(() => { /* 已断开 */ })
  }
}

/** 以业务租户凭据执行写语句 */
export async function execAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  sql: string,
  params: any[] = []
): Promise<{ affectedRows: number; info: string }> {
  const conn = await mysql.createConnection({
    host: p.host,
    port: p.port,
    user: `${login.user}@${login.tenant}`,
    password: login.password,
    connectTimeout: 8000,
    dateStrings: true
  })
  try {
    const [res] = await conn.query(sql, params)
    const r = res as any
    return { affectedRows: Number(r?.affectedRows ?? 0), info: String(r?.info ?? '') }
  } finally {
    await conn.end().catch(() => { /* 已断开 */ })
  }
}

/** 测试连接：成功返回版本号，失败抛错 */
export async function ping(p: ObDirectPlatform, password: string): Promise<{ version: string; tenant: string }> {
  const conn = await acquire(p, password)
  try {
    const [rows] = await conn.query('SELECT VERSION() AS v, EFFECTIVE_TENANT_ID() AS tid')
    const row = (Array.isArray(rows) ? rows[0] : null) as any
    return { version: String(row?.v ?? ''), tenant: String(row?.tid ?? '') }
  } finally {
    conn.release()
  }
}
