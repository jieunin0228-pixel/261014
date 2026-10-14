"""1단계-B: 목차·머리글 대조, 담보-쪽 배정, 조문 트리, 담보 유형, 참조 연결, 품질 보고서.

입력은 extract.extract_pdf()가 만든 쪽 목록과 사용자 수정(지시문) 목록입니다.
AI를 쓰지 않으며, 감지에 실패한 부분은 추정하지 않고 보고서 항목으로 남깁니다.
"""
from __future__ import annotations

import difflib
import re
from collections import Counter, defaultdict

from .extract import norm_text

CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"

COVERAGE_TYPES = ["보통약관", "특약공통", "개별특약", "납입면제류", "서비스·인수·전환류", "인용조문", "부속자료", "미분류"]
ANALYZABLE_TYPES = {"보통약관", "특약공통", "개별특약", "납입면제류", "서비스·인수·전환류", "인용조문"}

RE_TOC = re.compile(r"^(\d{3,4})\s+(\S.*)$")
RE_ART = re.compile(r"^제\s*(\d+)(?:\s*-\s*(\d+))?\s*조(?:\s*의\s*(\d+))?\s*【\s*(.+?)\s*】\s*(.*)$")
RE_PART = re.compile(r"^제\s*(\d+)\s*편\s*(?![에은는의을를이가과와])(\S.{0,40})?$")
RE_CHAP = re.compile(r"^제\s*(\d+)\s*관\s*(?![에은는의을를이가과와])(\S.{0,40})?$")
RE_ANNEX = re.compile(r"^\[?\s*별표\s*(\d+(?:\s*-\s*\d+)?)\s*\]?\s*(?![에은는의을를이가과와및중(（‘'“])(\S.{0,80})$")
RE_PARA = re.compile(r"^([" + CIRCLED + r"])(?![과와,·~및\-]|\s*[" + CIRCLED + r"])\s*(.*)$")
RE_ITEM = re.compile(r"^(\d{1,2})\.(?!\d)\s*(.*)$")
SUB_ORDER = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허"
RE_SUB = re.compile(r"^([가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허])\.\s*(.*)$")
RE_SUBSUB = re.compile(r"^\((\d{1,2})\)\s*(.*)$")
RE_LAW = re.compile(r"^(\d{1,3})\.\s*「(.+?)」\s*$")
RE_LAWART = re.compile(r"^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*[(（]([^)）]{1,40})[)）]\s*(.*)$")
SENTENCE_END = re.compile(r"(니다|한다|이다|있다|없다|된다)\s*[.。]?\s*$")

RE_REF_LAW = re.compile(r"「([^」]{1,80})」\s*(?:제\s*(\d+(?:-\d+)?)\s*조(?:\s*의\s*(\d+))?)?")
RE_REF_ART = re.compile(r"제\s*(\d+)(?:\s*-\s*(\d+))?\s*조(?:\s*의\s*(\d+))?(?:\s*[(（]([^)）]{0,60})[)）])?(?:\s*제\s*(\d+)\s*항)?")
RE_REF_ANX = re.compile(r"별표\s*(\d+)(?:\s*-\s*(\d+))?")
RE_REF_PART1 = re.compile(r"제\s*1\s*편\s*일\s*반\s*사\s*항")


def art_key(a, b=None, c=None):
    k = f"제{a}-{b}조" if b else f"제{a}조"
    return k + (f"의{c}" if c else "")


def art_sort(a, b=None, c=None):
    return (int(a), int(b or 0), int(c or 0))


def annex_key(s):
    return "별표" + re.sub(r"\s+", "", s)


# ---------------------------------------------------------------- 목차

def parse_toc(pages):
    """'쪽번호(3~4자리) + 담보명' 줄이 5개 이상 있는 쪽들 중 첫 연속 구간을 목차로 봅니다."""
    cands = []
    limit = min(len(pages), 80)
    for pg in pages[:limit]:
        n = sum(1 for l in pg["lines"] if RE_TOC.match(l["t"]))
        has_word = any("목차" in l["t"] for l in pg["lines"][:5])
        if n >= 5 or (n >= 2 and has_word):
            cands.append(pg["p"])
    if not cands:
        return {"found": False, "pages": [], "entries": [], "problems": ["목차(쪽번호 + 담보명 형식)를 찾지 못했습니다."]}
    run = [cands[0]]
    for p in cands[1:]:
        if p == run[-1] + 1:
            run.append(p)
        else:
            break
    entries = []
    problems = []
    for p in run:
        lines = pages[p - 1]["lines"]
        k = 0
        while k < len(lines):
            l = lines[k]
            m = RE_TOC.match(l["t"])
            if not m:
                k += 1
                continue
            name = m.group(2).strip()
            # 다음 줄이 쪽번호 없이 이름 위치에서 이어지면 줄바꿈된 담보명으로 봅니다.
            name_x = l["b"][0]
            h = l["b"][3] - l["b"][1]
            while k + 1 < len(lines):
                nx = lines[k + 1]
                if RE_TOC.match(nx["t"]) or nx["t"].isdigit():
                    break
                if nx["b"][1] - l["b"][3] > 1.2 * h or nx["b"][0] < name_x + 20:
                    break
                name += nx["t"].strip()
                l = nx
                k += 1
            entries.append({"order": len(entries) + 1, "label": m.group(1), "toc_page": int(m.group(1)),
                            "name": name, "name_norm": norm_text(name), "src_page": p})
            k += 1
    for a, b in zip(entries, entries[1:]):
        if b["toc_page"] < a["toc_page"]:
            problems.append(f"목차 쪽번호가 줄어듭니다: {a['name']}({a['toc_page']}) → {b['name']}({b['toc_page']})")
    return {"found": True, "pages": run, "entries": entries, "problems": problems}


