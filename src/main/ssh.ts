import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import iconv from 'iconv-lite'
import { app } from 'electron'
import type { SshServer, TermEncoding } from './types'
import { getPassword } from './secrets'
import { loadConfig } from './config'

/**
 * SSH 连接池 + 交互式终端。
 *
 * 三条不变量，改动前先读：
 * 1. 每台服务器一条长连接（池化 key 含全部影响握手的字段），断线自动重建。
 * 2. 跳板机＝先连跳板、再用 forwardOut 起一条 TCP 流、把这条流当 sock 建立到目标的连接；
 *    跳板与目标各自做主机密钥校验（TOFU，known_hosts.json）。
 * 3. 终端编码在**主进程**转换：远端 GBK 机器吐出的字节先按 8bit 收，再 iconv 解成字符串给
 *    xterm；输入反向编码。xterm 永远只看到 JS 字符串，否则中文全是乱码。
 *    多字节字符可能被 TCP 分包切断，所以必须用有状态的 getDecoder/getEncoder，不能逐包 decode。
 */

interface PoolEntry {
  client: Client
  ready: Promise<Client>
  /** 池化 key 快照：配置变化（改主机/认证/跳板）后旧连接必须作废 */
  key: string
  jumpId?: string
}

const pool = new Map<string, PoolEntry>()
const shells = new Map<string, ClientChannel>()
/** 主机密钥不匹配的详细说明：hostVerifier 只能返回布尔值，由 error 回调取出 */
const hostKeyErrors = new Map<string, string>()

// ---------- 主机密钥校验（known_hosts / TOFU） ----------

/**
 * 首次连接记录服务端公钥指纹，之后严格比对。不做校验时 ssh2 会接受任意服务端公钥——
 * 同网段攻击者可伪造 SSH 服务端拿到明文密码。指纹格式与 OpenSSH known_hosts 一致。
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
  hostKeyErrors.set(
    id,
    `SSH 主机密钥与已知记录不一致：${id}\n已记录：${rec}\n本次：${fp}\n` +
      '可能是中间人攻击，或服务器重装过。如确认服务器已重装，请删除 %APPDATA%/sqlpilot/known_hosts.json 中该条目后重连。'
  )
  return false
}

/** 忘记某台服务器的主机密钥（用户确认服务器已重装时调用） */
export function forgetHostKey(host: string, port: number): boolean {
  const id = `${String(host).toLowerCase()}:${Number(port) || 22}`
  const known = loadKnownHosts()
  if (!(id in known)) return false
  delete known[id]
  try { fs.writeFileSync(knownHostsPath(), JSON.stringify(known, null, 2)) } catch { /* 忽略 */ }
  return true
}

// ---------- 认证与跳板 ----------

const EKEY = (id: string) => `server-key:${id}`

/**
 * 认证凭据。私钥认证优先用 keyPath；passphrase 与密码一样走 DPAPI，键 server-key:<id>。
 * 私钥文件读不到时给出明确错误——否则 ssh2 会退化成"尝试无认证"并以
 * "All configured authentication methods failed" 报错，误导用户去查密码。
 */
function authConfig(server: SshServer, passwordOverride?: string, keyPassphraseOverride?: string): Partial<ConnectConfig> {
  if (server.auth === 'key') {
    if (!server.keyPath) throw new Error('认证方式为私钥，但未配置私钥文件路径')
    let privateKey: Buffer
    try {
      privateKey = fs.readFileSync(server.keyPath)
    } catch (e: any) {
      throw new Error(`私钥文件读取失败：${server.keyPath}（${e?.code || e?.message || e}）`)
    }
    const passphrase = keyPassphraseOverride || getPassword(EKEY(server.id))
    return passphrase ? { privateKey, passphrase } : { privateKey }
  }
  return { password: passwordOverride ?? getPassword(`server:${server.id}`) }
}

