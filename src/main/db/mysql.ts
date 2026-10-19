import mysql from 'mysql2/promise'
import fs from 'node:fs'
import type { ConnProfile, DbAdapter, EditSupport, QueryResult, TableInfo } from '../types'
import { getPassword } from '../secrets'
import { classifySql } from './guard'

// MySQL 协议适配器：同时覆盖 MySQL 与 OceanBase MySQL 租户
export const MYSQL_SYSTEM_SCHEMAS = new Set([
  'information_schema', 'performance_schema', 'mysql', 'sys',
  'oceanbase', '__public__', 'SYS', 'LBACSYS', 'ORAAUDITOR'
])

function obConnectMode(profile: ConnProfile): 'OBProxy' | 'Observer' {
  if (profile.obConnectMode === 'observer') return 'Observer'
  if (profile.obConnectMode === 'obproxy') return 'OBProxy'
  return profile.port === 2881 ? 'Observer' : 'OBProxy'
}

function obIdentity(profile: ConnProfile): string {
  const rawUser = profile.user.trim()
  if (rawUser.includes('@') || rawUser.includes('#')) return rawUser
  const tenant = profile.obTenant?.trim()
  if (!tenant) return rawUser
  if (obConnectMode(profile) === 'Observer') return `${rawUser}@${tenant}`
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

/** 超时哨兵：catch 侧按 code 识别，避免数据库报错文本含"超时"时误杀健康连接 */
function queryTimeoutError(ms: number): Error {
  const e = new Error(`查询超时（>${ms}ms），已取消`)
  ;(e as any).code = 'SQLPILOT_QUERY_TIMEOUT'
  return e
}

export class MySqlAdapter implements DbAdapter {
  kind: string
  private conn: mysql.Connection | null = null
  private connPromise: Promise<mysql.Connection> | null = null
  /** 连接上的操作串行化：单连接上并发 query 会交错（obj:saveEdits 的 START
   *  TRANSACTION 可被并发读取插入，破坏批量原子性）——与 Oracle 适配器对齐 */
  private opChain: Promise<unknown> = Promise.resolve()

  private runSerial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.opChain.then(fn, fn)
    this.opChain = p.catch(() => {})
    return p
  }

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
        user: this.profile.type === 'ob-mysql' ? obIdentity(this.profile) : this.profile.user,
        password: this.passwordOverride ?? getPassword(this.profile.id),
        database: this.profile.database || undefined,
        connectTimeout: 10000,
        charset: 'utf8mb4',
        ssl: sslOptions(this.profile)
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
      // 必须用 destroy()：end() 会等已入队命令（可能正是那条卡死的查询）执行完再发 QUIT，
      // 超时路径会因此永远返回不了，整个 opChain 被占住
      try { this.conn.destroy() } catch { /* 忽略 */ }
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
      let version = rows[0]?.v || ''
      const tenant = this.profile.obTenant?.trim() || this.profile.user.split('@')[1]?.split('#')[0] || '未知租户'
      const cluster = this.profile.obCluster?.trim() || this.profile.user.split('#')[1] || ''
      try {
        const [ob] = await c.query<any[]>('SELECT ob_version() AS v')
        version = ob[0]?.v || version
      } catch { /* 社区版/低版本可能无此函数 */
      }
      label = `OceanBase ${version} · MySQL 租户 · ${tenant}${cluster ? `#${cluster}` : ''} · ${obConnectMode(this.profile)}`
    }
    return label
  }

  async listSchemas(): Promise<string[]> {
    const c = await this.ensure()
    const [rows] = await c.query<any[]>('SHOW DATABASES')
    return rows.map((r) => String(Object.values(r)[0])).filter((d) => !MYSQL_SYSTEM_SCHEMAS.has(d))
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

  /** 网格编辑支持：主键定位行（无主键回退第一个全非空唯一键），生成列不可更新 */
  async editSupport(schema: string, table: string): Promise<EditSupport> {
    const c = await this.ensure()
    // 不能用 GROUP_CONCAT：函数索引的 column_name 为 NULL 会被跳过、超长复合键会被
    // group_concat_max_len 截断，两种退化都会把唯一键解析成"键前缀"，
    // 使网格编辑生成只覆盖部分键的 WHERE → 一次编辑静默改掉多行。
    let stats: any[]
    try {
      const [rows] = await c.query<any[]>(
        `SELECT index_name, column_name, seq_in_index, non_unique, expression
         FROM information_schema.statistics WHERE table_schema = ? AND table_name = ?
         ORDER BY index_name, seq_in_index`,
        [schema, table]
      )
      stats = rows
    } catch {
      // MySQL 5.7 / 部分 OB 版本没有 expression 列
      const [rows] = await c.query<any[]>(
        `SELECT index_name, column_name, seq_in_index, non_unique
         FROM information_schema.statistics WHERE table_schema = ? AND table_name = ?
         ORDER BY index_name, seq_in_index`,
        [schema, table]
      )
      stats = rows
    }
    const [cols] = await c.query<any[]>(
      `SELECT column_name, is_nullable, extra FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
      [schema, table]
    )
    if (!cols.length) throw new Error(`表 ${schema}.${table} 不存在或无权限访问`)
    const nameOf = (r: any) => String(r.column_name ?? r.COLUMN_NAME)
    const nullable = new Set(cols.filter((r) => String(r.is_nullable ?? r.IS_NULLABLE).toUpperCase() === 'YES').map(nameOf))
    // 只读列：仅虚拟/存储生成列。DEFAULT_GENERATED（DEFAULT CURRENT_TIMESTAMP）可正常更新
    const readonlyCols = cols
      .filter((r) => /^(virtual|stored)\s+generated/i.test(String(r.extra ?? r.EXTRA ?? '').trim()))
      .map(nameOf)
    // 按索引聚合（保持 seq_in_index 顺序）；表达式索引列为空，无法逐列等值定位，整条索引不可用
    const indexes = new Map<string, { cols: string[]; uniq: boolean; usable: boolean }>()
    for (const r of stats) {
      const name = String(r.index_name ?? r.INDEX_NAME ?? '')
      const col = r.column_name ?? r.COLUMN_NAME
      const nu = Number(r.non_unique ?? r.NON_UNIQUE ?? 1)
      const expr = r.expression ?? r.EXPRESSION
      let it = indexes.get(name)
      if (!it) {
        it = { cols: [], uniq: nu === 0, usable: true }
        indexes.set(name, it)
      }
      if (nu !== 0) it.uniq = false
      if (!col || (expr !== null && expr !== undefined && String(expr) !== '')) it.usable = false
      else it.cols.push(String(col))
    }
    let keyCols: string[] = []
    const pk = indexes.get('PRIMARY')
    if (pk && pk.usable && pk.cols.length) {
      keyCols = pk.cols
    } else {
      // 唯一键须全列非空：键列含 NULL 时无法可靠定位行
      for (const it of indexes.values()) {
        if (!it.uniq || !it.usable || !it.cols.length) continue
        if (it.cols.every((k) => !nullable.has(k))) {
          keyCols = it.cols
          break
        }
      }
    }
    if (!keyCols.length) {
      return { editable: false, reason: '表没有主键或全非空唯一键，无法定位行', keyMode: 'cols', keyCols: [], readonlyCols }
    }
    return { editable: true, keyMode: 'cols', keyCols, readonlyCols }
  }

  async query(sql: string, maxRows: number, timeoutMs: number, binds?: any[]): Promise<QueryResult> {
    // 串行执行：事务语义（BEGIN/UPDATE/COMMIT 批量编辑）不被同连接并发操作打散
    return this.runSerial(() => this.queryOnce(sql, maxRows, timeoutMs, binds))
  }

  private async queryOnce(sql: string, maxRows: number, timeoutMs: number, binds?: any[]): Promise<QueryResult> {
    let c = await this.ensure()
    const started = Date.now()
    let res: [any[], any]
    /** 单次尝试：query + 超时哨兵（重试路径也必须包，慢库上无限挂） */
    const attempt = (): Promise<[any[], any]> => {
      const qp = c.query({ sql, rowsAsArray: true, values: binds }) as Promise<[any[], any]>
      qp.catch(() => {}) // 超时后被放弃的查询若再报错，避免 unhandled rejection
      return Promise.race([
        qp,
        new Promise<never>((_, rej) => setTimeout(() => rej(queryTimeoutError(timeoutMs)), timeoutMs))
      ])
    }
    try {
      res = await attempt()
    } catch (e: any) {
      if ((e as any)?.code === 'SQLPILOT_QUERY_TIMEOUT') {
        await this.destroy()
        throw e
      }
      if (/closed|ECONN|PIPE|QUIT/.test(String(e?.code) + String(e?.message))) {
        // 断连重试仅限只读语句：写语句可能在服务端已提交，盲目重发会重复执行
        if (!classifySql(sql, 'mysql').ok) {
          await this.destroy()
          throw e
        }
        await this.destroy()
        c = await this.ensure()
        res = await attempt()
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
