// PDF 를 쪽별 줄 목록으로 바꿉니다. 각 줄에는 화면 강조(3단계)에 쓸 좌표를 함께 둡니다.
// 쪽마다 (1) 스캔(이미지) 쪽인지, (2) 약관에 인쇄된 쪽번호가 무엇인지, (3) 머리글·바닥글 줄인지도 판정합니다.
// 이 파일은 Node 전용 모듈을 쓰지 않아 서버(server/pdf/extract.js)와 브라우저(아티팩트)에서 함께 씁니다.
// 같은 줄로 볼 y 좌표 허용 오차(pt)
const LINE_TOLERANCE = 2.5;
// 공백을 뺀 글자가 이보다 적고 이미지가 그려진 쪽은 스캔 쪽으로 봅니다.
const SCAN_CHAR_LIMIT = 20;
// 쪽 위·아래 이 비율 안에 있는 줄만 머리글·바닥글·쪽번호 후보로 봅니다.
const MARGIN_RATIO = 0.09;

// 텍스트 조각을 y 로 묶어 줄을 만들고, 줄 안에서는 x 순으로 잇습니다. 조각 사이가 벌어져 있으면 공백을 넣습니다.
function buildLines(items, pageHeight) {
  const pieces = items
    .filter((it) => it.str && it.str.trim())
    .map((it) => {
      const h = Math.abs(it.transform[3]) || Math.abs(it.height) || 10;
      return { s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h };
    });
  pieces.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const p of pieces) {
    const row = rows.find((r) => Math.abs(r.y - p.y) <= LINE_TOLERANCE);
    if (row) row.pieces.push(p);
    else rows.push({ y: p.y, pieces: [p] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.pieces.sort((a, b) => a.x - b.x);
    let t = '', end = null;
    for (const p of r.pieces) {
      // 글자 높이의 2배보다 넓게 벌어진 곳은 표의 열 경계로 보고 " | "로 나눕니다.
      if (end !== null && p.x - end > p.h * 2) t = `${t.trimEnd()} | `;
      else if (end !== null && p.x - end > p.h * 0.25 && !t.endsWith(' ')) t += ' ';
      t += p.s;
      end = p.x + p.w;
    }
    const x0 = Math.min(...r.pieces.map((p) => p.x));
    const x1 = Math.max(...r.pieces.map((p) => p.x + p.w));
    const h = Math.max(...r.pieces.map((p) => p.h));
    // 좌표는 PDF 좌표계(왼쪽 아래 원점)를 왼쪽 위 원점으로 바꿔 둡니다.
    return { t: t.replace(/\s+/g, ' ').trim(), x: round(x0), y: round(pageHeight - r.y - h), w: round(x1 - x0), h: round(h) };
  }).filter((l) => l.t);
}

const round = (n) => Math.round(n * 10) / 10;

// 쪽번호로 보이는 줄: "12", "- 12 -", "12 / 340", "p.12", "12쪽"
const PAGE_NUMBER_LINE = /^(?:[-–—\s]*|p\.?\s*)(\d{1,4})(?:\s*[-–—]\s*|\s*\/\s*\d{1,4}|\s*쪽)?\s*$/i;

function pageNumberCandidates(lines, pageHeight) {
  const out = [];
  for (const l of lines) {
    const inMargin = l.y < pageHeight * MARGIN_RATIO || l.y + l.h > pageHeight * (1 - MARGIN_RATIO);
    if (!inMargin) continue;
    const m = l.t.match(PAGE_NUMBER_LINE);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

// 인쇄 쪽번호는 앞뒤 쪽과 "PDF 쪽 − 인쇄 쪽" 차이가 같을 때만 인정합니다. 표 안의 숫자 하나를 쪽번호로 오인하지 않기 위해서입니다.
function resolvePrintedPages(candidates) {
  const n = candidates.length;
  const printed = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    for (const c of candidates[i]) {
      const offset = i - c;
      let agree = false;
      for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3) && !agree; j++) {
        if (j !== i && candidates[j].some((d) => j - d === offset)) agree = true;
      }
      if (agree) { printed[i] = c; break; }
    }
  }
  return printed;
}

