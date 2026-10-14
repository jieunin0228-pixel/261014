"""설치 없이 실행하는 Windows용 휴대용 묶음을 만듭니다.

python.org의 '임베디드 Python'(압축만 풀면 되는 Python)과 필요한 패키지의 Windows용 파일을
한 폴더에 모아 dist/TermsApp.zip 으로 만듭니다. 받는 PC에는 Python·pip 설치가 필요 없습니다.

사용: python scripts/build_portable.py   (인터넷 연결 필요, GitHub Actions에서 실행)
"""
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

PY_VERSION = "3.12.10"
PY_TAG = "312"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
APP = os.path.join(DIST, "TermsApp")

BAT = r"""@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo 약관 변환·검증 앱을 시작합니다. 끝내려면 이 창을 닫거나 Ctrl+C를 누르십시오.
"%~dp0python\python.exe" "%~dp0app\run.py"
pause
"""

README = """약관 변환·검증 앱 (설치 불필요판)

1. 이 폴더를 원하는 곳(예: 바탕화면, D:\\약관)에 그대로 둡니다.
2. START.bat 을 더블클릭합니다. 브라우저가 http://127.0.0.1:8765 를 엽니다.
3. 끝낼 때는 검은 창을 닫습니다.

- Python이나 다른 프로그램을 설치하지 않습니다. 폴더 안의 python 폴더가 실행용 Python입니다.
- 변환 결과는 app\\data 폴더에만 저장되며 외부로 보내지 않습니다.
- Windows가 "PC 보호" 창을 띄우면 [추가 정보] → [실행]을 누릅니다. 회사 보안 정책으로 막히면 전산 담당 부서에 이 폴더의 실행 허용을 요청하십시오.
"""


def run(cmd):
    print("+", " ".join(cmd), flush=True)
    subprocess.check_call(cmd)


def main():
    shutil.rmtree(DIST, ignore_errors=True)
    os.makedirs(APP)
    # 1) 임베디드 Python
    url = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"
    zpath = os.path.join(DIST, "python-embed.zip")
    urllib.request.urlretrieve(url, zpath)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(os.path.join(APP, "python"))
    os.remove(zpath)
    # 2) 패키지(Windows용 파일만 받아서 lib 폴더에 풉니다)
    wheels = os.path.join(DIST, "wheels")
    run([sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--platform", "win_amd64",
         "--python-version", PY_TAG, "--implementation", "cp", "-d", wheels,
         "-r", os.path.join(ROOT, "requirements.txt")])
    lib = os.path.join(APP, "lib")
    for w in sorted(os.listdir(wheels)):
        with zipfile.ZipFile(os.path.join(wheels, w)) as z:
            z.extractall(lib)
    shutil.rmtree(wheels)
    # 3) 앱
    app = os.path.join(APP, "app")
    shutil.copytree(os.path.join(ROOT, "termsapp"), os.path.join(app, "termsapp"),
                    ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(os.path.join(ROOT, "run.py"), app)
    # 4) 경로 설정: 임베디드 Python은 이 파일에 적힌 경로만 읽습니다.
    with open(os.path.join(APP, "python", f"python{PY_TAG}._pth"), "w", encoding="utf-8") as f:
        f.write(f"python{PY_TAG}.zip\n.\n..\\lib\n..\\app\n")
    with open(os.path.join(APP, "START.bat"), "w", encoding="utf-8", newline="\r\n") as f:
        f.write(BAT)
    with open(os.path.join(APP, "읽어보기.txt"), "w", encoding="utf-8-sig", newline="\r\n") as f:
        f.write(README)
    # 5) 압축
    out = os.path.join(DIST, "TermsApp.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(APP):
            for name in files:
                full = os.path.join(base, name)
                z.write(full, os.path.relpath(full, DIST))
    print(out, os.path.getsize(out) // (1 << 20), "MB")


if __name__ == "__main__":
    main()
