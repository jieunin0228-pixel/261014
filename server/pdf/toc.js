// 목차 인식과 약관 구간 분리.
// 본문에서 "약관 제목 줄 + 곧이어 제1조"가 나오는 곳(또는 조문 번호가 제1조로 다시 시작하는 곳)을 구간 경계로 삼고,
// 목차가 있으면 목차 항목과 짝을 지어 목차 순서·인쇄 쪽번호를 확인합니다. 목차에만 있고 본문에서 못 찾은 약관은 경고로 남깁니다.

// 조문 제목 줄: "제3조(보험금의 지급사유)", "제3조【보험금의 지급사유】", "제3조[…]", "제3조「…」", "제3조의2(…)",
// 괄호 없이 "제3조 보험금의 지급사유"처럼 제목만 있는 줄도 인정합니다(본문 문장과 헷갈리지 않도록 조건을 둡니다).
const ARTICLE_BRACKET = /^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*[(（【\[〔〈<「『]\s*([^)）】\]〕〉>」』]{1,60}?)\s*[)）】\]〕〉>」』]/;
const ARTICLE_BARE = /^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s+([가-힣][가-힣A-Za-z0-9·ㆍ,\s]{0,38}[가-힣])\s*$/;
const BARE_NOT_TITLE = /제\s*\d+\s*(항|호|조)|(은|는|이|가|을|를|의|에|에서|로|으로|와|과|및|또는|및|하여|하고|하며|한|할|된|되는|따라)$/;
function parseArticle(line) {
  const t = String(line || '').trim();
  let m = t.match(ARTICLE_BRACKET);
  if (!m) {
    m = t.match(ARTICLE_BARE);
    if (!m || BARE_NOT_TITLE.test(m[3]) || t.length > 45) return null;
  }
  return { no: Number(m[1]), sub: m[2] ? Number(m[2]) : null, title: m[3].trim() };
}
const ARTICLE_LINE = { test: (t) => !!parseArticle(t) };
const FIRST_ARTICLE = { test: (t) => { const a = parseArticle(t); return !!a && a.no === 1 && !a.sub; } };
const CHAPTER_LINE = /^제\s*\d+\s*관\s*\S/;
// 목차 줄: 제목 뒤에 점선(또는 넓은 공백)과 쪽번호
const TOC_ENTRY = /^(.*?[^\s|])[\s|]*(?:[.·…ㆍ‧∙•_\-]{2,}|\s{2,}|\s(?=\d{1,4}$))[\s|]*(\d{1,4})$/;
// 약관 제목 끝: "…특약", "…특별약관", "…보통약관", "…주계약", 손해보험식 "…담보". 뒤에 (갱신형)·Ⅱ·2.0·[무배당] 같은 꼬리와 "약관"이 붙어도 됩니다.
const TITLE_KEY = /(보통보험약관|보통약관|특별약관|특약|주계약|담보)(\s*([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|\d+(\.\d+)?\s*형?|[(（][^)）]*[)）]|\[[^\]]*\]))*\s*(약관)?$/;
// 제목 앞뒤 장식 기호
const DECOR = '◆◇■□●○▶▷►★☆※•▣◈◎♦❖=＝~∼\\-–—';
const APPENDIX_LINE = /^[【\[<〈]?\s*별표\s*(\d+)(?:\s*[-의]\s*\d+)?\s*[】\]>〉]?\s*(.{0,50})$/;
const BODY_ENDING = /(다\.|다\)|하며,|하고,|경우|에\s*따라|합니다|입니다)\s*$/;

// 제목 비교용: 글자와 숫자만 남깁니다(띄어쓰기·괄호·장식 기호 차이 무시).
const norm = (s) => String(s).replace(/[^\p{L}\p{N}]/gu, '');

const DECOR_EDGE = new RegExp(`^[${DECOR}\\s]+|[${DECOR}\\s]+$`, 'g');
function cleanTitle(line) {
  return String(line).replace(DECOR_EDGE, '').replace(/^(\d+(?:-\d+)*[.)]|\(\d+\)|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.?|[가-하]\.)\s*/, '')
    .replace(/^[【\[<〈《\s]+|[】\]>〉》\s]+$/g, '').replace(DECOR_EDGE, '').trim();
}

// 약관 제목 줄이면 { title, kind }, 아니면 null
function sectionTitle(line) {
  if (!line || line.length > 80 || ARTICLE_LINE.test(line) || /^[①-⑳]/.test(line) || BODY_ENDING.test(line)) return null;
  const app = line.match(APPENDIX_LINE);
  if (app && /^[【\[<〈]|^별표/.test(line)) return { title: `별표${app[1]} ${app[2].trim()}`.trim(), kind: '별표', appendixNo: Number(app[1]) };
  // 제목 뒤의 꼬리표(예: "[무배당]", "[2024.1 개정]")는 떼고 판정합니다.
  const t = cleanTitle(line.replace(/\s*[\[【][^\]】]*[\]】]\s*$/, ''));
  if (!TITLE_KEY.test(t) || /(에\s*따라|경우|하여|에서|이\s*특약|의\s*체결|따른)/.test(t)) return null;
  return { title: t, kind: /보통|주계약/.test(t) ? '보통약관' : '특별약관' };
}

