# WA Operator installer for Windows. Install or update with one line in PowerShell:
#   irm https://github.com/nchdatta/wa-operator/releases/latest/download/install.ps1 | iex
# Needs no admin rights. The app goes to %LOCALAPPDATA%\Programs\WA Operator; settings and data stay in
# %APPDATA%\wa-operator, so updates and reinstalls keep them. "wa-operator update" and
# "wa-operator uninstall" run this same script (WAOP_MODE = update / uninstall).

function Install-WaOperator {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is many times slower with the progress bar
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $repo = if ($env:WAOP_REPO) { $env:WAOP_REPO } else { 'nchdatta/wa-operator' }
  $base = "https://github.com/$repo/releases/latest/download"
  $mode = if ($env:WAOP_MODE) { $env:WAOP_MODE } else { 'install' }
  $dir = Join-Path $env:LOCALAPPDATA 'Programs\WA Operator'
  $state = Join-Path $env:APPDATA 'wa-operator'

  # Started by "wa-operator update/uninstall": let that program exit so its files are free.
  if ($env:WAOP_WAIT_PID) { Wait-Process -Id ([int]$env:WAOP_WAIT_PID) -Timeout 60 -ErrorAction SilentlyContinue }

  function Step($s) { Write-Host "`n> $s" -ForegroundColor Cyan }
  function Ok($s) { Write-Host "  OK $s" -ForegroundColor Green }

  function Set-UserPath([bool]$add) {
    $p = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($p -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $dir) })
    if ($add) { $parts += $dir }
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    if ($add -and ($env:Path -split ';') -notcontains $dir) { $env:Path = "$env:Path;$dir" }
  }

  function Stop-App {
    if (Test-Path "$dir\node.exe") {
      & "$dir\node.exe" "$dir\dist\bin\control.js" stop 2>$null | Out-Null
    }
    # Windows cannot replace files that are still running: wait for every program from the app folder
    # (service, whisper, Claude Code it started) to exit, then end any that hang.
    $mine = { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, 'OrdinalIgnoreCase') } }
    for ($i = 0; $i -lt 20 -and (& $mine); $i++) { Start-Sleep -Milliseconds 500 }
    & $mine | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }

  if ($mode -eq 'uninstall') {
    Step 'Removing WA Operator'
    Stop-App
    Set-UserPath $false
    Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
    Ok "app removed. Your settings and data are still in $state (delete that folder to remove them too)."
    return
  }

  if ($env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'ARM64')) { throw 'WA Operator needs 64-bit Windows.' }

  Step 'Downloading WA Operator'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) "wa-operator-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'app.zip'
    Invoke-WebRequest -UseBasicParsing "$base/wa-operator-win-x64.zip" -OutFile $zip
    # Windows' own tar (10 1803+) unpacks the thousands of small files far faster than Expand-Archive.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) { & $tar -xf $zip -C $tmp; if ($LASTEXITCODE) { throw 'could not unpack the download' } }
    else { Expand-Archive -Path $zip -DestinationPath $tmp }
    $new = Join-Path $tmp 'wa-operator'
    $version = (Get-Content "$new\package.json" -Raw | ConvertFrom-Json).version
    Ok "version $version"

    Step 'Installing'
    $wasInstalled = Test-Path "$dir\node.exe"
    Stop-App
    # Rename the old copy aside first: that fails cleanly if a file is still in use, instead of
    # leaving a half-deleted app. On any failure the old copy goes back and starts again.
    $old = "$dir.old"
    Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Split-Path $dir) | Out-Null
    try {
      if (Test-Path $dir) { Rename-Item $dir $old }
      Move-Item $new $dir
    } catch {
      if ((Test-Path $old) -and -not (Test-Path "$dir\node.exe")) {
        Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        Rename-Item $old $dir
      }
      if ($wasInstalled) { & "$dir\node.exe" "$dir\dist\bin\control.js" start 2>$null | Out-Null }
      throw "could not replace the app folder ($($_.Exception.Message)). The old version is still installed and running. Close any window using it and try again."
    }
    Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue
    New-Item -ItemType File -Force -Path "$dir\.installed" | Out-Null
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    Set-UserPath $true
    Ok "installed to $dir"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (-not (Test-Path $claude) -and -not (Get-Command claude.exe -ErrorAction SilentlyContinue)) {
    Step 'Installing Claude Code (official installer from Anthropic)'
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  }

  if ($mode -eq 'update' -or ($wasInstalled -and (Test-Path "$state\.env"))) {
    Step 'Starting WA Operator again'
    & "$dir\wa-operator.cmd" start
    Ok "updated to $version. Your settings and data were kept."
  } else {
    Step 'Setup'
    & "$dir\wa-operator.cmd" setup
  }
  Write-Host "`nFrom now on, open any terminal and type:  wa-operator   (setup, start, stop, update, uninstall)"
}

Install-WaOperator