def page_offset(pages):
    """인쇄 쪽번호(꼬리글)와 PDF 쪽번호의 차이(최빈값)를 구합니다."""
    diffs = Counter(pg["p"] - pg["printed"] for pg in pages if pg["printed"] is not None)
    if not diffs:
        return {"offset": 0, "basis": "인쇄 쪽번호를 찾지 못해 0으로 가정하지 않고 보고합니다.", "known": False,
                "mismatch_pages": []}
    off, cnt = diffs.most_common(1)[0]
    mism = [pg["p"] for pg in pages if pg["printed"] is not None and pg["p"] - pg["printed"] != off]
    no_num = [pg["p"] for pg in pages if pg["printed"] is None]
    return {"offset": off, "known": True, "agree_pages": cnt, "mismatch_pages": mism, "no_number_pages": no_num}


# ---------------------------------------------------------------- 쪽 배정

def assign_pages(pages, toc, off, cov_overrides):
    n = len(pages)
    entries = toc["entries"]
    covs = []
    for e in entries:
        covs.append({"cid": f"C{e['order']:03d}", "name": e["name"], "name_norm": e["name_norm"],
                     "toc_label": e["label"], "toc_start": e["toc_page"] + off["offset"]})
    order = sorted(range(len(covs)), key=lambda i: covs[i]["toc_start"])
    for k, i in enumerate(order):
        nxt = covs[order[k + 1]]["toc_start"] - 1 if k + 1 < len(order) else n
        covs[i]["toc_end"] = max(covs[i]["toc_start"], min(nxt, n))
    by_norm = {c["name_norm"]: c for c in covs}
    norms = list(by_norm)

    header_hits = defaultdict(list)
    unknown_headers = defaultdict(list)
    page_rows = []
    for pg in pages:
        p = pg["p"]
        hn = pg["header_norm"]
        hc, how = None, None
        if hn:
            if hn in by_norm:
                hc, how = by_norm[hn], "일치"
            else:
                best = difflib.get_close_matches(hn, norms, n=1, cutoff=0.9)
                if best:
                    hc, how = by_norm[best[0]], "유사 일치"
                else:
                    unknown_headers[pg["header"]].append(p)
        tc = next((c for c in covs if c["toc_start"] <= p <= c["toc_end"]), None)
        if hc:
            header_hits[hc["cid"]].append(p)
        page_rows.append({"p": p, "header": pg["header"], "header_cid": hc["cid"] if hc else None,
                          "header_match": how, "toc_cid": tc["cid"] if tc else None})

    ov = {}
    for o in cov_overrides:
        for p in range(o["start"], o["end"] + 1):
            ov[p] = o["cid"]
    for r in page_rows:
        p = r["p"]
        if p in ov:
            r["cid"], r["source"] = ov[p], "사용자 수정"
        elif r["header_cid"]:
            r["cid"], r["source"] = r["header_cid"], "머리글"
        elif r["toc_cid"] and p not in toc["pages"]:
            r["cid"], r["source"] = r["toc_cid"], "목차 범위(머리글 없음)"
        else:
            r["cid"], r["source"] = None, "미배정"
        r["mismatch"] = bool(r["header_cid"] and r["toc_cid"] and r["header_cid"] != r["toc_cid"]) or \
            bool(pages[p - 1]["header_norm"] and not r["header_cid"])
    cov_pages = defaultdict(list)
    for r in page_rows:
        if r["cid"]:
            cov_pages[r["cid"]].append(r["p"])
    for c in covs:
        ps = cov_pages.get(c["cid"], [])
        c["pages"] = ps
        c["start"] = ps[0] if ps else None
        c["end"] = ps[-1] if ps else None
        c["header_pages"] = len(header_hits.get(c["cid"], []))
        c["header_start"] = header_hits[c["cid"]][0] if header_hits.get(c["cid"]) else None
        gaps = []
        for a, b in zip(ps, ps[1:]):
            if b != a + 1:
                gaps.append([a + 1, b - 1])
        c["gaps"] = gaps
    return covs, page_rows, dict(unknown_headers)


# ---------------------------------------------------------------- 조문 트리

def _is_internal_toc(pg, heading_x):
    ls = pg["lines"]
    if not ls:
        return False
    if any("목차" in l["t"] for l in ls[:3]):
        return True
    heads = 0
    for l in ls:
        t = l["t"]
        if RE_ART.match(t) or RE_CHAP.match(t) or RE_PART.match(t) or re.match(r"^별표\s*\d", t):
            heads += 1
    return heads >= 4 and heads >= 0.6 * len(ls)


def heading_margin(pages):
    xs = Counter()
    for pg in pages:
        for l in pg["lines"]:
            if RE_ART.match(l["t"]):
                xs[round(l["b"][0])] += 1
    if not xs:
        return 72.0
    return float(xs.most_common(1)[0][0])


