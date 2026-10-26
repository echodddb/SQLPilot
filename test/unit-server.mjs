/**
 * 服务器模块单测：SSH 配置解析 + SFTP 路径规范化。
 *
 * 为什么值得测：
 * - ~/.ssh/config 的语法看着简单，但通配段默认值、Host=Value 写法、多别名、ProxyJump
 *   这些分支全是字符串处理，写错了用户只会看到"导入后连不上"，很难定位。
 * - SFTP 路径拼接决定了 mkdir/rename/删除作用在哪个绝对路径上。`..` 处理错一格
 *   就可能把 removePath 指到父目录——必须用断言钉死。
 *
 * 运行：node test/unit-server.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { parseSshConfig } from '../src/main/ssh-config.ts'
import { parentLocalPath, atLocalRoot, driveOf, joinLocal } from '../src/renderer/server/paths.ts'

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
const ok = (cond, why) => {
  assert.ok(cond, why)
  passed++
}

// ---------- ssh config 解析 ----------
{
  const text = `
# 生产环境
Host db-prod-01
  HostName 192.168.1.100
  User oracle
  Port 2222
  IdentityFile ~/.ssh/id_rsa

Host db-test-01 db-test-02
  HostName 10.0.0.5
  User root
`
  const list = parseSshConfig(text)
  eq(list.length, 3, '多别名展开为多条会话')
  const p = list.find((x) => x.alias === 'db-prod-01')
  eq(p.host, '192.168.1.100', 'HostName 覆盖别名')
  eq(p.user, 'oracle', 'User')
  eq(p.port, 2222, 'Port')
  ok(p.identityFile && !p.identityFile.startsWith('~'), 'IdentityFile 的 ~ 已展开为绝对路径')
  const t2 = list.find((x) => x.alias === 'db-test-02')
  eq(t2.host, '10.0.0.5', '同一 Host 段的多个别名共享配置')
}

{
  // 通配段提供默认值：Host * 里的 User/Port 应被具体主机继承
  const text = `
Host *
  User admin
  Port 2200
  IdentityFile ~/.ssh/work_key

Host app-01
  HostName 10.1.1.1
`
  const list = parseSshConfig(text)
  eq(list.length, 1, '通配段本身不导入')
  eq(list[0].user, 'admin', '继承通配段的 User')
  eq(list[0].port, 2200, '继承通配段的 Port')
  ok(list[0].identityFile, '继承通配段的 IdentityFile')
}

{
  // 具体段覆盖通配段；Host=Value 写法等价
  const text = `
Host *
  User admin
Host web
  HostName=10.2.2.2
  User=nginx
  Port=8022
`
  const list = parseSshConfig(text)
  eq(list[0].user, 'nginx', '具体段覆盖通配默认值')
  eq(list[0].host, '10.2.2.2', 'Host=Value 等号写法')
  eq(list[0].port, 8022, 'Port 等号写法')
}

{
  const text = `
Host jump
  HostName 1.1.1.1
  User ops
Host inner
  HostName 2.2.2.2
  ProxyJump jump
Host nope
  HostName 3.3.3.3
  ProxyJump none
`
  const list = parseSshConfig(text)
  eq(list.find((x) => x.alias === 'inner').proxyJump, 'jump', 'ProxyJump 原样保留')
  eq(list.find((x) => x.alias === 'nope').proxyJump, undefined, 'ProxyJump none 视为不设置')
}

{
  // 重复别名只留第一条；没有 HostName 时用别名当主机名
  const text = `
Host a
  HostName 1.1.1.1
Host a
  HostName 9.9.9.9
Host b
  User root
`
  const list = parseSshConfig(text)
  eq(list.length, 2, '重复别名去重')
  eq(list[0].host, '1.1.1.1', '重复别名保留首次出现')
  eq(list[1].host, 'b', '缺少 HostName 时主机名=别名')
  eq(list[1].port, 22, '缺省端口 22')
}

{
  eq(parseSshConfig('').length, 0, '空文本不崩')
  eq(parseSshConfig('这不是配置').length, 0, '无法识别的行被忽略')
  // 只有通配段时没有可导入主机
  eq(parseSshConfig('Host *\n User root\n').length, 0, '纯通配段不产生会话')
}

// ---------- SFTP 路径（bundle 后导入真实实现，electron 走 stub） ----------
{
  const root = path.resolve(import.meta.dirname, '..')
  const out = path.join(import.meta.dirname, '.sftp-bundle.mjs')
  await build({
    entryPoints: [path.join(root, 'src/main/sftp.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    external: ['ssh2', 'iconv-lite'],
    alias: { electron: path.join(import.meta.dirname, 'stub-electron.mjs') },
    logLevel: 'silent'
  })
  const m = await import(`${pathToFileURL(out).href}?t=${Date.now()}`)
  fs.unlinkSync(out)

  eq(m.normalizeRemotePath('.'), '.', '相对路径保持')
  eq(m.normalizeRemotePath('/a//b/'), '/a/b', '绝对路径去重复斜杠与尾斜杠')
  eq(m.normalizeRemotePath('/a/./b'), '/a/b', '去掉 . 段')
  eq(m.normalizeRemotePath('/a/b/../c'), '/a/c', '解析 .. 段')
  eq(m.normalizeRemotePath('/..'), '/', '根目录的 .. 不越界')
  eq(m.normalizeRemotePath('/a/../../b'), '/b', '绝对路径 .. 不越过根')
  eq(m.normalizeRemotePath('..'), '..', '相对路径 .. 保留')
  eq(m.normalizeRemotePath('a\\b\\c'), 'a/b/c', '反斜杠归一为正斜杠')

  eq(m.joinRemote('/u01/app', 'oracle'), '/u01/app/oracle', '拼目录')
  eq(m.joinRemote('/u01/app/', 'oracle'), '/u01/app/oracle', '去掉多余尾斜杠再拼')
  eq(m.joinRemote('', 'x'), '/x', '空目录拼成根下的绝对路径')
  eq(m.joinRemote('/', 'x'), '/x', '根目录拼接')

  eq(m.parentRemote('/u01/app/oracle'), '/u01/app', '父目录')
  eq(m.parentRemote('/u01'), '/', '一级目录的父目录是根')
  eq(m.parentRemote('/'), '/', '根的父目录是自身')
}

// ---------- 本地路径「上一级」（回归：二级目录往上切不动） ----------
{
  const W = (s) => s.replace(/\//g, '\\') // 只为了下面读起来是反斜杠路径
  eq(parentLocalPath(W('C:/Users/dba/Documents')), W('C:/Users/dba'), '深目录 → 上一级')
  eq(parentLocalPath(W('C:/Users/dba')), W('C:/Users'), '二级目录 → 上一级')
  // 曾经的 bug：这里被 `if (i <= 2) return` 拦死，停在 C:\Users 出不去
  eq(parentLocalPath(W('C:/Users')), W('C:/') , '一级目录 → 盘符根（旧实现卡死在这）')
  eq(parentLocalPath(W('C:/')), null, '盘符根没有上一级')
  eq(parentLocalPath('C:'), null, '裸盘符视为根')
  eq(parentLocalPath(W('C:/Users/')), W('C:/'), '带尾部分隔符也能上去')
  eq(parentLocalPath('C:/Users/dba'), 'C:/Users', '正斜杠路径')
  eq(parentLocalPath(W('//server/share/dir')), W('//server/share'), 'UNC 共享下的一级')
  eq(parentLocalPath(W('//server/share')), null, 'UNC 共享根没有上一级')
  eq(parentLocalPath(''), null, '空路径不崩')

  eq(atLocalRoot(W('C:/')), true, '盘符根判定为根')
  eq(atLocalRoot(W('C:/Users')), false, '一级目录不是根')

  eq(driveOf(W('d:/data')), W('D:/'), '盘符归一为大写')
  eq(driveOf(''), '', '无盘符返回空串')

  eq(joinLocal(W('C:/a'), 'b'), W('C:/a/b'), '拼接本地路径')
  eq(joinLocal(W('C:/a/'), 'b'), W('C:/a/b'), '去掉多余尾分隔符')
}

console.log(`\x1b[32m✓ unit-server: ${passed} 个断言通过\x1b[0m`)
