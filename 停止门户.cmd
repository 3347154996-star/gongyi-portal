@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 goto missing_files
if exist "app\launch-portal.cjs" cd /d "app"
if errorlevel 1 goto missing_files
if not exist "launch-portal.cjs" goto missing_files
if exist "portable-node\node.exe" goto bundled
where node.exe >nul 2>nul
if errorlevel 1 goto missing_node
node.exe "launch-portal.cjs" stop
goto finished
:bundled
"portable-node\node.exe" "launch-portal.cjs" stop
:finished
set "PORTAL_EXIT=%ERRORLEVEL%"
if "%PORTAL_EXIT%"=="0" exit /b 0
pause
exit /b %PORTAL_EXIT%
:missing_files
echo Missing program files. Extract the complete ZIP to a local folder first.
pause
exit /b 2
:missing_node
echo Missing Node.js. Please extract the complete portable package again.
pause
exit /b 3
