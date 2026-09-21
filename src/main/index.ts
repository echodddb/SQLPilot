import { app, BrowserWindow, Menu } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc, bindWindow, shutdown } from './ipc'
import { appendAudit } from './audit'

let win: BrowserWindow | null = null

// 测试/调试用：设置 SQLPILOT_USER_DATA 环境变量可重定向数据目录（绕开单实例锁并行起第二个实例）
if (process.env.SQLPILOT_USER_DATA) {
  app.setPath('userData', process.env.SQLPILOT_USER_DATA)
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

function createWindow(): void {
  const indexHtml = path.join(__dirname, '../renderer/index.html')
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1150,
    minHeight: 700,
    backgroundColor: '#15171f',
    title: 'SQLPilot — DBA 智能助手',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
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

  win.loadFile(indexHtml)
  win.on('closed', () => {
    win = null
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    migrateOldUserData()
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
    shutdown()
      .catch(() => {})
      .finally(() => {
        app.exit(0)
      })
  })
}
