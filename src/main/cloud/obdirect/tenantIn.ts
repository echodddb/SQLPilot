/**
 * 业务租户内部操作（基于用户录入的租户凭据）。
 *
 * 与 tenant.ts 的区别：
 *   tenant.ts  —— 平台的 sys 连接，做租户「生命周期」（建/删/锁/参数）；
 *   本文件      —— 用业务租户自己的账号连进去，做租户「内部对象」（库、账号、授权）。
 * 两者连接身份不同，不能互相替代：sys 连不到业务租户内部，业务账号也删不了租户。
 */

import { qAs, execAs, type ObDirectPlatform, type TenantLogin } from './conn'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const HOST_RE = /^[%A-Za-z0-9_.:\-]+$/
const CHARSET_RE = /^[A-Za-z0-9_]+$/
/** 权限串：只允许字母、逗号、空格（GRANT SELECT, INSERT ON ...） */
const PRIV_RE = /^[A-Za-z_,\s]+$/

/** 不允许删除的系统库（MySQL 模式） */
export const SYSTEM_DATABASES = ['information_schema', 'mysql', 'oceanbase', 'sys', '__recyclebin']

const str = (v: any): string => (v === undefined || v === null ? '' : String(v))

function assertIdent(name: string, what: string): string {
  const v = String(name ?? '').trim()
  if (!IDENT.test(v)) throw new Error(`${what}非法：${name}（仅允许字母、数字、下划线，且不以数字开头）`)
  return v
}

function q(name: string): string {
  return `\`${assertIdent(name, '名称')}\``
}

function lit(v: string): string {
  return `'${String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

export interface OpResult {
  ok: boolean
  message: string
  steps: string[]
}

/** 用凭据试连一次，确认账号可用 */
export async function testTenantLogin(p: ObDirectPlatform, login: TenantLogin): Promise<{ ok: boolean; message: string }> {
  try {
    const rows = await qAs(p, login, 'SELECT 1 AS ok')
    return { ok: rows.length > 0, message: rows.length ? '连接成功' : '连接成功（无返回）' }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}

// ---------------------------------------------------------------- 数据库

export interface DbRow {
  name: string
  charset: string
  collation: string
  /** 系统内置库：可以看，但不能删 */
  system: boolean
}

/** MySQL 模式的库列表（含系统内置库） */
export async function databasesAs(p: ObDirectPlatform, login: TenantLogin): Promise<DbRow[]> {
  const rows = await qAs(
    p, login,
    `SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
       FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME`
  )
  return rows.map((r) => {
    const name = str(r.SCHEMA_NAME)
    return {
      name,
      charset: str(r.DEFAULT_CHARACTER_SET_NAME),
      collation: str(r.DEFAULT_COLLATION_NAME),
      system: SYSTEM_DATABASES.includes(name.toLowerCase())
    }
  })
}

export async function createDatabaseAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  input: { name: string; charset?: string }
): Promise<OpResult> {
  try {
    const name = assertIdent(input.name, '库名')
    const cs = String(input.charset || 'utf8mb4').trim()
    if (!CHARSET_RE.test(cs)) return { ok: false, message: `字符集非法：${input.charset}`, steps: [] }
    const sql = `CREATE DATABASE ${q(name)} DEFAULT CHARACTER SET ${cs}`
    await execAs(p, login, sql)
    return { ok: true, message: `数据库 ${name} 已创建`, steps: [sql] }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), steps: [] }
  }
}

export async function dropDatabaseAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  name: string
): Promise<OpResult> {
  try {
    const n = assertIdent(name, '库名')
    if (SYSTEM_DATABASES.includes(n.toLowerCase())) {
      return { ok: false, message: `${n} 是系统内置库，禁止删除`, steps: [] }
    }
    const sql = `DROP DATABASE ${q(n)}`
    await execAs(p, login, sql)
    return { ok: true, message: `数据库 ${n} 已删除`, steps: [sql] }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), steps: [] }
  }
}

// ---------------------------------------------------------------- 账号

export interface DbUserRow {
  user: string
  host: string
  status: string
}

export async function usersAs(p: ObDirectPlatform, login: TenantLogin, mode: 'MYSQL' | 'ORACLE'): Promise<DbUserRow[]> {
  if (mode === 'ORACLE') {
    const rows = await qAs(p, login, 'SELECT USERNAME, ACCOUNT_STATUS FROM DBA_USERS ORDER BY USERNAME')
    return rows.map((r) => ({ user: str(r.USERNAME), host: '', status: str(r.ACCOUNT_STATUS) }))
  }
  const rows = await qAs(p, login, 'SELECT User, Host, account_locked FROM mysql.user ORDER BY User, Host')
  return rows.map((r) => ({
    user: str(r.User),
    host: str(r.Host),
    status: str(r.account_locked).toUpperCase() === 'Y' ? 'LOCKED' : 'OPEN'
  }))
}

export async function createUserAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  input: { name: string; host?: string; password: string; mode: 'MYSQL' | 'ORACLE' }
): Promise<OpResult> {
  try {
    const name = assertIdent(input.name, '账号名')
    const pw = String(input.password || '')
    if (!pw) return { ok: false, message: '密码不能为空', steps: [] }

    if (input.mode === 'ORACLE') {
      const sql = `CREATE USER "${name}" IDENTIFIED BY "${pw.replace(/"/g, '""')}"`
      await execAs(p, login, sql)
      return { ok: true, message: `账号 ${name} 已创建`, steps: [sql] }
    }
    const host = String(input.host || '%').trim() || '%'
    if (!HOST_RE.test(host)) return { ok: false, message: `Host 非法：${host}`, steps: [] }
    const sql = `CREATE USER ${lit(name)}@${lit(host)} IDENTIFIED BY ${lit(pw)}`
    await execAs(p, login, sql)
    return { ok: true, message: `账号 ${name}@${host} 已创建`, steps: [sql] }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), steps: [] }
  }
}

