/**
 * OB 日志分析（observer / rootservice / election / trace）。
 *
 * 设计取舍：
 * 1. 不把日志文件拉回来。observer.log 在繁忙集群上 20 分钟就能写满 256MB、
 *    刷 65 万行；而 execCommand 的 cap/clipHeadTail 只保留末 64KB，拿它读日志
 *    会被静默截断。所以远端 awk 一趟就算完「级别分布 / 代码位置热点 / 错误码计数」，
 *    只回传几十 KB 聚合结果，每个错误码额外带首条样例。
 * 2. 不依赖 obdiag。obdiag 默认 --log_level=WARN，而健康集群 WARN 恒为 0，
 *    直接查不出东西；且 4.3.0 的终端「By Tenant」汇总表 Count 全是 0（实测 bug），
 *    真实计数只在 result_details.txt 里。本模块独立工作，obdiag 留给采集/巡检场景。
 * 3. 时间窗在远端用 `date -d` 算，不用本机时钟——客户端与服务端时区/时钟偏差
 *    会让窗口整体错位，而日志时间戳是服务端本地时间。
 */
import type { SshServer } from './types'
import { getSshClient } from './ssh'
import { buildSummary, explainErrCode, explainHotSpot, type ObLogSummary, type ObVerdict } from './oblogExplain'

// 结论类型与解释库同住 oblogExplain（纯逻辑可单测），这里转出去给 api.d.ts 用
export type { ObLogSummary } from './oblogExplain'

export type ObLogScope = 'observer' | 'rootservice' | 'election' | 'trace'

export interface ObLogFile {
  name: string
  size: number
  /** 秒级时间戳 */
  mtime: number
}

export interface ObLogProbe {
  ok: boolean
  error?: string
  logDir?: string
  /** 目录是怎么定下来的，便于排查 */
  detectedBy?: string
  files?: ObLogFile[]
  totalBytes?: number
  disk?: { mount: string; size: number; used: number; avail: number; usePct: number } | null
}

export interface ObLogRow {
  key: string
  count: number
  /** errCodes 专有：由样例提炼的短标签（如「需要等待（OB_NEED_WAIT）」） */
  msg?: string
  sample?: string
  first?: string
  last?: string
  /** 热点专有：函数名，判断「在干什么」最有效的锚点 */
  func?: string
  /** 人话解释：这是什么 */
  what?: string
  /** normal 可忽略 / watch 注意 / bad 要处理 */
  verdict?: ObVerdict
  /** 怎么办（verdict=normal 时常为空） */
  advice?: string
  /** 命中的解释规则，便于自检 */
  rule?: string
}

export interface ObLogResult {
  ok: boolean
  error?: string
  logDir: string
  scope: ObLogScope
  windowStart: string
  windowEnd: string
  /** 实际扫描的文件数 / 字节数；超上限会在 truncated 标记 */
  filesScanned: number
  bytesScanned: number
  truncated: boolean
  /** 窗口内总行数（只统计能解析出时间戳的行） */
  total: number
  /** 续行（多行日志的后半段，没有时间戳前缀） */
  continuations: number
  linesPerHour: number
  levels: ObLogRow[]
  hotSpots: ObLogRow[]
  errCodes: ObLogRow[]
  summary?: ObLogSummary
}

/** 单次扫描上限：3GB 大约对应 1 小时的高峰日志，再大就该缩窗口了 */
const MAX_SCAN_BYTES = 3 * 1024 * 1024 * 1024

function q(s: string): string {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'"
}

interface CaptureResult {
  code: number | null
  out: string
  err: string
  timedOut: boolean
}

/**
 * 独立的执行封装：与 ssh.ts 的 execCommand 共用连接池，但不做 64KB 截断。
 * 聚合结果可能上百 KB（文件位置热点多的时候），被截断会导致解析出半条记录。
 */