class _Builder:
    def __init__(self, cov, nodes, dup_ids):
        self.cov = cov
        self.name = cov["name"]
        self.nodes = nodes
        self.dup = dup_ids
        self.article = None   # 현재 조문 또는 별표·머리말·편·관
        self.stack = []       # (level, node)
        self.box = None
        self.box_region = None
        self.part = None
        self.chap = None
        self.law = None
        self.order = []

    def new(self, kind, key, title, parent, line_ref, page, text="", **extra):
        if parent is None:
            nid = f"{self.name}/{key}"
        else:
            nid = f"{parent['id']}/{key}"
        if nid in self.nodes:
            k = 2
            while f"{nid}#{k}" in self.nodes:
                k += 1
            self.dup.append({"cid": self.cov["cid"], "id": nid, "page": page})
            nid = f"{nid}#{k}"
        node = {"id": nid, "cid": self.cov["cid"], "kind": kind, "key": key, "title": title,
                "parent": parent["id"] if parent else None, "children": [], "lines": [], "text": "",
                "page_start": page, "page_end": page}
        node.update(extra)
        if text:
            node["text"] = text
        if line_ref:
            node["lines"].append(line_ref)
        if parent:
            parent["children"].append(nid)
        self.nodes[nid] = node
        self.order.append(nid)
        return node

    def add_line(self, node, text, ref, page):
        node["text"] = (node["text"] + "\n" + text) if node["text"] else text
        node["lines"].append(ref)
        node["page_end"] = page
        # 상위 노드의 끝 쪽도 갱신
        pid = node["parent"]
        while pid:
            pn = self.nodes[pid]
            pn["page_end"] = max(pn["page_end"], page)
            pid = pn["parent"]

    def top(self):
        if self.box is not None:
            return self.box
        if self.stack:
            return self.stack[-1][1]
        return self.article

    def ensure_preface(self, ref, page):
        if self.article is None:
            self.article = self.new("preface", "머리말", "머리말", None, None, page)

    def start_top(self, kind, key, title, ref, page, rest="", **extra):
        self.stack = []
        self.box = None
        self.box_region = None
        parent = None
        if kind == "article" and self.law is not None:
            parent = self.law
        node = self.new(kind, key, title, parent, ref, page, text=rest.strip(),
                        part=self.part, chap=self.chap, **extra)
        if kind in ("article", "annex", "preface", "part", "chap", "law"):
            self.article = node
        return node

    def marker(self, level, kind, label, num, rest, ref, page):
        """항·호·목 번호는 같은 부모 아래에서 1부터 차례로 이어질 때만 새 단위로 인정합니다.
        (예시 그림 속 ②, 본문 중간의 '1.' 같은 글자를 단위로 오인하지 않기 위함)"""
        st = list(self.stack)
        prev_same = None
        while st and st[-1][0] >= level:
            lv, nd = st.pop()
            if lv == level:
                prev_same = nd
        expected = prev_same["num"] + 1 if prev_same else 1
        if num != expected:
            return None
        self.stack = st
        parent = self.stack[-1][1] if self.stack else self.article
        node = self.new(kind, label, "", parent, ref, page, text=rest.strip(), num=num)
        self.stack.append((level, node))
        return node


