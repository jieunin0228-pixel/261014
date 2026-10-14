#!/bin/bash
# 맥 실행 파일: Finder에서 두 번 클릭하면 터미널 창이 열리며 실행됩니다.
# 처음 한 번은 필요한 프로그램을 내려받아 설치하므로 몇 분 걸립니다.
cd "$(dirname "$0")" || exit 1
clear
echo "=============================================="
echo "  약관 구조화 도구를 시작합니다"
echo "=============================================="

pause_exit() { echo; read -r -p "엔터를 누르면 이 창을 닫을 수 있습니다." _; exit 1; }

# Python 3.10 이상 찾기 (python.org 설치본 → Homebrew → 기본)
PY=""
for c in /Library/Frameworks/Python.framework/Versions/3.1[0-9]/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
    PY="$c"; break
  fi
done
if [ -z "$PY" ]; then
  echo
  echo "[안내] Python 3.10 이상이 설치되어 있지 않습니다."
  echo "  1) 지금 열리는 python.org 페이지에서 [Download Python]을 눌러 설치하세요."
  echo "  2) 설치가 끝나면 이 파일(run_mac.command)을 다시 두 번 클릭하세요."
  open "https://www.python.org/downloads/macos/" 2>/dev/null
  pause_exit
fi
echo "Python: $("$PY" --version)"

# 가상환경 만들기와 패키지 설치(처음 한 번, 또는 설치 목록이 바뀌었을 때)
if [ ! -x .venv/bin/python ] || ! .venv/bin/python -c 'import sys' >/dev/null 2>&1; then
  echo; echo "[처음 실행] 필요한 프로그램을 설치합니다. 몇 분 걸립니다..."
  rm -rf .venv
  "$PY" -m venv .venv || { echo "[오류] 가상환경을 만들지 못했습니다."; pause_exit; }
fi
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  .venv/bin/python -m pip install --upgrade pip >/dev/null 2>&1
  if ! .venv/bin/python -m pip install -r requirements.txt; then
    echo; echo "[오류] 프로그램 설치에 실패했습니다. 인터넷 연결(회사 보안망)을 확인하고, 이 창의 내용을 사진으로 찍어 보내 주세요."
    pause_exit
  fi
  touch .venv/.installed
fi

# AI 기능(3·4단계)용 API 키: 이 창에서만 쓰고 파일에 저장하지 않습니다.
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo
  echo "AI 기능(결과 카드·ECS 초안)을 쓰려면 Anthropic API 키를 붙여 넣고 엔터를 누르세요."
  echo "(쓰지 않으려면 그냥 엔터. 붙여 넣은 글자는 화면에 보이지 않습니다.)"
  read -r -s -p "API 키: " KEY; echo
  if [ -n "$KEY" ]; then export ANTHROPIC_API_KEY="$KEY"; echo "API 키를 이번 실행에만 적용했습니다."; fi
fi

echo
echo "브라우저에 도구 화면이 열립니다. 안 열리면 주소창에 http://127.0.0.1:8765 를 입력하세요."
echo "쓰는 동안 이 터미널 창을 닫지 마세요. 끝낼 때는 이 창에서 control + C 를 누릅니다."
.venv/bin/python app.py || pause_exit