function levelOf(title) {
  if (ARTICLE_LINE.test(title)) return '조';
  if (CHAPTER_LINE.test(title)) return '관';
  const s = sectionTitle(title);
  return s ? s.kind : '기타';
}

// 목차 쪽: 목차 줄이 6개 이상이고 그 줄이 본문 줄의 절반 이상인 쪽. 보통 문서 앞부분에 몰려 있습니다.
function findToc(pages) {
  const tocPages = [];
  const entries = [];
  for (const p of pages) {
    const body = p.lines.filter((l) => !l.noise);
    const hits = body.filter((l) => TOC_ENTRY.test(l.t));
    const isToc = hits.length >= 6 && hits.length >= body.length * 0.5;
    if (!isToc) {
      if (tocPages.length && p.n - tocPages[tocPages.length - 1] > 2) break; // 목차가 끝난 뒤의 본문
      continue;
    }
    tocPages.push(p.n);
    for (const l of hits) {
      const m = l.t.match(TOC_ENTRY);
      const title = m[1].replace(/[.·…ㆍ‧∙•_\-\s]+$/, '').trim();
      entries.push({ title, printed: Number(m[2]), level: levelOf(title), tocPage: p.n });
    }
  }
  return { tocPages, entries };
}

// 머리글·바닥글·목차 쪽을 뺀 본문 줄을 한 줄로 이어 붙입니다. 각 줄은 쪽 번호와 쪽 안 줄 번호를 기억합니다.
function bodyStream(pages, tocPages) {
  const skip = new Set(tocPages);
  const stream = [];
  for (const p of pages) {
    if (skip.has(p.n)) continue;
    p.lines.forEach((l, i) => { if (!l.noise) stream.push({ t: l.t, p: p.n, i }); });
  }
  return stream;
}

function nextArticleIndex(stream, from, limit = 14) {
  for (let j = from + 1; j < Math.min(stream.length, from + limit); j++) {
    if (ARTICLE_LINE.test(stream[j].t)) return j;
    if (sectionTitle(stream[j].t)) return -1;
  }
  return -1;
}

// 반환: [{ id, title, kind, appendixNo?, start, end, startPage, endPage, articles: [{ no, sub, title, line, page }] }]
// start/end 는 stream 의 줄 위치(end 는 포함하지 않음)입니다.
// forced: 목차에서 찾아낸 약관 시작 위치 [{ start, title, kind, appendixNo? }] — 제목 모양과 관계없이 경계로 씁니다.
function splitSections(stream, forced = []) {
  const heads = [];
  let sawArticle = false;
  for (let i = 0; i < stream.length; i++) {
    const t = stream[i].t;
    const head = sectionTitle(t);
    if (head && head.kind === '별표') { heads.push({ ...head, start: i }); sawArticle = false; continue; }
    if (head) {
      const j = nextArticleIndex(stream, i);
      if (j >= 0 && FIRST_ARTICLE.test(stream[j].t)) { heads.push({ ...head, start: i }); sawArticle = false; i = j - 1; continue; }
    }
    if (FIRST_ARTICLE.test(t) && sawArticle) {
      // 제목 줄을 못 찾았어도 조문 번호가 제1조로 다시 시작하면 새 구간입니다. 바로 앞의 짧은 줄을 제목으로 씁니다.
      const prev = stream[i - 1] && stream[i - 1].t;
      const titled = prev && prev.length <= 60 && !ARTICLE_LINE.test(prev) && !CHAPTER_LINE.test(prev) && !BODY_ENDING.test(prev) && !/^[①-⑳\d]/.test(prev);
      heads.push({ title: titled ? cleanTitle(prev) : null, kind: titled && /보통|주계약/.test(prev) ? '보통약관' : '특별약관', start: titled ? i - 1 : i, guessed: !titled });
      sawArticle = true;
      continue;
    }
    if (ARTICLE_LINE.test(t)) sawArticle = true;
  }

  for (const f of forced) {
    const near = heads.findIndex((h) => Math.abs(h.start - f.start) <= 2);
    if (near >= 0) heads[near] = { ...heads[near], title: f.title, kind: f.kind, appendixNo: f.appendixNo, guessed: false, fromToc: true };
    else heads.push({ ...f, fromToc: true });
  }
  heads.sort((a, b) => a.start - b.start);

  // 첫 제목보다 앞에 조문이 있으면 그 앞부분도 구간으로 남깁니다(제목을 못 읽은 첫 약관).
  const firstArticle = stream.findIndex((l) => ARTICLE_LINE.test(l.t));
  if (firstArticle >= 0 && (!heads.length || heads[0].start > firstArticle)) heads.unshift({ title: null, kind: '특별약관', start: 0, guessed: true });

  const sections = [];
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].start : stream.length;
    const articles = [];
    for (let i = h.start; i < end; i++) {
      const a = parseArticle(stream[i].t);
      if (a) articles.push({ ...a, line: i, page: stream[i].p });
    }
    if (h.kind !== '별표' && !articles.length && !h.fromToc) return;
    sections.push({
      title: h.title || `제목 미확인 구간(${stream[h.start].p}쪽)`, kind: h.kind, appendixNo: h.appendixNo, guessed: !!h.guessed, fromToc: !!h.fromToc,
      start: h.start, end, startPage: stream[h.start].p, endPage: stream[end - 1].p, articles,
    });
  });

  // 같은 제목이 연달아 나오면(쪽 머리글이 제목과 같은 경우) 하나로 합칩니다.
  const merged = [];
  for (const s of sections) {
    const last = merged[merged.length - 1];
    if (last && last.title === s.title && s.kind === last.kind && s.articles.length && s.articles[0].no !== 1) {
      last.end = s.end; last.endPage = s.endPage; last.articles.push(...s.articles);
    } else merged.push(s);
  }
  return merged.map((s, i) => ({ id: `S${String(i + 1).padStart(3, '0')}`, ...s }));
}

