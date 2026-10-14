@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo [처음 실행] 필요한 프로그램을 설치합니다. 몇 분 걸립니다...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if not exist .venv\Scripts\python.exe (
    echo Python을 찾을 수 없습니다. README의 설치 방법을 확인하세요.
    pause
    exit /b 1
  )
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt
)
.venv\Scripts\python app.py
pause
