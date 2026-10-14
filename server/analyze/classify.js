// 담보 추출과 대분류. 담보는 각 약관의 보험금 지급사유·지급금액 조문에 나오는 "○○보험금·○○진단비…" 이름입니다.
// 대분류는 사망·장해·진단·입원·치료·기타 여섯 가지로 고정하고, 중분류는 담보를 정의한 약관(목차의 약관 제목)으로 둡니다.
// 분류는 정해진 단서어로만 하며, 어떤 단서로 분류했는지 한 줄 근거를 남깁니다.
const { ARTICLE_LINE } = require('../pdf/toc');

const CATEGORIES = ['사망', '장해', '진단', '입원', '치료', '기타'];

const BENEFIT_SUFFIX = '(?:보험금|급여금|급부금|진단비|진단금|수술비|입원비|입원일당|치료비|통원비|간병비|생활자금|자금|연금|지원금|축하금)';
const BENEFIT_TOKEN = new RegExp(`[가-힣A-Za-z0-9ⅠⅡⅢⅣⅤ·]{1,30}?${BENEFIT_SUFFIX}`, 'g');
const NOT_BENEFIT = /^(보험금|급여금|급부금|연금|자금|해당보험금|약정한보험금|각보험금|이보험금|그보험금|위보험금|다른보험금|사고보험금|미지급보험금|해지환급금|책임준비금|기납입보험료|보험료|중도인출금|보험계약대출금|지급보험금|청구보험금|지급연금)$|^(약정한|해당|다음의|아래의|위의|이|그|각|및|또는|나머지|모든|동일|기|지급|미지급|지급할|받을|받은|청구|청구한|정한|따른|해당되는|추가로)/;

// 담보를 정의하는 조문 제목
const DEFINING_ARTICLE = /(지급사유|보장내용|지급금액|지급기준|보험금의\s*종류|보험금의\s*지급)/;
const NOT_DEFINING_ARTICLE = /(지급하지\s*않는|청구|지급절차|지급기일|세부규정|지급\s*제한|분할|지연)/;

// 담보명에서 대분류를 정하는 단서. 앞의 규칙이 우선합니다(예: 암수술입원일당 → 입원, 재해장해연금 → 장해).
const NAME_RULES = [
  ['사망', /사망/],
  ['장해', /장해|장애/],
  ['입원', /입원/],
  ['치료', /수술|치료|통원|요양|간병|항암|방사선|약물|처치|재활|외래|투약|시술/],
  ['진단', /진단|발병/],
];
// 담보명에 단서가 없을 때 지급사유 문장에서 찾는 단서
const SENTENCE_RULES = [
  ['사망', /사망하였을|사망한\s*경우|사망하였거나/],
  ['장해', /장해지급률|장해상태|장해분류표/],
  ['입원', /입원하여|입원한\s*경우|입원일수/],
  ['치료', /수술을\s*받|치료를\s*받|통원/],
  ['진단', /진단확정|진단이\s*확정/],
];

// 받침 유무에 따라 '으로/로'를 붙입니다(받침 ㄹ 은 '로').
function ro(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  const jong = code >= 0 && code < 11172 ? code % 28 : 0;
  return `${word}${jong === 0 || jong === 8 ? '로' : '으로'}`;
}

function categorize(name, sentence = '') {
  for (const [cat, re] of NAME_RULES) {
    const m = name.match(re);
    if (m) return { category: cat, reason: `담보명에 '${m[0]}'이(가) 들어 있어 ${ro(cat)} 분류했습니다.` };
  }
  for (const [cat, re] of SENTENCE_RULES) {
    const m = sentence.match(re);
    if (m) return { category: cat, reason: `담보명에는 단서가 없으나 지급사유 문장의 '${m[0]}'에 따라 ${ro(cat)} 분류했습니다.` };
  }
  return { category: '기타', reason: '담보명과 지급사유 문장에 사망·장해·진단·입원·치료 단서가 없어 기타로 분류했습니다.' };
}

// 구간의 조문별 줄 범위
function articleRanges(section) {
  return section.articles.map((a, k) => ({ ...a, from: a.line, to: k + 1 < section.articles.length ? section.articles[k + 1].line : section.end }));
}

function findBenefits(text) {
  const out = [];
  for (const m of text.matchAll(BENEFIT_TOKEN)) {
    const before = text[m.index - 1];
    if (before && /[가-힣]/.test(before)) continue; // 더 긴 낱말의 일부
    if (m[0].length < 4 || NOT_BENEFIT.test(m[0])) continue;
    out.push(m[0]);
  }
  return out;
}

