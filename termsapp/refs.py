"""본문 속 참조 표현(제○조, 별표 ○, 앞 항, 다음 각 호)을 찾아 조문 ID와 연결합니다."""
import re

from .structure import CIRCLED, norm_art_num

RE_ART_REF = re.compile(
    r"제\s*(\d+(?:\s*-\s*\d+)?)\s*조(?:\s*의\s*(\d+))?"
    r"(?:\s*[(（][^)）]{0,60}[)）])?"
    r"(?:\s*제\s*(\d+)\s*항)?(?:\s*제\s*(\d+)\s*호)?")
RE_PARA_REF = re.compile(r"제\s*(\d+)\s*항(?:\s*제\s*(\d+)\s*호)?")
RE_ITEM_REF = re.compile(r"제\s*(\d+)\s*호")
RE_APPX_REF = re.compile(r"별\s*표\s*(\d+(?:\s*-\s*\d+)?)")
RE_PREV_PARA = re.compile(r"(앞\s*항|전\s*항|앞의\s*항)")
RE_FOLLOW = re.compile(r"(다음|아래)\s*(?:의\s*)?(?:각\s*)?(?:어느\s*하나의?\s*)?(호|목|항)")
LAW_TAIL = re.compile(r"(」|법|령|규칙|규정|법률|같은\s*법|동법|시행령)\s*$")


def _is_law(text, start):
    before = text[max(0, start - 12):start]
    return bool(LAW_TAIL.search(before))


