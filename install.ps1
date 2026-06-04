# ══════════════════════════════════════════════════════════════════════
# install.ps1 — Bengali Digital Library one-command installer (Windows)
# Installs Docker Desktop + WSL2 automatically if missing.
#
# Run in PowerShell:
#   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
#   irm https://raw.githubusercontent.com/YOURNAME/bengali-library/main/install.ps1 | iex
# ══════════════════════════════════════════════════════════════════════

$RAW      = "https://raw.githubusercontent.com/YOURNAME/bengali-library/main"
$APP_DIR  = "$env:USERPROFILE\.bengali_library_docker"
$LIB_FILE = "$APP_DIR\library_directory.txt"
$BIN_DIR  = "$APP_DIR"

function Write-OK   { param($m) Write-Host "  OK $m" -ForegroundColor Green }
function Write-Info { param($m) Write-Host "  -> $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "  !  $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "  X  $m" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  Bengali Digital Library - Windows Installer" -ForegroundColor Cyan
Write-Host ""

# ── Ensure running as Administrator ──────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Warn "Requesting Administrator privileges for Docker + WSL2 installation..."
    # Save this script to temp and re-run as admin
    $tmpScript = "$env:TEMP\bengali_install.ps1"
    Invoke-WebRequest -Uri "$RAW/install.ps1" -OutFile $tmpScript -UseBasicParsing
    Start-Process powershell -Verb RunAs `
        -ArgumentList "-ExecutionPolicy Bypass -File `"$tmpScript`""
    exit 0
}

# ════════════════════════════════════════════════════════════════════
# WSL2 + Docker Desktop installation (fully automatic)
# ════════════════════════════════════════════════════════════════════

function Install-WSL2AndDocker {
    # ── Enable Windows features ────────────────────────────────────
    Write-Info "Enabling WSL2 Windows features..."

    $wsl = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
    if ($wsl.State -ne "Enabled") {
        Write-Info "  Enabling Windows Subsystem for Linux..."
        Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux `
            -All -NoRestart | Out-Null
        Write-OK "  WSL enabled."
    } else { Write-OK "  WSL already enabled." }

    $vm = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
    if ($vm.State -ne "Enabled") {
        Write-Info "  Enabling Virtual Machine Platform..."
        Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform `
            -All -NoRestart | Out-Null
        Write-OK "  VirtualMachinePlatform enabled."
    } else { Write-OK "  VirtualMachinePlatform already enabled." }

    # ── WSL2 kernel update ─────────────────────────────────────────
    Write-Info "Downloading WSL2 kernel update..."
    $kernelUrl = "https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi"
    $kernelMsi = "$env:TEMP\wsl_update_x64.msi"
    try {
        Invoke-WebRequest -Uri $kernelUrl -OutFile $kernelMsi -UseBasicParsing
        Write-Info "Installing WSL2 kernel update..."
        Start-Process msiexec.exe -ArgumentList "/i `"$kernelMsi`" /quiet /norestart" `
            -Wait -NoNewWindow
        Remove-Item $kernelMsi -Force -ErrorAction SilentlyContinue
        Write-OK "WSL2 kernel updated."
    } catch {
        Write-Warn "Could not install WSL2 kernel update (will continue)."
    }

    # ── Set WSL2 as default ────────────────────────────────────────
    Write-Info "Setting WSL2 as default version..."
    wsl --set-default-version 2 2>$null | Out-Null
    Write-OK "WSL2 is the default."

    # ── Download Docker Desktop ───────────────────────────────────
    $dockerUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
    $dockerExe = "$env:TEMP\DockerDesktopInstaller.exe"
    Write-Info "Downloading Docker Desktop (~600 MB, please wait)..."
    $wc = New-Object System.Net.WebClient
    $lastPct = -1
    $wc.DownloadProgressChanged += {
        param($s, $e)
        $pct = $e.ProgressPercentage
        if ($pct -ne $lastPct -and $pct % 5 -eq 0) {
            Write-Host "`r    $pct% ..." -NoNewline
            $script:lastPct = $pct
        }
    }
    $completed = $false
    $wc.DownloadFileCompleted += { $script:completed = $true }
    $wc.DownloadFileAsync([Uri]$dockerUrl, $dockerExe)
    while (-not $completed) { Start-Sleep 1 }
    Write-Host "`r    100% - Download complete.   "
    Write-OK "Docker Desktop downloaded."

    # ── Install Docker Desktop silently ───────────────────────────
    Write-Info "Installing Docker Desktop (this takes ~2 minutes)..."
    $proc = Start-Process $dockerExe `
        -ArgumentList "install --quiet --accept-license --backend=wsl-2" `
        -Wait -NoNewWindow -PassThru
    Remove-Item $dockerExe -Force -ErrorAction SilentlyContinue

    if ($proc.ExitCode -notin @(0, 1)) {
        Write-Warn "Docker installer returned code $($proc.ExitCode). May need manual steps."
    }
    Write-OK "Docker Desktop installed."

    # ── Check reboot requirement ───────────────────────────────────
    $rebootKeys = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
        "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager"
    )
    $needsReboot = $rebootKeys | Where-Object { Test-Path $_ } | Measure-Object | Select-Object -ExpandProperty Count
    if ($needsReboot -gt 0) {
        Write-Host ""
        Write-Warn "====================================================="
        Write-Warn " A REBOOT IS REQUIRED to finish the installation."
        Write-Warn "====================================================="
        Write-Warn ""
        Write-Warn " After rebooting:"
        Write-Warn "   1. Docker Desktop will start automatically"
        Write-Warn "   2. Wait until the taskbar icon says 'Engine running'"
        Write-Warn "   3. Then run:  bengali-library"
        Write-Warn ""
        $r = Read-Host "  Reboot now? [Y/n]"
        if ($r -notmatch "^[Nn]$") { Restart-Computer -Force }
        exit 0
    }

    # ── Start Docker Desktop ──────────────────────────────────────
    Write-Info "Starting Docker Desktop..."
    $ddPath = @(
        "C:\Program Files\Docker\Docker\Docker Desktop.exe",
        "$env:LOCALAPPDATA\Programs\Docker\Docker\Docker Desktop.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($ddPath) {
        Start-Process $ddPath -ErrorAction SilentlyContinue
        Write-Info "Waiting for Docker engine to start (up to 120 seconds)..."
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep 2
            $info = docker info 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-OK "Docker engine is running!"
                return
            }
            Write-Host "`r  Waiting... ($($i * 2)s)" -NoNewline
        }
        Write-Host ""
        Write-Err "Docker did not start in time. Open Docker Desktop manually, wait for 'Engine running', then run: bengali-library"
    } else {
        Write-Warn "Docker Desktop installed but executable not found at expected path."
        Write-Warn "Open Docker Desktop from the Start Menu, wait for it to start, then run: bengali-library"
    }
}

