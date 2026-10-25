import fs from 'node:fs'
import path from 'node:path'
import type { Client } from 'ssh2'
import type { SshServer } from './types'
import { getSshClient } from './ssh'

/**
 * SFTP 文件操作层。
 *
 * 与 ssh.ts 的职责切分：ssh.ts 管连接池与终端（长时间占用 channel），这里管文件传输
 * （每次操作短生命周期的 SFTP channel）。分开的原因是可测性——本文件除 getSshClient
 * 外不依赖 Electron，便于用假 client 跑单测。
 *
 * 三个必须记住的约束：
 * 1. 每个 SFTP channel 用完必须 end()，否则反复浏览会耗尽服务端 MaxSessions，
 *    之后所有 c.sftp() 永久挂起（历史 bug）。
 * 2. ssh2 v1 没有 filenameEncoding 选项，文件名一律按 UTF-8 解码。GBK 机器上的文件名
 *    乱码无法在库层修正，只能在 UI 提示；文件内容编码由调用方传入。
 * 3. 传输用 createReadStream/createWriteStream 自己 pipe 而不是 fastPut/fastGet，
 *    这样才能在用户取消时 destroy 掉流（fastPut 没有中断接口）。
 */

export interface SftpEntry {
  name: string
  isDir: boolean
  isLink: boolean
  size: number
  /** 毫秒时间戳 */
  mtime: number
  /** 权限位（0o755 形式） */
  mode: number
  /** rwxr-xr-x */
  perms: string
  uid?: number
  gid?: number
}

export interface TransferProgress {
  transferred: number
  total: number
}

function permString(mode: number): string {
  const bit = (n: number, c: string) => (mode & n ? c : '-')
  return (
    bit(0o400, 'r') + bit(0o200, 'w') + bit(0o100, 'x') +
    bit(0o040, 'r') + bit(0o020, 'w') + bit(0o010, 'x') +
    bit(0o004, 'r') + bit(0o002, 'w') + bit(0o001, 'x')
  )
}

/**
 * 统一 SFTP channel 生命周期：用毕必关。
 *
 * 附加超时：sfpt 请求发出后如果对端不响应（非标准服务端、连接半死），回调永远不会来，
 * 上层 IPC 就会永久挂起、UI 一直转圈。30 秒兜底失败比无限等待好排查得多。
 */
export async function withSftp<T>(server: SshServer, fn: (sftp: any) => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const c = await getSshClient(server)
  const sftp = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SFTP 通道打开超时（30 秒）')), timeoutMs)
    c.sftp((err, s) => {
      clearTimeout(timer)
      err ? reject(err) : resolve(s)
    })
  })
  let timer: any = null
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`SFTP 操作超时（${Math.round(timeoutMs / 1000)} 秒未响应）`)), timeoutMs)
    })
    return await Promise.race([fn(sftp), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    try { sftp.end() } catch { /* 连接可能已断 */ }
  }
}

function call<T = any>(sftp: any, method: string, ...args: any[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    sftp[method](...args, (e: Error | null, r: T) => (e ? reject(e) : resolve(r)))
  })
}

export function normalizeRemotePath(p: string): string {
  const raw = String(p || '.').replace(/\\/g, '/')
  if (!raw) return '.'
  const abs = raw.startsWith('/')
  const parts: string[] = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop()
      else if (!abs) parts.push('..')
      continue
    }
    parts.push(seg)
  }
  const joined = parts.join('/')
  if (abs) return '/' + joined
  return joined || '.'
}

export function joinRemote(dir: string, name: string): string {
  const d = String(dir || '').replace(/\/+$/, '')
  return d ? `${d}/${name}` : `/${name}`
}

/** 父目录（根目录返回自身） */
export function parentRemote(p: string): string {
  const n = normalizeRemotePath(p)
  if (n === '/') return '/'
  const i = n.lastIndexOf('/')
  if (i < 0) return '.'
  return n.slice(0, i) || '/'
}

export async function listDir(server: SshServer, remotePath: string): Promise<SftpEntry[]> {
  const p = normalizeRemotePath(remotePath)
  const list: any[] = await withSftp(server, (sftp) => call(sftp, 'readdir', p))
  return list
    .map((f: any) => {
      const mode = f.attrs?.mode ?? 0
      const typeBits = mode & 0o170000
      return {
        name: f.filename,
        // 目录判定：S_IFDIR 位；兼容只给了 longname 的服务端
        isDir: typeBits === 0o040000 || (typeBits === 0 && !!f.longname?.startsWith('d')),
        isLink: typeBits === 0o120000,
        size: f.attrs?.size ?? 0,
        mtime: (f.attrs?.mtime ?? 0) * 1000,
        mode: mode & 0o777,
        perms: permString(mode & 0o777),
        uid: f.attrs?.uid,
        gid: f.attrs?.gid
      }
    })
    // 隐藏文件排在最后，目录优先——和资源管理器一致
    .sort((a: SftpEntry, b: SftpEntry) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    })
}

