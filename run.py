"""약관 변환·검증 앱 실행: python run.py"""
import os
import sys
import threading
import webbrowser

HOST, PORT = "127.0.0.1", int(os.environ.get("PORT", "8765"))


def main():
    try:
        import uvicorn
        import pymupdf  # noqa: F401
    except ImportError:
        print("필요한 프로그램이 설치되지 않았습니다. 먼저 다음 명령을 실행하십시오:\n  python -m pip install -r requirements.txt")
        sys.exit(1)
    url = f"http://{HOST}:{PORT}"
    print(f"약관 변환·검증 앱: {url}  (끝내려면 이 창에서 Ctrl+C)")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run("termsapp.server:app", host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
