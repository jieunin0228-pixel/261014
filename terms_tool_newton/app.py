"""약관 구조화 도구 - 로컬 서버.

실행: python app.py  →  브라우저에서 http://127.0.0.1:8765 를 엽니다.
이 PC(127.0.0.1)에서만 접속되며, 약관과 결과는 data/ 폴더에만 저장됩니다.
1단계(변환·검증)는 외부로 아무것도 보내지 않습니다.
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import webbrowser

from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from converter import ai, cards, classify, compare, ecs, export, pipeline  # noqa: E402
from converter.structure import COVERAGE_TYPES  # noqa: E402

app = FastAPI(title="약관 구조화 도구")
_cache = {}
_clock = threading.Lock()


def cached(doc_id, name):
    path = os.path.join(pipeline.doc_dir(doc_id), name)
    if not os.path.exists(path):
        raise HTTPException(404, f"{name} 없음 — 먼저 변환을 실행하세요.")
    mt = os.path.getmtime(path)
    key = (doc_id, name)
    with _clock:
        hit = _cache.get(key)
        if hit and hit[0] == mt:
            return hit[1]
    data = pipeline.read_json(doc_id, name)
    with _clock:
        _cache[key] = (mt, data)
    return data


def check_doc(doc_id):
    if not doc_id or not doc_id.isalnum() or not os.path.isdir(pipeline.doc_dir(doc_id)):
        raise HTTPException(404, "문서를 찾을 수 없습니다.")


# ---------------------------------------------------------------- 문서·변환

@app.get("/api/docs")
def docs():
    return pipeline.list_docs()


@app.post("/api/docs")
async def upload(file: UploadFile = File(...), force: bool = Query(False)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "PDF 파일만 올릴 수 있습니다.")
    os.makedirs(pipeline.ROOT, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".pdf", dir=pipeline.ROOT)
    with os.fdopen(fd, "wb") as f:
        while True:
            chunk = await file.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    job = pipeline.start_conversion(tmp, file.filename, force=force)
    return job


@app.post("/api/docs/{doc_id}/reconvert")
def reconvert(doc_id: str):
    check_doc(doc_id)
    src = os.path.join(pipeline.doc_dir(doc_id), "source.pdf")
    meta = pipeline.read_json(doc_id, "meta.json") or {}
    return pipeline.start_conversion(src, meta.get("filename", "source.pdf"), force=True)


@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    j = pipeline.job_status(job_id)
    if not j:
        raise HTTPException(404, "작업 없음")
    return {k: v for k, v in j.items() if k != "trace"} | ({"trace": j["trace"]} if j.get("trace") else {})


@app.get("/api/docs/{doc_id}/summary")
def summary(doc_id: str):
    check_doc(doc_id)
    cmap = cached(doc_id, "coverage_map.json")
    reviews = pipeline.read_json(doc_id, "reviews.json", {}) or {}
    approval = pipeline.read_json(doc_id, "approval.json", {}) or {}
    nodes = cached(doc_id, "terms.json")["nodes"]
    covs = []
    for c in cmap["coverages"]:
        k = c["key"]
        covs.append({
            "cid": c["cid"], "name": c["name"], "start": c["start"], "end": c["end"], "type": c["type"],
            "type_auto": c["type_auto"], "type_edited": c["type_edited"], "range_edited": c["range_edited"],
            "toc_start": c["toc_start"], "toc_end": c["toc_end"], "header_pages": c["header_pages"],
            "n_articles": c["n_articles"], "n_tables": len(c["tables"]), "annexes": c["annexes"],
            "payout": ({"id": k["payout"], "key": nodes[k["payout"]]["key"], "title": nodes[k["payout"]]["title"],
                        "page": nodes[k["payout"]]["page_start"]} if k["payout"] else None),
            "review": reviews.get(c["cid"], {"status": "미검토"}),
        })
    return {"doc": cmap["doc"], "coverages": covs, "types": COVERAGE_TYPES, "approval": approval,
            "meta": pipeline.read_json(doc_id, "meta.json")}


@app.get("/api/docs/{doc_id}/report")
def report(doc_id: str):
    check_doc(doc_id)
    return cached(doc_id, "report.json")


def _brief(nodes, nid):
    n = nodes.get(nid)
    if not n:
        return {"id": nid, "missing": True}
    return {"id": nid, "cid": n["cid"], "kind": n["kind"], "key": n["key"], "title": n.get("title", ""),
            "page": n["page_start"]}


@app.get("/api/docs/{doc_id}/coverage/{cid}")
def coverage(doc_id: str, cid: str):
    check_doc(doc_id)
    cmap = cached(doc_id, "coverage_map.json")
    terms = cached(doc_id, "terms.json")
    tables = cached(doc_id, "tables.json")["tables"]
    c = next((x for x in cmap["coverages"] if x["cid"] == cid), None)
    if not c:
        raise HTTPException(404, "담보 없음")
    nodes = terms["nodes"]
    order = terms["orders"].get(cid, [])
    tree = [{k: v for k, v in nodes[i].items() if k != "lines"} | {"first_line": nodes[i]["lines"][0] if nodes[i]["lines"] else None,
                                                               "n_lines": len(nodes[i]["lines"])}
            for i in order]
    refs = [r for r in terms["refs"] if r["cid"] == cid]
    inc = c["inputs"]
    by_cid = {x["cid"]: x["name"] for x in cmap["coverages"]}
    inputs = {
        "own": [_brief(nodes, i) for i in inc["own"]],
        "common_refs": [_brief(nodes, i) for i in inc["common_refs"]],
        "main_refs": [_brief(nodes, i) for i in inc["main_refs"]],
        "annex_refs": [_brief(nodes, i) for i in inc["annex_refs"]],
        "law_refs": [_brief(nodes, i) for i in inc["law_refs"]],
        "whole": [w | {"name": by_cid.get(w["cid"], "")} for w in inc["whole"]],
    }
    cov = {k: v for k, v in c.items() if k not in ("inputs", "pages")}
    return {"coverage": cov, "nodes": tree, "tables": [t for t in tables if t["cid"] == cid], "refs": refs,
            "inputs": inputs, "review": (pipeline.read_json(doc_id, "reviews.json", {}) or {}).get(cid, {"status": "미검토"})}


@app.get("/api/docs/{doc_id}/node")
def node(doc_id: str, id: str):
    check_doc(doc_id)
    nodes = cached(doc_id, "terms.json")["nodes"]
    if id not in nodes:
        raise HTTPException(404, "조문 없음")
    return nodes[id]


@app.get("/api/docs/{doc_id}/page/{pno}.png")
def page_png(doc_id: str, pno: int, scale: float = 1.5):
    check_doc(doc_id)
    meta = pipeline.read_json(doc_id, "meta.json") or {}
    if pno < 1 or (meta.get("page_count") and pno > meta["page_count"]):
        raise HTTPException(404, "쪽 범위 밖")
    return FileResponse(pipeline.render_page(doc_id, pno, scale), media_type="image/png",
                        headers={"Cache-Control": "max-age=86400"})


@app.get("/api/docs/{doc_id}/page/{pno}/lines")
def page_lines(doc_id: str, pno: int):
    check_doc(doc_id)
    raw = cached(doc_id, "raw_pages.json")
    if pno < 1 or pno > len(raw["pages"]):
        raise HTTPException(404, "쪽 범위 밖")
    pg = raw["pages"][pno - 1]
    owner = cached(doc_id, "terms.json")["line_owner"]
    prow = cached(doc_id, "pages.json")["pages"][pno - 1]
    return {"p": pno, "w": pg["w"], "h": pg["h"], "header": pg["header"], "footer": pg["footer"],
            "row": prow,
            "lines": [{"i": i, "t": l["t"], "b": l["b"], "owner": owner.get(f"{pno}:{i}")} for i, l in enumerate(pg["lines"])],
            "tables": [{"idx": t["idx"], "kind": t["kind"], "bbox": t["bbox"], "complete": t["complete"]} for t in pg["tables"]]}


@app.get("/api/docs/{doc_id}/file/{path:path}")
def doc_file(doc_id: str, path: str):
    check_doc(doc_id)
    base = os.path.realpath(pipeline.doc_dir(doc_id))
    full = os.path.realpath(os.path.join(base, path))
    if not full.startswith(base + os.sep) or not full.endswith(".png") or not os.path.exists(full):
        raise HTTPException(404, "파일 없음")
    return FileResponse(full)


# ---------------------------------------------------------------- 수정·검토·승인

@app.get("/api/docs/{doc_id}/edits")
def edits(doc_id: str):
    check_doc(doc_id)
    return {"edits": pipeline.read_json(doc_id, "edits.json", []) or [],
            "history": pipeline.read_json(doc_id, "history.json", []) or []}


ALLOWED = {
    "coverage_range": {"cid", "start", "end"},
    "coverage_type": {"cid", "type"},
    "split": {"cid", "page", "line", "key", "title", "kind"},
    "rename": {"cid", "page", "line", "key", "title", "kind"},
    "merge": {"cid", "page", "line"},
}


@app.post("/api/docs/{doc_id}/edits")
def add_edit(doc_id: str, body: dict = Body(...)):
    check_doc(doc_id)
    action = body.get("action")
    if action not in ALLOWED:
        raise HTTPException(400, "알 수 없는 수정 종류")
    edit = {"action": action}
    for k in ALLOWED[action]:
        if k in body:
            edit[k] = body[k]
    if action == "coverage_type" and edit.get("type") not in COVERAGE_TYPES:
        raise HTTPException(400, "알 수 없는 유형")
    if action == "coverage_range":
        try:
            s, e = int(edit["start"]), int(edit["end"])
        except (KeyError, ValueError):
            raise HTTPException(400, "시작·끝 쪽을 숫자로 넣으세요.")
        meta = pipeline.read_json(doc_id, "meta.json") or {}
        if not (1 <= s <= e <= meta.get("page_count", 10 ** 6)):
            raise HTTPException(400, "쪽 범위가 올바르지 않습니다.")
    if action in ("split", "rename") and not str(edit.get("key", "")).strip():
        raise HTTPException(400, "조문 번호(예: 제2-3조, 별표2-1)를 넣으세요.")
    if action in ("split", "rename"):
        edit["kind"] = "annex" if str(edit["key"]).startswith("별표") else "article"
    if "before" in body:
        edit["before"] = body["before"]
    pipeline.add_edit(doc_id, edit, body.get("user", ""))
    return {"ok": True}


@app.delete("/api/docs/{doc_id}/edits/{eid}")
def undo(doc_id: str, eid: str, user: str = ""):
    check_doc(doc_id)
    try:
        pipeline.undo_edit(doc_id, eid, user)
    except KeyError:
        raise HTTPException(404, "수정 항목 없음")
    return {"ok": True}


@app.post("/api/docs/{doc_id}/review")
def review(doc_id: str, body: dict = Body(...)):
    check_doc(doc_id)
    try:
        return pipeline.set_review(doc_id, body["cid"], body["status"], body.get("user", ""))
    except (KeyError, ValueError):
        raise HTTPException(400, "검토 상태는 미검토/검토완료 중 하나입니다.")


@app.post("/api/docs/{doc_id}/approval")
def approval(doc_id: str, body: dict = Body(...)):
    check_doc(doc_id)
    return pipeline.set_approval(doc_id, bool(body.get("approved")), body.get("user", ""))


# ---------------------------------------------------------------- 2단계: 담보 분류

def _cls(fn):
    try:
        return fn()
    except classify.NotApproved as e:
        raise HTTPException(409, str(e))
    except (KeyError, ValueError) as e:
        raise HTTPException(400, str(e).strip("'"))


@app.get("/api/docs/{doc_id}/classification")
def cls_view(doc_id: str):
    check_doc(doc_id)
    return classify.view(doc_id)


@app.post("/api/docs/{doc_id}/classification/generate")
def cls_generate(doc_id: str, body: dict = Body(default={})):
    check_doc(doc_id)
    _cls(lambda: classify.generate(doc_id, body.get("user", ""), bool(body.get("reset"))))
    return classify.view(doc_id)


@app.post("/api/docs/{doc_id}/classification/ai")
def cls_ai(doc_id: str, body: dict = Body(default={})):
    check_doc(doc_id)
    _cls(lambda: classify.require_approved(doc_id))
    if not classify.ai_available():
        raise HTTPException(400, "ANTHROPIC_API_KEY 환경변수가 설정되지 않아 AI 분류를 실행할 수 없습니다. README의 'AI 사용 설정'을 참고하세요.")
    _cls(lambda: classify._get(doc_id))
    cids = body.get("cids") or None
    return pipeline.start_task(doc_id, lambda prog: classify.ai_suggest(doc_id, body.get("user", ""), prog, cids), "AI 분류 제안")


@app.post("/api/docs/{doc_id}/classification/{op}")
def cls_op(doc_id: str, op: str, body: dict = Body(...)):
    check_doc(doc_id)
    u = body.get("user", "")
    if op == "move":
        _cls(lambda: classify.move(doc_id, body["cid"], body["major"], body.get("mid", ""), body.get("minor", ""), u))
    elif op == "rename_item":
        _cls(lambda: classify.rename_item(doc_id, body["cid"], body.get("display_name", ""), u))
    elif op == "rename_group":
        _cls(lambda: classify.rename_group(doc_id, body["major"], body["mid"], body.get("minor"), body.get("new_name", ""), u))
    elif op == "select":
        _cls(lambda: classify.set_selected(doc_id, body.get("cids", []), u))
    elif op == "review":
        _cls(lambda: classify.set_review(doc_id, body["cid"], body["status"], u))
    elif op == "apply_ai":
        _, applied, skipped = _cls(lambda: classify.apply_ai(doc_id, body.get("cids", []), u))
        return classify.view(doc_id) | {"applied": applied, "skipped": skipped}
    else:
        raise HTTPException(404, "알 수 없는 작업")
    return classify.view(doc_id)


# ---------------------------------------------------------------- 3·4단계: 결과 카드·ECS 초안

def _require_approved(doc_id):
    if not pipeline.is_approved(doc_id):
        raise HTTPException(409, "1단계 변환이 승인되지 않아 AI 해석을 실행할 수 없습니다. 검증 후 [변환 승인]을 먼저 누르세요.")
    if not ai.available():
        raise HTTPException(400, "ANTHROPIC_API_KEY 환경변수가 설정되지 않아 AI 해석을 실행할 수 없습니다. README의 'AI 사용 설정'을 참고하세요.")


@app.get("/api/docs/{doc_id}/analysis")
def analysis_view(doc_id: str):
    check_doc(doc_id)
    cls = classify.load(doc_id) or {}
    cmap = cached(doc_id, "coverage_map.json")
    covs = [{"cid": c["cid"], "name": c["name"], "type": c["type"], "start": c["start"], "end": c["end"]}
            for c in cmap["coverages"] if c["type"] in classify.CLASSIFY_TYPES]
    cd, ed = cards.load(doc_id), ecs.load(doc_id)
    for c in covs:
        it = (cls.get("items") or {}).get(c["cid"]) or {}
        c["class"] = "/".join(x for x in (it.get("major"), it.get("mid"), it.get("minor")) if x)
        c["display_name"] = it.get("display_name")
        c["has_card"] = c["cid"] in cd
        c["has_ecs"] = c["cid"] in ed
    appr = pipeline.read_json(doc_id, "approval.json", {}) or {}
    return {"coverages": covs, "selected": cls.get("selected") or [], "approved": bool(appr.get("approved")),
            "approval_at": appr.get("at"), "ai_available": ai.available(), "model": ai.MODEL,
            "product": ecs.product(doc_id), "master": _master_summary(), "fields": ecs.FIELDS}


def _master_summary():
    m = ecs.load_master()
    return {"loaded": bool(m.get("fields")), "imported_at": m.get("imported_at"),
            "fields": {k: len(v) for k, v in (m.get("fields") or {}).items()}}


@app.post("/api/docs/{doc_id}/analysis/run")
def analysis_run(doc_id: str, body: dict = Body(...)):
    check_doc(doc_id)
    _require_approved(doc_id)
    cids = [c for c in body.get("cids", []) if c]
    if not cids:
        raise HTTPException(400, "분석할 담보를 고르세요.")
    stage = body.get("stage")
    u = body.get("user", "")

    def task(prog):
        if stage in ("cards", "both"):
            cards.run(doc_id, cids, u, lambda s, f, m="": prog(s, f * (0.5 if stage == "both" else 1), m))
        if stage in ("ecs", "both"):
            ecs.run(doc_id, cids, u, lambda s, f, m="": prog(s, (0.5 + f / 2) if stage == "both" else f, m))
    if stage not in ("cards", "ecs", "both"):
        raise HTTPException(400, "stage는 cards/ecs/both 중 하나입니다.")
    return pipeline.start_task(doc_id, task, "AI 해석")


@app.get("/api/docs/{doc_id}/card/{cid}")
def card_get(doc_id: str, cid: str):
    check_doc(doc_id)
    card = cards.load(doc_id).get(cid)
    tables = {t["id"]: t for t in cached(doc_id, "tables.json")["tables"]}
    if card:
        card = dict(card)
        card["table_data"] = [tables[t["table"]] for t in card["tables"] if t["table"] in tables]
    appr = pipeline.read_json(doc_id, "approval.json", {}) or {}
    cmp_data = compare.load(doc_id)
    before = None
    if cmp_data:
        p = next((p for p in cmp_data["pairs"] if p["new"] == cid), None)
        if p and p["old"]:
            before = (ecs.load(cmp_data["old_doc"]).get(p["old"]) or {}).get("rows")
    rows = ecs.view_rows(doc_id, cid, before)
    return {"card": card, "ecs": rows, "stale": bool(card and card.get("approval_at") != appr.get("at")),
            "compare_mode": before is not None}


@app.post("/api/docs/{doc_id}/card/{cid}/review")
def card_review(doc_id: str, cid: str, body: dict = Body(...)):
    check_doc(doc_id)
    try:
        cards.set_review(doc_id, cid, body["item"], body["status"], body.get("user", ""))
    except (KeyError, ValueError) as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/docs/{doc_id}/ecs/{cid}/{op}")
def ecs_op(doc_id: str, cid: str, op: str, body: dict = Body(...)):
    check_doc(doc_id)
    try:
        if op == "edit":
            ecs.edit_cell(doc_id, cid, body["row"], body["field"], body.get("code", ""), body.get("name", ""), body.get("user", ""))
        elif op == "review":
            ecs.set_review(doc_id, cid, body["row"], body.get("field"), body["status"], body.get("user", ""))
        else:
            raise HTTPException(404, "알 수 없는 작업")
    except (KeyError, StopIteration, ValueError) as e:
        raise HTTPException(400, f"수정할 항목을 찾지 못했습니다: {e}")
    return {"ok": True}


@app.post("/api/docs/{doc_id}/product")
def product_set(doc_id: str, body: dict = Body(...)):
    check_doc(doc_id)
    return ecs.set_product(doc_id, body, body.get("user", ""))


@app.get("/api/master/template.xlsx")
def master_template():
    return Response(ecs.master_template(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": 'attachment; filename="code_master_template.xlsx"'})


@app.post("/api/master")
async def master_upload(file: UploadFile = File(...)):
    data = await file.read()
    try:
        return ecs.import_master(data)
    except Exception as e:
        raise HTTPException(400, f"코드마스터를 읽지 못했습니다: {e}")


@app.get("/api/docs/{doc_id}/locate")
def locate(doc_id: str, node: str = "", table: str = "", quote: str = ""):
    """근거 인용 위치: 조문(또는 표)의 줄 가운데 인용문이 걸친 줄을 찾아 쪽과 줄 번호를 돌려줍니다."""
    check_doc(doc_id)
    from converter.extract import norm_text
    raw = cached(doc_id, "raw_pages.json")["pages"]
    if table:
        t = next((t for t in cached(doc_id, "tables.json")["tables"] if t["id"] == table), None)
        if not t:
            raise HTTPException(404, "표 없음")
        return {"page": t["page"], "lines": [], "bbox": t["bbox"], "cid": t["cid"]}
    nodes = cached(doc_id, "terms.json")["nodes"]
    if node not in nodes:
        raise HTTPException(404, "조문 없음")
    refs = []

    def collect(nid):
        refs.extend(nodes[nid]["lines"])
        for c in nodes[nid]["children"]:
            collect(c)
    collect(node)
    refs.sort()
    q = norm_text(quote)
    texts = [norm_text(raw[p - 1]["lines"][i]["t"]) for p, i in refs]
    joined, spans, pos = "", [], 0
    for t in texts:
        spans.append((pos, pos + len(t)))
        joined += t
        pos += len(t)
    k = joined.find(q) if q else -1
    if k < 0:
        p0 = refs[0][0] if refs else nodes[node]["page_start"]
        return {"page": p0, "lines": [i for p, i in refs if p == p0][:1], "found": False, "cid": nodes[node]["cid"]}
    hit = [refs[j] for j, (a, b) in enumerate(spans) if a < k + len(q) and b > k]
    page = hit[0][0]
    return {"page": page, "lines": [i for p, i in hit if p == page], "found": True, "cid": nodes[node]["cid"]}


# ---------------------------------------------------------------- 5단계: 구약관 비교

@app.get("/api/docs/{doc_id}/compare")
def compare_view(doc_id: str):
    check_doc(doc_id)
    docs = [d for d in pipeline.list_docs() if d["id"] != doc_id]
    return {"data": compare.load(doc_id), "candidates": docs,
            "approved": pipeline.is_approved(doc_id)}


@app.post("/api/docs/{doc_id}/compare")
def compare_run(doc_id: str, body: dict = Body(...)):
    check_doc(doc_id)
    old = body.get("old_doc", "")
    check_doc(old)
    try:
        return {"data": compare.run(doc_id, old, body.get("user", ""))}
    except PermissionError as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/docs/{doc_id}/compare/match")
def compare_match(doc_id: str, body: dict = Body(...)):
    check_doc(doc_id)
    try:
        return {"data": compare.set_match(doc_id, body["new"], body.get("old") or "", body.get("user", ""))}
    except (KeyError, PermissionError) as e:
        raise HTTPException(400, str(e))


@app.get("/api/docs/{doc_id}/compare.xlsx")
def compare_xlsx(doc_id: str, all: bool = False):
    check_doc(doc_id)
    try:
        data = compare.excel(doc_id, only_changed=not all)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="compare_{doc_id}.xlsx"'})


# ---------------------------------------------------------------- 내보내기

def _cids(cids):
    return [c for c in (cids or "").split(",") if c] or None


@app.get("/api/docs/{doc_id}/export.xlsx")
def export_xlsx(doc_id: str, cids: str = ""):
    check_doc(doc_id)
    data = export.excel(doc_id, _cids(cids))
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="conversion_{doc_id}.xlsx"'})


@app.get("/api/docs/{doc_id}/export.zip")
def export_zip(doc_id: str, cids: str = ""):
    check_doc(doc_id)
    data = export.json_zip(doc_id, _cids(cids))
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="conversion_{doc_id}.zip"'})


@app.exception_handler(Exception)
def on_error(request, exc):
    return JSONResponse({"detail": f"{type(exc).__name__}: {exc}"}, status_code=500)


app.mount("/", StaticFiles(directory=os.path.join(HERE, "static"), html=True), name="static")


def main():
    import uvicorn
    port = int(os.environ.get("PORT", "8765"))
    url = f"http://127.0.0.1:{port}"
    print(f"\n  약관 구조화 도구가 시작되었습니다 → {url}\n  끝내려면 이 창에서 Ctrl+C 를 누르세요.\n")
    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
