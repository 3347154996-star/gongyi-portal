@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更新版本，然后重新启动。
  pause
  exit /b 1
)
echo 正在启动工艺部门户，请保持本窗口打开。
echo 浏览器访问地址以启动后显示的地址为准。
node server.cjs
pause
