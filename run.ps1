# ══════════════════════════════════════════════════════════════════════════
# run.ps1 — Bengali Digital Library Manager (Windows)
# Handles Docker Desktop + WSL2 installation automatically.
#
# First-time install:
#   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
#   irm https://raw.githubusercontent.com/ohidsajol/bengali-library/refs/heads/main/install.ps1 | iex
#
# Usage:
#   bengali-library                       start / open in browser
#   bengali-library -Stop                 stop
#   bengali-library -Logs                 tail logs
#   bengali-library -Status               show info
#   bengali-library -Update               pull latest image
#   bengali-library -Clean                remove container + user data
#   bengali-library -SetLibrary "C:\path" change library path
# ══════════════════════════════════════════════════════════════════════════

param(
    [switch]$Stop,
    [switch]$Logs,
    [switch]$Status,
    [switch]$Update,
    [switch]$Clean,
    [string]$SetLibrary = ""
)

$IMAGE     = "YOURNAME/bengali-library:latest"
$PORT      = 7654
$CONTAINER = "bengali-library"
$APP_DIR   = "$env:USERPROFILE\.bengali_library_docker"
$LIB_FILE  = "$APP_DIR\library_directory.txt"
$DATA_DIR  = "$APP_DIR\data"
$OCR_DIR   = "$APP_DIR\ocr"
$URL       = "http://localhost:$PORT"

function Write-Info  { param($m) Write-Host "  -> $m" -ForegroundColor Cyan }
function Write-OK    { param($m) Write-Host "  OK $m" -ForegroundColor Green }
function Write-Warn  { param($m) Write-Host "  !  $m" -ForegroundColor Yellow }
function Write-Err   { param($m) Write-Host "  X  $m" -ForegroundColor Red; exit 1 }
function Write-Hdr   { param($m) Write-Host "`n  $m`n"  -ForegroundColor Cyan }

# ════════════════════════════════════════════════════════════════════════
# DOCKER INSTALLATION + WSL2 SETUP (fully automatic)
# ════════════════════════════════════════════════════════════════════════

function Install-DockerDesktop {
    Write-Warn "Docker Desktop not found. Installing automatically..."
    Write-Info "This requires Administrator privileges and may need a reboot."

    # Ensure script runs as admin for feature installation
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Warn "Restarting as Administrator to install Docker + WSL2..."
        $args2 = "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
        Start-Process powershell -Verb RunAs -ArgumentList $args2
        exit 0
    }

    # ── Step 1: Enable WSL and VirtualMachinePlatform ──────────────────
    Write-Info "Enabling WSL2 Windows features..."

    $wslFeature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
    if ($wslFeature.State -ne "Enabled") {
        Write-Info "  Enabling Windows Subsystem for Linux..."
        Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux `
            -All -NoRestart | Out-Null
    } else {
        Write-OK "  WSL feature already enabled."
    }

    $vmFeature = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
    if ($vmFeature.State -ne "Enabled") {
        Write-Info "  Enabling Virtual Machine Platform..."
        Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform `
            -All -NoRestart | Out-Null
    } else {
        Write-OK "  VirtualMachinePlatform already enabled."
    }

    # ── Step 2: Download and install WSL2 kernel update ───────────────
    $wslKernelUrl = "https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi"
    $wslKernelMsi = "$env:TEMP\wsl_update_x64.msi"
    Write-Info "  Downloading WSL2 kernel update..."
    try {
        Invoke-WebRequest -Uri $wslKernelUrl -OutFile $wslKernelMsi -UseBasicParsing
        Write-Info "  Installing WSL2 kernel update..."
        Start-Process msiexec.exe -ArgumentList "/i `"$wslKernelMsi`" /quiet /norestart" `
            -Wait -NoNewWindow
        Write-OK "  WSL2 kernel updated."
    } catch {
        Write-Warn "  Could not download WSL2 kernel update. Will continue anyway."
    }

    # ── Step 3: Set WSL2 as default ────────────────────────────────────
    Write-Info "  Setting WSL2 as default..."
    wsl --set-default-version 2 2>$null | Out-Null

    # ── Step 4: Download Docker Desktop ───────────────────────────────
    $dockerUrl      = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
    $dockerInstaller= "$env:TEMP\DockerDesktopInstaller.exe"
    Write-Info "Downloading Docker Desktop (this may take a few minutes)..."
    try {
        $wc = New-Object System.Net.WebClient
        # Show download progress
        $wc.DownloadProgressChanged += {
            param($s,$e)
            if ($e.ProgressPercentage % 10 -eq 0) {
                Write-Host "`r    $($e.ProgressPercentage)% downloaded..." -NoNewline
            }
        }
        $wc.DownloadFileAsync([Uri]$dockerUrl, $dockerInstaller)
        while ($wc.IsBusy) { Start-Sleep 1 }
        Write-Host ""
        Write-OK "Downloaded."
    } catch {
        # Fallback: blocking download
        Invoke-WebRequest -Uri $dockerUrl -OutFile $dockerInstaller -UseBasicParsing
        Write-OK "Downloaded."
    }

    # ── Step 5: Install Docker Desktop silently ────────────────────────
    Write-Info "Installing Docker Desktop (silent install)..."
    Start-Process $dockerInstaller `
        -ArgumentList "install --quiet --accept-license --backend=wsl-2" `
        -Wait -NoNewWindow

    Remove-Item $dockerInstaller -Force -ErrorAction SilentlyContinue

    # ── Step 6: Check if reboot is required ───────────────────────────
    $rebootKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending"
    $rebootNeeded = (Test-Path $rebootKey)
    if ($rebootNeeded) {
        Write-Warn ""
        Write-Warn "A REBOOT IS REQUIRED to complete Docker installation."
        Write-Warn "After rebooting, start Docker Desktop from the Start Menu,"
        Write-Warn "wait for it to say 'Docker Desktop is running', then run:"
        Write-Warn "  bengali-library"
        Write-Warn ""
        $r = Read-Host "  Reboot now? [Y/n]"
        if ($r -notmatch "^[Nn]$") { Restart-Computer -Force }
        exit 0
    }

    Write-OK "Docker Desktop installed!"
    Write-Info "Starting Docker Desktop..."
    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -ErrorAction SilentlyContinue
    Write-Info "Waiting for Docker to start (up to 90 seconds)..."
    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep 2
        $r = docker info 2>$null
        if ($LASTEXITCODE -eq 0) { Write-OK "Docker is running!"; return }
        Write-Host "`r  Waiting... ($($i*2)s)" -NoNewline
    }
    Write-Host ""
    Write-Err "Docker did not start in time. Open Docker Desktop manually, wait for it to say 'Engine running', then run: bengali-library"
}