// 머리글·바닥글 판정. 다음을 모두 만족하는 줄만 머리글·바닥글로 봅니다.
//  - 쪽의 맨 위·맨 아래 두 줄 가운데 여백 안에 있음
//  - 숫자를 지운 글자와 세로 위치가 같은 줄이 세 쪽 이상 반복됨
//  - 조문·항·호나 "~다."로 끝나는 본문 문장의 모양이 아님
//  - 본문보다 글자가 작거나, 이웃 본문 줄과 줄 간격보다 크게 떨어져 있음
// 쪽번호 모양의 줄은 위 조건과 관계없이 머리글·바닥글로 봅니다.
const BODY_LIKE = /^(제\s*\d+\s*조|제\s*\d+\s*관|[①-⑳]|\d+\.|[가-하]\.|\(\d+\))|다\.\s*$|[\[【<〈]\s*별표/;
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };

function markNoise(pages) {
  const key = (l) => `${l.t.replace(/\d+/g, '#').replace(/\s+/g, '')}@${Math.round(l.y / 6)}`;
  const edgeIdx = (p) => p.lines.map((l, i) => i).filter((i) => p.lines[i].margin && (i < 2 || i >= p.lines.length - 2));
  const bodyH = median(pages.flatMap((p) => p.lines.map((l) => l.h)));
  const count = new Map();
  for (const p of pages) for (const k of new Set(edgeIdx(p).map((i) => key(p.lines[i])))) count.set(k, (count.get(k) || 0) + 1);
  for (const p of pages) {
    const gaps = p.lines.slice(1).map((l, i) => l.y - p.lines[i].y).filter((g) => g > 0);
    const step = median(gaps) || bodyH * 1.5;
    for (const i of edgeIdx(p)) {
      const l = p.lines[i];
      if (PAGE_NUMBER_LINE.test(l.t)) { l.noise = true; continue; }
      if ((count.get(key(l)) || 0) < 3 || BODY_LIKE.test(l.t)) continue;
      const small = l.h < bodyH * 0.92;
      const prev = p.lines[i - 1], next = p.lines[i + 1];
      const gap = Math.min(prev ? l.y - prev.y : Infinity, next ? next.y - l.y : Infinity);
      if (small || gap > step * 1.6) l.noise = true;
    }
    for (const l of p.lines) delete l.margin;
  }
}

// 반환: { numPages, pages: [{ n, printed, width, height, chars, scanned, blank, lines: [{ t, x, y, w, h, noise? }] }] }
// pdfjs: pdf.js 라이브러리 객체, params: getDocument 에 넘길 값(data·문자표 위치 등). 서버와 브라우저가 각자 넘깁니다.
async function extractPages(pdfjs, params, onProgress = () => {}) {
  // isEvalSupported 는 항상 끕니다(악성 PDF 의 글꼴로 스크립트가 실행되는 취약점 차단).
  const doc = await pdfjs.getDocument({ ...params, isEvalSupported: false, verbosity: 0 }).promise;

  const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);
  const pages = [];
  const candidates = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      const { items } = await page.getTextContent();
      const lines = buildLines(items, height);
      for (const l of lines) l.margin = l.y < height * MARGIN_RATIO || l.y + l.h > height * (1 - MARGIN_RATIO);
      const chars = lines.reduce((s, l) => s + l.t.replace(/\s/g, '').length, 0);
      let scanned = false;
      let blank = false;
      if (chars < SCAN_CHAR_LIMIT) {
        const ops = await page.getOperatorList();
        scanned = ops.fnArray.some((f) => imageOps.has(f));
        blank = !scanned && chars === 0;
      }
      candidates.push(pageNumberCandidates(lines, height));
      pages.push({ n, printed: null, width: round(width), height: round(height), chars, scanned, blank, lines });
      page.cleanup();
      onProgress(n, doc.numPages);
    }
  } finally {
    await doc.destroy();
  }
  const printed = resolvePrintedPages(candidates);
  pages.forEach((p, i) => { p.printed = printed[i]; });
  markNoise(pages);
  return { numPages: pages.length, pages };
}

module.exports = { extractPages, buildLines, resolvePrintedPages, markNoise, PAGE_NUMBER_LINE };
