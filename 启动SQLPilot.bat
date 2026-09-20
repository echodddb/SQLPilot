@echo off
chcp 65001 >nul
title SQLPilot 启动器
cd /d "%~dp0"

rem ---------- 首次运行自检：缺什么补什么 ----------
if not exist "node_modules\electron\dist\electron.exe" (
  echo [首次运行] 未发现依赖，开始安装（约 1-2 分钟）...
  call npm install
  if errorlevel 1 (
    echo.
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

if not exist "dist\main\index.js" (
  echo [首次运行] 未发现构建产物，开始构建...
  call npm run build
  if errorlevel 1 (
    echo.
    echo 构建失败，报错见上方。
    pause
    exit /b 1
  )
)

echo 正在启动 SQLPilot...（此窗口为日志窗口，关闭本窗口 = 退出应用）
call npm start

if errorlevel 1 (
  echo.
  echo SQLPilot 异常退出，报错信息见上方。
  pause
)
