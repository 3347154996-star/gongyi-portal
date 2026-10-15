@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "PORTAL_LOG=%TEMP%\gongyi-startup-%RANDOM%-%RANDOM%.log"
echo Saving startup output to "%PORTAL_LOG%"
echo If startup succeeds, keep this window open and visit http://127.0.0.1:4173/
call :diagnose >"%PORTAL_LOG%" 2>&1
set "PORTAL_EXIT=%ERRORLEVEL%"
type "%PORTAL_LOG%"
echo.
echo Log saved: "%PORTAL_LOG%"
echo If the server started, keep its window open and visit http://127.0.0.1:4173/
pause
exit /b %PORTAL_EXIT%
:diagnose
echo === Portal startup diagnostics ===
ver
echo Architecture: %PROCESSOR_ARCHITECTURE%
echo Folder: %CD%
if not exist "server.cjs" (
  echo ERROR: Missing server.cjs. Extract the complete ZIP first.
  exit /b 2
)
if not exist "config.local.json" (
  echo ERROR: Missing private config.local.json. Restore the migration package configuration.
  exit /b 2
)
if exist "portable-node\node.exe" goto diagnose_bundled
where node.exe
if errorlevel 1 exit /b 3
node.exe --version
if errorlevel 1 exit /b 4
node.exe "%~dp0server.cjs"
exit /b %ERRORLEVEL%
:diagnose_bundled
echo Using bundled Node.js.
"%~dp0portable-node\node.exe" --version
if errorlevel 1 exit /b 4
"%~dp0portable-node\node.exe" "%~dp0server.cjs"
exit /b %ERRORLEVEL%
