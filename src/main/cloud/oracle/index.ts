/**
 * Oracle 云平台的入口：分区调度 + 短时缓存。
 *
 * 缓存 45 秒：DBA 在几个页面之间来回切时不会重复压库，点「刷新」可强制穿透。
 * 只缓存成功结果，失败不进缓存（起库/授权后立刻能看到新状态）。
 */

import { withOracle, oraclePing } from './conn'
import * as S from './sections'
import type { CloudOraclePlatform, OraSectionKey, OraSectionResult, OraSections } from './types'

const TTL_MS = 45_000
const cache = new Map<string, { at: number; res: OraSectionResult }>()

function cacheKey(id: string, section: string, opts: unknown): string {
  return `${id}:${section}:${JSON.stringify(opts || {})}`
}

export function dropOracleCache(id: string, section?: string): void {
  if (!section) {
    for (const k of [...cache.keys()]) if (k.startsWith(`${id}:`)) cache.delete(k)
    return
  }
  for (const k of [...cache.keys()]) if (k.startsWith(`${id}:${section}:`)) cache.delete(k)
}

/** 连接探活 + 版本信息（平台设置页与模块进入时用） */
export async function oracleStatus(p: CloudOraclePlatform): Promise<{ ok: boolean; version?: string; mode?: string; error?: string }> {
  const r = await oraclePing(p)
  return { ok: r.ok, version: r.version, mode: r.mode, error: r.error }
}

async function runSection<K extends OraSectionKey>(
  p: CloudOraclePlatform,
  section: K,
  opts: Record<string, any>
): Promise<{ data: OraSections[K]; warnings: string[] }> {
  return withOracle<{ data: OraSections[K]; warnings: string[] }>(p, async (ctx) => {
    const warnings: string[] = []
    const warn = (m: string) => warnings.push(m)
    let data: unknown
    switch (section) {
      case 'env': data = await S.fetchEnvSummary(ctx, warn); break
      case 'overview': data = await S.fetchOverview(ctx, warn); break
      case 'rac': data = await S.fetchRac(ctx, warn); break
      case 'instances': data = await S.fetchInstances(ctx, warn); break
      case 'pdb': data = await S.fetchPdb(ctx, warn); break
      case 'storage': data = await S.fetchStorage(ctx, warn); break
      case 'sessions': data = await S.fetchSessions(ctx, warn); break
      case 'sql': data = await S.fetchSql(ctx, warn, String(opts.by || 'elapsed')); break
      case 'perf': data = await S.fetchPerf(ctx, warn); break
      case 'alerts': data = await S.fetchAlerts(ctx, warn, Number(opts.hours) || 24); break
      case 'backup': data = await S.fetchBackup(ctx, warn); break
      case 'dg': data = await S.fetchDg(ctx, warn); break
      case 'jobs': data = await S.fetchJobs(ctx, warn); break
      case 'params': data = await S.fetchParams(ctx, warn); break
      case 'users': data = await S.fetchUsers(ctx, warn); break
      default: throw new Error(`未知的 Oracle 数据分区：${section}`)
    }
    // warnings 由外层统一挂载：这里用不可枚举的临时字段传出去太绕，直接包一层返回
    return { data: data as OraSections[K], warnings }
  })
}

/** 取一个分区的数据（带 45 秒缓存，force=true 强制刷新） */
export async function oracleSection<K extends OraSectionKey>(
  p: CloudOraclePlatform,
  section: K,
  opts: Record<string, any> = {},
  force = false
): Promise<OraSectionResult<OraSections[K]>> {
  const key = cacheKey(p.id, section, opts)
  if (!force) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.res, at: new Date(hit.at).toISOString() } as OraSectionResult<OraSections[K]>
  }
  const t0 = Date.now()
  try {
    const r = await runSection(p, section, opts)
    const res: OraSectionResult<OraSections[K]> = {
      ok: true,
      data: r.data,
      warnings: r.warnings,
      ms: Date.now() - t0,
      at: new Date().toISOString()
    }
    cache.set(key, { at: Date.now(), res: res as OraSectionResult })
    return res
  } catch (e: any) {
    return {
      ok: false,
      error: String(e?.message || e).split('\n')[0],
      warnings: [],
      ms: Date.now() - t0,
      at: new Date().toISOString()
    }
  }
}

/** 单条 SQL 全文与执行计划 */
export async function oracleSqlDetail(p: CloudOraclePlatform, sqlId: string): Promise<{ ok: boolean; text?: string; plan?: any[]; error?: string }> {
  try {
    const r = await withOracle(p, (ctx) => S.fetchSqlDetail(ctx, sqlId))
    return { ok: true, text: r.text, plan: r.plan }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).split('\n')[0] }
  }
}

export type { CloudOraclePlatform, OraSectionKey, OraSectionResult, OraSections }
export * from './types'
