import { Client, type ClientChannel } from 'ssh2'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'
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
/** 主机密钥不匹配的详细说明：hostVerifier 只能返回布尔值，由 error 回调取出 */
const hostKeyErrors = new Map<string, string>()

/**
 * 主机密钥校验（known_hosts / TOFU）：首次连接记录服务端公钥指纹，之后严格比对。
 * 不做校验时 ssh2 接受任意服务端公钥——同网段攻击者可伪造 SSH 服务端拿到明文密码。
 * 指纹格式与 OpenSSH known_hosts 一致（SHA256:base64）。
 */
function knownHostsPath(): string {
  return path.join(app.getPath('userData'), 'known_hosts.json')
}

function loadKnownHosts(): Record<string, string> {
  try {
    const v = JSON.parse(fs.readFileSync(knownHostsPath(), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

function hostKeyId(server: SshServer): string {
  return `${server.host.toLowerCase()}:${server.port || 22}`
}

function fingerprint(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

/** 返回 true 表示通过；不匹配时记录原因并返回 false（握手失败） */
function verifyHostKey(server: SshServer, key: Buffer): boolean {
  const id = hostKeyId(server)
  const fp = fingerprint(key)
  const known = loadKnownHosts()
  const rec = known[id]
  if (!rec) {
    known[id] = fp
    try { fs.writeFileSync(knownHostsPath(), JSON.stringify(known, null, 2)) } catch { /* 仅影响下次校验 */ }
    return true
  }
  if (rec === fp) return true
  hostKeyErrors.set(id, `SSH 主机密钥与已知记录不一致：${id}\n已记录：${rec}\n本次：${fp}\n可能是中间人攻击，或服务器重装过。如确认服务器已重装，请删除 %APPDATA%/sqlpilot/known_hosts.json 中该条目后重连。`)
  return false
}

function serverKeyPassword(serverId: string): string {
  return getPassword(`server:${serverId}`)
}

function getEntry(server: SshServer, passwordOverride?: string): PoolEntry {
  let e = pool.get(server.id)
  if (e) return e
  const client = new Client()
  const ready = new Promise<Client>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      pool.delete(server.id)
      try { client.end() } catch { /* 握手未完成，忽略 */ }
      reject(new Error(`SSH 连接超时：${server.host}:${server.port}`))
    }, 15_000)
    client
      .on('ready', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(client)
      })
      .on('error', (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        pool.delete(server.id)
        const detail = hostKeyErrors.get(hostKeyId(server))
        hostKeyErrors.delete(hostKeyId(server))
        reject(detail ? new Error(detail) : err)
      })
      .on('close', () => {
        clearTimeout(timer)
        pool.delete(server.id)
      })
      .connect({
        host: server.host,
        port: server.port || 22,
        username: server.user,
        password: passwordOverride ?? serverKeyPassword(server.id),
        readyTimeout: 15_000,
        keepaliveInterval: 15_000,
        hostVerifier: (key: Buffer) => verifyHostKey(server, key)
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
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`SSH 命令超时：${server.host}`))
    }, 15_000)
    c.exec('uname -a || ver', (err, stream) => {
      if (err) {
        clearTimeout(timer)
        return reject(err)
      }
      let out = ''
      stream.on('data', (d: Buffer) => { out = (out + d.toString('utf8')).slice(-8_000) })
      stream.on('error', (e: Error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(e)
      })
      stream.on('close', () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(out.trim() || '连接成功')
      })
      stream.stderr.on('data', () => { /* 忽略 */ })
    })
  })
}

/** 头尾保留的截断：错误信息通常在末尾，不能只留开头 */
function clipHeadTail(s: string, max = 8_000): string {
  if (s.length <= max) return s
  const half = Math.floor((max - 24) / 2)
  return `${s.slice(0, half)}\n…（中间省略 ${s.length - half * 2} 字符）…\n${s.slice(-half)}`
}

export interface ExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** 用户中止（会话停止）：stream 已关闭，远端进程可能仍在运行 */
  aborted?: boolean
}

export async function execCommand(server: SshServer, command: string, timeoutMs = 60_000, passwordOverride?: string, signal?: AbortSignal): Promise<ExecResult> {
  const c = await getClient(server, passwordOverride)
  return new Promise<ExecResult>((resolve, reject) => {
    c.exec(command, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      let er = ''
      let timedOut = false
      let aborted = false
      const cap = (s: string, chunk: Buffer) => (s + chunk.toString('utf8')).slice(-64_000)
      stream.on('data', (d: Buffer) => { out = cap(out, d) })
      stream.stderr.on('data', (d: Buffer) => { er = cap(er, d) })
      const timer = setTimeout(() => {
        timedOut = true
        stream.close()
      }, timeoutMs)
      const onAbort = () => {
        aborted = true
        stream.close()
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      stream.on('close', (code: number | null) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({ exitCode: code, stdout: clipHeadTail(out), stderr: clipHeadTail(er), timedOut, aborted })
      })
    })
  })
}

