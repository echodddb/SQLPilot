import { Client, type ClientChannel } from 'ssh2'
import fs from 'node:fs'
import path from 'node:path'
import type { SshServer } from './types'
import { getPassword } from './secrets'

// SSH 连接池：每台服务器一条长连接（惰性建连，断线重建），密码认证
// 密码来源：DPAPI 加密的 secrets（key = server:<id>），临时密码可覆盖

interface PoolEntry {
  client: Client
  ready: Promise<Client>
}

const pool = new Map<string, PoolEntry>()
const shells = new Map<string, ClientChannel>()

function serverKeyPassword(serverId: string): string {
  return getPassword(`server:${serverId}`)
}

function getEntry(server: SshServer, passwordOverride?: string): PoolEntry {
  let e = pool.get(server.id)
  if (e) return e
  const client = new Client()
  const ready = new Promise<Client>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSH 连接超时：${server.host}:${server.port}`)), 15_000)
    client
      .on('ready', () => {
        clearTimeout(timer)
        resolve(client)
      })
      .on('error', (err: Error) => {
        clearTimeout(timer)
        pool.delete(server.id)
        reject(err)
      })
      .on('close', () => {
        pool.delete(server.id)
      })
      .connect({
        host: server.host,
        port: server.port || 22,
        username: server.user,
        password: passwordOverride ?? serverKeyPassword(server.id),
        readyTimeout: 15_000,
        keepaliveInterval: 15_000
      })
  })
  e = { client, ready }
  pool.set(server.id, e)
  return e
}

async function getClient(server: SshServer, passwordOverride?: string): Promise<Client> {
  const e = getEntry(server, passwordOverride)
  try {
    return await e.ready
  } catch (err) {
    pool.delete(server.id)
    throw err
  }
}

/** 测试连接：返回系统信息 */
export async function testServer(server: SshServer, passwordOverride?: string): Promise<string> {
  const c = await getClient(server, passwordOverride)
  return new Promise<string>((resolve, reject) => {
    c.exec('uname -a || ver', (err, stream) => {
      if (err) return reject(err)
      let out = ''
      stream.on('data', (d: Buffer) => { out += d.toString('utf8') })
      stream.on('close', () => resolve(out.trim() || '连接成功'))
      stream.stderr.on('data', () => { /* 忽略 */ })
    })
  })
}

export interface ExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export async function execCommand(server: SshServer, command: string, timeoutMs = 60_000, passwordOverride?: string): Promise<ExecResult> {
  const c = await getClient(server, passwordOverride)
  return new Promise<ExecResult>((resolve, reject) => {
    c.exec(command, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      let er = ''
      let timedOut = false
      const cap = (s: string, chunk: Buffer) => (s + chunk.toString('utf8')).slice(-64_000)
      stream.on('data', (d: Buffer) => { out = cap(out, d) })
      stream.stderr.on('data', (d: Buffer) => { er = cap(er, d) })
      const timer = setTimeout(() => {
        timedOut = true
        stream.close()
      }, timeoutMs)
      stream.on('close', (code: number | null) => {
        clearTimeout(timer)
        resolve({ exitCode: code, stdout: out.slice(0, 8000), stderr: er.slice(0, 8000), timedOut })
      })
    })
  })
}

export async function readFile(server: SshServer, remotePath: string, maxBytes = 2 * 1024 * 1024, passwordOverride?: string): Promise<{ size: number; content: string }> {
  const c = await getClient(server, passwordOverride)
  const sftp = await new Promise<any>((resolve, reject) => c.sftp((err, s) => (err ? reject(err) : resolve(s))))
  const stat: any = await new Promise((resolve, reject) => sftp.stat(remotePath, (e: Error | null, st: any) => (e ? reject(e) : resolve(st))))
  if (stat.size > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1024)}KB，拒绝读取`)
  const buf = await new Promise<Buffer>((resolve, reject) => sftp.readFile(remotePath, (e: Error | null, d: Buffer) => (e ? reject(e) : resolve(d))))
  return { size: stat.size, content: buf.toString('utf8').slice(0, 20000) }
}

