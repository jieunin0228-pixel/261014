"""구조 분해: 목차(구간) → 편·관·조·항·호·목, 별표, 해설 상자. 정규식만 사용합니다."""
import re

CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚"
HANGUL_ITEMS = "가나다라마바사아자차카타파하"

RE_PART = re.compile(r"^제\s*(\d+)\s*편\s*(.*)$")
RE_CHAPTER = re.compile(r"^제\s*(\d+)\s*관\s*(.*)$")
RE_SECTION = re.compile(r"^제\s*(\d+)\s*절\s*(.*)$")
_ART_NUM = r"제\s*(\d+(?:\s*-\s*\d+)?)\s*조(?:\s*의\s*(\d+))?"
RE_ART_BRACKET = re.compile(r"^" + _ART_NUM + r"\s*【\s*(.+?)\s*】\s*(.*)$")
RE_ART_PAREN = re.compile(r"^" + _ART_NUM + r"\s*[(\[（]\s*([^)\]）]+?)\s*[)\]）]\s*$")
RE_APPENDIX = re.compile(r"^[<\[]?\s*별\s*표\s*(\d+(?:\s*-\s*\d+)?)\s*[>\]]?\s*(.*)$")
RE_PARA = re.compile(r"^([" + CIRCLED + r"])\s*(.*)$")
RE_ITEM = re.compile(r"^(\d{1,2})\.(?!\d)\s*(\S.*)$")
RE_SUBITEM = re.compile(r"^([" + HANGUL_ITEMS + r"])\.\s*(\S.*)$")
RE_NOTE_HEAD = re.compile(r"^【\s*([^】]{1,40})\s*】")
RE_TOC_NUM_FIRST = re.compile(r"^(\d{1,4})\s+(\S.*)$")
RE_TOC_NUM_LAST = re.compile(r"^(\S.*?)[\s·.…]{1,}(\d{1,4})$")

REFERENCE_SECTION_WORDS = ("색인", "Guide", "용어 해설", "용어해설", "요약서", "인용조문", "안내문")


def norm_art_num(num):
    return re.sub(r"\s+", "", num)


def art_label(num):
    """'2-1의8' → '제2-1조의8'"""
    base, _, sub = num.partition("의")
    return f"제{base}조" + (f"의{sub}" if sub else "")


def circled_index(ch):
    return CIRCLED.index(ch) + 1


# ---------------------------------------------------------------- 목차와 구간

def parse_toc_lines(lines):
    """한 쪽의 줄에서 (쪽번호, 제목) 목록을 읽습니다."""
    out = []
    for l in lines:
        t = l["text"].strip()
        m = RE_TOC_NUM_FIRST.match(t)
        if m and len(m.group(1)) >= 3:  # 0011 형식(앞자리 0 채움)
            out.append((int(m.group(1)), m.group(2).strip()))
            continue
        m = RE_TOC_NUM_LAST.match(t)
        if m and len(re.sub(r"[\s·.…]", "", m.group(1))) >= 2:
            title = re.sub(r"[\s·.…]+(0)?$", "", m.group(1)).strip()
            out.append((int(m.group(2)), title))
    return out


def find_toc(pages, max_scan=60):
    """책 앞부분의 목차 쪽을 찾아 최상위 목차 항목을 돌려줍니다.

    '목차'라는 말이 있는 쪽에서 시작해, 항목이 3개 이상 나오는 쪽이 이어지는 동안 읽습니다.
    """
    n = min(len(pages), max_scan)
    best = None
    for i in range(n):
        head = " ".join(l["text"] for l in pages[i]["lines"][:6])
        if "목차" not in head:
            continue
        entries, toc_pages = [], []
        j = i
        while j < len(pages):
            e = parse_toc_lines(pages[j]["lines"])
            nums = [x[0] for x in e]
            # 쪽번호가 앞 항목보다 작아지면 목차가 끝난 것으로 봅니다(색인 쪽 등).
            if len(e) < 3 or nums != sorted(nums) or (entries and nums[0] < entries[-1][0]):
                break
            entries += e
            toc_pages.append(j + 1)
            j += 1
        if len(entries) >= 3 and (best is None or len(entries) > len(best["entries"])):
            best = {"pages": toc_pages, "entries": entries}
    return best


