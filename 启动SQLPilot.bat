@echo off
chcp 65001 >nul
title SQLPilot 启动器
cd /d "%~dp0"

rem Defensive: when launched from an Electron host terminal, ELECTRON_RUN_AS_NODE=1
rem is inherited and electron.exe degrades to plain Node mode, so app is undefined
rem and the main process crashes on startup. Clear it here.
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="

rem ---------- Locate node/npm ----------
rem npm is often absent from the PATH that Explorer hands to cmd.
rem Probe order: current PATH -> WorkBuddy private runtime -> standard installs.
set "NODE_DIR="
for /f "delims=" %%P in ('where npm.cmd 2^>nul') do if not defined NODE_DIR set "NODE_DIR=%%~dpP"
if not defined NODE_DIR (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do (
    if not defined NODE_DIR if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%D\npm.cmd" set "NODE_DIR=%USERPROFILE%\.workbuddy\binaries\node\versions\%%D\"
  )
)
if not defined NODE_DIR if exist "%ProgramFiles%\nodejs\npm.cmd" set "NODE_DIR=%ProgramFiles%\nodejs\"
if not defined NODE_DIR if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs\"
if not defined NODE_DIR (
  echo.
  echo [错误] 未找到 Node.js / npm。
  echo 请先安装 Node.js 20 或更高版本： https://nodejs.org/
  echo.
  pause
  exit /b 1
)
set "PATH=%NODE_DIR%;%PATH%"

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