function execCapture(server: SshServer, cmd: string, timeoutMs = 120000, maxBytes = 8 * 1024 * 1024): Promise<CaptureResult> {
  return getSshClient(server).then(
    (c) =>
      new Promise<CaptureResult>((resolve) => {
        let out = ''
        let er = ''
        let trimmed = false
        let settled = false
        let stream: any = null
        const finish = (code: number | null, timedOut = false) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ code, out: trimmed ? out + '\n@@TRUNCATED@@' : out, err: er, timedOut })
        }
        const timer = setTimeout(() => {
          try { stream?.close() } catch { /* 已关闭 */ }
          finish(null, true)
        }, timeoutMs)
        c.exec(cmd, (err, s) => {
          if (err) {
            clearTimeout(timer)
            settled = true
            resolve({ code: null, out: '', err: err.message, timedOut: false })
            return
          }
          stream = s
          s.on('data', (d: Buffer) => {
            if (out.length >= maxBytes) { trimmed = true; return }
            out += d.toString('utf8')
          })
          s.stderr.on('data', (d: Buffer) => { if (er.length < 64_000) er += d.toString('utf8') })
          s.on('error', () => { /* 由 close 收尾 */ })
          s.on('close', (code: number | null) => finish(code))
        })
      })
  )
}

const FALLBACK_DIRS = [
  '/home/admin/oceanbase/log',
  '/root/observer/log',
  '/oceanbase/log',
  '/data/observer/log',
  '/opt/oceanbase/log',
  '/data/1/observer/log'
]

/** 定位日志目录：优先按 observer 进程的真实二进制路径推，再退到常见路径 */
export async function probeObLog(server: SshServer, logDir?: string): Promise<ObLogProbe> {
  const probeScript = [
    'BIN=$(ps -eo args 2>/dev/null | awk \'/[o]bserver/{print $1; exit}\')',
    'HINT=""',
    'if [ -n "$BIN" ]; then HINT=$(dirname "$(dirname "$BIN")")/log; fi',
    'FOUND=""',
    'BY=""',
    'if [ -n "$HINT" ] && [ -f "$HINT/observer.log" ]; then FOUND="$HINT"; BY="observer 进程路径"; fi',
    'if [ -z "$FOUND" ]; then',
    '  for p in ' + FALLBACK_DIRS.map(q).join(' ') + '; do',
    '    if [ -f "$p/observer.log" ]; then FOUND="$p"; BY="常见路径"; break; fi',
    '  done',
    'fi',
    'printf "@@DIR\\n%s\\n@@BY\\n%s\\n@@BIN\\n%s\\n@@END\\n" "$FOUND" "$BY" "$BIN"'
  ].join('\n')

  const want = logDir || ''
  const r = await execCapture(server, want ? `ls -d ${q(want)} 2>/dev/null && echo "@@DIR" && echo ${q(want)} && echo "@@BY" && echo "指定目录" && echo "@@END"` : probeScript, 30_000)

  let dir = ''
  let by = ''
  const lines = r.out.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '@@DIR') dir = (lines[i + 1] || '').trim()
    else if (lines[i] === '@@BY') by = (lines[i + 1] || '').trim()
  }
  if (!dir) {
    return { ok: false, error: `未找到日志目录（已尝试 ${FALLBACK_DIRS.length} 个常见路径，且未能从 observer 进程路径推断）` }
  }

  const script = [
    'printf "@@FILES\\n"',
    `find ${q(dir)} -maxdepth 1 -type f \\( -name 'observer.log*' -o -name 'rootservice.log*' -o -name 'election.log*' -o -name 'trace.log*' \\) -printf '%f\\t%s\\t%T@\\n' 2>/dev/null`,
    'printf "@@DISK\\n"',
    `df -P ${q(dir)} 2>/dev/null | tail -1`,
    'printf "@@USIZE\\n"',
    `du -sb ${q(dir)} 2>/dev/null | awk '{print $1}'`,
    'printf "@@END\\n"'
  ].join('\n')

  const r2 = await execCapture(server, script, 60_000)
  if (r2.code !== 0 && !r2.out.includes('@@FILES')) {
    return { ok: false, error: `读取日志目录失败：${r2.err || '未知错误'}` }
  }

  const files: ObLogFile[] = []
  let totalBytes = 0
  let disk: ObLogProbe['disk'] = null
  let section = ''
  let dirSize = 0
  for (const raw of r2.out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('@@')) { section = line.slice(2); continue }
    if (!line.trim()) continue
    if (section === 'FILES') {
      const p = line.split('\t')
      if (p.length < 3) continue
      const size = Number(p[1]) || 0
      files.push({ name: p[0], size, mtime: Math.round(Number(p[2]) || 0) })
      totalBytes += size
    } else if (section === 'DISK') {
      const p = line.trim().split(/\s+/)
      if (p.length >= 6) {
        disk = {
          mount: p[5],
          size: Number(p[1]) * 1024,
          used: Number(p[2]) * 1024,
          avail: Number(p[3]) * 1024,
          usePct: Number(String(p[4]).replace('%', '')) || 0
        }
      }
    } else if (section === 'USIZE') {
      dirSize = Number(line.trim()) || 0
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return { ok: true, logDir: dir, detectedBy: by || '指定目录', files, totalBytes: dirSize || totalBytes, disk }
}

