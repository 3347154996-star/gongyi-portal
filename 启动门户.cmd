@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist "server.cjs" goto missing_files
if exist "portable-node\node.exe" goto bundled
where node.exe >nul 2>nul
if errorlevel 1 goto missing_node
node.exe "%~dp0server.cjs"
goto finished
:bundled
"%~dp0portable-node\node.exe" "%~dp0server.cjs"
:finished
set "PORTAL_EXIT=%ERRORLEVEL%"
if not "%PORTAL_EXIT%"=="0" echo Startup failed. Run startup-diagnostics.cmd and share its log.
pause
exit /b %PORTAL_EXIT%
:missing_files
echo Missing server.cjs. Extract the complete ZIP to a local folder first.
pause
exit /b 2
:missing_node
echo Node.js 22 or newer is required. Restore portable-node or install official Node.js.
pause
exit /b 3
