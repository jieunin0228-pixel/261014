"""표 추출: 쪽의 벡터 그림(괘선·칸 사이 여백)으로 격자를 만들고 글자를 칸에 배정합니다.

샘플 약관의 표는 선(line)이 아니라 채움 사각형으로 그려져 있습니다.
- 행 구분: 진한 색의 얇은 가로 사각형(높이 2.5pt 이하)
- 열 구분: 흰색의 좁은 세로 사각형(폭 4.5pt 이하) 또는 진한 세로 괘선
- 칸 배경: 연한 색 채움(경계로 쓰지 않음)
범용 표 추출기(PyMuPDF find_tables, pdfplumber)는 이 형식에서 병합 칸의 글자를 잃으므로
직접 격자를 복원합니다. 병합 칸이 직사각형이 아니거나 칸에 배정되지 않은 글자가 있으면
"표 추출 불완전"으로 표시합니다. 표를 문장으로 풀어 쓰지 않습니다.
"""
from __future__ import annotations


def _lum(c):
    if c is None:
        return None
    if isinstance(c, (int, float)):
        return float(c)
    if len(c) == 1:
        return float(c[0])
    if len(c) == 3:
        return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
    if len(c) == 4:  # CMYK
        return 1 - min(1, 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2] + c[3])
    return None


def _primitives(page):
    """괘선·여백 후보를 (종류, x0, y0, x1, y1)로 돌려줍니다."""
    prims = []
    for d in page.get_drawings():
        fill_l = _lum(d.get("fill"))
        stroke_l = _lum(d.get("color"))
        for it in d["items"]:
            if it[0] == "re":
                r = it[1]
                rects = [(r.x0, r.y0, r.x1, r.y1)]
            elif it[0] == "l":
                p1, p2 = it[1], it[2]
                rects = [(min(p1.x, p2.x), min(p1.y, p2.y), max(p1.x, p2.x), max(p1.y, p2.y))]
            elif it[0] == "qu":
                q = it[1].rect
                rects = [(q.x0, q.y0, q.x1, q.y1)]
            else:
                continue
            for (x0, y0, x1, y1) in rects:
                w, h = x1 - x0, y1 - y0
                if d["type"] in ("f", "fs") and fill_l is not None:
                    if fill_l < 0.6 and h <= 2.5 and w >= 6:
                        prims.append(("h", x0, y0, x1, y1))
                    elif fill_l < 0.6 and w <= 2.5 and h >= 5:
                        prims.append(("v", x0, y0, x1, y1))
                    elif fill_l > 0.97 and w <= 4.5 and h >= 4:
                        prims.append(("v", x0, y0, x1, y1))
                    elif fill_l >= 0.6 and w > 6 and h > 6:
                        prims.append(("cell", x0, y0, x1, y1))
                if d["type"] in ("s", "fs") and stroke_l is not None and stroke_l < 0.8:
                    if it[0] == "re" and w > 6 and h > 6:
                        prims += [("h", x0, y0 - 0.5, x1, y0 + 0.5), ("h", x0, y1 - 0.5, x1, y1 + 0.5),
                                  ("v", x0 - 0.5, y0, x0 + 0.5, y1), ("v", x1 - 0.5, y0, x1 + 0.5, y1)]
                    elif h <= 1.5 and w >= 6:
                        prims.append(("h", x0, y0 - 0.5, x1, y1 + 0.5))
                    elif w <= 1.5 and h >= 5:
                        prims.append(("v", x0 - 0.5, y0, x1 + 0.5, y1))
    return prims


def _cluster(prims, tol=3.5):
    """겹치거나 가까운 도형을 묶어 표 후보 영역을 만듭니다."""
    n = len(prims)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    boxes = [p[1:] for p in prims]
    order = sorted(range(n), key=lambda i: boxes[i][1])
    active = []
    for i in order:
        x0, y0, x1, y1 = boxes[i]
        active = [j for j in active if boxes[j][3] + tol >= y0]
        for j in active:
            a0, b0, a1, b1 = boxes[j]
            if a0 - tol <= x1 and x0 - tol <= a1 and b0 - tol <= y1 and y0 - tol <= b1:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[ri] = rj
        active.append(i)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(prims[i])
    return list(groups.values())