/** 握手一次，成功 resolve；超时/错误/主机密钥不符都 reject 并清理 */
function connectFresh(server: SshServer, cfg: ConnectConfig): Promise<Client> {
  const client = new Client()
  return new Promise<Client>((resolve, reject) => {
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      try { client.end() } catch { /* 握手未完成，忽略 */ }
      reject(err)
    }
    const timer = setTimeout(
      () => fail(new Error(`SSH 连接超时：${server.host}:${server.port || 22}`)),
      20_000
    )
    client
      .on('ready', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(client)
      })
      .on('error', (err: Error) => {
        clearTimeout(timer)
        const detail = hostKeyErrors.get(hostKeyId(server))
        hostKeyErrors.delete(hostKeyId(server))
        fail(detail ? new Error(detail) : err)
      })
    try {
      client.connect(cfg)
    } catch (e: any) {
      clearTimeout(timer)
      fail(e)
    }
  })
}

/** 跳板机转发：在跳板连接上开一条到目标 host:port 的 TCP 流 */
function forwardOut(jump: Client, host: string, port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    jump.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)))
  })
}

/** 建立到目标服务器的连接（自动处理跳板机；跳板可嵌套，靠递归 + 池化避免重复握手） */
async function connectServer(server: SshServer, passwordOverride?: string, keyPassphraseOverride?: string): Promise<Client> {
  const base: ConnectConfig = {
    host: server.host,
    port: Number(server.port) || 22,
    username: server.user,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    hostVerifier: (key: Buffer) => verifyHostKey(server, key),
    ...authConfig(server, passwordOverride, keyPassphraseOverride)
  }
  if (!server.jumpId) return connectFresh(server, base)

  const jump = loadConfig().servers.find((s) => s.id === server.jumpId)
  if (!jump) throw new Error(`跳板机不存在（可能已删除）：${server.jumpId}`)
  if (jump.id === server.id) throw new Error('跳板机不能是服务器自身')
  const jumpClient = await getSshClient(jump)
  const sock = await forwardOut(jumpClient, server.host, Number(server.port) || 22)
  // sock 模式下 ssh2 不再自己建 TCP，但仍会调 hostVerifier 校验目标主机公钥
  return connectFresh(server, { ...base, sock })
}

/** 池化 key：凡影响握手结果的字段都进 key，改配置后旧连接自动失效 */
function poolKey(server: SshServer): string {
  return [
    server.id,
    server.host,
    Number(server.port) || 22,
    server.user,
    server.auth || 'password',
    server.auth === 'key' ? server.keyPath || '' : '',
    server.jumpId || ''
  ].join('|')
}

export async function getSshClient(server: SshServer, passwordOverride?: string): Promise<Client> {
  const key = poolKey(server)
  const hit = pool.get(server.id)
  if (hit && hit.key === key) {
    try {
      return await hit.ready
    } catch {
      pool.delete(server.id)
    }
  } else if (hit) {
    // 配置已变：旧连接不能再用（认证方式/主机可能都换了）
    pool.delete(server.id)
    // entry.client 在握手完成前只是占位对象，end() 是空操作：真正的连接要等 ready 落地后再关，
    // 否则它成了没人持有、closeAll 也遍历不到的孤儿连接（keepalive 会一直跑）
    try { hit.client.end() } catch { /* 占位对象，忽略 */ }
    hit.ready.then((c) => { try { c.end() } catch { /* 已断开 */ } }, () => { /* 握手失败无需关闭 */ })
  }
  const client = new Client()
  const ready = connectServer(server, passwordOverride)
  const entry: PoolEntry = { client, ready, key, jumpId: server.jumpId }
  pool.set(server.id, entry)
  ready
    .then((c) => {
      // 握手成功后 client 就是实际连接对象：把 close 挂上以便断线自动出池
      c.on('close', () => {
        const cur = pool.get(server.id)
        if (cur && cur.ready === ready) pool.delete(server.id)
      })
      entry.client = c
    })
    .catch(() => {
      const cur = pool.get(server.id)
      if (cur && cur.ready === ready) pool.delete(server.id)
    })
  return ready
}