const AWK = String.raw`
function site_of(s,   n, i, p, parts, one, fn) {
  n = split(s, parts, "(")
  for (i = 2; i <= n; i++) {
    one = parts[i]
    if (one ~ /^[A-Za-z_0-9.]+\.(cpp|h|ipp|cc|hpp|hxx):[0-9]+\)/) {
      p = index(one, ")")
      # 函数名取「(」前那段里最后一个词：[STORAGE] get_kept_multi_version_start
      #   → get_kept_multi_version_start。解释库按函数名匹配，比 文件:行 稳。
      fn = parts[i - 1]
      sub(/.*[ \t]/, "", fn)
      FUNC = fn
      return substr(one, 1, p - 1)
    }
  }
  FUNC = ""
  return ""
}
{
  if (substr($0, 1, 1) != "[") { cont++; next }
  ts = substr($0, 2, 26)
  d19 = substr(ts, 1, 19)
  if (d19 < S || d19 > E) next
  rest = substr($0, 30)
  sp = index(rest, " ")
  if (sp < 2) next
  lv = substr(rest, 1, sp - 1)
  if (lv !~ /^[A-Z]+$/) next
  total++
  L[lv]++
  st = site_of(substr(rest, sp + 1))
  if (st != "") {
    H[st]++
    if (!(st in HS)) { HS[st] = substr($0, 1, 130); HF[st] = FUNC }
  }
  ei = index($0, "[errcode=")
  if (ei > 0) {
    r = substr($0, ei + 9)
    q2 = index(r, "]")
    if (q2 > 1) {
      c = substr(r, 1, q2 - 1)
      E_[c]++
      if (!(c in EF)) { EF[c] = ts; ES[c] = substr($0, 1, 220) }
      EL[c] = ts
    }
  }
}
END {
  printf "T\t%d\n", total
  printf "X\t%d\n", cont
  for (k in L) printf "L\t%s\t%d\n", k, L[k]
  for (k in H) printf "H\t%s\t%d\t%s\t%s\n", k, H[k], HS[k], HF[k]
  for (k in E_) printf "E\t%s\t%d\t%s\t%s\t%s\n", k, E_[k], EF[k], EL[k], ES[k]
}
`

/** 常见 OB 错误码补齐可读名（日志里的 message 片段往往只有半句） */
const CODE_NAMES: Record<string, string> = {
  '-4002': '参数非法',
  '-4006': '对象未初始化',
  '-4007': '不支持的语法/功能',
  '-4008': '迭代结束',
  '-4009': 'IO 错误',
  '-4013': '超时',
  '-4018': '条目不存在',
  '-4023': '请重试',
  '-4024': '非 Leader',
  '-4030': '主备/角色不允许',
  '-4031': '事务上下文不允许',
  '-4043': '用户认证失败',
  '-4076': '需要等待（OB_NEED_WAIT）',
  '-4138': 'schema 版本不匹配',
  '-4147': '已存在同名对象',
  '-4152': '空值',
  '-4189': '租户资源不足',
  '-4216': 'curl 失败',
  '-4235': '表/分区不存在',
  '-5019': '表不存在',
  '-5024': '列已存在',
  '-5026': '非法表名',
  '-5030': '无法识别的列',
  '-5055': '函数不存在',
  '-5134': '未选择数据库',
  '-5154': '未知数据库',
  '-5217': '未知列',
  '-5543': '未声明的变量',
  '-6004': '锁冲突',
  '-6005': '行锁等待超时',
  '-6006': '主键冲突'
}

function errMessage(sample: string | undefined, code: string): string {
  if (!sample) return CODE_NAMES[code] || ''
  const m = sample.match(/\[errcode=[^\]]*\]\s*(.{0,160})/)
  let text = ''
  if (m) text = m[1]
  else {
    const p = sample.match(/\([^)]*\.(?:cpp|h|ipp|cc|hpp|hxx):\d+\)\s*(.{0,160})/)
    text = p ? p[1] : ''
  }
  text = text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
  const name = CODE_NAMES[code]
  if (name && text) return `${name} · ${text.slice(0, 90)}`
  return name || text.slice(0, 90)
}

