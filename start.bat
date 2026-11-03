@echo off
set "NODE_DIR=C:\Users\ASS\AppData\Local\Programs\nodejs-portable\node-v26.13.0-win-x64"
if exist "%NODE_DIR%" set "PATH=%NODE_DIR%;%PATH%"
cd /d "%~dp0"
node server.js
