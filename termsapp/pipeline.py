"""1단계 변환 전체 흐름과 캐시.

결과 파일(data/<PDF 해시>/):
  terms.json   조문 트리(구간·조각·참조)    tables.json  표(행·열)
  pages.json   PDF 쪽 ↔ 인쇄 쪽번호 매핑     report.json  변환 품질 보고서
  terms.orig.json 수정 전 원본, edits.json 수정 이력, status.json 승인 상태
"""
import datetime
import hashlib
import json
import os
import shutil
import statistics

import pymupdf

from . import extract, quality, refs as refs_mod, structure

CONVERTER_VERSION = "1.0"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def is_cached(out_dir):
    meta = read_json(os.path.join(out_dir, "meta.json"), {})
    return meta.get("version") == CONVERTER_VERSION and os.path.exists(os.path.join(out_dir, "terms.json"))


def _inside(bbox, rect):
    cx = (bbox[0] + bbox[2]) / 2
    cy = (bbox[1] + bbox[3]) / 2
    return rect[0] <= cx <= rect[2] and rect[1] <= cy <= rect[3]


def extract_pages(doc, out_dir, progress):
    """쪽마다 줄·표·OCR을 추출합니다."""
    pages, tables = [], []
    n = doc.page_count
    ocr_ok = extract.tesseract_available()
    os.makedirs(os.path.join(out_dir, "tables"), exist_ok=True)
    for i, page in enumerate(doc):
        pn = i + 1
        progress(stage="쪽별 텍스트·표 추출", done=i, total=n)
        found = extract.extract_tables(page)
        boxes = [t for t in found if t["kind"] == "box"]
        real = [t for t in found if t["kind"] == "table"]
        lines, two_col = extract.page_lines(page, exclude_rects=[t["bbox"] for t in real])
        boxes += extract.drawn_boxes(page, lines, [b["bbox"] for b in boxes] + [t["bbox"] for t in real])
        ratio = extract.image_ratio(page)
        chars = sum(len(l["text"].replace(" ", "")) for l in lines) + sum(
            len("".join(c for r in t["rows"] for c in r)) for t in real)
        ocr_state = ""
        if chars < 20 and ratio > 0.5:
            if ocr_ok:
                lines = extract.ocr_page(page)
                chars = sum(len(l["text"].replace(" ", "")) for l in lines)
                ocr_state = "적용"
            else:
                ocr_state = "필요(미설치)"
        # 표 자리에 표시 줄을 넣고, 해설 상자 안의 줄에 상자 번호를 붙입니다.
        for t in real:
            tid = f"T{len(tables) + 1:04d}"
            t["id"] = tid
            t["page"] = pn
            marker = {"text": f"[표 {tid}]", "bbox": t["bbox"], "size": 0, "font": "", "table": tid,
                      "col": 0 if not two_col or (t["bbox"][0] + t["bbox"][2]) / 2 < page.rect.width / 2 else 1}
            pos = len(lines)
            for k, l in enumerate(lines):
                if (l["col"], l["bbox"][1]) > (marker["col"], t["bbox"][1]):
                    pos = k
                    break
            lines.insert(pos, marker)
            if t["incomplete"] or t.get("rebuilt"):
                img = os.path.join("tables", f"{tid}.png")
                page.get_pixmap(matrix=pymupdf.Matrix(2, 2), clip=pymupdf.Rect(t["bbox"]) + (-6, -6, 6, 6)).save(
                    os.path.join(out_dir, img))
                t["image"] = img
            tables.append(t)
        # 상자가 겹치면 가장 바깥(큰) 상자가 이기도록 작은 것부터 붙입니다.
        boxes.sort(key=lambda b: (b["bbox"][2] - b["bbox"][0]) * (b["bbox"][3] - b["bbox"][1]))
        for k, b in enumerate(boxes):
            for l in lines:
                if _inside(l["bbox"], b["bbox"]):
                    l["box"] = f"p{pn}b{k}"
                    l["box_cont"] = (not b.get("title")) and b["bbox"][1] < page.rect.height * 0.15
        pages.append({"pdf_page": pn, "width": round(page.rect.width, 1), "height": round(page.rect.height, 1),
                      "lines": lines, "chars": chars, "image_ratio": round(ratio, 3), "two_column": two_col,
                      "ocr": ocr_state, "boxes": [b["bbox"] for b in boxes]})
    progress(stage="쪽별 텍스트·표 추출", done=n, total=n)
    return pages, tables


