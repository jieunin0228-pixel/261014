"""변환 품질 보고서: 저텍스트 쪽, 조문·항·호 번호 연속성, 참조 미해결, 표 추출 불완전, OCR 저신뢰."""
import re

from .structure import HANGUL_ITEMS

LOW_TEXT_CHARS = 50
OCR_LOW_CONF = 70


def _split_num(num):
    """'2-1의3' → ('2', 1, 3), '12' → ('', 12, 0)"""
    m = re.match(r"^(?:(\d+)-)?(\d+)(?:의(\d+))?$", num)
    if not m:
        return None
    return (m.group(1) or "", int(m.group(2)), int(m.group(3) or 0))


def build_report(sections, pages, nodes, tables, refs):
    sec_by_id = {s["id"]: s for s in sections}
    children = {}
    for n in nodes:
        children.setdefault(n["parent"], []).append(n)

    low_text = []
    for p in pages:
        # 글자가 거의 없거나, 이미지가 큰데 글자가 적은 쪽(스캔 의심)을 경고합니다.
        if p["chars"] < 20 or (p["chars"] < LOW_TEXT_CHARS * 2 and p["image_ratio"] > 0.3):
            low_text.append({"page": p["pdf_page"], "chars": p["chars"], "image_ratio": p["image_ratio"],
                             "message": f"추출 글자 {p['chars']}자, 이미지 비율 {p['image_ratio']:.0%}"
                                        + (" — 스캔 쪽일 수 있음" if p["image_ratio"] > 0.5 else "")})

    article_gaps = []
    for s in sections:
        if s["kind"] != "terms":
            continue
        arts = [n for n in nodes if n["section"] == s["id"] and n["kind"] == "article"]
        last = {}
        for a in arts:
            k = _split_num(a["num"])
            if not k:
                continue
            series, main, sub = k
            if sub:
                continue
            prev = last.get(series)
            label = lambda x: f"제{series + '-' if series else ''}{x}조"
            if prev is None:
                if main != 1:
                    article_gaps.append({"page": a["own_page_start"], "section": s["title"], "id": a["cid"],
                                         "message": f"{s['title']}: 첫 조문이 {label(main)}입니다(제1조부터 시작하지 않음)"})
            elif main == prev:
                article_gaps.append({"page": a["own_page_start"], "section": s["title"], "id": a["cid"],
                                     "message": f"{s['title']}: {label(main)}가 중복됩니다"})
            elif main != prev + 1:
                article_gaps.append({"page": a["own_page_start"], "section": s["title"], "id": a["cid"],
                                     "message": f"{s['title']}: {label(prev)} 다음에 {label(main)}가 나옵니다"
                                                + (f"(빠진 번호 {main - prev - 1}개)" if main > prev else "(번호가 거꾸로 감)")})
            last[series] = main
        if not arts:
            article_gaps.append({"page": s["page_start"], "section": s["title"], "id": s["id"],
                                 "message": f"{s['title']}: 조문을 하나도 찾지 못했습니다"})

    sub_gaps = []
    for parent_uid, kids in children.items():
        for kind, name in (("paragraph", "항"), ("item", "호"), ("subitem", "목")):
            seq = [k for k in kids if k["kind"] == kind]
            if not seq:
                continue
            nums = []
            for k in seq:
                if kind == "subitem":
                    nums.append(HANGUL_ITEMS.index(k["num"]) + 1 if k["num"] in HANGUL_ITEMS else 0)
                else:
                    nums.append(int(k["num"]))
            expect = 1
            for k, v in zip(seq, nums):
                if v != expect:
                    owner = k["cid"].rsplit("-", 1)[0]
                    msg = (f"{owner}: {name} 번호 {k['label']}가 중복됩니다" if v < expect
                           else f"{owner}: {name} 번호가 {expect}번이 아닌 {k['label']}로 이어집니다")
                    sub_gaps.append({"page": k["own_page_start"], "id": k["cid"], "message": msg})
                expect = v + 1

    dups = [{"page": n["own_page_start"], "id": n["cid"], "message": f"같은 ID가 다시 나옵니다: {n['cid']}"}
            for n in nodes if n.get("dup")]

    unresolved = [{"page": r["page"], "id": r["from"], "message": f"{r['from']}의 \"{r['text']}\" — {r['note']}"}
                  for r in refs if r["status"] == "미해결"]

    note_unresolved = [{"page": r["page"], "id": r["from"], "message": f"{r['from']}의 \"{r['text']}\" — {r['note']}"}
                       for r in refs if r["status"] == "해설내미해결"]

    bad_tables = [{"page": t["page"], "id": t["id"],
                   "message": f"{t['id']}({t['page']}쪽): " + ", ".join(t["reasons"])}
                  for t in tables if t["incomplete"]]

    rebuilt = [{"page": t["page"], "id": t["id"],
                "message": f"{t['id']}({t['page']}쪽): 세로선이 없어 글자 위치로 칸을 다시 나눈 표입니다. 원본 이미지와 대조하십시오"}
               for t in tables if t.get("rebuilt") and not t["incomplete"]]

    ocr_low = []
    for n in nodes:
        confs = n.get("ocr_conf")
        if confs and min(confs) < OCR_LOW_CONF:
            ocr_low.append({"page": n["own_page_start"], "id": n["cid"],
                            "message": f"{n['cid']}: OCR 신뢰도 최저 {min(confs):.0f}"})
    for p in pages:
        if p.get("ocr") == "필요(미설치)":
            ocr_low.append({"page": p["pdf_page"], "id": "", "message": f"{p['pdf_page']}쪽: 스캔 쪽이지만 OCR(Tesseract)이 설치되어 있지 않아 글자를 읽지 못했습니다"})

    groups = [
        ("low_text", "텍스트가 거의 없는 쪽", low_text),
        ("article_gaps", "조문 번호 연속성", article_gaps),
        ("sub_gaps", "항·호·목 번호 끊김·중복", sub_gaps),
        ("dup_ids", "중복 ID", dups),
        ("unresolved", "참조 미해결", unresolved),
        ("note_unresolved", "참조 미해결(해설 상자 안, 법령 인용 등)", note_unresolved),
        ("bad_tables", "표 추출 불완전", bad_tables),
        ("rebuilt_tables", "표 재구성(원본 대조 권장)", rebuilt),
        ("ocr_low", "OCR 저신뢰 구간", ocr_low),
    ]
    stats = {
        "pages": len(pages),
        "sections": len(sections),
        "articles": sum(1 for n in nodes if n["kind"] == "article"),
        "paragraphs": sum(1 for n in nodes if n["kind"] == "paragraph"),
        "items": sum(1 for n in nodes if n["kind"] == "item"),
        "subitems": sum(1 for n in nodes if n["kind"] == "subitem"),
        "appendices": sum(1 for n in nodes if n["kind"] == "appendix"),
        "notes": sum(1 for n in nodes if n["kind"] == "note"),
        "tables": len(tables),
        "refs": len(refs),
        "refs_linked": sum(1 for r in refs if r["status"] == "연결"),
        "refs_law": sum(1 for r in refs if r["status"] == "법령"),
    }
    return {"stats": stats,
            "groups": [{"key": k, "title": t, "count": len(v), "items": v} for k, t, v in groups]}
