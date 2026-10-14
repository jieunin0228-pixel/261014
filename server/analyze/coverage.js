// 담보 하나 분석: 약관 원문 묶기 → Claude 호출 → 원문 대조. 화면에 보낼 형태(view)로 바꾸는 일도 여기서 합니다.
const { bodyStream } = require('../pdf/toc');
const { FIELDS, GROUPS } = require('../ecs/fields');
const { checkCode, isProvisionalEntry } = require('../ecs/codemaster');
const { A_ITEMS, PROMPT_VERSION, SCHEMA, systemPrompt, requestText } = require('./prompt');
const { verifyResult } = require('./verify');
const ai = require('./ai-client');

// 한 번에 보내는 약관 원문 상한(글자). 넘으면 담보와 관련된 조문만 골라 보냅니다.
const MAX_CONTEXT_CHARS = 150000;
const KEY_ARTICLE = /(목적|정의|지급사유|지급금액|지급기준|보장|지급하지\s*않는|면책|감액|보장개시|책임개시|갱신|소멸|납입면제|세부규정|보험기간|중복|준용)/;

// 약관 구간의 원문을 쪽 표시와 함께 이어 붙입니다.
function sectionText(section, stream, pages, coverageName) {
  const printedOf = (p) => (pages[p - 1] ? pages[p - 1].printed : null);
  const marker = (p) => `〔PDF ${p}쪽${printedOf(p) != null ? ` | 인쇄 ${printedOf(p)}쪽` : ''}〕`;
  const render = (from, to) => {
    const out = [];
    let page = null;
    for (let i = from; i < to; i++) {
      if (stream[i].p !== page) { page = stream[i].p; out.push(marker(page)); }
      out.push(stream[i].t);
    }
    return out.join('\n');
  };
  const full = render(section.start, section.end);
  if (full.length <= MAX_CONTEXT_CHARS) return { text: full, omitted: [] };
  // 너무 길면: 핵심 제목의 조문과 담보명이 나오는 조문만 남깁니다.
  const arts = section.articles.map((a, k) => ({ ...a, to: k + 1 < section.articles.length ? section.articles[k + 1].line : section.end }));
  const keep = [];
  const omitted = [];
  for (const a of arts) {
    const body = render(a.line, a.to);
    if (KEY_ARTICLE.test(a.title) || body.includes(coverageName)) keep.push(body); else omitted.push(`제${a.no}조(${a.title})`);
  }
  let text = keep.join('\n');
  if (text.length > MAX_CONTEXT_CHARS) text = text.slice(0, MAX_CONTEXT_CHARS);
  return { text, omitted };
}

function documentText(doc, section, coverageName) {
  const stream = bodyStream(doc.pages, doc.structure.tocPages);
  const { text, omitted } = sectionText(section, stream, doc.pages, coverageName);
  const appendices = doc.structure.sections.filter((s) => s.kind === '별표')
    .map((s) => `- ${s.title}: PDF ${s.startPage}~${s.endPage}쪽`).join('\n') || '(별표 없음)';
  return {
    text: `[약관 원문] ${section.title} (PDF ${section.startPage}~${section.endPage}쪽)
${omitted.length ? `※ 분량이 많아 다음 조문은 생략했습니다: ${omitted.join(', ')}\n` : ''}
${text}

〔별표 목록〕 표 안의 수치는 보내지 않았습니다. 별표를 참조하는 항목은 아래 이름과 쪽만 안내하십시오.
${appendices}`,
    omitted,
  };
}

// 반환: 캐시에 저장할 분석 결과
async function analyzeCoverage({ doc, coverage, master, signal }) {
  const section = doc.structure.sections.find((s) => s.id === coverage.sectionId);
  if (!section) throw new Error('이 담보를 정의한 약관을 찾지 못했습니다. 담보 편집에서 정의 약관을 지정해 주십시오.');
  const { text, omitted } = documentText(doc, section, coverage.name);
  const startedAt = Date.now();
  const res = await ai.call({ system: systemPrompt(master), documentText: text, request: requestText(coverage), schema: SCHEMA, signal, coverageName: coverage.name });
  // 인용은 담보를 정의한 약관과 별표 범위 안에서만 찾습니다.
  const ranges = [section, ...doc.structure.sections.filter((s) => s.kind === '별표')].map((s) => ({ startPage: s.startPage, endPage: s.endPage }));
  const verified = verifyResult(res.json, doc.pages, ranges);
  return {
    coverageId: coverage.id, name: coverage.name, sectionId: section.id, promptVersion: PROMPT_VERSION, model: res.model, masterId: master.id,
    createdAt: new Date().toISOString(), seconds: Math.round((Date.now() - startedAt) / 100) / 10, usage: res.usage || null, omitted,
    raw: res.json, verified,
  };
}

// ───────────── 화면용 묶음 ─────────────
const FLAG_TEXT = {
  code_unknown: '제안된 코드가 코드마스터에 없어 비웠습니다',
  code_check: '코드 확인 필요',
  code_provisional: '임시 코드',
  code_not_in_master: '코드마스터에 없는 코드(직접 입력)',
  unverified: '근거 미확인',
  partial: '원문 일부 일치',
  moved: '쪽번호 보정',
  user_input: '사용자 입력 필요',
  interpretation: '해석 확인 필요',
};

function cleanCitations(list) {
  return (list || []).filter((c) => c.check !== 'failed').map(({ article, pdfPage, printed, quote, check, reason }) => ({ article, pdfPage, printed, quote, check, reason }));
}

