/* 1단계-A: PDF 쪽 추출(브라우저·node 공용). Python converter/extract.py·tables.py를 pdf.js로 옮긴 것입니다.
 * - 좌표 기준으로 줄을 재구성하고(머리글은 텍스트 순서상 쪽 끝에 나오므로 좌표로 찾음), 머리글·꼬리글·인쇄 쪽번호를 뽑습니다.
 * - pdf.js는 글자 간격이 넓으면 띄어쓰기를 넣어 주므로 띄어쓰기 없는 쪽도 읽을 수 있습니다.
 * - 표는 쪽의 채움 사각형(진한 가는 가로 띠=행 구분, 흰 좁은 세로 띠=열 구분)으로 격자를 복원합니다.
 */
(function (root) {
  "use strict";
  const TT = (root.TT = root.TT || {});
  const HEADER_ZONE = 0.07, FOOTER_ZONE = 0.94, HEADER_MAX_SIZE = 10.6, LOW_TEXT_CHARS = 80;

  TT.normText = function (s) {
    return String(s || "").normalize("NFKC").replace(/[ㆍ·∙•‧]/g, "·").replace(/\s+/g, "");
  };

  // ------------------------------------------------------------ 글자 → 낱말
  function itemsToWords(items, H) {
    const words = [];
    for (const it of items) {
      const str = it.str;
      if (!str || !str.trim()) continue;
      const t = it.transform;
      const size = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 10;
      const x0 = t[4], base = t[5];
      const w = it.width || str.length * size * 0.5;
      const top = H - (base + size * 0.88), bot = H - base + size * 0.22;
      const n = str.length;
      let i = 0;
      while (i < n) {
        while (i < n && /\s/.test(str[i])) i++;
        if (i >= n) break;
        let j = i;
        while (j < n && !/\s/.test(str[j])) j++;
        words.push([x0 + (w * i) / n, top, x0 + (w * j) / n, bot, str.slice(i, j), size]);
        i = j;
      }
    }
    return words;
  }

  function buildLines(words) {
    const ws = words.slice().sort((a, b) => ((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2) || a[0] - b[0]);
    const rows = [];
    for (const w of ws) {
      const yc = (w[1] + w[3]) / 2, h = Math.max(2, w[3] - w[1]);
      const r = rows[rows.length - 1];
      if (r && Math.abs(yc - r.yc) <= Math.max(1.5, 0.4 * Math.min(h, r.h))) r.ws.push(w);
      else rows.push({ yc, h, ws: [w] });
    }
    const lines = [];
    for (const r of rows) {
      const ss = r.ws.sort((a, b) => a[0] - b[0]);
      let text = "", prev = null;
      for (const w of ss) {
        if (prev && w[0] - prev[2] > 0.12 * Math.max(w[5], 1)) text += " ";
        text += w[4];
        prev = w;
      }
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const r1 = (x) => Math.round(x * 10) / 10;
      lines.push({
        t: text,
        b: [r1(Math.min(...ss.map((w) => w[0]))), r1(Math.min(...ss.map((w) => w[1]))), r1(Math.max(...ss.map((w) => w[2]))), r1(Math.max(...ss.map((w) => w[3])))],
        s: r1(Math.max(...ss.map((w) => w[5]))),
      });
    }
    return lines;
  }

  // ------------------------------------------------------------ 그림(사각형) 수집
  function mul(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function lum(c) { return c ? (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 : null; }

  function collectPrims(opList, OPS, H) {
    const fn = opList.fnArray, args = opList.argsArray;
    let ctm = [1, 0, 0, 1, 0, 0], fill = [0, 0, 0], stroke = [0, 0, 0];
    const stack = [];
    let pending = [];
    const prims = [];
    let imgArea = 0;
    const toBox = (pts) => {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => H - p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    const addRect = (box, kind) => {
      const [x0, y0, x1, y1] = box, w = x1 - x0, h = y1 - y0;
      if (kind === "f") {
        const L = lum(fill);
        if (L < 0.6 && h <= 2.5 && w >= 6) prims.push(["h", x0, y0, x1, y1]);
        else if (L < 0.6 && w <= 2.5 && h >= 5) prims.push(["v", x0, y0, x1, y1]);
        else if (L > 0.97 && w <= 4.5 && h >= 4) prims.push(["v", x0, y0, x1, y1]);
        else if (L >= 0.6 && w > 6 && h > 6) prims.push(["cell", x0, y0, x1, y1]);
      } else if (lum(stroke) < 0.8) {
        if (w > 6 && h > 6) prims.push(["h", x0, y0 - 0.5, x1, y0 + 0.5], ["h", x0, y1 - 0.5, x1, y1 + 0.5], ["v", x0 - 0.5, y0, x0 + 0.5, y1], ["v", x1 - 0.5, y0, x1 + 0.5, y1]);
        else if (h <= 1.5 && w >= 6) prims.push(["h", x0, y0 - 0.5, x1, y1 + 0.5]);
        else if (w <= 1.5 && h >= 5) prims.push(["v", x0 - 0.5, y0, x1 + 0.5, y1]);
      }
    };
    // 선으로 그린 괘선: 직사각형은 네 변으로, 그 밖에는 가로·세로 선분만 씁니다(곡선·사선은 그림이므로 뺌).
    const strokeSub = (sp) => {
      const pts = sp.pts;
      const axis = pts.every((q, i) => { const r = pts[(i + 1) % pts.length]; return Math.abs(q[0] - r[0]) < 0.5 || Math.abs(q[1] - r[1]) < 0.5; });
      if (sp.rect || (!sp.curve && pts.length >= 4 && pts.length <= 5 && axis)) { addRect(toBox(pts), "s"); return; }
      if (sp.curve) return;
      for (let i = 0; i + 1 < pts.length; i++) {
        const b = toBox([pts[i], pts[i + 1]]);
        if (b[3] - b[1] < 0.5 || b[2] - b[0] < 0.5) addRect(b, "s");
      }
    };
    for (let i = 0; i < fn.length; i++) {
      const op = fn[i], a = args[i];
      switch (op) {
        case OPS.save: stack.push([ctm, fill, stroke]); break;
        case OPS.restore: if (stack.length) [ctm, fill, stroke] = stack.pop(); break;
        case OPS.transform: ctm = mul(ctm, a); break;
        case OPS.paintFormXObjectBegin: stack.push([ctm, fill, stroke]); if (a && a[0]) ctm = mul(ctm, a[0]); break;
        case OPS.paintFormXObjectEnd: if (stack.length) [ctm, fill, stroke] = stack.pop(); break;
        case OPS.setFillRGBColor: fill = [a[0], a[1], a[2]]; break;
        case OPS.setStrokeRGBColor: stroke = [a[0], a[1], a[2]]; break;
        case OPS.setFillGray: fill = [a[0] * 255, a[0] * 255, a[0] * 255]; break;
        case OPS.setFillCMYKColor: { const k = a[3]; fill = [255 * (1 - Math.min(1, a[0] + k)), 255 * (1 - Math.min(1, a[1] + k)), 255 * (1 - Math.min(1, a[2] + k))]; break; }
        case OPS.constructPath: {
          // 하위 경로마다 점 목록과 '직사각형 여부', 곡선 포함 여부를 남깁니다.
          const ops = a[0], co = a[1];
          let k = 0, cur = null;
          const subs = [];
          const close = () => { if (cur && cur.pts.length >= 2) subs.push(cur); cur = null; };
          for (const o of ops) {
            if (o === OPS.rectangle) {
              close();
              const [x, y, w, h] = co.slice(k, k + 4); k += 4;
              subs.push({ rect: true, pts: [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)] });
            } else if (o === OPS.moveTo) { close(); cur = { pts: [apply(ctm, co[k], co[k + 1])], curve: false }; k += 2; }
            else if (o === OPS.lineTo) { if (!cur) cur = { pts: [], curve: false }; cur.pts.push(apply(ctm, co[k], co[k + 1])); k += 2; }
            else if (o === OPS.curveTo) { if (cur) { cur.curve = true; cur.pts.push(apply(ctm, co[k + 4], co[k + 5])); } k += 6; }
            else if (o === OPS.curveTo2 || o === OPS.curveTo3) { if (cur) { cur.curve = true; cur.pts.push(apply(ctm, co[k + 2], co[k + 3])); } k += 4; }
          }
          close();
          pending = subs;
          break;
        }
        case OPS.fill: case OPS.eoFill: pending.forEach((sp) => addRect(toBox(sp.pts), "f")); pending = []; break;
        case OPS.stroke: case OPS.closeStroke: pending.forEach(strokeSub); pending = []; break;
        case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke:
          pending.forEach((sp) => { addRect(toBox(sp.pts), "f"); strokeSub(sp); }); pending = []; break;
        case OPS.endPath: pending = []; break;
        case OPS.paintImageXObject: case OPS.paintInlineImageXObject: case OPS.paintImageMaskXObject: case OPS.paintJpegXObject: {
          const b = toBox([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)]);
          imgArea += Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
          break;
        }
        default: break;
      }
    }
    return { prims, imgArea };
  }

  // ------------------------------------------------------------ 표 격자
  function cluster(prims, tol = 3.5) {
    const n = prims.length, parent = [...Array(n).keys()];
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const order = [...Array(n).keys()].sort((i, j) => prims[i][2] - prims[j][2]);
    let active = [];
    for (const i of order) {
      const [, x0, y0, x1, y1] = prims[i];
      active = active.filter((j) => prims[j][4] + tol >= y0);
      for (const j of active) {
        const [, a0, b0, a1, b1] = prims[j];
        if (a0 - tol <= x1 && x0 - tol <= a1 && b0 - tol <= y1 && y0 - tol <= b1) {
          const ri = find(i), rj = find(j);
          if (ri !== rj) parent[ri] = rj;
        }
      }
      active.push(i);
    }
    const g = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(prims[i]); }
    return [...g.values()];
  }
  function mergePos(vals, tol = 2) {
    const out = [];
    for (const v of vals.slice().sort((a, b) => a - b)) {
      const last = out[out.length - 1];
      if (last && v - last[last.length - 1] <= tol) last.push(v); else out.push([v]);
    }
    return out.map((g) => g.reduce((s, x) => s + x, 0) / g.length);
  }
  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

  function gridFromGroup(g, words, pageNo) {
    const hs = g.filter((p) => p[0] === "h"), vs = g.filter((p) => p[0] === "v"), cellsBg = g.filter((p) => p[0] === "cell");
    const X0 = Math.min(...g.map((p) => p[1])), Y0 = Math.min(...g.map((p) => p[2]));
    const X1 = Math.max(...g.map((p) => p[3])), Y1 = Math.max(...g.map((p) => p[4]));
    if (X1 - X0 < 40 || Y1 - Y0 < 12) return null;
    const ys = mergePos([Y0, ...hs.map((p) => (p[2] + p[4]) / 2), Y1]);
    const xs = mergePos([X0, ...vs.map((p) => (p[1] + p[3]) / 2).filter((x) => x > X0 + 3 && x < X1 - 3), X1]);
    const rows = [], cols = [];
    for (let i = 0; i < ys.length - 1; i++) if (ys[i + 1] - ys[i] > 3) rows.push([ys[i], ys[i + 1]]);
    for (let i = 0; i < xs.length - 1; i++) if (xs[i + 1] - xs[i] > 5) cols.push([xs[i], xs[i + 1]]);
    if (!rows.length || !cols.length) return null;
    if (hs.length < 2 && !cellsBg.length) return null;
    const nr = rows.length, nc = cols.length;
    const vb = (i, j) => { const x = cols[j][1], [r0, r1] = rows[i]; return vs.some((p) => p[1] - 2 <= x && x <= p[3] + 2 && overlap(r0, r1, p[2], p[4]) >= 0.5 * (r1 - r0)); };
    const hb = (i, j) => { const y = rows[i][1], [c0, c1] = cols[j]; return hs.some((p) => p[2] - 2 <= y && y <= p[4] + 2 && overlap(c0, c1, p[1], p[3]) >= 0.5 * (c1 - c0)); };
    const parent = new Map();
    const key = (i, j) => i * 1000 + j;
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) parent.set(key(i, j), key(i, j));
    const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc - 1; j++) if (!vb(i, j)) union(key(i, j), key(i, j + 1));
    for (let i = 0; i < nr - 1; i++) for (let j = 0; j < nc; j++) if (!hb(i, j)) union(key(i, j), key(i + 1, j));
    const regions = new Map();
    for (const k of parent.keys()) { const r = find(k); if (!regions.has(r)) regions.set(r, []); regions.get(r).push(k); }
    const problems = new Set(), cells = [], owner = new Map();
    for (const members of regions.values()) {
      const ri = members.map((m) => Math.floor(m / 1000)), cj = members.map((m) => m % 1000);
      const r0 = Math.min(...ri), r1 = Math.max(...ri), c0 = Math.min(...cj), c1 = Math.max(...cj);
      if (members.length !== (r1 - r0 + 1) * (c1 - c0 + 1)) problems.add("병합 칸 모양이 직사각형이 아님");
      const cell = { r: r0, c: c0, rs: r1 - r0 + 1, cs: c1 - c0 + 1, words: [] };
      cells.push(cell);
      for (const m of members) owner.set(m, cell);
    }
    const locate = (x, y) => {
      const ri = rows.findIndex(([a, b]) => a - 1 <= y && y <= b + 1), cj = cols.findIndex(([a, b]) => a - 1 <= x && x <= b + 1);
      return ri < 0 || cj < 0 ? null : owner.get(key(ri, cj));
    };
    let unassigned = 0, used = 0;
    for (const w of words) {
      const xc = (w[0] + w[2]) / 2, yc = (w[1] + w[3]) / 2;
      if (!(X0 - 1 <= xc && xc <= X1 + 1 && Y0 - 1 <= yc && yc <= Y1 + 1)) continue;
      used++;
      const c = locate(xc, yc);
      if (!c) { unassigned++; continue; }
      c.words.push(w);
    }
    if (!used) return null;
    if (unassigned) problems.add(`칸에 배정되지 않은 글자 ${unassigned}개`);
    for (const c of cells) {
      const ws = c.words.sort((a, b) => ((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2) || a[0] - b[0]);
      const lines = [];
      for (const w of ws) {
        const yc = (w[1] + w[3]) / 2, L = lines[lines.length - 1];
        if (L && Math.abs(yc - L.yc) <= 0.5 * (w[3] - w[1])) L.ws.push(w); else lines.push({ yc, ws: [w] });
      }
      c.text = lines.map((L) => L.ws.sort((a, b) => a[0] - b[0]).map((w) => w[4]).join(" ")).join("\n");
      delete c.words;
    }
    cells.sort((a, b) => a.r - b.r || a.c - b.c);
    const grid = Array.from({ length: nr }, () => Array(nc).fill(null));
    for (const c of cells) grid[c.r][c.c] = c.text;
    const first = (cells.find((c) => c.text.trim()) || { text: "" }).text.trim();
    let kind = "table";
    if (first.startsWith("【")) kind = "box";
    else if (nc === 1 && nr <= 2) kind = "box";
    const r1 = (x) => Math.round(x * 10) / 10;
    return { page: pageNo, bbox: [r1(X0), r1(Y0), r1(X1), r1(Y1)], n_rows: nr, n_cols: nc, cells, grid, kind,
      complete: problems.size === 0, problems: [...problems].sort() };
  }

  function extractTables(prims, words, pageNo) {
    if (!prims.length) return [];
    let out = [];
    for (const g of cluster(prims)) {
      if (g.filter((p) => p[0] === "h").length < 2) continue;
      const t = gridFromGroup(g, words, pageNo);
      if (!t) continue;
      if (t.cells.reduce((s, c) => s + c.text.length, 0) < 2) continue;
      out.push(t);
    }
    const boxes = out.filter((t) => t.kind === "box").map((t) => t.bbox);
    for (const t of out) {
      if (t.kind !== "table") continue;
      const [x0, y0, x1, y1] = t.bbox;
      if (boxes.some((b) => b[0] - 3 <= x0 && b[1] - 3 <= y0 && x1 <= b[2] + 3 && y1 <= b[3] + 3)) t.kind = "figure";
    }
    out.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
    out.forEach((t, k) => (t.idx = k));
    return out;
  }

  // ------------------------------------------------------------ 쪽 추출
  TT.extractPage = async function (page, pno, OPS) {
    const vp = page.getViewport({ scale: 1 });
    const W = vp.width, H = vp.height;
    const tc = await page.getTextContent();
    const words = itemsToWords(tc.items, H);
    const lines = buildLines(words);
    const ol = await page.getOperatorList();
    const { prims, imgArea } = collectPrims(ol, OPS, H);
    const imgCov = Math.min(1, imgArea / (W * H));
    const chars = lines.reduce((s, l) => s + l.t.length, 0);
    const scanned = chars < 30 && imgCov > 0.5;
    const header = [], footer = [], body = [];
    for (const l of lines) {
      if (l.b[3] < H * HEADER_ZONE && l.s <= HEADER_MAX_SIZE && !/^\d+$/.test(l.t)) header.push(l);
      else if (l.b[1] > H * FOOTER_ZONE) footer.push(l);
      else body.push(l);
    }
    const footerText = footer.map((l) => l.t).join(" ").trim();
    const m = footerText.match(/^-?\s*(\d{1,4})\s*-?$/);
    let printed = m ? +m[1] : null;
    if (printed === null) { const top = lines.find((l) => l.b[3] < H * HEADER_ZONE && /^\d+$/.test(l.t)); if (top) printed = +top.t; }
    const headerText = header.map((l) => l.t).join(" ").trim();
    const bodyChars = body.reduce((s, l) => s + l.t.length, 0);
    return {
      p: pno, w: Math.round(W * 10) / 10, h: Math.round(H * 10) / 10,
      header: headerText, header_norm: TT.normText(headerText), footer: footerText, printed,
      lines: body, chars: bodyChars, low_text: bodyChars < LOW_TEXT_CHARS, img_cov: Math.round(imgCov * 100) / 100,
      scanned, ocr: scanned ? { done: false, reason: "스캔(이미지) 쪽입니다. 브라우저용 도구에서는 OCR을 하지 않으므로 글자를 읽지 못했습니다." } : null,
      tables: extractTables(prims, words.map((w) => w.slice(0, 5)), pno),
    };
  };

  TT.extractPdf = async function (pdf, OPS, progress) {
    const pages = [];
    const n = pdf.numPages;
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      pages.push(await TT.extractPage(page, i, OPS));
      page.cleanup();
      if (progress && (i % 5 === 0 || i === n)) await progress("텍스트·표 추출", (i / n) * 0.9, `${i}/${n}쪽`);
    }
    return { pages, meta: { page_count: n, ocr_engine: false } };
  };
})(typeof self !== "undefined" ? self : globalThis);
