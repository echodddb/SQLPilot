import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic'

// 数据库密码经 Windows DPAPI(safeStorage) 加密后存 userData/secrets.json
// { connId: base64(encrypted) }

let cache: Record<string, string> | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'secrets.json')
}

function load(): Record<string, string> {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    cache = {}
  }
  return cache!
}

export function secretsAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function setPassword(connId: string, plain: string): void {
  if (!plain) { deletePassword(connId); return }
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
  const m = load()
  delete m[connId]
  writeFileAtomic(file(), JSON.stringify(m, null, 2))
}
