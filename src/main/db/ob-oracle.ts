import fs from 'node:fs'
import mysql from 'mysql2/promise'
import type { ConnProfile, DbAdapter, EditSupport, QueryResult, TableInfo } from '../types'
import { getPassword } from '../secrets'
import { classifySql } from './guard'

const ORACLE_SYSTEM_OWNERS = new Set([
  'SYS', 'SYSTEM', 'SYSAUX', 'OUTLN', 'XDB', 'ANONYMOUS', 'APPQOSSYS', 'DBSNMP',
  'ORDDATA', 'ORDSYS', 'MDDATA', 'MDSYS', 'OLAPSYS', 'CTXSYS', 'EXFSYS',
  'WMSYS', 'LBACSYS', 'DVSYS', 'DVF', 'AUDSYS', 'GSMADMIN_INTERNAL', 'OJVMSYS',
  '__PUBLIC__', 'ORAAUDITOR'
])

function obIdentity(profile: ConnProfile): string {
  const rawUser = profile.user.trim()
  if (rawUser.includes('@') || rawUser.includes('#')) return rawUser
  const tenant = profile.obTenant?.trim()
  if (!tenant) return rawUser
  if (profile.obConnectMode === 'observer') return `${rawUser}@${tenant}`
  const cluster = profile.obCluster?.trim()
  return `${rawUser}@${tenant}${cluster ? `#${cluster}` : ''}`
}

function sslOptions(profile: ConnProfile) {
  if (!profile.ssl) return undefined
  return {
    ca: profile.sslCa ? fs.readFileSync(profile.sslCa, 'utf8') : undefined,
    rejectUnauthorized: !!profile.sslVerifyServer
  }
}

function queryTimeoutError(ms: number): Error {
  const error = new Error(`查询超时（>${ms}ms），连接已重置`)
  ;(error as any).code = 'SQLPILOT_QUERY_TIMEOUT'
  return error
}

/** OB Oracle 租户使用 OceanBase 线协议传输 Oracle 方言；命名绑定转换为线协议位置绑定。 */
function positionalBinds(sql: string, binds?: any): { sql: string; values?: any[] } {
  if (!binds || Array.isArray(binds)) return { sql, values: binds }
  const values: any[] = []
  const converted = sql.replace(/(?<!:):([A-Za-z_][A-Za-z0-9_$]*)/g, (_text, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(binds, name)) throw new Error(`缺少命名绑定参数 :${name}`)
    values.push(binds[name])
    return '?'
  })
  return { sql: converted, values }
}

export class ObOracleAdapter implements DbAdapter {
  kind = 'ob-oracle'
  private conn: mysql.Connection | null = null
  private connPromise: Promise<mysql.Connection> | null = null
  private opChain: Promise<unknown> = Promise.resolve()

  constructor(
    private profile: ConnProfile,
    private passwordOverride?: string
  ) {}

