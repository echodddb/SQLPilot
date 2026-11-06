/**
 * OB 故障排查 Agent · 独立浮窗
 *
 * DOM 元素不可能画出 BrowserWindow 的边界，所以「把浮窗挪到主窗口外」只有一个解法：
 * 换一个真正的窗口。本文件只管这个窗口的生命周期与几何（位置/尺寸/置顶），
 * 会话状态仍在渲染层「两侧同源折叠」——主窗口把状态交出去，独立窗口接管，
 * 停靠时再交回来（见 renderer/oblog/agent.ts 的 snapshot/hydrate）。
 *
 * 刻意做成透明无边框 + 不进任务栏 + 默认置顶：它是一个 HUD，
 * 不是第二个「应用窗口」，主窗口最小化时它还应该留在桌面上供人对命令点确认。
 */

import { BrowserWindow, app, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../atomic'

export interface PanelState {
  x: number
  y: number
  w: number
  h: number
  /** 置顶（默认开：点确认按钮时不能被别的窗口盖住） */
  pin: boolean
}

const DEF_W = 520
const DEF_H = 660
const MIN_W = 400
const MIN_H = 380
/** 允许窗口滑出屏幕多少：全滑出去就再也拖不回来了（按宽度比例算，窄窗口也能抓回来） */
const KEEP_RATIO = 0.6
const KEEP_MIN = 320
/** 纵向至少露出这么高（标题栏能点到） */
const KEEP_Y = 160

let panel: BrowserWindow | null = null
let goneCb: (() => void) | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function statePath(): string {
  try {
    return path.join(app.getPath('userData'), 'obagent-panel.json')
  } catch {
    return ''
  }
}

function num(v: any, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d
}

function loadState(): PanelState {
  const base: PanelState = { x: NaN, y: NaN, w: DEF_W, h: DEF_H, pin: true }
  try {
    const p = statePath()
    if (!p) return base
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { x: num(j.x, NaN), y: num(j.y, NaN), w: num(j.w, DEF_W), h: num(j.h, DEF_H), pin: j.pin !== false }
  } catch {
    return base
  }
}

/** 落盘防抖：拖动窗口时 moved 事件一次拖动能刷几十次 */
function saveStateSoon(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistState()
  }, 400)
}

function persistState(): void {
  if (!panel || panel.isDestroyed()) return
  const b = panel.getBounds()
  const st: PanelState = { x: b.x, y: b.y, w: b.width, h: b.height, pin: panel.isAlwaysOnTop() }
  try {
    writeFileAtomic(statePath(), JSON.stringify(st))
  } catch {
    /* 存不上只影响下次位置 */
  }
}

/**
 * 把窗口拉回可见范围。
 *
 * 只保证「左上角不越界 + 至少留一条边能抓到」，不强行摆正：
 * 用户把浮窗抠到屏幕边缘一半是故意的（不挡日志表）。
 */
function clampBox(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea
  const keepX = Math.min(KEEP_MIN, Math.round(w * KEEP_RATIO))
  const minX = area.x - w + keepX
  const maxX = area.x + area.width - keepX
  const minY = area.y - h + KEEP_Y
  const maxY = area.y + area.height - KEEP_Y
  return {
    x: Math.min(maxX, Math.max(minX, Math.round(x))),
    y: Math.min(maxY, Math.max(minY, Math.round(y)))
  }
}

export function panelWindow(): BrowserWindow | null {
  return panel && !panel.isDestroyed() ? panel : null
}

export function hasPanelWindow(): boolean {
  return !!panelWindow()
}

/** 窗口被关掉（点 ✕ / 系统关闭 / 主窗口退出）时回调一次 */
export function onPanelGone(cb: () => void): void {
  goneCb = cb
}

/**
 * 摘掉「被关掉」的回调。
 * 停靠是有意为之的关闭：这时不该再通知主窗口「浮窗被关掉了」，
 * 否则刚交回去的对话会被立刻收起。
 */
export function clearPanelGone(): void {
  goneCb = null
}

export interface OpenPanelOpts {
  theme: 'dark' | 'light'
  /** 主窗口几何：首次打开时贴着它右侧出现，比凭空出现在屏幕角落合理 */
  anchor?: { x: number; y: number; width: number; height: number }
}

