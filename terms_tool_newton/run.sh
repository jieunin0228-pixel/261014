#!/usr/bin/env bash
# Mac·Linux 실행: 처음 한 번은 가상환경을 만들고 필요한 패키지를 설치합니다.
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "[처음 실행] 필요한 프로그램을 설치합니다..."
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
fi
exec .venv/bin/python app.py
