# Lanceur FB Photo Downloader (utilise le Node portable si présent)
$nodeDir = "C:\Users\ASS\AppData\Local\Programs\nodejs-portable\node-v26.13.0-win-x64"
if (Test-Path $nodeDir) { $env:Path = "$nodeDir;" + $env:Path }
Set-Location $PSScriptRoot
node server.js