// ---------- 连接测试 ----------

export interface ServerProbe {
  /** uname -a 或等价信息 */
  label: string
  /** 探测到的编码候选（仅提示，不改配置） */
  locale?: string
  /** 是否走了跳板 */
  viaJump?: string
}

/** 测试连接：返回系统信息；失败抛出可读错误（含跳板环节提示）。
 *  必须走独立连接而不是连接池：要验证的就是"这组凭据能不能连"，命中池里的旧连接会给出错误结论 */
export async function testServer(server: SshServer, passwordOverride?: string, keyPassphraseOverride?: string): Promise<string> {
  const probe = await probeServer(server, passwordOverride, keyPassphraseOverride)
  const tail = probe.viaJump ? `（经跳板 ${probe.viaJump}）` : ''
  const loc = probe.locale ? `\nlocale: ${probe.locale}` : ''
  return probe.label + tail + loc
}

export async function probeServer(server: SshServer, passwordOverride?: string, keyPassphraseOverride?: string): Promise<ServerProbe> {
  let c: Client
  try {
    c = await connectServer(server, passwordOverride, keyPassphraseOverride)
  } catch (e: any) {
    if (server.jumpId) {
      throw new Error(`连接失败${server.jumpId ? '（目标或跳板环节）' : ''}：${e?.message || e}`)
    }
    throw e
  }
  try {
    const out = await execOn(c, 'uname -a 2>/dev/null || ver', 15_000)
    const loc = await execOn(c, 'echo "LANG=$LANG LC_ALL=$LC_ALL"', 8_000).catch(() => ({ stdout: '' }))
    const jump = server.jumpId ? loadConfig().servers.find((s) => s.id === server.jumpId)?.name : undefined
    return {
      label: out.stdout.trim() || '连接成功',
      locale: loc.stdout.replace(/^LANG=/, '').trim() || undefined,
      viaJump: jump
    }
  } finally {
    try { c.end() } catch { /* 已断开 */ }
  }
}

function execOn(c: Client, command: string, timeoutMs: number): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`命令超时：${command.slice(0, 40)}`))
    }, timeoutMs)
    c.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        return reject(err)
      }
      let out = ''
      stream.on('data', (d: Buffer) => { out = (out + d.toString('utf8')).slice(-8_000) })
      stream.stderr.on('data', () => { /* 测试连接忽略 stderr */ })
      stream.on('close', (code: number | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ stdout: out, code })
      })
    })
  })
}

// ---------- 命令执行 ----------

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

export async function execCommand(
  server: SshServer,
  command: string,
  timeoutMs = 60_000,
  passwordOverride?: string,
  signal?: AbortSignal,
  encoding?: TermEncoding
): Promise<ExecResult> {
  const c = await getSshClient(server, passwordOverride)
  const dec = iconv.getDecoder(iconvName(encoding))
  // stderr 也要用有状态解码器：远端错误信息往往正是中文，分包还会把字符切断
  const decErr = iconv.getDecoder(iconvName(encoding))
  return new Promise<ExecResult>((resolve, reject) => {
    let out = ''
    let er = ''
    let timedOut = false
    let aborted = false
    let stream: any = null
    let settled = false
    const cap = (s: string, chunk: string) => (s + chunk).slice(-64_000)
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode: code, stdout: clipHeadTail(out), stderr: clipHeadTail(er), timedOut, aborted })
    }
    const onAbort = () => {
      aborted = true
      try { stream?.close() } catch { /* 已关闭 */ }
      finish(null)
    }
    // 定时器必须在 exec 之前建立：channel 打不开时回调根本不触发（半死连接 / sshd 的 MaxStartups），
    // 建在回调里等于没有超时守卫，Promise 永不 settle
    const timer = setTimeout(() => {
      timedOut = true
      try { stream?.close() } catch { /* 已关闭 */ }
      finish(null)
    }, timeoutMs)
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    c.exec(command, (err, s) => {
      if (err) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
        return
      }
      stream = s
      s.on('data', (d: Buffer) => { out = cap(out, dec.write(d) as string) })
      s.stderr.on('data', (d: Buffer) => { er = cap(er, decErr.write(d) as string) })
      s.on('error', () => { /* 统一由 close 收尾 */ })
      s.on('close', (code: number | null) => finish(code))
    })
  })
}

