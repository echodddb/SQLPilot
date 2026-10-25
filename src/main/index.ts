import { app, BrowserWindow, Menu } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc, bindWindow, shutdown } from './ipc'
import { seedBuiltinSkills } from './skills'
import { dirsFromArgv, filesFromArgv, setPendingOpens, setPendingWorkspace } from './editor'
import { appendAudit } from './audit'
import { loadConfig } from './config'

let win: BrowserWindow | null = null

// 测试/调试用：设置 SQLPILOT_USER_DATA 环境变量可重定向数据目录（绕开单实例锁并行起第二个实例）
if (process.env.SQLPILOT_USER_DATA) {
  app.setPath('userData', process.env.SQLPILOT_USER_DATA)
} else if (process.env.PORTABLE_EXECUTABLE_DIR) {
  // 绿色版（portable exe）：数据放在 exe 旁边的 SQLPilot-Data，客户机上不留 AppData 痕迹。
  // 放在只读目录（光盘 / 只读共享）时创建失败，退回默认 userData，不影响启动。
  try {
    const dataDir = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'SQLPilot-Data')
    fs.mkdirSync(dataDir, { recursive: true })
    app.setPath('userData', dataDir)
  } catch {
    /* 只读目录：用默认 %APPDATA%\sqlpilot */
  }
}

// 项目由 DBAgent 更名为 SQLPilot：把旧 userData 目录里的配置/密码/审计迁移过来（仅当新目录尚无配置时执行一次）
function migrateOldUserData(): void {
  try {
    const newPath = app.getPath('userData')
    if (fs.existsSync(path.join(newPath, 'config.json'))) return
    const appData = path.dirname(newPath)
    for (const old of ['DBAgent', 'dbagent']) {
      const oldPath = path.join(appData, old)
      if (fs.existsSync(path.join(oldPath, 'config.json'))) {
        fs.mkdirSync(newPath, { recursive: true })
        for (const f of ['config.json', 'secrets.json', 'audit.log']) {
          const src = path.join(oldPath, f)
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(newPath, f))
        }
        console.log(`[migrate] 已从 ${oldPath} 迁移用户数据`)
        return
      }
    }
  } catch { /* 迁移失败不阻断启动 */ }
}

/** 首帧画好才露面，窗口出现时已经有启动画面骨架，不会白闪 */
function revealMain(): void {
  if (!win || win.isDestroyed() || win.isVisible()) return
  win.show()
  win.focus()
}

// 启动界面要跟着主题走：在窗口创建前就把主题读出来，
// 否则亮色用户会先看到一屏深色启动画面再被切成白色。
function startupTheme(): 'light' | 'dark' {
  try {
    return loadConfig().theme === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function createWindow(): void {
  const indexHtml = path.join(__dirname, '../renderer/index.html')
  const theme = startupTheme()
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1150,
    minHeight: 700,
    show: false,
    // 窗口底色和启动画面同色，首帧就不会闪
    backgroundColor: theme === 'light' ? '#f8f8f8' : '#161616',
    title: 'SQLPilot — DBA 智能助手',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      // 启动画面在窗口未聚焦时也要正常走动画（后台节流会把定时器压到秒级）
      backgroundThrottling: false
    }
  })
  bindWindow(win)
  win.removeMenu()
  Menu.setApplicationMenu(null)

  // F12 开发者工具 / Ctrl+R 刷新：仅开发构建或 SQLPILOT_DEV=1 时开放，生产包不给终端用户留入口
  const devTools = !app.isPackaged || !!process.env.SQLPILOT_DEV
  win.webContents.on('before-input-event', (_e, input) => {
    if (!devTools || input.type !== 'keyDown') return
    if (input.key === 'F12') {
      win?.webContents.toggleDevTools()
    } else if (input.control && input.key === 'r') {
      win?.webContents.reload()
    }
  })

  // 渲染层 console 转发到主进程 stdout，错误级同时落审计日志便于排查
  win.webContents.on('console-message', (_e, level, message) => {
    if (message.includes('[vite]')) return
    console.log('[renderer]', message)
    if (level >= 3) {
      appendAudit({ kind: 'ui.error', detail: message.slice(0, 500) })
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', details.reason)
  })

  // 页面不弹新窗口、不允许导航离开应用自身页面（file:// 里也只放行本页，hash 变化除外）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const indexUrl = pathToFileURL(indexHtml).href
  win.webContents.on('will-navigate', (e, url) => {
    if (url.split('#')[0] !== indexUrl) e.preventDefault()
  })

  win.once('ready-to-show', () => revealMain())
  // 兜底：ready-to-show 万一不触发（资源异常），8 秒后也必须有一个能用的窗口
  const revealGuard = setTimeout(() => revealMain(), 8000)

  // SQLPILOT_NO_SPLASH=1 → 渲染层跳过启动画面（开发时反复重启省得等动画）
  win
    .loadFile(indexHtml, {
      query: {
        ...(process.env.SQLPILOT_NO_SPLASH === '1' ? { nosplash: '1' } : {}),
        theme
      }
    })
    .catch((err) => {
      console.error('[main] 主页面加载失败:', err)
      revealMain()
    })
  win.on('closed', () => {
    clearTimeout(revealGuard)
    win = null
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
      // 再次双击文件打开时：把文件交给当前实例，复用同一窗口的编辑器
      const files = filesFromArgv(argv)
      const dirs = dirsFromArgv(argv)
      if (files.length || dirs.length) {
        setPendingOpens(files)
        if (dirs.length) setPendingWorkspace(dirs[0])
        try { win.webContents.send('editor:open-request', { paths: files, folder: dirs[0] || '' }) } catch { /* 窗口关闭中 */ }
      }
    }
  })

  app.whenReady().then(() => {
    migrateOldUserData()
    // 双击/命令行带文件启动：窗口就绪后由渲染层取走并在编辑器中打开
    setPendingOpens(filesFromArgv(process.argv.slice(1)))
    const dirs = dirsFromArgv(process.argv.slice(1))
    if (dirs.length) setPendingWorkspace(dirs[0])
    // 内置技能包：只在技能库里还没有时播种（用户的改动不会被覆盖）
    seedBuiltinSkills()
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('will-quit', (e) => {
    e.preventDefault()
    // 总超时兜底：shutdown 里的连接关闭若挂住（如 MySQL 半开连接），
    // 应用将永远退不出去——5 秒后强制退出
    const forceExit = setTimeout(() => app.exit(0), 5_000)
    forceExit.unref?.()
    shutdown()
      .catch(() => {})
      .finally(() => {
        clearTimeout(forceExit)
        app.exit(0)
      })
  })
}
