// 원문 대조: AI 가 단 인용문이 해당 PDF 쪽(또는 이웃 쪽, 같은 약관 안 다른 쪽)에 실제로 있는지 확인합니다.
// 결과 check: exact(그 쪽에 그대로 있음) · moved(같은 약관의 다른 쪽에 있음, 쪽번호를 고침) · partial(문장 조각 70% 이상 일치) · failed(없음)
const norm = (s) => String(s || '').replace(/[^\p{L}\p{N}%]/gu, '');
const MIN_QUOTE = 6;
const GRAM = 8;

function pageTexts(pages) {
  return pages.map((p) => norm(p.lines.filter((l) => !l.noise).map((l) => l.t).join(' ')));
}

function gramRatio(quote, text) {
  if (quote.length < GRAM) return text.includes(quote) ? 1 : 0;
  let hit = 0, total = 0;
  for (let i = 0; i + GRAM <= quote.length; i += 2) { total++; if (text.includes(quote.slice(i, i + GRAM))) hit++; }
  return total ? hit / total : 0;
}

// range: { startPage, endPage } 인용을 찾아볼 범위(담보를 정의한 약관과 별표)
function verifyCitation(cit, texts, pages, ranges) {
  const q = norm(cit.quote);
  const n = Number(cit.pdfPage);
  const out = { article: String(cit.article || '').trim(), pdfPage: n, quote: String(cit.quote || '').trim(), check: 'failed', printed: null };
  if (q.length < MIN_QUOTE) return { ...out, reason: '인용문이 너무 짧아 원문과 대조할 수 없습니다.' };
  const at = (p) => texts[p - 1] || '';
  const near = (p) => at(p - 1) + at(p) + at(p + 1);
  const setPage = (p) => { out.pdfPage = p; out.printed = pages[p - 1] ? pages[p - 1].printed : null; };
  if (n >= 1 && n <= texts.length) {
    // 그 쪽에 있거나, 그 쪽에서 시작·끝나며 이웃 쪽에 걸친 문장이면 그대로 인정합니다.
    if (at(n).includes(q) || (at(n) + at(n + 1)).includes(q) || (at(n - 1) + at(n)).includes(q)) {
      const whollyElsewhere = !at(n).includes(q) && (at(n + 1).includes(q) || at(n - 1).includes(q));
      if (!whollyElsewhere) { setPage(n); out.check = 'exact'; return out; }
    }
  }
  // 한 쪽 안에 통째로 있는 곳을 먼저 찾고, 없으면 두 쪽에 걸친 곳을 찾습니다.
  for (const spans of [false, true]) {
    for (const r of ranges) {
      for (let p = r.startPage; p <= r.endPage; p++) {
        if (spans ? (at(p) + at(p + 1)).includes(q) : at(p).includes(q)) { setPage(p); out.check = 'moved'; out.reason = `AI가 적은 PDF ${n}쪽이 아니라 ${p}쪽에서 찾았습니다.`; return out; }
      }
    }
  }
  if (n >= 1 && n <= texts.length && gramRatio(q, near(n)) >= 0.7) {
    setPage(n); out.check = 'partial'; out.reason = '원문과 일부만 일치합니다(띄어쓰기·줄바꿈 차이 또는 일부 변형). 원문을 직접 확인하십시오.';
    return out;
  }
  out.reason = '인용문을 원문에서 찾지 못했습니다.';
  return out;
}

const ok = (c) => c.check !== 'failed';

// AI 응답 전체의 인용을 대조합니다. 근거가 하나도 확인되지 않은 값은 표시하지 않도록 status 를 'unverified' 로 바꿉니다.
function verifyResult(ai, pages, ranges) {
  const texts = pageTexts(pages);
  const v = (list) => (list || []).map((c) => verifyCitation(c, texts, pages, ranges));
  const stats = { citations: 0, failed: 0, unverified: 0 };
  const count = (cs) => { stats.citations += cs.length; stats.failed += cs.filter((c) => !ok(c)).length; };

  const A = (ai.A || []).map((it) => {
    const cs = v(it.citations); count(cs);
    let status = it.status;
    if (status === 'found' && !cs.some(ok)) { status = 'unverified'; stats.unverified++; }
    return { ...it, status, citations: cs };
  });
  // B 영역은 원문 근거가 확인된 항목만 남깁니다.
  const B = [];
  let droppedB = 0;
  for (const it of ai.B || []) {
    const cs = v(it.citations); count(cs);
    if (cs.some(ok)) B.push({ ...it, citations: cs }); else droppedB++;
  }
  const rows = (ai.rows || []).map((row) => {
    const sc = v(row.splitCitations); count(sc);
    const fields = (row.fields || []).map((f) => {
      const cs = v(f.citations); count(cs);
      let status = f.status;
      if (status === 'filled' && !cs.some(ok)) { status = 'unverified'; stats.unverified++; }
      return { ...f, status, citations: cs };
    });
    return { ...row, splitCitations: sc, fields };
  });
  return { coverageFound: ai.coverageFound, A, B, rows, droppedB, stats };
}

module.exports = { verifyResult, verifyCitation, pageTexts, norm };