// ---------- SFTP（终端面板/兼容旧调用） ----------

export interface SftpEntry {
  name: string
  isDir: boolean
  size: number
  mtime: number
}

/**
 * SFTP 子通道统一生命周期：用毕必关（finally end）。此前每次操作新开 channel 从不关闭，
 * 反复浏览/下载会耗尽服务器 MaxSessions，后续 c.sftp() 永久挂起。
 * 通道打开与操作各加一道超时：对端不响应时回调永远不来，IPC 会一直转圈。
 */
export async function withSftp<T>(
  server: SshServer,
  fn: (sftp: any) => Promise<T>,
  passwordOverride?: string,
  timeoutMs = 30_000
): Promise<T> {
  const c = await getSshClient(server, passwordOverride)
  const sftp = await new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('SFTP 通道打开超时（30 秒）')), timeoutMs)
    c.sftp((err, s) => {
      clearTimeout(t)
      err ? reject(err) : resolve(s)
    })
  })
  let timer: any = null
  try {
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`SFTP 操作超时（${Math.round(timeoutMs / 1000)} 秒未响应）`)), timeoutMs)
    })
    return await Promise.race([fn(sftp), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    try {
      const anySftp = sftp as any
      if (typeof anySftp.destroy === 'function') anySftp.destroy()
      else sftp.end()
    } catch { /* 连接可能已断 */ }
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
      isDir: ((f.attrs?.mode ?? 0) & 0o040000) !== 0 || !!f.longname?.startsWith('d'),
      size: f.attrs?.size ?? 0,
      mtime: (f.attrs?.mtime ?? 0) * 1000
    }))
    .sort((a: SftpEntry, b: SftpEntry) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

export async function readFile(server: SshServer, remotePath: string, maxBytes = 2 * 1024 * 1024, passwordOverride?: string): Promise<{ size: number; content: string }> {
  return withSftp(server, async (sftp) => {
    const stat: any = await new Promise((resolve, reject) => sftp.stat(remotePath, (e: Error | null, st: any) => (e ? reject(e) : resolve(st))))
    if (stat.size > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1024)}KB，拒绝读取`)
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

/** 远程文件下载到本地路径（旧接口：无进度，供项目/工具调用） */
export async function getFile(server: SshServer, remotePath: string, localPath: string, passwordOverride?: string): Promise<void> {
  return withSftp(server, async (sftp) => {
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    await new Promise<void>((resolve, reject) =>
      sftp.fastGet(remotePath, localPath, (e: Error | null) => (e ? reject(e) : resolve()))
    )
  }, passwordOverride)
}

export async function sftpDownload(server: SshServer, remotePath: string, localPath: string, passwordOverride?: string): Promise<void> {
  return getFile(server, remotePath, localPath, passwordOverride)
}

export async function sftpUpload(server: SshServer, localPath: string, remotePath: string, passwordOverride?: string): Promise<void> {
  return withSftp(server, async (sftp) => {
    await new Promise<void>((resolve, reject) =>
      sftp.fastPut(localPath, remotePath, (e: Error | null) => (e ? reject(e) : resolve()))
    )
  }, passwordOverride)
}

// ---------- 交互式终端 ----------

const ENC_NAME: Record<TermEncoding, string> = {
  'utf-8': 'utf8',
  gbk: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  latin1: 'latin1'
}

function iconvName(enc?: TermEncoding): string {
  return ENC_NAME[(enc || 'utf-8') as TermEncoding] || 'utf8'
}

export interface ShellOptions {
  cols?: number
  rows?: number
  /** 登录后自动进入的目录 */
  cwd?: string
  /** 远端 locale 对应的编码（缺省 utf-8） */
  encoding?: TermEncoding
  term?: string
}

/** 需要保留状态的编解码器：跨 chunk 的半个汉字不能丢 */
const decoders = new Map<string, any>()
/** 每条终端会话的输入编码（iconv 的 decoder 对象不保证带 encoding 字段，单独记） */
const termEncoding = new Map<string, string>()

/** 只允许可打印目录字符进命令，避免 cwd 里的引号/分号被 shell 解释 */
function shellQuote(p: string): string {
  return `'${String(p).replace(/'/g, `'\\''`)}'`
}