// 목차의 약관·별표 항목과 본문 구간을 짝짓습니다. 제목이 같거나(장식·띄어쓰기 무시) 한쪽이 다른 쪽을 품으면 짝으로 보고,
// 제목을 못 읽은 구간은 시작 쪽이 목차의 쪽과 맞으면 짝으로 보고 목차의 제목을 붙입니다.
function matchToc(sections, toc, pages) {
  const printedToPdf = new Map();
  for (const p of pages) if (p.printed != null && !printedToPdf.has(p.printed)) printedToPdf.set(p.printed, p.n);
  const tops = toc.entries.filter((e) => e.level === '보통약관' || e.level === '특별약관' || /별표/.test(e.title));
  const used = new Set();
  for (const e of tops) {
    delete e.sectionId;
    const key = norm(cleanTitle(e.title));
    e.pdfPage = printedToPdf.get(e.printed) ?? null;
    const free = sections.filter((x) => !used.has(x.id));
    const s = free.find((x) => norm(x.title) === key)
      || free.find((x) => !x.guessed && key.length >= 4 && (norm(x.title).includes(key) || key.includes(norm(x.title))))
      || (e.pdfPage != null ? free.find((x) => x.guessed && Math.abs(x.startPage - e.pdfPage) <= 1) : null);
    if (s) {
      used.add(s.id);
      e.sectionId = s.id;
      if (s.guessed) { s.title = cleanTitle(e.title); s.guessed = false; s.titledByToc = true; }
      s.toc = { title: e.title, printed: e.printed, pdfPage: e.pdfPage, pageAgrees: e.pdfPage == null ? null : Math.abs(e.pdfPage - s.startPage) <= 1 };
    }
  }
  const missing = tops.filter((e) => !e.sectionId).map((e) => ({ title: e.title, printed: e.printed, pdfPage: e.pdfPage, tocPage: e.tocPage }));
  return { entries: tops, missing };
}

// 목차에는 있으나 본문 구간과 짝이 없는 약관의 시작 줄을 본문에서 찾습니다.
// 제목 글자가 들어 있는 짧은 줄 가운데, 목차의 쪽(알면)에 가장 가까운 줄을 고릅니다. 반환: splitSections 의 forced
function locateTocEntries(missing, stream) {
  const forced = [];
  for (const e of missing) {
    const title = cleanTitle(e.title);
    const key = norm(title);
    if (key.length < 3) continue;
    let best = null;
    for (let i = 0; i < stream.length; i++) {
      const t = stream[i].t;
      if (t.length > title.length + 30 || ARTICLE_LINE.test(t)) continue;
      const k = norm(cleanTitle(t));
      if (!(k === key || (k.includes(key) && k.length <= key.length + 12))) continue;
      const dist = e.pdfPage != null ? Math.abs(stream[i].p - e.pdfPage) : 0;
      if (e.pdfPage != null && dist > 3) continue;
      if (!best || dist < best.dist) best = { i, dist };
      if (dist === 0) break;
    }
    if (!best) continue;
    const head = sectionTitle(title);
    const app = title.match(/별표\s*(\d+)/);
    forced.push({ start: best.i, title: head && head.kind === '별표' ? head.title : title, kind: app ? '별표' : (head ? head.kind : (/보통|주계약/.test(title) ? '보통약관' : '특별약관')), appendixNo: app ? Number(app[1]) : undefined });
  }
  return forced;
}

module.exports = { findToc, bodyStream, splitSections, matchToc, locateTocEntries, sectionTitle, cleanTitle, parseArticle, ARTICLE_LINE, TOC_ENTRY, norm };
