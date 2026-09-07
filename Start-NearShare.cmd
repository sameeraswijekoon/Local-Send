@echo off
setlocal
cd /d "%~dp0"
set "nearshare_node=node"
where node >nul 2>nul
if errorlevel 1 set "nearshare_node=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "node_modules\ws\package.json" (
  echo Install dependencies first: pnpm install
  pause
  exit /b 1
)
if not exist "dist\lan\index.html" (
  echo Build the app first: pnpm build
  pause
  exit /b 1
)
"%nearshare_node%" server\index.mjs
if errorlevel 1 pause