function Require-Docker {
    # Check if docker CLI exists
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Install-DockerDesktop
        return
    }
    # Check if Docker daemon is running
    $info = docker info 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Docker is installed but not running. Starting Docker Desktop..."
        # Try to start Docker Desktop
        $dockerExe = @(
            "C:\Program Files\Docker\Docker\Docker Desktop.exe",
            "$env:LOCALAPPDATA\Programs\Docker\Docker\Docker Desktop.exe"
        ) | Where-Object { Test-Path $_ } | Select-Object -First 1

        if ($dockerExe) {
            Start-Process $dockerExe -ErrorAction SilentlyContinue
            Write-Info "Waiting for Docker engine (up to 90 seconds)..."
            for ($i = 0; $i -lt 45; $i++) {
                Start-Sleep 2
                $info2 = docker info 2>&1
                if ($LASTEXITCODE -eq 0) { Write-OK "Docker is running!"; return }
                Write-Host "`r  Waiting... ($($i*2)s)" -NoNewline
            }
            Write-Host ""
            Write-Err "Docker not ready. Open Docker Desktop and wait for 'Engine running', then retry."
        } else {
            Install-DockerDesktop
        }
    }
}

# ════════════════════════════════════════════════════════════════════════
# LIBRARY PATH — fully automatic, no user prompting
# ════════════════════════════════════════════════════════════════════════

function Resolve-LibraryPath {
    New-Item -ItemType Directory -Force -Path $APP_DIR | Out-Null

    # 1. Already saved and valid?
    if (Test-Path $LIB_FILE) {
        $saved = (Get-Content $LIB_FILE).Trim()
        if ($saved -and (Test-Path $saved)) { return $saved }
    }

    # 2. Check common locations
    $candidates = @(
        "$env:USERPROFILE\bengali-literature",
        "$env:USERPROFILE\BengaliLibrary",
        "$env:USERPROFILE\bengali_literature",
        "$env:USERPROFILE\Documents\bengali-literature",
        "$env:USERPROFILE\Documents\BengaliLibrary",
        "$env:USERPROFILE\Desktop\bengali-literature",
        "$env:OneDrive\bengali-literature"
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) {
            $c | Out-File -FilePath $LIB_FILE -Encoding utf8
            return $c
        }
    }

    # 3. Create default
    $default = "$env:USERPROFILE\bengali-literature"
    New-Item -ItemType Directory -Force -Path $default | Out-Null
    $default | Out-File -FilePath $LIB_FILE -Encoding utf8
    return $default
}

function Set-LibraryPath { param($path)
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
        Write-OK "Created: $path"
    }
    New-Item -ItemType Directory -Force -Path $APP_DIR | Out-Null
    $path | Out-File -FilePath $LIB_FILE -Encoding utf8
    Write-OK "Library path set to: $path"
}