  private runSerial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.opChain.then(fn, fn)
    this.opChain = task.catch(() => {})
    return task
  }

  private async ensure(): Promise<mysql.Connection> {
    if (this.conn) return this.conn
    if (!this.connPromise) {
      this.connPromise = mysql.createConnection({
        host: this.profile.host,
        port: this.profile.port,
        user: obIdentity(this.profile),
        password: this.passwordOverride ?? getPassword(this.profile.id),
        connectTimeout: 10_000,
        charset: 'utf8mb4',
        ssl: sslOptions(this.profile),
        multipleStatements: false
      }).then(async (connection) => {
        await connection.query('SET autocommit = 0')
        this.conn = connection
        return connection
      }).catch((error) => {
        this.connPromise = null
        throw error
      })
    }
    return this.connPromise
  }

  private async destroy(): Promise<void> {
    this.connPromise = null
    if (this.conn) {
      const connection = this.conn
      this.conn = null
      try { await connection.end() } catch { /* 忽略 */ }
    }
  }

  async connect(): Promise<void> {
    await this.ensure()
  }

  async test(): Promise<string> {
    const tenant = this.profile.obTenant?.trim() || this.profile.user.split('@')[1]?.split('#')[0] || '未知租户'
    const cluster = this.profile.obCluster?.trim() || this.profile.user.split('#')[1] || ''
    const mode = this.profile.obConnectMode === 'observer' ? 'Observer' : 'OBProxy'
    let banner = ''
    try {
      const version = await this.query('SELECT banner FROM v$version WHERE ROWNUM <= 2', 2, 30_000)
      banner = String(version.rows[0]?.[0] || '')
    } catch {
      try {
        const version = await this.query("SELECT 'Oracle ' || version FROM product_component_version WHERE ROWNUM = 1", 1, 30_000)
        banner = String(version.rows[0]?.[0] || '')
      } catch { /* 连接已成功，版本视图权限受限时不阻断测试 */ }
    }
    return `OceanBase ${banner || '（已连接）'} · Oracle 租户 · ${tenant}${cluster ? `#${cluster}` : ''} · ${mode}`
  }

  async listSchemas(): Promise<string[]> {
    const result = await this.query(
      'SELECT owner FROM all_tables GROUP BY owner ORDER BY owner',
      2000, 30_000
    )
    return result.rows.map((row) => String(row[0])).filter((owner) => !ORACLE_SYSTEM_OWNERS.has(owner.toUpperCase()))
  }

  async listTables(schema: string): Promise<TableInfo[]> {
    const result = await this.query(
      `SELECT object_name, object_type FROM all_objects
       WHERE owner = :schema AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW') AND secondary = 'N'
         AND object_name NOT LIKE 'SYS_IOT_OVER_%'
       ORDER BY object_type, object_name`,
      5000, 30_000, { schema: schema.toUpperCase() }
    )
    return result.rows.map((row) => ({
      name: String(row[0]),
      type: row[1] === 'MATERIALIZED VIEW' ? 'VIEW' : String(row[1])
    }))
  }

  async describeTable(schema: string, table: string) {
    const s = schema.toUpperCase()
    const t = table.toUpperCase()
    const result = await this.query(
      `SELECT column_name,
              data_type || CASE
                WHEN char_length > 0 THEN '(' || char_length || ')'
                WHEN data_precision IS NOT NULL THEN '(' || data_precision || CASE WHEN data_scale > 0 THEN ',' || data_scale ELSE '' END || ')'
                ELSE '' END,
              nullable
       FROM all_tab_columns WHERE owner = :schema AND table_name = :table ORDER BY column_id`,
      1000, 30_000, { schema: s, table: t }
    )
    if (!result.rows.length) throw new Error(`表 ${s}.${t} 不存在或无权限访问`)
    let approxRows: number | undefined
    try {
      const statistics = await this.query(
        'SELECT num_rows FROM all_tables WHERE owner = :schema AND table_name = :table',
        1, 30_000, { schema: s, table: t }
      )
      approxRows = Number(statistics.rows[0]?.[0]) || undefined
    } catch { /* 统计视图权限受限时忽略 */ }
    return {
      columns: result.rows.map((row) => ({ name: String(row[0]), type: String(row[1]), nullable: String(row[2]) })),
      approxRows
    }
  }

  async getDdl(schema: string, table: string): Promise<string> {
    const s = schema.toUpperCase()
    const t = table.toUpperCase()
    for (const objectType of ['TABLE', 'VIEW', 'MATERIALIZED VIEW']) {
      try {
        const result = await this.query(
          'SELECT dbms_metadata.get_ddl(:object_type, :table_name, :owner) FROM DUAL',
          1, 30_000, { object_type: objectType, table_name: t, owner: s }
        )
        const ddl = result.rows[0]?.[0]
        if (ddl) return String(ddl)
      } catch { /* 尝试下一种对象类型 */ }
    }
    throw new Error(`无法获取 ${s}.${t} 的 DDL`)
  }

  async editSupport(schema: string, table: string): Promise<EditSupport> {
    let readonlyCols: string[] = []
    try {
      const result = await this.query(
        `SELECT column_name FROM all_tab_cols
         WHERE owner = :schema AND table_name = :table AND virtual_column = 'YES'`,
        500, 30_000, { schema: schema.toUpperCase(), table: table.toUpperCase() }
      )
      readonlyCols = result.rows.map((row) => String(row[0]))
    } catch { /* 旧版本无虚拟列标记时按可更新处理 */ }
    return { editable: true, keyMode: 'rowid', keyCols: [], readonlyCols }
  }

  async query(sql: string, maxRows: number, timeoutMs: number, binds?: any): Promise<QueryResult> {
    return this.runSerial(() => this.queryOnce(sql, maxRows, timeoutMs, binds))
  }

  private async queryOnce(sql: string, maxRows: number, timeoutMs: number, binds?: any): Promise<QueryResult> {
    let connection = await this.ensure()
    const started = Date.now()
    const attempt = async (): Promise<[any[], any]> => {
      const prepared = positionalBinds(sql, binds)
      const queryPromise = connection.query({
        sql: prepared.sql,
        values: prepared.values,
        rowsAsArray: true
      }) as Promise<[any[], any]>
      queryPromise.catch(() => {})
      return Promise.race([
        queryPromise,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(queryTimeoutError(timeoutMs)), timeoutMs))
      ])
    }

    let result: [any[], any]
    try {
      result = await attempt()
    } catch (error: any) {
      if (error?.code === 'SQLPILOT_QUERY_TIMEOUT') {
        await this.destroy()
        throw error
      }
      if (/closed|ECONN|PIPE|QUIT/.test(String(error?.code) + String(error?.message))) {
        if (!classifySql(sql).ok) {
          await this.destroy()
          throw error
        }
        await this.destroy()
        connection = await this.ensure()
        result = await attempt()
      } else {
        throw error
      }
    }

    const fields: any[] = (result[1] as any)?.columns || (result[1] as any) || []
    const columns = Array.isArray(fields) ? fields.map((field) => field.name) : []
    const raw = result[0] as any
    const isRows = Array.isArray(raw)
    const allRows: any[][] = isRows ? raw : []
    const okPacket = isRows ? null : raw
    const truncated = allRows.length > maxRows
    return {
      columns,
      rows: truncated ? allRows.slice(0, maxRows) : allRows,
      rowCount: isRows ? allRows.length : Number(okPacket?.affectedRows ?? 0),
      ms: Date.now() - started,
      truncated
    }
  }

  async close(): Promise<void> {
    await this.destroy()
  }

  async commit(): Promise<boolean> {
    await this.query('COMMIT', 1, 30_000)
    return true
  }
}
