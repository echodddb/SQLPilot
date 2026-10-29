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

// ---------- 分组文件夹（名字即身份：config.serverGroups ∪ 服务器 group 字段） ----------
{
  // server-groups 的分组核心在 group-folders.ts（与数据库连接分组共用），Node 的类型剥离
  // 解析不了无扩展名的相对导入，所以与 SFTP 一样 bundle 后导入真实实现
  const root = path.resolve(import.meta.dirname, '..')
  const out = path.join(import.meta.dirname, '.sg-bundle.mjs')
  await build({
    entryPoints: [path.join(root, 'src/main/server-groups.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'silent'
  })
  const sg = await import(`${pathToFileURL(out).href}?t=${Date.now()}`)
  fs.unlinkSync(out)

  eq(sg.normalizeGroupName('  生产   环境 '), '生产 环境', '分组名去首尾空白并折叠内部空白')
  eq(sg.normalizeGroupName('a\u0000b'), 'ab', '分组名剔掉控制字符')
  eq(sg.normalizeGroupName(null), '', '空值归一为空串')
  eq(sg.normalizeGroupName('x'.repeat(80)).length, 40, '超长分组名截断')

  eq(sg.validateGroupName('   ').ok, false, '空分组名不合法')
  eq(sg.validateGroupName('未分组').ok, false, '「未分组」是内置兜底桶，不允许当分组名')
  eq(sg.validateGroupName(' 生产 ').name, '生产', '合法分组名返回清洗后的值')

  // 旧配置：分组只写在服务器 group 字段上 → 要能长出文件夹清单，并且空文件夹靠清单保留
  const cfg = {
    serverGroups: [{ name: '生产' }, { name: '空组' }, { name: '生产' }],
    servers: [
      { id: 'a', name: 'A', host: 'h', port: 22, user: 'u', group: '生产' },
      { id: 'b', name: 'B', host: 'h', port: 22, user: 'u', group: '测试' },
      { id: 'c', name: 'C', host: 'h', port: 22, user: 'u' }
    ]
  }
  eq(sg.groupNames(cfg), ['生产', '空组', '测试'], '文件夹顺序在前、服务器独有分组补后、去重')
  ok(sg.hasGroup(cfg, '空组'), '空文件夹也算存在')
  ok(!sg.hasGroup(cfg, '未分组'), '兜底桶不算真分组')

  // 只写在服务器上的分组，登记一次后就有了固定位置（否则每次载入都要靠推导，顺序会飘）
  eq(sg.ensureGroup(cfg, '测试'), true, '服务器上独有的分组补登记进清单')
  eq(sg.ensureGroup(cfg, '测试'), false, '已登记的分组不重复添加')
  eq(sg.ensureGroup(cfg, '开发'), true, '新分组追加')
  eq(cfg.serverGroups.map((g) => g.name), ['生产', '空组', '测试', '开发'], 'ensureGroup 顺序按创建先后')

  // 改名：文件夹与服务器同步改，位置不变
  const moved = sg.renameGroup(cfg, '生产', '生产环境')
  eq(moved, 1, '改名搬动 1 台服务器')
  eq(cfg.servers[0].group, '生产环境', '服务器 group 跟着改名')
  eq(cfg.serverGroups.map((g) => g.name), ['生产环境', '空组', '测试', '开发'], '文件夹原位改名')
  eq(sg.renameGroup(cfg, '生产环境', '生产环境'), 0, '改成一模一样不做事')

  // 删除分组：有 moveTo 就搬，没有就回到未分组
  eq(sg.deleteGroup(cfg, '生产环境', '开发'), 1, '删除分组并搬到目标分组')
  eq(cfg.servers[0].group, '开发', '会话落到 moveTo 指定的分组')
  eq(sg.groupNames(cfg).includes('生产环境'), false, '被删的分组从清单消失')
  eq(sg.deleteGroup(cfg, '开发'), 1, '删除分组且不指定目标 → 组内会话全部移出')
  eq(cfg.servers[0].group, undefined, '移出分组后 group 字段被删掉')
  eq(sg.deleteGroup(cfg, '未分组'), 0, '兜底桶不可删除')

  // 会话搬家：空串 = 未分组；非空自动登记文件夹
  eq(sg.moveServers(cfg, ['b'], '新组'), 1, '移入新分组')
  eq(cfg.servers[1].group, '新组', 'group 字段写入')
  ok(sg.groupNames(cfg).includes('新组'), '移动时自动登记文件夹（否则空组会消失）')
  eq(sg.moveServers(cfg, ['b'], ''), 1, '空分组名 = 移出分组')
  eq(cfg.servers[1].group, undefined, '移出后不留空 group')
  eq(sg.moveServers(cfg, [], '新组'), 0, '没有目标会话时不动配置')

  // 回归：server:save 是先把机器写进 cfg.servers 再调 ensureGroup，
  // 早前用 hasGroup 判断"已登记"会把刚写进去那台机器的分组误判成已存在，文件夹永远进不了清单
  const flow = { serverGroups: [], servers: [{ id: 'x', name: 'X', host: 'h', port: 22, user: 'u', group: '新写的组' }] }
  eq(sg.ensureGroup(flow, '新写的组'), true, '先写服务器再登记分组也能进清单（回归）')
  eq(flow.serverGroups.map((g) => g.name), ['新写的组'], '清单里真的有了这个文件夹')

  // 载入配置时的整理：去重、剔非法、迁移旧数据、服务器上的脏名字对齐
  const dirty = {
    serverGroups: [{ name: ' 生产 ' }, { name: '生产' }, { name: '未分组' }, { name: '' }, '裸字符串'],
    servers: [
      { id: 'a', name: 'A', host: 'h', port: 22, user: 'u', group: '生产' },
      { id: 'b', name: 'B', host: 'h', port: 22, user: 'u', group: '未分组' },
      { id: 'c', name: 'C', host: 'h', port: 22, user: 'u', group: ' 机房A ' }
    ]
  }
  sg.normalizeServerGroups(dirty)
  eq(dirty.serverGroups.map((g) => g.name), ['生产', '裸字符串', '机房A'], '清理重复/空/保留名，并补登记服务器上的分组')
  eq(dirty.servers[1].group, undefined, '服务器上写着「未分组」等于没分组')
  eq(dirty.servers[2].group, '机房A', '服务器上的分组名对齐清洗后的写法')
}

console.log(`\x1b[32m✓ unit-server: ${passed} 个断言通过\x1b[0m`)