export async function statPath(server: SshServer, remotePath: string): Promise<SftpEntry & { exists: boolean }> {
  try {
    const st: any = await withSftp(server, (sftp) => call(sftp, 'stat', normalizeRemotePath(remotePath)))
    const mode = st?.mode ?? 0
    const typeBits = mode & 0o170000
    return {
      name: normalizeRemotePath(remotePath).split('/').pop() || '/',
      isDir: typeBits === 0o040000,
      isLink: typeBits === 0o120000,
      size: st?.size ?? 0,
      mtime: (st?.mtime ?? 0) * 1000,
      mode: mode & 0o777,
      perms: permString(mode & 0o777),
      uid: st?.uid,
      gid: st?.gid,
      exists: true
    }
  } catch {
    // stat 失败通常就是不存在；真权限问题在后续操作里会再次报错
    return { name: '', isDir: false, isLink: false, size: 0, mtime: 0, mode: 0, perms: '', exists: false }
  }
}

export async function mkdir(server: SshServer, remotePath: string): Promise<void> {
  await withSftp(server, (sftp) => call(sftp, 'mkdir', normalizeRemotePath(remotePath)))
}

export async function rename(server: SshServer, from: string, to: string): Promise<void> {
  await withSftp(server, (sftp) => call(sftp, 'rename', normalizeRemotePath(from), normalizeRemotePath(to)))
}

/** 递归删除。符号链接只删链接本身，绝不跟随——否则可能误删链接指向的系统目录 */
export async function removePath(server: SshServer, remotePath: string, recursive = true): Promise<number> {
  let removed = 0
  const walk = async (sftp: any, p: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error('目录层级过深（>32），已中止以防递归环')
    const st = await call<any>(sftp, 'lstat', p).catch(() => null)
    if (!st) return
    const isDir = (st.mode & 0o170000) === 0o040000
    if (!isDir) {
      await call(sftp, 'unlink', p)
      removed++
      return
    }
    const kids: any[] = await call(sftp, 'readdir', p).catch(() => [])
    if (kids.length && !recursive) throw new Error('目录非空，需勾选递归删除')
    for (const k of kids) {
      if (k.filename === '.' || k.filename === '..') continue
      await walk(sftp, `${p.replace(/\/+$/, '')}/${k.filename}`, depth + 1)
    }
    await call(sftp, 'rmdir', p)
    removed++
  }
  await withSftp(server, (sftp) => walk(sftp, normalizeRemotePath(remotePath), 0))
  return removed
}

export async function chmod(server: SshServer, remotePath: string, mode: number): Promise<void> {
  await withSftp(server, (sftp) => call(sftp, 'chmod', normalizeRemotePath(remotePath), mode & 0o777))
}

export async function readText(server: SshServer, remotePath: string, maxBytes: number, encoding: string): Promise<{ content: string; size: number; truncated: boolean }> {
  const iconv = await import('iconv-lite')
  return withSftp(server, async (sftp) => {
    const st: any = await call(sftp, 'stat', normalizeRemotePath(remotePath))
    const size = st?.size ?? 0
    const limit = Math.max(1024, maxBytes)
    const chunks: Buffer[] = []
    let total = 0
    // 流式读并在超限处停下：stat 与实际读取之间文件可能被写大（日志）
    await new Promise<void>((resolve, reject) => {
      const rs = sftp.createReadStream(normalizeRemotePath(remotePath), { start: 0, end: limit - 1 })
      rs.on('data', (c: Buffer) => {
        total += c.length
        if (total > limit) {
          rs.destroy()
          resolve()
          return
        }
        chunks.push(c)
      })
      rs.on('end', () => resolve())
      rs.on('error', (e: Error) => reject(e))
    })
    const buf = Buffer.concat(chunks)
    return { content: iconv.decode(buf, encoding as any), size, truncated: size > buf.length }
  })
}

