/**
 * Oracle 云平台的取数通道：一条连接 + 串行队列。
 *
 * 轻量化的关键取舍：
 * 1. 不做连接池。DBA 看板是"点一次刷一次"，一条连接足够；查完挂着复用，断了自动重建。
 * 2. 全部查询串行执行（oracledb 同一条连接不允许并发 execute）。
 * 3. 11g 不支持 thin 模式，必须 thick（Instant Client）；错误信息里直接告诉用户填哪种路径。
 * 4. SYSDBA / SYSOPER 是**独立特权**，和 DBA 角色不是一回事：必须在口令文件里显式授予
 *    （grant sysdba to 用户），否则登录直接 ORA-01017。这里对这种情况做自动降级 + 明确提示。
 */

import oracledb from 'oracledb'
import { getPassword } from '../../secrets'
import { initThick } from '../../db/oracle'
import type { CloudOraclePlatform } from './types'

oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB]

/** 单条查询超时：看板是交互式的，超过这个时间说明视图太重，直接放弃而不是拖住界面 */
const QUERY_TIMEOUT_MS = 30000

interface Entry {
  conn: any
  mode: 'thin' | 'thick'
  at: number
}

const entries = new Map<string, Entry>()
/** 每个平台一条串行链，和 entries 分开维护：连接还没建好时两次并发调用也不会各自开一条 */
const chains = new Map<string, Promise<unknown>>()

export function dropOracleConn(id: string): void {
  const e = entries.get(id)
  entries.delete(id)
  if (e) { try { e.conn?.close().catch(() => {}) } catch { /* 已关闭 */ } }
}

function connectString(p: CloudOraclePlatform): string {
  const svc = String(p.serviceName || '').trim()
  return `${p.host}:${Number(p.port) || 1521}${svc ? `/${svc}` : ''}`
}

function privilegeOf(role?: string): number | undefined {
  if (role === 'sysdba') return oracledb.SYSDBA
  if (role === 'sysoper') return oracledb.SYSOPER
  return undefined
}

function isThinUnsupported(e: any): boolean {
  const msg = String(e?.message || '')
  return /NJS-138|not supported by node-oracledb in Thin mode|requires Oracle Client/i.test(msg)
}

/** 认证/授权类失败：这类错误要翻译成"账号没这个特权"，而不是原样抛 ORA 编号 */
const AUTH_FAIL = /ORA-01017|ORA-01031|ORA-28009|ORA-01045|invalid username\/password|insufficient privileges/i

export function isAuthDenied(e: unknown): boolean {
  return AUTH_FAIL.test(String((e as any)?.message || e || ''))
}

/** SYSDBA 授权提示（DBA 角色 ≠ SYSDBA，这是最常见的误解） */
export function sysdbaHelp(role: string): string {
  const r = role.toUpperCase()
  return (
    `该账号没有 ${r} 特权。${r} 是独立特权，必须由口令文件显式授予（管理员执行 GRANT ${r} TO 用户名，` +
    '且 remote_login_passwordfile 不能是 NONE），拥有 DBA 角色并不等于拥有它。' +
    'Oracle 看板只读 v$ / dba_ 视图，普通 DBA 账号（有 SELECT_CATALOG_ROLE）就够用，把「连接身份」改回「普通用户」即可。'
  )
}

/** 把驱动抛出的原始错误翻译成可执行的说明；非认证类错误原样返回 */
export function explainOraError(e: unknown, role?: string): string {
  const msg = String((e as any)?.message || e || '').split('\n')[0]
  if (role && role !== 'default' && isAuthDenied(e)) return `${msg}｜${sysdbaHelp(role)}`
  if (isThinUnsupported(e)) {
    return '该实例版本较老（如 Oracle 11g），node-oracledb 的 thin 模式不支持。请在平台设置里填写 Instant Client 目录（thick 模式）后重试。'
  }
  return msg
}

/** 按指定身份建一条连接（不缓存）；thin 优先，配了 Instant Client 才走 thick */
async function connectWith(p: CloudOraclePlatform, password: string, role?: string): Promise<{ conn: any; mode: 'thin' | 'thick' }> {
  const base: any = {
    user: p.username.trim(),
    password,
    connectString: connectString(p),
    connectTimeout: 12000
  }
  const priv = privilegeOf(role)
  if (priv !== undefined) base.privilege = priv

  const useThick = !!p.instantClientDir
  if (useThick) initThick(p.instantClientDir)
  try {
    const conn = await oracledb.getConnection(base)
    conn.callTimeout = QUERY_TIMEOUT_MS
    return { conn, mode: useThick ? 'thick' : 'thin' }
  } catch (e: any) {
    // 统一翻译成可执行的说明（老版本 thin 不支持 / 缺 SYSDBA 特权），保留原始 code 便于上层判断
    throw Object.assign(new Error(explainOraError(e, role)), { code: e?.code })
  }
}

async function open(p: CloudOraclePlatform): Promise<{ conn: any; mode: 'thin' | 'thick' }> {
  const password = getPassword(`cloud:${p.id}`)
  if (!password) throw new Error(`平台「${p.name}」尚未保存密码，请先在云管平台设置里填写`)
  return connectWith(p, password, p.role)
}

async function entryOf(p: CloudOraclePlatform): Promise<Entry> {
  const hit = entries.get(p.id)
  if (hit) {
    // 60 秒内且连接还活着就直接用；否则做一次最轻量的探活
    if (Date.now() - hit.at < 60000) return hit
    try {
      await hit.conn.execute('select 1 from dual')
      hit.at = Date.now()
      return hit
    } catch {
      dropOracleConn(p.id)
    }
  }
  const { conn, mode } = await open(p)
  const entry: Entry = { conn, mode, at: Date.now() }
  entries.set(p.id, entry)
  return entry
}

