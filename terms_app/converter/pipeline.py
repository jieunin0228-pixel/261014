"""변환 파이프라인과 로컬 저장소.

data/<문서ID>/ 아래에 모든 결과를 저장합니다(외부 전송 없음).
- source.pdf, meta.json
- raw_pages.json      쪽별 추출 원자료(줄 좌표·머리글·꼬리글·표 격자) — 같은 PDF는 재사용
- pages.json          쪽 매핑(쪽 → 담보, 배정 근거, 불일치 여부)
- coverage_map.json   담보 - 쪽범위 - 조문 - 별표 - 표 - 분석 입력 구성
- terms.json          조문 트리(조·항·호·목, 별표, 설명상자)
- tables.json         표(행·열 격자, 병합 칸, 불완전 표시)
- report.json         변환 품질 보고서
- edits.json          사용자 수정 지시문(되돌리기 가능), history.json 수정 이력
- reviews.json        담보별 검토 상태, approval.json 변환 승인 상태
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import shutil
import threading
import traceback
import uuid

import pymupdf

from . import extract, structure

PIPELINE_VERSION = "1.1"
ROOT = os.environ.get("TERMS_DATA_DIR") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")

_locks = {}
_jobs = {}
_glock = threading.Lock()


def now():
    return dt.datetime.now().isoformat(timespec="seconds")


def doc_dir(doc_id):
    return os.path.join(ROOT, doc_id)


def lock_for(doc_id):
    with _glock:
        return _locks.setdefault(doc_id, threading.RLock())


def read_json(doc_id, name, default=None):
    p = os.path.join(doc_dir(doc_id), name)
    if not os.path.exists(p):
        return default
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def write_json(doc_id, name, data):
    d = doc_dir(doc_id)
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, os.path.join(d, name))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def list_docs():
    out = []
    if not os.path.isdir(ROOT):
        return out
    for d in sorted(os.listdir(ROOT)):
        meta = read_json(d, "meta.json")
        if not meta:
            continue
        appr = read_json(d, "approval.json", {}) or {}
        rep = read_json(d, "report.json")
        out.append({"id": d, "filename": meta.get("filename"), "page_count": meta.get("page_count"),
                    "created": meta.get("created"), "converted": bool(rep), "approved": bool(appr.get("approved")),
                    "version": meta.get("version")})
    return out


# ---------------------------------------------------------------- 작업(진행률)

def job_status(job_id):
    return _jobs.get(job_id)


def _set(job, stage, frac, msg=""):
    job.update({"stage": stage, "frac": round(frac, 3), "msg": msg, "updated": now()})


def start_conversion(upload_path, filename, force=False):
    """업로드된 PDF를 저장소에 넣고 변환 작업을 시작합니다. 같은 PDF는 캐시를 씁니다."""
    os.makedirs(ROOT, exist_ok=True)
    digest = sha256_file(upload_path)
    doc_id = digest[:16]
    d = doc_dir(doc_id)
    os.makedirs(d, exist_ok=True)
    src = os.path.join(d, "source.pdf")
    if not os.path.exists(src):
        shutil.move(upload_path, src)
    elif os.path.abspath(upload_path) != os.path.abspath(src):
        try:
            os.remove(upload_path)
        except OSError:
            pass
    meta = read_json(doc_id, "meta.json") or {}
    meta.setdefault("filename", filename)
    meta.setdefault("created", now())
    meta["sha256"] = digest
    write_json(doc_id, "meta.json", meta)
    job_id = uuid.uuid4().hex[:12]
    job = {"id": job_id, "doc_id": doc_id, "done": False, "error": None, "cached": False}
    _jobs[job_id] = job
    cached = (not force and meta.get("version") == PIPELINE_VERSION and
              os.path.exists(os.path.join(d, "raw_pages.json")) and os.path.exists(os.path.join(d, "report.json")))
    if cached:
        job.update({"done": True, "cached": True, "stage": "캐시 사용", "frac": 1.0, "msg": "같은 PDF의 이전 변환 결과를 사용합니다."})
        return job
    t = threading.Thread(target=_run, args=(job, doc_id, force), daemon=True)
    t.start()
    return job


def _run(job, doc_id, force):
    try:
        with lock_for(doc_id):
            d = doc_dir(doc_id)
            src = os.path.join(d, "source.pdf")
            meta = read_json(doc_id, "meta.json")
            raw = None if force else read_json(doc_id, "raw_pages.json")
            if raw is None or meta.get("version") != PIPELINE_VERSION:
                pages, pmeta = extract.extract_pdf(src, progress=lambda s, f, m: _set(job, s, 0.85 * f, m))
                _set(job, "불완전 표 쪽 이미지 저장", 0.86)
                _save_table_images(doc_id, src, pages)
                raw = {"pages": pages, "meta": pmeta}
                write_json(doc_id, "raw_pages.json", raw)
            _set(job, "목차·머리글 대조, 조문 구조화, 참조 연결", 0.9)
            rebuild(doc_id, raw=raw)
            meta = read_json(doc_id, "meta.json")
            meta["version"] = PIPELINE_VERSION
            meta["page_count"] = raw["meta"]["page_count"]
            meta["converted"] = now()
            write_json(doc_id, "meta.json", meta)
            _set(job, "완료", 1.0)
            job["done"] = True
    except Exception as e:  # 변환 실패는 화면에 그대로 보고합니다.
        job["error"] = f"{type(e).__name__}: {e}"
        job["trace"] = traceback.format_exc()
        job["done"] = True


def _save_table_images(doc_id, src, pages):
    bad = [(pg["p"], t) for pg in pages for t in pg["tables"] if t["kind"] == "table" and not t["complete"]]
    if not bad:
        return
    img_dir = os.path.join(doc_dir(doc_id), "images")
    os.makedirs(img_dir, exist_ok=True)
    doc = pymupdf.open(src)
    done = {}
    for p, t in bad:
        name = f"table_p{p:04d}.png"
        if p not in done:
            pix = doc[p - 1].get_pixmap(matrix=pymupdf.Matrix(2, 2))
            pix.save(os.path.join(img_dir, name))
            done[p] = name
        t["image"] = "images/" + name
    doc.close()


# ---------------------------------------------------------------- 구조 재계산(수정 반영)

def rebuild(doc_id, raw=None):
    raw = raw or read_json(doc_id, "raw_pages.json")
    edits = read_json(doc_id, "edits.json", []) or []
    res = structure.build(raw["pages"], raw["meta"], edits)
    meta = read_json(doc_id, "meta.json") or {}
    nodes = res["nodes"]
    covs = res["coverages"]
    write_json(doc_id, "coverage_map.json", {
        "doc": {"id": doc_id, "filename": meta.get("filename"), "page_count": raw["meta"]["page_count"]},
        "toc": res["toc"], "offset": res["offset"], "heading_x": res["heading_x"],
        "coverages": covs,
    })
    write_json(doc_id, "terms.json", {"nodes": nodes, "orders": res["cov_orders"], "refs": res["refs"],
                                      "line_owner": res["line_owner"]})
    write_json(doc_id, "tables.json", {"tables": res["tables"]})
    pages_map = []
    for r, pg in zip(res["page_rows"], raw["pages"]):
        pages_map.append({**r, "printed": pg["printed"], "chars": pg["chars"], "low_text": pg["low_text"],
                          "scanned": pg["scanned"], "ocr": pg["ocr"], "internal_toc": pg["p"] in res["toc_internal"],
                          "w": pg["w"], "h": pg["h"]})
    write_json(doc_id, "pages.json", {"pages": pages_map})
    write_json(doc_id, "report.json", res["report"])
    return res


# ---------------------------------------------------------------- 수정·검토·승인

def add_edit(doc_id, edit, user=""):
    with lock_for(doc_id):
        edits = read_json(doc_id, "edits.json", []) or []
        edit = dict(edit)
        edit["eid"] = uuid.uuid4().hex[:8]
        edit["at"] = now()
        edit["user"] = user
        edit["active"] = True
        edits.append(edit)
        write_json(doc_id, "edits.json", edits)
        _history(doc_id, "수정", edit, user)
        _touch_after_edit(doc_id, edit.get("cid"), user)
        return rebuild(doc_id)


def undo_edit(doc_id, eid, user=""):
    with lock_for(doc_id):
        edits = read_json(doc_id, "edits.json", []) or []
        hit = None
        for e in edits:
            if e["eid"] == eid and e.get("active", True):
                e["active"] = False
                e["undone_at"] = now()
                hit = e
        if not hit:
            raise KeyError(eid)
        write_json(doc_id, "edits.json", edits)
        _history(doc_id, "되돌리기", hit, user)
        _touch_after_edit(doc_id, hit.get("cid"), user)
        return rebuild(doc_id)


def _history(doc_id, what, data, user):
    h = read_json(doc_id, "history.json", []) or []
    h.append({"at": now(), "user": user, "what": what, "data": data})
    write_json(doc_id, "history.json", h)


def _touch_after_edit(doc_id, cid, user):
    """수정이 생기면 해당 담보의 검토 상태를 미검토로 돌리고, 변환 승인을 해제합니다."""
    if cid:
        rv = read_json(doc_id, "reviews.json", {}) or {}
        if rv.get(cid, {}).get("status") == "검토완료":
            rv[cid] = {"status": "미검토", "at": now(), "user": user, "note": "수정으로 검토 상태 초기화"}
            write_json(doc_id, "reviews.json", rv)
    appr = read_json(doc_id, "approval.json", {}) or {}
    if appr.get("approved"):
        appr.update({"approved": False, "revoked_at": now(), "revoked_reason": "승인 후 수정이 발생함"})
        write_json(doc_id, "approval.json", appr)
        _history(doc_id, "승인 자동 해제", {"reason": "승인 후 수정"}, user)


def set_review(doc_id, cid, status, user=""):
    if status not in ("미검토", "검토완료"):
        raise ValueError(status)
    with lock_for(doc_id):
        rv = read_json(doc_id, "reviews.json", {}) or {}
        rv[cid] = {"status": status, "at": now(), "user": user}
        write_json(doc_id, "reviews.json", rv)
        _history(doc_id, "검토 상태", {"cid": cid, "status": status}, user)
        return rv


def set_approval(doc_id, approved, user=""):
    with lock_for(doc_id):
        appr = read_json(doc_id, "approval.json", {}) or {}
        if approved:
            rep = read_json(doc_id, "report.json") or {}
            appr = {"approved": True, "at": now(), "user": user,
                    "snapshot": {"edits": len([e for e in (read_json(doc_id, "edits.json", []) or []) if e.get("active", True)]),
                                 "toc_count": rep.get("toc_count")}}
        else:
            appr.update({"approved": False, "revoked_at": now(), "revoked_reason": "사용자 승인 취소"})
        write_json(doc_id, "approval.json", appr)
        _history(doc_id, "변환 승인" if approved else "승인 취소", {}, user)
        return appr


def is_approved(doc_id):
    """2단계 이후(AI 해석)는 이 값이 True일 때만 실행해야 합니다."""
    return bool((read_json(doc_id, "approval.json", {}) or {}).get("approved"))


def render_page(doc_id, pno, scale=1.5):
    scale = max(0.5, min(3.0, float(scale)))
    cache = os.path.join(doc_dir(doc_id), "render")
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f"p{pno:04d}_{int(scale * 100)}.png")
    if not os.path.exists(path):
        doc = pymupdf.open(os.path.join(doc_dir(doc_id), "source.pdf"))
        pix = doc[pno - 1].get_pixmap(matrix=pymupdf.Matrix(scale, scale))
        pix.save(path)
        doc.close()
    return path