def build_sections(pages, bookmarks):
    """구간(주계약·특약 등) 목록을 만듭니다. 북마크 → 목차 쪽 → 문서 전체 순으로 시도합니다."""
    npages = len(pages)
    printed_to_pdf = {}
    for p in pages:
        if p.get("printed_page") is not None:
            printed_to_pdf.setdefault(p["printed_page"], p["pdf_page"])
    starts, source, toc_pages = [], "", []
    top = [b for b in bookmarks if b[0] == 1]
    if len(top) >= 2:
        starts = [(b[2], b[1].strip()) for b in top if 1 <= b[2] <= npages]
        source = "북마크"
    else:
        toc = find_toc(pages)
        if toc:
            toc_pages = toc["pages"]
            for printed, title in toc["entries"]:
                pdf = printed_to_pdf.get(printed, printed)
                if 1 <= pdf <= npages:
                    starts.append((pdf, title))
            source = "목차 쪽"
    # 목차에 빠진 특약: 쪽 첫 줄이 큰 글씨의 '○○ 약관' 제목이면 새 구간으로 봅니다.
    known = [pg for pg, _ in starts]
    for p in pages:
        lines = p["lines"]
        if not lines:
            continue
        t = lines[0]["text"].strip()
        if t.endswith("약관") and lines[0].get("big") and len(t) < 90 and "목차" not in t:
            pn = p["pdf_page"]
            if not any(pn - 3 <= k <= pn for k in known):
                starts.append((pn, re.sub(r"\s*약관$", "", t)))
                known.append(pn)
                source = (source or "") + ("" if "본문 제목" in (source or "") else " + 본문 제목")
    starts = sorted(set(starts))
    sections = []
    if not starts or starts[0][0] > 1:
        first = starts[0][0] if starts else npages + 1
        sections.append({"title": "표지·목차" if starts else "문서 전체", "page_start": 1,
                         "page_end": first - 1})
    for k, (pg, title) in enumerate(starts):
        end = starts[k + 1][0] - 1 if k + 1 < len(starts) else npages
        sections.append({"title": title, "page_start": pg, "page_end": max(pg, end)})
    for k, s in enumerate(sections):
        s["id"] = f"S{k + 1:03d}"
        ref = s["title"] in ("표지·목차",) or any(w in s["title"] for w in REFERENCE_SECTION_WORDS)
        s["kind"] = "reference" if ref and s["title"] != "문서 전체" else "terms"
    return sections, source or "없음", toc_pages


# ---------------------------------------------------------------- 구간 안의 목차 쪽

def is_heading_line(text):
    t = text.strip()
    return bool(RE_PART.match(t) or RE_CHAPTER.match(t) or RE_SECTION.match(t)
                or re.match(r"^" + _ART_NUM + r"\s*[【(\[]", t) or RE_APPENDIX.match(t))


def section_toc_pages(pages, sec):
    """구간 맨 앞의 조문 목차 쪽(본문 없이 제목만 나열된 쪽)을 찾습니다."""
    out = []
    for pn in range(sec["page_start"], sec["page_end"] + 1):
        lines = [l for l in pages[pn - 1]["lines"] if l["text"].strip()]
        if not lines:
            if out:
                continue
            continue
        head = " ".join(l["text"] for l in lines[:4])
        heads = sum(1 for l in lines if is_heading_line(l["text"]))
        if ("목차" in head and heads >= 2) or (out and heads >= 0.7 * len(lines) and len(lines) >= 2):
            out.append(pn)
            continue
        if pn - sec["page_start"] > 3 or out:
            break
    return out


# ---------------------------------------------------------------- 조문 분해

