import type { ConnProfile, DbAdapter } from '../types'
import { OracleAdapter } from './oracle'
import { MySqlAdapter } from './mysql'

// 连接池：默认每个连接 profile 一个共享适配器（agent/信息面板/对象浏览器用）；
// 带 sessionKey 时每个会话键独立一条连接（SQL 控制台的每个查询窗口 = 独立数据库会话，事务互不可见）
const adapters = new Map<string, DbAdapter>()

export function adapterPoolKey(profileId: string, sessionKey?: string): string {
  return sessionKey ? `${profileId}::${sessionKey}` : profileId
}

export function getAdapter(profile: ConnProfile, globalClientDir?: string, sessionKey?: string): DbAdapter {
  const key = adapterPoolKey(profile.id, sessionKey)
  let a = adapters.get(key)
  if (a) return a
  if (profile.type === 'oracle') {
    a = new OracleAdapter(profile, globalClientDir)
  } else {
    // ob-oracle 租户在 M1 阶段暂未接入驱动，占位提示
    if (profile.type === 'ob-oracle') {
      throw new Error('OB Oracle 租户支持将在 M2 阶段接入（pyobclient），当前版本请使用 OB MySQL 租户连接')
    }
    a = new MySqlAdapter(profile)
  }
  adapters.set(key, a)
  return a
}

/** 释放适配器；不带 sessionKey 时连同该连接的所有窗口级会话一起释放 */
export function dropAdapter(id: string, sessionKey?: string): void {
  const keys = sessionKey ? [adapterPoolKey(id, sessionKey)] : [id]
  if (!sessionKey) {
    for (const k of adapters.keys()) {
      if (k.startsWith(`${id}::`)) keys.push(k)
    }
  }
  for (const k of keys) {
    const a = adapters.get(k)
    if (a) {
      a.close().catch(() => {})
      adapters.delete(k)
    }
  }
}

export async function closeAll(): Promise<void> {
  for (const a of adapters.values()) {
    try { await a.close() } catch { /* 忽略 */ }
  }
  adapters.clear()
}

export function resolveConnection(list: ConnProfile[], ref: string): ConnProfile {
  const c = list.find((x) => x.id === ref || x.name === ref || x.name.toLowerCase() === String(ref).toLowerCase())
  if (!c) {
    throw new Error(`找不到连接 "${ref}"。可用连接: ${list.map((x) => x.name).join(', ') || '(无)'}`)
  }
  return c
}
