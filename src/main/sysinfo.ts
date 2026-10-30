// 本机资源采集（设置输入区下方"资源"面板的数据源）。
// CPU 占用率用"两次请求差分"：面板 2s 轮询 → 2s 采样窗口，平滑且零后台开销；
// 磁盘用 fs.promises.statfs 逐盘符探测（Node 18.15+/Electron 33，无子进程、无 wmic 依赖）。
// 注意：必须用异步 statfs——主进程承载全部 IPC/DB/Agent，同步版本每 2s 逐盘 syscall 会卡住事件循环。

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

export interface DiskInfo {
  drive: string
  totalBytes: number
  freeBytes: number
  usedPct: number
}

/** 单个 ACPI 热区读数 */
export interface TempZone {
  /** 热区短名，如 TZS0（已去掉 \_TZ. 前缀） */
  zone: string
  celsius: number
}

/**
 * 温度快照。
 *
 * 采集代价远高于 CPU/内存（需要起 PowerShell 读性能计数器），所以**不与 3 秒轮询同步**，
 * 而是主进程侧独立节流缓存：成功 30 秒一次、失败 5 分钟后才重试，轮询只读缓存。
 * at=0 表示还没采过，前端据此显示"读取中"，避免把"未采到"说成"不支持"。
 */
export interface TempInfo {
  zones: TempZone[]
  /** 各热区最高温度（℃）；null 表示当前没有可用读数 */
  maxCelsius: number | null
  at: number
  error: string | null
}

export interface SysResources {
  cpu: {
    model: string
    cores: number
    /** 距上次请求的占用率（首次请求无差分窗口，为 null） */
    usagePct: number | null
    perCore: number[]
  }
  mem: {
    totalBytes: number
    freeBytes: number
    usedPct: number
  }
  disks: DiskInfo[]
  app: {
    rssBytes: number
    /** SQLPilot 进程 CPU，相对单核（多线程可 >100%） */
    cpuPct: number | null
  }
  sys: {
    hostname: string
    platform: string
    uptimeSec: number
    /**
     * 本次「内核会话」的起点（ms）= now - uptimeSec。
     * Windows 开了快速启动时，关机再开机只是休眠恢复，内核计时不清零，
     * 于是 uptimeSec 会跨多次开关机累计（本机实测：9/02 起一直累加到 58 天）。
     * 界面上补一个具体日期，用户才能自己判断这个数字是否等于"我上次开机"。
     */
    bootAt: number
  }
  temp: TempInfo
}

let lastCpu: { at: number; total: number[]; idle: number[]; proc: { user: number; system: number } } | null = null

async function listDrives(): Promise<DiskInfo[]> {
  const out: DiskInfo[] = []
  for (let code = 67; code <= 90; code++) {
    // C..Z（跳过软驱年代的 A/B）；不存在/无介质的盘符 statfs 抛错即跳过
    const root = String.fromCharCode(code) + ':\\'
    try {
      const st = await fs.promises.statfs(root)
      const total = st.blocks * st.bsize
      const free = st.bavail * st.bsize
      if (total > 0) out.push({ drive: root.slice(0, 2), totalBytes: total, freeBytes: free, usedPct: Math.round((1 - free / total) * 1000) / 10 })
    } catch { /* 盘符不存在 */ }
  }
  return out
}

// ---------- 温度 ----------
//
// 数据来源：WMI 性能计数器 Win32_PerfFormattedData_Counters_ThermalZoneInformation
// （ACPI 热区）。选它而不是 root\WMI 的 MSAcpi_ThermalZoneTemperature，
// 因为后者普通用户读取会 0x80041003 拒绝访问，而性能计数器类**不需要管理员权限**（本机已验证）。
//
// 单位坑：该类的 Temperature 是**整数开尔文**，HighPrecisionTemperature 才是 0.1K
// （本机实测 333 / 3332，相差 10 倍）。按 0.1K 读 Temperature 会得到 -240℃ 这种值。
//
// 代价：每次都要起一个 PowerShell 子进程（本机实测约 1.9s，主要耗在 PowerShell 冷启动 + CIM 枚举），
// 绝不能跟着 3 秒轮询跑。因此这里自行节流 + 缓存：成功 30 秒一次；失败退避 5 分钟。

const TEMP_TTL_MS = 30_000
const TEMP_RETRY_MS = 5 * 60_000
const TEMP_TIMEOUT_MS = 8_000

/**
 * 用 -EncodedCommand 传脚本：普通命令行参数经过 Windows 引号转义后，
 * 内嵌双引号和中文很容易被 PowerShell 解析坏，base64(UTF-16LE) 则完全免疫。
 * ProgressPreference 置 SilentlyContinue：否则 CIM 的进度流会往 stderr 灌 CLIXML 噪音。
 */
