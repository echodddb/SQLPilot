import oracledb from 'oracledb'
import type { ConnProfile, DbAdapter, QueryResult, TableInfo } from '../types'
import { getPassword } from '../secrets'

oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB]

// 驱动包未带类型声明（见 src/types/shims.d.ts），这里定义用到的最小连接接口
interface OraExecuteResult<T> {
  rows: T[]
  metaData?: { name: string }[]
  rowsAffected?: number
}

interface OraConnection {
  execute<T = any>(sql: string, binds?: any, options?: any): Promise<OraExecuteResult<T>>
  commit(): Promise<void>
  close(): Promise<void>
  callTimeout: number
}

// initOracleClient 全进程只能调一次，这里做防重入
const thickState = { done: false }

export function initThick(libDir?: string): void {
  if (thickState.done) return
  try {
    oracledb.initOracleClient(libDir?.trim() ? { libDir: libDir.trim() } : undefined)
  } catch (e: any) {
    // 不同连接配了不同目录时第二次初始化会报错，忽略即可
    if (!/already been initialized/i.test(String(e?.message))) throw e
  }
  thickState.done = true
}

export class OracleAdapter implements DbAdapter {
  kind = 'oracle'
  private conn: OraConnection | null = null
  private connPromise: Promise<OraConnection> | null = null
  /** 连接上的操作串行化：多会话共用同一 profile 连接时，oracledb 不允许并发 execute */
  private opChain: Promise<unknown> = Promise.resolve()

