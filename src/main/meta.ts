import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic'

// 元数据缓存（DBeaver 式）：schema/表/列结构/可编辑性等慢查询结果缓存到 userData/meta-cache.json，
// 重启后对象树秒开；⟳ 强制重读，应用内发生的 DDL 自动失效。
// 注意：应用外做的 DDL 不会失效缓存，需用户手动刷新——与 DBeaver 行为一致。

interface MetaEntry {
  at: number
  data: any
}

/** 条目上限：超出按写入时间淘汰最旧（每条是表/列清单，2000 条已覆盖绝大多数库） */
const MAX_ENTRIES = 2000

let cache: Record<string, MetaEntry> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'meta-cache.json')
}

function load(): Record<string, MetaEntry> {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    cache = {}
  }
  return cache!
}

function flush(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const c = load()
      const keys = Object.keys(c)
      if (keys.length > MAX_ENTRIES) {
        // 按写入时间淘汰最旧
        for (const k of keys.sort((a, b) => c[a].at - c[b].at).slice(0, keys.length - MAX_ENTRIES)) {
          delete c[k]
        }
      }
      writeFileAtomic(file(), JSON.stringify(c))
    } catch { /* 缓存写盘失败不影响功能 */ }
  }, 1000)
  saveTimer.unref?.()
}

export function metaGet<T>(key: string): T | undefined {
  return load()[key]?.data as T | undefined
}

export function metaSet(key: string, data: any): void {
  const c = load()
  c[key] = { at: Date.now(), data }
  flush()
}

/** 按前缀失效（如某连接的全部条目）。key 约定以 `${kind}:${connId}` 开头 */
export function metaDropPrefix(prefix: string): void {
  const c = load()
  let hit = false
  for (const k of Object.keys(c)) {
    if (k.startsWith(prefix)) {
      delete c[k]
      hit = true
    }
  }
  if (hit) flush()
}

/** 失效某连接的全部缓存条目（key 格式统一为 `${kind}:${connId}:...`）。DDL 后/连接变更时调用 */
export function metaDropConn(connId: string): void {
  const c = load()
  let hit = false
  for (const k of Object.keys(c)) {
    if (k.split(':')[1] === connId) {
      delete c[k]
      hit = true
    }
  }
  if (hit) flush()
}

/** 缓存 key 统一构造（schema/table 由调用方按连接类型规范化大小写后传入）。
 *  约定：kind 与 connId 均不能包含冒号——metaDropConn 靠 `k.split(':')[1]` 定位连接段 */
export const metaKeys = {
  schemas: (connId: string) => `schemas:${connId}`,
  tables: (connId: string, schema: string) => `tables:${connId}:${schema}`,
  describe: (connId: string, schema: string, table: string) => `describe:${connId}:${schema}.${table}`,
  edit: (connId: string, schema: string, table: string) => `edit:${connId}:${schema}.${table}`,
  version: (connId: string) => `version:${connId}`
}

/** 读穿缓存：命中直接返回，未命中（或强制刷新）执行 loader 并回填 */
export async function cached<T>(key: string, refresh: boolean, loader: () => Promise<T>): Promise<T> {
  if (!refresh) {
    const hit = metaGet<T>(key)
    if (hit !== undefined) return hit
  }
  const data = await loader()
  metaSet(key, data)
  return data
}