export async function dropUserAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  input: { name: string; host?: string; mode: 'MYSQL' | 'ORACLE' }
): Promise<OpResult> {
  try {
    const name = assertIdent(input.name, '账号名')
    if (input.mode === 'ORACLE') {
      if (name.toUpperCase() === 'SYS') return { ok: false, message: '不能删除 SYS 账号', steps: [] }
      const sql = `DROP USER "${name}" CASCADE`
      await execAs(p, login, sql)
      return { ok: true, message: `账号 ${name} 已删除`, steps: [sql] }
    }
    const host = String(input.host || '%').trim() || '%'
    if (!HOST_RE.test(host)) return { ok: false, message: `Host 非法：${host}`, steps: [] }
    const sql = `DROP USER ${lit(name)}@${lit(host)}`
    await execAs(p, login, sql)
    return { ok: true, message: `账号 ${name}@${host} 已删除`, steps: [sql] }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), steps: [] }
  }
}

/** 授权：MySQL 授到库级；Oracle 授角色 */
export async function grantAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  input: { name: string; host?: string; database?: string; privileges: string; mode: 'MYSQL' | 'ORACLE' }
): Promise<OpResult> {
  try {
    const name = assertIdent(input.name, '账号名')
    const priv = String(input.privileges || '').trim()
    if (!priv) return { ok: false, message: '请填写权限', steps: [] }
    if (!PRIV_RE.test(priv)) return { ok: false, message: `权限串非法：${priv}`, steps: [] }

    if (input.mode === 'ORACLE') {
      const sql = `GRANT ${priv.toUpperCase()} TO "${name}"`
      await execAs(p, login, sql)
      return { ok: true, message: `已授予 ${name}：${priv}`, steps: [sql] }
    }
    const host = String(input.host || '%').trim() || '%'
    if (!HOST_RE.test(host)) return { ok: false, message: `Host 非法：${host}`, steps: [] }
    const db = String(input.database || '').trim()
    const on = db ? `${q(db)}.*` : '*.*'
    const sql = `GRANT ${priv.toUpperCase()} ON ${on} TO ${lit(name)}@${lit(host)}`
    await execAs(p, login, sql)
    return { ok: true, message: `已授予 ${name}@${host} 在 ${db || '所有库'} 上的 ${priv}`, steps: [sql] }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), steps: [] }
  }
}

/** 查看某个账号的授权（MySQL 用 SHOW GRANTS） */
export async function grantsAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  input: { name: string; host?: string }
): Promise<string[]> {
  const host = String(input.host || '%').trim() || '%'
  const rows = await qAs(p, login, `SHOW GRANTS FOR ${lit(assertIdent(input.name, '账号名'))}@${lit(host)}`)
  return rows.map((r) => str(Object.values(r)[0]))
}
