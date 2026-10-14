"""2단계: 승인된 조문 트리에서 담보(급부)를 찾아 대·중·소 분류 트리로 정리합니다.

AI를 쓰지 않습니다. 담보는 특약별 '보험금 지급기준표' 별표의 급부명 행에서 찾고,
표가 없는 특약은 특약 하나를 담보 하나로 둡니다.

분류
 - 대분류(고정): 사망·장해·진단·입원·치료·기타 — 급부명, 없으면 지급사유의 낱말로 정합니다.
 - 중분류: 목차의 특약명에서 읽은 질환·사고군(암, 뇌혈관질환, 심장질환, 재해, 질병, 기타)
 - 소분류: 목차의 특약명(구간 제목)
"""
import re

MAJORS = ["사망", "장해", "진단", "입원", "치료", "기타"]

# (낱말, 대분류) — 앞에 있을수록 먼저 판단합니다.
MAJOR_RULES = [
    ("납입면제", "기타"), ("사망", "사망"), ("장해", "장해"), ("입원", "입원"), ("간병", "입원"),
    ("수술", "치료"), ("통원", "치료"), ("내원", "치료"), ("치료", "치료"), ("약물", "치료"),
    ("방사선", "치료"), ("검사", "치료"), ("조영술", "치료"), ("혈전", "치료"), ("산정특례", "진단"),
    ("진단", "진단"),
]
MIDDLE_RULES = [
    ("암", "암"), ("신생물", "암"), ("뇌", "뇌혈관질환"), ("심장", "심장질환"), ("심근", "심장질환"),
    ("허혈", "심장질환"), ("관상동맥", "심장질환"), ("대동맥", "심장질환"), ("판막", "심장질환"),
    ("순환계", "심장질환"), ("재해", "재해"), ("상해", "재해"), ("골절", "재해"), ("질병", "질병"),
]
REASON_HINT = re.compile(r"(피보험자|때|경우|진단|확정)")
ART_TAG = re.compile(r"\(\s*제\s*[\d\-]+\s*조[^)]*\)")


def clean_name(text):
    """표 칸의 줄바꿈을 합치고 '(제2-2조)' 같은 조문 표시를 뗍니다."""
    parts = [p.strip() for p in str(text).split("\n") if p.strip()]
    out = ""
    for p in parts:
        if out and re.match(r"[가-힣ⅠⅡⅢⅣ]", p) and re.search(r"[가-힣)]$", out):
            out += p
        else:
            out = (out + " " + p).strip()
    out = ART_TAG.sub("", out)
    return re.sub(r"\s+", " ", out).strip()


def join_text(text):
    return re.sub(r"\s*\n\s*", " ", str(text)).strip()


def _batchim(word):
    c = word[-1]
    return "가" <= c <= "힣" and (ord(c) - 0xAC00) % 28 != 0


def euro(word):
    """'으로/로' 조사"""
    last_rieul = "가" <= word[-1] <= "힣" and (ord(word[-1]) - 0xAC00) % 28 == 8
    return word + ("으로" if _batchim(word) and not last_rieul else "로")


def iga(word):
    return word + ("이" if _batchim(word) else "가")


def classify_major(name, reason, what="급부명"):
    for word, major in MAJOR_RULES:
        if word in name:
            return major, f"{what}에 '{word}'{'이' if _batchim(word) else '가'} 있어 {euro(major)} 분류했습니다."
    for word, major in MAJOR_RULES:
        if word in reason:
            return major, f"{what}으로는 정할 수 없어 지급사유의 '{word}' 낱말로 {euro(major)} 분류했습니다."
    return "기타", f"{what}과 지급사유에 사망·장해·진단·입원·치료를 가리키는 낱말이 없어 기타로 분류했습니다."


def classify_middle(title):
    for word, mid in MIDDLE_RULES:
        if word in title:
            return mid
    return "기타"


def short_title(title):
    t = re.sub(r"^R?\(무\)", "", title)
    t = re.sub(r"\((갱신형|간편심사형)\)", "", t)
    return t.strip() or title