class Builder:
    def __init__(self, sec, article_style):
        self.sec = sec
        self.style = article_style
        self.nodes = []
        self.counter = 0
        self.stack = {}  # level -> node
        self.cur = None
        self.note_box = None
        self.note_cont = False

    def new(self, kind, parent, num="", title="", label=""):
        self.counter += 1
        n = {"uid": f"{self.sec['id']}-n{self.counter:05d}", "section": self.sec["id"], "kind": kind,
             "parent": parent["uid"] if parent else None, "num": num, "title": title, "label": label,
             "text": "", "lines": []}
        self.nodes.append(n)
        return n

    def add_line(self, node, line, text):
        node["lines"].append({"p": line["p"], "bbox": line["bbox"]})
        node["text"] = (node["text"] + "\n" + text) if node["text"] else text
        if line.get("conf") is not None:
            node.setdefault("ocr_conf", []).append(line["conf"])

    def parent_for(self, kind):
        order = ["part", "chapter", "section", "article", "paragraph", "item", "subitem"]
        idx = order.index(kind)
        for k in reversed(order[:idx]):
            if self.stack.get(k):
                return self.stack[k]
        return None

    def reset_below(self, kind):
        order = ["part", "chapter", "section", "article", "paragraph", "item", "subitem"]
        idx = order.index(kind)
        for k in order[idx:]:
            self.stack[k] = None

    def open(self, kind, line, num, title, rest, label):
        parent = self.parent_for(kind)
        self.reset_below(kind)
        n = self.new(kind, parent, num=num, title=title, label=label)
        self.stack[kind] = n
        self.add_line(n, line, rest if kind in ("paragraph", "item", "subitem") else line["text"].strip())
        if kind in ("paragraph", "item", "subitem") and not rest:
            n["text"] = ""
        self.cur = n
        self.note_box = None
        return n

    def feed(self, line):
        t = line["text"].strip()
        if not t:
            return
        box = line.get("box")
        # 해설 상자(【설명】 등) 안의 줄
        if box:
            if self.note_box != box:
                cont = line.get("box_cont") and self.cur is not None and self.cur["kind"] == "note"
                if not cont:
                    owner = self.stack.get("article") or self.stack.get("appendix_holder")
                    m = RE_NOTE_HEAD.match(t)
                    note = self.new("note", owner, title=m.group(1) if m else "", label="해설")
                    self.cur = note
                self.note_box = box
            self.add_line(self.cur, line, t)
            return
        if line.get("line_no") == 0:
            self.note_cont = self.cur is not None and self.cur["kind"] == "note"
        if self.note_cont:
            # 앞 쪽 끝의 해설 상자가 이 쪽 위로 이어지는 경우: 상자 들여쓰기보다 안쪽에 있는 줄은 상자에 붙입니다.
            nx = min(l["bbox"][0] for l in self.cur["lines"]) if self.cur["lines"] else 0
            if line["bbox"][0] >= nx - 1.5 and not RE_ART_BRACKET.match(t):
                self.add_line(self.cur, line, t)
                return
            self.note_cont = False
            self.cur = self.last_structural()
        if self.note_box:
            self.note_box = None
            # 상자가 끝나면 상자 앞의 조각으로 돌아갑니다.
            self.cur = self.last_structural()

        m = RE_PART.match(t)
        if m and len(t) < 40:
            self.open("part", line, m.group(1), m.group(2).strip(), "", f"제{m.group(1)}편")
            return
        m = RE_CHAPTER.match(t)
        if m and len(t) < 50:
            self.open("chapter", line, m.group(1), m.group(2).strip(), "", f"제{m.group(1)}관")
            return
        m = RE_SECTION.match(t)
        if m and len(t) < 50:
            self.open("section", line, m.group(1), m.group(2).strip(), "", f"제{m.group(1)}절")
            return
        m = RE_ART_BRACKET.match(t) if self.style == "bracket" else RE_ART_PAREN.match(t)
        if m:
            num = norm_art_num(m.group(1)) + (f"의{m.group(2)}" if m.group(2) else "")
            self.open("article", line, num, m.group(3).strip(), "", art_label(num))
            self.stack["appendix_holder"] = None
            return
        m = RE_APPENDIX.match(t)
        if m and (line.get("line_no", 99) <= 2 or line.get("big")) and len(t) < 80:
            num = norm_art_num(m.group(1))
            self.reset_below("article")
            n = self.new("appendix", None, num=num, title=m.group(2).strip(), label=f"별표{num}")
            self.add_line(n, line, t)
            self.stack["appendix_holder"] = n
            self.stack["article"] = None
            self.cur = n
            return
        in_appendix = self.stack.get("appendix_holder") is not None and self.stack.get("article") is None
        if self.stack.get("article") is not None and not in_appendix:
            m = RE_PARA.match(t)
            art = self.stack["article"]
            ax = art["lines"][0]["bbox"][0] if art["lines"] else 0
            # 항 기호는 조문 제목 바로 안쪽에 옵니다. 더 들여 쓴 ①은 본문·예시 속 인용으로 봅니다.
            if m and line["bbox"][0] <= ax + 22:
                self.open("paragraph", line, str(circled_index(m.group(1))), "", m.group(2).strip(), m.group(1))
                return
            m = RE_ITEM.match(t)
            if m and self.plausible("item", int(m.group(1))):
                self.open("item", line, m.group(1), "", m.group(2).strip(), f"{m.group(1)}.")
                return
            m = RE_SUBITEM.match(t)
            if m and self.plausible("subitem", HANGUL_ITEMS.index(m.group(1)) + 1):
                self.open("subitem", line, m.group(1), "", m.group(2).strip(), f"{m.group(1)}.")
                return
        if self.cur is None:
            self.cur = self.new("preamble", None, label="머리말")
        self.add_line(self.cur, line, t)

    def plausible(self, kind, n):
        """호·목 기호가 진짜 번호인지 판단합니다.

        첫 번호(1., 가.)이거나 같은 단계의 앞 번호가 이미 있을 때만 새 조각으로 봅니다.
        줄바꿈으로 '…합니\n다. 다만'처럼 끊긴 줄을 목으로 읽지 않기 위해서입니다.
        """
        if n == 1:
            return True
        prev = self.stack.get(kind)
        return prev is not None and prev["parent"] == (self.parent_for(kind) or {}).get("uid")

    def last_structural(self):
        for k in ("subitem", "item", "paragraph", "article", "section", "chapter", "part"):
            if self.stack.get(k):
                return self.stack[k]
        return self.stack.get("appendix_holder") or self.cur


