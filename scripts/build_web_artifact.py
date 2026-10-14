"""claude.ai 아티팩트판(브라우저 단독) 만들기: python scripts/build_web_artifact.py

로컬판 화면(termsapp/static)을 바탕으로, 서버 호출을 브라우저 처리 계층(artifact/backend.js)으로,
파일 링크를 claude.ai 내려받기 기능으로 바꿉니다. 결과는 build/web/ 에 만들어지며 그대로 게시합니다.
게시 파일: index.html(페이지), app.js, engine.js, backend.js, cmaps-ko.js
선언 기능: sample(3단계 Claude 호출), downloads(엑셀·JSON 내려받기)
"""
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, "termsapp", "static")
OUT = os.path.join(ROOT, "build", "web")

PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174"
XLSX = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"


def sub(text, old, new, count=1):
    if old not in text:
        raise SystemExit(f"바꿀 부분을 찾지 못했습니다: {old[:60]}")
    return text.replace(old, new, count)


def build_app_js():
    s = open(os.path.join(STATIC, "app.js"), encoding="utf-8").read()
    # 1) 서버 호출 → 브라우저 처리 계층
    s = re.sub(r"async function api\(path, opts = \{\}\) \{.*?\n\}\n", '''async function api(path, opts = {}) {
  try { return await TermsBackend.request(path, opts); }
  catch (e) { throw new Error(e.message || String(e)); }
}
''', s, count=1, flags=re.S)
    s = sub(s, '''  const fd = new FormData(); fd.append("file", file);
  showProgress({ stage: "올리는 중", done: 0, total: 1 });
  try {
    const r = await api("/api/upload", { method: "POST", body: fd });''', '''  showProgress({ stage: "PDF 읽는 중", done: 0, total: 1 });
  try {
    const r = await TermsBackend.convert(file);''')
    # 2) 쪽 이미지: 브라우저에서 그림
    s = sub(s, '''  img.src = `/api/docs/${state.doc}/pages/${n}/image?zoom=2`;''',
            '''  TermsBackend.pageImage(state.doc, n).then((u) => { if (state.page === n) img.src = u; }).catch((e) => toast("쪽 그림을 만들지 못했습니다: " + e.message));''')
    # 3) 표 원본 이미지: 비어 있는 그림을 나중에 채움
    s = sub(s, '''<img loading="lazy" src="/api/docs/${state.doc}/table-image/${t.id}" alt="${esc(t.id)} 원본">''',
            '''<img data-timg="${esc(t.id)}" alt="${esc(t.id)} 원본">''')
    # 4) 내려받기 탭
    s = sub(s, '''  const f = (name, desc) => `<tr><td><a href="/api/docs/${state.doc}/download/${name}">${name}</a></td><td>${desc}</td></tr>`;''',
            '''  const f = (name, desc) => `<tr><td><button class="btn small" data-dl="${name}">${name}</button></td><td>${desc}</td></tr>`;''')
    s = sub(s, '''    <p><button class="btn" id="reconvertBtn">같은 PDF를 처음부터 다시 변환</button> <span class="muted">수정 이력과 승인이 초기화됩니다.</span></p>`;''',
            '''    <p><button class="btn" id="reconvertBtn">같은 PDF를 처음부터 다시 변환</button> <span class="muted">수정 이력과 승인이 초기화됩니다.</span></p>
    <p><button class="btn danger" id="deleteDocBtn">이 브라우저에서 이 약관 지우기</button> <span class="muted">PDF와 변환·수정·요약 결과를 이 브라우저에서 지웁니다.</span></p>
    <p class="muted">모든 결과는 이 브라우저(IndexedDB)에만 저장됩니다. 브라우저 사이트 데이터를 지우면 함께 사라지므로, 필요한 결과는 위 파일로 내려받아 보관하십시오.</p>`;
  $("#filesBody").onclick = async (ev) => {
    const b = ev.target.closest("[data-dl]"); if (!b) return;
    try { const d = await TermsBackend.loadDoc(state.doc); if (await TermsBackend.download(d, b.dataset.dl)) toast("내려받았습니다."); }
    catch (e) { toast("내려받지 못했습니다: " + e.message, 5000); }
  };
  $("#deleteDocBtn").onclick = async () => {
    if (!(await askConfirm("이 약관의 PDF와 모든 결과를 이 브라우저에서 지웁니다. 되돌릴 수 없습니다. 계속할까요?", "지우기"))) return;
    await api(`/api/docs/${state.doc}/delete`, { method: "POST", body: "{}" });
    store("lastDoc", ""); location.reload();
  };''')
    # 5) 담보 분류·요약 내보내기
    s = sub(s, '''const covExport = (fmt) => { location.href = `/api/docs/${state.doc}/coverage/export?fmt=${fmt}&selected=${$("#covSelOnly").checked}`; };''',
            '''const covExport = async (fmt) => {
  try { const d = await TermsBackend.loadDoc(state.doc); if (await TermsBackend.download(d, fmt === "xlsx" ? "coverage.xlsx" : "coverage.json", { selected: $("#covSelOnly").checked })) toast("내려받았습니다."); }
  catch (e) { toast("내려받지 못했습니다: " + e.message, 5000); }
};''')
    s = sub(s, '''$("#sumXlsx").onclick = () => { location.href = `/api/docs/${state.doc}/summaries-export?selected=true`; };''',
            '''$("#sumXlsx").onclick = async () => {
  try { const d = await TermsBackend.loadDoc(state.doc); if (await TermsBackend.download(d, "summaries.xlsx", { selected: true })) toast("내려받았습니다."); }
  catch (e) { toast("내려받지 못했습니다: " + e.message, 5000); }
};''')
    # 6) 3단계 안내 문구(API 키 대신 claude.ai의 Claude 호출)
    s = re.sub(r'k\.innerHTML = `서버에 Claude API 키.*?`;', 'k.innerHTML = `이 화면에서는 Claude를 부를 수 없습니다. claude.ai에서 이 아티팩트를 열면 [선택 담보 요약 실행]을 쓸 수 있습니다. 이미 만든 요약은 그대로 볼 수 있습니다.`;', s, count=1, flags=re.S)
    s = sub(s, '''담보 하나당 해당 특약 조문(보통 2~4만 자)을 보내며 API 사용료가 발생합니다.''',
            '''담보 하나당 해당 특약 조문(보통 2~4만 자)을 보내며, 지금 보고 있는 사람의 Claude 사용량을 씁니다. 처음 한 번은 Claude 사용 허용 창이 뜹니다.''')
    # 7) 표 원본 이미지 채우기
    s += '''
// 표 원본 그림은 화면에 나타난 뒤 브라우저에서 그려 채웁니다.
new MutationObserver(() => {
  document.querySelectorAll("img[data-timg]:not([data-busy])").forEach(async (im) => {
    im.dataset.busy = "1";
    try {
      const d = await TermsBackend.loadDoc(state.doc);
      const t = d.tables.find((x) => x.id === im.dataset.timg);
      if (t) im.src = await TermsBackend.tableImage(state.doc, t);
    } catch (e) { im.alt = "원본 그림을 만들지 못했습니다"; }
  });
}).observe(document.body, { childList: true, subtree: true });
'''
    return s


