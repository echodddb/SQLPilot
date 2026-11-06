// 直连集群探测单测：probe.ts 是「哪套集群先回来先上屏 / 探不通的不再拖累其它模块」的唯一来源。
// 这套逻辑错了的后果不是界面难看，而是每进一个模块都要等一台挂掉的机器超时。
import assert from 'node:assert/strict'
import {
  PROBE_DEADLINE_MS,
  fanOut,
  friendlyProbeError,
  idleProbe,
  isOffline,
  markFail,
  markOk,
  markProbing,
  probeLabel,
  probeOf,
  pruneProbes,
  resetProbe,
  shouldProbe,
  skipProbe
} from '../src/renderer/cloud/probe.ts'

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
const ok = (cond, why) => { assert.ok(cond, why); passed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 初始状态 ----------
{
  const book = {}
  const rec = probeOf(book, 'p1')
  eq(rec.state, 'idle', '没探过的集群是 idle')
  eq(rec.probing, false, '没探过不在飞')
  eq(rec.error, '', '没探过没有错误')
  ok(!isOffline(rec), 'idle 不算不可用')
  eq(probeLabel(rec), '未探测', 'idle 文案')
}

// ---------- 自动 / 手动是否要探 ----------
{
  const idle = idleProbe()
  ok(shouldProbe(idle, false), '自动刷新要探 idle')
  ok(shouldProbe(idle, true), '手动要探 idle')

  const okRec = { ...idleProbe(), state: 'ok' }
  ok(shouldProbe(okRec, false), '自动刷新要探上次成功的（数据要新鲜）')

  const fail = { ...idleProbe(), state: 'fail' }
  ok(!shouldProbe(fail, false), '自动刷新不再碰失败的（其它模块不被拖住）')
  ok(shouldProbe(fail, true), '手动重试要放行失败的')

  const skipped = { ...idleProbe(), state: 'skipped' }
  ok(!shouldProbe(skipped, false), '自动刷新不碰用户确认跳过的')
  ok(shouldProbe(skipped, true), '手动重试要放行跳过的')

  const busy = { ...idleProbe(), state: 'ok', probing: true }
  ok(shouldProbe(busy, true), '正在探的不阻止新的探测（切页面不能因为上一页还在探就空着）')
  ok(shouldProbe(busy, false), '自动刷新同理，多查一次好过空表格')
  ok(!shouldProbe({ ...idleProbe(), state: 'fail', probing: true }, false), '失败中的不因手动/自动规则被放行（自动）')
}

// ---------- probing 不覆盖上一次结论（否则状态灯每次刷新都闪成"连接中"） ----------
{
  const book = {}
  markOk(book, 'p1', 1000)
  markProbing(book, 'p1', 2000)
  eq(book.p1.state, 'ok', '开始新一轮探测时仍保留上次成功结论')
  eq(book.p1.probing, true, '标记为在飞')
  eq(probeLabel(book.p1), '正常', '在飞但上次成功：文案仍是正常')
}

// ---------- 失败 / 跳过 / 重试 ----------
{
  const book = {}
  markProbing(book, 'p1', 1000)
  eq(probeLabel(book.p1), '探测中', '首次探测中文案')
  markFail(book, 'p1', 'connect ETIMEDOUT', 2000)
  eq(book.p1.state, 'fail', '失败记 fail')
  eq(book.p1.error, 'connect ETIMEDOUT', '保留原因')
  eq(book.p1.probing, false, '失败后不在飞')
  eq(book.p1.fails, 1, '连续失败计数 1')
  ok(isOffline(book.p1), 'fail 算不可用')
  eq(probeLabel(book.p1), '不可用', 'fail 文案')

  markFail(book, 'p1', 'again', 3000)
  eq(book.p1.fails, 2, '连续失败累加')

  skipProbe(book, 'p1', 4000)
  eq(book.p1.state, 'skipped', '确认后转 skipped')
  eq(book.p1.error, 'again', '跳过时保留上次原因')
  eq(book.p1.fails, 2, '跳过不动失败计数')
  eq(probeLabel(book.p1), '已跳过', '跳过文案')
  ok(isOffline(book.p1), 'skipped 仍算不可用')

  resetProbe(book, 'p1')
  eq(book.p1, undefined, '手动重试清掉记录')
  eq(probeOf(book, 'p1').state, 'idle', '清掉后回到 idle')
}

// ---------- 误点"暂不探测"不能把健康的集群关掉 ----------
{
  const book = {}
  markOk(book, 'p1', 1000)
  skipProbe(book, 'p1', 2000)
  eq(book.p1.state, 'ok', '成功的集群不会被跳过')

  const empty = {}
  skipProbe(empty, 'p9', 1000)
  eq(empty.p9, undefined, '没探过的也不会被跳过')
}

// ---------- 成功要清零失败计数 ----------
{
  const book = {}
  markFail(book, 'p1', 'x', 1000)
  markFail(book, 'p1', 'x', 2000)
  markOk(book, 'p1', 3000)
  eq(book.p1.fails, 0, '连上后失败计数清零')
  eq(book.p1.error, '', '连上后清空错误')
  eq(book.p1.probing, false, '连上后不在飞')
}

// ---------- 清理已删除接入的残留 ----------
{
  const book = {}
  markOk(book, 'a', 1)
  markOk(book, 'b', 1)
  pruneProbes(book, ['a'])
  eq(Object.keys(book), ['a'], '只保留还在配置里的平台')
}

// ---------- fanOut：先回来的先上屏 ----------
{
  const book = {}
  const order = []
  const t0 = Date.now()
  await fanOut(
    book,
    [{ id: 'fast' }, { id: 'slow' }],
    async (p) => {
      await sleep(p.id === 'fast' ? 5 : 25)
      return { ok: true, data: p.id }
    },
    (p, data, late) => order.push(`${data}${late ? '!' : ''}`),
    { deadlineMs: 200 }
  )
  eq(order, ['fast', 'slow'], '按返回顺序上屏，不是按配置顺序')
  ok(Date.now() - t0 < 200, '两套都回来了就结束，不用等满超时')
  eq(book.fast.state, 'ok', 'fast 成功')
  eq(book.slow.state, 'ok', 'slow 成功')
}

// ---------- fanOut：一台挂住不返回，本轮必须在超时点上结束 ----------
{
  const book = {}
  const got = []
  const t0 = Date.now()
  await fanOut(
    book,
    [{ id: 'ok1' }, { id: 'hang' }],
    async (p) => {
      if (p.id === 'hang') return new Promise(() => { /* 永不返回，模拟黑洞连接 */ })
      return { ok: true, data: p.id }
    },
    (p, data) => got.push(data),
    { deadlineMs: 40 }
  )
  const cost = Date.now() - t0
  ok(cost >= 40, `本轮要等到超时点才收尾（实际 ${cost}ms）`)
  ok(cost < 160, `不能无限等挂住的那台（实际 ${cost}ms）`)
  eq(got, ['ok1'], '健康的集群照样出数据')
  eq(book.hang.state, 'fail', '挂住的那台记失败')
  ok(book.hang.error.includes('未响应'), '超时原因写成"未响应"')
  ok(!book.hang.probing, '超时后不再标记在飞')
}

// ---------- fanOut：超时之后才回来的，数据照收 ----------
{
  const book = {}
  const got = []
  await fanOut(
    book,
    [{ id: 'late' }],
    async () => {
      await sleep(90)
      return { ok: true, data: 'L' }
    },
    (p, data, late) => got.push({ data, late }),
    { deadlineMs: 30 }
  )
  eq(book.late.state, 'fail', '到点时先判失败（界面出提示）')
  eq(got, [], '此刻还没有数据')
  await sleep(120)
  eq(got, [{ data: 'L', late: true }], '迟到的好结果仍要补上，并标明是迟到的')
  eq(book.late.state, 'ok', '补上后状态回到正常')
}

// ---------- fanOut：报错的集群只影响它自己 ----------
{
  const book = {}
  const got = []
  await fanOut(
    book,
    [{ id: 'bad' }, { id: 'good' }],
    async (p) => {
      if (p.id === 'bad') throw new Error('Access denied for user')
      return { ok: true, data: 'G' }
    },
    (p, data) => got.push(data),
    { deadlineMs: 100 }
  )
  eq(got, ['G'], '另一套集群的数据照常上屏')
  eq(book.bad.state, 'fail', '抛错的记失败')
  ok(book.bad.error.includes('Access denied'), '保留原始报错，不用笼统文案盖掉')

  // service 层用 { ok:false } 而不是抛错，两条路径都要认
  const book2 = {}
  await fanOut(book2, [{ id: 'x' }], async () => ({ ok: false, error: '连接失败' }), () => { /* 不该被调用 */ }, { deadlineMs: 100 })
  eq(book2.x.state, 'fail', 'ok:false 也记失败')
  eq(book2.x.error, '连接失败', '保留 service 给的原因')
}

// ---------- 默认超时要比连接超时（8s）宽，别把慢实例误判成挂了 ----------
ok(PROBE_DEADLINE_MS > 8000, '默认超时大于 obdirect 的 connectTimeout')

// ---------- 原始报错翻人话 ----------
{
  const t = friendlyProbeError
  ok(t('connect ETIMEDOUT').includes('连接超时'), 'ETIMEDOUT → 连接超时')
  ok(t('connect ECONNREFUSED 10.0.0.9:2881').includes('连接被拒绝'), 'ECONNREFUSED → 连接被拒绝')
  ok(t('Access denied for user root@sys').includes('账号或密码'), 'Access denied → 账号密码不对')
  ok(t('ER_ACCESS_DENIED_ERROR').includes('账号或密码'), 'ER_ACCESS_DENIED 也认')
  ok(t('getaddrinfo ENOTFOUND ob.local').includes('域名'), 'ENOTFOUND → 域名解析失败')
  ok(t('EHOSTUNREACH').includes('网络不可达'), 'EHOSTUNREACH → 网络不可达')
  ok(t('ER_CON_COUNT_ERROR: Too many connections').includes('连接数'), '连接数满')
  ok(t('平台尚未保存密码，请先在云管平台设置中填写').includes('还没保存密码'), '密码缺失单独说清')
  eq(t('超过 15 秒未响应'), '超过 15 秒未响应', '已经是人话的透传，不二次加工')
  eq(t(''), '连接失败', '空错误给兜底文案')
  eq(t('Unknown database oceanbase'), 'Unknown database oceanbase', '不认识的报错原样返回，别瞎编')
}

console.log(`cluster-probe 单测：${passed} 组断言全部通过`)
