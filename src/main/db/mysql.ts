import mysql from 'mysql2/promise'
import type { ConnProfile, DbAdapter, QueryResult, TableInfo } from '../types'
import { getPassword } from '../secrets'
import { classifySql } from './guard'

// MySQL 协议适配器：同时覆盖 MySQL 与 OceanBase MySQL 租户
const SYSTEM_SCHEMAS = new Set([
  'information_schema', 'performance_schema', 'mysql', 'sys',
  'oceanbase', '__public__', 'SYS', 'LBACSYS', 'ORAAUDITOR'
])

export class MySqlAdapter implements DbAdapter {
  kind: string
  private conn: mysql.Connection | null = null
  private connPromise: Promise<mysql.Connection> | null = null

  constructor(
    private profile: ConnProfile,
    /** 测试连接时传入的临时密码（不落盘） */
    private passwordOverride?: string
  ) {
    this.kind = profile.type // 'mysql' | 'ob-mysql'
  }

  private async ensure(): Promise<mysql.Connection> {
    if (this.conn) return this.conn
    if (!this.connPromise) {
      this.connPromise = mysql.createConnection({
        host: this.profile.host,
        port: this.profile.port,
        user: this.profile.user,
        password: this.passwordOverride ?? getPassword(this.profile.id),
        database: this.profile.database || undefined,
        connectTimeout: 10000,
        charset: 'utf8mb4'
      }).then((c) => {
        this.conn = c
        return c
      }).catch((e) => {
        this.connPromise = null
        throw e
      })
    }
    return this.connPromise
  }

  private async destroy(): Promise<void> {
    this.connPromise = null
    if (this.conn) {
      try { await this.conn.end() } catch { /* 忽略 */ }
      this.conn = null
    }
  }

  async connect(): Promise<void> {
    await this.ensure()
  }

  async test(): Promise<string> {
    const c = await this.ensure()
    const [rows] = await c.query<any[]>('SELECT version() AS v')
    let label = `${this.profile.type === 'ob-mysql' ? 'OceanBase(MySQL租户)' : 'MySQL'} ${rows[0]?.v || ''}`
    if (this.profile.type === 'ob-mysql') {
      try {
        const [ob] = await c.query<any[]>('SELECT ob_version() AS v')
        if (ob[0]?.v) label = `OceanBase ${ob[0].v} (MySQL 租户兼容)`
      } catch { /* 社区版可能无此函数 */ }
    }
    return label
  }

  async listSchemas(): Promise<string[]> {
    const c = await this.ensure()
    const [rows] = await c.query<any[]>('SHOW DATABASES')
    return rows.map((r) => String(Object.values(r)[0])).filter((d) => !SYSTEM_SCHEMAS.has(d))
  }

  async listTables(schema: string): Promise<TableInfo[]> {
    const c = await this.ensure()
    const [rows] = await c.query<any[]>(
      'SELECT table_name AS name, CASE table_type WHEN \'VIEW\' THEN \'VIEW\' ELSE \'TABLE\' END AS type FROM information_schema.tables WHERE table_schema = ? ORDER BY type DESC, name',
      [schema]
    )
    return rows.map((r) => ({ name: String(r.name), type: String(r.type) }))
  }

  async describeTable(schema: string, table: string) {
    const c = await this.ensure()
    const [cols] = await c.query<any[]>(
      'SELECT column_name, column_type, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
      [schema, table]
    )
    if (cols.length === 0) throw new Error(`表 ${schema}.${table} 不存在或无权限访问`)
    let approxRows: number | undefined
    try {
      const [tr] = await c.query<any[]>(
        'SELECT table_rows FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
        [schema, table]
      )
      approxRows = Number(tr[0]?.table_rows) || undefined
    } catch { /* 忽略 */ }
    return {
      columns: cols.map((r) => ({ name: String(r.column_name), type: String(r.column_type), nullable: String(r.is_nullable) })),
      approxRows
    }
  }

  async getDdl(schema: string, table: string): Promise<string> {
    const c = await this.ensure()
    try {
      const [rows] = await c.query<any[]>('SHOW CREATE TABLE ??', [[schema, table]])
      return String(Object.values(rows[0])[1] || '')
    } catch {
      const [rows] = await c.query<any[]>(('SHOW CREATE VIEW ??' as any), [[schema, table]])
      return String(Object.values(rows[0])[1] || '')
    }
  }

  async query(sql: string, maxRows: number, timeoutMs: number): Promise<QueryResult> {
    let c = await this.ensure()
    const started = Date.now()
    let res: [any[], any]
    const qp = c.query({ sql, rowsAsArray: true }) as Promise<[any[], any]>
    // 超时后被放弃的查询若再报错，避免 unhandled rejection 拖垮主进程
    qp.catch(() => {})
    try {
      res = await Promise.race([
        qp,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`查询超时（>${timeoutMs}ms），已取消`)), timeoutMs))
      ])
    } catch (e: any) {
      if (/超时/.test(String(e?.message))) {
        await this.destroy()
        throw e
      }
      if (/closed|ECONN|PIPE|QUIT/.test(String(e?.code) + String(e?.message))) {
        // 断连重试仅限只读语句：写语句可能在服务端已提交，盲目重发会重复执行
        if (!classifySql(sql).ok) {
          await this.destroy()
          throw e
        }
        await this.destroy()
        c = await this.ensure()
        res = await c.query({ sql, rowsAsArray: true }) as [any[], any]
      } else {
        throw e
      }
    }
    const fields: any[] = (res[1] as any)?.columns || (res[1] as any) || []
    const columns = Array.isArray(fields) ? fields.map((f: any) => f.name) : []
    // 写语句（INSERT/UPDATE/DELETE/DDL）返回 OkPacket 而非行数组：rowCount 取 affectedRows
    const raw = res[0] as any
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
}
