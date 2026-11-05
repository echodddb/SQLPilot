/**
 * OB 日志解释库单测（纯逻辑，不打集群）。
 *
 * 为什么需要它：解释层的输出直接就是给 DBA 看的结论，
 * 一旦「-4008（迭代结束）被判成错误」或「standby 空转被判成正常」，
 * 工具就从"帮人省时间"变成"误导人"。所以这里锁的是判定口径，不是覆盖率。
 *
 * 运行：node test/unit-oblog.mjs
 */
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const out = path.join(ROOT, 'output', '.unit-oblog-bundle.mjs')
await build({
  entryPoints: [path.join(ROOT, 'src/main/oblogExplain.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error'
})
const { parseSite, explainErrCode, explainHotSpot, buildSummary, ERRCODE_KB, SITE_KB, TEXT_KB } = await import('file://' + out.replace(/\\/g, '/'))

let n = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  n++
}

/** 真实日志行（从 192.168.10.165 的 observer.log 抓的，不是编的） */
const LINE_STANDBY =
  '[2026-11-02 15:29:00.029138] WDIAG [STORAGE.TRANS] run1 (ob_standby_timestamp_service.cpp:147) [48801][T1002_STSWorker][T1002][Y0-0000000000000000-0-0] [lt=41][errcode=-4076] query and update last id fail(ret=-4076, ret="OB_NEED_WAIT")'
const LINE_TABLET =
  '[2026-11-02 15:29:10.664057] INFO  [STORAGE] get_kept_multi_version_start (ob_tablet.cpp:3960) [38465][T1_SSTableGC][T1][YB42C0A80AA5-00065F1EE8AD52C8-0-0] [lt=15] [dump tenant_info_loader]'
const LINE_SOCK =
  '[2026-11-02 15:29:00.368503] WDIAG [RPC.OBMYSQL] async_write_data (ob_sql_sock_session.cpp:153) [38498][T1_L0_G0][T1][YB42C0A80AA5-00065F1EE8BC4B0D-0-0] [lt=19][errcode=-4009] sock has error(ret=-4009)'
const LINE_LIB = '[2026-11-02 15:29:00.255249] INFO [LIB] stat (utility.h:1167) [38451][T1_TenantWeakRe][T1][Y0-0000000000000000-0-0] [lt=43] [PALF] x'

// ---------- parseSite：三个锚点都要抠对 ----------
{
  const s = parseSite(LINE_STANDBY)
  ok(s.module === 'STORAGE.TRANS', 'parseSite 模块名错：' + s.module)
  ok(s.file === 'ob_standby_timestamp_service.cpp', 'parseSite 文件名错：' + s.file)
  ok(s.func === 'run1', 'parseSite 函数名错：' + s.func)
  const e = parseSite('')
  ok(e.file === '' && e.func === '' && e.module === '', 'parseSite 空输入应全空')
}

// ---------- 错误码：语义稳定的一批 ----------
{
  // -4008 名字叫 End of iteration，是 EOF 不是错误 —— 判成 bad 会吓人
  ok(explainErrCode('-4008').verdict === 'normal', '-4008 迭代结束应为 normal')
  // -4043 认证失败是真问题
  ok(explainErrCode('-4043').verdict === 'bad', '-4043 认证失败应为 bad')
  // -6005 行锁超时是真问题
  ok(explainErrCode('-6005').verdict === 'bad', '-6005 行锁超时应为 bad')
  // 语义只到"注意"的
  ok(explainErrCode('-4009').verdict === 'watch', '-4009 应为 watch')
  ok(explainErrCode('-4076').verdict === 'watch', '-4076 单看语义应为 watch')
  ok(explainErrCode('-4018').verdict === 'normal', '-4018 条目不存在应为 normal')
}

// ---------- 来源能提升严重度：-4076 单看是"等"，来自 standby 空转就是病 ----------
{
  const plain = explainErrCode('-4076')
  const withSrc = explainErrCode('-4076', LINE_STANDBY)
  ok(plain.verdict === 'watch', '-4076 无来源时应为 watch')
  ok(withSrc.verdict === 'bad', '-4076 来自 standby 时间戳服务应升级为 bad')
  ok(withSrc.what.includes('standby'), '-4076 解释里应带上来源组件：' + withSrc.what)
  ok(withSrc.rule.includes('ob_standby_timestamp_service'), '应记录命中的来源规则：' + withSrc.rule)

  // 来源不会把已判 bad 的码降级
  const denied = explainErrCode('-4043', LINE_SOCK)
  ok(denied.verdict === 'bad', '来源是 watch 不能把 bad 降级')
}

// ---------- 热点：文件名优先于通用函数名 ----------
{
  // 函数名是通用词 run1，靠文件名才能认出是 standby 服务
  const h = explainHotSpot('ob_standby_timestamp_service.cpp:147', LINE_STANDBY)
  ok(h.verdict === 'bad', 'standby 热点应判 bad：' + h.verdict)
  ok(h.rule.includes('ob_standby_timestamp_service'), '应按文件名命中：' + h.rule)

  const t = explainHotSpot('ob_tablet.cpp:3960', LINE_TABLET)
  ok(t.verdict === 'normal', 'SSTable GC 应判 normal：' + t.verdict)

  // 函数名锚点：文件名不在库里，但函数名在
  const d = explainHotSpot('ob_dag_scheduler.cpp:2002', '[t] INFO [COMMON] dump_dag_status (ob_dag_scheduler.cpp:2002) x')
  ok(d.verdict === 'normal', 'dump_dag_status 应判 normal')

  // 纯兜底：库里没这个名字，只能按模块说个子系统
  const u = explainHotSpot('utility.h:1167', LINE_LIB)
  ok(u.verdict === 'normal', 'LIB 兜底应为 normal：' + u.verdict + ' rule=' + u.rule)

  // 完全没线索 → 标 watch 而不是假装正常，且提示怎么自救
  const x = explainHotSpot('weird.cpp:1', '[t] INFO [WEIRD.NS] foo (weird.cpp:1) x')
  ok(x.verdict === 'watch', '无信息应保守判 watch')
  ok(!!x.advice, '无信息时应给出下一步建议')
}

// ---------- 结论：严重度按"日志行数"算，不是条目数 ----------
{
  const levels = [
    { key: 'INFO', count: 9000 },
    { key: 'WDIAG', count: 1000 }
  ]
  const rows = [
    { key: 'a.cpp:1', count: 9000, verdict: 'normal', what: '正常' },
    { key: 'b.cpp:2', count: 1000, verdict: 'bad', what: '备租户没有主库' }
  ]
  const s = buildSummary(10000, levels, rows, 10000)
  ok(s.level === 'bad', '有 bad 行应判 bad')
  ok(s.badCount === 1000, 'badCount 按行数：' + s.badCount)
  ok(Math.abs(s.normalPct - 90) < 0.01, '正常占比应 90%：' + s.normalPct)
  ok(s.headline.includes('b.cpp:2'), '结论应点名最大来源：' + s.headline)

  // 全正常 → ok
  const okS = buildSummary(500, [{ key: 'INFO', count: 500 }], [{ key: 'a.cpp:1', count: 500, verdict: 'normal', what: 'x' }], 3000)
  ok(okS.level === 'ok', '全正常应为 ok：' + okS.level)
  ok(okS.headline.includes('没发现问题'), '全正常结论文案：' + okS.headline)

  // 日志量超阈值（50 万行/小时）要提示，低于阈值不该乱报
  const heavy = buildSummary(500, [{ key: 'INFO', count: 500 }], [{ key: 'a.cpp:1', count: 500, verdict: 'normal', what: 'x' }], 800_000)
  ok(heavy.points.some((p) => p.includes('行/小时')), '超阈值时应给日志量提示')
  ok(!okS.points.some((p) => p.includes('行/小时')), '低日志量不该报量级提示')

  // 空窗口不应崩
  const empty = buildSummary(0, [], [], 0)
  ok(empty.level === 'ok' && empty.normalPct === 100, '空窗口应安全返回')

  // WDIAG 要被单独点名（它比 INFO 重、比 WARN 轻，最容易被忽略）
  const w = buildSummary(1000, [{ key: 'WDIAG', count: 800 }], [{ key: 'a.cpp:1', count: 800, verdict: 'normal', what: 'x' }], 6000)
  ok(w.points.some((p) => p.includes('WDIAG')), 'WDIAG 应单独提示')

  // 统计到行、但一行都解析不出代码位置 = 日志格式变了，不能报"没发现问题"
  const noHot = buildSummary(5000, [{ key: 'INFO', count: 5000 }], [], 30000)
  ok(noHot.level === 'watch', '解析不出热点时不能判 ok，实际：' + noHot.level)
  ok(noHot.normalPct === 0, '解析不出热点时不能说 100% 正常')
  ok(noHot.headline.includes('解析'), '结论要说明是解析问题而不是健康：' + noHot.headline)

  // WARN 及以上 0 条，但 WDIAG 里的错误码被判 bad —— 不能同时说"集群没有报错"
  const wdiagBad = buildSummary(
    1000,
    [{ key: 'WDIAG', count: 900 }],
    [{ key: 'ob_standby_timestamp_service.cpp:147', count: 900, verdict: 'bad', what: '备租户等待主库' }],
    6000,
    [{ key: '-4076', count: 900, verdict: 'bad', what: '需要等待' }]
  )
  ok(wdiagBad.level === 'bad', 'WDIAG 里的 bad 也要拉起级别')
  ok(!wdiagBad.points.some((p) => p.includes('集群当前没有报错')), '已经判 bad 时不能再写"集群没有报错"')
}

// ---------- 低频高危不能被漏报 ----------
// 热点榜只留 Top40：一个 -4043（认证失败）刷 3 次，它所在的源码位置根本进不了榜。
// 只按热点行数算级别，结论会显示"健康"，但实际有应用连不上库 —— 这是会出事的漏报。
{
  const levels = [{ key: 'INFO', count: 100000 }]
  const hot = [{ key: 'ob_tablet.cpp:3960', count: 90000, verdict: 'normal', what: 'GC 扫描' }]
  const errs = [{ key: '-4043', count: 3, verdict: 'bad', what: '账号认证失败' }]
  const s = buildSummary(100000, levels, hot, 600000, errs)
  ok(s.level === 'bad', '低频高危错误码必须把判定拉成 bad，实际：' + s.level)
  ok(s.headline.includes('-4043'), '结论要点名低频高危码：' + s.headline)
  ok(s.points.some((p) => p.includes('-4043')), '要点里要列出低频高危码')

  // 没有 bad 错误码时不能因此误报
  const clean = buildSummary(1000, [{ key: 'INFO', count: 1000 }],
    [{ key: 'a.cpp:1', count: 1000, verdict: 'normal', what: 'x' }], 3000,
    [{ key: '-4018', count: 5, verdict: 'normal', what: 'y' }])
  ok(clean.level === 'ok', '只有 normal 错误码时不该误报：' + clean.level)

  // 高频 bad 已经占了主要问题时，不再重复列"低频高危"
  const both = buildSummary(10000, [{ key: 'INFO', count: 10000 }],
    [{ key: 'ob_standby_timestamp_service.cpp:147', count: 9000, verdict: 'bad', what: '备租户没主库' }], 60000,
    [{ key: '-4076', count: 9000, verdict: 'bad', what: '需要等待' }])
  ok(both.level === 'bad', '高频 bad 应判 bad')
  ok(!both.points.some((p) => p.includes('低频但高危')), '高频问题时不该再报"低频高危"，会显得啰嗦')
}

// ---------- 文案兜底：错误码记不全时靠报错文案 ----------
{
  // 一个没收录的错误码，但文案把问题说清楚了
  const disk = explainErrCode('-4390', '[t] ERROR [STORAGE] write (ob_io.cpp:12) [1][T1][T1] [errcode=-4390] No space left on device')
  ok(disk.verdict === 'bad', '磁盘写满必须判 bad：' + disk.verdict)
  ok(disk.what.includes('磁盘'), '应说清是磁盘问题：' + disk.what)
  ok(disk.rule.startsWith('text:'), '应走文案规则：' + disk.rule)

  const dead = explainErrCode('-4999', '[t] WARN [STORAGE.TRANS] x (ob_tx.cpp:1) [1] [errcode=-4999] Deadlock detected')
  ok(dead.verdict === 'bad', '死锁应判 bad：' + dead.verdict)

  // 已收录但文案更严重的，要能抬级
  const esc = explainErrCode('-4009', '[t] ERROR [STORAGE] w (ob_io.cpp:1) [1] [errcode=-4009] No space left on device')
  ok(esc.verdict === 'bad', '-4009 配"磁盘写满"文案应升级为 bad：' + esc.verdict)
  ok(esc.rule.includes('text:'), '升级后规则里应带 text：' + esc.rule)

  // 正常 INFO 行不该被文案表命中
  const plain = parseSite(LINE_TABLET)
  ok(plain.file === 'ob_tablet.cpp', '正常行解析不受影响')
}

// ---------- 知识库自检：条目不许缺 what / verdict ----------
{
  const bad = Object.entries(ERRCODE_KB).filter(([, v]) => !v.what || !v.verdict)
  ok(bad.length === 0, '错误码知识库有条目缺字段：' + bad.map(([k]) => k).join(','))
  const wrongKey = Object.keys(ERRCODE_KB).filter((k) => !/^-\d+$/.test(k))
  ok(wrongKey.length === 0, '错误码键格式不对：' + wrongKey.join(','))
  const noAdvice = Object.entries(ERRCODE_KB).filter(([, v]) => v.verdict !== 'normal' && !v.advice)
  ok(noAdvice.length === 0, '非 normal 条目应给出处理建议：' + noAdvice.map(([k]) => k).join(','))

  // 新增两张表也要过同样的关：非 normal 必须给建议，否则用户只知道"有问题"却不知道干什么
  for (const [name, kb] of [['SITE_KB', SITE_KB], ['TEXT_KB', TEXT_KB]]) {
    const missing = kb.filter((k) => !k.match || !k.item.what || !k.item.verdict)
    ok(missing.length === 0, `${name} 有条目缺字段：` + missing.map((k) => k.match).join(','))
    const noTip = kb.filter((k) => k.item.verdict !== 'normal' && !k.item.advice)
    ok(noTip.length === 0, `${name} 非 normal 条目缺建议：` + noTip.map((k) => k.match).join(','))
    const keys = kb.map((k) => k.match)
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i)
    ok(dup.length === 0, `${name} 有重复键：` + dup.join(','))
    // 太短的键会横扫一切：拿 "fail"/"timeout" 当键等于没判断
    const tooShort = keys.filter((k) => k.length < 4)
    ok(tooShort.length === 0, `${name} 键太短容易误伤：` + tooShort.join(','))
  }

  // 文案表的键必须是小写，否则 includes 永远匹配不上
  const upper = TEXT_KB.filter((k) => k.match !== k.match.toLowerCase())
  ok(upper.length === 0, 'TEXT_KB 键必须小写：' + upper.map((k) => k.match).join(','))
}

console.log(`✓ unit-oblog: ${n} 个断言通过`)
