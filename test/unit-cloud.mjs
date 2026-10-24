// 云管平台单测：地址归一化、TopSQL 归一化，以及 401 重登的并发行为（真跑本地假 OCP 服务）。
// 直接导入真实 TS 模块（Node 原生类型剥离），不打桩、不 mock，走的是和生产一致的 http 请求路径。
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { normalizeBase, toTopSql, OcpClient } from '../src/main/cloud/ocp.ts'

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
const ok = (cond, why) => {
  assert.ok(cond, why)
  passed++
}
const throws = (fn, pattern, why) => {
  assert.throws(fn, pattern, why)
  passed++
}

// ---------- normalizeBase：用户从浏览器地址栏粘过来的各种形态 ----------
eq(normalizeBase('192.168.1.130:8080'), 'http://192.168.1.130:8080', '裸地址默认补 http')
eq(normalizeBase('http://192.168.1.130:8080/'), 'http://192.168.1.130:8080', '去掉末尾斜杠')
eq(normalizeBase('  http://192.168.1.130:8080  '), 'http://192.168.1.130:8080', '去掉首尾空白')
eq(normalizeBase('https://ocp.intra:8443'), 'https://ocp.intra:8443', '保留 https 与端口')
eq(normalizeBase('http://ocp.intra:8080/login'), 'http://ocp.intra:8080', '剥掉末尾的 SPA 路由 login')
eq(normalizeBase('http://ocp.intra:8080/#/overview'), 'http://ocp.intra:8080', '剥掉 hash 路由')
eq(normalizeBase('http://ocp.intra:8080/overview'), 'http://ocp.intra:8080', '剥掉末尾的 SPA 路由 overview')
eq(normalizeBase('http://ocp.intra:8080/ocp/overview'), 'http://ocp.intra:8080/ocp', '保留反向代理子路径，只剥路由段')
eq(normalizeBase('ｈｔｔｐ：／／192.168.1.130：8080'), 'http://192.168.1.130:8080', '全角字符 NFKC 归一')
eq(normalizeBase('http://192.168.1.130:8080\u200B'), 'http://192.168.1.130:8080', '去掉零宽字符')
eq(normalizeBase('"http://192.168.1.130:8080"'), 'http://192.168.1.130:8080', '去掉包裹的引号')
eq(normalizeBase('<http://192.168.1.130:8080>'), 'http://192.168.1.130:8080', '去掉包裹的尖括号')
eq(normalizeBase('http://[::1]:8080'), 'http://[::1]:8080', 'IPv6 地址保留方括号')
eq(normalizeBase('http://ocp.intra:8080?x=1'), 'http://ocp.intra:8080', '丢掉查询串')

throws(() => normalizeBase(''), /地址为空/, '空地址报错')
throws(() => normalizeBase('   '), /地址为空/, '纯空白报错')
throws(() => normalizeBase('http://999.1.1.1:8080'), /格式不正确/, '越界 IP 被 URL 解析器拒绝')
throws(() => normalizeBase('http://ocp_intra:8080'), /非法字符/, '主机名含下划线报错')
throws(() => normalizeBase('http://ocp.intra:abc'), /格式不正确/, '端口非数字报错')

// ---------- toTopSql：OCP 返回的松散 JSON → 稳定行结构 ----------
{
  const empty = toTopSql(null)
  eq(empty.sqlId, '', 'null 输入：字符串字段留空')
  eq(empty.executions, 0, 'null 输入：数字字段归零')
  eq(empty.dynamicSql, false, 'null 输入：布尔字段归 false')
  eq(empty.retCodes['4012'], 0, 'null 输入：错误码计数归零')
  passed++
}

{
  const row = toTopSql({
    sqlId: 'ABC123',
    sqlTextShort: 'select * from t where id = ?',
    sqlType: 'SELECT',
    tenantId: 1002,
    tenantName: 'app',
    userName: 'root',
    dbName: 'shop',
    server: '10.0.0.1:2882',
    serverIp: '10.0.0.1',
    executions: 42,
    execPs: 1.5,
    avgCpuTime: 1200,
    avgElapsedTime: 3400,
    maxElapsedTime: 9800,
    sumElapsedTime: 142800,
    sumCpuTimeMs: 50400,
    cpuPercentage: 12.5,
    failCount: 2,
    failPercentage: 4.8,
    lastFailCode: 4013,
    waitEvent: 'none',
    localPlanPercentage: 100,
    remotePlanPercentage: 0,
    distPlanPercentage: 0,
    missPlanPercentage: 0,
    tableScanPercentage: 12.5,
    strongConsistencyPercentage: 0,
    retryCount: 1,
    dynamicSql: 1,
    inner: 0,
    retCode4012Count: 3,
    retCode4013Count: 2,
    retCode5001Count: '1',
    retCode5024Count: 0,
    retCode5167Count: 0,
    retCode5217Count: 0,
    retCode6002Count: 0
  })
  eq(row.sqlId, 'ABC123', 'sqlId 透传')
  eq(row.tenantId, 1002, 'tenantId 透传')
  eq(row.avgCpuTime, 1200, '耗时字段保持微秒原值（不做换算）')
  eq(row.sumCpuTimeMs, 50400, '名字带 Ms 的字段同样是微秒')
  eq(row.executions, 42, '执行次数透传')
  eq(row.dynamicSql, true, 'truthy 转布尔 true')
  eq(row.inner, false, '0 转布尔 false')
  eq(row.retCodes, { 4012: 3, 4013: 2, 5001: 1, 5024: 0, 5167: 0, 5217: 0, 6002: 0 }, '错误码计数按列表抽取并转数字')
  passed++
}