def benefits_from_table(rows):
    """지급기준표에서 급부(급부 그룹, 급부명, 지급사유, 지급금액)를 읽습니다.

    표 칸이 글자 줄마다 여러 행으로 쪼개져 있으므로 열 단위로 읽습니다.
     1) '피보험자' 문장이 가장 많은 열을 지급사유 열로 정합니다.
     2) 지급사유가 시작되는 행마다 급부 하나가 시작되고, 다음 지급사유 행 직전까지가 그 급부의 행입니다.
     3) 지급사유 열 왼쪽의 글자는 급부명(맨 왼쪽 열은 급부 그룹), 오른쪽 글자는 지급금액입니다.
    """
    if not rows:
        return []
    head = " ".join(join_text(c) for c in rows[0])
    body = [[str(c) for c in r] for r in (rows[1:] if ("급부" in head or "지급사유" in head) else rows)]
    # 하위 표가 이어 붙은 경우의 반복 머리줄과 '나. 2종 보장계약' 같은 소제목 줄은 뺍니다.
    def keep(r):
        j = " ".join(join_text(c) for c in r)
        if "급부명" in j and "지급사유" in j:
            return False
        filled = [c for c in r if c.strip()]
        if len(filled) == 1 and re.match(r"^[가-하]\.\s", filled[0].strip()):
            return False
        return not (j.strip().endswith("보장계약") and len(j.strip()) < 40 and "피보험자" not in j)
    body = [r for r in body if keep(r)]
    if not body:
        return []
    ncol = max(len(r) for r in body)
    body = [r + [""] * (ncol - len(r)) for r in body]
    score = [sum(1 for r in body if "피보험자" in r[c]) for c in range(ncol)]
    rc = max(range(ncol), key=lambda c: (score[c], -c))
    if score[rc] == 0:
        return []
    # 지급사유 칸이 '피보험자'로 시작하는 행이 새 급부의 시작입니다(칸 중간의 '또는 피보험자가'는 아님).
    starts = [k for k, r in enumerate(body) if r[rc].strip().startswith("피보험자")]
    if not starts:
        return []
    name_cols = [c for c in range(rc) if any(r[c].strip() for r in body)]
    amt_cols = [c for c in range(rc + 1, ncol) if any(r[c].strip() for r in body)]
    # 지급사유 열 바로 왼쪽(가장 오른쪽) 칸이 하위 급부명, 그 왼쪽 칸들은 급부 그룹입니다.
    sub_cols = name_cols[-1:]
    group_cols = name_cols[:-1]
    group_col = group_cols[0] if group_cols else None
    group = clean_name("\n".join(r[c] for r in body for c in group_cols if r[c].strip()))
    out = []
    for i, st in enumerate(starts):
        a = 0 if i == 0 else st
        b = starts[i + 1] if i + 1 < len(starts) else len(body)
        block = body[a:b]
        name = clean_name("\n".join(r[c] for r in block for c in sub_cols if r[c].strip()))
        if not name and group_col is None and len(starts) > 1:
            name = clean_name("\n".join(r[c] for r in body for c in sub_cols if r[c].strip()))
        reason = join_text(" ".join(r[rc] for r in body[st:b] if r[rc].strip()))
        amount = " / ".join(" ".join(join_text(r[c]) for c in amt_cols if r[c].strip())
                            for r in block if any(r[c].strip() for c in amt_cols))
        out.append({"name": name or group, "reason": reason, "amount": amount})
    # 급부명이 '(요양병원'처럼 괄호가 닫히지 않았으면 지급사유 칸의 줄바꿈으로 잘못 나뉜 것이므로 다음 급부와 합칩니다.
    merged = []
    for b in out:
        prev = merged[-1] if merged else None
        if prev and prev["name"].count("(") > prev["name"].count(")"):
            prev["name"] = clean_name(prev["name"] + "\n" + b["name"])
            prev["reason"] = (prev["reason"] + " " + b["reason"]).strip()
            prev["amount"] = " / ".join(x for x in (prev["amount"], b["amount"]) if x)
        else:
            merged.append(dict(b))
    return [dict(b, group=re.sub(r"\s*[ⅠⅡⅢⅣⅤ]+$", "", b["name"])) for b in merged]


