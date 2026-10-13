@echo off
rem One-click install: Node 24 and cloudflared (via winget if missing), npm install, then the setup wizard.
rem Extra arguments go to the wizard, e.g.  install.cmd --only tunnel,webhook
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Installing Node.js LTS...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements || goto :fail
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 24 (
  echo Node %NODEMAJOR% found, 24+ needed. Run: winget upgrade OpenJS.NodeJS.LTS
  goto :fail
)

where cloudflared >nul 2>nul || if not exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" (
  echo Installing cloudflared...
  winget install -e --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
)

if not exist node_modules (
  call npm install || goto :fail
)
call npm run setup -- %*
exit /b %errorlevel%

:fail
echo Install failed.
exit /b 1
