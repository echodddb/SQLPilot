/**
 * 本机资源采样（单例）。
 *
 * 顶栏的资源概述与 AI 侧栏底部的迷你监控是同一份数据，必须共用**一个**轮询器：
 * 主进程的 CPU 占用率是「两次请求差分」（main/sysinfo.ts 的 lastCpu），
 * 两个轮询器交替调用会让差分窗口被切碎，两边都算出噪声值。
 *
 * 因此这里做成引用计数的单例：谁用谁 acquire，最后一个释放者关表；
 * 采样间隔、历史序列（sparkline 用）都是全应用共享的。
 */

import { getCurrentScope, onScopeDispose, reactive, ref } from 'vue'

export interface DiskRow {
  drive: string
  totalBytes: number
  freeBytes: number
  usedPct: number
}

/** 历史长度：3s 一个点 → 40 点 ≈ 2 分钟趋势 */
const HIST = 40

/**
 * 渲染层启动时刻（≈ 本次 SQLPilot 启动）。
 * 和 os.uptime()（整台机器开机至今）是两码事，界面上必须分开写清楚，
 * 否则「已运行 4 天」会被当成程序自己跑了 4 天。
 */
export const appStartedAt = Date.now()
const INTERVAL = 3_000

const cpuHist = ref<number[]>([])
const memHist = ref<number[]>([])
const lastCpu = ref<number | null>(null)
const memPct = ref<number | null>(null)
const cpuTitle = ref('CPU 占用率（3 秒采样窗口）')
const memTitle = ref('内存占用')
const disks = ref<DiskRow[]>([])
/** 最近一次原始快照：型号、线程数、本进程内存、主机名等展示用 */
const info = ref<{
  cpuModel: string
  cores: number
  memTotal: number
  memFree: number
  rssBytes: number
  appCpuPct: number | null
  hostname: string
  platform: string
  uptimeSec: number
  at: number
} | null>(null)

let timer: ReturnType<typeof setInterval> | null = null
let users = 0

export function fmtGB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(bytes > 100 * 1024 ** 3 ? 0 : 1)
}

/** 历史序列 → sparkline points（0..100 × 0..22 视区，与侧栏同一套坐标） */
export function spark(hist: number[]): string {
  if (hist.length < 2) return ''
  return hist
    .map((v, i) => `${((i / (hist.length - 1)) * 100).toFixed(1)},${(21 - (Math.min(100, v) / 100) * 19).toFixed(1)}`)
    .join(' ')
}

/** 占用率 → 语义等级（决定颜色：绿 / 黄 / 红），null 表示还没有采样窗口 */
export function lvl(v: number | null | undefined): string {
  return v == null ? '' : v > 90 ? 'danger' : v > 70 ? 'warn' : 'ok'
}

export function diskTitle(d: DiskRow): string {
  return `${d.drive} 共 ${fmtGB(d.totalBytes)} GB · 剩余 ${fmtGB(d.freeBytes)} GB · 已用 ${d.usedPct}%`
}

async function poll(): Promise<void> {
  try {
    const r = await window.sqlpilot.sysResources()
    memPct.value = r.mem.usedPct
    memHist.value = [...memHist.value, r.mem.usedPct].slice(-HIST)
    if (r.cpu.usagePct != null) {
      lastCpu.value = r.cpu.usagePct
      cpuHist.value = [...cpuHist.value, r.cpu.usagePct].slice(-HIST)
    }
    cpuTitle.value = `CPU ${r.cpu.model} · ${r.cpu.cores} 线程 · 近 ${HIST} 个采样点`
    disks.value = (r.disks || []).slice(0, 6)
    memTitle.value = `内存已用 ${fmtGB(r.mem.totalBytes - r.mem.freeBytes)} / ${fmtGB(r.mem.totalBytes)} GB`
    info.value = {
      cpuModel: r.cpu.model,
      cores: r.cpu.cores,
      memTotal: r.mem.totalBytes,
      memFree: r.mem.freeBytes,
      rssBytes: r.app.rssBytes,
      appCpuPct: r.app.cpuPct,
      hostname: r.sys.hostname,
      platform: r.sys.platform,
      uptimeSec: r.sys.uptimeSec,
      at: Date.now()
    }
  } catch {
    /* 主进程忙时跳过本轮，下一拍再试 */
  }
}

function start(): void {
  if (timer) return
  void poll()
  timer = setInterval(() => { void poll() }, INTERVAL)
}

function stop(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

/**
 * 在组件里取这份共享数据。
 * 用 onScopeDispose 而不是 onUnmounted：既能在组件卸载时释放，
 * 也能在 effectScope 里安全使用（没有活跃作用域时退化为常驻，不会报错）。
 */
export function useSysResources() {
  users += 1
  start()
  if (getCurrentScope()) {
    onScopeDispose(() => {
      users = Math.max(0, users - 1)
      if (users === 0) stop()
    })
  }
  return {
    cpuHist,
    memHist,
    lastCpu,
    memPct,
    cpuTitle,
    memTitle,
    disks,
    info,
    histLen: HIST,
    spark,
    lvl,
    fmtGB,
    diskTitle
  }
}
