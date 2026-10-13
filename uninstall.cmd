@echo off
rem One-click uninstall. Arguments: --purge (also delete .env, data, logs, dist, node_modules), --yes, --keep-secrets
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo node_modules missing; run: npm install, then uninstall.cmd again
  exit /b 1
)
call npm run uninstall -- %*
if errorlevel 1 exit /b 1
echo %* | findstr /c:"--purge" >nul && (
  echo Deleting node_modules...
  rmdir /s /q node_modules
)
exit /b 0