export async function writeFile(server: SshServer, remotePath: string, content: string, passwordOverride?: string): Promise<number> {
  const c = await getClient(server, passwordOverride)
  const sftp = await new Promise<any>((resolve, reject) => c.sftp((err, s) => (err ? reject(err) : resolve(s))))
  await new Promise<void>((resolve, reject) =>
    sftp.writeFile(remotePath, content, (e: Error | null) => (e ? reject(e) : resolve()))
  )
  return Buffer.byteLength(content)
}

/** 远程文件下载到本地路径（项目内） */
export async function getFile(server: SshServer, remotePath: string, localPath: string, passwordOverride?: string): Promise<void> {
  const c = await getClient(server, passwordOverride)
  const sftp = await new Promise<any>((resolve, reject) => c.sftp((err, s) => (err ? reject(err) : resolve(s))))
  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  await new Promise<void>((resolve, reject) =>
    sftp.fastGet(remotePath, localPath, (e: Error | null) => (e ? reject(e) : resolve()))
  )
}

// ---------- 交互式终端（xterm） ----------

export async function openShell(
  termId: string,
  server: SshServer,
  onData: (d: string) => void,
  onExit: () => void,
  passwordOverride?: string
): Promise<void> {
  const c = await getClient(server, passwordOverride)
  c.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err, stream) => {
    if (err) return onExit()
    shells.set(termId, stream)
    stream.on('data', (d: Buffer) => onData(d.toString('utf8')))
    stream.on('close', () => {
      shells.delete(termId)
      onExit()
    })
    stream.stderr.on('data', () => { /* 忽略 */ })
  })
}

export function shellInput(termId: string, data: string): void {
  shells.get(termId)?.write(data)
}

export function shellResize(termId: string, cols: number, rows: number): void {
  shells.get(termId)?.setWindow(rows, cols, 0, 0)
}

export function closeShell(termId: string): void {
  const s = shells.get(termId)
  if (s) {
    shells.delete(termId)
    s.close()
  }
}

// ---------- SFTP（终端面板文件浏览器） ----------

export interface SftpEntry {
  name: string
  isDir: boolean
  size: number
  mtime: number
}

async function getSftp(server: SshServer, passwordOverride?: string): Promise<any> {
  const c = await getClient(server, passwordOverride)
  return new Promise<any>((resolve, reject) => c.sftp((err, s) => (err ? reject(err) : resolve(s))))
}

export async function sftpList(server: SshServer, remotePath: string, passwordOverride?: string): Promise<SftpEntry[]> {
  const sftp = await getSftp(server, passwordOverride)
  const list: any[] = await new Promise((resolve, reject) =>
    sftp.readdir(remotePath, (e: Error | null, l: any[]) => (e ? reject(e) : resolve(l)))
  )
  return list
    .map((f: any) => ({
      name: f.filename,
      // 目录取 S_IFDIR 位 + longname 首字母判断；不能用 mode 奇偶（可执行文件 0755 也是奇数）
      isDir: ((f.attrs?.mode ?? 0) & 0o040000) !== 0 || !!f.longname?.startsWith('d'),
      size: f.attrs?.size ?? 0,
      mtime: (f.attrs?.mtime ?? 0) * 1000
    }))
    .sort((a: SftpEntry, b: SftpEntry) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

export async function sftpDownload(server: SshServer, remotePath: string, localPath: string, passwordOverride?: string): Promise<void> {
  const c = await getClient(server, passwordOverride)
  const sftp = await new Promise<any>((resolve, reject) => c.sftp((err, s) => (err ? reject(err) : resolve(s))))
  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  await new Promise<void>((resolve, reject) =>
    sftp.fastGet(remotePath, localPath, (e: Error | null) => (e ? reject(e) : resolve()))
  )
}

export async function sftpUpload(server: SshServer, localPath: string, remotePath: string, passwordOverride?: string): Promise<void> {
  const c = await getClient(server, passwordOverride)
  const sftp = await new Promise<any>((resolve, reject) => c.sftp((err, s) => (err ? reject(err) : resolve(s))))
  await new Promise<void>((resolve, reject) =>
    sftp.fastPut(localPath, remotePath, (e: Error | null) => (e ? reject(e) : resolve()))
  )
}

export async function closeAll(): Promise<void> {
  for (const id of shells.keys()) closeShell(id)
  for (const e of pool.values()) {
    try { e.client.end() } catch { /* 忽略 */ }
  }
  pool.clear()
}