def structure_doc(pages, tables, bookmarks, progress):
    progress(stage="머리글·바닥글 제거", done=0, total=1)
    extract.strip_headers_footers(pages)
    sizes = [l["size"] for p in pages for l in p["lines"] if l.get("size")]
    body = statistics.median(sizes) if sizes else 10
    for p in pages:
        for l in p["lines"]:
            l["big"] = bool(l.get("size")) and l["size"] >= body + 1.5
    progress(stage="목차·구간 인식", done=0, total=1)
    sections, toc_source, toc_pages = structure.build_sections(pages, bookmarks)
    style = structure.detect_article_style(pages)
    nodes = []
    for k, s in enumerate(sections):
        progress(stage="조·항·호 분해", done=k, total=len(sections))
        s["toc_pages"] = structure.section_toc_pages(pages, s) if s["kind"] == "terms" else []
        skip = set(s["toc_pages"]) | set(toc_pages)
        if s["kind"] == "terms":
            nodes += structure.parse_section(pages, s, style, skip)
        else:
            # 부속 자료(색인·요약서·인용조문 등)는 조문으로 나누지 않고 쪽 단위 텍스트로 둡니다.
            for pn in range(s["page_start"], s["page_end"] + 1):
                b = structure.Builder(s, style)
                b.counter = pn * 10
                node = b.new("page_text", None, label=f"{pn}쪽")
                for l in pages[pn - 1]["lines"]:
                    b.add_line(node, dict(l, p=pn), l["text"])
                if node["lines"]:
                    nodes.append(node)
    for p in pages:
        p["section"] = next((s["id"] for s in sections if s["page_start"] <= p["pdf_page"] <= s["page_end"]), "")
        p["is_toc"] = p["pdf_page"] in toc_pages or any(p["pdf_page"] in s.get("toc_pages", []) for s in sections)
    return {"sections": sections, "nodes": nodes, "toc_source": toc_source, "toc_pages": toc_pages,
            "article_style": style}


def finalize(terms, pages, tables):
    """ID·참조·품질 보고서를 다시 계산합니다(수정 후에도 호출)."""
    nodes = terms["nodes"]
    structure.relink(nodes)
    structure.assign_ids(nodes)
    for t in tables:
        t["node"] = next((n["cid"] for n in nodes if f"[표 {t['id']}]" in n["text"]), "")
        t["section"] = next((p["section"] for p in pages if p["pdf_page"] == t["page"]), "")
    terms["refs"] = refs_mod.link_refs(terms["sections"], nodes)
    return quality.build_report(terms["sections"], pages, nodes, tables, terms["refs"])


def convert(pdf_path, out_dir, filename="", progress=lambda **k: None):
    os.makedirs(out_dir, exist_ok=True)
    doc = pymupdf.open(pdf_path)
    pages, tables = extract_pages(doc, out_dir, progress)
    terms = structure_doc(pages, tables, doc.get_toc(), progress)
    progress(stage="참조 연결·품질 점검", done=0, total=1)
    report = finalize(terms, pages, tables)
    terms["doc"] = {"filename": filename, "pages": doc.page_count}
    progress(stage="저장", done=0, total=1)
    page_meta = [{k: v for k, v in p.items() if k != "lines"} for p in pages]
    write_json(os.path.join(out_dir, "pages.json"), page_meta)
    write_json(os.path.join(out_dir, "tables.json"), tables)
    write_json(os.path.join(out_dir, "terms.json"), terms)
    shutil.copyfile(os.path.join(out_dir, "terms.json"), os.path.join(out_dir, "terms.orig.json"))
    write_json(os.path.join(out_dir, "report.json"), report)
    write_json(os.path.join(out_dir, "edits.json"), [])
    write_json(os.path.join(out_dir, "status.json"), {"approved": False, "history": []})
    write_json(os.path.join(out_dir, "meta.json"), {"version": CONVERTER_VERSION, "filename": filename,
                                                    "pages": doc.page_count, "converted_at": now()})
    progress(stage="완료", done=1, total=1)
    return report
