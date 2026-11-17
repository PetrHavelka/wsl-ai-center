@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ not found in PATH - install it from https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0src\main.js" %*
