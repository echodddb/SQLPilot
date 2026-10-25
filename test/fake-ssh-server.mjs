/**
 * 本机假 SSH 服务：给服务器模块做真实链路自检（不改 sqlpilot 任何代码）。
 *
 * 提供：
 * - password 认证（test/test）
 * - exec：返回 uname 风格信息
 * - shell：以 **GBK** 编码输出中文问候，并回显输入（验证主进程 iconv 解码与反向编码）
 * - sftp：固定目录树 + 可读写的文本文件（验证双栏浏览、编辑保存）
 *
 * ⚠️ 已知限制：SFTP 子通道目前只有 REALPATH 能通，OPENDIR 的 HANDLE 响应客户端收不到
 * （服务端 outgoing 已是 open、包也写出了，但 readdir 一直超时）。exec/shell 完全可用，
 * 所以本服务目前只用于终端链路自检；SFTP 真机验证请用真实 Linux 主机。
 *
 * 端口 2222，仅供 127.0.0.1 使用。
 */
import ssh2 from 'ssh2'
import crypto from 'node:crypto'
import iconv from 'iconv-lite'

const { Server } = ssh2

const PORT = Number(process.env.FAKE_SSH_PORT || 2222)

// 主机密钥持久化到临时目录：known_hosts 会记录指纹，每次重启换密钥会触发
// 「主机密钥不一致」告警（那会挡住连接自检）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEY_FILE = path.join(os.tmpdir(), 'sqlpilot-fake-ssh-hostkey.pem')
let privateKey
try {
  privateKey = fs.readFileSync(KEY_FILE, 'utf8')
} catch {
  const kp = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  privateKey = kp.privateKey
  fs.writeFileSync(KEY_FILE, privateKey)
}

const FILES = {
  '/home/test/readme.txt': '这是一个 GBK 文件\n第二行：/u01/app/oracle\n',
  '/home/test/alert.log': 'ORA-00600: internal error code\nORA-01555: snapshot too old\n'
}
const DIRS = {
  '/home/test': ['readme.txt', 'alert.log', 'diag', 'logs'],
  '/home/test/diag': ['alert_xml.txt'],
  '/home/test/logs': ['listener.log']
}
const SUBFILE = { '/home/test/diag/alert_xml.txt': '<alert/>\n', '/home/test/logs/listener.log': '24-OCT-2026 10:00:00 * (CONNECT_DATA)\n' }

const ENC = 'gbk'