def detect_article_style(pages):
    br = 0
    for p in pages:
        for l in p["lines"]:
            if RE_ART_BRACKET.match(l["text"].strip()):
                br += 1
    return "bracket" if br >= 3 else "paren"


def parse_section(pages, sec, style, skip_pages):
    b = Builder(sec, style)
    for pn in range(sec["page_start"], sec["page_end"] + 1):
        if pn in skip_pages:
            continue
        for i, l in enumerate(pages[pn - 1]["lines"]):
            line = dict(l)
            line["p"] = pn
            line["line_no"] = i
            b.feed(line)
    return b.nodes


# ---------------------------------------------------------------- ID와 페이지 범위

def assign_ids(nodes):
    """조문 ID(예: 제12조-②-3-가)와 소속 경로, 시작·끝 페이지를 붙입니다."""
    by_uid = {n["uid"]: n for n in nodes}
    children = {}
    for n in nodes:
        children.setdefault(n["parent"], []).append(n)
    seen = {}
    for n in nodes:
        chain = []
        p = n
        while p is not None:
            chain.append(p)
            p = by_uid.get(p["parent"]) if p["parent"] else None
        chain.reverse()
        path = [c["label"] + (" " + c["title"] if c["title"] and c["kind"] in ("part", "chapter", "section", "article", "appendix") else "")
                for c in chain]
        n["path"] = " > ".join(x.strip() for x in path if x.strip())
        parts = []
        for c in chain:
            if c["kind"] == "article":
                parts.append(art_label(c["num"]))
            elif c["kind"] == "appendix":
                parts.append(f"별표{c['num']}")
            elif c["kind"] == "paragraph":
                parts.append(c["label"])
            elif c["kind"] in ("item", "subitem"):
                parts.append(c["num"])
            elif c["kind"] == "note":
                k = [x for x in children.get(c["parent"], []) if x["kind"] == "note"].index(c) + 1
                parts.append(f"해설{k}")
            elif c["kind"] == "preamble":
                parts.append("머리말")
            elif c["kind"] == "page_text":
                parts.append(f"p{c['lines'][0]['p']}" if c["lines"] else "쪽")
            elif c["kind"] in ("part", "chapter", "section"):
                parts.append(c["label"])
        if n["kind"] in ("part", "chapter", "section"):
            cid = "-".join(parts)
        else:
            cid = "-".join(p for p, c in zip(parts, chain) if c["kind"] not in ("part", "chapter", "section"))
        base = f"{n['section']}|{cid}"
        k = seen.get(base, 0) + 1
        seen[base] = k
        n["cid"] = base if k == 1 else f"{base}#{k}"
        n["dup"] = k > 1

    def span(n):
        ps = [l["p"] for l in n["lines"]]
        for c in children.get(n["uid"], []):
            a, b = span(c)
            if a:
                ps += [a, b]
        return (min(ps), max(ps)) if ps else (None, None)

    for n in nodes:
        own = [l["p"] for l in n["lines"]]
        n["page_start"], n["page_end"] = span(n)
        n["own_page_start"] = min(own) if own else n["page_start"]
    return nodes