export async function readFile(server: SshServer, remotePath: string, maxBytes = 2 * 1024 * 1024, passwordOverride?: string): Promise<{ size: number; content: string }> {
  return withSftp(server, async (sftp) => {
    const stat: any = await new Promise((resolve, reject) => sftp.stat(remotePath, (e: Error | null, st: any) => (e ? reject(e) : resolve(st))))
    if (stat.size > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1024)}KB，拒绝读取`)
    // 流式读取并在超限处立即停止：stat 与实际读取之间文件可能增长（日志正在写）
    const chunks: Buffer[] = []
    let total = 0
    await new Promise<void>((resolve, reject) => {
      const rs = sftp.createReadStream(remotePath)
      rs.on('data', (c: Buffer) => {
        total += c.length
        if (total > maxBytes) {
          rs.destroy()
          reject(new Error(`文件超过 ${Math.round(maxBytes / 1024)}KB，已中止读取`))
          return
        }
        chunks.push(c)
      })
      rs.on('end', () => resolve())
      rs.on('error', (e: Error) => reject(e))
    })
    return { size: total, content: Buffer.concat(chunks).toString('utf8').slice(0, 20000) }
  }, passwordOverride)
}

export async function writeFile(server: SshServer, remotePath: string, content: string, passwordOverride?: string): Promise<number> {
  return withSftp(server, async (sftp) => {
    await new Promise<void>((resolve, reject) =>
      sftp.writeFile(remotePath, content, (e: Error | null) => (e ? reject(e) : resolve()))
    )
    return Buffer.byteLength(content)
  }, passwordOverride)
}

/** 远程文件下载到本地路径（项目内） */
export async function getFile(server: SshServer, remotePath: string, localPath: string, passwordOverride?: string): Promise<void> {
  return withSftp(server, async (sftp) => {
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    await new Promise<void>((resolve, reject) =>
      sftp.fastGet(remotePath, localPath, (e: Error | null) => (e ? reject(e) : resolve()))
    )
  }, passwordOverride)
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

/**
 * SFTP 子通道统一生命周期：用毕必关（finally end）。此前每次操作新开 channel 从不关闭，
 * 反复浏览/下载会耗尽服务器 MaxSessions，后续 c.sftp() 永久挂起。
 */
async function withSftp<T>(server: SshServer, fn: (sftp: any) => Promise<T>, passwordOverride?: string): Promise<T> {
  const c = await getClient(server, passwordOverride)
  const sftp = await new Promise<any>((resolve, reject) => c.sftp((err, s) => (err ? reject(err) : resolve(s))))
  try {
    return await fn(sftp)
  } finally {
    try { sftp.end() } catch { /* 连接可能已断 */ }
  }
}

export async function sftpList(server: SshServer, remotePath: string, passwordOverride?: string): Promise<SftpEntry[]> {
  const list: any[] = await withSftp(server, (sftp) =>
    new Promise((resolve, reject) =>
      sftp.readdir(remotePath, (e: Error | null, l: any[]) => (e ? reject(e) : resolve(l)))
    ), passwordOverride)
  return list
    .map((f: any) => ({
      name: f.filename,
      // 目录取 S_IFDIR 位 + longname 首字母判断；不能用 mode 奇偶（可执行文件 0755 也是奇数）
      isDir: ((f.attrs?.mode ?? 0) & 0o040000) !== 0 || !!f.longname?.startsWith("d"),
      size: f.attrs?.size ?? 0,
      mtime: (f.attrs?.mtime ?? 0) * 1000
    }))
    .sort((a: SftpEntry, b: SftpEntry) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

export async function sftpDownload(server: SshServer, remotePath: string, localPath: string, passwordOverride?: string): Promise<void> {
  return withSftp(server, async (sftp) => {
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    await new Promise<void>((resolve, reject) =>
      sftp.fastGet(remotePath, localPath, (e: Error | null) => (e ? reject(e) : resolve()))
    )
  }, passwordOverride)
}

export async function sftpUpload(server: SshServer, localPath: string, remotePath: string, passwordOverride?: string): Promise<void> {
  return withSftp(server, async (sftp) => {
    await new Promise<void>((resolve, reject) =>
      sftp.fastPut(localPath, remotePath, (e: Error | null) => (e ? reject(e) : resolve()))
    )
  }, passwordOverride)
}

export async function closeAll(): Promise<void> {
  for (const id of shells.keys()) closeShell(id)
  for (const e of pool.values()) {
    try { e.client.end() } catch { /* 忽略 */ }
  }
  pool.clear()
}

/** 删除全局服务器时调用：断开其池化连接。交互 shell 挂在同一 client 上，
 *  连接断开会触发 stream close → 前端 onExit 清理，无需单独追踪归属 */
export function dropServer(serverId: string): void {
  const e = pool.get(serverId)
  if (e) {
    pool.delete(serverId)
    try { e.client.end() } catch { /* 忽略 */ }
  }
}
