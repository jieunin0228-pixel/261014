"""아티팩트 페이지 조립: ui/index.html의 본문 + ui/style.css(인라인) + 스크립트 태그 → index.html"""
import os, re
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "ui/index.html"), encoding="utf-8").read()
css = open(os.path.join(HERE, "ui/style.css"), encoding="utf-8").read()
body = src[src.index("<body>") + 6: src.index("</body>")]
body = re.sub(r"<script[^>]*></script>\s*", "", body)
CDN = [
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
]
LOCAL = ["vendor/cmaps-ko.js"] + [f"js/{n}.js" for n in ("tt-extract", "tt-structure", "tt-store", "tt-page", "tt-ai", "tt-classify", "tt-compare", "tt-export", "tt-router")]
UI = [f"ui/{n}.js" for n in ("app", "classify", "analysis", "compare")]
page = f"""<title>약관 구조화 도구</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
{css}
</style>
{body.strip()}
""" + "\n".join(f'<script src="{u}"></script>' for u in CDN + LOCAL) + """
<script>
  try { TT.setupPdf(); } catch (e) { console.error(e); }
</script>
""" + "\n".join(f'<script src="{u}"></script>' for u in UI) + "\n"
open(os.path.join(HERE, "index.html"), "w", encoding="utf-8").write(page)
print(len(page), "bytes")
