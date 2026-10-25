/**
 * WorkBuddy 模型通道（受管本地桥）。
 *
 * 为什么不直连：WorkBuddy 的登录 token 是 AES-256-GCM 字段信封，密钥由客户端主进程
 * 运行时持有并只注入给它的子进程（`WORKBUDDY_AT_REST_ENCRYPTION`），磁盘上没有可解材料；
 * 上游 `copilot.tencent.com/v2/chat/completions` 还要 HMAC 签名头。自己复刻等于每个月
 * 跟着上游改，而且属于绕开它的凭据保护，不做。
 *
 * 这里的做法：把 MIT 许可的 workbuddy-to-dsh 桥（vendor/workbuddy-bridge）当子进程托管，
 * 由它用**官方授权流程**取出令牌、把私有协议翻译成 OpenAI 协议；本进程只跟 127.0.0.1 说话。
 *
 * 端口：桥监听回环端口（默认 8790，被占用就顺延）；控制台（8792）默认不启，只有用户点
 * 「登录 WorkBuddy」时才临时拉起。
 * 令牌：每次启动前由本进程生成/复用（DPAPI 存 secrets.json），通过环境变量注入桥，
 * 不读也不写桥自己的 .bridge-token，所以 SQLPilot 里不需要用户手填 API Key。
 */
import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { getPassword, setPassword } from './secrets'
import type { ProviderConfig } from './types'

export interface BridgeStatus {
  /** 已就绪（/v1/models 能返回 200） */
  running: boolean
  /** 正在启动（首次启动要拉起 WorkBuddy 取密钥，可能要几秒） */
  starting: boolean
  port: number
  baseUrl: string
  /** 最近一次失败原因（给设置页显示） */
  error?: string
  /** 桥的可执行根目录（诊断用） */
  root?: string
}

const DEFAULT_PORT = 8790
const PORT_TRIES = 20
const TOKEN_KEY = 'wb-bridge'

let child: ChildProcess | null = null
let port = 0
let starting: Promise<BridgeStatus> | null = null
let wantRunning = false
let restarts = 0
let lastError = ''
let ready = false

/** 桥根目录：打包后 vendor 被 asarUnpack 到 app.asar.unpacked，spawn 不能直接跑 asar 内的文件 */
function bridgeRoot(): string {
  const appPath = app.getAppPath()
  const candidates = [
    appPath.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked'),
    appPath
  ]
  for (const base of candidates) {
    const p = path.join(base, 'vendor', 'workbuddy-bridge')
    if (fs.existsSync(path.join(p, 'bridge', 'launch.mjs'))) return p
  }
  return path.join(candidates[0], 'vendor', 'workbuddy-bridge')
}

/** 回环令牌：DPAPI 存一份，桥与本进程共用；不落明文、不进日志 */
export function bridgeToken(): string {
  let t = getPassword(TOKEN_KEY)
  if (!t) {
    t = crypto.randomBytes(24).toString('hex')
    try { setPassword(TOKEN_KEY, t) } catch { /* 凭据库不可写时只在本进程内用 */ }
  }
  return t
}

function logFile(): string {
  return path.join(app.getPath('userData'), 'wb-bridge.log')
}

function appendLog(chunk: string): void {
  try {
    const f = logFile()
    const st = fs.existsSync(f) ? fs.statSync(f) : null
    // 日志轮转：超过 2MB 直接重开，桥的 stdout 很容易被刷满
    if (st && st.size > 2 * 1024 * 1024) fs.rmSync(f, { force: true })
    fs.appendFileSync(f, chunk)
  } catch { /* 日志失败不影响运行 */ }
}

function probeFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let p = start
    let tries = 0
    const next = () => {
      if (tries++ >= PORT_TRIES) return reject(new Error(`端口 ${start}~${start + PORT_TRIES} 都被占用`))
      const srv = net.createServer()
      srv.unref()
      srv.once('error', () => { p++; next() })
      srv.once('listening', () => srv.close(() => resolve(p)))
      srv.listen(p, '127.0.0.1')
    }
    next()
  })
}

async function ping(port: number, token: string, timeoutMs = 2500): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function bridgeStatus(): BridgeStatus {
  const running = ready && !!child
  return {
    running,
    starting: !!starting && !running,
    port: running ? port : 0,
    baseUrl: running ? `http://127.0.0.1:${port}/v1` : '',
    error: lastError || undefined,
    root: bridgeRoot()
  }
}

/**
 * 启动桥（幂等）。首次启动要等 WorkBuddy 侧取出 at-rest 密钥，最长等 25 秒。
 * 失败不抛给调用方以外的路径：直接返回 status，让 UI 显示原因。
 */