def _merge_positions(vals, tol=2.0):
    vals = sorted(vals)
    out = []
    for v in vals:
        if out and v - out[-1][-1] <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return [sum(g) / len(g) for g in out]


def _overlap(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def _grid_from_group(g, words, page_no):
    hs = [p for p in g if p[0] == "h"]
    vs = [p for p in g if p[0] == "v"]
    cells_bg = [p for p in g if p[0] == "cell"]
    X0 = min(p[1] for p in g)
    Y0 = min(p[2] for p in g)
    X1 = max(p[3] for p in g)
    Y1 = max(p[4] for p in g)
    if X1 - X0 < 40 or Y1 - Y0 < 12:
        return None
    hy = _merge_positions([(p[2] + p[4]) / 2 for p in hs if (p[3] - p[1]) >= 0.15 * (X1 - X0) or True])
    vx = _merge_positions([(p[1] + p[3]) / 2 for p in vs])
    # 표 외곽을 경계로 추가
    ys = _merge_positions([Y0] + hy + [Y1])
    xs = _merge_positions([X0] + [x for x in vx if X0 + 3 < x < X1 - 3] + [X1])
    rows = [(ys[i], ys[i + 1]) for i in range(len(ys) - 1) if ys[i + 1] - ys[i] > 3]
    cols = [(xs[i], xs[i + 1]) for i in range(len(xs) - 1) if xs[i + 1] - xs[i] > 5]
    if len(rows) < 1 or len(cols) < 1:
        return None
    if len(hs) < 2 and not cells_bg:
        return None
    nr, nc = len(rows), len(cols)

    def vboundary(i, j):  # 행 i에서 열 j와 j+1 사이 경계
        x = cols[j][1]
        r0, r1 = rows[i]
        for p in vs:
            if p[1] - 2 <= x <= p[3] + 2 and _overlap(r0, r1, p[2], p[4]) >= 0.5 * (r1 - r0):
                return True
        return False

    def hboundary(i, j):  # 열 j에서 행 i와 i+1 사이 경계
        y = rows[i][1]
        c0, c1 = cols[j]
        for p in hs:
            if p[2] - 2 <= y <= p[4] + 2 and _overlap(c0, c1, p[1], p[3]) >= 0.5 * (c1 - c0):
                return True
        return False

    parent = {(i, j): (i, j) for i in range(nr) for j in range(nc)}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i in range(nr):
        for j in range(nc - 1):
            if not vboundary(i, j):
                union((i, j), (i, j + 1))
    for i in range(nr - 1):
        for j in range(nc):
            if not hboundary(i, j):
                union((i, j), (i + 1, j))
    regions = {}
    for k in parent:
        regions.setdefault(find(k), []).append(k)
    problems = []
    cells = []
    owner = {}
    for members in regions.values():
        ri = [m[0] for m in members]
        cj = [m[1] for m in members]
        r0, r1, c0, c1 = min(ri), max(ri), min(cj), max(cj)
        if len(members) != (r1 - r0 + 1) * (c1 - c0 + 1):
            problems.append("병합 칸 모양이 직사각형이 아님")
        cell = {"r": r0, "c": c0, "rs": r1 - r0 + 1, "cs": c1 - c0 + 1, "words": []}
        cells.append(cell)
        for m in members:
            owner[m] = cell

    def locate(x, y):
        ri = next((i for i, (a, b) in enumerate(rows) if a - 1 <= y <= b + 1), None)
        cj = next((j for j, (a, b) in enumerate(cols) if a - 1 <= x <= b + 1), None)
        if ri is None or cj is None:
            return None
        return owner.get((ri, cj))

    unassigned = 0
    used = []
    for w in words:
        x0, y0, x1, y1, t = w[:5]
        xc, yc = (x0 + x1) / 2, (y0 + y1) / 2
        if not (X0 - 1 <= xc <= X1 + 1 and Y0 - 1 <= yc <= Y1 + 1):
            continue
        used.append(w)
        cell = locate(xc, yc)
        if cell is None:
            unassigned += 1
            continue
        cell["words"].append(w)
    if not used:
        return None
    if unassigned:
        problems.append(f"칸에 배정되지 않은 글자 {unassigned}개")

    for cell in cells:
        ws = sorted(cell.pop("words"), key=lambda w: ((w[1] + w[3]) / 2, w[0]))
        lines = []
        for w in ws:
            yc = (w[1] + w[3]) / 2
            if lines and abs(yc - lines[-1]["yc"]) <= 0.5 * (w[3] - w[1]):
                lines[-1]["ws"].append(w)
            else:
                lines.append({"yc": yc, "ws": [w]})
        out = []
        for ln in lines:
            ws2 = sorted(ln["ws"], key=lambda w: w[0])
            s = ""
            prev = None
            for w in ws2:
                if prev is not None and w[0] - prev[2] > 1.0:
                    s += " "
                s += w[4]
                prev = w
            out.append(s)
        cell["text"] = "\n".join(out)
    cells.sort(key=lambda c: (c["r"], c["c"]))
    grid = [[None] * nc for _ in range(nr)]
    for c in cells:
        grid[c["r"]][c["c"]] = c["text"]
        for i in range(c["r"], c["r"] + c["rs"]):
            for j in range(c["c"], c["c"] + c["cs"]):
                if (i, j) != (c["r"], c["c"]):
                    grid[i][j] = None
    # 빈 행·열(경계만 있고 글자가 없는 얇은 띠)은 그대로 두되 표시만 합니다.
    first = next((c["text"].strip() for c in cells if c["text"].strip()), "")
    kind = "table"
    if first.startswith("【"):
        kind = "box"   # 약관 안의 설명 상자(【유의사항】·【예시】 등)
    elif nc == 1 and nr <= 2:
        kind = "box"
    return {
        "page": page_no,
        "bbox": [round(X0, 1), round(Y0, 1), round(X1, 1), round(Y1, 1)],
        "n_rows": nr, "n_cols": nc,
        "row_y": [[round(a, 1), round(b, 1)] for a, b in rows],
        "col_x": [[round(a, 1), round(b, 1)] for a, b in cols],
        "cells": cells,
        "grid": grid,
        "kind": kind,
        "complete": not problems,
        "problems": sorted(set(problems)),
    }


def extract_tables(page, page_no, words=None):
    prims = _primitives(page)
    if not prims:
        return []
    if words is None:
        words = page.get_text("words")
    out = []
    for g in _cluster(prims):
        if sum(1 for p in g if p[0] == "h") < 2:
            continue
        t = _grid_from_group(g, words, page_no)
        if t is None:
            continue
        # 쪽 상단 장식 띠처럼 글자가 거의 없는 영역은 버립니다.
        if sum(len(c["text"]) for c in t["cells"]) < 2:
            continue
        out.append(t)
    # 설명 상자(【...】) 안에 들어 있는 격자는 예시 그림의 일부로 보고 표에서 뺍니다.
    boxes = [t["bbox"] for t in out if t["kind"] == "box"]
    for t in out:
        if t["kind"] == "table":
            x0, y0, x1, y1 = t["bbox"]
            if any(b[0] - 3 <= x0 and b[1] - 3 <= y0 and x1 <= b[2] + 3 and y1 <= b[3] + 3 for b in boxes):
                t["kind"] = "figure"
    out.sort(key=lambda t: (t["bbox"][1], t["bbox"][0]))
    for k, t in enumerate(out):
        t["idx"] = k
    return out
