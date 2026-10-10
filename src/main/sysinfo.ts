// 本机资源采集（设置输入区下方"资源"面板的数据源）。
// CPU 占用率用"两次请求差分"：面板 2s 轮询 → 2s 采样窗口，平滑且零后台开销；
// 磁盘用 fs.promises.statfs 逐盘符探测（Node 18.15+/Electron 33，无子进程、无 wmic 依赖）。
// 注意：必须用异步 statfs——主进程承载全部 IPC/DB/Agent，同步版本每 2s 逐盘 syscall 会卡住事件循环。

import fs from 'node:fs'
import os from 'node:os'

export interface DiskInfo {
  drive: string
  totalBytes: number
  freeBytes: number
  usedPct: number
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
  }
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
  return {
    cpu: { model: (cpus[0]?.model || '未知 CPU').trim().replace(/\s+/g, ' '), cores: cpus.length, usagePct, perCore },
    mem: { totalBytes: totalMem, freeBytes: freeMem, usedPct: Math.round(((totalMem - freeMem) / totalMem) * 100) },
    disks: await listDrives(),
    app: { rssBytes: process.memoryUsage().rss, cpuPct: appCpu },
    sys: { hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`, uptimeSec: Math.round(os.uptime()) }
  }
}
