/* 약관 변환 엔진(브라우저·노드 공용). termsapp/*.py 의 규칙을 그대로 옮긴 것입니다.
 * 1단계: pdf.js 글자·선 → 줄, 머리글·바닥글, 표·해설 상자, 구간, 조·항·호·목, 참조, 품질 보고서
 * 2단계: 지급기준표에서 담보 찾기, 대·중·소 분류
 * 3단계: 담보 단위 AI 입력 구성, 인용문 원문 대조·격리
 * AI 호출과 저장은 이 파일 밖(backend.js)에서 합니다. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TermsEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const HEADER_BAND = 0.075;
  const PAGE_NO_RE = /^[-–—\s]*(\d{1,4})[-–—\s]*$/;
  const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚";
  const HANGUL_ITEMS = "가나다라마바사아자차카타파하";
  const ART_NUM = "제\\s*(\\d+(?:\\s*-\\s*\\d+)?)\\s*조(?:\\s*의\\s*(\\d+))?";
  const RE = {
    part: /^제\s*(\d+)\s*편\s*(.*)$/, chapter: /^제\s*(\d+)\s*관\s*(.*)$/, section: /^제\s*(\d+)\s*절\s*(.*)$/,
    artBracket: new RegExp("^" + ART_NUM + "\\s*【\\s*(.+?)\\s*】\\s*(.*)$"),
    artParen: new RegExp("^" + ART_NUM + "\\s*[(\\[（]\\s*([^)\\]）]+?)\\s*[)\\]）]\\s*$"),
    artAny: new RegExp("^" + ART_NUM + "\\s*[【(\\[]"),
    appendix: /^[<\[]?\s*별\s*표\s*(\d+(?:\s*-\s*\d+)?)\s*[>\]]?\s*(.*)$/,
    para: new RegExp("^([" + CIRCLED + "])\\s*(.*)$"),
    item: /^(\d{1,2})\.(?!\d)\s*(\S.*)$/,
    subitem: new RegExp("^([" + HANGUL_ITEMS + "])\\.\\s*(\\S.*)$"),
    noteHead: /^【\s*([^】]{1,40})\s*】/,
    tocFirst: /^(\d{1,4})\s+(\S.*)$/, tocLast: /^(\S.*?)[\s·.…]{1,}(\d{1,4})$/,
  };
  const REFERENCE_WORDS = ["색인", "Guide", "용어 해설", "용어해설", "요약서", "인용조문", "안내문"];
  const LEVELS = { part: 0, chapter: 1, section: 2, article: 3, paragraph: 4, item: 5, subitem: 6 };
  const KIND_NAMES = { part: "편", chapter: "관", section: "절", article: "조", paragraph: "항", item: "호", subitem: "목",
    appendix: "별표", note: "해설", preamble: "머리말", page_text: "쪽 본문" };

  const normNum = (s) => s.replace(/\s+/g, "");
  const artLabel = (num) => { const [b, sub] = num.split("의"); return `제${b}조` + (sub ? `의${sub}` : ""); };
  const norm = (s) => (s || "").replace(/\s+/g, "");
  const r1 = (v) => Math.round(v * 10) / 10;

  // ================================================================ 1단계: 쪽 추출
  /* pdf.js 텍스트 항목 → 화면 좌표(위가 0) 조각 */
  function textPieces(items, H) {
    const out = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const [a, b, , d, e, f] = it.transform;
      const size = Math.hypot(a, b) || Math.abs(d) || it.height || 10;
      out.push({ str: it.str, size, font: it.fontName || "",
        bbox: [e, H - f - size * 0.85, e + (it.width || 0), H - f + size * 0.2] });
    }
    return out;
  }

  function mergeLines(pieces) {
    const ps = pieces.slice().sort((p, q) => ((p.bbox[1] + p.bbox[3]) / 2 - (q.bbox[1] + q.bbox[3]) / 2) || p.bbox[0] - q.bbox[0]);
    const lines = [];
    for (const p of ps) {
      const cy = (p.bbox[1] + p.bbox[3]) / 2, h = p.bbox[3] - p.bbox[1];
      const m = lines[lines.length - 1];
      if (m) {
        const mcy = (m.bbox[1] + m.bbox[3]) / 2, mh = m.bbox[3] - m.bbox[1];
        // 같은 높이라도 단 사이처럼 멀리 떨어진 글자는 다른 줄로 둡니다.
        if (Math.abs(cy - mcy) < 0.5 * Math.min(h, mh) && p.bbox[0] - m.bbox[2] < 4 * p.size) {
          m.parts.push(p);
          m.bbox = [Math.min(m.bbox[0], p.bbox[0]), Math.min(m.bbox[1], p.bbox[1]), Math.max(m.bbox[2], p.bbox[2]), Math.max(m.bbox[3], p.bbox[3])];
          continue;
        }
      }
      lines.push({ bbox: p.bbox.slice(), parts: [p] });
    }
    return lines.map((l) => {
      l.parts.sort((p, q) => p.bbox[0] - q.bbox[0]);
      let text = "", prev = null;
      for (const p of l.parts) {
        if (prev && p.bbox[0] - prev.bbox[2] > 0.2 * p.size && !/\s$/.test(text) && !/^\s/.test(p.str)) text += " ";
        text += p.str; prev = p;
      }
      const sizes = l.parts.map((p) => p.size);
      return { text: text.replace(/[  \t]+/g, " ").trim(), bbox: l.bbox.map(r1), size: r1(Math.max(...sizes)),
        font: l.parts[0].font };
    }).filter((l) => l.text);
  }

  function detectColumns(lines, W) {
    const mid = W / 2;
    const body = lines.filter((l) => l.bbox[2] - l.bbox[0] > W * 0.08);
    if (body.length < 10) return null;
    const left = body.filter((l) => l.bbox[2] <= mid + 4).length, right = body.filter((l) => l.bbox[0] >= mid - 4).length;
    return left >= 5 && right >= 5 && body.length - left - right <= 0.1 * body.length ? mid : null;
  }

  const inside = (bb, r) => { const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2; return r[0] <= cx && cx <= r[2] && r[1] <= cy && cy <= r[3]; };

  function pageLines(pieces, W, excludeRects) {
    const kept = pieces.filter((p) => !excludeRects.some((r) => inside(p.bbox, r)));
    const probe = mergeLines(kept);
    const split = detectColumns(probe, W);
    const groups = split == null ? [kept] : [kept.filter((p) => (p.bbox[0] + p.bbox[2]) / 2 < split), kept.filter((p) => (p.bbox[0] + p.bbox[2]) / 2 >= split)];
    const out = [];
    groups.forEach((g, col) => mergeLines(g).forEach((l) => out.push({ ...l, col })));
    return { lines: out, twoColumn: split != null };
  }

  /* 연산자 목록에서 그려진 선·사각형과 이미지 면적을 모읍니다(좌표 변환 추적). */
  function drawings(opList, OPS, H) {
    const segs = [], rects = [];
    let imageArea = 0;
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
    const tp = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], H - (ctm[1] * x + ctm[3] * y + ctm[5])];
    let pending = [];
    const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
    const strokes = new Set([OPS.stroke, OPS.closeStroke]);
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i], args = opList.argsArray[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(args, ctm);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm.slice()); if (args && args[0]) ctm = mul(args[0], ctm); }
      else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
      else if (fn === OPS.constructPath) {
        const [ops, coords] = args; let k = 0, cur = null, start = null;
        for (const op of ops) {
          if (op === OPS.moveTo) { cur = tp(coords[k], coords[k + 1]); start = cur; k += 2; }
          else if (op === OPS.lineTo) { const p = tp(coords[k], coords[k + 1]); if (cur) pending.push([cur, p]); cur = p; k += 2; }
          else if (op === OPS.curveTo) { const p = tp(coords[k + 4], coords[k + 5]); cur = p; k += 6; }
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) { const p = tp(coords[k + 2], coords[k + 3]); cur = p; k += 4; }
          else if (op === OPS.closePath) { if (cur && start) pending.push([cur, start]); cur = start; }
          else if (op === OPS.rectangle) {
            const [x, y, w, h] = coords.slice(k, k + 4); k += 4;
            const ps = [tp(x, y), tp(x + w, y), tp(x + w, y + h), tp(x, y + h)];
            for (let j = 0; j < 4; j++) pending.push([ps[j], ps[(j + 1) % 4]]);
          }
        }
      } else if (fills.has(fn) || strokes.has(fn)) {
        // 닫힌 경로는 사각형 영역으로도 기록합니다(상자·칠해진 칸).
        if (pending.length) {
          const xs = pending.flat().map((p) => p[0]), ys = pending.flat().map((p) => p[1]);
          const bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
          if (bb[2] - bb[0] < 1.6 || bb[3] - bb[1] < 1.6) segs.push(bb[2] - bb[0] < 1.6 ? [[(bb[0] + bb[2]) / 2, bb[1]], [(bb[0] + bb[2]) / 2, bb[3]]] : [[bb[0], (bb[1] + bb[3]) / 2], [bb[2], (bb[1] + bb[3]) / 2]]);
          else { rects.push(bb.map(r1)); segs.push(...pending); }
        }
        pending = [];
      } else if (fn === OPS.endPath) pending = [];
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
        const a = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]); imageArea += a;
      }
    }
    const H_ = [], V_ = [];
    for (const [p, q] of segs) {
      if (Math.abs(p[1] - q[1]) < 1.6 && Math.abs(p[0] - q[0]) > 8) H_.push([Math.min(p[0], q[0]), (p[1] + q[1]) / 2, Math.max(p[0], q[0])]);
      else if (Math.abs(p[0] - q[0]) < 1.6 && Math.abs(p[1] - q[1]) > 4) V_.push([(p[0] + q[0]) / 2, Math.min(p[1], q[1]), Math.max(p[1], q[1])]);
    }
    return { hlines: H_, vlines: V_, rects, imageArea };
  }

  function cluster(vals, tol) {
    const s = vals.slice().sort((a, b) => a - b), out = [];
    for (const v of s) { if (out.length && v - out[out.length - 1][out[out.length - 1].length - 1] <= tol) out[out.length - 1].push(v); else out.push([v]); }
    return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
  }

  function cleanTable(rows) {
    rows = rows.map((r) => r.map((c) => (c || "").trim())).filter((r) => r.some(Boolean));
    if (!rows.length) return [];
    const n = Math.max(...rows.map((r) => r.length));
    rows = rows.map((r) => r.concat(Array(n - r.length).fill("")));
    const keep = [...Array(n).keys()].filter((j) => rows.some((r) => r[j]));
    return rows.map((r) => keep.map((j) => r[j]));
  }

  /* 선으로 표 영역을 찾고 칸에 글자를 배치합니다. 세로선이 없으면 글자 간격으로 열을 나눕니다(재구성 표시). */
  function findTables(dr, pieces, W) {
    const { hlines, vlines } = dr;
    if (hlines.length < 2) return [];
    // 가로선끼리(세로로 가까운) 또는 세로선과 닿는 것끼리 묶어 영역을 만듭니다.
    const segs = hlines.map((h) => ({ t: "h", bb: [h[0], h[1], h[2], h[1]] })).concat(vlines.map((v) => ({ t: "v", bb: [v[0], v[1], v[0], v[2]] })));
    const par = segs.map((_, i) => i);
    const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
    const near = (a, b, tol) => a[0] - tol <= b[2] && b[0] - tol <= a[2] && a[1] - tol <= b[3] && b[1] - tol <= a[3];
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i].bb, b = segs[j].bb;
      let link = near(a, b, 2);
      if (!link && segs[i].t === "h" && segs[j].t === "h" && Math.abs(a[1] - b[1]) < 45
          && Math.abs(a[0] - b[0]) < 4 && Math.abs(a[2] - b[2]) < 4) {
        // 양끝이 같은 가로선 사이에 표 왼쪽 밖에서 시작하는 본문 줄이 있으면 서로 다른 상자입니다.
        const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]), x0 = Math.min(a[0], b[0]);
        link = !pieces.some((p) => { const cy = (p.bbox[1] + p.bbox[3]) / 2; return cy > y0 && cy < y1 && p.bbox[0] < x0 - 3; });
      }
      if (link) par[find(i)] = find(j);
    }
    const groups = {};
    segs.forEach((s, i) => (groups[find(i)] ||= []).push(s));
    const out = [];
    for (const g of Object.values(groups)) {
      const hs = g.filter((s) => s.t === "h");
      if (hs.length < 2) continue;
      const bb = [Math.min(...g.map((s) => s.bb[0])), Math.min(...g.map((s) => s.bb[1])), Math.max(...g.map((s) => s.bb[2])), Math.max(...g.map((s) => s.bb[3]))];
      if (bb[2] - bb[0] < 60 || bb[3] - bb[1] < 10) continue;
      const ys = cluster(hs.map((s) => s.bb[1]), 2.5);
      let xs = cluster(g.filter((s) => s.t === "v" && s.bb[3] - s.bb[1] > 6).map((s) => s.bb[0]), 3);
      const inPieces = pieces.filter((p) => inside(p.bbox, [bb[0] - 1, bb[1] - 1, bb[2] + 1, bb[3] + 1]));
      if (!inPieces.length) continue;
      let rebuilt = false;
      if (xs.length < 3) {
        // 세로선이 없는 표: 첫 행(머리줄) 글자 덩어리 사이의 빈 곳을 열 경계로 삼습니다.
        rebuilt = true;
        const headBand = [ys[0], ys[1]];
        const head = inPieces.filter((p) => { const cy = (p.bbox[1] + p.bbox[3]) / 2; return cy >= headBand[0] && cy <= headBand[1]; })
          .sort((p, q) => p.bbox[0] - q.bbox[0]);
        xs = [bb[0], bb[2]];
        for (let k = 1; k < head.length; k++) {
          const gap0 = head[k - 1].bbox[2], gap1 = head[k].bbox[0];
          if (gap1 - gap0 > 12) xs.push((gap0 + gap1) / 2);
        }
        xs.sort((a, b) => a - b);
      } else {
        if (xs[0] - bb[0] > 3) xs.unshift(bb[0]);
        if (bb[2] - xs[xs.length - 1] > 3) xs.push(bb[2]);
      }
      const bands = [];
      for (let k = 0; k + 1 < ys.length; k++) if (ys[k + 1] - ys[k] > 4) bands.push([ys[k], ys[k + 1]]);
      if (!bands.length || xs.length < 2) continue;
      const grid = bands.map(() => xs.slice(1).map(() => []));
      let placed = 0;
      for (const p of inPieces) {
        const cy = (p.bbox[1] + p.bbox[3]) / 2, cx = (p.bbox[0] + p.bbox[2]) / 2;
        const ri = bands.findIndex(([a, b]) => cy >= a - 1 && cy <= b + 1);
        if (ri < 0) continue;
        let ci = xs.findIndex((x, k) => k + 1 < xs.length && cx >= x - 1 && cx <= xs[k + 1] + 1);
        if (ci < 0) ci = 0;
        grid[ri][ci].push(p); placed++;
      }
      const rows = grid.map((r) => r.map((cell) => mergeLines(cell).map((l) => l.text).join("\n")));
      const cleaned = cleanTable(rows);
      const totalChars = inPieces.reduce((a, p) => a + norm(p.str).length, 0);
      const got = cleaned.flat().reduce((a, c) => a + norm(c).length, 0);
      const head = cleaned.length ? cleaned[0].join("").trim() : "";
      const t = { bbox: bb.map(r1), rows: cleaned, rebuilt, reasons: [] };
      const vcount = cluster(g.filter((x) => x.t === "v" && x.bb[3] - x.bb[1] > 6).map((x) => x.bb[0]), 3).length;
      if (cleaned.length < 2 || (cleaned[0] || []).length < 2 || head.startsWith("【")) {
        // 해설 상자는 【제목】이 있거나 좌우가 막힌 상자만 인정합니다(가로선 몇 개만 있는 곳은 본문으로 둡니다).
        if (!head.startsWith("【") && vcount < 2) continue;
        t.kind = "box"; t.title = head.startsWith("【") ? head : "";
      }
      else {
        t.kind = "table";
        const cells = cleaned.flat();
        const empty = cells.filter((c) => !c).length / cells.length;
        if (empty > 0.75) t.reasons.push(`빈 칸 비율 ${Math.round(empty * 100)}%`);
        if (totalChars && got < totalChars * 0.9) t.reasons.push(`표 영역 글자 ${totalChars}자 중 ${got}자만 추출`);
      }
      t.incomplete = t.reasons.length > 0;
      out.push(t);
    }
    return out;
  }

  /* 그려진 사각형 중 첫 줄이 【…】인 것을 해설 상자로 봅니다. */
  function drawnBoxes(rects, lines, known, W, H) {
    const out = [];
    for (const r of rects) {
      if (r[2] - r[0] < W * 0.4 || !(r[3] - r[1] > 12 && r[3] - r[1] < H * 0.8)) continue;
      if (known.concat(out.map((b) => b.bbox)).some((k) => k[0] - 3 <= r[0] && k[1] - 3 <= r[1] && r[2] <= k[2] + 3 && r[3] <= k[3] + 3)) continue;
      const ins = lines.filter((l) => inside(l.bbox, r)).sort((a, b) => a.bbox[1] - b.bbox[1]);
      if (ins.length && ins[0].text.startsWith("【")) out.push({ kind: "box", bbox: r, rows: [], title: ins[0].text });
    }
    return out;
  }

  /* 쪽 하나를 처리합니다. tables 배열에 표를 이어 붙이고 쪽 정보를 돌려줍니다. */
  function processPage(pn, W, H, textItems, opList, OPS, tables) {
    const pieces = textPieces(textItems, H);
    const dr = drawings(opList, OPS, H);
    const found = findTables(dr, pieces, W);
    let boxes = found.filter((t) => t.kind === "box");
    const real = found.filter((t) => t.kind === "table");
    let { lines, twoColumn } = pageLines(pieces, W, real.map((t) => t.bbox));
    boxes = boxes.concat(drawnBoxes(dr.rects, lines, boxes.map((b) => b.bbox).concat(real.map((t) => t.bbox)), W, H));
    const ratio = Math.min(1, dr.imageArea / (W * H));
    let chars = lines.reduce((a, l) => a + norm(l.text).length, 0) + real.reduce((a, t) => a + norm(t.rows.flat().join("")).length, 0);
    const ocr = chars < 20 && ratio > 0.5 ? "필요(브라우저판 미지원)" : "";
    for (const t of real) {
      t.id = `T${String(tables.length + 1).padStart(4, "0")}`; t.page = pn;
      const col = !twoColumn || (t.bbox[0] + t.bbox[2]) / 2 < W / 2 ? 0 : 1;
      const marker = { text: `[표 ${t.id}]`, bbox: t.bbox, size: 0, font: "", col, table: t.id };
      let pos = lines.findIndex((l) => l.col > col || (l.col === col && l.bbox[1] > t.bbox[1]));
      if (pos < 0) pos = lines.length;
      lines.splice(pos, 0, marker);
      tables.push(t);
    }
    boxes.sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]));
    boxes.forEach((b, k) => {
      for (const l of lines) if (inside(l.bbox, b.bbox) && l.bbox[0] >= b.bbox[0] - 2) { l.box = `p${pn}b${k}`; l.box_cont = !b.title && b.bbox[1] < H * 0.15; }
    });
    return { pdf_page: pn, width: r1(W), height: r1(H), lines, chars, image_ratio: Math.round(ratio * 1000) / 1000,
      two_column: twoColumn, ocr, boxes: boxes.map((b) => b.bbox) };
  }

  const normHF = (t) => t.replace(/\s+/g, "").replace(/\d+/g, "#");
  function stripHeadersFooters(pages) {
    const counts = new Map();
    for (const p of pages) {
      const seen = new Set();
      for (const l of p.lines) if (l.bbox[3] < p.height * HEADER_BAND || l.bbox[1] > p.height * (1 - HEADER_BAND)) seen.add(normHF(l.text));
      for (const s of seen) counts.set(s, (counts.get(s) || 0) + 1);
    }
    for (const p of pages) {
      const body = [], hf = []; let printed = null;
      for (const l of p.lines) {
        const band = !l.table && (l.bbox[3] < p.height * HEADER_BAND || l.bbox[1] > p.height * (1 - HEADER_BAND));
        if (band) {
          const m = PAGE_NO_RE.exec(l.text);
          if (m) { printed = +m[1]; hf.push(l.text); continue; }
          if ((counts.get(normHF(l.text)) || 0) >= 3) { hf.push(l.text); continue; }
        }
        body.push(l);
      }
      p.lines = body; p.header_footer = hf; p.printed_page = printed;
    }
  }

  // ================================================================ 1단계: 구조
  function parseTocLines(lines) {
    const out = [];
    for (const l of lines) {
      const t = l.text.trim();
      let m = RE.tocFirst.exec(t);
      if (m && m[1].length >= 3) { out.push([+m[1], m[2].trim()]); continue; }
      m = RE.tocLast.exec(t);
      if (m && m[1].replace(/[\s·.…]/g, "").length >= 2) out.push([+m[2], m[1].replace(/[\s·.…]+0?$/, "").trim()]);
    }
    return out;
  }

  function findToc(pages, maxScan = 60) {
    let best = null;
    for (let i = 0; i < Math.min(pages.length, maxScan); i++) {
      if (!pages[i].lines.slice(0, 6).map((l) => l.text).join(" ").includes("목차")) continue;
      const entries = [], tocPages = [];
      for (let j = i; j < pages.length; j++) {
        const e = parseTocLines(pages[j].lines), nums = e.map((x) => x[0]);
        const sorted = nums.every((v, k) => k === 0 || nums[k - 1] <= v);
        if (e.length < 3 || !sorted || (entries.length && nums[0] < entries[entries.length - 1][0])) break;
        entries.push(...e); tocPages.push(j + 1);
      }
      if (entries.length >= 3 && (!best || entries.length > best.entries.length)) best = { pages: tocPages, entries };
    }
    return best;
  }

  function buildSections(pages, bookmarks) {
    const n = pages.length, p2pdf = {};
    for (const p of pages) if (p.printed_page != null && !(p.printed_page in p2pdf)) p2pdf[p.printed_page] = p.pdf_page;
    let starts = [], source = "", tocPages = [];
    const top = (bookmarks || []).filter((b) => b.level === 1 && b.page);
    if (top.length >= 2) { starts = top.map((b) => [b.page, b.title.trim()]); source = "북마크"; }
    else {
      const toc = findToc(pages);
      if (toc) {
        tocPages = toc.pages;
        for (const [printed, title] of toc.entries) { const pdf = p2pdf[printed] ?? printed; if (pdf >= 1 && pdf <= n) starts.push([pdf, title]); }
        source = "목차 쪽";
      }
    }
    const known = starts.map((s) => s[0]);
    for (const p of pages) {
      const l = p.lines[0]; if (!l) continue;
      const t = l.text.trim();
      if (t.endsWith("약관") && l.big && t.length < 90 && !t.includes("목차") && !known.some((k) => p.pdf_page - 3 <= k && k <= p.pdf_page)) {
        starts.push([p.pdf_page, t.replace(/\s*약관$/, "")]); known.push(p.pdf_page);
        if (!source.includes("본문 제목")) source = (source || "") + " + 본문 제목";
      }
    }
    const seen = new Set();
    starts = starts.filter((s) => { const k = s.join("|"); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    const sections = [];
    if (!starts.length || starts[0][0] > 1) sections.push({ title: starts.length ? "표지·목차" : "문서 전체", page_start: 1, page_end: (starts.length ? starts[0][0] : n + 1) - 1 });
    starts.forEach(([pg, title], k) => sections.push({ title, page_start: pg, page_end: Math.max(pg, k + 1 < starts.length ? starts[k + 1][0] - 1 : n) }));
    sections.forEach((s, k) => {
      s.id = `S${String(k + 1).padStart(3, "0")}`;
      const ref = s.title === "표지·목차" || REFERENCE_WORDS.some((w) => s.title.includes(w));
      s.kind = ref && s.title !== "문서 전체" ? "reference" : "terms";
    });
    return { sections, source: source.trim() || "없음", tocPages };
  }

  const isHeading = (t) => { t = t.trim(); return RE.part.test(t) || RE.chapter.test(t) || RE.section.test(t) || RE.artAny.test(t) || RE.appendix.test(t); };

  function sectionTocPages(pages, sec) {
    const out = [];
    for (let pn = sec.page_start; pn <= sec.page_end; pn++) {
      const lines = pages[pn - 1].lines.filter((l) => l.text.trim());
      if (!lines.length) continue;
      const head = lines.slice(0, 4).map((l) => l.text).join(" ");
      const heads = lines.filter((l) => isHeading(l.text)).length;
      if ((head.includes("목차") && heads >= 2) || (out.length && heads >= 0.7 * lines.length && lines.length >= 2)) { out.push(pn); continue; }
      if (pn - sec.page_start > 3 || out.length) break;
    }
    return out;
  }

  class Builder {
    constructor(sec, style) { this.sec = sec; this.style = style; this.nodes = []; this.counter = 0; this.stack = {}; this.cur = null; this.noteBox = null; this.noteCont = false; }
    newNode(kind, parent, num = "", title = "", label = "") {
      this.counter++;
      const n = { uid: `${this.sec.id}-n${String(this.counter).padStart(5, "0")}`, section: this.sec.id, kind, parent: parent ? parent.uid : null,
        num, title, label, text: "", lines: [] };
      this.nodes.push(n); return n;
    }
    addLine(node, line, text) {
      node.lines.push({ p: line.p, bbox: line.bbox });
      node.text = node.text ? node.text + "\n" + text : text;
    }
    parentFor(kind) {
      const order = ["part", "chapter", "section", "article", "paragraph", "item", "subitem"];
      for (let i = order.indexOf(kind) - 1; i >= 0; i--) if (this.stack[order[i]]) return this.stack[order[i]];
      return null;
    }
    resetBelow(kind) {
      const order = ["part", "chapter", "section", "article", "paragraph", "item", "subitem"];
      for (const k of order.slice(order.indexOf(kind))) this.stack[k] = null;
    }
    open(kind, line, num, title, rest, label) {
      const parent = this.parentFor(kind);
      this.resetBelow(kind);
      const n = this.newNode(kind, parent, num, title, label);
      this.stack[kind] = n;
      const sub = ["paragraph", "item", "subitem"].includes(kind);
      this.addLine(n, line, sub ? rest : line.text.trim());
      if (sub && !rest) n.text = "";
      this.cur = n; this.noteBox = null;
    }
    plausible(kind, n) {
      if (n === 1) return true;
      const prev = this.stack[kind], par = this.parentFor(kind);
      return !!prev && prev.parent === (par ? par.uid : null);
    }
    lastStructural() {
      for (const k of ["subitem", "item", "paragraph", "article", "section", "chapter", "part"]) if (this.stack[k]) return this.stack[k];
      return this.stack.appendix_holder || this.cur;
    }
    feed(line) {
      const t = line.text.trim(); if (!t) return;
      if (line.box) {
        if (this.noteBox !== line.box) {
          const cont = line.box_cont && this.cur && this.cur.kind === "note";
          if (!cont) {
            const owner = this.stack.article || this.stack.appendix_holder;
            const m = RE.noteHead.exec(t);
            this.cur = this.newNode("note", owner, "", m ? m[1] : "", "해설");
          }
          this.noteBox = line.box;
        }
        this.addLine(this.cur, line, t); return;
      }
      if (line.line_no === 0) this.noteCont = !!this.cur && this.cur.kind === "note";
      if (this.noteCont) {
        const nx = this.cur.lines.length ? Math.min(...this.cur.lines.map((l) => l.bbox[0])) : 0;
        if (line.bbox[0] >= nx - 1.5 && !RE.artBracket.test(t)) { this.addLine(this.cur, line, t); return; }
        this.noteCont = false; this.cur = this.lastStructural();
      }
      if (this.noteBox) { this.noteBox = null; this.cur = this.lastStructural(); }
      let m;
      if ((m = RE.part.exec(t)) && t.length < 40) return this.open("part", line, m[1], m[2].trim(), "", `제${m[1]}편`);
      if ((m = RE.chapter.exec(t)) && t.length < 50) return this.open("chapter", line, m[1], m[2].trim(), "", `제${m[1]}관`);
      if ((m = RE.section.exec(t)) && t.length < 50) return this.open("section", line, m[1], m[2].trim(), "", `제${m[1]}절`);
      m = this.style === "bracket" ? RE.artBracket.exec(t) : RE.artParen.exec(t);
      if (m) {
        const num = normNum(m[1]) + (m[2] ? `의${m[2]}` : "");
        this.open("article", line, num, m[3].trim(), "", artLabel(num));
        this.stack.appendix_holder = null; return;
      }
      if ((m = RE.appendix.exec(t)) && (line.line_no <= 2 || line.big) && t.length < 80) {
        const num = normNum(m[1]);
        this.resetBelow("article");
        const n = this.newNode("appendix", null, num, m[2].trim(), `별표${num}`);
        this.addLine(n, line, t);
        this.stack.appendix_holder = n; this.stack.article = null; this.cur = n; return;
      }
      const inAppendix = this.stack.appendix_holder && !this.stack.article;
      if (this.stack.article && !inAppendix) {
        m = RE.para.exec(t);
        const art = this.stack.article, ax = art.lines.length ? art.lines[0].bbox[0] : 0;
        if (m && line.bbox[0] <= ax + 22) return this.open("paragraph", line, String(CIRCLED.indexOf(m[1]) + 1), "", m[2].trim(), m[1]);
        m = RE.item.exec(t);
        if (m && this.plausible("item", +m[1])) return this.open("item", line, m[1], "", m[2].trim(), `${m[1]}.`);
        m = RE.subitem.exec(t);
        if (m && this.plausible("subitem", HANGUL_ITEMS.indexOf(m[1]) + 1)) return this.open("subitem", line, m[1], "", m[2].trim(), `${m[1]}.`);
      }
      if (!this.cur) this.cur = this.newNode("preamble", null, "", "", "머리말");
      this.addLine(this.cur, line, t);
    }
  }

  function makeLabel(kind, num) {
    if (kind === "article") return artLabel(num);
    if (kind === "paragraph") return /^\d+$/.test(num) && +num > 0 && +num <= CIRCLED.length ? CIRCLED[+num - 1] : `(${num})`;
    if (kind === "item" || kind === "subitem") return `${num}.`;
    if (["part", "chapter", "section"].includes(kind)) return `제${num}${KIND_NAMES[kind]}`;
    if (kind === "appendix") return `별표${num}`;
    return KIND_NAMES[kind] || kind;
  }

  function relink(nodes) {
    let stack = {}, holder = null, section = null;
    for (const n of nodes) {
      if (n.section !== section) { stack = {}; holder = null; section = n.section; }
      const k = n.kind;
      if (k in LEVELS) {
        const lv = LEVELS[k]; let parent = null;
        for (let j = lv - 1; j >= 0; j--) if (stack[j]) { parent = stack[j]; break; }
        n.parent = parent ? parent.uid : null;
        for (const j of Object.keys(stack)) if (+j >= lv) delete stack[j];
        stack[lv] = n;
        if (k === "article") holder = null;
      } else if (k === "appendix") {
        n.parent = null;
        for (const j of Object.keys(stack)) if (+j >= LEVELS.article) delete stack[j];
        holder = n;
      } else if (k === "note") { const o = stack[LEVELS.article] || holder; n.parent = o ? o.uid : null; }
      else n.parent = null;
    }
    return nodes;
  }

  function childrenMap(nodes) { const m = new Map(); for (const n of nodes) { if (!m.has(n.parent)) m.set(n.parent, []); m.get(n.parent).push(n); } return m; }

  function assignIds(nodes) {
    const byUid = new Map(nodes.map((n) => [n.uid, n])), children = childrenMap(nodes), seen = new Map();
    for (const n of nodes) {
      const chain = []; let p = n;
      while (p) { chain.push(p); p = p.parent ? byUid.get(p.parent) : null; }
      chain.reverse();
      n.path = chain.map((c) => (c.label + (c.title && ["part", "chapter", "section", "article", "appendix"].includes(c.kind) ? " " + c.title : "")).trim()).filter(Boolean).join(" > ");
      const parts = chain.map((c) => {
        if (c.kind === "article") return artLabel(c.num);
        if (c.kind === "appendix") return `별표${c.num}`;
        if (c.kind === "paragraph") return c.label;
        if (c.kind === "item" || c.kind === "subitem") return c.num;
        if (c.kind === "note") return `해설${(children.get(c.parent) || []).filter((x) => x.kind === "note").indexOf(c) + 1}`;
        if (c.kind === "preamble") return "머리말";
        if (c.kind === "page_text") return c.lines.length ? `p${c.lines[0].p}` : "쪽";
        return c.label;
      });
      const cid = ["part", "chapter", "section"].includes(n.kind) ? parts.join("-") : parts.filter((_, i) => !["part", "chapter", "section"].includes(chain[i].kind)).join("-");
      const base = `${n.section}|${cid}`, k = (seen.get(base) || 0) + 1;
      seen.set(base, k); n.cid = k === 1 ? base : `${base}#${k}`; n.dup = k > 1;
    }
    const span = (n) => {
      let ps = n.lines.map((l) => l.p);
      for (const c of children.get(n.uid) || []) { const [a, b] = span(c); if (a) ps.push(a, b); }
      return ps.length ? [Math.min(...ps), Math.max(...ps)] : [null, null];
    };
    for (const n of nodes) {
      [n.page_start, n.page_end] = span(n);
      n.own_page_start = n.lines.length ? Math.min(...n.lines.map((l) => l.p)) : n.page_start;
    }
    return nodes;
  }

  function structureDoc(pages, bookmarks) {
    stripHeadersFooters(pages);
    const sizes = pages.flatMap((p) => p.lines.filter((l) => l.size).map((l) => l.size)).sort((a, b) => a - b);
    const body = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
    for (const p of pages) for (const l of p.lines) l.big = !!l.size && l.size >= body + 1.0;
    const { sections, source, tocPages } = buildSections(pages, bookmarks);
    const style = pages.reduce((a, p) => a + p.lines.filter((l) => RE.artBracket.test(l.text.trim())).length, 0) >= 3 ? "bracket" : "paren";
    const nodes = [];
    for (const s of sections) {
      s.toc_pages = s.kind === "terms" ? sectionTocPages(pages, s) : [];
      const skip = new Set(s.toc_pages.concat(tocPages));
      if (s.kind === "terms") {
        const b = new Builder(s, style);
        for (let pn = s.page_start; pn <= s.page_end; pn++) {
          if (skip.has(pn)) continue;
          pages[pn - 1].lines.forEach((l, i) => b.feed({ ...l, p: pn, line_no: i }));
        }
        nodes.push(...b.nodes);
      } else {
        for (let pn = s.page_start; pn <= s.page_end; pn++) {
          const b = new Builder(s, style); b.counter = pn * 10;
          const node = b.newNode("page_text", null, "", "", `${pn}쪽`);
          for (const l of pages[pn - 1].lines) b.addLine(node, { ...l, p: pn }, l.text);
          if (node.lines.length) nodes.push(node);
        }
      }
    }
    for (const p of pages) {
      const s = sections.find((x) => x.page_start <= p.pdf_page && p.pdf_page <= x.page_end);
      p.section = s ? s.id : "";
      p.is_toc = tocPages.includes(p.pdf_page) || sections.some((x) => (x.toc_pages || []).includes(p.pdf_page));
    }
    return { sections, nodes, toc_source: source, toc_pages: tocPages, article_style: style };
  }

  // ================================================================ 참조 연결
  const RE_ART_REF = /제\s*(\d+(?:\s*-\s*\d+)?)\s*조(?:\s*의\s*(\d+))?(?:\s*[(（][^)）]{0,60}[)）])?(?:\s*제\s*(\d+)\s*항)?(?:\s*제\s*(\d+)\s*호)?/g;
  const RE_PARA_REF = /제\s*(\d+)\s*항(?:\s*제\s*(\d+)\s*호)?/g;
  const RE_ITEM_REF = /제\s*(\d+)\s*호/g;
  const RE_APPX_REF = /별\s*표\s*(\d+(?:\s*-\s*\d+)?)/g;
  const RE_PREV = /(앞\s*항|전\s*항|앞의\s*항)/g;
  const RE_FOLLOW = /(다음|아래)\s*(?:의\s*)?(?:각\s*)?(?:어느\s*하나의?\s*)?(호|목|항)/g;
  const LAW_TAIL = /(」|법|령|규칙|규정|법률|같은\s*법|동법|시행령)\s*$/;

  function linkRefs(sections, nodes) {
    const byUid = new Map(nodes.map((n) => [n.uid, n])), children = childrenMap(nodes);
    const arts = new Map(), artsAny = new Map(), appx = new Map(), appxAny = new Map();
    for (const n of nodes) {
      if (n.kind === "article") { const k = `${n.section}|${n.num}`; if (!arts.has(k)) arts.set(k, n); (artsAny.get(n.num) || artsAny.set(n.num, []).get(n.num)).push(n); }
      if (n.kind === "appendix") { const k = `${n.section}|${n.num}`; if (!appx.has(k)) appx.set(k, n); (appxAny.get(n.num) || appxAny.set(n.num, []).get(n.num)).push(n); }
    }
    const mains = sections.filter((s) => s.kind === "terms").map((s) => s.id);
    const termsIds = new Set(mains);
    const articleOf = (n) => { while (n && !["article", "appendix"].includes(n.kind)) n = n.parent ? byUid.get(n.parent) : null; return n; };
    const findArticle = (sec, num, before) => {
      if (arts.has(`${sec}|${num}`)) return arts.get(`${sec}|${num}`);
      const c = artsAny.get(num) || [];
      if (before.slice(-20).includes("주계약") && mains.length) { const x = c.find((a) => a.section === mains[0] || a.section === mains[Math.min(1, mains.length - 1)]); if (x) return x; }
      if (c.length === 1) return c[0];
      if (num.includes("-") && c.length) return c[0];
      return null;
    };
    const childBy = (parent, kind, num) => {
      const k = (children.get(parent.uid) || []).find((c) => c.kind === kind && c.num === String(num));
      if (k) return k;
      if (kind === "item" && parent.kind === "article") {
        const f = (children.get(parent.uid) || []).filter((p) => p.kind === "paragraph").flatMap((p) => (children.get(p.uid) || []).filter((c) => c.kind === "item" && c.num === String(num)));
        if (f.length === 1) return f[0];
      }
      return null;
    };
    const isLaw = (text, i) => LAW_TAIL.test(text.slice(Math.max(0, i - 12), i));
    const refs = [];
    for (const n of nodes) {
      let text = n.text;
      if (!text || ["preamble", "page_text"].includes(n.kind) || !termsIds.has(n.section)) continue;
      if (["article", "appendix", "part", "chapter", "section"].includes(n.kind)) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
      const flat = text.replace(/\n/g, ""), taken = [], inNote = n.kind === "note";
      const add = (m, kind, target, status, note = "") => {
        if (status === "미해결" && inNote) status = "해설내미해결";
        refs.push({ from: n.cid, from_uid: n.uid, text: m[0].trim(), kind, target, status, note, page: n.own_page_start });
        taken.push([m.index, m.index + m[0].length]);
      };
      const free = (m) => !taken.some(([a, b]) => a <= m.index && m.index < b);
      for (const m of flat.matchAll(RE_ART_REF)) {
        if (isLaw(flat, m.index)) { add(m, "법령", null, "법령"); continue; }
        const num = normNum(m[1]) + (m[2] ? `의${m[2]}` : "");
        const art = findArticle(n.section, num, flat.slice(0, m.index));
        if (!art) { add(m, "조", null, "미해결", `제${num}조를 찾지 못함`); continue; }
        let target = art;
        if (m[3]) { const p = childBy(art, "paragraph", m[3]); if (!p) { add(m, "항", null, "미해결", `${art.cid}에 제${m[3]}항 없음`); continue; } target = p; }
        if (m[4]) { const it = childBy(target, "item", m[4]); if (!it) { add(m, "호", null, "미해결", `${target.cid}에 제${m[4]}호 없음`); continue; } target = it; }
        add(m, "조", [target.cid], "연결");
      }
      const art = articleOf(n);
      for (const m of flat.matchAll(RE_PARA_REF)) {
        if (!free(m)) continue;
        const law = isLaw(flat, m.index);
        if (law || !art || art.kind !== "article") { add(m, "항", null, law ? "법령" : "미해결", "같은 조문을 정할 수 없음"); continue; }
        let p = childBy(art, "paragraph", m[1]);
        if (!p) { add(m, "항", null, "미해결", `${art.cid}에 제${m[1]}항 없음`); continue; }
        if (m[2]) { const it = childBy(p, "item", m[2]); if (!it) { add(m, "호", null, "미해결", `${p.cid}에 제${m[2]}호 없음`); continue; } p = it; }
        add(m, "항", [p.cid], "연결");
      }
      for (const m of flat.matchAll(RE_ITEM_REF)) {
        if (!free(m)) continue;
        if (isLaw(flat, m.index)) { add(m, "호", null, "법령"); continue; }
        const holder = ["article", "paragraph"].includes(n.kind) ? n : n.parent ? byUid.get(n.parent) : null;
        let it = holder ? childBy(holder, "item", m[1]) : null;
        if (!it && art) it = childBy(art, "item", m[1]);
        if (!it) add(m, "호", null, "미해결", `제${m[1]}호를 찾지 못함`); else add(m, "호", [it.cid], "연결");
      }
      for (const m of flat.matchAll(RE_APPX_REF)) {
        if (!free(m) || (n.kind === "appendix" && m.index < 8)) continue;
        const num = normNum(m[1]);
        let t = appx.get(`${n.section}|${num}`);
        if (!t && (appxAny.get(num) || []).length === 1) t = appxAny.get(num)[0];
        if (!t && num.includes("-") && (appxAny.get(num) || []).length) t = appxAny.get(num)[0];
        if (!t) add(m, "별표", null, "미해결", `별표${num}을 찾지 못함`); else add(m, "별표", [t.cid], "연결");
      }
      if (n.kind !== "note") for (const m of flat.matchAll(RE_PREV)) {
        let p = n; while (p && p.kind !== "paragraph") p = p.parent ? byUid.get(p.parent) : null;
        let target = null;
        if (p) { const sibs = (children.get(p.parent) || []).filter((c) => c.kind === "paragraph"); const k = sibs.indexOf(p); if (k > 0) target = sibs[k - 1]; }
        if (!target) add(m, "앞 항", null, "미해결", "앞 항이 없음"); else add(m, "앞 항", [target.cid], "연결");
      }
      if (!["appendix", "note"].includes(n.kind)) for (const m of flat.matchAll(RE_FOLLOW)) {
        const want = { 호: "item", 목: "subitem", 항: "paragraph" }[m[2]];
        const kids = (children.get(n.uid) || []).filter((c) => c.kind === want);
        if (!kids.length) add(m, `다음 각 ${m[2]}`, null, "미해결", `이 조각 아래에 ${m[2]}가 없음`);
        else add(m, `다음 각 ${m[2]}`, kids.map((k) => k.cid), "연결");
      }
    }
    return refs;
  }

  // ================================================================ 품질 보고서
  function splitNum(num) { const m = /^(?:(\d+)-)?(\d+)(?:의(\d+))?$/.exec(num); return m ? [m[1] || "", +m[2], +(m[3] || 0)] : null; }

  function buildReport(sections, pages, nodes, tables, refs) {
    const children = childrenMap(nodes);
    const lowText = pages.filter((p) => p.chars < 20 || (p.chars < 100 && p.image_ratio > 0.3)).map((p) => ({ page: p.pdf_page,
      message: `추출 글자 ${p.chars}자, 이미지 비율 ${Math.round(p.image_ratio * 100)}%` + (p.image_ratio > 0.5 ? " — 스캔 쪽일 수 있음" : "") }));
    const gaps = [];
    for (const s of sections.filter((x) => x.kind === "terms")) {
      const arts = nodes.filter((n) => n.section === s.id && n.kind === "article"), last = {};
      for (const a of arts) {
        const k = splitNum(a.num); if (!k) continue;
        const [series, main, sub] = k; if (sub) continue;
        const prev = last[series], label = (x) => `제${series ? series + "-" : ""}${x}조`;
        if (prev == null) { if (main !== 1) gaps.push({ page: a.own_page_start, id: a.cid, message: `${s.title}: 첫 조문이 ${label(main)}입니다(제1조부터 시작하지 않음)` }); }
        else if (main === prev) gaps.push({ page: a.own_page_start, id: a.cid, message: `${s.title}: ${label(main)}가 중복됩니다` });
        else if (main !== prev + 1) gaps.push({ page: a.own_page_start, id: a.cid, message: `${s.title}: ${label(prev)} 다음에 ${label(main)}가 나옵니다` + (main > prev ? `(빠진 번호 ${main - prev - 1}개)` : "(번호가 거꾸로 감)") });
        last[series] = main;
      }
      if (!arts.length) gaps.push({ page: s.page_start, id: s.id, message: `${s.title}: 조문을 하나도 찾지 못했습니다` });
    }
    const subGaps = [];
    for (const kids of children.values()) for (const [kind, name] of [["paragraph", "항"], ["item", "호"], ["subitem", "목"]]) {
      const seq = kids.filter((k) => k.kind === kind); if (!seq.length) continue;
      let expect = 1;
      for (const k of seq) {
        const v = kind === "subitem" ? HANGUL_ITEMS.indexOf(k.num) + 1 : +k.num;
        if (v !== expect) {
          const owner = k.cid.slice(0, k.cid.lastIndexOf("-"));
          subGaps.push({ page: k.own_page_start, id: k.cid, message: v < expect ? `${owner}: ${name} 번호 ${k.label}가 중복됩니다` : `${owner}: ${name} 번호가 ${expect}번이 아닌 ${k.label}로 이어집니다` });
        }
        expect = v + 1;
      }
    }
    const msgRef = (r) => ({ page: r.page, id: r.from, message: `${r.from}의 "${r.text}" — ${r.note}` });
    const groups = [
      ["low_text", "텍스트가 거의 없는 쪽", lowText],
      ["article_gaps", "조문 번호 연속성", gaps],
      ["sub_gaps", "항·호·목 번호 끊김·중복", subGaps],
      ["dup_ids", "중복 ID", nodes.filter((n) => n.dup).map((n) => ({ page: n.own_page_start, id: n.cid, message: `같은 ID가 다시 나옵니다: ${n.cid}` }))],
      ["unresolved", "참조 미해결", refs.filter((r) => r.status === "미해결").map(msgRef)],
      ["note_unresolved", "참조 미해결(해설 상자 안, 법령 인용 등)", refs.filter((r) => r.status === "해설내미해결").map(msgRef)],
      ["bad_tables", "표 추출 불완전", tables.filter((t) => t.incomplete).map((t) => ({ page: t.page, id: t.id, message: `${t.id}(${t.page}쪽): ${t.reasons.join(", ")}` }))],
      ["rebuilt_tables", "표 재구성(원본 대조 권장)", tables.filter((t) => t.rebuilt && !t.incomplete).map((t) => ({ page: t.page, id: t.id, message: `${t.id}(${t.page}쪽): 세로선이 없어 글자 위치로 칸을 다시 나눈 표입니다. 원본과 대조하십시오` }))],
      ["ocr_low", "OCR 필요 쪽", pages.filter((p) => p.ocr).map((p) => ({ page: p.pdf_page, id: "", message: `${p.pdf_page}쪽: 스캔 쪽으로 보이지만 브라우저판에는 OCR이 없어 글자를 읽지 못했습니다(로컬 설치판 사용 권장)` }))],
    ];
    const cnt = (k) => nodes.filter((n) => n.kind === k).length;
    return { stats: { pages: pages.length, sections: sections.length, articles: cnt("article"), paragraphs: cnt("paragraph"), items: cnt("item"),
      subitems: cnt("subitem"), appendices: cnt("appendix"), notes: cnt("note"), tables: tables.length, refs: refs.length,
      refs_linked: refs.filter((r) => r.status === "연결").length, refs_law: refs.filter((r) => r.status === "법령").length },
    groups: groups.map(([key, title, items]) => ({ key, title, count: items.length, items })) };
  }

  function finalize(terms, pages, tables) {
    relink(terms.nodes); assignIds(terms.nodes);
    for (const t of tables) {
      const n = terms.nodes.find((x) => x.text.includes(`[표 ${t.id}]`));
      t.node = n ? n.cid : ""; const p = pages[t.page - 1]; t.section = p ? p.section : "";
    }
    terms.refs = linkRefs(terms.sections, terms.nodes);
    return buildReport(terms.sections, pages, terms.nodes, tables, terms.refs);
  }

  // ================================================================ 수정
  function applyEdit(terms, op, args) {
    const nodes = terms.nodes, i = nodes.findIndex((n) => n.uid === args.uid);
    if (i < 0) throw new Error("조각을 찾지 못했습니다");
    const n = nodes[i];
    const entry = { op, uid: n.uid, cid: n.cid, page: n.own_page_start };
    const sameSec = (j) => j >= 0 && j < nodes.length && nodes[j].section === n.section;
    if (op === "edit_text") { entry.before = n.text; n.text = args.text; entry.after = n.text; n.edited = true; }
    else if (op === "edit_meta") {
      entry.before = { kind: n.kind, num: n.num, title: n.title };
      if (!(args.kind in KIND_NAMES)) throw new Error("조각 종류가 올바르지 않습니다");
      n.kind = args.kind; n.num = String(args.num ?? n.num).trim(); n.title = String(args.title ?? n.title).trim(); n.label = makeLabel(n.kind, n.num);
      entry.after = { kind: n.kind, num: n.num, title: n.title }; n.edited = true;
    } else if (op === "split") {
      const at = +args.at_line, tl = n.text.split("\n");
      if (!(at > 0 && at < tl.length)) throw new Error("나눌 줄 번호가 올바르지 않습니다(둘째 줄부터 마지막 줄 사이)");
      const kind = args.kind || n.kind, num = String(args.num || "").trim(), gl = n.lines;
      const cut = gl.length === tl.length ? at : Math.max(1, Math.round(gl.length * at / tl.length));
      let uid = n.uid + "e1", k = 1; while (nodes.some((x) => x.uid === uid)) uid = n.uid + "e" + ++k;
      const nw = { uid, section: n.section, kind, parent: null, num, title: String(args.title || "").trim(), label: makeLabel(kind, num),
        text: tl.slice(at).join("\n"), lines: gl.slice(cut).length ? gl.slice(cut) : gl.slice(-1), edited: true };
      n.text = tl.slice(0, at).join("\n"); n.lines = gl.slice(0, cut).length ? gl.slice(0, cut) : gl.slice(0, 1);
      nodes.splice(i + 1, 0, nw); entry.after = { new_uid: uid, kind, num, at_line: at };
    } else if (op === "merge_prev") {
      if (!sameSec(i - 1)) throw new Error("같은 구간 안에 앞 조각이 없습니다");
      const prev = nodes[i - 1];
      prev.text = (prev.text + "\n" + n.text).replace(/^\n+|\n+$/g, ""); prev.lines = prev.lines.concat(n.lines); prev.edited = true;
      nodes.splice(i, 1); entry.after = { merged_into: prev.uid, merged_cid: prev.cid };
    } else if (op === "line_to_prev" || op === "line_to_next") {
      const j = op === "line_to_prev" ? i - 1 : i + 1;
      if (!sameSec(j)) throw new Error(op === "line_to_prev" ? "같은 구간 안에 앞 조각이 없습니다" : "같은 구간 안에 다음 조각이 없습니다");
      const o = nodes[j], tl = n.text.split("\n");
      const moved = op === "line_to_prev" ? tl.shift() : tl.pop();
      if (op === "line_to_prev") { o.text = (o.text + "\n" + moved).replace(/^\n+|\n+$/g, ""); if (n.lines.length) o.lines.push(n.lines.shift()); }
      else { o.text = (moved + "\n" + o.text).replace(/^\n+|\n+$/g, ""); if (n.lines.length) o.lines.unshift(n.lines.pop()); }
      n.text = tl.join("\n"); o.edited = n.edited = true;
      entry.after = { moved_line: moved, to: o.uid };
      if (!n.text.trim()) { if (op === "line_to_prev") o.lines.push(...n.lines); else o.lines.unshift(...n.lines); nodes.splice(i, 1); entry.after.removed_empty = true; }
    } else throw new Error(`알 수 없는 작업: ${op}`);
    return entry;
  }

  // ================================================================ 2단계: 담보 분류
  const MAJORS = ["사망", "장해", "진단", "입원", "치료", "기타"];
  const MAJOR_RULES = [["납입면제", "기타"], ["사망", "사망"], ["장해", "장해"], ["입원", "입원"], ["간병", "입원"], ["수술", "치료"], ["통원", "치료"],
    ["내원", "치료"], ["치료", "치료"], ["약물", "치료"], ["방사선", "치료"], ["검사", "치료"], ["조영술", "치료"], ["혈전", "치료"], ["산정특례", "진단"], ["진단", "진단"]];
  const MIDDLE_RULES = [["암", "암"], ["신생물", "암"], ["뇌", "뇌혈관질환"], ["심장", "심장질환"], ["심근", "심장질환"], ["허혈", "심장질환"], ["관상동맥", "심장질환"],
    ["대동맥", "심장질환"], ["판막", "심장질환"], ["순환계", "심장질환"], ["재해", "재해"], ["상해", "재해"], ["골절", "재해"], ["질병", "질병"]];
  const batchim = (w) => { const c = w.charCodeAt(w.length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0; };
  const euro = (w) => { const c = w.charCodeAt(w.length - 1); const rieul = c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 === 8; return w + (batchim(w) && !rieul ? "으로" : "로"); };
  function classifyMajor(name, reason, what = "급부명") {
    for (const [w, m] of MAJOR_RULES) if (name.includes(w)) return [m, `${what}에 '${w}'${batchim(w) ? "이" : "가"} 있어 ${euro(m)} 분류했습니다.`];
    for (const [w, m] of MAJOR_RULES) if (reason.includes(w)) return [m, `${what}으로는 정할 수 없어 지급사유의 '${w}' 낱말로 ${euro(m)} 분류했습니다.`];
    return ["기타", `${what}과 지급사유에 사망·장해·진단·입원·치료를 가리키는 낱말이 없어 기타로 분류했습니다.`];
  }
  const classifyMiddle = (t) => (MIDDLE_RULES.find(([w]) => t.includes(w)) || [null, "기타"])[1];
  const shortTitle = (t) => t.replace(/^R?\(무\)/, "").replace(/\((갱신형|간편심사형)\)/g, "").trim() || t;
  const joinText = (s) => String(s).replace(/\s*\n\s*/g, " ").trim();
  function cleanName(s) {
    const parts = String(s).split("\n").map((p) => p.trim()).filter(Boolean);
    let out = "";
    for (const p of parts) out = out && /^[가-힣ⅠⅡⅢⅣ]/.test(p) && /[가-힣)]$/.test(out) ? out + p : (out + " " + p).trim();
    return out.replace(/\(\s*제\s*[\d-]+\s*조[^)]*\)/g, "").replace(/\s+/g, " ").trim();
  }
  function benefitsFromTable(rows) {
    if (!rows.length) return [];
    const head = rows[0].map(joinText).join(" ");
    let body = (head.includes("급부") || head.includes("지급사유") ? rows.slice(1) : rows).map((r) => r.map(String));
    // 하위 표가 이어 붙은 경우의 반복 머리줄과 '나. 2종 보장계약' 같은 소제목 줄은 뺍니다.
    body = body.filter((r) => {
      const j = r.map(joinText).join(" ");
      if (j.includes("급부명") && j.includes("지급사유")) return false;
      const filled = r.filter((c) => c.trim());
      if (filled.length === 1 && /^[가-하]\.\s/.test(filled[0].trim())) return false;
      return !(/보장계약$/.test(j.trim()) && j.trim().length < 40 && !j.includes("피보험자"));
    });
    if (!body.length) return [];
    const ncol = Math.max(...body.map((r) => r.length));
    body = body.map((r) => r.concat(Array(ncol - r.length).fill("")));
    const score = [...Array(ncol).keys()].map((c) => body.filter((r) => r[c].includes("피보험자")).length);
    let rc = 0; score.forEach((s, c) => { if (s > score[rc]) rc = c; });
    if (!score[rc]) return [];
    // 지급사유 칸이 '피보험자'로 시작하는 행이 새 급부의 시작입니다(칸 중간의 '또는 피보험자가'는 아님).
    const starts = body.map((r, k) => (r[rc].trim().startsWith("피보험자") ? k : -1)).filter((k) => k >= 0);
    if (!starts.length) return [];
    const nameCols = [...Array(rc).keys()].filter((c) => body.some((r) => r[c].trim()));
    const amtCols = [...Array(ncol).keys()].filter((c) => c > rc && body.some((r) => r[c].trim()));
    // 지급사유 열 바로 왼쪽(가장 오른쪽) 칸이 하위 급부명, 그 왼쪽 칸들은 급부 그룹입니다.
    const subCols = nameCols.length ? [nameCols[nameCols.length - 1]] : [];
    const groupCols = nameCols.slice(0, -1), groupCol = groupCols.length ? groupCols[0] : null;
    const group = cleanName(body.flatMap((r) => groupCols.map((c) => r[c]).filter((x) => x.trim())).join("\n"));
    const out = starts.map((st, i) => {
      const a = i === 0 ? 0 : st, b = i + 1 < starts.length ? starts[i + 1] : body.length, block = body.slice(a, b);
      let name = cleanName(block.flatMap((r) => subCols.map((c) => r[c]).filter((x) => x.trim())).join("\n"));
      if (!name && groupCol == null && starts.length > 1) name = cleanName(body.flatMap((r) => subCols.map((c) => r[c]).filter((x) => x.trim())).join("\n"));
      // 지급사유 칸 하나에 여러 줄이 든 경우 칸 내용을 그대로 씁니다.
      const reason = joinText(body.slice(st, b).map((r) => r[rc]).filter((x) => x.trim()).join(" "));
      const amount = block.filter((r) => amtCols.some((c) => r[c].trim())).map((r) => amtCols.map((c) => joinText(r[c])).filter(Boolean).join(" ")).join(" / ");
      return { name: name || group, reason, amount };
    });
    // 급부명이 '(요양병원'처럼 괄호가 닫히지 않았으면 지급사유 칸의 줄바꿈으로 잘못 나뉜 것이므로 다음 급부와 합칩니다.
    const merged = [];
    for (const b of out) {
      const prev = merged[merged.length - 1];
      if (prev && (prev.name.match(/\(/g) || []).length > (prev.name.match(/\)/g) || []).length) {
        prev.name = cleanName(prev.name + "\n" + b.name); prev.reason = (prev.reason + " " + b.reason).trim();
        prev.amount = [prev.amount, b.amount].filter(Boolean).join(" / ");
      } else merged.push({ ...b });
    }
    return merged.map((b) => ({ group: b.name.replace(/\s*[ⅠⅡⅢⅣⅤ]+$/, ""), ...b }));
  }
  const KEY_TITLE_WORDS = ["용어의정의", "정의", "지급사유", "지급에관한세부규정", "지급하지않는", "보장개시", "보험기간", "갱신", "납입면제", "소멸"];
  function buildCoverage(terms, tables) {
    const nodes = terms.nodes, tById = new Map(tables.map((t) => [t.id, t])), items = [], common = [];
    for (const sec of terms.sections) {
      if (sec.kind !== "terms") continue;
      if (sec.title.includes("일반사항")) { common.push({ section: sec.id, title: sec.title }); continue; }
      const secNodes = nodes.filter((n) => n.section === sec.id), arts = secNodes.filter((n) => ["article", "appendix"].includes(n.kind));
      if (!arts.length) continue;
      const key = arts.filter((n) => n.kind === "article" && KEY_TITLE_WORDS.some((w) => norm(n.title).includes(w))).map((n) => n.cid);
      const rng = { section: sec.id, first: arts[0].cid, last: arts[arts.length - 1].cid, pages: [sec.page_start, sec.page_end] };
      const middle = classifyMiddle(sec.title), minor = shortTitle(sec.title), found = [];
      for (const apx of secNodes.filter((n) => n.kind === "appendix" && norm(n.title).includes("지급기준표"))) {
        for (const m of apx.text.matchAll(/\[표 (T\d+)\]/g)) {
          const t = tById.get(m[1]); if (!t) continue;
          benefitsFromTable(t.rows).forEach((b, k) => found.push([b, { type: "지급기준표", appendix: apx.cid, table: t.id, row: k, page: t.page }]));
        }
      }
      if (!found.length) {
        let major, why;
        if (["서비스", "전환특약", "인수특약"].some((w) => sec.title.includes(w))) [major, why] = ["기타", "서비스·전환·인수 조건 특약이어서 보험금 대분류에 맞지 않아 기타로 분류했습니다."];
        else if (sec.title.includes("납입면제")) [major, why] = ["기타", "보험료 납입면제 특약이어서 보험금 대분류에 맞지 않아 기타로 분류했습니다."];
        else if (!arts.some((n) => n.kind === "article" && norm(n.title).includes("지급사유"))) [major, why] = ["기타", "보험금 지급기준표와 지급사유 조문이 없는 특약이어서 기타로 분류했습니다."];
        else { [major, why] = classifyMajor(sec.title, "", "특약명"); why = "보험금 지급기준표가 없어 특약 하나를 담보 하나로 보았고, " + why; }
        found.push([{ group: minor, name: minor, reason: "", amount: "", _major: [major, why] }, { type: "특약", appendix: "", table: "", row: 0, page: sec.page_start }]);
      }
      for (const [b, src] of found) {
        const [major, why] = b._major || classifyMajor(b.name, b.reason);
        items.push({ id: `C${String(items.length + 1).padStart(4, "0")}`, name: b.name, auto_name: b.name, group: b.group, major, middle, minor,
          reason_note: why, pay_reason: b.reason, pay_amount: b.amount, section: sec.id, section_title: sec.title, source: src, range: rng,
          key_articles: key, selected: false, moved: false, renamed: false });
      }
    }
    return { majors: MAJORS, items, common_sections: common };
  }
  const itemKey = (it) => `${it.section}|${it.source.table || ""}|${it.source.row || 0}|${it.auto_name}`;

  // ================================================================ 3단계: 입력 구성·인용 대조
  const A_FIELDS = [["pay_reason", "지급사유"], ["amount", "지급금액과 산식"], ["limits", "지급횟수와 한도(1회·연간·통산)"], ["coverage_start", "보장개시일"],
    ["exemption_period", "면책기간"], ["reduction", "감액기간과 감액비율"], ["term_renewal", "보험기간과 갱신 여부"], ["exclusions", "지급하지 않는 사유"],
    ["definitions", "요건의 세부 정의(진단확정·입원일수 등)"], ["after_payment", "지급 후 계약 소멸·납입면제·가입금액 감액 여부"]];
  const B_CATEGORIES = ["별표 참조", "산출에 영향을 주는 용어 정의", "단서·예외에 따른 조건 분기", "다른 담보와의 중복지급·택일", "경과기간·연령·성별별 지급률 차이", "기준일 판단", "기타"];

  const tableText = (t) => `[표 ${t.id} | ${t.page}쪽]\n` + t.rows.map((r) => r.map((c) => c.replace(/\n/g, " ")).join(" | ")).join("\n");

  function buildInput(item, terms, tables, common) {
    const nodes = terms.nodes, byCid = new Map(nodes.map((n) => [n.cid, n])), byUid = new Map(nodes.map((n) => [n.uid, n]));
    const tById = new Map(tables.map((t) => [t.id, t])), children = childrenMap(nodes);
    const topOf = (n) => { while (n.parent && !["article", "appendix"].includes(n.kind)) n = byUid.get(n.parent); return n; };
    const subtree = (n) => [n].concat(...(children.get(n.uid) || []).map(subtree));
    const sec = item.range.section;
    const own = nodes.filter((n) => n.section === sec && !["part", "chapter", "section"].includes(n.kind));
    const ownU = new Set(own.map((n) => n.uid)), referenced = [];
    for (const r of terms.refs) if (ownU.has(r.from_uid) && r.status === "연결") for (const t of r.target) {
      const tn = byCid.get(t);
      if (tn && tn.section !== sec) { const top = topOf(tn); if (!referenced.some((x) => x.uid === top.uid)) referenced.push(top); }
    }
    const commonIds = new Set(common.map((c) => c.section));
    const defs = nodes.filter((n) => n.kind === "article" && n.title.includes("정의") && (commonIds.has(n.section) || n.section === sec));
    const seen = new Set();
    const render = (group) => {
      const lines = [], cids = [];
      for (const top of group) for (const n of subtree(top)) {
        if (seen.has(n.uid)) continue; seen.add(n.uid); cids.push(n.cid);
        let text = n.text;
        for (const m of n.text.matchAll(/\[표 (T\d+)\]/g)) if (tById.has(m[1])) text = text.replace(m[0], "\n" + tableText(tById.get(m[1])));
        lines.push(`[${n.cid}] (${n.path}, ${n.own_page_start}쪽)` + (n.kind === "note" ? " ※해설 상자" : "") + "\n" + text);
      }
      return [lines.join("\n\n"), cids];
    };
    const commonDefs = defs.filter((d) => d.section !== sec);
    const [cText, c1] = render(commonDefs);
    const ownTops = own.filter((n) => !n.parent || ["part", "chapter", "section"].includes(byUid.get(n.parent).kind));
    const [oText, c2] = render(ownTops);
    const [rText, c3] = render(referenced.filter((r) => !commonDefs.includes(r)));
    const itemText = `■ 담보: ${item.name} (특약: ${item.section_title}, 지급기준표 급부 그룹: ${item.group})\n■ 지급기준표의 지급사유 원문: ${item.pay_reason || "없음"}\n■ 지급기준표의 지급금액 원문: ${item.pay_amount || "없음"}\n\n=== 이 담보가 속한 특약의 조문 ===\n${oText}\n\n=== 위 조문이 참조하는 다른 구간의 조문 ===\n${rText || "없음"}`;
    return { common: `=== 공통 용어 정의 조문 ===\n${cText || "없음"}`, item: itemText, ids: c1.concat(c2, c3) };
  }

  const PROMPT_RULES = `당신은 생명보험 보험금 심사 전산화(자동산출 룰 입력)를 돕는 약관 분석 보조자입니다.
아래에 한 담보의 약관 조문, 그 조문이 참조하는 조문·표, 용어 정의 조문이 주어집니다. 조문마다 [ID]가 붙어 있습니다.

규칙
1. 입력된 조문만 근거로 씁니다. 일반 상식이나 다른 상품의 관행으로 채우지 않습니다.
2. 약관에서 찾지 못한 항목은 추정하지 말고 status를 "약관에 명시 없음"으로, value를 빈 문자열로, evidence를 빈 배열로 둡니다.
3. 근거가 있는 항목은 evidence에 node_id(입력의 [ID] 그대로)와 quote(그 조문 원문을 한 글자도 바꾸지 않고 옮긴 한두 문장)를 넣습니다. 인용문은 프로그램이 원문과 문자열로 대조하므로 요약·의역·생략 부호를 쓰지 않습니다. 표 안의 글자를 인용할 때는 표가 들어 있는 조문 ID를 씁니다.
4. 별표 안의 수치와 지급률은 풀어 쓰지 않습니다. value에는 "별표2-1 보험금 지급기준표에 따름"처럼 표 이름만 적고, tables_referenced에 그 별표·표 ID를 넣습니다.
5. 해석이 갈릴 수 있으면 status를 "해석 확인 필요"로 하고 interpretations에 가능한 해석을 모두 적습니다.
6. B에는 전산화(룰 입력) 때 주의할 점을 적습니다: 별표 참조와 표 이름, 산출에 영향을 주는 용어 정의, "다만" 단서와 예외의 예외로 생기는 조건 분기, 다른 담보와의 중복지급·택일, 경과기간·연령·성별별 지급률 차이, 기준일(사고일·진단일·입원개시일·수술일) 판단.
7. 한국어로, 완결된 문장으로 씁니다.

출력: 다음 모양의 JSON 하나만 답합니다(설명 문장 없이).
{"A": {${A_FIELDS.map(([k]) => `"${k}": 항목`).join(", ")}},
 "B": [{"category": ${B_CATEGORIES.map((c) => `"${c}"`).join(" | ")}, "content": "…", "needs_confirmation": true|false, "interpretations": ["…"], "evidence": [근거]}],
 "tables_referenced": ["S023|별표2-1"]}
항목 = {"status": "명시" | "약관에 명시 없음" | "해석 확인 필요", "value": "…", "interpretations": ["…"], "evidence": [근거]}
근거 = {"node_id": "입력의 [ID]", "quote": "원문 그대로 한두 문장"}
A의 각 키 뜻: ${A_FIELDS.map(([k, l]) => `${k}=${l}`).join(", ")}`;

  function buildPrompt(input) { return `${PROMPT_RULES}\n\n${input.common}\n\n${input.item}\n\n위 조문만 근거로 이 담보의 결과 카드를 JSON으로 작성하십시오.`; }

  function verificationText(n, children, tById) {
    const parts = [n.text];
    for (const m of n.text.matchAll(/\[표 (T\d+)\]/g)) if (tById.has(m[1])) parts.push(tById.get(m[1]).rows.flat().join(" "));
    for (const c of children.get(n.uid) || []) parts.push(verificationText(c, children, tById));
    return parts.join("\n");
  }

  function locateQuote(n, quote, pages, tById) {
    const q = norm(quote);
    for (const m of n.text.matchAll(/\[표 (T\d+)\]/g)) {
      const t = tById.get(m[1]);
      if (t && q && norm(t.rows.flat().join(" ")).includes(q) && !norm(n.text).includes(q))
        return { page: t.page, printed_page: pages[t.page - 1].printed_page, boxes: [{ p: t.page, bbox: t.bbox }], table: t.id };
    }
    const lines = n.text.split("\n"), geo = n.lines;
    let flat = ""; const owners = [];
    lines.forEach((l, i) => { const s = norm(l); flat += s; for (let k = 0; k < s.length; k++) owners.push(i); });
    const k = q ? flat.indexOf(q.slice(0, Math.max(8, Math.min(q.length, 30)))) : -1;
    if (k < 0 || geo.length !== lines.length) { const p = n.own_page_start; return { page: p, printed_page: p ? pages[p - 1].printed_page : null, boxes: [] }; }
    const a = owners[k], b = owners[Math.min(owners.length - 1, k + q.length - 1)], hit = geo.slice(a, b + 1);
    return { page: hit[0].p, printed_page: pages[hit[0].p - 1].printed_page, boxes: hit.map((g) => ({ p: g.p, bbox: g.bbox })) };
  }

  /* AI 결과 확인: 모양이 틀리면 오류, 인용이 원문에 없으면 '근거 불일치'로 격리합니다. */
  function verify(result, terms, tables, pages, inputIds) {
    if (!result || typeof result !== "object" || !result.A || typeof result.A !== "object") throw new Error("응답이 정해진 JSON 모양이 아닙니다(A 없음).");
    const nodes = terms.nodes, byCid = new Map(nodes.map((n) => [n.cid, n])), children = childrenMap(nodes), tById = new Map(tables.map((t) => [t.id, t]));
    const allowed = new Set(inputIds), cache = new Map();
    const arr = (x) => (Array.isArray(x) ? x : []);
    const check = (evs) => {
      let ok = true;
      const out = arr(evs).map((e) => {
        e = { node_id: String((e && e.node_id) || ""), quote: String((e && e.quote) || "") };
        const n = byCid.get(e.node_id); let reason = "";
        if (!n) reason = "입력에 없는 조문 ID";
        else if (!allowed.has(e.node_id)) reason = "이 담보의 입력에 포함되지 않은 조문";
        else {
          if (!cache.has(n.uid)) cache.set(n.uid, norm(verificationText(n, children, tById)));
          if (!norm(e.quote) || !cache.get(n.uid).includes(norm(e.quote))) reason = "인용문이 조문 원문에 없음";
        }
        const item = { ...e, matched: !reason, reason };
        if (n) Object.assign(item, { path: n.path }, locateQuote(n, e.quote, pages, tById));
        ok = ok && !reason; return item;
      });
      return [out, ok];
    };
    const card = { A: [], B: [], mismatch: [], tables: [] };
    for (const [key, label] of A_FIELDS) {
      const f = result.A[key] || { status: "약관에 명시 없음", value: "", interpretations: [], evidence: [] };
      const status = ["명시", "약관에 명시 없음", "해석 확인 필요"].includes(f.status) ? f.status : "해석 확인 필요";
      let [evs, ok] = check(f.evidence);
      const entry = { key, label, status, value: String(f.value || ""), interpretations: arr(f.interpretations).map(String), evidence: evs };
      if (status !== "약관에 명시 없음" && !evs.length) { ok = false; entry.mismatch_reason = "근거 인용이 없음"; }
      if (ok) card.A.push(entry);
      else {
        entry.mismatch_reason = entry.mismatch_reason || "근거 인용문이 원문과 일치하지 않음";
        card.A.push({ key, label, status: "근거 불일치", value: "", interpretations: [], evidence: [] });
        card.mismatch.push({ ...entry, section: "A" });
      }
    }
    for (const b of arr(result.B)) {
      let [evs, ok] = check(b.evidence);
      const entry = { category: String(b.category || "기타"), content: String(b.content || ""), needs_confirmation: !!b.needs_confirmation,
        interpretations: arr(b.interpretations).map(String), evidence: evs };
      if (!evs.length) { ok = false; entry.mismatch_reason = "근거 인용이 없음"; }
      if (ok) card.B.push(entry);
      else card.mismatch.push({ ...entry, section: "B", label: entry.category, mismatch_reason: entry.mismatch_reason || "근거 인용문이 원문과 일치하지 않음" });
    }
    for (let ref of arr(result.tables_referenced)) {
      ref = String(ref).trim(); let tids = [];
      if (/^T\d+$/.test(ref)) tids = [ref];
      else if (byCid.has(ref)) tids = [...verificationText(byCid.get(ref), children, new Map()).matchAll(/\[표 (T\d+)\]/g)].map((m) => m[1]);
      card.tables.push({ ref, known: tids.length > 0 || byCid.has(ref), table_ids: tids });
    }
    return card;
  }

  return { processPage, structureDoc, finalize, applyEdit, makeLabel, KIND_NAMES, buildCoverage, itemKey, benefitsFromTable, classifyMajor,
    MAJORS, A_FIELDS, B_CATEGORIES, buildInput, buildPrompt, verify, norm };
});
