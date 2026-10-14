@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주십시오.
  pause
  exit /b 1
)
if not exist node_modules (
  echo 처음 실행이므로 필요한 구성요소를 설치합니다. 몇 분 걸릴 수 있습니다.
  call npm install --omit=dev
  if errorlevel 1 (
    echo 설치에 실패했습니다. 인터넷 연결 또는 사내 프록시 설정을 확인해 주십시오.
    pause
    exit /b 1
  )
)
rem 사내 프록시(HTTPS_PROXY)가 설정된 PC 에서는 Claude API 호출도 프록시를 거치게 합니다.
if defined HTTPS_PROXY set NODE_USE_ENV_PROXY=1
start "" http://localhost:3000
node server\index.js
pause
