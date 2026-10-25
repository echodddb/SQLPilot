import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic'

// 数据库密码经 Windows DPAPI(safeStorage) 加密后存 userData/secrets.json
// { connId: base64(encrypted) }

let cache: Record<string, string> | null = null
/** 读盘失败（文件损坏/被占用）标记：此时绝不允许写回，否则会把整表凭据覆盖掉 */
let loadFailed = false

function file(): string {
  return path.join(app.getPath('userData'), 'secrets.json')
}

function load(): Record<string, string> {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      cache = {}
      return cache
    }
    // 文件存在但读不出/JSON 破损：不能当成空表，先备份再标记，后续写入直接拒绝
    loadFailed = true
    try { fs.copyFileSync(file(), `${file()}.corrupt-${Date.now()}`) } catch { /* 备份失败不阻断读取 */ }
    cache = {}
  }
  return cache!
}

/** 写前守卫：读盘失败时拒绝写入，避免用"空表"覆盖全部已存凭据 */
function assertWritable(): void {
  if (loadFailed) {
    throw new Error('凭据库读取失败（secrets.json 可能已损坏），为避免覆盖全部已存密码已拒绝写入；请检查 %APPDATA%\\sqlpilot\\secrets.json')
  }
}

export function secretsAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function setPassword(connId: string, plain: string): void {
  if (!plain) { deletePassword(connId); return }
  assertWritable()
  const m = load()
  m[connId] = safeStorage.encryptString(plain).toString('base64')
  writeFileAtomic(file(), JSON.stringify(m, null, 2))
}

export function getPassword(connId: string): string {
  const rec = load()[connId]
  if (!rec) return ''
  try {
    return safeStorage.decryptString(Buffer.from(rec, 'base64'))
  } catch {
    return ''
  }
}

export function deletePassword(connId: string): void {
  assertWritable()
  const m = load()
  delete m[connId]
  writeFileAtomic(file(), JSON.stringify(m, null, 2))
}