// 줄바꿈으로 나뉜 항목(호·항·표의 한 행)을 한 문장으로 잇습니다. 앞쪽은 항목 기호(1. ① 가.)가 나올 때까지,
// 뒤쪽은 다음 항목 기호나 다른 보험금명이 나오기 전까지 최대 3줄을 붙입니다.
const ITEM_START = /^(\d+\.|[①-⑳]|[가-하]\.|\(\d+\))\s*/;
function itemContext(stream, i, a) {
  let from = i;
  while (from > a.from + 1 && i - from < 3 && !ITEM_START.test(stream[from].t)) from--;
  if (!ITEM_START.test(stream[from].t)) from = i;
  let to = i;
  while (to + 1 < a.to && to - i < 3 && !ITEM_START.test(stream[to + 1].t) && !ARTICLE_LINE.test(stream[to + 1].t) && !findBenefits(stream[to + 1].t).length && stream[to + 1].t) to++;
  return { from, text: stream.slice(from, to + 1).map((l) => l.t).join(' ') };
}

// 반환: [{ id, name, category, reason, group, sectionId, sectionTitle, evidence: { page, line, article, quote }, mentions }]
function extractCoverages(sections, stream, pages) {
  const printedOf = new Map(pages.map((p) => [p.n, p.printed]));
  const items = [];
  for (const s of sections) {
    if (s.kind === '별표') continue;
    const found = new Map();
    for (const a of articleRanges(s)) {
      if (!DEFINING_ARTICLE.test(a.title) || NOT_DEFINING_ARTICLE.test(a.title)) continue;
      for (let i = a.from; i < a.to; i++) {
        const line = stream[i];
        if (i !== a.from && ARTICLE_LINE.test(line.t)) continue;
        for (const name of findBenefits(line.t)) {
          if (!found.has(name)) {
            const ctx = itemContext(stream, i, a);
            const head = stream[ctx.from];
            found.set(name, { mentions: 0, evidence: { page: head.p, printed: printedOf.get(head.p) ?? null, lineIndex: head.i, article: `제${a.no}조${a.sub ? `의${a.sub}` : ''}(${a.title})`, quote: ctx.text } });
          }
          found.get(name).mentions += 1;
        }
      }
    }
    if (!found.size) {
      // 지급사유 조문에서 보험금명을 못 찾은 약관은 약관 제목을 담보로 올려 빠뜨리지 않게 합니다.
      const first = stream[s.start];
      const c = categorize(s.title);
      items.push({
        id: `${s.id}#0`, name: s.title, ...c, reason: `${c.reason} (지급사유 조문에서 보험금명을 찾지 못해 약관 제목을 담보명으로 대신 썼습니다.)`,
        group: s.title, sectionId: s.id, sectionTitle: s.title, fromTitle: true,
        evidence: { page: first.p, printed: printedOf.get(first.p) ?? null, lineIndex: first.i, article: null, quote: first.t }, mentions: 0,
      });
      continue;
    }
    let k = 0;
    for (const [name, h] of found) {
      k += 1;
      items.push({ id: `${s.id}#${k}`, name, ...categorize(name, h.evidence.quote), group: s.title, sectionId: s.id, sectionTitle: s.title, evidence: h.evidence, mentions: h.mentions });
    }
  }
  return items;
}

// 사용자 수정(이름·분류 이동·제외·직접 추가)을 자동 추출 결과에 덧씌웁니다.
function applyOverrides(coverages, review = {}) {
  const edits = review.edits || {};
  const merged = coverages.map((c) => {
    const e = edits[c.id];
    if (!e) return { ...c, edited: false };
    const v = { ...c, ...pick(e, ['name', 'category', 'group', 'excluded']), auto: { name: c.name, category: c.category, group: c.group, reason: c.reason }, edited: true };
    if (v.category !== c.category || v.group !== c.group) v.reason = `사용자가 ${v.category} › ${v.group}(으)로 옮겼습니다. (자동 분류: ${c.category} — ${c.reason})`;
    return v;
  });
  for (const a of review.added || []) merged.push({ ...a, ...pick(edits[a.id] || {}, ['name', 'category', 'group', 'excluded']), manual: true, edited: true });
  return merged;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

module.exports = { CATEGORIES, categorize, extractCoverages, applyOverrides, findBenefits };
