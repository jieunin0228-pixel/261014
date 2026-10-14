"""1단계-A: PDF 쪽 단위 추출 (AI 없이, 외부 전송 없이).

각 쪽에서 다음을 뽑습니다.
- 좌표 기준으로 재구성한 줄(텍스트 스트림 순서가 아니라 y 좌표 순서). 샘플 약관은 머리글이
  스트림 끝에 나오고, 양쪽 정렬 줄이 단어 단위로 쪼개져 나오므로 좌표 기준 재구성이 필요합니다.
- 머리글(쪽 상단 영역), 꼬리글(쪽 하단 영역, 인쇄 쪽번호)
- 표 영역(tables.extract_tables)
- 스캔형 쪽 판정과 로컬 OCR(설치된 경우)
"""
from __future__ import annotations

import re
import statistics
import unicodedata

import pymupdf

from . import tables as tablemod

HEADER_ZONE = 0.07   # 쪽 높이 대비 상단 7% 안의 작은 글씨를 머리글로 봅니다.
FOOTER_ZONE = 0.94   # 쪽 높이 대비 하단 6% 안을 꼬리글로 봅니다.
HEADER_MAX_SIZE = 10.6
LOW_TEXT_CHARS = 80
OCR_LOW_CONF = 70


def norm_text(s: str) -> str:
    """대조용 정규화: NFKC, 공백 제거, 가운뎃점 통일."""
    s = unicodedata.normalize("NFKC", s or "")
    s = re.sub(r"[ㆍ·∙•‧]", "·", s)
    return re.sub(r"\s+", "", s)


WORD_GAP = 0.18   # 글자 사이 간격이 글자 크기의 18%를 넘으면 띄어쓰기로 봅니다.


def page_words(rd):
    """rawdict의 글자 좌표로 단어를 만듭니다.

    일부 쪽은 텍스트 층에 띄어쓰기 문자가 없고 글자 간격으로만 띄어 쓰여 있어(예: '이특약에있어서'),
    글자 사이 간격으로 띄어쓰기를 복원합니다. 반환: [x0, y0, x1, y1, text, size, flags]
    """
    words = []
    for b in rd["blocks"]:
        if b.get("type") != 0:
            continue
        for l in b["lines"]:
            for s in l["spans"]:
                size = s["size"]
                cur = None
                prev = None
                for c in s["chars"]:
                    ch = c["c"]
                    x0, y0, x1, y1 = c["bbox"]
                    if ch.isspace():
                        if cur:
                            words.append(cur)
                        cur, prev = None, None
                        continue
                    if cur is not None and prev is not None and x0 - prev[2] > WORD_GAP * size:
                        words.append(cur)
                        cur = None
                    if cur is None:
                        cur = [x0, y0, x1, y1, ch, size, s.get("flags", 0)]
                    else:
                        cur[0] = min(cur[0], x0)
                        cur[1] = min(cur[1], y0)
                        cur[2] = max(cur[2], x1)
                        cur[3] = max(cur[3], y1)
                        cur[4] += ch
                    prev = c["bbox"]
                if cur:
                    words.append(cur)
    return words


def _build_lines(words):
    """단어를 y 중심 기준으로 묶어 줄을 만듭니다(텍스트 스트림 순서가 아닌 좌표 순서)."""
    spans = [{"text": w[4], "bbox": w[:4], "size": w[5], "flags": w[6]} for w in words if w[4].strip()]
    spans.sort(key=lambda s: ((s["bbox"][1] + s["bbox"][3]) / 2, s["bbox"][0]))
    rows = []
    for s in spans:
        yc = (s["bbox"][1] + s["bbox"][3]) / 2
        h = max(2.0, s["bbox"][3] - s["bbox"][1])
        if rows:
            r = rows[-1]
            if abs(yc - r["yc"]) <= max(1.5, 0.4 * min(h, r["h"])):
                r["spans"].append(s)
                continue
        rows.append({"yc": yc, "h": h, "spans": [s]})
    lines = []
    for r in rows:
        ss = sorted(r["spans"], key=lambda s: s["bbox"][0])
        text = ""
        prev = None
        for s in ss:
            t = s["text"]
            if prev is not None:
                gap = s["bbox"][0] - prev["bbox"][2]
                if gap > 0.12 * max(s["size"], 1):
                    text += " "
            text += t
            prev = s
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            continue
        x0 = min(s["bbox"][0] for s in ss)
        y0 = min(s["bbox"][1] for s in ss)
        x1 = max(s["bbox"][2] for s in ss)
        y1 = max(s["bbox"][3] for s in ss)
        size = max(s["size"] for s in ss)
        bold = any(s.get("flags", 0) & 16 for s in ss)
        lines.append({"t": text, "b": [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)],
                      "s": round(size, 1), "bold": bold})
    return lines


def _image_coverage(page, dd):
    area = page.rect.width * page.rect.height
    cov = 0.0
    for b in dd["blocks"]:
        if b.get("type") == 1:
            x0, y0, x1, y1 = b["bbox"]
            cov += max(0, x1 - x0) * max(0, y1 - y0)
    return min(1.0, cov / area) if area else 0.0