KEY_TITLE_WORDS = ("용어의 정의", "정의", "지급사유", "지급에 관한 세부규정", "지급하지 않는", "보장개시",
                   "보험기간", "갱신", "납입면제", "소멸")


def build_coverage(terms, tables):
    """조문 트리와 표에서 담보 목록과 분류 트리를 만듭니다."""
    nodes = terms["nodes"]
    tables_by_id = {t["id"]: t for t in tables}
    items, common = [], []
    for sec in terms["sections"]:
        if sec["kind"] != "terms":
            continue
        if "일반사항" in sec["title"]:
            # 특약 공통 조문: 담보가 아니며, 3단계에서 참조 조문으로 함께 씁니다.
            common.append({"section": sec["id"], "title": sec["title"]})
            continue
        sec_nodes = [n for n in nodes if n["section"] == sec["id"]]
        arts = [n for n in sec_nodes if n["kind"] in ("article", "appendix")]
        if not arts:
            continue
        key = [n["cid"] for n in arts if n["kind"] == "article"
               and any(w in n["title"].replace(" ", "") for w in (k.replace(" ", "") for k in KEY_TITLE_WORDS))]
        rng = {"section": sec["id"], "first": arts[0]["cid"], "last": arts[-1]["cid"],
               "pages": [sec["page_start"], sec["page_end"]]}
        middle = classify_middle(sec["title"])
        minor = short_title(sec["title"])
        found = []
        for apx in (n for n in sec_nodes if n["kind"] == "appendix" and "지급기준표" in n["title"].replace(" ", "")):
            for tid in re.findall(r"\[표 (T\d+)\]", apx["text"]):
                t = tables_by_id.get(tid)
                if not t:
                    continue
                for k, b in enumerate(benefits_from_table(t["rows"])):
                    found.append((b, {"type": "지급기준표", "appendix": apx["cid"], "table": tid, "row": k,
                                      "page": t["page"]}))
        if not found:
            if any(w in sec["title"] for w in ("서비스", "전환특약", "인수특약")):
                major, why = "기타", "서비스·전환·인수 조건 특약이어서 보험금 대분류에 맞지 않아 기타로 분류했습니다."
            elif "납입면제" in sec["title"]:
                major, why = "기타", "보험료 납입면제 특약이어서 보험금 대분류에 맞지 않아 기타로 분류했습니다."
            elif not any(n["kind"] == "article" and "지급사유" in n["title"].replace(" ", "") for n in arts):
                major, why = "기타", "보험금 지급기준표와 지급사유 조문이 없는 특약(공통 사항·서비스·인수 특약으로 보임)이어서 기타로 분류했습니다."
            else:
                major, why = classify_major(sec["title"], "", "특약명")
                why = "보험금 지급기준표가 없어 특약 하나를 담보 하나로 보았고, " + why
            found.append(({"group": minor, "name": minor, "reason": "", "amount": "", "_major": (major, why)},
                          {"type": "특약", "appendix": "", "table": "", "row": 0, "page": sec["page_start"]}))
        for b, src in found:
            major, why = b.pop("_major", None) or classify_major(b["name"], b["reason"])
            items.append({
                "id": f"C{len(items) + 1:04d}", "name": b["name"], "auto_name": b["name"], "group": b["group"],
                "major": major, "middle": middle, "minor": minor, "reason_note": why,
                "pay_reason": b["reason"], "pay_amount": b["amount"], "section": sec["id"],
                "section_title": sec["title"], "source": src, "range": rng, "key_articles": key,
                "selected": False, "moved": False, "renamed": False,
            })
    return {"majors": MAJORS, "items": items, "common_sections": common}


def item_key(it):
    """다시 만들 때 사용자 수정을 이어 붙이기 위한 열쇠"""
    return f"{it['section']}|{it['source'].get('table', '')}|{it['source'].get('row', 0)}|{it['auto_name']}"