const TEMP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try {',
  '  Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation |',
  '    ForEach-Object { "{0}`t{1}`t{2}" -f $_.Name, $_.Temperature, $_.HighPrecisionTemperature }',
  '} catch { "ERR`t" + $_.Exception.Message }'
].join('\r\n')

let tempCache: TempInfo = { zones: [], maxCelsius: null, at: 0, error: null }
let tempInFlight = false

function powershellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

function firstLine(s: string | undefined): string {
  return (s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || ''
}

/** 解析 stdout：每行「热区名 \t 整数K \t 0.1K」；ERR 开头的行是脚本捕获到的异常 */
function parseTempOutput(stdout: string): { zones: TempZone[]; error: string | null } {
  const zones: TempZone[] = []
  let error: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    const [name, whole, precise] = s.split('\t')
    if (name === 'ERR') { error = whole || '采样失败'; continue }
    const p = Number(precise)
    const w = Number(whole)
    // 优先 HighPrecisionTemperature（0.1K）；部分平台只有整数 K
    const celsius = Number.isFinite(p) && p > 0 ? p / 10 - 273.15 : Number.isFinite(w) && w > 0 ? w - 273.15 : NaN
    // 未加载/未接传感器的热区会返回 0 或越界值，直接丢
    if (!Number.isFinite(celsius) || celsius < -20 || celsius > 150) continue
    zones.push({ zone: (name || '').replace(/^\\_TZ\./, '') || s, celsius: Math.round(celsius * 10) / 10 })
  }
  // 有热区就不算错：error 只用于解释"一个都没读到"
  return { zones, error: zones.length ? null : (error || '本机未上报 ACPI 热区温度') }
}

/** 触发一次后台采样（不阻塞调用方，结果进缓存） */
function refreshTemps(now: number): void {
  const ttl = tempCache.error ? TEMP_RETRY_MS : TEMP_TTL_MS
  if (tempCache.at > 0 && now - tempCache.at < ttl) return
  if (tempInFlight) return
  if (process.platform !== 'win32') {
    tempCache = { zones: [], maxCelsius: null, at: now, error: '仅 Windows 支持本机温度读取' }
    return
  }
  tempInFlight = true
  const encoded = Buffer.from(TEMP_SCRIPT, 'utf16le').toString('base64')
  execFile(
    powershellPath(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: TEMP_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
    (err, stdout, stderr) => {
      tempInFlight = false
      const at = Date.now()
      if (err) {
        // execFile 超时杀掉子进程时走 killed；stderr 往往为空，此时只能靠 message
        const e = err as NodeJS.ErrnoException & { killed?: boolean }
        const msg = e.killed ? '采样超时' : (firstLine(stderr) || firstLine(e.message) || '采样失败')
        tempCache = { zones: [], maxCelsius: null, at, error: msg.slice(0, 120) }
        return
      }
      const parsed = parseTempOutput(stdout)
      tempCache = {
        zones: parsed.zones,
        maxCelsius: parsed.zones.length ? Math.max(...parsed.zones.map((z) => z.celsius)) : null,
        at,
        error: parsed.error
      }
    }
  )
}

export async function getSysResources(): Promise<SysResources> {
  const cpus = os.cpus()
  const now = Date.now()
  const total = cpus.map((c) => c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq)
  const idle = cpus.map((c) => c.times.idle)
  const proc = process.cpuUsage()

  let usagePct: number | null = null
  let perCore: number[] = []
  let appCpu: number | null = null
  if (lastCpu && now > lastCpu.at) {
    const elapsedSec = (now - lastCpu.at) / 1000
    perCore = total.map((t, i) => {
      const dTotal = t - lastCpu!.total[i]
      const dIdle = idle[i] - lastCpu!.idle[i]
      return dTotal > 0 ? Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)) : 0
    })
    usagePct = Math.round(perCore.reduce((a, b) => a + b, 0) / Math.max(1, perCore.length))
    const dProcSec = (proc.user - lastCpu.proc.user + proc.system - lastCpu.proc.system) / 1e6
    appCpu = Math.round((dProcSec / elapsedSec) * 100)
  }
  lastCpu = { at: now, total, idle, proc: { user: proc.user, system: proc.system } }

  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  // 温度只读缓存；缓存过期时顺手踢一次后台采样（不 await，绝不让面板等 PowerShell）
  refreshTemps(now)
  const uptimeSec = Math.round(os.uptime())
  return {
    cpu: { model: (cpus[0]?.model || '未知 CPU').trim().replace(/\s+/g, ' '), cores: cpus.length, usagePct, perCore },
    mem: { totalBytes: totalMem, freeBytes: freeMem, usedPct: Math.round(((totalMem - freeMem) / totalMem) * 100) },
    disks: await listDrives(),
    app: { rssBytes: process.memoryUsage().rss, cpuPct: appCpu },
    sys: {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      uptimeSec,
      bootAt: now - uptimeSec * 1000
    },
    temp: tempCache
  }
}
