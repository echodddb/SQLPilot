/**
 * 业务租户内部操作（基于用户录入的租户凭据）。
 *
 * 与 tenant.ts 的区别：
 *   tenant.ts  —— 平台的 sys 连接，做租户「生命周期」（建/删/锁/参数）；
 *   本文件      —— 用业务租户自己的账号连进去，做租户「内部对象」（库、账号、授权）。
 * 两者连接身份不同，不能互相替代：sys 连不到业务租户内部，业务账号也删不了租户。
 */

import { qAs, execAs, type ObDirectPlatform, type TenantLogin } from './conn'
import { normalizePrivileges, privilegesOf } from './tenantSql'
import { obVersionOf } from './tenancy'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const HOST_RE = /^[%A-Za-z0-9_.:\-]+$/
const CHARSET_RE = /^[A-Za-z0-9_]+$/

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

/**
 * 用凭据试连一次，确认账号可用。
 *
 * Oracle 兼容模式不认「SELECT 1」（没有 FROM）：拿 MySQL 的探测语句去试会报语法错，
 * 于是凭据其实可用、界面却提示"连接测试未通过"，用户重进详情又发现能查到用户列表。
 * 这里按模式选探测语句。
 */
export async function testTenantLogin(
  p: ObDirectPlatform,
  login: TenantLogin,
  mode: 'MYSQL' | 'ORACLE' = 'MYSQL'
): Promise<{ ok: boolean; message: string }> {
  const probe = mode === 'ORACLE' ? 'SELECT 1 AS "OK" FROM DUAL' : 'SELECT 1 AS ok'
  try {
    const rows = await qAs(p, login, probe)
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

/**
 * 账号列表。
 *
 * MySQL 模式优先读 mysql.user 的完整列（含锁定状态）；不同 OB 版本的 mysql.user
 * 列不一样（早期版本没有 account_locked），一旦整条 SQL 报错，账号列表就是空的——
 * 界面上表现为「读取不到账号」，连带「授权」按钮根本不出现，
 * 用户看到的结论就是"不能授权"。因此这里按能力逐级降级，保证至少能列出账号。
 */
export async function usersAs(p: ObDirectPlatform, login: TenantLogin, mode: 'MYSQL' | 'ORACLE'): Promise<DbUserRow[]> {
  if (mode === 'ORACLE') {
    const rows = await qAs(p, login, 'SELECT USERNAME, ACCOUNT_STATUS FROM DBA_USERS ORDER BY USERNAME')
    return rows.map((r) => ({ user: str(r.USERNAME), host: '', status: str(r.ACCOUNT_STATUS) }))
  }
  const attempts: { sql: string; map: (r: any) => DbUserRow }[] = [
    {
      sql: 'SELECT User, Host, account_locked FROM mysql.user ORDER BY User, Host',
      map: (r) => ({
        user: str(r.User),
        host: str(r.Host),
        status: str(r.account_locked).toUpperCase() === 'Y' ? 'LOCKED' : 'OPEN'
      })
    },
    {
      // 老版本没有 account_locked：只取账号与 host，状态显示为未知
      sql: 'SELECT user AS User, host AS Host FROM mysql.user ORDER BY user, host',
      map: (r) => ({ user: str(r.User ?? r.user), host: str(r.Host ?? r.host), status: '' })
    },
    {
      // 再退一步：直接读 OB 自己的视图（mysql.user 被裁剪掉的版本）
      sql: 'SELECT USER_NAME AS User, HOST AS Host FROM oceanbase.DBA_OB_USERS ORDER BY USER_NAME, HOST',
      map: (r) => ({ user: str(r.User ?? r.USER_NAME), host: str(r.Host ?? r.HOST), status: '' })
    }
  ]
  let lastErr: any = null
  for (const a of attempts) {
    try {
      const rows = await qAs(p, login, a.sql)
      return rows.map(a.map)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('读取账号列表失败')
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

/**
 * 授权（勾选式）。
 *
 * MySQL：勾多个库就逐库执行一条 GRANT；不勾库 = *.*（所有库）。
 * Oracle：角色 / 系统权限直接 GRANT ... TO "user"。
 * 权限来自界面勾选，统一走白名单归一化；中途失败会把已执行的语句一并带回，
 * 让用户知道断在哪一条（GRANT 不可回滚）。
 *
 * 逐项回退：组合语句失败时（同一批里混了本模式不支持的项，OB 会整条拒绝），
 * 再按单项重试一遍，把能授的先授上，只把真正失败的那几项报出来——
 * 否则用户看到的永远是「授权失败」，不知道是哪一个权限不被支持。
 */
export async function grantAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  input: {
    name: string
    host?: string
    /** MySQL：多库；空数组 = 所有库 */
    databases?: string[]
    /** 兼容旧的单库入参 */
    database?: string
    privileges: string | string[]
    mode: 'MYSQL' | 'ORACLE'
  }
): Promise<OpResult> {
  const steps: string[] = []
  try {
    const name = assertIdent(input.name, '账号名')
    const priv = normalizePrivileges(input.privileges, input.mode)
    if (!priv.length) return { ok: false, message: '请至少勾选一项权限', steps: [] }

    if (input.mode === 'ORACLE') {
      const target = oracleIdent(name)
      const sql = `GRANT ${priv.join(', ')} TO ${target}`
      try {
        await execAs(p, login, sql)
        steps.push(sql)
        return { ok: true, message: `已授予 ${name}：${priv.join(', ')}`, steps }
      } catch (batchErr: any) {
        // 组合失败 → 逐项重试，成功几项算几项
        if (priv.length === 1) throw batchErr
        const okList: string[] = []
        const failed: string[] = []
        for (const one of priv) {
          const oneSql = `GRANT ${one} TO ${target}`
          try {
            await execAs(p, login, oneSql)
            steps.push(oneSql)
            okList.push(one)
          } catch (e: any) {
            failed.push(`${one}（${shortErr(e)}）`)
          }
        }
        if (!okList.length) throw batchErr
        return {
          // 部分成功也算成功：只要有一条生效，界面就不该报「授权失败」，
          // 失败的项在 message 里逐条列出（否则用户会误以为一条都没授上）。
          ok: true,
          message: failed.length
            ? `已授予 ${okList.join(', ')}；以下未成功：${failed.join('；')}`
            : `已授予 ${name}：${okList.join(', ')}`,
          steps
        }
      }
    }

    const host = String(input.host || '%').trim() || '%'
    if (!HOST_RE.test(host)) return { ok: false, message: `Host 非法：${host}`, steps: [] }
    const rawDbs = Array.isArray(input.databases)
      ? input.databases
      : String(input.database || '').trim()
        ? [String(input.database)]
        : []
    const dbs = rawDbs.map((d) => assertIdent(String(d).trim(), '库名'))
    const targets = dbs.length ? dbs : ['']

    // MySQL 的 GRANT 每条只对单个库生效，逐库执行；失败按库收集，不因一个库中断整批
    const failed: string[] = []
    for (const db of targets) {
      const on = db ? `${q(db)}.*` : '*.*'
      const sql = `GRANT ${priv.join(', ')} ON ${on} TO ${lit(name)}@${lit(host)}`
      try {
        await execAs(p, login, sql)
        steps.push(sql)
      } catch (e: any) {
        failed.push(`${on}（${shortErr(e)}）`)
      }
    }
    if (!steps.length) {
      return { ok: false, message: `授权失败：${explainGrantError(failed.join('；'), input.mode)}`, steps }
    }
    // OB 的 GRANT 本来就立即生效，这里再刷一次权限缓存：某些版本 / 经 OBProxy 时会滞后，
    // 刷完顺手回读一次 SHOW GRANTS，把"到底授上没有"直接告诉用户，而不是让人去猜。
    await execAs(p, login, 'FLUSH PRIVILEGES').catch(() => { /* 权限不足就算了，不影响结论 */ })
    let verified = ''
    try {
      const back = await qAs(p, login, `SHOW GRANTS FOR ${lit(name)}@${lit(host)}`)
      const text = back.map((r) => str(Object.values(r)[0])).join('\n').toUpperCase()
      const targetDb = dbs.length ? dbs[0].toUpperCase() : ''
      const hitPriv = priv.some((x) => text.includes(x.replace(/\s+/g, ' ')))
      const hitDb = !targetDb || text.includes(targetDb)
      verified = hitPriv && hitDb ? '（已回读校验：权限存在）' : '（回读未匹配到刚授的项，请点「刷新」核对）'
    } catch {
      verified = ''
    }
    const where = dbs.length ? dbs.join('、') : '所有库'
    return {
      // 同上：部分库成功就不算整体失败，失败明细进 message
      ok: true,
      message: (failed.length
        ? `已在 ${where} 授予 ${priv.join(', ')}；以下失败：${failed.join('；')}`
        : `已授予 ${name}@${host} 在 ${where} 上的 ${priv.join(', ')}`) + verified,
      steps
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    const why = explainGrantError(msg, input.mode)
    return {
      ok: false,
      message: steps.length ? `${why}\n（已执行 ${steps.length} 条授权，未回滚）` : why,
      steps
    }
  }
}

/**
 * 权限回收（REVOKE）。与 grantAs 一一对应：
 *   MySQL：REVOKE <privs> ON <db>.* FROM 'u'@'host'
 *   Oracle：REVOKE <角色/系统权限> FROM "user"
 *
 * 只允许回收白名单内的项——REVOKE 写错等于给错权限，不能交给界面自由拼 SQL。
 */
export async function revokeAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  input: {
    name: string
    host?: string
    databases?: string[]
    database?: string
    privileges: string | string[]
    mode: 'MYSQL' | 'ORACLE'
    /** Oracle 对象权限：owner.table，给了就走 ON owner.table */
    table?: string
  }
): Promise<OpResult> {
  const steps: string[] = []
  try {
    const name = assertIdent(input.name, '账号名')
    const priv = normalizePrivileges(input.privileges, input.mode)
    if (!priv.length) return { ok: false, message: '请至少选择一项要回收的权限', steps: [] }

    if (input.mode === 'ORACLE') {
      const target = oracleIdent(name)
      const table = String(input.table || '').trim()
      if (table) {
        // owner.table 两段都必须是合法标识符，避免拼出跨对象的意外语句
        const [owner, tbl] = table.split('.')
        if (!owner || !tbl) return { ok: false, message: `对象名非法：${table}（应为 owner.table）`, steps: [] }
        const on = `${oracleIdent(assertIdent(owner, 'Owner'))}.${oracleIdent(assertIdent(tbl, '表名'))}`
        const sql = `REVOKE ${priv.join(', ')} ON ${on} FROM ${target}`
        await execAs(p, login, sql)
        steps.push(sql)
        return { ok: true, message: `已回收 ${name} 在 ${table} 上的 ${priv.join(', ')}`, steps }
      }
      const sql = `REVOKE ${priv.join(', ')} FROM ${target}`
      try {
        await execAs(p, login, sql)
        steps.push(sql)
        return { ok: true, message: `已回收 ${name} 的 ${priv.join(', ')}`, steps }
      } catch (batchErr: any) {
        if (priv.length === 1) throw batchErr
        const okList: string[] = []
        const failed: string[] = []
        for (const one of priv) {
          const oneSql = `REVOKE ${one} FROM ${target}`
          try {
            await execAs(p, login, oneSql)
            steps.push(oneSql)
            okList.push(one)
          } catch (e: any) {
            failed.push(`${one}（${shortErr(e)}）`)
          }
        }
        if (!okList.length) throw batchErr
        return {
          ok: true,
          message: failed.length
            ? `已回收 ${okList.join(', ')}；以下未成功：${failed.join('；')}`
            : `已回收 ${name} 的 ${okList.join(', ')}`,
          steps
        }
      }
    }

    const host = String(input.host || '%').trim() || '%'
    if (!HOST_RE.test(host)) return { ok: false, message: `Host 非法：${host}`, steps: [] }
    const rawDbs = Array.isArray(input.databases)
      ? input.databases
      : String(input.database || '').trim()
        ? [String(input.database)]
        : []
    const dbs = rawDbs.map((d) => assertIdent(String(d).trim(), '库名'))
    const targets = dbs.length ? dbs : ['']
    const failed: string[] = []
    for (const db of targets) {
      const on = db ? `${q(db)}.*` : '*.*'
      const sql = `REVOKE ${priv.join(', ')} ON ${on} FROM ${lit(name)}@${lit(host)}`
      try {
        await execAs(p, login, sql)
        steps.push(sql)
      } catch (e: any) {
        failed.push(`${on}（${shortErr(e)}）`)
      }
    }
    if (!steps.length) return { ok: false, message: `回收失败：${explainGrantError(failed.join('；'), input.mode)}`, steps }
    const where = dbs.length ? dbs.join('、') : '所有库'
    return {
      ok: true,
      message: failed.length
        ? `已回收 ${where} 上的 ${priv.join(', ')}；以下失败：${failed.join('；')}`
        : `已回收 ${name}@${host} 在 ${where} 上的 ${priv.join(', ')}`,
      steps
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    const why = explainGrantError(msg, input.mode)
    return { ok: false, message: steps.length ? `${why}（已执行 ${steps.length} 条，未回滚）` : why, steps }
  }
}

/** 已授权的结构化条目：界面据此渲染「当前权限」并逐条回收 */
export interface GrantRow {
  /** 展示文本（原样保留数据库返回的那一行） */
  text: string
  /** 角色 / 系统权限 / 对象权限 */
  kind: string
  /** 该行包含的权限（回收时提交） */
  privileges: string[]
  /** MySQL 作用域库名；空串表示 *.* */
  database?: string
  /** Oracle 对象权限的 owner.table */
  table?: string
  /** 是否允许在界面上回收 */
  revocable: boolean
  /** 不可回收的原因 */
  note?: string
}

const shortErr = (e: any): string => {
  const m = String(e?.message ?? e ?? '')
  return m.length > 160 ? `${m.slice(0, 160)}…` : m
}

/** Oracle 标识符：原样双引号包裹（名字来自 DBA_USERS，大小写是权威值） */
function oracleIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`
}

/**
 * 解析 SHOW GRANTS 的一行：
 *   GRANT USAGE ON *.* TO 'u'@'%'
 *   GRANT SELECT, INSERT ON `db`.* TO 'u'@'%'
 * 只保留白名单内的权限——出现未知权限（如 GRANT OPTION 组合）时整行标记为不可回收，
 * 避免 REVOKE 拼出我们没校验过的东西。
 */
function parseMysqlGrantLine(line: string): GrantRow {
  const text = String(line || '').trim()
  const m = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(text)
  if (!m) return { text, kind: '—', privileges: [], revocable: false, note: '无法解析' }
  const rawPrivs = m[1].split(',').map((x) => x.trim().toUpperCase())
  const scope = m[2].trim()
  const dbMatch = /^`([^`]+)`\.\*$/.exec(scope)
  const database = scope === '*.*' ? '' : dbMatch ? dbMatch[1] : ''
  const all = rawPrivs.includes('ALL PRIVILEGES')
  const known = all ? ['ALL PRIVILEGES'] : rawPrivs.filter((x) => MYSQL_REVOKABLE.includes(x))
  const unknown = rawPrivs.filter((x) => !all && !MYSQL_REVOKABLE.includes(x))
  const usageOnly = rawPrivs.every((x) => x === 'USAGE')
  const revocable = !usageOnly && unknown.length === 0 && known.length > 0 && (scope === '*.*' || !!dbMatch)
  return {
    text,
    kind: database ? '库权限' : '全局权限',
    privileges: known,
    database,
    revocable,
    note: usageOnly
      ? 'USAGE 表示「可登录但无权限」，无可回收项'
      : unknown.length
        ? `含未开放回收的项：${unknown.join(', ')}`
        : !revocable
          ? '非库级 / 全局级授权，暂不支持在界面回收'
          : undefined
  }
}

/** 可回收的 MySQL 权限（与 normalizePrivileges 的白名单同源） */
const MYSQL_REVOKABLE = privilegesOf('MYSQL')

/**
 * 查看某个账号的授权。
 * MySQL 用 SHOW GRANTS（一行一条授权）；Oracle 模式没有 SHOW GRANTS，
 * 分别读 DBA_ROLE_PRIVS（角色）、DBA_SYS_PRIVS（系统权限）、DBA_TAB_PRIVS（对象权限）。
 */
export async function grantsAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  input: { name: string; host?: string; mode?: 'MYSQL' | 'ORACLE' }
): Promise<GrantRow[]> {
  const name = assertIdent(input.name, '账号名')
  if (input.mode === 'ORACLE') {
    const user = lit(name.toUpperCase())
    const out: GrantRow[] = []
    // GRANTEE 大小写按实际对象名匹配：Oracle 模式默认大写，但引号创建的账号会保留小写
    const roles = await qAs(p, login, `SELECT GRANTED_ROLE FROM DBA_ROLE_PRIVS WHERE UPPER(GRANTEE) = UPPER(${user})`).catch(() => [])
    for (const r of roles) {
      const role = str(r.GRANTED_ROLE)
      const revocable = ORACLE_REVOKABLE.includes(role.toUpperCase())
      out.push({
        text: `GRANT ${role} TO ${name}`,
        kind: '角色',
        privileges: [role.toUpperCase()],
        revocable,
        note: revocable ? undefined : '不在可回收白名单内'
      })
    }
    const sys = await qAs(p, login, `SELECT PRIVILEGE FROM DBA_SYS_PRIVS WHERE UPPER(GRANTEE) = UPPER(${user})`).catch(() => [])
    for (const r of sys) {
      const priv = str(r.PRIVILEGE).toUpperCase()
      const revocable = ORACLE_REVOKABLE.includes(priv)
      out.push({
        text: `GRANT ${priv} TO ${name}`,
        kind: '系统权限',
        privileges: [priv],
        revocable,
        note: revocable ? undefined : '不在可回收白名单内'
      })
    }
    const tab = await qAs(
      p, login,
      `SELECT OWNER, TABLE_NAME, PRIVILEGE FROM DBA_TAB_PRIVS WHERE UPPER(GRANTEE) = UPPER(${user}) AND ROWNUM <= 200`
    ).catch(() => [])
    for (const r of tab) {
      const owner = str(r.OWNER)
      const tableName = str(r.TABLE_NAME)
      const priv = str(r.PRIVILEGE).toUpperCase()
      const revocable = MYSQL_REVOKABLE.includes(priv) && IDENT.test(owner) && IDENT.test(tableName)
      out.push({
        text: `GRANT ${priv} ON ${owner}.${tableName} TO ${name}`,
        kind: '对象权限',
        privileges: [priv],
        table: `${owner}.${tableName}`,
        revocable,
        note: revocable ? undefined : '不在可回收白名单内'
      })
    }
    return out
  }

  const host = String(input.host || '%').trim() || '%'
  const rows = await qAs(p, login, `SHOW GRANTS FOR ${lit(name)}@${lit(host)}`)
  return rows.map((r) => parseMysqlGrantLine(str(Object.values(r)[0])))
}

/** Oracle 可回收的角色 / 系统权限（与 ORACLE_PRIVILEGES 一致） */
const ORACLE_REVOKABLE = privilegesOf('ORACLE')

// ---------------------------------------------------------------- 表

export interface TenantTableRow {
  name: string
  type: string
  engine: string
  rows: number
  dataBytes: number
  indexBytes: number
  comment: string
  createTime: string
}

/**
 * 库 / Schema 下的表清单。
 *   MySQL 模式：information_schema.TABLES（库 = schema）
 *   Oracle 模式：ALL_TABLES（schema = 用户），DBA_TABLES 权限不够时自动降级
 * 只读，不需要授权能力；但仍需租户凭据（信息在租户内）。
 */
export async function tablesAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  input: { schema: string; mode: 'MYSQL' | 'ORACLE'; limit?: number }
): Promise<TenantTableRow[]> {
  const limit = Math.min(Math.max(Number(input.limit) || 300, 1), 1000)
  const schema = String(input.schema || '').trim()
  if (!schema) return []

  if (input.mode === 'ORACLE') {
    const owner = schema.toUpperCase()
    const sql = (view: string) =>
      `SELECT TABLE_NAME, NUM_ROWS, BLOCKS, LAST_ANALYZED FROM ${view} WHERE OWNER = ? ORDER BY TABLE_NAME`
    let rows: any[] = []
    try {
      rows = await qAs(p, login, sql('DBA_TABLES') + ' FETCH FIRST ' + limit + ' ROWS ONLY', [owner])
    } catch {
      rows = await qAs(p, login, sql('ALL_TABLES') + ' FETCH FIRST ' + limit + ' ROWS ONLY', [owner]).catch(() => [])
    }
    return rows.map((r) => ({
      name: str(r.TABLE_NAME),
      type: 'TABLE',
      engine: '',
      rows: num0(r.NUM_ROWS),
      // 统计信息未收集时 BLOCKS 为空，按 8K 块粗算占用
      dataBytes: num0(r.BLOCKS) * 8192,
      indexBytes: 0,
      comment: '',
      createTime: str(r.LAST_ANALYZED)
    }))
  }

  const rows = await qAs(
    p, login,
    `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, CREATE_TIME, TABLE_COMMENT
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
      LIMIT ${limit}`,
    [schema]
  )
  return rows.map((r) => ({
    name: str(r.TABLE_NAME),
    type: str(r.TABLE_TYPE),
    engine: str(r.ENGINE),
    rows: num0(r.TABLE_ROWS),
    dataBytes: num0(r.DATA_LENGTH),
    indexBytes: num0(r.INDEX_LENGTH),
    comment: str(r.TABLE_COMMENT),
    createTime: str(r.CREATE_TIME)
  }))
}

const num0 = (v: any): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 把 GRANT / REVOKE 的原始报错翻译成"下一步该做什么"。
 *
 * 授权失败的原因其实就那么几种，但 MySQL / OB 的英文报错看不出区别，
 * 用户只能反复重试。这里按错误特征归类，原始报文仍附在后面便于排查。
 */
export function explainGrantError(raw: string, mode: 'MYSQL' | 'ORACLE'): string {
  const m = String(raw || '')
  const rules: { re: RegExp; why: string }[] = [
    { re: /GRANT OPTION/i, why: '当前连接的账号没有 GRANT OPTION，无法把权限授给别人。请改用租户管理员（MySQL: root / Oracle: sys）连接。' },
    { re: /Access denied you need .*privilege|check no privilege|no privilege/i, why: '当前账号缺少执行 GRANT 的权限。请到「用户」页用租户管理员重新录入凭据。' },
    { re: /Access denied for user .* to database/i, why: '当前账号对该库没有授权权限，或目标库不存在。' },
    { re: /Unknown database '?([^']+)'?/i, why: '要授权的库不存在（OB 不会自动建库）。先到「数据库」页确认库名。' },
    { re: /Unknown (MySQL server host|database)/i, why: '目标库或主机不可达。' },
    { re: /Can't find any matching row in the user table|Unknown user|does not exist/i, why: '目标账号不存在，或 Host 不匹配（例如账号是 user@10.% 而这里按 % 授权）。' },
    { re: /ORA-01031/i, why: '权限不足（ORA-01031）：当前账号需要 DBA 角色或 GRANT ANY PRIVILEGE。' },
    { re: /ORA-01917/i, why: '用户或角色不存在（ORA-01917）。' },
    { re: /ORA-01924/i, why: '角色未被授权（ORA-01924），或该角色在实例里不存在。' },
    { re: /ORA-00990/i, why: '权限名不合法（ORA-00990）。' },
    { re: /Access denied/i, why: '登录被拒绝：凭据里的账号或密码不正确，或账号没有该租户的登录权限。' }
  ]
  const hit = rules.find((r) => r.re.test(m))
  return hit ? `${hit.why}\n原始错误：${m}` : m
}

/**
 * 连接自检：确认"到底是谁在连、有没有授权能力"。
 *
 * 授权失败的现场大多不是 SQL 拼错，而是这条连接的身份本身就授不了：
 *   - 用的是普通业务账号（没有 GRANT OPTION），
 *   - 或连的租户与目标租户不是同一个（user@tenant 后缀写错）。
 * 这两个原因从 UI 上都看不出来，只能把 CURRENT_USER / SHOW GRANTS 摊开给用户。
 */
export async function selfCheckAs(
  p: ObDirectPlatform,
  login: TenantLogin,
  mode: 'MYSQL' | 'ORACLE'
): Promise<{ user: string; login: string; version: string; grants: string[]; canGrant: boolean; note: string }> {
  if (mode === 'ORACLE') {
    const rows = await qAs(p, login, 'SELECT USER AS U, SYS_CONTEXT(\'USERENV\', \'SESSION_USER\') AS S FROM DUAL')
    const r0 = rows[0] || {}
    const roles = await qAs(p, login, 'SELECT GRANTED_ROLE FROM USER_ROLE_PRIVS').catch(() => [])
    const names = roles.map((r) => str(r.GRANTED_ROLE))
    const isDba = names.some((x) => x.toUpperCase() === 'DBA')
    return {
      user: str(r0.U),
      login: login.user + '@' + login.tenant,
      version: '',
      grants: names,
      // Oracle 模式的授权能力来自 DBA 角色 / GRANT ANY PRIVILEGE
      canGrant: isDba || names.some((x) => /GRANT ANY/i.test(x)),
      note: isDba ? '当前账号具备 DBA 角色，可以授权' : '当前账号没有 DBA 角色，授权可能被拒绝'
    }
  }

  const rows = await qAs(p, login, 'SELECT CURRENT_USER() AS U, USER() AS L, VERSION() AS V')
  const r0 = rows[0] || {}
  const grantRows = await qAs(p, login, 'SHOW GRANTS').catch(() => [])
  const grants = grantRows.map((r) => str(Object.values(r)[0]))
  // MySQL 语义：只有带 WITH GRANT OPTION 的权限才能继续授给别人
  const canGrant = grants.some((g) => /WITH\s+GRANT\s+OPTION/i.test(g))
  return {
    user: str(r0.U),
    login: str(r0.L) || `${login.user}@${login.tenant}`,
    version: obVersionOf(str(r0.V)),
    grants,
    canGrant,
    note: canGrant
      ? '当前账号带 GRANT OPTION，可以给其它账号授权'
      : '当前账号没有 GRANT OPTION：只能做无授权的操作（OB 里通常是因为用业务账号而非 root/sys 连接）'
  }
}
