/**
 * 直连模式的写操作。
 *
 * 与 OCP 的本质差别：OCP 的写操作进任务框架（可回滚、有子任务进度）；
 * 这里只是对当前实例执行一条 SQL，**没有任务编排、没有回滚**。
 * 所以：
 *   1. 只放行少数几个语义明确、影响可控的操作；
 *   2. 所有入参在拼 SQL 前做严格校验（DDL 无法参数化，只能白名单 + 正则）；
 *   3. 每次调用由 service 层写审计日志。
 */

import { execWrite, q, type ObDirectPlatform } from './conn'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 参数值：数字，或单引号字符串（内部单引号转义） */
function literalOf(value: string): string | null {
  const v = String(value ?? '').trim()
  if (v === '') return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return v
  if (/^(true|false)$/i.test(v)) return v.toUpperCase()
  // 字符串：允许任意内容，转义单引号与反斜杠
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

function assertIdent(name: string, what: string): string {
  const v = String(name ?? '').trim()
  if (!IDENT.test(v)) throw new Error(`${what} 非法：${name}`)
  return v
}

export interface WriteResult {
  ok: boolean
  message: string
}

/** 触发一次大合并（等价于 OCP 集群页的「合并」按钮） */
export async function majorFreeze(p: ObDirectPlatform, password: string): Promise<WriteResult> {
  try {
    await execWrite(p, password, 'ALTER SYSTEM MAJOR FREEZE')
    return { ok: true, message: '已发起合并' }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}

/** 挂起 / 恢复合并 */
export async function setMergeSuspended(
  p: ObDirectPlatform,
  password: string,
  suspended: boolean
): Promise<WriteResult> {
  try {
    await execWrite(p, password, suspended ? 'ALTER SYSTEM SUSPEND MERGE' : 'ALTER SYSTEM RESUME MERGE')
    return { ok: true, message: suspended ? '已挂起合并' : '已恢复合并' }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}

/**
 * 修改参数。
 * tenant 为空 = 集群级（ALTER SYSTEM SET）；非空 = 租户级（ALTER TENANT x SET）。
 * 注意：集群级参数走 sys 租户执行，租户级参数需连到该租户或由 sys 代执行，这里统一由 sys 代执行。
 */
export async function setParameter(
  p: ObDirectPlatform,
  password: string,
  name: string,
  value: string,
  tenant?: string
): Promise<WriteResult> {
  try {
    const param = assertIdent(name, '参数名')
    const lit = literalOf(value)
    if (lit === null) return { ok: false, message: '参数值不能为空' }

    if (tenant) {
      const t = assertIdent(tenant, '租户名')
      await execWrite(p, password, `ALTER TENANT ${t} SET ${param} = ${lit}`)
      return { ok: true, message: `已设置租户 ${t} 参数 ${param} = ${value}` }
    }
    await execWrite(p, password, `ALTER SYSTEM SET ${param} = ${lit}`)
    return { ok: true, message: `已设置参数 ${param} = ${value}` }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}

/** 终止会话（等价于 OCP 的 kill session） */
export async function killSession(
  p: ObDirectPlatform,
  password: string,
  sessionId: number
): Promise<WriteResult> {
  const id = Math.trunc(Number(sessionId))
  if (!Number.isFinite(id) || id <= 0) return { ok: false, message: '会话 ID 非法' }
  try {
    await execWrite(p, password, `KILL ${id}`)
    return { ok: true, message: `已终止会话 ${id}` }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}

/**
 * 未提交事务列表：写操作前给用户看一眼，避免误杀。
 * 用进程列表的 TRANS_STATE 判定（V$OB_TRANSACTION_PARTICIPANTS 在 4.3 单机为空且无列信息）。
 */
export async function openTransactions(
  p: ObDirectPlatform,
  password: string,
  limit = 100
): Promise<{ sessionId: number; tenant: string; user: string; host: string; seconds: number; state: string; sqlId: string }[]> {
  const rows = await q<any>(
    p, password,
    `SELECT ID, TENANT, USER, HOST, TIME, TRANS_STATE, SQL_ID
       FROM oceanbase.GV$OB_PROCESSLIST
      WHERE TRANS_STATE IS NOT NULL AND TRANS_STATE <> ''
      ORDER BY TIME DESC LIMIT ?`,
    [Math.max(1, Math.min(500, limit))]
  )
  return rows.map((r) => ({
    sessionId: Number(r.ID) || 0,
    tenant: String(r.TENANT ?? ''),
    user: String(r.USER ?? ''),
    host: String(r.HOST ?? ''),
    seconds: Math.round(Number(r.TIME) || 0),
    state: String(r.TRANS_STATE ?? ''),
    sqlId: String(r.SQL_ID ?? '')
  }))
}