export async function startBridge(): Promise<BridgeStatus> {
  wantRunning = true
  if (ready && child) return bridgeStatus()
  if (starting) return starting
  starting = (async (): Promise<BridgeStatus> => {
    lastError = ''
    const root = bridgeRoot()
    if (!fs.existsSync(path.join(root, 'bridge', 'launch.mjs'))) {
      lastError = '内置桥文件缺失（vendor/workbuddy-bridge）'
      wantRunning = false
      return bridgeStatus()
    }
    try {
      port = await probeFreePort(DEFAULT_PORT)
    } catch (e: any) {
      lastError = String(e?.message || e)
      wantRunning = false
      return bridgeStatus()
    }
    const token = bridgeToken()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // 用 Electron 自己当 Node 跑桥：用户机器上不需要装 Node
      ELECTRON_RUN_AS_NODE: '1',
      WORKBUDDY_PORT: String(port),
      WORKBUDDY_LOCAL_TOKEN: token,
      // 桥的运行状态（账号选择等）放到 SQLPilot 的 userData，不污染安装目录
      WORKBUDDY_STATE_FILE: path.join(app.getPath('userData'), 'wb-bridge-state.json')
    }
    // 不设 DASHBOARD_PORT：控制台按需另起（见 openLogin）
    try {
      const c = spawn(process.execPath, [path.join(root, 'bridge', 'launch.mjs')], {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child = c
      c.stdout?.on('data', (d: Buffer) => appendLog(`[out] ${d.toString()}`))
      c.stderr?.on('data', (d: Buffer) => {
        const s = d.toString()
        appendLog(`[err] ${s}`)
        // 桥把关键失败写在 stderr（未登录、找不到 WorkBuddy 等），留最后一条给 UI
        const line = s.trim().split(/\r?\n/).filter(Boolean).pop()
        if (line) lastError = line.slice(0, 300)
      })
      c.on('exit', (code) => {
        child = null
        ready = false
        if (wantRunning && restarts < 3) {
          restarts++
          // 崩溃自动拉起：桥会去取密钥，偶发失败重启一次通常就好了
          setTimeout(() => { void startBridge() }, 1500 * restarts)
        }
      })
    } catch (e: any) {
      lastError = `启动桥失败：${e?.message || e}`
      wantRunning = false
      return bridgeStatus()
    }
    // 等桥可用：首次要拉起 WorkBuddy 取密钥，给足 25 秒
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      if (await ping(port, token)) {
        ready = true
        restarts = 0
        lastError = ''
        appendLog(`[ok] bridge ready on ${port}\n`)
        return bridgeStatus()
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    lastError = lastError || '桥启动超时（检查 WorkBuddy 是否已登录）'
    return bridgeStatus()
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

/** 停止桥（含子进程树）。Windows 上 launch.mjs 还会 fork 真正的桥进程，必须 /T */
export function stopBridge(): BridgeStatus {
  wantRunning = false
  ready = false
  // 主动停止不算错误：把上一次的 stderr 尾巴清掉，别让 UI 显示红字
  lastError = ''
  const pid = child?.pid
  child = null
  if (pid) {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } catch { /* 进程可能已退出 */ }
  }
  return bridgeStatus()
}

/** 首次请求时懒启动：用户没点「启动」也能直接用 */
export async function ensureBridge(): Promise<BridgeStatus> {
  if (ready && child) return bridgeStatus()
  return startBridge()
}

/**
 * 把 provider 解析成真正可用的端点：
 * - 端口/令牌一律用本机受管桥的（桥令牌只许发往回环地址，不能跟着 baseUrl 外泄）
 * - 用户填了非回环地址时明确报错，而不是把令牌送出去
 */
export async function resolveProvider(p: ProviderConfig): Promise<ProviderConfig> {
  if (p.vendor !== 'workbuddy') return p
  const cur = (() => { try { return new URL(p.baseUrl) } catch { return null } })()
  const loopback = !cur || /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(cur.hostname)
  if (!loopback) {
    throw new Error(`WorkBuddy 只能连本机桥（127.0.0.1），当前 Base URL 指向 ${cur?.hostname || p.baseUrl}`)
  }
  const st = await ensureBridge()
  if (!st.running) throw new Error(st.error || 'WorkBuddy 桥未就绪：请确认 WorkBuddy 客户端已登录')
  // 令牌永远是本进程注入给桥的那一个：用户从别处粘来的 Key 对不上这个桥，会 401
  return { ...p, baseUrl: st.baseUrl, apiKey: bridgeToken() }
}

/** 打开登录控制台（只有这一步需要 8792 端口；用完关掉即可） */
export async function openLoginDashboard(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const root = bridgeRoot()
  const entry = path.join(root, 'dashboard', 'server.mjs')
  if (!fs.existsSync(entry)) return { ok: false, error: '控制台文件缺失' }
  const dashPort = 8792
  const okDash = await ping(dashPort, '')
  if (!okDash) {
    try {
      const c = spawn(process.execPath, [entry], {
        cwd: root,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DASHBOARD_PORT: String(dashPort),
          WORKBUDDY_PORT: String(port || DEFAULT_PORT),
          WORKBUDDY_LOCAL_TOKEN: bridgeToken(),
          WORKBUDDY_STATE_FILE: path.join(app.getPath('userData'), 'wb-bridge-state.json')
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      })
      c.stdout?.on('data', (d: Buffer) => appendLog(`[dash] ${d.toString()}`))
      c.stderr?.on('data', (d: Buffer) => appendLog(`[dash-err] ${d.toString()}`))
      c.unref()
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  }
  return { ok: true, url: `http://127.0.0.1:${dashPort}` }
}

/** 读桥的模型目录（带倍率/上下文窗口，UI 可以据此填上下文 K） */
export async function listBridgeModels(): Promise<{ ok: boolean; models?: any[]; error?: string }> {
  const st = await ensureBridge()
  if (!st.running) return { ok: false, error: st.error || '桥未就绪' }
  try {
    const res = await fetch(`${st.baseUrl}/models`, { headers: { Authorization: `Bearer ${bridgeToken()}` } })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const j: any = await res.json()
    return { ok: true, models: Array.isArray(j?.data) ? j.data : [] }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 退出应用时收尾：桥进程不留在后台 */
export function shutdownBridge(): void {
  stopBridge()
}
