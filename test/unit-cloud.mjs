// 云管平台单测：地址归一化、TopSQL 归一化，以及 401 重登的并发行为（真跑本地假 OCP 服务）。
// 直接导入真实 TS 模块（Node 原生类型剥离），不打桩、不 mock，走的是和生产一致的 http 请求路径。
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { normalizeBase, toTopSql, OcpClient, ocpTaskAction, ocpSubtaskAction, ocpTaskBatchRetry, ocpSubtaskLog, ocpTaskLogText, ocpTaskDiagnosis, ocpCreateTenant } from '../src/main/cloud/ocp.ts'

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
eq(normalizeBase('192.168.1.100:8080'), 'http://192.168.1.100:8080', '裸地址默认补 http')
eq(normalizeBase('http://192.168.1.100:8080/'), 'http://192.168.1.100:8080', '去掉末尾斜杠')
eq(normalizeBase('  http://192.168.1.100:8080  '), 'http://192.168.1.100:8080', '去掉首尾空白')
eq(normalizeBase('https://ocp.intra:8443'), 'https://ocp.intra:8443', '保留 https 与端口')
eq(normalizeBase('http://ocp.intra:8080/login'), 'http://ocp.intra:8080', '剥掉末尾的 SPA 路由 login')
eq(normalizeBase('http://ocp.intra:8080/#/overview'), 'http://ocp.intra:8080', '剥掉 hash 路由')
eq(normalizeBase('http://ocp.intra:8080/overview'), 'http://ocp.intra:8080', '剥掉末尾的 SPA 路由 overview')
eq(normalizeBase('http://ocp.intra:8080/ocp/overview'), 'http://ocp.intra:8080/ocp', '保留反向代理子路径，只剥路由段')
eq(normalizeBase('ｈｔｔｐ：／／192.168.1.100：8080'), 'http://192.168.1.100:8080', '全角字符 NFKC 归一')
eq(normalizeBase('http://192.168.1.100:8080\u200B'), 'http://192.168.1.100:8080', '去掉零宽字符')
eq(normalizeBase('"http://192.168.1.100:8080"'), 'http://192.168.1.100:8080', '去掉包裹的引号')
eq(normalizeBase('<http://192.168.1.100:8080>'), 'http://192.168.1.100:8080', '去掉包裹的尖括号')
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
  const state = { logins: 0, sessions: new Set(), calls: 0, latencyMs: 0, failSeq: 0, ops: [], batchBody: null }

  /** 任务相关的假接口：路径/参数形状是照 4.3 实测结果写的（见 src/main/cloud/ocp.ts 注释） */
  const TASK_DETAIL = {
    id: 1000117,
    name: 'Take over primary OB cluster',
    status: 'FAILED',
    operation: 'EXECUTE',
    creator: { id: 100, name: 'admin' },
    executor: '10.0.0.1:8080',
    startTime: '2026-10-31T16:42:55+08:00',
    finishTime: '2026-10-31T16:57:23+08:00',
    prohibitRollback: true,
    subtasks: [
      { id: 1000227, name: 'Create resource manager', status: 'FAILED', operation: 'EXECUTE', nodeType: 'JAVA_TASK', startTime: '2026-10-31T16:57:22+08:00', finishTime: '2026-10-31T16:57:23+08:00', runTime: 1, upstreams: [1000237], prohibitRollback: false },
      { id: 1000233, name: 'Wait node', status: 'SUCCESSFUL', operation: 'EXECUTE', nodeType: 'JAVA_TASK', startTime: '2026-10-31T16:42:55+08:00', finishTime: '2026-10-31T16:42:56+08:00', runTime: 1, downstreams: [1000227], prohibitRollback: true }
    ]
  }


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

    // ---- 任务接口（写操作只记录，不改状态） ----
    const opMatch = /^\/api\/v2\/tasks\/instances\/(\d+)(\/subtasks\/(\d+))?\/(retry|rollback|abort|skip|cancel)$/.exec(url.pathname)
    if (opMatch && req.method === 'POST') {
      const id = Number(opMatch[1])
      state.ops.push({ taskId: id, subtaskId: opMatch[3] ? Number(opMatch[3]) : 0, action: opMatch[4], query: Object.fromEntries(url.searchParams) })
      // 999999999 模拟「任务不存在」，顺便验证 error.message 里的 {0} 占位符会被替换
      if (id === 999999999) return send(404, { successful: false, error: { message: '任务 {0} 不存在' } })
      return send(200, { successful: true, data: {} })
    }

    if (url.pathname === '/api/v2/tasks/instances/batchRetry' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        state.batchBody = JSON.parse(raw || '{}')
        send(200, { successful: true, data: {} })
      })
      return
    }

    if (url.pathname === '/api/v2/tasks/instances/1000117') {
      return send(200, { successful: true, data: TASK_DETAIL })
    }

    const logMatch = /^\/api\/v2\/tasks\/instances\/(\d+)\/subtasks\/(\d+)\/log$/.exec(url.pathname)
    if (logMatch) {
      const sid = Number(logMatch[2])
      return send(200, { successful: true, data: { log: `line-1 of ${sid}\nline-2 of ${sid}` } })
    }

    if (/downloadDiagnosis$/.test(url.pathname) && req.method === 'POST') {
      const buf = Buffer.from('PK\u0003\u0004fake-zip')
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length })
      return res.end(buf)
    }

    // 建租户：记录下来看请求体（真实 OCP 校验的是 zones[].resourcePool，见 ocpCreateTenant 注释）
    if (/\/tenants\/createTenant$/.test(url.pathname) && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        state.createTenantBody = JSON.parse(raw || '{}')
        // 真实返回体是「任务实例」（id = 任务号，tenantId 另给），不是 {taskId}
        send(200, { successful: true, data: { id: 9001, tenantId: 555, status: 'RUNNING' } })
      })
      return
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

  // ---------- 任务操作：路径、查询参数与错误消息（对齐 OCP 4.3 实测结果） ----------
  {
    const client = new OcpClient({ id: 't5', name: 'fake', type: 'ocp', baseUrl: base, username: 'root' }, 'secret')
    await client.ensureLogin()

    await ocpTaskAction(client, 1000117, 'retry')
    const retry = state.ops.at(-1)
    eq(retry.action, 'retry', '任务重试走 /retry')
    eq(retry.taskId, 1000117, '任务重试路径里带任务 ID')
    eq(retry.query.taskInstanceId, '1000117', 'taskInstanceId 走查询参数（OCP 不读 JSON body）')

    await ocpTaskAction(client, 1000117, 'rollback')
    eq(state.ops.at(-1).action, 'rollback', '回滚走 /rollback')

    await ocpTaskAction(client, 1000117, 'abort')
    eq(state.ops.at(-1).action, 'abort', '放弃走 /abort')

    // 存在的任务：返回提示语
    const r = await ocpTaskAction(client, 1000117, 'retry')
    eq(r.taskId, 1000117, '成功时回传任务 ID')
    ok(/重试/.test(r.message), '成功时给出中文提示')

    // 不存在的任务：OCP 的 {0} 占位符被替换成真实 ID
    await assert.rejects(() => ocpTaskAction(client, 999999999, 'rollback'), /任务 999999999 不存在/, '回滚的 {0} 占位符替换为任务 ID')
    passed++

    // 子任务操作
    await ocpSubtaskAction(client, 1000117, 1000227, 'skip')
    const skip = state.ops.at(-1)
    eq(skip.subtaskId, 1000227, '子任务跳过路径带子任务 ID')
    eq(skip.query.subtaskInstanceId, '1000227', 'subtaskInstanceId 走查询参数')
    await ocpSubtaskAction(client, 1000117, 1000227, 'cancel')
    eq(state.ops.at(-1).action, 'cancel', '终止子任务走 /cancel')

    // 批量重试：body 字段名是 taskInstanceIdList（实测传 taskInstanceIds 会 400「不能为空」）
    await ocpTaskBatchRetry(client, [11, 22])
    eq(state.batchBody, { taskInstanceIdList: [11, 22] }, '批量重试 body 用 taskInstanceIdList')
    await assert.rejects(() => ocpTaskBatchRetry(client, []), /请先勾选/, '空列表直接拒绝，不打接口')
    passed++

    // 子任务日志
    const log = await ocpSubtaskLog(client, 1000117, 1000227)
    ok(log.text.includes('line-1 of 1000227'), '子任务日志取 data.log')

    // 整任务日志：按开始时间排序拼接（Wait node 更早，排前面）
    const bundle = await ocpTaskLogText(client, 1000117)
    eq(bundle.subtasks, 2, '日志包含全部子任务')
    ok(bundle.text.indexOf('line-1 of 1000233') < bundle.text.indexOf('line-1 of 1000227'), '子任务日志按开始时间排序')
    ok(bundle.text.includes('任务 1000117'), '日志头部带任务标识')
    ok(/#1000227 Create resource manager/.test(bundle.text), '日志分段带子任务名与 ID')

    // 诊断包：二进制原样返回
    const diag = await ocpTaskDiagnosis(client, 1000117)
    ok(diag.data.subarray(0, 2).toString() === 'PK', '诊断包返回 zip 二进制')
    ok(/\.zip$/.test(diag.fileName), '诊断包有 zip 文件名')
  }

  // ---------- 建租户请求体：资源池必须嵌在 zones[].resourcePool ----------
  // 真实 OCP 4.3 在 zones[].unitSpecName 平铺时报「传入的资源池参数不能为空」（zones[0].resourcePool），
  // 这条断言就是为了不再退化回去。
  {
    const client = new OcpClient({ id: 't6', name: 'fake', type: 'ocp', baseUrl: base, username: 'root' }, 'secret')
    const r = await ocpCreateTenant(client, 1000003, {
      name: 'app_mysql',
      mode: 'MYSQL',
      charset: 'utf8mb4',
      collation: 'utf8mb4_general_ci',
      rootPassword: 'Passw0rd!',
      whitelist: '%',
      primaryZone: 'RANDOM',
      zones: [
        { name: 'zone1', replicaType: 'FULL', unitSpecName: 'S1', unitCount: 1 },
        { name: 'zone2', replicaType: 'FULL', unitSpecName: 'S2', unitCount: 0 }
      ]
    })
    const body = state.createTenantBody
    eq(r.taskId, 9001, '任务号取 data.id（OCP 返回的是任务实例，不是 {taskId}）')
    eq(r.tenantId, 555, '回传新租户 ID')
    eq(body.name, 'app_mysql', 'body 带租户名')
    eq(body.type, 'PRIMARY', 'type 固定 PRIMARY')
    ok(typeof body.rootPassword === 'string' && body.rootPassword !== 'Passw0rd!', 'root 密码经过 RSA 加密后再提交')
    eq(body.zones[0].resourcePool, { unitSpecName: 'S1', unitCount: 1 }, 'zone 的规格与 Unit 数嵌在 resourcePool 内')
    eq(body.zones[0].unitSpecName, undefined, 'zone 上不再平铺 unitSpecName')
    eq(body.zones[1].resourcePool.unitCount, 1, 'Unit 数 0 会被兜底成 1（OCP 要求 ≥1）')
    eq(body.zones.map((z) => z.name), ['zone1', 'zone2'], 'zone 名称透传')
  }
} finally {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

console.log(`cloud 单测：${passed} 组断言全部通过`)