  private runSerial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.opChain.then(fn, fn)
    this.opChain = p.catch(() => {})
    return p
  }

  constructor(
    private profile: ConnProfile,
    private defaultClientDir?: string,
    /** 测试连接时传入的临时密码（不落盘） */
    private passwordOverride?: string
  ) {}

  private async ensure(): Promise<OraConnection> {
    if (this.conn) {
      try {
        await this.conn.execute('SELECT 1 FROM DUAL', {}, { maxRows: 1 })
        return this.conn
      } catch {
        this.conn = null
        this.connPromise = null
      }
    }
    if (!this.connPromise) {
      this.connPromise = (async () => {
        const libDir = this.profile.instantClientDir || this.defaultClientDir
        if (libDir) initThick(libDir)
        const cs = `${this.profile.host}:${this.profile.port}/${this.profile.serviceName || ''}`
        const c = await oracledb.getConnection({
          user: this.profile.user,
          password: this.passwordOverride ?? getPassword(this.profile.id),
          connectString: cs,
          connectTimeout: 10000
        })
        c.callTimeout = 60000
        this.conn = c
        return c
      })().catch((e) => {
        this.connPromise = null
        throw e
      })
    }
    return this.connPromise
  }

  async connect(): Promise<void> {
    await this.ensure()
  }

  async test(): Promise<string> {
    const c = await this.ensure()
    try {
      const r = await c.execute<string[]>(`SELECT banner FROM v$version WHERE banner LIKE 'Oracle%'`, {}, { maxRows: 2, outFormat: oracledb.OUT_FORMAT_ARRAY })
      return r.rows[0]?.[0] || 'Oracle（已连接）'
    } catch {
      const r = await c.execute<string[]>(`SELECT 'Oracle ' || version FROM product_component_version WHERE ROWNUM = 1`, {}, { maxRows: 1, outFormat: oracledb.OUT_FORMAT_ARRAY })
      return r.rows[0]?.[0] || 'Oracle（已连接）'
    }
  }

  async listSchemas(): Promise<string[]> {
    const c = await this.ensure()
    const r = await c.execute<string[]>(
      `SELECT owner FROM all_tables GROUP BY owner ORDER BY owner`,
      {},
      { maxRows: 2000, outFormat: oracledb.OUT_FORMAT_ARRAY }
    )
    return r.rows.map((x: any) => x[0])
  }

  async listTables(schema: string): Promise<TableInfo[]> {
    const c = await this.ensure()
    const r = await c.execute<any[]>(
      `SELECT object_name, object_type FROM all_objects
       WHERE owner = :s AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW') AND secondary = 'N'
       ORDER BY object_type, object_name`,
      { s: schema.toUpperCase() },
      { maxRows: 5000, outFormat: oracledb.OUT_FORMAT_ARRAY }
    )
    return r.rows.map((x: any) => ({ name: x[0], type: x[1] === 'MATERIALIZED VIEW' ? 'VIEW' : x[1] }))
  }

  async describeTable(schema: string, table: string) {
    const c = await this.ensure()
    const s = schema.toUpperCase()
    const t = table.toUpperCase()
    const cols = await c.execute<any[]>(
      `SELECT column_name,
              data_type || CASE
                WHEN char_length > 0 THEN '(' || char_length || ')'
                WHEN data_precision IS NOT NULL THEN '(' || data_precision || CASE WHEN data_scale > 0 THEN ',' || data_scale ELSE '' END || ')'
                ELSE '' END,
              nullable
       FROM all_tab_columns WHERE owner = :s AND table_name = :t ORDER BY column_id`,
      { s, t },
      { maxRows: 1000, outFormat: oracledb.OUT_FORMAT_ARRAY }
    )
    if (cols.rows.length === 0) throw new Error(`表 ${s}.${t} 不存在或无权限访问`)
    let approxRows: number | undefined
    try {
      const nr = await c.execute<any[]>(
        `SELECT num_rows FROM all_tables WHERE owner = :s AND table_name = :t`,
        { s, t },
        { maxRows: 1, outFormat: oracledb.OUT_FORMAT_ARRAY }
      )
      approxRows = nr.rows[0]?.[0] ?? undefined
    } catch { /* 统计信息不可见时忽略 */ }
    return {
      columns: cols.rows.map((x: any) => ({ name: x[0], type: x[1], nullable: x[2] })),
      approxRows
    }
  }

  async getDdl(schema: string, table: string): Promise<string> {
    const c = await this.ensure()
    const s = schema.toUpperCase()
    const t = table.toUpperCase()
    for (const typ of ['TABLE', 'VIEW', 'MATERIALIZED VIEW']) {
      try {
        const r = await c.execute<string[]>(
          `SELECT dbms_metadata.get_ddl(:typ, :t, :s) FROM DUAL`,
          { typ, t, s },
          { maxRows: 1, outFormat: oracledb.OUT_FORMAT_ARRAY }
        )
        const ddl = r.rows[0]?.[0]
        if (ddl) return ddl
      } catch { /* 尝试下一种对象类型 */ }
    }
    throw new Error(`无法获取 ${s}.${t} 的 DDL`)
  }

  async query(sql: string, maxRows: number, timeoutMs: number): Promise<QueryResult> {
    return this.runSerial(() => this.doQuery(sql, maxRows, timeoutMs))
  }

  private async doQuery(sql: string, maxRows: number, timeoutMs: number): Promise<QueryResult> {
    const c = await this.ensure()
    c.callTimeout = timeoutMs
    const started = Date.now()
    // callTimeout 覆盖单次往返；外层再整体封顶 1.5 倍，超时后重置连接
    const qp = c.execute(sql, {}, { maxRows, outFormat: oracledb.OUT_FORMAT_ARRAY })
    qp.catch(() => {})
    let res: Awaited<typeof qp>
    try {
      res = await Promise.race([
        qp,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`查询超时（>${timeoutMs}ms），连接已重置`)), Math.round(timeoutMs * 1.5))
        )
      ])
    } catch (e) {
      // 只有超时才需要重置连接；普通语句错误（语法/权限等）保持连接，
      // 避免模型"报错-修正-重试"循环里每次失败都付一次完整重连
      if (/超时/.test(String((e as Error)?.message))) {
        this.conn = null
        this.connPromise = null
        c.close().catch(() => {})
      }
      throw e
    }
    const columns = (res.metaData || []).map((m: any) => m.name)
    const rows = (res.rows || []) as any[][]
    return {
      columns,
      rows,
      rowCount: res.rowsAffected != null && rows.length === 0 ? res.rowsAffected : rows.length,
      ms: Date.now() - started
    }
  }

  async close(): Promise<void> {
    this.connPromise = null
    if (this.conn) {
      try { await this.conn.close() } catch { /* 忽略关闭错误 */ }
      this.conn = null
    }
  }

  /** 写操作后显式提交（oracledb 默认关闭自动提交） */
  async commit(): Promise<void> {
    const c = this.conn
    if (c) await this.runSerial(() => c.commit())
  }
}
