@echo off
setlocal

cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "NODE=%LOCALAPPDATA%\OpenAI\Codex\bin\node.exe"
)

if not exist "%NODE%" if /i not "%NODE%"=="node" (
  echo Nie znaleziono Node.js.
  echo Uruchom w terminalu: node server.mjs
  pause
  exit /b 1
)

start "Radar Okazji OLX - serwer" cmd /k ""%NODE%" server.mjs"
timeout /t 2 /nobreak >nul
start "" "http://localhost:5173/"