export async function writeText(server: SshServer, remotePath: string, content: string, encoding: string): Promise<number> {
  const iconv = await import('iconv-lite')
  const buf = iconv.encode(content, encoding as any)
  // 编码不了的字会被 iconv 静默替换成 '?'：先回读一遍，不一致直接拒绝，别把原文件改坏
  if (iconv.decode(buf, encoding as any) !== content) {
    throw new Error(`内容包含 ${encoding} 无法表示的字符，已取消保存（请改用 UTF-8）`)
  }
  const target = normalizeRemotePath(remotePath)
  const name = target.split('/').pop() || 'file'
  const dir = target.replace(/\/[^/]*$/, '') || '/'
  // 同目录临时文件 + rename：直接 writeFile 是 O_TRUNC，断网/超时会把远端配置截成半截
  const tmp = `${dir}/.${name}.sqlpilot-${Date.now()}.tmp`
  await withSftp(server, async (sftp) => {
    await call(sftp, 'writeFile', tmp, buf)
    try {
      await call(sftp, 'rename', tmp, target)
    } catch (e) {
      await call(sftp, 'unlink', tmp).catch(() => { /* 清理失败忽略 */ })
      throw e
    }
  })
  return buf.length
}

/**
 * 传输专用通道：不设总时长上限，改成"连续 idleMs 没有任何进展才失败"。
 * 原先 upload/download 共用 30 秒总超时，500MB 文件或几百个小文件的目录必然被误判为无响应，
 * 随后 finally 里的 end() 把管道掐断，远端/本地留下半截文件。
 */
async function withSftpIdle<T>(
  server: SshServer,
  fn: (sftp: any, bump: () => void) => Promise<T>,
  idleMs = 60_000
): Promise<T> {
  const c = await getSshClient(server)
  const sftp = await new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('SFTP 通道打开超时（30 秒）')), 30_000)
    c.sftp((err, s) => {
      clearTimeout(t)
      err ? reject(err) : resolve(s)
    })
  })
  let timer: any = null
  let stall: ((e: Error) => void) | null = null
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => stall?.(new Error(`SFTP 传输中断：${Math.round(idleMs / 1000)} 秒没有任何进展`)), idleMs)
  }
  try {
    const stallP = new Promise<never>((_, rej) => { stall = rej })
    arm()
    return await Promise.race([fn(sftp, arm), stallP])
  } finally {
    stall = null
    if (timer) clearTimeout(timer)
    try {
      const anySftp = sftp as any
      if (typeof anySftp.destroy === 'function') anySftp.destroy()
      else sftp.end()
    } catch { /* 连接可能已断 */ }
  }
}

/**
 * 上传：单文件或整个目录（递归）。
 * onProgress 按 150ms 节流回调，避免大文件把 IPC 打爆。
 */
export async function upload(
  server: SshServer,
  localPath: string,
  remotePath: string,
  onProgress?: (p: TransferProgress & { file?: string }) => void,
  signal?: AbortSignal
): Promise<{ files: number; bytes: number }> {
  const st = fs.statSync(localPath)
  let files = 0
  let bytes = 0
  await withSftpIdle(server, async (sftp, bump) => {
    const putOne = (lp: string, rp: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const total = fs.statSync(lp).size
        let moved = 0
        let last = 0
        const rs = fs.createReadStream(lp)
        const ws = sftp.createWriteStream(normalizeRemotePath(rp))
        const done = (err?: Error) => {
          rs.destroy()
          try { ws.destroy() } catch { /* 已结束 */ }
          err ? reject(err) : resolve()
        }
        rs.on('data', (c: any) => {
          moved += c.length
          bump()
          const now = Date.now()
          if (onProgress && now - last > 150) {
            last = now
            // total 是**当前文件**的大小：渲染层用 moved/total 画单文件进度，
            // 再用已完成的文件数画整体进度。早先这里传 0，UI 只能显示 0%
            onProgress({ transferred: moved, total, file: path.basename(lp) })
          }
        })
        rs.on('error', done)
        ws.on('error', done)
        ws.on('close', () => done())
        if (signal) {
          if (signal.aborted) return done(new Error('已取消'))
          signal.addEventListener('abort', () => done(new Error('已取消')), { once: true })
        }
        rs.pipe(ws)
      })

    const walk = async (lp: string, rp: string, depth: number): Promise<void> => {
      if (depth > 24) throw new Error('目录层级过深，已中止')
      const s = fs.statSync(lp)
      if (s.isDirectory()) {
        await call(sftp, 'mkdir', normalizeRemotePath(rp)).catch(() => { /* 已存在 */ })
        for (const name of fs.readdirSync(lp)) {
          await walk(path.join(lp, name), `${rp.replace(/\/+$/, '')}/${name}`, depth + 1)
        }
        return
      }
      await putOne(lp, rp)
      files++
      bytes += s.size
      // 单个文件收尾：把进度顶到 100%，避免最后一个包没打满就切下一个文件
      onProgress?.({ transferred: s.size, total: s.size, file: path.basename(lp) })
    }

    if (st.isDirectory()) {
      // 目录上传：目标目录本身作为子目录创建（资源管理器拖拽语义）
      const base = path.basename(localPath)
      await walk(localPath, joinRemote(normalizeRemotePath(remotePath), base), 0)
    } else {
      // 单文件：remotePath 的语义统一为「目标目录」，文件名由这里补。
      // 早期直接把它当完整路径写，createWriteStream 会写到目录上，必然失败。
      await walk(localPath, joinRemote(normalizeRemotePath(remotePath), path.basename(localPath)), 0)
    }
  })
  return { files, bytes }
}

