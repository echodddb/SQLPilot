/**
 * 直连模式的「租户内部」数据：会话 / 数据库 / 用户 / 参数 / TopSQL。
 *
 * 与 tenant.ts（建/删/锁）分开：那边是 DDL 生命周期，这边是只读取数。
 * 全部按 TENANT_ID 过滤，视图缺失或列差异时返回空数组——界面上表现为「该页不可用」，
 * 而不是整块报错，和 capability.ts 的降级策略保持一致。
 */

import { q, type ObDirectPlatform } from './conn'

const str = (v: any): string => (v === undefined || v === null ? '' : String(v))
const num = (v: any): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export interface ObTenantSession {
  id: number
  user: string
  host: string
  db: string
  command: string
  seconds: number
  state: string
  sqlId: string
  sql: string
  transState: string
}

/** 该租户的会话（GV$OB_PROCESSLIST；无 GV$ 时退化到 V$） */
export async function tenantSessionsOf(
  p: ObDirectPlatform,
  password: string,
  tenantName: string,
  limit = 200
): Promise<ObTenantSession[]> {
  const n = Math.max(1, Math.min(500, limit))
  const name = String(tenantName || '').trim()
  if (!name) return []

  const attempts = [
    `SELECT * FROM oceanbase.GV$OB_PROCESSLIST WHERE TENANT = ? ORDER BY TIME DESC LIMIT ?`,
    `SELECT * FROM oceanbase.V$OB_PROCESSLIST WHERE TENANT = ? ORDER BY TIME DESC LIMIT ?`
  ]
  for (const sql of attempts) {
    try {
      const rows = await q<any>(p, password, sql, [name, n])
      return rows.map((r) => ({
        id: num(r.ID),
        user: str(r.USER),
        host: str(r.HOST),
        db: str(r.DB),
        command: str(r.COMMAND),
        seconds: Math.round(num(r.TIME) || 0),
        state: str(r.STATE),
        sqlId: str(r.SQL_ID),
        sql: str(r.INFO).slice(0, 2000),
        transState: str(r.TRANS_STATE)
      }))
    } catch {
      // 换下一个视图；都失败则返回空
    }
  }
  return []
}

export interface ObTenantDatabase {
  name: string
  collation: string
  readOnly: string
}

/** 该租户的数据库（DBA_OB_DATABASES） */
export async function tenantDatabasesOf(
  p: ObDirectPlatform,
  password: string,
  tenantId: number
): Promise<ObTenantDatabase[]> {
  try {
    const rows = await q<any>(
      p, password,
      'SELECT * FROM oceanbase.DBA_OB_DATABASES WHERE TENANT_ID = ? ORDER BY DATABASE_NAME',
      [tenantId]
    )
    return rows.map((r) => ({
      name: str(r.DATABASE_NAME),
      collation: str(r.COLLATION),
      readOnly: str(r.READ_ONLY)
    }))
  } catch {
    return []
  }
}

export interface ObTenantUser {
  name: string
  host: string
  info: string
  locked: boolean
}

/** 该租户的用户（DBA_OB_USERS）；Oracle 模式的账号体系同样落在这张视图 */
export async function tenantUsersOf(
  p: ObDirectPlatform,
  password: string,
  tenantId: number
): Promise<ObTenantUser[]> {
  try {
    const rows = await q<any>(
      p, password,
      'SELECT * FROM oceanbase.DBA_OB_USERS WHERE TENANT_ID = ? ORDER BY USER_NAME',
      [tenantId]
    )
    return rows.map((r) => ({
      name: str(r.USER_NAME),
      host: str(r.HOST),
      info: str(r.INFO),
      locked: str(r.LOCKED).toUpperCase() === 'YES'
    }))
  } catch {
    return []
  }
}

export interface ObTenantParameter {
  name: string
  value: string
  defaultValue: string
  editLevel: string
  info: string
}

/** 该租户的参数（GV$OB_PARAMETERS 按 TENANT_ID 过滤，同名取第一条） */
export async function tenantParametersOf(
  p: ObDirectPlatform,
  password: string,
  tenantId: number,
  opts: { keyword?: string; limit?: number } = {}
): Promise<ObTenantParameter[]> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 300))
  const kw = String(opts.keyword || '').trim()
  try {
    const rows = kw
      ? await q<any>(
          p, password,
          `SELECT * FROM oceanbase.GV$OB_PARAMETERS WHERE TENANT_ID = ? AND (NAME LIKE ? OR INFO LIKE ?)
            ORDER BY NAME LIMIT ?`,
          [tenantId, `%${kw}%`, `%${kw}%`, limit]
        )
      : await q<any>(
          p, password,
          'SELECT * FROM oceanbase.GV$OB_PARAMETERS WHERE TENANT_ID = ? ORDER BY NAME LIMIT ?',
          [tenantId, limit]
        )
    const seen = new Set<string>()
    const out: ObTenantParameter[] = []
    for (const r of rows) {
      const name = str(r.NAME)
      if (seen.has(name)) continue
      seen.add(name)
      out.push({
        name,
        value: str(r.VALUE),
        defaultValue: str(r.DEFAULT_VALUE),
        editLevel: str(r.EDIT_LEVEL),
        info: str(r.INFO)
      })
    }
    return out
  } catch {
    return []
  }
}

export interface ObTenantTopSql {
  sqlId: string
  sqlText: string
  executions: number
  avgElapsedMs: number
  maxElapsedMs: number
  rowsOut: number
  retCode: number
  lastUs: number
}

/**
 * 该租户的 TopSQL。
 * 与集群级 topSqlOf 的差别：这里多一个 TENANT_ID 过滤，指标口径保持一致
 * （REQUEST_TIME 是微秒 epoch；按 SQL_ID 聚合而不是对长文本 GROUP BY）。
 */
export async function tenantTopSqlOf(
  p: ObDirectPlatform,
  password: string,
  tenantId: number,
  opts: { hours?: number; limit?: number } = {}
): Promise<ObTenantTopSql[]> {
  const hours = Math.max(1, Math.min(24 * 7, opts.hours ?? 24))
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
  const views = ['GV$OB_SQL_AUDIT', 'V$OB_SQL_AUDIT']
  for (const view of views) {
    try {
      const rows = await q<any>(
        p, password,
        `SELECT SQL_ID, MIN(QUERY_SQL) AS QUERY_SQL, COUNT(*) AS EXEC,
                AVG(ELAPSED_TIME)/1000 AS AVG_MS, MAX(ELAPSED_TIME)/1000 AS MAX_MS,
                SUM(RETURN_ROWS) AS ROWS_OUT, MIN(RET_CODE) AS RC, MAX(REQUEST_TIME) AS LAST_US
           FROM oceanbase.${view}
          WHERE TENANT_ID = ?
            AND REQUEST_TIME >= (UNIX_TIMESTAMP() - ? * 3600) * 1000000
            AND SQL_ID IS NOT NULL AND SQL_ID <> ''
          GROUP BY SQL_ID
          ORDER BY AVG_MS DESC
          LIMIT ?`,
        [tenantId, hours, limit]
      )
      return rows.map((r) => ({
        sqlId: str(r.SQL_ID),
        sqlText: str(r.QUERY_SQL).slice(0, 2000),
        executions: num(r.EXEC),
        avgElapsedMs: Math.round(num(r.AVG_MS) * 100) / 100,
        maxElapsedMs: Math.round(num(r.MAX_MS) * 100) / 100,
        rowsOut: num(r.ROWS_OUT),
        retCode: num(r.RC),
        lastUs: num(r.LAST_US)
      }))
    } catch {
      // 换下一个审计视图
    }
  }
  return []
}
