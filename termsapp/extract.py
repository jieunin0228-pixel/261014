"""페이지 단위 추출: 좌표 기반 줄 복원(띄어쓰기·2단), 머리글·바닥글, 인쇄 쪽번호, 표, OCR.

AI를 쓰지 않고 PyMuPDF만으로 처리합니다.
"""
import collections
import re
import shutil
import subprocess
import tempfile
import os

import pymupdf

HEADER_BAND = 0.075   # 위·아래 7.5% 구간을 머리글·바닥글 후보로 봅니다.
SPACE_GAP_RATIO = 0.2  # 글자 간격이 글자 크기의 20%를 넘으면 띄어쓰기로 봅니다.
PAGE_NO_RE = re.compile(r"^[-–—\s]*(\d{1,4})[-–—\s]*$")


# ---------------------------------------------------------------- 줄 복원

def _raw_lines(page):
    """PyMuPDF 줄 단위로 글자와 좌표를 모읍니다."""
    rd = page.get_text("rawdict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_MEDIABOX_CLIP)
    out = []
    for b in rd["blocks"]:
        if b.get("type") != 0:
            continue
        for l in b["lines"]:
            chars = []
            for s in l["spans"]:
                for c in s["chars"]:
                    chars.append({"c": c["c"], "bbox": c["bbox"], "size": s["size"], "font": s["font"]})
            if any(ch["c"].strip() for ch in chars):
                out.append({"bbox": list(l["bbox"]), "chars": chars})
    return out


def _chars_to_text(chars):
    """글자 사이 간격으로 띄어쓰기를 복원합니다(공백 문자가 없는 PDF 대응)."""
    chars = sorted(chars, key=lambda c: c["bbox"][0])
    out = []
    prev = None
    for c in chars:
        ch = c["c"]
        if prev is not None:
            gap = c["bbox"][0] - prev["bbox"][2]
            if gap > SPACE_GAP_RATIO * max(c["size"], 1) and not ch.isspace() and not prev["c"].isspace():
                out.append(" ")
        out.append(ch)
        prev = c
    text = "".join(out)
    text = re.sub(r"[  \t]+", " ", text).strip()
    return text


def _merge_same_baseline(lines):
    """같은 높이에 있는 조각 줄을 한 줄로 합칩니다."""
    lines = sorted(lines, key=lambda l: ((l["bbox"][1] + l["bbox"][3]) / 2, l["bbox"][0]))
    merged = []
    for l in lines:
        cy = (l["bbox"][1] + l["bbox"][3]) / 2
        h = l["bbox"][3] - l["bbox"][1]
        if merged:
            m = merged[-1]
            mcy = (m["bbox"][1] + m["bbox"][3]) / 2
            mh = m["bbox"][3] - m["bbox"][1]
            if abs(cy - mcy) < 0.5 * min(h, mh) and l["bbox"][0] >= m["bbox"][2] - 2:
                m["chars"] = m["chars"] + l["chars"]
                m["bbox"] = [min(m["bbox"][0], l["bbox"][0]), min(m["bbox"][1], l["bbox"][1]),
                             max(m["bbox"][2], l["bbox"][2]), max(m["bbox"][3], l["bbox"][3])]
                continue
        merged.append({"bbox": list(l["bbox"]), "chars": list(l["chars"])})
    return merged


def detect_columns(lines, width):
    """2단 편집이면 가운데 경계 x좌표를, 아니면 None을 돌려줍니다."""
    mid = width / 2
    body = [l for l in lines if (l["bbox"][2] - l["bbox"][0]) > width * 0.08]
    if len(body) < 10:
        return None
    left = sum(1 for l in body if l["bbox"][2] <= mid + 4)
    right = sum(1 for l in body if l["bbox"][0] >= mid - 4)
    span = len(body) - left - right
    if left >= 5 and right >= 5 and span <= 0.1 * len(body):
        return mid
    return None


def page_lines(page, exclude_rects=()):
    """페이지의 읽기 순서대로 정렬된 줄 목록을 돌려줍니다.

    exclude_rects 안에 중심이 있는 줄(표 영역)은 빼고 돌려줍니다.
    """
    raw = _raw_lines(page)
    kept = []
    for l in raw:
        cx = (l["bbox"][0] + l["bbox"][2]) / 2
        cy = (l["bbox"][1] + l["bbox"][3]) / 2
        if any(r[0] <= cx <= r[2] and r[1] <= cy <= r[3] for r in exclude_rects):
            continue
        kept.append(l)
    width = page.rect.width
    split = detect_columns(kept, width)
    if split is None:
        groups = [kept]
    else:
        groups = [[l for l in kept if (l["bbox"][0] + l["bbox"][2]) / 2 < split],
                  [l for l in kept if (l["bbox"][0] + l["bbox"][2]) / 2 >= split]]
    out = []
    for col, g in enumerate(groups):
        for m in _merge_same_baseline(g):
            text = _chars_to_text(m["chars"])
            if not text:
                continue
            sizes = [c["size"] for c in m["chars"] if c["c"].strip()]
            fonts = collections.Counter(c["font"] for c in m["chars"] if c["c"].strip())
            out.append({
                "text": text,
                "bbox": [round(v, 1) for v in m["bbox"]],
                "size": round(max(sizes) if sizes else 0, 1),
                "font": fonts.most_common(1)[0][0] if fonts else "",
                "col": col,
            })
    return out, (split is not None)


# ---------------------------------------------------------------- 머리글·바닥글

def _norm_hf(text):
    return re.sub(r"\d+", "#", re.sub(r"\s+", "", text))


def strip_headers_footers(pages):
    """pages[i]['lines']에서 머리글·바닥글을 떼어 내고 인쇄 쪽번호를 기록합니다.

    - 위·아래 띠 안의 숫자만 있는 줄은 인쇄 쪽번호로 봅니다.
    - 위·아래 띠 안에서 3쪽 이상 반복되는 문구는 머리글·바닥글로 봅니다.
    """
    counts = collections.Counter()
    for p in pages:
        h = p["height"]
        seen = set()
        for l in p["lines"]:
            if l["bbox"][3] < h * HEADER_BAND or l["bbox"][1] > h * (1 - HEADER_BAND):
                seen.add(_norm_hf(l["text"]))
        counts.update(seen)
    for p in pages:
        h = p["height"]
        body, hf = [], []
        printed = None
        for l in p["lines"]:
            in_band = l["bbox"][3] < h * HEADER_BAND or l["bbox"][1] > h * (1 - HEADER_BAND)
            if in_band:
                m = PAGE_NO_RE.match(l["text"])
                if m:
                    printed = int(m.group(1))
                    hf.append(l["text"])
                    continue
                if counts[_norm_hf(l["text"])] >= 3:
                    hf.append(l["text"])
                    continue
            body.append(l)
        p["lines"] = body
        p["header_footer"] = hf
        p["printed_page"] = printed


# ---------------------------------------------------------------- 표

def _clean_table(rows):
    rows = [[(c or "").strip() for c in r] for r in rows]
    rows = [r for r in rows if any(r)]
    if not rows:
        return []
    ncol = max(len(r) for r in rows)
    rows = [r + [""] * (ncol - len(r)) for r in rows]
    keep = [j for j in range(ncol) if any(r[j] for r in rows)]
    return [[r[j] for j in keep] for r in rows]


def _chars_in_rect(raw_lines, rect):
    n = 0
    for l in raw_lines:
        for c in l["chars"]:
            if not c["c"].strip():
                continue
            cx = (c["bbox"][0] + c["bbox"][2]) / 2
            cy = (c["bbox"][1] + c["bbox"][3]) / 2
            if rect[0] <= cx <= rect[2] and rect[1] <= cy <= rect[3]:
                n += 1
    return n


def _text_len(rows):
    return sum(len(re.sub(r"\s", "", c)) for r in rows for c in r)


def _rebuild_table(page, t, raw):
    """머리줄(첫 행) 칸의 x 범위를 열로, 표 안의 가로선을 행 경계로 삼아 글자를 배치합니다."""
    if not t.rows:
        return None
    head = t.rows[0]
    cols = [c for c in head.cells if c and (c[2] - c[0]) >= 8]
    if len(cols) < 2:
        return None
    x0, y0, x1, y1 = t.bbox
    top = head.bbox[3]
    seps = {round(top, 1), round(y1, 1)}
    for d in page.get_drawings():
        for it in d["items"]:
            if it[0] == "l":
                a, b = it[1], it[2]
                if abs(a.y - b.y) < 1.5 and abs(a.x - b.x) > 30 and top + 3 < a.y < y1 - 3:
                    seps.add(round(a.y, 1))
            elif it[0] == "re":
                r = it[1]
                if r.height < 1.5 and r.width > 30 and top + 3 < r.y0 < y1 - 3:
                    seps.add(round(r.y0, 1))
    seps = sorted(seps)
    bands = [(head.bbox[1], top)] + [(a, b) for a, b in zip(seps, seps[1:]) if b - a > 4]
    grid = [[[] for _ in cols] for _ in bands]
    for l in raw:
        for c in l["chars"]:
            if not c["c"].strip():
                continue
            cx = (c["bbox"][0] + c["bbox"][2]) / 2
            cy = (c["bbox"][1] + c["bbox"][3]) / 2
            if not (x0 <= cx <= x1 and y0 <= cy <= y1):
                continue
            ri = next((k for k, (a, b) in enumerate(bands) if a <= cy <= b), None)
            if ri is None:
                continue
            ci = min(range(len(cols)), key=lambda k: 0 if cols[k][0] <= cx <= cols[k][2]
                     else min(abs(cx - cols[k][0]), abs(cx - cols[k][2])))
            grid[ri][ci].append(c)
    rows = []
    for r in grid:
        row = []
        for chars in r:
            lines = {}
            for c in chars:
                key = round((c["bbox"][1] + c["bbox"][3]) / 2 / 3)
                lines.setdefault(key, []).append(c)
            row.append("\n".join(_chars_to_text(lines[k]) for k in sorted(lines)))
        rows.append(row)
    return _clean_table(rows)


def extract_tables(page):
    """선이 그려진 표를 찾아 행·열 구조로 돌려줍니다.

    돌려주는 항목: kind('table' 또는 'box'), bbox, rows, incomplete, reasons.
    열·행이 2개 미만인 테두리 상자(【설명】 상자 등)는 'box'로 돌려주며, 본문에서 빼지 않습니다.
    """
    if len(page.get_drawings()) < 2:
        return []
    try:
        found = page.find_tables()
    except Exception:  # 표 탐지 실패는 표 없음으로 처리하고 보고서에서 다룹니다.
        return []
    raw = None
    out = []
    for t in found.tables:
        rows = _clean_table(t.extract())
        bbox = [round(v, 1) for v in t.bbox]
        head = "".join(rows[0]).strip() if rows else ""
        if len(rows) < 2 or len(rows[0]) < 2 or head.startswith("【"):
            # 테두리만 있는 상자: 【설명】·【예시】 같은 해설 상자이며 본문 줄로 남깁니다.
            out.append({"kind": "box", "bbox": bbox, "rows": rows, "incomplete": False, "reasons": [],
                        "title": head if head.startswith("【") else ""})
            continue
        reasons = []
        rebuilt = False
        if raw is None:
            raw = _raw_lines(page)
        inside = _chars_in_rect(raw, bbox)
        if inside and _text_len(rows) < inside * 0.9:
            # 세로선이 없는 표: 머리줄 칸 위치와 가로선으로 글자를 칸에 다시 배치합니다.
            alt = _rebuild_table(page, t, raw)
            if alt and _text_len(alt) > _text_len(rows):
                rows, rebuilt = alt, True
        cells = [c for r in rows for c in r]
        empty = sum(1 for c in cells if not c) / len(cells)
        if empty > 0.75:  # 병합 셀은 빈 칸으로 남으므로 높은 기준만 경고합니다.
            reasons.append(f"빈 칸 비율 {empty:.0%}")
        got = _text_len(rows)
        if inside and got < inside * 0.9:
            reasons.append(f"표 영역 글자 {inside}자 중 {got}자만 추출")
        out.append({"kind": "table", "bbox": bbox, "rows": rows, "rebuilt": rebuilt,
                    "incomplete": bool(reasons), "reasons": reasons})
    return out


def drawn_boxes(page, lines, known):
    """그려진 사각형 중 첫 줄이 【…】로 시작하는 것을 해설 상자로 봅니다(표 탐지가 놓친 한 칸 상자)."""
    W, H = page.rect.width, page.rect.height
    out = []
    for d in page.get_drawings():
        r = d.get("rect")
        if r is None or r.width < W * 0.4 or not (12 < r.height < H * 0.8):
            continue
        rect = [round(r.x0, 1), round(r.y0, 1), round(r.x1, 1), round(r.y1, 1)]
        # 이미 찾은 상자·표 안에 들어가는 사각형(제목 띠, 배경 칠)은 건너뜁니다.
        if any(k[0] - 3 <= rect[0] and k[1] - 3 <= rect[1] and rect[2] <= k[2] + 3 and rect[3] <= k[3] + 3
               for k in known + [b["bbox"] for b in out]):
            continue
        inside = [l for l in lines if rect[0] <= (l["bbox"][0] + l["bbox"][2]) / 2 <= rect[2]
                  and rect[1] <= (l["bbox"][1] + l["bbox"][3]) / 2 <= rect[3]]
        if inside and min(inside, key=lambda l: l["bbox"][1])["text"].startswith("【"):
            out.append({"kind": "box", "bbox": rect, "rows": [], "incomplete": False, "reasons": [],
                        "title": min(inside, key=lambda l: l["bbox"][1])["text"]})
    return out


# ---------------------------------------------------------------- OCR

def tesseract_available():
    return shutil.which("tesseract") is not None


def ocr_page(page, lang="kor+eng"):
    """로컬 Tesseract로 OCR을 수행합니다. 외부로 전송하지 않습니다.

    돌려주는 값: 줄 목록(text, bbox, conf). 좌표는 PDF 좌표계입니다.
    """
    zoom = 300 / 72
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
    with tempfile.TemporaryDirectory() as td:
        img = os.path.join(td, "p.png")
        pix.save(img)
        res = subprocess.run(["tesseract", img, "stdout", "-l", lang, "tsv"],
                             capture_output=True, text=True, timeout=300)
    lines = collections.OrderedDict()
    for row in res.stdout.splitlines()[1:]:
        f = row.split("\t")
        if len(f) < 12 or not f[11].strip():
            continue
        key = (f[2], f[3], f[4])  # block, paragraph, line
        x, y, w, h, conf = int(f[6]), int(f[7]), int(f[8]), int(f[9]), float(f[10])
        bb = [x / zoom, y / zoom, (x + w) / zoom, (y + h) / zoom]
        e = lines.setdefault(key, {"words": [], "bbox": bb, "confs": []})
        e["words"].append(f[11])
        e["confs"].append(conf)
        e["bbox"] = [min(e["bbox"][0], bb[0]), min(e["bbox"][1], bb[1]),
                     max(e["bbox"][2], bb[2]), max(e["bbox"][3], bb[3])]
    out = []
    for e in lines.values():
        out.append({"text": " ".join(e["words"]), "bbox": [round(v, 1) for v in e["bbox"]],
                    "size": round(e["bbox"][3] - e["bbox"][1], 1), "font": "OCR", "col": 0,
                    "conf": round(sum(e["confs"]) / len(e["confs"]), 1)})
    return out


def image_ratio(page):
    area = page.rect.width * page.rect.height
    covered = 0.0
    for im in page.get_images(full=True):
        try:
            for r in page.get_image_rects(im[0]):
                r = r & page.rect
                covered += max(0, r.width) * max(0, r.height)
        except Exception:
            pass
    return min(1.0, covered / area) if area else 0.0