{
  const row = toTopSql({ executions: '42', avgCpuTime: 'abc', tenantId: null })
  eq(row.executions, 42, '字符串数字转 number')
  eq(row.avgCpuTime, 0, '非数字转 0（不能让 NaN 流到界面）')
  eq(row.tenantId, 0, 'null 转 0')
  passed++
}

// ---------- 401 重登：并发请求不能互相清会话 ----------
function cookieOf(req, key) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === key) return part.slice(i + 1).trim()
  }
  return ''
}

function startFakeOcp() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const state = { logins: 0, sessions: new Set(), calls: 0, latencyMs: 0, failSeq: 0 }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (code, obj) => {
      const body = JSON.stringify(obj)
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    }

    if (url.pathname === '/api/v2/sensitiveDataKey') {
      return send(200, { successful: true, data: { publicKey: pub } })
    }

    if (url.pathname === '/api/v2/iam/login' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const form = new URLSearchParams(raw)
        let plain = '<decrypt failed>'
        try {
          plain = crypto.privateDecrypt(
            { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.from(String(form.get('password') || ''), 'base64')
          ).toString('utf8')
        } catch { /* 保持 decrypt failed */ }
        if (form.get('username') !== 'root' || plain !== 'secret') {
          return send(200, { successful: false, error: { message: 'Incorrect username or password' } })
        }
        state.logins++
        const sid = `s${state.logins}`
        state.sessions.add(sid)
        const body = JSON.stringify({ successful: true, data: {} })
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Set-Cookie': [`SESSION=${sid}; Path=/`, 'XSRF-TOKEN=tok; Path=/']
        })
        res.end(body)
      })
      return
    }

    if (url.pathname === '/api/v2/info') {
      return send(200, { successful: true, data: { buildVersion: '4.4.1-20240101120000', edition: 'Enterprise', buildTime: '2024-01-01' } })
    }

    if (url.pathname === '/api/v2/echo') {
      const sid = cookieOf(req, 'SESSION')
      const alive = state.sessions.has(sid)
      // 失效应答故意错开 20ms：模拟真实场景里 401 陆续回来（先回来的已经把会话换新）
      const delay = alive ? state.latencyMs : state.latencyMs + 20 * (++state.failSeq)
      const reply = () => {
        if (!alive) return send(401, { successful: false, error: { message: 'unauthorized' } })
        state.calls++
        send(200, { successful: true, data: { value: state.calls } })
      }
      return setTimeout(reply, delay)
    }

    if (url.pathname === '/api/v2/denied') {
      return setTimeout(() => send(401, { successful: false, error: { message: 'unauthorized' } }), state.latencyMs)
    }

    send(404, { successful: false, error: { message: 'not found' } })
  })

  return { server, state }
}

const { server, state } = startFakeOcp()
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  // 冷启动并发：6 个请求同时打进来，只能登录一次
  {
    const client = new OcpClient({ id: 't1', name: 'fake', type: 'ocp', baseUrl: base, username: 'root' }, 'secret')
    const rows = await Promise.all(Array.from({ length: 6 }, () => client.call('/api/v2/echo')))
    eq(state.logins, 1, '冷启动并发 6 个请求只登录 1 次')
    ok(rows.every((r) => r && r.value > 0), '冷启动并发请求全部成功')
  }

  // 会话过期并发：先把服务端会话清空，再让 8 个请求同时 401
  {
    state.sessions.clear()
    const loginsBefore = state.logins
    const client = new OcpClient({ id: 't2', name: 'fake', type: 'ocp', baseUrl: base, username: 'root' }, 'secret')
    await client.ensureLogin()
    state.sessions.clear()
    state.latencyMs = 0
    state.failSeq = 0
    const before = state.logins
    const rows = await Promise.all(Array.from({ length: 8 }, () => client.call('/api/v2/echo')))
    state.latencyMs = 0
    eq(state.logins - before, 1, '会话失效时 8 个并发请求只重登 1 次（旧实现会互相清 jar、重复登录）')
    ok(rows.every((r) => r && r.value > 0), '并发重登后全部请求都拿到数据')
    ok(state.logins >= loginsBefore + 2, '登录次数符合预期（初始 1 次 + 重登 1 次）')
  }

  // 一直 401：重试一次后给出明确错误，不无限重登
  {
    const client = new OcpClient({ id: 't3', name: 'fake', type: 'ocp', baseUrl: base, username: 'root' }, 'secret')
    const before = state.logins
    await assert.rejects(() => client.call('/api/v2/denied'), /会话已失效/, '持续 401 应抛"会话已失效"')
    passed++
    eq(state.logins - before, 2, '持续 401 只重登一次（首次建立 + 重试前一次）')
  }

  // 密码错误：报可读错误，且不污染已有会话
  {
    const client = new OcpClient({ id: 't4', name: 'fake', type: 'ocp', baseUrl: base, username: 'root' }, 'wrong')
    await assert.rejects(() => client.ensureLogin(), /用户名或密码不正确/, '密码错误应报中文提示')
    passed++
  }
} finally {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

console.log(`cloud 单测：${passed} 组断言全部通过`)
