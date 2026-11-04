# Lance le serveur local + un tunnel Cloudflare public (gratuit, sans compte).
# Laissez la fenetre ouverte : le tunnel s'arrete avec elle.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host ""
Write-Host "=== FB Photo Downloader : URL publique ===" -ForegroundColor Cyan
Write-Host ""

# --- Node.js (portable installe precedemment, sinon PATH) ---
$node = "C:\Users\ASS\AppData\Local\Programs\nodejs-portable\node-v26.13.0-win-x64\node.exe"
if (-not (Test-Path $node)) { $node = "node" }

# --- cloudflared (telecharge au premier lancement) ---
$cfDir = "C:\Users\ASS\AppData\Local\Programs\cloudflared"
$cf = Join-Path $cfDir "cloudflared.exe"
if (-not (Test-Path $cf)) {
    Write-Host "Telechargement de cloudflared (une seule fois)..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force $cfDir | Out-Null
    Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $cf -TimeoutSec 300
}

# --- serveur local ---
$listening = Get-NetTCPConnection -LocalPort 3812 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    Write-Host "Demarrage du serveur sur le port 3812..." -ForegroundColor Yellow
    Start-Process -FilePath $node -ArgumentList "server.js" -WorkingDirectory $root -WindowStyle Hidden
    Start-Sleep -Seconds 2
}
try {
    Invoke-RestMethod -Uri "http://localhost:3812/health" -TimeoutSec 15 | Out-Null
} catch {
    Write-Host "Le serveur local ne repond pas sur http://localhost:3812" -ForegroundColor Red
    Write-Host "Lancez d'abord start.bat, puis relancez ce script." -ForegroundColor Red
    exit 1
}

# --- tunnel ---
$logOut = Join-Path $env:TEMP "fb-photo-tunnel-out.log"
$logErr = Join-Path $env:TEMP "fb-photo-tunnel-err.log"
Remove-Item $logOut, $logErr -Force -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $cf `
    -ArgumentList @("tunnel", "--url", "http://localhost:3812", "--no-autoupdate") `
    -RedirectStandardOutput $logOut -RedirectStandardError $logErr `
    -PassThru -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    foreach ($f in @($logOut, $logErr)) {
        if (Test-Path $f) {
            $m = Select-String -Path $f -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($m) { $url = $m.Matches[0].Value; break }
        }
    }
    if ($url) { break }
    if ($proc.HasExited) { break }
}

if (-not $url) {
    Write-Host "Impossible de creer le tunnel. Details : $logErr" -ForegroundColor Red
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    exit 1
}

Set-Clipboard -Value $url
Write-Host ""
Write-Host "URL publique : $url" -ForegroundColor Green
Write-Host "(adresse copiee dans le presse-papiers)" -ForegroundColor Gray
Write-Host ""
Write-Host "Cette adresse change a chaque redemarrage du tunnel." -ForegroundColor Gray
Write-Host "Laissez cette fenetre ouverte. Ctrl+C pour arreter." -ForegroundColor Cyan
Start-Process $url

try {
    Wait-Process -Id $proc.Id
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
