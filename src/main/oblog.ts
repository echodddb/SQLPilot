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
  // 用 echo 而不是 printf 一次吐多行：每个哨兵独立成段，解析时不用靠行号猜。
  // 关键命令的退出码单独回传（@@FINDE），否则「命令失败」会和「没有文件」分不开。
  const probeScript = [
    'BIN=$(ps -eo args 2>/dev/null | LC_ALL=C awk \'/[o]bserver/{print $1; exit}\')',
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
    'echo "@@DIR"',
    'echo "$FOUND"',
    'echo "@@BY"',
    'echo "$BY"',
    'echo "@@BIN"',
    'echo "$BIN"'
  ].join('\n')

  const want = logDir || ''
  // 指定目录时把失败原因带回来：原来 ls 失败会被兜底文案说成「已尝试 6 个常见路径」，
  // 实际上一个都没试，用户据此会去查错地方
  const wantScript = [
    `if [ -d ${q(want)} ]; then`,
    '  echo "@@DIR"',
    `  echo ${q(want)}`,
    '  echo "@@BY"',
    '  echo "指定目录"',
    'else',
    '  echo "@@ERR"',
    `  echo ${q('指定的日志目录不存在或不可访问：' + want)}`,
    'fi'
  ].join('\n')

  const r = await execCapture(server, want ? wantScript : probeScript, 30_000)

  let dir = ''
  let by = ''
  let probeErr = ''
  let section = ''
  for (const raw of r.out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('@@')) { section = line.slice(2).trim(); continue }
    if (section === 'DIR' && line.trim()) dir = line.trim()
    else if (section === 'BY' && line.trim()) by = line.trim()
    else if (section === 'ERR' && line.trim()) probeErr = line.trim()
  }
  if (!dir) {
    if (probeErr) return { ok: false, error: probeErr }
    if (r.err) return { ok: false, error: `定位日志目录失败：${r.err}` }
    return { ok: false, error: `未找到日志目录（已尝试 ${FALLBACK_DIRS.length} 个常见路径，且未能从 observer 进程路径推断）` }
  }

  const script = [
    'echo "@@ISDIR"',
    `test -d ${q(dir)} && echo 1 || echo 0`,
    'echo "@@READABLE"',
    `test -r ${q(dir)} && echo 1 || echo 0`,
    'echo "@@FILES"',
    `find ${q(dir)} -maxdepth 1 -type f \\( -name 'observer.log*' -o -name 'rootservice.log*' -o -name 'election.log*' -o -name 'trace.log*' \\) -printf '%f\\t%s\\t%T@\\n' 2>/dev/null`,
    // 必须先存再 echo：`echo "@@FINDE"` 本身会把 $? 重置成 0
    'RC=$?',
    'echo "@@FINDE"',
    'echo "$RC"',
    'echo "@@DISK"',
    `df -P ${q(dir)} 2>/dev/null | tail -1`,
    'echo "@@USIZE"',
    `du -sb ${q(dir)} 2>/dev/null | cut -f1`,
    'echo "@@END"'
  ].join('\n')

  const r2 = await execCapture(server, script, 60_000)
  if (r2.timedOut) return { ok: false, error: `读取日志目录超时（${dir}）` }

  const files: ObLogFile[] = []
  let totalBytes = 0
  let disk: ObLogProbe['disk'] = null
  let isDir = true
  let readable = true
  let findCode = 0
  let dirSize = 0
  let sec = ''
  for (const raw of r2.out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('@@')) { sec = line.slice(2).trim(); continue }
    if (!line.trim()) continue
    if (sec === 'ISDIR') { isDir = line.trim() === '1'; continue }
    if (sec === 'READABLE') { readable = line.trim() === '1'; continue }
    if (sec === 'FINDE') { findCode = Number(line.trim()) || 0; continue }
    if (sec === 'FILES') {
      const p = line.split('\t')
      if (p.length < 3) continue
      const size = Number(p[1]) || 0
      files.push({ name: p[0], size, mtime: Math.floor(Number(p[2]) || 0) })
      totalBytes += size
    } else if (sec === 'DISK') {
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
    } else if (sec === 'USIZE') {
      dirSize = Number(line.trim()) || 0
    }
  }

  // 「目录不存在」「没有读权限」「目录可读但一个日志都没有」必须分得开：
  // 三者都表现为 files: []，但只有第三种是真的没有日志
  if (!isDir) return { ok: false, error: `日志路径不是目录：${dir}` }
  if (!readable) return { ok: false, error: `没有读取权限：${dir}（换有权限的账号，或让 DBA 临时放开权限）` }
  if (findCode !== 0) {
    return { ok: false, error: `扫描日志目录失败（find 退出码 ${findCode}）：${r2.err || dir}` }
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
      # 先削掉尾部分隔符再取最后一个词：parts[i-1] 结尾是空格（"INFO [STORAGE] get_xxx "），
      # 直接 sub(/.*[ \t]/) 贪婪匹配会连整段一起吃掉，FN 永远是空串
      sub(/[ \t]+$/, "", fn)
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
      # 样例从 errcode 位置开始截：从行首截 220 字符的话，正文本常常已经被切掉，
      # 而「No space left」这类文案正是判定要靠的东西
      if (!(c in EF)) { EF[c] = ts; ES[c] = substr($0, ei, 220) }
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

/**
 * 失败结果：必须是 ok:false。
 * 这里单独开一个函数而不是 `{ ...empty, error }` —— empty 的 ok 是 true，
 * 展开后 error 会被渲染层整个丢掉（它只认 !ok），界面就变成绿色「一切正常」。
 */
function failedObLog(logDir: string, scope: ObLogScope, error: string): ObLogResult {
  return {
    ok: false,
    error,
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

export async function analyzeObLog(server: SshServer, opts: ObLogOpts = {}): Promise<ObLogResult> {
  const scope: ObLogScope = opts.scope || 'observer'
  const since = Math.max(1, Math.min(Number(opts.sinceMinutes) || 10, 7 * 24 * 60))
  const base: ObLogProbe = await probeObLog(server, opts.logDir)
  if (!base.ok || !base.logDir) {
    return failedObLog(base.logDir || '', scope, base.error || '未找到日志目录')
  }
  const logDir = base.logDir

  // 时间窗在远端算：客户端时钟/时区不可信。
  // 每个哨兵都要能独立判定 —— 原来的 `code !== 0 && !includes('@@END')` 恒为假
  // （@@END 是最后一句无条件 echo，退出码也是它自己的 0），等于完全没有错误检测。
  const winScript = [
    'echo "@@START"',
    `date -d '-${since} minutes' '+%s|%Y-%m-%d %H:%M:%S' 2>/dev/null`,
    'echo "@@NOW"',
    `date '+%s|%Y-%m-%d %H:%M:%S' 2>/dev/null`,
    'echo "@@FILES"',
    `find ${q(logDir)} -maxdepth 1 -type f -name ${q(scope + '.log*')} -printf '%f\\t%s\\t%T@\\n' 2>/dev/null`,
    'RC=$?',
    'echo "@@FINDE"',
    'echo "$RC"',
    'echo "@@END"'
  ].join('\n')
  const win = await execCapture(server, winScript, 60_000)
  if (win.timedOut) return failedObLog(logDir, scope, '读取时间窗/文件清单超时')

  let startEpoch = 0
  let endEpoch = 0
  let startText = ''
  let endText = ''
  let findCode = 0
  const all: { name: string; size: number; mtime: number }[] = []
  let widx = ''
  for (const raw of win.out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('@@')) { widx = line.slice(2).trim(); continue }
    if (!line.trim()) continue
    if (widx === 'START') {
      const p = line.split('|')
      startEpoch = Number(p[0]) || 0
      startText = p[1] || ''
    } else if (widx === 'NOW') {
      const p = line.split('|')
      endEpoch = Number(p[0]) || 0
      endText = p[1] || ''
    } else if (widx === 'FINDE') {
      findCode = Number(line.trim()) || 0
    } else if (widx === 'FILES') {
      const p = line.split('\t')
      if (p.length < 3) continue
      // .wf 是同一批 WARN/FATAL 的副本，与 observer.log 内容重复，一起扫会重复计数
      if (p[0].includes('.wf')) continue
      all.push({ name: p[0], size: Number(p[1]) || 0, mtime: Math.floor(Number(p[2]) || 0) })
    }
  }

  // 时间窗算不出来就直接失败。原来会静默退化成「客户端时钟」，还可能是零长度窗口，
  // 两条路都会让界面显示「0 行 = 集群很干净」，比报错危险得多。
  if (!startText || !startEpoch || !endText || !endEpoch) {
    return failedObLog(
      logDir,
      scope,
      `远端没能算出时间窗（date -d '-${since} minutes' 失败）。OB 主机一般是 GNU date，若为 BusyBox 请手动指定时间范围`
    )
  }
  if (endEpoch <= startEpoch) {
    return failedObLog(logDir, scope, `远端时间窗异常：开始 ${startEpoch} ≥ 结束 ${endEpoch}`)
  }
  const spanMin = (endEpoch - startEpoch) / 60
  if (Math.abs(spanMin - since) > Math.max(2, since * 0.1)) {
    return failedObLog(
      logDir,
      scope,
      `远端时间窗与请求不符：请求 ${since} 分钟，实际 ${Math.round(spanMin)} 分钟（${startText} → ${endText}）`
    )
  }
  if (findCode !== 0) {
    return failedObLog(logDir, scope, `扫描日志文件失败（find 退出码 ${findCode}）：${win.err || logDir}`)
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
  if (r.timedOut) return failedObLog(logDir, scope, `扫描超时（已选中 ${picked.length} 个文件，建议缩短时间窗或指定 logDir）`)
  const gotTotal = /(^|\n)T\t\d+/.test(r.out)
  if (!gotTotal) {
    return failedObLog(logDir, scope, `awk 聚合失败：${r.err || '没有输出'}（选中 ${picked.length} 个文件）`)
  }
  // 有 T 行说明统计跑起来了，但退出码非 0 = 有文件没读成功（权限/被删/EOF 中途），
  // 这时的数字是「部分文件」的结果，必须让用户看见
  const partial: string[] = []
  if (r.code !== 0) partial.push(`退出码 ${r.code ?? 'null'}，部分文件可能没读到：${r.err || '无 stderr'}`)
  // 远端输出超过 32MB 被截断时，排在后半段的低频高危错误码会被整段丢掉
  if (r.out.includes('@@TRUNCATED@@')) {
    partial.push('远端输出超过 32MB 已截断，热点与错误码统计不完整')
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

  // 挂人话解释：DBA 真正要的是「这要不要管」，不是错误码数字。
  // 注意这里挂的是**全量**：summary 的 bad 判定必须看到所有条目，
  // 先 slice(0,40) 再判会让第 41 名之后的低频高危错误悄悄消失。
  for (const h of hotSpots) {
    const ex = explainHotSpot(h.key, h.sample)
    h.what = ex.what
    h.verdict = ex.verdict
    h.advice = ex.advice
    h.rule = ex.rule
  }
  for (const e of errCodes) {
    const ex = explainErrCode(e.key, e.sample)
    e.what = ex.what
    e.verdict = ex.verdict
    e.advice = ex.advice
    e.rule = ex.rule
  }
  // 展示只取 Top40（界面本来也只渲染这么多），判定用全量
  const hot = hotSpots.slice(0, 40)
  const errs = errCodes.slice(0, 40)

  if (partial.length) truncated = true

  return {
    ok: true,
    // ok:true + error = 「数据拿到了但不完整」，渲染层会显示红色横幅而不是当成成功
    error: partial.length ? partial.join('；') : undefined,
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
    summary: buildSummary(total, levels, hotSpots, Math.round((total / since) * 60), errCodes)
  }
}

