@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ not found in PATH - install it from https://nodejs.org
  pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0]<20?1:0)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required - the node in PATH is older. Install a current version from https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0src\main.js" %*