export interface ObLogOpts {
  scope?: ObLogScope
  sinceMinutes?: number
  logDir?: string
  maxBytes?: number
}

export async function analyzeObLog(server: SshServer, opts: ObLogOpts = {}): Promise<ObLogResult> {
  const scope: ObLogScope = opts.scope || 'observer'
  const since = Math.max(1, Math.min(Number(opts.sinceMinutes) || 10, 7 * 24 * 60))
  const base: ObLogProbe = await probeObLog(server, opts.logDir)
  if (!base.ok || !base.logDir) {
    return {
      ok: false,
      error: base.error || '未找到日志目录',
      logDir: base.logDir || '',
      scope,
      windowStart: '',
      windowEnd: '',
      filesScanned: 0,
      bytesScanned: 0,
      truncated: false,
      total: 0,
      continuations: 0,
      linesPerHour: 0,
      levels: [],
      hotSpots: [],
      errCodes: []
    }
  }
  const logDir = base.logDir

  // 时间窗在远端算：客户端时钟/时区不可信
  const winScript = [
    `date -d '-${since} minutes' '+%s|%Y-%m-%d %H:%M:%S'`,
    `date '+%s|%Y-%m-%d %H:%M:%S'`,
    `find ${q(logDir)} -maxdepth 1 -type f -name ${q(scope + '.log*')} -printf '%f\\t%s\\t%T@\\n' 2>/dev/null`,
    'echo @@END'
  ].join('\n')
  const win = await execCapture(server, winScript, 60_000)
  if (win.code !== 0 && !win.out.includes('@@END')) {
    return {
      ok: false,
      error: `读取时间窗/文件清单失败：${win.err || '未知错误'}`,
      logDir,
      scope,
      windowStart: '',
      windowEnd: '',
      filesScanned: 0,
      bytesScanned: 0,
      truncated: false,
      total: 0,
      continuations: 0,
      linesPerHour: 0,
      levels: [],
      hotSpots: [],
      errCodes: []
    }
  }

  const rows = win.out.split('\n').map((s) => s.replace(/\r$/, ''))
  let startEpoch = 0
  let startText = ''
  let endText = ''
  const all: { name: string; size: number; mtime: number }[] = []
  let idx = 0
  if (rows[0] && rows[0].includes('|')) {
    const p = rows[0].split('|')
    startEpoch = Number(p[0]) || 0
    startText = p[1] || ''
  }
  if (rows[1] && rows[1].includes('|')) endText = (rows[1].split('|')[1] || '')
  for (let i = 2; i < rows.length; i++) {
    const line = rows[i]
    if (!line || line === '@@END') continue
    const p = line.split('\t')
    if (p.length < 3) continue
    // .wf 是同一批 WARN/FATAL 的副本，与 observer.log 内容重复，一起扫会重复计数
    if (p[0].includes('.wf')) continue
    all.push({ name: p[0], size: Number(p[1]) || 0, mtime: Math.round(Number(p[2]) || 0) })
  }
  if (!startText) {
    // 极端情况：date 不可用，退化成本机时间（可能与服务端有偏差）
    const now = Date.now()
    const d = new Date(now - since * 60_000)
    const f = (n: number) => String(n).padStart(2, '0')
    startText = `${d.getFullYear()}-${f(d.getMonth() + 1)}-${f(d.getDate())} ${f(d.getHours())}:${f(d.getMinutes())}:${f(d.getSeconds())}`
    const e = new Date(now)
    endText = `${e.getFullYear()}-${f(e.getMonth() + 1)}-${f(e.getDate())} ${f(e.getHours())}:${f(e.getMinutes())}:${f(e.getSeconds())}`
    startEpoch = Math.floor((now - since * 60_000) / 1000)
  }

  // 只扫与窗口有交集的文件：文件 mtime 早于窗口起点说明它整段都在窗口之前
  const overlap = all.filter((f) => f.mtime >= startEpoch - 60).sort((a, b) => b.mtime - a.mtime)
  const empty: ObLogResult = {
    ok: true,
    logDir,
    scope,
    windowStart: startText,
    windowEnd: endText,
    filesScanned: 0,
    bytesScanned: 0,
    truncated: false,
    total: 0,
    continuations: 0,
    linesPerHour: 0,
    levels: [],
    hotSpots: [],
    errCodes: []
  }
  if (!overlap.length) return empty

  const cap = Math.max(64 * 1024 * 1024, Number(opts.maxBytes) || MAX_SCAN_BYTES)
  const picked: typeof overlap = []
  let bytes = 0
  let truncated = false
  for (const f of overlap) {
    if (bytes + f.size > cap && picked.length) { truncated = true; break }
    picked.push(f)
    bytes += f.size
  }
  // awk 按时间顺序读，first/last 才有意义
  picked.sort((a, b) => a.mtime - b.mtime)

  const fileArgs = picked.map((f) => q(logDir.replace(/\/$/, '') + '/' + f.name)).join(' ')
  // LC_ALL=C：日志里混着非 UTF-8 字节，默认 locale 下 awk 会持续报
  // "Invalid multibyte data detected"；按字节解析反而更快也更稳定（我们只切 ASCII 前缀）
  const cmd = `LC_ALL=C awk -v S=${q(startText)} -v E=${q(endText)} ${q(AWK)} ${fileArgs}`
  const r = await execCapture(server, cmd, 300_000, 32 * 1024 * 1024)
  if (r.timedOut) return { ...empty, error: `扫描超时（已选中 ${picked.length} 个文件，建议缩短时间窗）` }
  if (r.code !== 0 && !r.out.includes('\t')) {
    return { ...empty, error: `awk 聚合失败：${r.err || '无输出'}` }
  }

  const levels: ObLogRow[] = []
  const hotSpots: ObLogRow[] = []
  const errCodes: ObLogRow[] = []
  let total = 0
  let cont = 0
  for (const line of r.out.split('\n')) {
    if (!line) continue
    const p = line.split('\t')
    if (p[0] === 'T') total = Number(p[1]) || 0
    else if (p[0] === 'X') cont = Number(p[1]) || 0
    else if (p[0] === 'L') levels.push({ key: p[1], count: Number(p[2]) || 0 })
    else if (p[0] === 'H') hotSpots.push({ key: p[1], count: Number(p[2]) || 0, sample: p[3] || undefined, func: p[4] || undefined })
    else if (p[0] === 'E') {
      // errcode=0 是"成功"占位，不是错误；混进来会把错误码表冲淡
      if (p[1] === '0' || p[1] === '') continue
      errCodes.push({ key: p[1], count: Number(p[2]) || 0, first: p[3], last: p[4], sample: p[5] || undefined })
    }
  }

  // 级别按严重度排序（OB 的顺序：DEBUG < TRACE < INFO < WDIAG < WARN < EDIAG < ERROR）
  const order = ['DEBUG', 'TRACE', 'INFO', 'WDIAG', 'WARN', 'EDIAG', 'ERROR']
  levels.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99))
  hotSpots.sort((a, b) => b.count - a.count)
  errCodes.sort((a, b) => b.count - a.count)
  // 可读短标签放 msg：sample 要原样留到点开时看，不能被覆盖
  for (const e of errCodes.slice(0, 60)) e.msg = errMessage(e.sample, e.key)

  // 挂人话解释：DBA 真正要的是「这要不要管」，不是错误码数字
  const hot = hotSpots.slice(0, 40)
  const errs = errCodes.slice(0, 40)
  for (const h of hot) {
    const ex = explainHotSpot(h.key, h.sample)
    h.what = ex.what
    h.verdict = ex.verdict
    h.advice = ex.advice
    h.rule = ex.rule
  }
  for (const e of errs) {
    const ex = explainErrCode(e.key, e.sample)
    e.what = ex.what
    e.verdict = ex.verdict
    e.advice = ex.advice
    e.rule = ex.rule
  }

  return {
    ok: true,
    logDir,
    scope,
    windowStart: startText,
    windowEnd: endText,
    filesScanned: picked.length,
    bytesScanned: bytes,
    truncated,
    total,
    continuations: cont,
    linesPerHour: Math.round((total / since) * 60),
    levels,
    hotSpots: hot,
    errCodes: errs,
    summary: buildSummary(total, levels, hot, Math.round((total / since) * 60), errs)
  }
}