/** 在平台连接上串行执行一个任务（同一连接上的查询不会并发） */
export function withOracle<T>(p: CloudOraclePlatform, fn: (ctx: { conn: any; mode: 'thin' | 'thick' }) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const e = await entryOf(p)
    try {
      return await fn({ conn: e.conn, mode: e.mode })
    } catch (err) {
      // 连接类错误：丢掉重建，下一次刷新自愈
      if (/NJS-|ORA-03113|ORA-03114|ORA-12537|ORA-12541|connection/i.test(String((err as any)?.message))) dropOracleConn(p.id)
      throw err
    } finally {
      e.at = Date.now()
    }
  }
  const prev = chains.get(p.id) ?? Promise.resolve()
  const next = prev.then(run, run)
  chains.set(p.id, next.catch(() => {}))
  return next
}

export interface OraQueryOptions {
  /** 最多取多少行（默认 500，看板不需要全量） */
  maxRows?: number
  binds?: Record<string, unknown>
}

/** 查询并把列名统一成小写（渲染层按定义取值） */
export async function oraQuery<T = any>(conn: any, sql: string, opts: OraQueryOptions = {}): Promise<T[]> {
  const r = await conn.execute(sql, opts.binds || [], {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
    maxRows: opts.maxRows ?? 500
  })
  const rows = (r.rows || []) as any[]
  return rows.map((row) => {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(row)) {
      const v = row[k]
      o[k.toLowerCase()] = v instanceof Date ? toIso(v) : v
    }
    return o as T
  })
}

/** 查询单值（第一行第一列） */
export async function oraScalar(conn: any, sql: string, opts: OraQueryOptions = {}): Promise<unknown> {
  const r = await conn.execute(sql, opts.binds || [], {
    outFormat: oracledb.OUT_FORMAT_ARRAY,
    maxRows: 1
  })
  const rows = (r.rows || []) as any[][]
  return rows[0]?.[0]
}

function toIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export interface OraTestResult {
  ok: boolean
  version?: string
  mode?: string
  error?: string
  /** 请求了 SYSDBA/SYSOPER 但实际按普通身份连通 */
  downgraded?: boolean
  /** 给界面的补充说明（降级原因等） */
  note?: string
  /** 账号特权探测（查不到时为 undefined） */
  privileges?: { dba: boolean; sysdba: boolean; sysoper: boolean }
}

/** 探测账号确实拥有的特权：DBA 角色、口令文件里的 SYSDBA/SYSOPER */
async function probePrivileges(conn: any): Promise<OraTestResult['privileges']> {
  try {
    const r = await conn.execute(
      `select (select count(*) from dba_role_privs where grantee = user and granted_role = 'DBA') dba_cnt,
              (select count(*) from v$pwfile_users where username = user and sysdba = 'TRUE') sysdba_cnt,
              (select count(*) from v$pwfile_users where username = user and sysoper = 'TRUE') sysoper_cnt
         from dual`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 1 }
    )
    const row: any = (r.rows || [])[0]
    if (!row) return undefined
    return { dba: Number(row.DBA_CNT) > 0, sysdba: Number(row.SYSDBA_CNT) > 0, sysoper: Number(row.SYSOPER_CNT) > 0 }
  } catch {
    return undefined // 没有 catalog 权限时静默跳过，不影响连通性结论
  }
}

/**
 * 连接测试：返回版本 + 实际使用的身份。
 * 选了 SYSDBA 但账号没这个特权时，会自动用普通身份再试一次 —— 看板只读视图，
 * 普通 DBA 账号就够，没必要卡在"连不上"这一步。
 */
export async function oraTestConn(p: CloudOraclePlatform, passwordOverride?: string): Promise<OraTestResult> {
  const password = passwordOverride || getPassword(`cloud:${p.id}`)
  if (!password) return { ok: false, error: '请填写密码' }

  const finish = async (r: { conn: any; mode: 'thin' | 'thick' }, extra: Partial<OraTestResult> = {}): Promise<OraTestResult> => {
    let version = 'Oracle'
    try {
      const v = await r.conn.execute('select banner from v$version where rownum = 1', [], { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 1 })
      version = String((v.rows as any[][])[0]?.[0] || version)
    } catch { /* 权限不足时不给版本，但连接是通的 */ }
    const privileges = await probePrivileges(r.conn)
    try { await r.conn.close() } catch { /* 忽略 */ }
    return { ok: true, version, mode: r.mode, privileges, ...extra }
  }

  try {
    return await finish(await connectWith(p, password, p.role))
  } catch (e: any) {
    // 选了 SYSDBA/SYSOPER 但账号没授权：自动按普通身份再试，成功则降级并说明原因
    if (p.role !== 'default' && isAuthDenied(e)) {
      try {
        const r = await connectWith(p, password, 'default')
        return await finish(r, {
          downgraded: true,
          note: `该账号未被授予 ${String(p.role).toUpperCase()} 特权（DBA 角色不等于 SYSDBA），已按普通身份连通。`
        })
      } catch {
        return { ok: false, error: explainOraError(e, p.role) }
      }
    }
    return { ok: false, error: explainOraError(e, p.role) }
  }
}

/** 连接探活（平台设置页与模块进入时用） */
export async function oraclePing(p: CloudOraclePlatform): Promise<OraTestResult> {
  try {
    return await withOracle(p, async ({ conn, mode }) => {
      const r = await conn.execute('select banner from v$version where rownum = 1', [], { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 1 })
      return { ok: true, version: String((r.rows as any[][])[0]?.[0] || ''), mode }
    })
  } catch (e: any) {
    return { ok: false, error: explainOraError(e, p.role) }
  }
}