def ocr_available():
    try:
        import pytesseract  # noqa: F401
        pytesseract.get_tesseract_version()
        langs = pytesseract.get_languages(config="")
        return "kor" in langs
    except Exception:
        return False


def _ocr_page(page):
    """로컬 Tesseract(한국어)로 OCR 합니다. 줄별 평균 신뢰도를 함께 돌려줍니다."""
    import pytesseract
    from PIL import Image  # pytesseract 의존 패키지
    import io

    zoom = 300 / 72
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    data = pytesseract.image_to_data(img, lang="kor+eng", output_type=pytesseract.Output.DICT)
    groups = {}
    for i, w in enumerate(data["text"]):
        if not w.strip():
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        groups.setdefault(key, []).append(i)
    lines = []
    for key, idx in groups.items():
        words = [data["text"][i] for i in idx]
        confs = [float(data["conf"][i]) for i in idx if float(data["conf"][i]) >= 0]
        x0 = min(data["left"][i] for i in idx) / zoom
        y0 = min(data["top"][i] for i in idx) / zoom
        x1 = max(data["left"][i] + data["width"][i] for i in idx) / zoom
        y1 = max(data["top"][i] + data["height"][i] for i in idx) / zoom
        conf = round(sum(confs) / len(confs), 1) if confs else 0.0
        text = " ".join(words)
        if words and sum(1 for w in words if len(w) == 1) >= 0.6 * len(words):
            # 한국어 OCR이 글자마다 띄어 쓰는 경우를 붙입니다(예: '제 7 3 2 조' → '제732조').
            text = re.sub(r"(?<=[가-힣0-9]) (?=[가-힣0-9])", "", text)
        lines.append({"t": text, "b": [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)],
                      "s": round((y1 - y0) * 0.8, 1), "bold": False, "conf": conf})
    lines.sort(key=lambda l: (l["b"][1], l["b"][0]))
    return lines


def extract_page(page, pno, use_ocr):
    W, H = page.rect.width, page.rect.height
    dd = page.get_text("rawdict")
    words = page_words(dd)
    lines = _build_lines(words)
    img_cov = _image_coverage(page, dd)
    chars = sum(len(l["t"]) for l in lines)
    scanned = chars < 30 and img_cov > 0.5
    ocr = None
    if scanned:
        if use_ocr:
            lines = _ocr_page(page)
            confs = [l["conf"] for l in lines]
            ocr = {"done": True, "avg_conf": round(statistics.mean(confs), 1) if confs else 0.0,
                   "low_lines": [i for i, l in enumerate(lines) if l["conf"] < OCR_LOW_CONF]}
        else:
            ocr = {"done": False, "reason": "OCR 엔진(Tesseract 한국어) 미설치"}

    header, footer, body = [], [], []
    for l in lines:
        y0, y1 = l["b"][1], l["b"][3]
        if y1 < H * HEADER_ZONE and l["s"] <= HEADER_MAX_SIZE and not l["t"].isdigit():
            header.append(l)
        elif y0 > H * FOOTER_ZONE:
            footer.append(l)
        else:
            body.append(l)
    footer_text = " ".join(l["t"] for l in footer).strip()
    m = re.fullmatch(r"-?\s*(\d{1,4})\s*-?", footer_text)
    # 쪽 상단에 쪽번호만 있는 경우(목차 쪽 등)도 인쇄 쪽번호로 인정합니다.
    printed = int(m.group(1)) if m else None
    if printed is None:
        for l in lines:
            if l["b"][3] < H * HEADER_ZONE and l["t"].isdigit():
                printed = int(l["t"])
                break

    header_text = " ".join(l["t"] for l in header).strip()
    body_chars = sum(len(l["t"]) for l in body)
    tbls = tablemod.extract_tables(page, pno, [w[:5] for w in words])
    return {
        "p": pno,
        "w": round(W, 1), "h": round(H, 1),
        "header": header_text,
        "header_norm": norm_text(header_text),
        "footer": footer_text,
        "printed": printed,
        "lines": body,
        "chars": body_chars,
        "low_text": body_chars < LOW_TEXT_CHARS,
        "img_cov": round(img_cov, 2),
        "scanned": scanned,
        "ocr": ocr,
        "tables": tbls,
    }


def extract_pdf(path, progress=None):
    doc = pymupdf.open(path)
    use_ocr = None
    pages = []
    n = doc.page_count
    for i, page in enumerate(doc):
        if use_ocr is None:
            use_ocr = False
        pg = extract_page(page, i + 1, use_ocr=False)
        if pg["scanned"]:
            if use_ocr is False and ocr_available():
                use_ocr = True
            if use_ocr:
                pg = extract_page(page, i + 1, use_ocr=True)
        pages.append(pg)
        if progress and (i % 10 == 0 or i == n - 1):
            progress("텍스트·표 추출", (i + 1) / n, f"{i + 1}/{n}쪽")
    meta = {"page_count": n, "metadata": doc.metadata, "ocr_engine": bool(use_ocr)}
    doc.close()
    return pages, meta