/** 下载：单文件或目录（递归） */
export async function download(
  server: SshServer,
  remotePath: string,
  localPath: string,
  onProgress?: (p: TransferProgress & { file?: string }) => void,
  signal?: AbortSignal
): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  await withSftpIdle(server, async (sftp, bump) => {
    const getOne = (rp: string, lp: string, size: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        fs.mkdirSync(path.dirname(lp), { recursive: true })
        let last = 0
        let moved = 0
        const rs = sftp.createReadStream(normalizeRemotePath(rp))
        const ws = fs.createWriteStream(lp)
        const done = (err?: Error) => {
          rs.destroy()
          try { ws.destroy() } catch { /* 已结束 */ }
          if (err) { try { fs.rmSync(lp, { force: true }) } catch { /* 清理半截文件 */ } }
          err ? reject(err) : resolve()
        }
        rs.on('data', (c: Buffer) => {
          moved += c.length
          bytes += c.length
          bump()
          const now = Date.now()
          if (onProgress && now - last > 150) {
            last = now
            // total 用远端 lstat 的大小，渲染层据此画单文件进度条
            onProgress({ transferred: moved, total: size, file: path.basename(lp) })
          }
        })
        rs.on('error', done)
        ws.on('error', done)
        ws.on('close', () => done())
        if (signal) {
          if (signal.aborted) return done(new Error('已取消'))
          signal.addEventListener('abort', () => done(new Error('已取消')), { once: true })
        }
        rs.pipe(ws)
      })

    const walk = async (rp: string, lp: string, depth: number): Promise<void> => {
      if (depth > 24) throw new Error('目录层级过深，已中止')
      const st: any = await call(sftp, 'lstat', normalizeRemotePath(rp))
      const isDir = ((st?.mode ?? 0) & 0o170000) === 0o040000
      if (isDir) {
        fs.mkdirSync(lp, { recursive: true })
        const kids: any[] = await call(sftp, 'readdir', normalizeRemotePath(rp))
        for (const k of kids) {
          if (k.filename === '.' || k.filename === '..') continue
          // 文件名由对端服务端决定：剥掉任何路径分隔符并校验落盘位置，防止 `..\..\x` 写出目标目录
          const safeName = path.basename(String(k.filename).replace(/[\\/]+/g, '_'))
          if (!safeName || safeName === '.' || safeName === '..') continue
          const childLp = path.resolve(lp, safeName)
          if (!childLp.startsWith(path.resolve(lp) + path.sep)) continue
          await walk(`${normalizeRemotePath(rp).replace(/\/+$/, '')}/${k.filename}`, childLp, depth + 1)
        }
        return
      }
      await getOne(rp, lp, Number(st?.size) || 0)
      files++
    }

    const st: any = await call(sftp, 'lstat', normalizeRemotePath(remotePath))
    const isDir = ((st?.mode ?? 0) & 0o170000) === 0o040000
    if (isDir) {
      await walk(remotePath, path.join(localPath, path.posix.basename(normalizeRemotePath(remotePath))), 0)
    } else {
      const target = /[\\/]$/.test(localPath) || fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()
        ? path.join(localPath, path.posix.basename(normalizeRemotePath(remotePath)))
        : localPath
      await getOne(remotePath, target, Number(st?.size) || 0)
      files++
    }
  })
  return { files, bytes }
}

/** 首页目录：先试 /home/<user>，取不到退回 ~ */
export async function homeDir(server: SshServer): Promise<string> {
  try {
    const real = await withSftp(server, (sftp) => call<string>(sftp, 'realpath', '.'))
    if (real) return real
  } catch { /* 服务端不支持 realpath */ }
  const guess = `/home/${server.user}`
  const st = await statPath(server, guess)
  return st.exists ? guess : '/'
}