export async function openShell(
  termId: string,
  server: SshServer,
  onData: (d: string) => void,
  onExit: (info?: { code?: number | null }) => void,
  opts: ShellOptions = {}
): Promise<void> {
  const c = await getSshClient(server)
  const cols = Math.min(Math.max(Number(opts.cols) || 80, 2), 500)
  const rows = Math.min(Math.max(Number(opts.rows) || 24, 2), 300)
  const enc = (opts.encoding || server.encoding || 'utf-8') as TermEncoding
  const dec = iconv.getDecoder(iconvName(enc))
  decoders.set(termId, dec)
  termEncoding.set(termId, iconvName(enc))

  return new Promise<void>((resolve, reject) => {
    c.shell({ term: opts.term || 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) {
        decoders.delete(termId)
        termEncoding.delete(termId)
        return reject(err)
      }
      shells.set(termId, stream)
      stream.on('data', (d: Buffer) => {
        try {
          onData(dec.write(d) || '')
        } catch {
          onData(d.toString('utf8'))
        }
      })
      stream.on('close', (code: number | null) => {
        shells.delete(termId)
        decoders.delete(termId)
        termEncoding.delete(termId)
        onExit({ code })
      })
      stream.stderr.on('data', () => { /* 交互 shell 的 stderr 通常已合并 */ })
      if (opts.cwd) {
        // 交互式 shell 没有"工作目录"参数，只能在拿到 prompt 前把 cd 打进 stdin。
        // 不能让用户看到半条命令，所以合成一行命令 + 清行，回显后立即执行。
        const safe = shellQuote(opts.cwd)
        stream.write(`cd ${safe} 2>/dev/null\r`)
      }
      resolve()
    })
  })
}

export function shellInput(termId: string, data: string): void {
  const s = shells.get(termId)
  if (!s) return
  const encName = termEncoding.get(termId) || ''
  // 编码非 UTF-8 时把渲染层的 UTF-8 字符串编成远端字节；纯 ASCII 直接写，省一次转换
  if (encName && encName !== 'utf8' && /[^\x00-\x7F]/.test(data)) {
    try {
      s.write(iconv.encode(data, encName))
      return
    } catch { /* 编码失败退回原样 */ }
  }
  s.write(data)
}

export function shellResize(termId: string, cols: number, rows: number): void {
  shells.get(termId)?.setWindow(rows, cols, 0, 0)
}

export function closeShell(termId: string): void {
  const s = shells.get(termId)
  if (s) {
    shells.delete(termId)
    decoders.delete(termId)
    termEncoding.delete(termId)
    s.close()
  }
}

export function closeAll(): Promise<void> {
  for (const id of [...shells.keys()]) closeShell(id)
  for (const e of pool.values()) {
    try { e.client.end() } catch { /* 忽略 */ }
  }
  pool.clear()
  return Promise.resolve()
}

/** 删除/改动全局服务器时调用：断开它，以及把它当跳板的连接 */
export function dropServer(serverId: string): void {
  const e = pool.get(serverId)
  if (e) {
    pool.delete(serverId)
    try { e.client.end() } catch { /* 忽略 */ }
  }
  for (const [id, entry] of [...pool.entries()]) {
    if (entry.jumpId === serverId) {
      pool.delete(id)
      try { entry.client.end() } catch { /* 忽略 */ }
    }
  }
}

/** 当前池化的连接 id（诊断用） */
export function pooledIds(): string[] {
  return [...pool.keys()]
}