# ════════════════════════════════════════════════════════════════════════
# MODES
# ════════════════════════════════════════════════════════════════════════

if ($SetLibrary) {
    Set-LibraryPath $SetLibrary
    Write-Info "Restart to apply: bengali-library -Stop; bengali-library"
    exit 0
}

if ($Stop) {
    Require-Docker
    $r = docker ps -q -f "name=$CONTAINER" 2>$null
    if ($r) { docker stop $CONTAINER | Out-Null; docker rm $CONTAINER | Out-Null; Write-OK "Stopped." }
    else     { Write-Warn "Not running." }
    exit 0
}

if ($Logs) {
    Require-Docker; docker logs -f $CONTAINER; exit 0
}

if ($Status) {
    Require-Docker
    $libPath = Resolve-LibraryPath
    $pdfCount = (Get-ChildItem -Path $libPath -Recurse -Filter "*.pdf" -ErrorAction SilentlyContinue).Count
    Write-Host ""
    docker ps -a --filter "name=$CONTAINER" --format "  Container: {{.Names}}  {{.Status}}"
    Write-Host "  Library:  $libPath ($pdfCount PDFs)" -ForegroundColor White
    Write-Host "  Data dir: $DATA_DIR"
    Write-Host "  Image:    $IMAGE"
    Write-Host "  URL:      $URL"
    Write-Host ""
    exit 0
}

if ($Update) {
    Require-Docker
    Write-Info "Pulling latest image..."
    docker pull $IMAGE
    Write-OK "Updated. Restart: bengali-library -Stop; bengali-library"
    exit 0
}

if ($Clean) {
    Require-Docker
    $c = Read-Host "  Remove container and user data? PDFs will NOT be deleted. [y/N]"
    if ($c -notmatch "^[Yy]$") { exit 0 }
    docker stop $CONTAINER 2>$null | Out-Null
    docker rm   $CONTAINER 2>$null | Out-Null
    docker rmi  $IMAGE     2>$null | Out-Null
    Remove-Item -Recurse -Force $DATA_DIR -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $OCR_DIR  -ErrorAction SilentlyContinue
    Write-OK "Cleaned."
    exit 0
}

# ════════════════════════════════════════════════════════════════════════
# START
# ════════════════════════════════════════════════════════════════════════
Write-Hdr "Bengali Digital Library"

Require-Docker
$v = (docker --version 2>$null) -replace "Docker version ","" -replace ",.*",""
Write-OK "Docker $v"

New-Item -ItemType Directory -Force -Path $DATA_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $OCR_DIR  | Out-Null

$libPath = Resolve-LibraryPath
Write-OK "Library: $libPath"
$pdfCount = (Get-ChildItem -Path $libPath -Recurse -Filter "*.pdf" -ErrorAction SilentlyContinue).Count
Write-Info "$pdfCount PDF file(s) found."
if ($pdfCount -eq 0) { Write-Warn "No PDFs yet. Add them to: $libPath\Author Name\Book.pdf" }

# Pull image if needed
$imgExists = docker image inspect $IMAGE 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Info "Pulling image (first time, ~2 GB)..."
    docker pull $IMAGE
    if ($LASTEXITCODE -ne 0) { Write-Err "Pull failed. Check internet connection." }
}
Write-OK "Image ready."

# Stop existing container
$running = docker ps -aq -f "name=$CONTAINER" 2>$null
if ($running) {
    docker stop $CONTAINER 2>$null | Out-Null
    docker rm   $CONTAINER 2>$null | Out-Null
}

# Start container
Write-Info "Starting container..."
docker run -d `
    --name $CONTAINER `
    --restart unless-stopped `
    -p "${PORT}:7654" `
    -v "${libPath}:/app/bengali-literature:rw" `
    -v "${DATA_DIR}:/app/what-you-doing:rw" `
    -v "${OCR_DIR}:/app/ocr:rw" `
    $IMAGE | Out-Null

# Wait for readiness
Write-Info "Waiting for app to be ready..."
for ($i = 0; $i -lt 45; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "$URL/api/library" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { break }
    } catch {}
    Start-Sleep 1
    if ($i -eq 44) { Write-Warn "Slow to start. Check: bengali-library -Logs" }
}
Write-OK "App is ready!"

Write-Host ""
Write-Host "  ▶  $URL" -ForegroundColor Green
Write-Host ""
Write-Host "  bengali-library -Stop                stop"
Write-Host "  bengali-library -Logs                view logs"
Write-Host "  bengali-library -SetLibrary C:\path  change library folder"
Write-Host ""

Start-Process $URL