LEVELS = {"part": 0, "chapter": 1, "section": 2, "article": 3, "paragraph": 4, "item": 5, "subitem": 6}
KIND_NAMES = {"part": "편", "chapter": "관", "section": "절", "article": "조", "paragraph": "항", "item": "호",
              "subitem": "목", "appendix": "별표", "note": "해설", "preamble": "머리말", "page_text": "쪽 본문"}


def make_label(kind, num):
    if kind == "article":
        return art_label(num)
    if kind == "paragraph":
        return CIRCLED[int(num) - 1] if str(num).isdigit() and 0 < int(num) <= len(CIRCLED) else f"({num})"
    if kind in ("item", "subitem"):
        return f"{num}."
    if kind in ("part", "chapter", "section"):
        return f"제{num}{KIND_NAMES[kind]}"
    if kind == "appendix":
        return f"별표{num}"
    return KIND_NAMES.get(kind, kind)


def relink(nodes):
    """문서 순서대로 놓인 조각 목록에서 상하 관계(parent)를 다시 계산합니다.

    수정(나누기·합치기·종류 변경) 뒤에도 같은 규칙으로 트리가 만들어지게 합니다.
    """
    stack = {}
    holder = None
    section = None
    for n in nodes:
        if n["section"] != section:
            stack, holder, section = {}, None, n["section"]
        k = n["kind"]
        if k in LEVELS:
            lv = LEVELS[k]
            parent = None
            for j in range(lv - 1, -1, -1):
                cand = stack.get(j)
                if cand is not None:
                    parent = cand
                    break
            n["parent"] = parent["uid"] if parent else None
            for j in list(stack):
                if j >= lv:
                    del stack[j]
            stack[lv] = n
            if k == "article":
                holder = None
        elif k == "appendix":
            n["parent"] = None
            for j in list(stack):
                if j >= LEVELS["article"]:
                    del stack[j]
            holder = n
        elif k == "note":
            owner = stack.get(LEVELS["article"]) or holder
            n["parent"] = owner["uid"] if owner else None
        else:
            n["parent"] = None
    return nodes
