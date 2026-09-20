import type { ConnProfile, DbAdapter } from '../types'
import { OracleAdapter } from './oracle'
import { MySqlAdapter } from './mysql'

// 连接池管理：每个连接 profile 对应一个惰性建连的适配器实例

const adapters = new Map<string, DbAdapter>()

export function getAdapter(profile: ConnProfile, globalClientDir?: string): DbAdapter {
  let a = adapters.get(profile.id)
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
  adapters.set(profile.id, a)
  return a
}

export function dropAdapter(id: string): void {
  const a = adapters.get(id)
  if (a) {
    a.close().catch(() => {})
    adapters.delete(id)
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