function attrsFor(name, dirPath) {
  const full = `${dirPath.replace(/\/+$/, '')}/${name}`
  const isDir = !!DIRS[full]
  return {
    filename: name,
    longname: `${isDir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 test test ${isDir ? 4096 : (FILES[full] || SUBFILE[full] || '').length} Oct 24 10:00 ${name}`,
    attrs: {
      mode: isDir ? 0o040755 : 0o100644,
      uid: 1000,
      gid: 1000,
      size: isDir ? 4096 : Buffer.byteLength(FILES[full] || SUBFILE[full] || '', 'utf8'),
      atime: Math.floor(Date.now() / 1000),
      mtime: Math.floor(Date.now() / 1000)
    }
  }
}

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on('error', (e) => console.log('[client error]', e.code || e.message))
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test') ctx.accept()
    else if (ctx.method === 'none') ctx.reject(['password'])
    else ctx.reject()
  })

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (a) => a?.())
      session.on('window-change', (a) => a?.())

      session.on('exec', (accept, reject, info) => {
        const stream = accept()
        const cmd = String(info?.command || '')
        let out = ''
        if (/os-release/.test(cmd)) {
          out = 'NAME="Ubuntu"\nVERSION="22.04.3 LTS (Jammy Jellyfish)"\nID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 22.04.3 LTS"\nVERSION_ID="22.04"\n'
        } else if (/uname -r/.test(cmd)) {
          out = '5.15.0-91-generic\n'
        } else if (/uname -m/.test(cmd)) {
          out = 'x86_64\n'
        } else if (/uname/i.test(cmd)) {
          out = 'Linux fake-db01 5.15.0-91-generic #1 SMP x86_64 GNU/Linux\n'
        } else if (/LANG=/.test(cmd)) {
          out = 'LANG=zh_CN.GBK LC_ALL=\n'
        } else if (/cd /.test(cmd)) {
          out = ''
        } else {
          out = `executed: ${cmd}\n`
        }
        stream.write(iconv.encode(out, ENC))
        stream.exit(0)
        stream.end()
      })

      session.on('shell', (accept) => {
        const stream = accept()
        stream.write(iconv.encode('欢迎登录 测试服务器（GBK 编码）\r\n$ ', ENC))
        stream.on('data', (d) => {
          const text = iconv.decode(d, ENC)
          if (/^\r$/.test(text) || /^\n$/.test(text)) {
            stream.write(iconv.encode('\r\n$ ', ENC))
            return
          }
          if (text.includes('\x03')) {
            stream.write(iconv.encode('\r\n^C\r\n$ ', ENC))
            return
          }
          if (text.includes('\x04')) {
            stream.write(iconv.encode('\r\nlogout\r\n', ENC))
            stream.exit(0)
            stream.end()
            return
          }
          // 回显 + 提示符：验证输入方向也走了 GBK 编码
          stream.write(iconv.encode(text + '\r\n$ ', ENC))
        })
        stream.on('close', () => { /* 客户端主动断开 */ })
      })

      // sftp 是 session 级子系统请求，不是 client 级事件（挂错位置会报
      // "Unable to start subsystem: sftp"）
      session.on('sftp', (accept) => {
      console.log('[sftp] subsystem requested')
      const sftp = accept()
      console.log('[sftp] accepted:', !!sftp)
      const handles = new Map()
      let seq = 0
      const newHandle = (v) => {
        const h = Buffer.from(`h${++seq}`)
        handles.set(h.toString(), v)
        return h
      }
      const dirOf = (p) => p.replace(/\/+$/, '') || '/'

      sftp.on('REALPATH', (reqid, p) => {
        const target = p === '.' ? '/home/test' : p
        sftp.name(reqid, [{ filename: target, longname: target, attrs: { mode: 0o040755 } }])
      })
      sftp.on('OPENDIR', (reqid, p) => {
        console.log('[sftp] OPENDIR', p, 'state=', sftp.outgoing?.state, 'buf=', sftp._buffer?.length)
        const key = dirOf(p)
        if (!DIRS[key]) return sftp.status(reqid, 2)
        sftp.handle(reqid, newHandle({ type: 'dir', path: key }))
        console.log('[sftp] handle sent, buf=', sftp._buffer?.length, 'state=', sftp.outgoing?.state)
      })
      sftp.on('READDIR', (reqid, handle) => {
        const h = handles.get(handle.toString())
        if (!h || h.type !== 'dir') return sftp.status(reqid, 4)
        const names = DIRS[h.path] || []
        sftp.name(reqid, names.map((n) => attrsFor(n, h.path)))
      })
      const stat = (reqid, p) => {
        const key = dirOf(p)
        if (DIRS[key]) return sftp.attrs(reqid, attrsFor(key.split('/').pop() || '/', key.slice(0, key.lastIndexOf('/')) || '/').attrs)
        if (FILES[key] || SUBFILE[key]) {
          const name = key.split('/').pop()
          return sftp.attrs(reqid, attrsFor(name, key.slice(0, key.lastIndexOf('/'))).attrs)
        }
        sftp.status(reqid, 2)
      }
      sftp.on('STAT', (reqid, p) => stat(reqid, p))
      sftp.on('LSTAT', (reqid, p) => stat(reqid, p))
      sftp.on('FSTAT', (reqid, handle) => {
        const h = handles.get(handle.toString())
        if (!h?.path) return sftp.status(reqid, 4)
        stat(reqid, h.path)
      })
      sftp.on('OPEN', (reqid, filename, flags) => {
        const write = flags & 0x00000002
        if (!write && !FILES[filename] && !SUBFILE[filename]) return sftp.status(reqid, 2)
        sftp.handle(reqid, newHandle({ type: 'file', path: filename, write: !!write }))
      })
      sftp.on('READ', (reqid, handle, offset, length) => {
        const h = handles.get(handle.toString())
        if (!h || h.type !== 'file') return sftp.status(reqid, 4)
        const content = Buffer.from(FILES[h.path] ?? SUBFILE[h.path] ?? '', 'utf8')
        // 按 GBK 重编码返回：验证「文件内容编码」与「终端编码」是两条独立通路
        const gbk = iconv.encode(content.toString('utf8'), ENC)
        if (offset >= gbk.length) return sftp.status(reqid, 1)
        sftp.data(reqid, gbk.subarray(offset, Math.min(offset + length, gbk.length)))
      })
      sftp.on('WRITE', (reqid, handle, offset, data) => {
        const h = handles.get(handle.toString())
        if (!h || !h.write) return sftp.status(reqid, 4)
        const text = iconv.decode(data, ENC)
        FILES[h.path] = (FILES[h.path] || '') + text
        sftp.status(reqid, 0)
      })
      sftp.on('CLOSE', (reqid, handle) => {
        handles.delete(handle.toString())
        sftp.status(reqid, 0)
      })
      sftp.on('MKDIR', (reqid, p) => {
        DIRS[dirOf(p)] = DIRS[dirOf(p)] || []
        sftp.status(reqid, 0)
      })
      sftp.on('RENAME', (reqid) => sftp.status(reqid, 0))
      sftp.on('REMOVE', (reqid) => sftp.status(reqid, 0))
      sftp.on('RMDIR', (reqid) => sftp.status(reqid, 0))
      sftp.on('SETSTAT', (reqid) => sftp.status(reqid, 0))
      })
    })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake ssh server on 127.0.0.1:${PORT}  (user test / pass test, shell+sftp, encoding gbk)`)
})