def link_refs(sections, nodes):
    by_uid = {n["uid"]: n for n in nodes}
    children = {}
    for n in nodes:
        children.setdefault(n["parent"], []).append(n)
    arts = {}       # (section, num) -> node
    arts_any = {}   # num -> [node]
    appx = {}
    appx_any = {}
    for n in nodes:
        if n["kind"] == "article":
            arts.setdefault((n["section"], n["num"]), n)
            arts_any.setdefault(n["num"], []).append(n)
        elif n["kind"] == "appendix":
            appx.setdefault((n["section"], n["num"]), n)
            appx_any.setdefault(n["num"], []).append(n)
    main_sections = [s["id"] for s in sections if s["kind"] == "terms"]

    def article_of(n):
        while n is not None and n["kind"] not in ("article", "appendix"):
            n = by_uid.get(n["parent"]) if n["parent"] else None
        return n

    def find_article(sec, num, text_before):
        if (sec, num) in arts:
            return arts[(sec, num)]
        cands = arts_any.get(num, [])
        if "주계약" in text_before[-20:] and main_sections:
            for c in cands:
                if c["section"] == main_sections[0] or c["section"] == main_sections[min(1, len(main_sections) - 1)]:
                    return c
        if len(cands) == 1:
            return cands[0]
        # '1-N' 번호는 특약 공통(일반사항) 조문이므로 그 번호를 가진 첫 조문을 씁니다.
        if "-" in num and cands:
            return cands[0]
        return None

    def child_by_num(parent, kind, num):
        for c in children.get(parent["uid"], []):
            if c["kind"] == kind and c["num"] == str(num):
                return c
        if kind == "item" and parent["kind"] == "article":
            # '제1-5조 제2호'처럼 항을 건너뛴 표현: 항 아래의 호 중 하나뿐이면 그것으로 봅니다.
            found = [c for p in children.get(parent["uid"], []) if p["kind"] == "paragraph"
                     for c in children.get(p["uid"], []) if c["kind"] == "item" and c["num"] == str(num)]
            if len(found) == 1:
                return found[0]
        return None

    refs = []
    terms_sections = {s["id"] for s in sections if s["kind"] == "terms"}
    for n in nodes:
        text = n["text"]
        if not text or n["kind"] in ("preamble", "page_text") or n["section"] not in terms_sections:
            continue
        in_note = n["kind"] == "note"
        if n["kind"] in ("article", "appendix", "part", "chapter", "section"):
            text = text.split("\n", 1)[1] if "\n" in text else ""  # 제목 줄은 참조가 아닙니다.
        flat = text.replace("\n", "")
        taken = []

        def add(m, kind, target, status, note=""):
            if status == "미해결" and in_note:
                status = "해설내미해결"  # 해설 상자는 법령 원문 인용이 많아 따로 모읍니다.
            refs.append({"from": n["cid"], "from_uid": n["uid"], "text": m.group(0).strip(), "kind": kind,
                         "target": target, "status": status, "note": note, "page": n["own_page_start"]})
            taken.append((m.start(), m.end()))

        for m in RE_ART_REF.finditer(flat):
            if _is_law(flat, m.start()):
                add(m, "법령", None, "법령")
                continue
            num = norm_art_num(m.group(1)) + (f"의{m.group(2)}" if m.group(2) else "")
            art = find_article(n["section"], num, flat[:m.start()])
            if art is None:
                add(m, "조", None, "미해결", f"제{num}조를 찾지 못함")
                continue
            target = art
            if m.group(3):
                p = child_by_num(art, "paragraph", m.group(3))
                if p is None:
                    add(m, "항", None, "미해결", f"{art['cid']}에 제{m.group(3)}항 없음")
                    continue
                target = p
            if m.group(4):
                it = child_by_num(target, "item", m.group(4))
                if it is None:
                    add(m, "호", None, "미해결", f"{target['cid']}에 제{m.group(4)}호 없음")
                    continue
                target = it
            add(m, "조", [target["cid"]], "연결")

        def free(m):
            return not any(a <= m.start() < b for a, b in taken)

        art = article_of(n)
        for m in RE_PARA_REF.finditer(flat):
            if not free(m):
                continue
            if _is_law(flat, m.start()) or art is None or art["kind"] != "article":
                add(m, "항", None, "법령" if _is_law(flat, m.start()) else "미해결", "같은 조문을 정할 수 없음")
                continue
            p = child_by_num(art, "paragraph", m.group(1))
            if p is None:
                add(m, "항", None, "미해결", f"{art['cid']}에 제{m.group(1)}항 없음")
                continue
            if m.group(2):
                it = child_by_num(p, "item", m.group(2))
                if it is None:
                    add(m, "호", None, "미해결", f"{p['cid']}에 제{m.group(2)}호 없음")
                    continue
                p = it
            add(m, "항", [p["cid"]], "연결")
        for m in RE_ITEM_REF.finditer(flat):
            if not free(m):
                continue
            if _is_law(flat, m.start()):
                add(m, "호", None, "법령")
                continue
            holder = n if n["kind"] in ("article", "paragraph") else by_uid.get(n["parent"]) if n["parent"] else None
            it = child_by_num(holder, "item", m.group(1)) if holder else None
            if it is None and art is not None:
                it = child_by_num(art, "item", m.group(1))
            if it is None:
                add(m, "호", None, "미해결", f"제{m.group(1)}호를 찾지 못함")
            else:
                add(m, "호", [it["cid"]], "연결")
        for m in RE_APPX_REF.finditer(flat):
            if not free(m) or n["kind"] == "appendix" and m.start() < 8:
                continue
            num = norm_art_num(m.group(1))
            t = appx.get((n["section"], num))
            if t is None and len(appx_any.get(num, [])) == 1:
                t = appx_any[num][0]
            if t is None and "-" in num and appx_any.get(num):
                t = appx_any[num][0]
            if t is None:
                add(m, "별표", None, "미해결", f"별표{num}을 찾지 못함")
            else:
                add(m, "별표", [t["cid"]], "연결")
        for m in (RE_PREV_PARA.finditer(flat) if n["kind"] != "note" else []):
            para = n if n["kind"] == "paragraph" else None
            p = n
            while p is not None and p["kind"] != "paragraph":
                p = by_uid.get(p["parent"]) if p["parent"] else None
            para = p
            target = None
            if para is not None:
                sibs = [c for c in children.get(para["parent"], []) if c["kind"] == "paragraph"]
                k = sibs.index(para)
                if k > 0:
                    target = sibs[k - 1]
            if target is None:
                add(m, "앞 항", None, "미해결", "앞 항이 없음")
            else:
                add(m, "앞 항", [target["cid"]], "연결")
        for m in (RE_FOLLOW.finditer(flat) if n["kind"] not in ("appendix", "note") else []):
            want = {"호": "item", "목": "subitem", "항": "paragraph"}[m.group(2)]
            kids = [c for c in children.get(n["uid"], []) if c["kind"] == want]
            if not kids and n["kind"] in ("item",) and want == "subitem":
                kids = []
            if not kids:
                add(m, f"다음 각 {m.group(2)}", None, "미해결", f"이 조각 아래에 {m.group(2)}가 없음")
            else:
                add(m, f"다음 각 {m.group(2)}", [k["cid"] for k in kids], "연결")
    return refs