def build_index():
    html = open(os.path.join(STATIC, "index.html"), encoding="utf-8").read()
    css = open(os.path.join(STATIC, "style.css"), encoding="utf-8").read()
    body = html[html.index("<body>") + len("<body>"):html.index("</body>")]
    body = body.replace('<script src="/static/app.js"></script>', "")
    body = sub(body, "변환은 이 PC 안에서만 처리하며 외부로 보내지 않습니다. 같은 PDF를 다시 올리면 저장된 결과를 그대로 엽니다.",
               "PDF 변환은 이 브라우저 안에서만 처리하며 외부로 보내지 않습니다. 결과는 이 브라우저에만 저장되고, 같은 PDF를 다시 올리면 저장된 결과를 엽니다. 3단계(담보별 요약)만 담보 단위 조문을 Claude에 보냅니다.")
    body = sub(body, '<span class="step">1단계</span>', '<span class="step">브라우저판</span>')
    css = css.replace(":root {", ":root {\n  color-scheme: light;", 1)
    css += "\nbody { background: var(--bg); color: var(--text); }\n"
    return f"""<title>약관 변환 검증</title>
<style>
{css}
</style>
{body}
<script src="{PDFJS}/pdf.min.js"></script>
<script src="{PDFJS}/pdf.worker.min.js"></script>
<script src="{XLSX}"></script>
<script src="cmaps-ko.js"></script>
<script src="engine.js"></script>
<script src="backend.js"></script>
<script src="app.js"></script>
"""


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
        f.write(build_index())
    with open(os.path.join(OUT, "app.js"), "w", encoding="utf-8") as f:
        f.write(build_app_js())
    for src in ("artifact/engine.js", "artifact/backend.js", "legacy/vendor/cmaps-ko.js"):
        shutil.copy(os.path.join(ROOT, src), OUT)
    print("\n".join(sorted(os.listdir(OUT))))


if __name__ == "__main__":
    main()