def parse_coverage(cov, pages, page_rows, nodes, dup_ids, heading_x, force, suppress, box_regions, toc_pages_internal):
    """담보 하나의 쪽들을 조문 트리로 만듭니다."""
    b = _Builder(cov, nodes, dup_ids)
    is_law = cov["type_guess"] == "인용조문"
    line_owner = {}
    # 조문 머리의 왼쪽 위치는 특약마다 다를 수 있으므로 담보별 최빈값을 씁니다.
    xs = Counter()
    for p in cov["pages"]:
        if p in toc_pages_internal:
            continue
        for l in pages[p - 1]["lines"]:
            if (RE_LAW if is_law else RE_ART).match(l["t"]):
                xs[round(l["b"][0])] += 1
    if xs:
        heading_x = float(min(x for x, n in xs.items() if n >= max(1, xs.most_common(1)[0][1] // 3)))
    law_x = heading_x
    for p in cov["pages"]:
        pg = pages[p - 1]
        if p in toc_pages_internal:
            continue
        regions = box_regions.get(p, [])
        for i, l in enumerate(pg["lines"]):
            ref = [p, i]
            t = l["t"]
            x0 = l["b"][0]
            yc = (l["b"][1] + l["b"][3]) / 2
            xc = (l["b"][0] + l["b"][2]) / 2
            key = (p, i)
            region = next((r for r in regions if r[0] - 1 <= xc <= r[2] + 1 and r[1] - 1 <= yc <= r[3] + 1), None)
            fh = force.get(key)
            sup = key in suppress
            at_margin = x0 <= heading_x + 4
            if fh:
                if fh["kind"] == "annex":
                    node = b.start_top("annex", fh["key"], fh["title"], ref, p, forced=True)
                else:
                    node = b.start_top("article", fh["key"], fh["title"], ref, p, forced=True)
                line_owner[key] = node["id"]
                continue
            if not sup and region is None:
                if is_law:
                    m = RE_LAW.match(t)
                    if m:
                        b.law = None
                        node = b.start_top("law", f"「{m.group(2).strip()}」", m.group(2).strip(), ref, p,
                                           law_norm=norm_text(m.group(2)))
                        b.law = node
                        line_owner[key] = node["id"]
                        continue
                    m = RE_LAWART.match(t)
                    if m and b.law is not None and x0 <= law_x + 14:
                        node = b.start_top("article", art_key(m.group(1), None, m.group(2)), m.group(3), ref, p,
                                           rest=m.group(4), sort=art_sort(m.group(1), None, m.group(2)))
                        line_owner[key] = node["id"]
                        continue
                else:
                    m = RE_ART.match(t)
                    if m and at_margin:
                        node = b.start_top("article", art_key(m.group(1), m.group(2), m.group(3)), m.group(4), ref, p,
                                           rest=m.group(5), sort=art_sort(m.group(1), m.group(2), m.group(3)))
                        line_owner[key] = node["id"]
                        continue
                    m = RE_PART.match(t)
                    if m and len(t) <= 40 and not SENTENCE_END.search(t):
                        b.part = f"제{m.group(1)}편"
                        b.chap = None
                        node = b.start_top("part", b.part, (m.group(2) or "").strip(), ref, p)
                        line_owner[key] = node["id"]
                        continue
                    m = RE_CHAP.match(t)
                    if m and at_margin and len(t) <= 45 and not SENTENCE_END.search(t):
                        b.chap = f"제{m.group(1)}관"
                        ck = (b.part + "/" if b.part else "") + b.chap
                        node = b.start_top("chap", ck, (m.group(2) or "").strip(), ref, p)
                        line_owner[key] = node["id"]
                        continue
                    m = RE_ANNEX.match(t)
                    if m and x0 <= heading_x + 12 and i <= 2 and len(t) <= 90 and not SENTENCE_END.search(t):
                        akey = annex_key(m.group(1))
                        if b.article is not None and b.article["kind"] == "annex" and b.article["key"] == akey:
                            # 같은 별표 제목이 다음 쪽에 반복되면 이어지는 쪽으로 봅니다.
                            b.article.setdefault("repeated_heading_pages", []).append(p)
                            b.add_line(b.article, t, ref, p)
                            line_owner[key] = b.article["id"]
                            continue
                        node = b.start_top("annex", akey, m.group(2).strip(), ref, p)
                        line_owner[key] = node["id"]
                        continue
            if region is not None and b.article is not None and b.article["kind"] != "annex":
                if b.box is None or b.box_region != region:
                    parent = b.stack[-1][1] if b.stack else b.article
                    nbox = sum(1 for c in parent["children"] if b.nodes[c]["kind"] == "box") + 1
                    b.box = b.new("box", f"설명{nbox}", t if t.startswith("【") else "", parent, None, p)
                    b.box_region = region
                b.add_line(b.box, t, ref, p)
                line_owner[key] = b.box["id"]
                continue
            b.box = None
            b.box_region = None
            b.ensure_preface(ref, p)
            if b.article["kind"] in ("article",) and not sup:
                node = None
                m = RE_PARA.match(t)
                if m and x0 <= heading_x + 22:
                    node = b.marker(1, "para", m.group(1), CIRCLED.index(m.group(1)) + 1, m.group(2), ref, p)
                if node is None:
                    m = RE_ITEM.match(t)
                    if m:
                        node = b.marker(2, "item", m.group(1), int(m.group(1)), m.group(2), ref, p)
                if node is None:
                    m = RE_SUB.match(t)
                    if m:
                        node = b.marker(3, "sub", m.group(1), SUB_ORDER.index(m.group(1)) + 1, m.group(2), ref, p)
                if node is None:
                    m = RE_SUBSUB.match(t)
                    if m:
                        node = b.marker(4, "subsub", f"({m.group(1)})", int(m.group(1)), m.group(2), ref, p)
                if node is not None:
                    line_owner[key] = node["id"]
                    continue
            node = b.top()
            b.add_line(node, t, ref, p)
            line_owner[key] = node["id"]
    return b.order, line_owner


def full_text(nodes, nid):
    n = nodes[nid]
    parts = []
    if n["kind"] in ("article", "annex", "part", "chap", "law"):
        head = f"{n['key']}【{n['title']}】" if n["kind"] == "article" and n.get("title") else f"{n['key']} {n.get('title', '')}"
        parts.append(head.strip())
    elif n["kind"] in ("para", "item", "sub", "subsub"):
        pass
    if n["text"]:
        lead = n["key"] + " " if n["kind"] in ("para", "item", "sub", "subsub") else ""
        if n["kind"] == "item":
            lead = n["key"] + ". "
        elif n["kind"] == "sub":
            lead = n["key"] + ". "
        parts.append(lead + n["text"])
    for c in n["children"]:
        parts.append(full_text(nodes, c))
    return "\n".join(p for p in parts if p)


# ---------------------------------------------------------------- 유형·핵심 조문

def classify(cov, nodes, order):
    name = cov["name_norm"]
    arts = [nodes[i] for i in order if nodes[i]["kind"] == "article"]
    titles = [norm_text(a["title"]) for a in arts]
    has_dash1 = sum(1 for a in arts if re.match(r"제1-\d+조", a["key"]))
    payout = any(("지급사유" in t and "통지" not in t) for t in titles)
    waiver = any("납입면제사유" in t for t in titles)
    if "인용조문" in name:
        return "인용조문"
    if cov["header_pages"] == 0 and not arts:
        return "부속자료"
    if "일반사항" in name and has_dash1 >= max(1, len(arts) // 2):
        return "특약공통"
    if waiver or ("납입면제" in name and not payout):
        return "납입면제류"
    if re.search(r"서비스|인수|전환|지정대리", name):
        return "서비스·인수·전환류"
    if payout and "특약" not in name:
        return "보통약관"
    if payout:
        return "개별특약"
    return "미분류"


def key_articles(nodes, order):
    out = {"payout": None, "detail": None, "exclusion": None, "benefit_table": None}
    for nid in order:
        n = nodes[nid]
        t = norm_text(n.get("title", ""))
        if n["kind"] == "article":
            if out["payout"] is None and (("지급사유" in t and "통지" not in t) or "납입면제사유" in t):
                out["payout"] = nid
            elif out["detail"] is None and "세부규정" in t:
                out["detail"] = nid
            elif out["exclusion"] is None and ("지급하지않는사유" in t or "면제하지않는사유" in t or "면책" in t):
                out["exclusion"] = nid
        elif n["kind"] == "annex" and out["benefit_table"] is None and "지급기준표" in t:
            out["benefit_table"] = nid
    return out


def numbering_problems(cov, nodes, order):
    probs = []
    seen = {}
    prev = None
    for nid in order:
        n = nodes[nid]
        if n["kind"] != "article" or "sort" not in n:
            if n["kind"] == "law":
                prev = None
            continue
        s = n["sort"]
        k = (n["parent"], n["key"])
        if k in seen:
            probs.append({"cid": cov["cid"], "kind": "중복", "key": n["key"], "page": n["page_start"],
                          "detail": f"{n['key']}가 {seen[k]}쪽과 {n['page_start']}쪽에 두 번 나옵니다."})
        seen[k] = n["page_start"]
        if prev is not None:
            a, b2, c = s
            pa, pb, pc = prev
            ok = False
            if (a, b2) == (pa, pb) and (c == pc + 1 or (pc == 0 and c == 2)):
                ok = True
            elif b2 and a == pa and b2 == pb + 1 and c == 0:
                ok = True
            elif not b2 and a == pa + 1 and c == 0:
                ok = True
            elif b2 and a == pa + 1 and b2 == 1 and c == 0:
                ok = True
            elif b2 and a != pa and b2 == 1:
                ok = True
            if not ok:
                probs.append({"cid": cov["cid"], "kind": "끊김·역전", "key": n["key"], "page": n["page_start"],
                              "detail": f"직전 조문 {art_key(prev[0], prev[1] or None, prev[2] or None)} 다음에 {n['key']}가 나옵니다."})
        prev = s
    return probs


# ---------------------------------------------------------------- 참조 연결

def _circled(n):
    n = int(n)
    return CIRCLED[n - 1] if 1 <= n <= len(CIRCLED) else None


def resolve_refs(covs, nodes, cov_orders):
    by_cid = {c["cid"]: c for c in covs}
    common = [c for c in covs if c["type"] == "특약공통"]
    main = [c for c in covs if c["type"] == "보통약관"]
    lawcov = [c for c in covs if c["type"] == "인용조문"]
    law_index = {}
    if lawcov:
        lc = lawcov[0]
        for nid in cov_orders[lc["cid"]]:
            n = nodes[nid]
            if n["kind"] == "law":
                law_index[n["law_norm"]] = nid
    art_index = {}
    for c in covs:
        for nid in cov_orders.get(c["cid"], []):
            n = nodes[nid]
            if n["kind"] in ("article", "annex") and n["parent"] is None:
                art_index[(c["cid"], n["key"])] = nid

    refs = []
    for c in covs:
        if c["type"] in ("인용조문", "부속자료"):
            continue
        dash_style = any(re.match(r"제\d+-\d+조", nodes[n]["key"]) for n in cov_orders.get(c["cid"], [])
                         if nodes[n]["kind"] == "article")
        for nid in cov_orders.get(c["cid"], []):
            n = nodes[nid]
            if not n["text"] and n["kind"] != "article":
                continue
            text = (n["text"] or "").replace("\n", " ")
            if n["kind"] == "box" and re.search(r"법|규칙|령|고시", n.get("title") or ""):
                # 법령 원문을 옮겨 놓은 설명 상자: 상자 제목의 법령 조문만 참조로 보고, 안쪽 조문 번호는 그 법령 내부 참조이므로 건너뜁니다.
                text = (n["text"] or "").split("\n")[0]
            # 조문 자체의 위치(최상위 조문/별표)
            top = n
            while top["parent"]:
                top = nodes[top["parent"]]
            spans = []

            def add(kind, raw, target, tcid, status, reason, start):
                ctx = text[max(0, start - 25): start + len(raw) + 25]
                refs.append({"cid": c["cid"], "src": nid, "src_page": n["page_start"], "kind": kind, "raw": raw,
                             "target": target, "target_cid": tcid, "status": status, "reason": reason, "ctx": ctx})

            for m in RE_REF_LAW.finditer(text):
                spans.append((m.start(), m.end()))
                law = norm_text(m.group(1))
                lid = law_index.get(law)
                raw = m.group(0).strip()
                if not lid:
                    near = text[m.end(): m.end() + 25]
                    if "인용조문" in near:
                        add("법령", raw, None, None, "미해결", "인용조문 구간에서 해당 법령을 찾지 못함", m.start())
                    continue
                if m.group(2):
                    tid = f"{lid}/제{m.group(2)}조" + (f"의{m.group(3)}" if m.group(3) else "")
                    if tid in nodes:
                        add("법령", raw, tid, lawcov[0]["cid"], "연결", "", m.start())
                    else:
                        add("법령", raw, lid, lawcov[0]["cid"], "미해결", "법령은 있으나 해당 조문이 인용조문에 없음", m.start())
                else:
                    add("법령", raw, lid, lawcov[0]["cid"], "연결", "법령 단위 연결", m.start())

            for m in RE_REF_ART.finditer(text):
                if any(a <= m.start() < b for a, b in spans):
                    continue
                before = text[max(0, m.start() - 40): m.start()]
                a, b2, cc = m.group(1), m.group(2), m.group(3)
                key = art_key(a, b2, cc)
                raw = m.group(0).strip()
                if re.search(r"(같은\s*법|이\s*법)\s*$", before):
                    continue
                if re.search(r"(법률|법|령|규칙|규정|고시)\s*$", before):
                    nb = norm_text(before)
                    lid = next((v for k2, v in law_index.items() if nb.endswith(k2)), None)
                    if lid:
                        tid = f"{lid}/{key}"
                        if tid in nodes:
                            add("법령", raw, tid, lawcov[0]["cid"], "연결", "", m.start())
                        else:
                            add("법령", raw, lid, lawcov[0]["cid"], "미해결", "법령은 있으나 해당 조문이 인용조문에 없음", m.start())
                    else:
                        add("법령", raw, None, None, "미해결", "인용조문에 없는 외부 법령·고시의 조문", m.start())
                    continue
                if re.search(r"(적용대상\s*특약|해당\s*특약|각\s*특약)[^.。]{0,10}$", before):
                    add("조문", raw, None, None, "각 특약 조문", "다른 특약(적용대상 특약)의 같은 번호 조문을 가리킴", m.start())
                    continue
                if b2 and a == "2" and c["type"] == "특약공통":
                    add("조문", raw, None, None, "각 특약 조문", "특약 공통 조항이 각 개별 특약의 같은 번호 조문을 가리킴", m.start())
                    continue
                if b2:
                    if a == "1":
                        if not common:
                            add("조문", raw, None, None, "미해결", "특약 공통(일반사항) 구간을 찾지 못함", m.start())
                            continue
                        tc = common[0]
                    else:
                        tc = c
                else:
                    if not dash_style:
                        tc = c
                    elif re.search(r"(주계약|보통약관)", text[max(0, m.start() - 30): m.start()]):
                        if not main:
                            add("조문", raw, None, None, "미해결", "보통약관 구간을 찾지 못함", m.start())
                            continue
                        tc = main[0]
                    else:
                        add("조문", raw, None, None, "미해결", "번호 체계(N-M)와 다른 '제N조' 참조이며 소속(주계약·법령 등)이 문맥에 없음", m.start())
                        continue
                tid = art_index.get((tc["cid"], key))
                if not tid:
                    add("조문", raw, None, tc["cid"], "미해결", f"{tc['name']}에서 {key}를 찾지 못함", m.start())
                    continue
                if tid == top["id"]:
                    continue
                if m.group(5):
                    sub = f"{tid}/{_circled(m.group(5))}"
                    if sub in nodes:
                        tid = sub
                add("조문", raw, tid, tc["cid"], "연결", "", m.start())

            for m in RE_REF_ANX.finditer(text):
                a, b2 = m.group(1), m.group(2)
                key = f"별표{a}-{b2}" if b2 else f"별표{a}"
                if top["kind"] == "annex" and top["key"] == key:
                    continue
                raw = m.group(0)
                before = text[max(0, m.start() - 15): m.start()]
                if (not b2 and dash_style) or re.search(r"(법률|법|령|규칙|고시|」)\s*(제\s*\d+\s*[조항]\s*)*$", before):
                    add("별표", raw, None, None, "미해결", "외부 법령·고시의 별표로 보임(이 약관의 별표 번호 체계와 다름)", m.start())
                    continue
                if b2 and a == "1" and c["type"] != "특약공통":
                    tc = common[0] if common else None
                else:
                    tc = c
                if tc is None:
                    add("별표", raw, None, None, "미해결", "특약 공통(일반사항) 구간을 찾지 못함", m.start())
                    continue
                tid = art_index.get((tc["cid"], key))
                if tid:
                    add("별표", raw, tid, tc["cid"], "연결", "", m.start())
                else:
                    add("별표", raw, None, tc["cid"], "미해결", f"{tc['name']}에서 {key}를 찾지 못함", m.start())

            if c["type"] != "특약공통":
                for m in RE_REF_PART1.finditer(text):
                    if common:
                        add("공통 전체", m.group(0), common[0]["cid"], common[0]["cid"], "연결",
                            "제1편 일반사항 전체를 이 특약에 적용", m.start())
                    else:
                        add("공통 전체", m.group(0), None, None, "미해결", "특약 공통(일반사항) 구간을 찾지 못함", m.start())
            if n["kind"] == "article" and "준용" in norm_text(n.get("title", "")) and c["type"] != "보통약관":
                ft = norm_text(full_text(nodes, nid))
                if "주계약" in ft or "보통약관" in ft:
                    if main:
                        add("주계약 준용", n["key"], main[0]["cid"], main[0]["cid"], "연결",
                            "주계약(보통약관) 약관을 준용", 0)
                    else:
                        add("주계약 준용", n["key"], None, None, "미해결", "보통약관 구간을 찾지 못함", 0)
    return refs


def analysis_inputs(cov, nodes, cov_orders, refs, by_cid):
    """매칭 규칙 6: 담보 하나의 분석 입력 구성."""
    own = [nid for nid in cov_orders.get(cov["cid"], []) if nodes[nid]["parent"] is None]
    common, main, annex, law, whole = [], [], [], [], []
    for r in refs:
        if r["cid"] != cov["cid"] or r["status"] != "연결":
            continue
        tc = by_cid.get(r["target_cid"])
        if r["kind"] in ("공통 전체", "주계약 준용"):
            whole.append({"kind": r["kind"], "cid": r["target_cid"], "name": tc["name"] if tc else ""})
            continue
        if r["kind"] == "법령":
            law.append(r["target"])
        elif r["kind"] == "별표" and r["target_cid"] != cov["cid"]:
            annex.append(r["target"])
        elif r["kind"] == "조문" and r["target_cid"] != cov["cid"] and tc:
            if tc["type"] == "특약공통":
                common.append(r["target"])
            elif tc["type"] == "보통약관":
                main.append(r["target"])
            else:
                main.append(r["target"])

    def uniq(xs):
        out = []
        for x in xs:
            if x and x not in out:
                out.append(x)
        return out
    wh = []
    for w in whole:
        if w not in wh:
            wh.append(w)
    return {"own": own, "common_refs": uniq(common), "main_refs": uniq(main), "annex_refs": uniq(annex),
            "law_refs": uniq(law), "whole": wh}


# ---------------------------------------------------------------- 전체 조립

def build(pages, meta, edits):
    active = [e for e in edits if e.get("active", True)]
    cov_range = {}
    cov_type = {}
    force, suppress = {}, set()
    for e in active:
        if e["action"] == "coverage_range":
            cov_range[e["cid"]] = {"cid": e["cid"], "start": int(e["start"]), "end": int(e["end"])}
        elif e["action"] == "coverage_type":
            cov_type[e["cid"]] = e["type"]
        elif e["action"] in ("split", "rename"):
            force[(int(e["page"]), int(e["line"]))] = {"kind": e.get("kind", "article"), "key": e["key"],
                                                      "title": e.get("title", "")}
            suppress.discard((int(e["page"]), int(e["line"])))
        elif e["action"] == "merge":
            suppress.add((int(e["page"]), int(e["line"])))
            force.pop((int(e["page"]), int(e["line"])), None)

    toc = parse_toc(pages)
    off = page_offset(pages)
    covs, page_rows, unknown_headers = assign_pages(pages, toc, off, list(cov_range.values()))
    heading_x = heading_margin(pages)
    toc_internal = set()
    for pg in pages:
        if pg["p"] in toc["pages"]:
            continue
        if _is_internal_toc(pg, heading_x):
            toc_internal.add(pg["p"])
    box_regions = defaultdict(list)
    for pg in pages:
        for t in pg["tables"]:
            if t["kind"] == "box":
                box_regions[pg["p"]].append(tuple(t["bbox"]))

    nodes, dup_ids, cov_orders, line_owner = {}, [], {}, {}
    for c in covs:
        c["type_guess"] = "인용조문" if "인용조문" in c["name_norm"] else None
        if c["header_pages"] == 0 and c["cid"] not in cov_range:
            cov_orders[c["cid"]] = []
            continue
        order, owner = parse_coverage(c, pages, page_rows, nodes, dup_ids, heading_x, force, suppress,
                                      box_regions, toc_internal)
        cov_orders[c["cid"]] = order
        line_owner.update(owner)
    for c in covs:
        auto = classify(c, nodes, cov_orders[c["cid"]])
        c["type_auto"] = auto
        c["type"] = cov_type.get(c["cid"], auto)
        c["type_edited"] = c["cid"] in cov_type
        c["range_edited"] = c["cid"] in cov_range
        c.pop("type_guess", None)
        c["key"] = key_articles(nodes, cov_orders[c["cid"]])
        c["n_articles"] = sum(1 for i in cov_orders[c["cid"]] if nodes[i]["kind"] == "article")
        c["annexes"] = [{"id": i, "key": nodes[i]["key"], "title": nodes[i]["title"], "page": nodes[i]["page_start"]}
                        for i in cov_orders[c["cid"]] if nodes[i]["kind"] == "annex"]

    refs = resolve_refs(covs, nodes, cov_orders)
    by_cid = {c["cid"]: c for c in covs}
    for c in covs:
        c["inputs"] = analysis_inputs(c, nodes, cov_orders, refs, by_cid)

    # 표: 담보·소속 조문(별표)에 연결
    page_cid = {r["p"]: r["cid"] for r in page_rows}
    tables = []
    for pg in pages:
        p = pg["p"]
        owners = [(pg["lines"][i]["b"][1], line_owner.get((p, i))) for i in range(len(pg["lines"]))]
        for t in pg["tables"]:
            if t["kind"] != "table":
                continue
            top = t["bbox"][1]
            own = None
            for y, nid in owners:
                if nid and y <= top + 2:
                    own = nid
            if own is None:
                prevs = [line_owner.get((p - 1, i)) for i in range(len(pages[p - 2]["lines"]))] if p > 1 else []
                prevs = [x for x in prevs if x]
                own = prevs[-1] if prevs else None
            owner_top = own
            while owner_top and nodes.get(owner_top, {}).get("parent"):
                owner_top = nodes[owner_top]["parent"]
            tid = f"T{p:04d}-{t['idx'] + 1}"
            cap = ""
            for l in pg["lines"]:
                if l["b"][3] <= top + 1 and top - l["b"][3] < 25:
                    cap = l["t"]
            tables.append({"id": tid, "cid": page_cid.get(p), "page": p, "owner": owner_top, "owner_node": own,
                           "annex": nodes[owner_top]["key"] if owner_top and nodes[owner_top]["kind"] == "annex" else None,
                           "caption": cap, "bbox": t["bbox"], "n_rows": t["n_rows"], "n_cols": t["n_cols"], "grid": t["grid"],
                           "cells": t["cells"], "complete": t["complete"], "problems": t["problems"],
                           "image": t.get("image")})
    for a, b2 in zip(tables, tables[1:]):
        if b2["page"] == a["page"] + 1 and a["cid"] == b2["cid"] and a["n_cols"] == b2["n_cols"]:
            ha = pages[a["page"] - 1]["h"]
            if a["bbox"][3] > ha * 0.8 and b2["bbox"][1] < ha * 0.3:
                a["continues_to"] = b2["id"]
                b2["continued_from"] = a["id"]
    for c in covs:
        c["tables"] = [t["id"] for t in tables if t["cid"] == c["cid"]]

    numbering = []
    for c in covs:
        if c["type"] in ANALYZABLE_TYPES and c["type"] != "인용조문":  # 인용조문은 발췌이므로 번호가 끊기는 것이 정상
            numbering += numbering_problems(c, nodes, cov_orders[c["cid"]])

    report = make_report(pages, meta, toc, off, covs, page_rows, unknown_headers, refs, tables, numbering,
                         dup_ids, toc_internal)
    return {
        "toc": toc, "offset": off, "coverages": covs, "page_rows": page_rows, "nodes": nodes,
        "cov_orders": cov_orders, "refs": refs, "tables": tables, "report": report,
        "heading_x": heading_x, "toc_internal": sorted(toc_internal), "line_owner": {f"{k[0]}:{k[1]}": v for k, v in line_owner.items()},
    }


def make_report(pages, meta, toc, off, covs, page_rows, unknown_headers, refs, tables, numbering, dup_ids, toc_internal):
    header_found = [c for c in covs if c["header_pages"] > 0]
    toc_no_header = [{"cid": c["cid"], "name": c["name"], "toc_start": c["toc_start"], "toc_end": c["toc_end"]}
                     for c in covs if c["header_pages"] == 0]
    start_diff = [{"cid": c["cid"], "name": c["name"], "toc_start": c["toc_start"], "header_start": c["header_start"]}
                  for c in covs if c["header_start"] and c["header_start"] != c["toc_start"]]
    unassigned = [{"p": r["p"], "first_line": (pages[r["p"] - 1]["lines"][0]["t"] if pages[r["p"] - 1]["lines"] else "")[:60]}
                  for r in page_rows if not r["cid"]]
    mismatch = []
    for r in page_rows:
        if r["mismatch"]:
            mismatch.append({"p": r["p"], "header": r["header"], "header_cid": r["header_cid"], "toc_cid": r["toc_cid"],
                             "assigned": r["cid"]})
    no_header_assigned = [r["p"] for r in page_rows if r["cid"] and r["source"] == "목차 범위(머리글 없음)"]
    by_cid = {c["cid"]: c for c in covs}
    no_payout = [{"cid": c["cid"], "name": c["name"], "type": c["type"]} for c in covs
                 if c["type"] in ("보통약관", "개별특약", "납입면제류", "미분류", "서비스·인수·전환류") and not c["key"]["payout"]]
    unresolved = [r for r in refs if r["status"] == "미해결"]
    tbl_bad = [{"id": t["id"], "cid": t["cid"], "page": t["page"], "annex": t["annex"], "problems": t["problems"],
                "image": t["image"]} for t in tables if not t["complete"]
               and (by_cid.get(t["cid"]) or {}).get("type") in ANALYZABLE_TYPES]
    low = [{"p": pg["p"], "chars": pg["chars"], "cid": page_rows[pg["p"] - 1]["cid"]} for pg in pages if pg["low_text"]]
    ocr = []
    for pg in pages:
        if pg["ocr"]:
            o = pg["ocr"]
            if not o.get("done"):
                ocr.append({"p": pg["p"], "status": "OCR 미실행", "detail": o.get("reason", "")})
            elif o.get("low_lines"):
                ocr.append({"p": pg["p"], "status": "저신뢰", "detail": f"평균 신뢰도 {o['avg_conf']}, 저신뢰 줄 {len(o['low_lines'])}개"})
    summary = []
    for c in covs:
        k = c["key"]
        summary.append({
            "cid": c["cid"], "name": c["name"], "start": c["start"], "end": c["end"], "type": c["type"],
            "payout": k["payout"], "annexes": c["annexes"], "n_articles": c["n_articles"],
            "toc_start": c["toc_start"], "header_pages": c["header_pages"], "gaps": c["gaps"],
        })
    return {
        "page_count": meta["page_count"],
        "text_pages": sum(1 for pg in pages if pg["chars"] > 0),
        "scanned_pages": sum(1 for pg in pages if pg["scanned"]),
        "ocr_engine": meta.get("ocr_engine"),
        "toc": {"found": toc["found"], "pages": toc["pages"], "count": len(toc["entries"]), "problems": toc["problems"]},
        "offset": off,
        "header_coverages": len(header_found),
        "toc_count": len(covs),
        "count_diff": len(covs) - len(header_found),
        "toc_no_header": toc_no_header,
        "unknown_headers": [{"header": h, "pages": ps} for h, ps in unknown_headers.items()],
        "start_diff": start_diff,
        "unassigned_pages": unassigned,
        "mismatch_pages": mismatch,
        "no_header_assigned": no_header_assigned,
        "internal_toc_pages": sorted(toc_internal),
        "no_payout": no_payout,
        "numbering": numbering,
        "duplicate_ids": dup_ids,
        "unresolved_refs": unresolved,
        "ref_total": len(refs),
        "table_total": len(tables),
        "table_incomplete": tbl_bad,
        "low_text_pages": low,
        "ocr": ocr,
        "summary": summary,
    }
