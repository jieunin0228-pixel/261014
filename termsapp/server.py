"""로컬 웹 서버. 이 PC(127.0.0.1)에서만 접속되며 외부로 데이터를 보내지 않습니다."""
import os
import tempfile

import pymupdf
from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .pipeline import read_json
from .store import EditError, Store

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("TERMS_DATA_DIR", os.path.join(BASE, "data"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
DOWNLOADS = ("terms.json", "tables.json", "pages.json", "report.json", "edits.json", "status.json")

app = FastAPI(title="약관 변환·검증")
store = Store(DATA)


def doc_or_404(doc_id):
    try:
        return store.get(doc_id)
    except KeyError:
        raise HTTPException(404, "변환된 문서가 없습니다")


@app.get("/api/docs")
def list_docs():
    return store.list()


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), force: bool = False):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "PDF 파일만 올릴 수 있습니다")
    fd, tmp = tempfile.mkstemp(suffix=".pdf", dir=DATA)
    with os.fdopen(fd, "wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    try:
        pymupdf.open(tmp).close()
    except Exception:
        os.remove(tmp)
        raise HTTPException(400, "PDF를 열 수 없습니다(손상되었거나 암호가 걸린 파일)")
    doc_id, cached = store.start_convert(tmp, file.filename, force=force)
    return {"id": doc_id, "cached": cached}


@app.post("/api/docs/{doc_id}/reconvert")
def reconvert(doc_id: str):
    src = os.path.join(store.folder(doc_id), "source.pdf")
    if not os.path.exists(src):
        raise HTTPException(404, "원본 PDF가 없습니다")
    fd, tmp = tempfile.mkstemp(suffix=".pdf", dir=DATA)
    os.close(fd)
    with open(src, "rb") as a, open(tmp, "wb") as b:
        b.write(a.read())
    meta = read_json(os.path.join(store.folder(doc_id), "meta.json"), {})
    store.start_convert(tmp, meta.get("filename", ""), force=True)
    return {"id": doc_id}


@app.get("/api/docs/{doc_id}/progress")
def progress(doc_id: str):
    return store.progress(doc_id)


@app.get("/api/docs/{doc_id}/summary")
def summary(doc_id: str):
    return doc_or_404(doc_id).summary()


@app.get("/api/docs/{doc_id}/report")
def report(doc_id: str):
    return doc_or_404(doc_id).report


@app.get("/api/docs/{doc_id}/pages/{pn}")
def page(doc_id: str, pn: int):
    d = doc_or_404(doc_id)
    if not 1 <= pn <= len(d.pages):
        raise HTTPException(404, "쪽 번호가 범위를 벗어났습니다")
    return d.page_view(pn)


@app.get("/api/docs/{doc_id}/pages/{pn}/image")
def page_image(doc_id: str, pn: int, zoom: float = 1.6):
    d = doc_or_404(doc_id)
    zoom = max(0.5, min(zoom, 3.0))
    cache = os.path.join(d.folder, "page_images", f"{pn:05d}_{zoom:.1f}.png")
    if not os.path.exists(cache):
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with pymupdf.open(os.path.join(d.folder, "source.pdf")) as pdf:
            if not 1 <= pn <= pdf.page_count:
                raise HTTPException(404, "쪽 번호가 범위를 벗어났습니다")
            pdf[pn - 1].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom)).save(cache)
    return FileResponse(cache, media_type="image/png")


@app.get("/api/docs/{doc_id}/tables")
def tables(doc_id: str, page: int | None = None, issues: bool = False):
    d = doc_or_404(doc_id)
    out = d.tables
    if page:
        out = [t for t in out if t["page"] == page]
    if issues:
        out = [t for t in out if t["incomplete"] or t.get("rebuilt")]
    return out


@app.get("/api/docs/{doc_id}/table-image/{tid}")
def table_image(doc_id: str, tid: str):
    d = doc_or_404(doc_id)
    t = next((t for t in d.tables if t["id"] == tid and t.get("image")), None)
    if not t:
        raise HTTPException(404, "표 이미지가 없습니다")
    return FileResponse(os.path.join(d.folder, t["image"]), media_type="image/png")


@app.get("/api/docs/{doc_id}/locate")
def locate(doc_id: str, cid: str):
    r = doc_or_404(doc_id).locate(cid)
    if not r:
        raise HTTPException(404, "조각을 찾지 못했습니다")
    return r


@app.get("/api/docs/{doc_id}/search")
def search(doc_id: str, q: str, limit: int = 50):
    d = doc_or_404(doc_id)
    q2 = q.replace(" ", "")
    out = []
    for n in d.terms["nodes"]:
        if q in n["cid"] or q2 and q2 in n["text"].replace(" ", "").replace("\n", ""):
            out.append({"cid": n["cid"], "uid": n["uid"], "page": n["own_page_start"], "path": n["path"],
                        "text": n["text"][:80]})
            if len(out) >= limit:
                break
    return out


@app.get("/api/docs/{doc_id}/edits")
def edits(doc_id: str):
    return doc_or_404(doc_id).edits()


@app.post("/api/docs/{doc_id}/edit")
def edit(doc_id: str, body: dict = Body(...)):
    d = doc_or_404(doc_id)
    try:
        entry = d.apply(body.get("op", ""), body, user=body.get("user", ""))
    except (EditError, KeyError, ValueError) as e:
        raise HTTPException(400, str(e))
    return {"entry": entry, "summary": d.summary()}


@app.post("/api/docs/{doc_id}/reset")
def reset(doc_id: str, body: dict = Body(default={})):
    d = doc_or_404(doc_id)
    d.reset(user=body.get("user", ""))
    return d.summary()


@app.post("/api/docs/{doc_id}/approve")
def approve(doc_id: str, body: dict = Body(...)):
    d = doc_or_404(doc_id)
    return d.set_approval(bool(body.get("approved")), body.get("user", ""), body.get("note", ""))


@app.get("/api/docs/{doc_id}/download/{name}")
def download(doc_id: str, name: str):
    d = doc_or_404(doc_id)
    if name not in DOWNLOADS:
        raise HTTPException(404, "내려받을 수 없는 파일입니다")
    return FileResponse(d.path(name), media_type="application/json", filename=name)


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"), headers={"Cache-Control": "no-store"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")