// stored: analyzeCoverage 결과, review: 문서의 검토 기록
function buildView(stored, coverage, master, review = {}) {
  const status = review.reviewStatus || {};
  const edits = review.fieldEdits || {};
  const product = review.product || {};
  const v = stored.verified;
  const key = (...parts) => [coverage.id, ...parts].join('|');
  const stale = [];
  if (stored.name !== coverage.name) stale.push(`분석 뒤 담보 이름이 "${stored.name}"에서 "${coverage.name}"(으)로 바뀌었습니다.`);
  if (stored.promptVersion !== PROMPT_VERSION) stale.push('앱의 분석 기준이 바뀌었습니다.');
  if (stored.masterId !== master.id) stale.push('분석 뒤 코드마스터가 바뀌었습니다. 다시 분석하면 새 코드마스터 기준으로 코드를 제안합니다.');

  const A = A_ITEMS.map(([k, label]) => {
    const it = v.A.find((x) => x.key === k) || { status: 'not_in_terms', value: '', citations: [] };
    const shown = it.status === 'found';
    return {
      key: k, label, status: it.status,
      value: shown ? it.value : it.status === 'unverified' ? 'AI가 제시한 근거를 원문에서 확인하지 못해 표시하지 않습니다.' : '약관에 명시 없음',
      citations: shown ? cleanCitations(it.citations) : [],
      interpretations: shown && it.interpretationNeeded ? it.interpretations : [],
      reviewKey: key('A', k), reviewed: status[key('A', k)] === 'done',
    };
  });

  const B = v.B.map((it, i) => ({
    type: it.type, title: it.title, detail: it.detail, tableName: it.tableName,
    interpretations: it.interpretationNeeded ? it.interpretations : [],
    citations: cleanCitations(it.citations), reviewKey: key('B', i), reviewed: status[key('B', i)] === 'done',
  }));

  const rows = v.rows.map((row, r) => {
    const byKey = new Map(row.fields.map((f) => [f.key, f]));
    const fields = FIELDS.map((def) => {
      const rk = key('D', r, def.key);
      const edit = edits[rk];
      const base = { key: def.key, label: def.label, group: def.group, fill: def.fill, reviewKey: rk, reviewed: status[rk] === 'done', before: { code: '', name: '' } };
      if (def.fill === 'user') {
        const val = product[def.key] || '';
        return { ...base, after: { code: '', name: val }, status: val ? 'user' : 'user_input', flags: val ? [] : ['user_input'], citations: [], note: '' };
      }
      const f = byKey.get(def.key) || { status: 'not_in_terms', code: '', name: '', note: '', citations: [] };
      let after = { code: '', name: '' };
      let flags = [];
      if (f.status === 'filled') {
        if (def.fill === 'code') { const chk = checkCode(master, def.type, f.code, f.name); after = { code: chk.code, name: chk.name }; flags = chk.flags; }
        else after = { code: '', name: f.name };
      } else if (f.status === 'unverified') flags = ['unverified'];
      const cits = f.status === 'filled' ? cleanCitations(f.citations) : [];
      if (cits.some((c) => c.check === 'partial')) flags.push('partial');
      if (cits.some((c) => c.check === 'moved')) flags.push('moved');
      if (edit) {
        // 직접 고친 값은 AI 제안의 표시를 버리고, 고친 코드를 코드마스터와 다시 대조합니다.
        after = { code: edit.code ?? after.code, name: edit.name ?? after.name };
        flags = [];
        if (def.fill === 'code') {
          const entry = after.code ? ((master.types && master.types[def.type]) || []).find((e) => e.code === after.code) : null;
          if (!after.code) { if (after.name) flags.push('code_check'); }
          else if (!entry) flags.push('code_not_in_master');
          else if (master.provisional || isProvisionalEntry(entry)) flags.push('code_provisional');
        }
      }
      return {
        ...base, after, status: f.status, flags, edited: !!edit, note: f.status === 'filled' ? f.note : '', citations: cits,
        display: f.status === 'filled' || edit ? null : f.status === 'unverified' ? '근거 미확인(표시 안 함)' : '약관에 명시 없음',
      };
    });
    return { label: row.label, splitReason: row.splitReason, splitCitations: cleanCitations(row.splitCitations), fields };
  });

  // C 영역: 모든 근거를 한곳에 모읍니다(같은 인용은 한 번만).
  const seen = new Set();
  const C = [];
  const add = (where, list) => {
    for (const c of list) {
      const k = `${c.pdfPage}|${c.quote}`;
      if (seen.has(k)) { C.find((x) => `${x.pdfPage}|${x.quote}` === k).usedBy.push(where); continue; }
      seen.add(k); C.push({ ...c, usedBy: [where] });
    }
  };
  A.forEach((a) => add(`A. ${a.label}`, a.citations));
  B.forEach((b) => add(`B. ${b.title}`, b.citations));
  rows.forEach((row, r) => { add(`D. ${row.label} 행 나눔`, row.splitCitations); row.fields.forEach((f) => add(`D. ${rows.length > 1 ? `${r + 1}행 ` : ''}${f.label}`, f.citations)); });
  C.sort((a, b) => a.pdfPage - b.pdfPage);

  const allItems = [...A, ...B, ...rows.flatMap((r) => r.fields.filter((f) => f.status === 'filled' || f.edited || f.fill === 'user'))];
  return {
    coverageId: coverage.id, model: stored.model, createdAt: stored.createdAt, seconds: stored.seconds, omitted: stored.omitted, stale,
    coverageFound: v.coverageFound, A, B, C, rows, groups: GROUPS, droppedB: v.droppedB, stats: v.stats,
    progress: { reviewed: allItems.filter((x) => x.reviewed).length, total: allItems.length },
    codeFlags: rows.flatMap((r) => r.fields).filter((f) => f.flags.includes('code_check') || f.flags.includes('code_unknown')).length,
  };
}

module.exports = { analyzeCoverage, buildView, sectionText, documentText, FLAG_TEXT, MAX_CONTEXT_CHARS };