# ── Check / install Docker ────────────────────────────────────────────
$dockerFound = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerFound) {
    Write-Warn "Docker not found. Installing automatically..."
    Install-WSL2AndDocker
} else {
    $dockerInfo = docker info 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Docker found but not running."
        # Try to start it
        $ddPath = @(
            "C:\Program Files\Docker\Docker\Docker Desktop.exe",
            "$env:LOCALAPPDATA\Programs\Docker\Docker\Docker Desktop.exe"
        ) | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($ddPath) {
            Start-Process $ddPath
            Write-Info "Waiting for Docker to start (60s)..."
            for ($i = 0; $i -lt 30; $i++) {
                Start-Sleep 2
                $info2 = docker info 2>$null
                if ($LASTEXITCODE -eq 0) { Write-OK "Docker is running!"; break }
                Write-Host "`r  Waiting... ($($i*2)s)" -NoNewline
            }
            Write-Host ""
        } else {
            Write-Warn "Could not locate Docker Desktop. Running install..."
            Install-WSL2AndDocker
        }
    } else {
        $v = (docker --version 2>$null) -replace "Docker version ","" -replace ",.*",""
        Write-OK "Docker $v already installed."
    }
}

# ── Create app directory ──────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $APP_DIR | Out-Null
Write-OK "App directory: $APP_DIR"

# ── Download run.ps1 ──────────────────────────────────────────────────
Write-Info "Downloading run.ps1..."
Invoke-WebRequest -Uri "$RAW/run.ps1" -OutFile "$APP_DIR\run.ps1" -UseBasicParsing
Write-OK "run.ps1 installed."

# ── Create bengali-library.bat wrapper ───────────────────────────────
$bat = "@echo off`r`npowershell -ExecutionPolicy Bypass -File `"$APP_DIR\run.ps1`" %*"
$bat | Out-File -FilePath "$APP_DIR\bengali-library.bat" -Encoding ascii
Write-OK "Launcher created: $APP_DIR\bengali-library.bat"

# ── Add to user PATH ──────────────────────────────────────────────────
$userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notlike "*$APP_DIR*") {
    [System.Environment]::SetEnvironmentVariable("PATH", "$APP_DIR;$userPath", "User")
    $env:PATH = "$APP_DIR;$env:PATH"
    Write-OK "Added to PATH."
} else {
    Write-OK "Already in PATH."
}

# ── PowerShell function alias ─────────────────────────────────────────
$psProfile = $PROFILE.CurrentUserAllHosts
if (-not (Test-Path (Split-Path $psProfile))) {
    New-Item -ItemType Directory -Force -Path (Split-Path $psProfile) | Out-Null
}
if (-not (Test-Path $psProfile)) { New-Item -ItemType File -Force -Path $psProfile | Out-Null }
$funcLine = "function bengali-library { & `"$APP_DIR\run.ps1`" @args }"
$existing = Select-String -Path $psProfile -Pattern "bengali-library" -Quiet -ErrorAction SilentlyContinue
if (-not $existing) {
    Add-Content -Path $psProfile -Value "`n$funcLine"
    Write-OK "PowerShell alias added."
}

# ── Auto-detect / create library directory ───────────────────────────
if (-not (Test-Path $LIB_FILE)) {
    $candidates = @(
        "$env:USERPROFILE\bengali-literature",
        "$env:USERPROFILE\BengaliLibrary",
        "$env:USERPROFILE\Documents\bengali-literature",
        "$env:OneDrive\bengali-literature"
    )
    $found = $false
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) {
            $c | Out-File -FilePath $LIB_FILE -Encoding utf8
            Write-OK "Library detected: $c"
            $found = $true; break
        }
    }
    if (-not $found) {
        $default = "$env:USERPROFILE\bengali-literature"
        New-Item -ItemType Directory -Force -Path $default | Out-Null
        $default | Out-File -FilePath $LIB_FILE -Encoding utf8
        Write-OK "Library directory created: $default"
    }
}

$libPath = (Get-Content $LIB_FILE).Trim()

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Start the app (open a new terminal):"
Write-Host "    bengali-library" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Add your PDFs to:"
Write-Host "    $libPath\Author Name\Book.pdf" -ForegroundColor Yellow
Write-Host ""