/** 打开独立浮窗；resolve 时页面已加载完（可以安全灌状态） */
export function openPanelWindow(opts: OpenPanelOpts): Promise<BrowserWindow> {
  const exist = panelWindow()
  if (exist) {
    if (!exist.isVisible()) exist.show()
    exist.focus()
    return Promise.resolve(exist)
  }

  const st = loadState()
  const w = Math.max(MIN_W, st.w)
  const h = Math.max(MIN_H, st.h)
  const a = opts.anchor
  const area = screen.getDisplayMatching(a || screen.getPrimaryDisplay().workArea).workArea
  // 第一次打开（没有存过位置）：贴着主窗口右侧、但**整窗必须落在工作区里**，
  // 不能像以前那样只保证「露 140px」—— 那会让一半窗口跑到屏幕外面去。
  const freshX = (a ? a.x + a.width - Math.min(200, a.width) : area.x + area.width - w - 60)
  const freshY = (a ? Math.max(a.y, area.y + 40) : area.y + 80)
  const fullyX = Math.max(area.x + 12, Math.min(area.x + area.width - w - 12, freshX))
  const fullyY = Math.max(area.y + 12, Math.min(area.y + area.height - h - 12, freshY))
  const pos = clampBox(Number.isFinite(st.x) ? st.x : fullyX, Number.isFinite(st.y) ? st.y : fullyY, w, h)

  // 打包后本文件被 esbuild 并进 dist/main/index.js，__dirname 与 index.ts 相同
  const indexHtml = path.join(__dirname, '../renderer/index.html')
  const win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: w,
    height: h,
    minWidth: MIN_W,
    minHeight: MIN_H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // 透明窗口在 Windows 上没有系统阴影，圆角与阴影全交给 CSS（见 ObAgentWindow.vue）
    hasShadow: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // 进任务栏：主窗口最小化/被盖住时，从任务栏就能把排查窗口叫回来
    skipTaskbar: false,
    alwaysOnTop: st.pin,
    title: 'SQLPilot · 故障排查',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      // 后台不降频：轮询/流式事件在浮窗后面也要照常进来
      backgroundThrottling: false
    }
  })
  panel = win
  // 先在屏幕外建、屏外显示：透明窗口在 Windows 上的「第一帧」有时是白的，
  // 让它在用户看不见的地方画完，再挪进视野，就不会有「白色背影」。
  const offX = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x)) - w - 200
  let revealed = false
  win.setPosition(offX, pos.y)
  win.setMenu(null)
  win.setAlwaysOnTop(st.pin, 'floating')
  // 任务栏里当成「另一个应用」而不是主窗口的一部分：不同 AppUserModelID
  // 才会单独成一格（Windows 默认按 AUMID 分组）。没有自定义图标就沿用 exe 的。
  if (process.platform === 'win32') {
    try {
      win.setAppDetails({
        appId: 'com.sqlpilot.troubleshoot',
        relaunchCommand: process.execPath,
        relaunchDisplayName: 'SQLPilot 故障排查'
      })
    } catch { /* 老系统 / 无权限时保持默认分组 */ }
  }

  const devTools = !app.isPackaged || !!process.env.SQLPILOT_DEV
  win.webContents.on('before-input-event', (_e, input) => {
    if (!devTools || input.type !== 'keyDown') return
    if (input.key === 'F12') win.webContents.toggleDevTools()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.on('moved', () => { if (revealed) saveStateSoon() })
  win.on('resized', () => { if (revealed) saveStateSoon() })
  win.on('closed', () => {
    if (panel === win) panel = null
    const cb = goneCb
    goneCb = null
    cb?.()
  })

  // 关键：不在这里 show。
  // ready-to-show 只是「首帧画完了」，而首帧是 index.html 里的启动遮罩
  // （#boot-veil，浅色主题下是整屏 #f8f8f8）—— 透明窗口若现在露面，
  // 用户第一眼看到的就是一块白底「背影」。等渲染层挂载完、遮罩已摘掉、
  // 再来 hello 时才 show（见 ipc 的 obagent:panel:hello）。
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => { resolveReady = resolve })
  win.webContents.once('did-finish-load', () => {
    // 屏外先显示，让它把内容画出来（此时用户看不到任何东西）
    win.showInactive()
    resolveReady()
    setTimeout(() => {
      const cur = panelWindow()
      if (!cur) return
      revealed = true
      cur.setPosition(pos.x, pos.y)
      cur.focus()
    }, 220)
  })
  // 兜底：页面 3s 还没加载完也必须有个能看见的窗口
  const showFallback = setTimeout(() => {
    const cur = panelWindow()
    if (!cur) return
    if (!cur.isVisible()) cur.showInactive()
    if (!revealed) {
      revealed = true
      cur.setPosition(pos.x, pos.y)
      cur.focus()
    }
  }, 3000)
  win.once('closed', () => clearTimeout(showFallback))

  void win
    .loadFile(indexHtml, { query: { panel: 'obagent', theme: opts.theme, nosplash: '1' } })
    .catch(() => {
      // 页面都没起来就别留一个空气窗（ready-to-show 也不会触发，得自己放行）
      if (!win.isDestroyed()) win.destroy()
      resolveReady()
    })

  return ready.then(() => win)
}

/** 兜底露面（正常路径在 did-finish-load 里已经显示过了） */
function showPanelWindow(): void {
  const w = panelWindow()
  if (!w) return
  if (!w.isVisible()) { w.show(); w.focus() }
}

export function closePanelWindow(): void {
  const w = panelWindow()
  if (!w) return
  panel = null
  w.destroy()
}

export function setPanelPinned(v: boolean): boolean {
  const w = panelWindow()
  if (!w) return false
  w.setAlwaysOnTop(!!v, 'floating')
  saveStateSoon()
  return !!v
}

export function isPanelPinned(): boolean {
  const w = panelWindow()
  return !!w && w.isAlwaysOnTop()
}

export function sendToPanel(channel: string, payload: unknown): void {
  const w = panelWindow()
  if (!w) return
  try {
    w.webContents.send(channel, payload)
  } catch {
    /* 窗口正在销毁 */
  }
}

/**
 * 边框拖拽改尺寸。
 *
 * 透明无边框窗口的原生边沿很窄（而且被圆角/阴影盖住），所以在渲染层给了一个
 * 可见的抓手，按增量改 bounds —— 指针捕获期间即使指针跑到窗口外也能收到 move。
 */
export function nudgePanelSize(dx: number, dy: number): void {
  const w = panelWindow()
  if (!w) return
  const b = w.getBounds()
  const width = Math.max(MIN_W, b.width + Math.round(dx))
  const height = Math.max(MIN_H, b.height + Math.round(dy))
  const area = screen.getDisplayMatching(b).workArea
  w.setBounds({
    x: b.x,
    y: b.y,
    width: Math.min(width, area.width - 8),
    height: Math.min(height, area.height - 8)
  })
}

export function movePanelBy(dx: number, dy: number): void {
  const w = panelWindow()
  if (!w) return
  const b = w.getBounds()
  const pos = clampBox(b.x + Math.round(dx), b.y + Math.round(dy), b.width, b.height)
  w.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height })
}
