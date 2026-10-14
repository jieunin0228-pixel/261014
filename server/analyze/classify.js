// 담보 추출과 대분류. 담보는 각 약관의 보험금 지급사유·지급금액 조문에 나오는 "○○보험금·○○진단비…" 이름입니다.
// 대분류는 사망·장해·진단·입원·치료·기타 여섯 가지로 고정하고, 중분류는 담보를 정의한 약관(목차의 약관 제목)으로 둡니다.
// 분류는 정해진 단서어로만 하며, 어떤 단서로 분류했는지 한 줄 근거를 남깁니다.
const { ARTICLE_LINE } = require('../pdf/toc');

const CATEGORIES = ['사망', '장해', '진단', '입원', '치료', '기타'];

const BENEFIT_SUFFIX = '(?:보험금|급여금|급부금|진단비|진단금|수술비|입원비|입원일당|일당|치료비|통원비|간병비|생활자금|자금|연금|지원금|축하금|위로금|보장금)';
const BENEFIT_TOKEN = new RegExp(`[가-힣A-Za-z0-9ⅠⅡⅢⅣⅤ·]{1,30}?${BENEFIT_SUFFIX}`, 'g');
const NOT_BENEFIT = /^(보험금|급여금|급부금|연금|자금|해당보험금|약정한보험금|각보험금|이보험금|그보험금|위보험금|다른보험금|사고보험금|미지급보험금|해지환급금|책임준비금|기납입보험료|보험료|중도인출금|보험계약대출금|지급보험금|청구보험금|지급연금)$|^(약정한|해당|다음의|아래의|위의|이|그|각|및|또는|나머지|모든|동일|기|지급|미지급|지급할|받을|받은|청구|청구한|정한|따른|해당되는|추가로)/;

// 담보를 정의하는 조문 제목
const DEFINING_ARTICLE = /(지급사유|보장내용|지급금액|지급기준|보험금의\s*종류|보험금의\s*지급|보상하는\s*손해|보상내용|보장하는\s*손해|담보내용)/;
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

// 담보명 찾기. "뇌졸중진단비"처럼 붙여 쓴 이름과 "뇌졸중 진단비", "대상포진 진단비", "암 진단비(유사암 제외)"처럼
// 띄어 쓴 이름을 모두 찾습니다. 보험금 종류 낱말(진단비·보험금 등) 앞쪽으로 최대 세 낱말까지 붙이되,
// 조사로 끝나는 낱말("다음의", "경우에")이나 일반 낱말("경우", "해당")을 만나면 멈춥니다.
const SUFFIX_RE = new RegExp(BENEFIT_SUFFIX, 'g');
const NAME_WORD = /^[가-힣A-Za-z0-9ⅠⅡⅢⅣⅤ·]+$/;
const STOP_WORD = /^(경우|때|다음|아래|위|해당|각|이|그|및|또는|등|중|약정한|정한|따른|지급|지급할|받을|받은|청구|모든|동일|기타|회사|회사는|피보험자|보험수익자|계약자|가입금액|금액|지급금액|지급사유|지급구분|구분|사유|급부명|보장명|담보명|내용|매년|매월|매회|매일|최초|최대|각각|연간|통산|별도|추가|즉시|다시|모두|함께|보험기간|계약일|살아|생존)$/;
const PARTICLE_END = /(의|을|를|이|가|은|는|에|에서|로|으로|와|과|고|며|서|면|한|된|할|하여|하고|및|또는|으며|이며|에게|부터|까지|만|도)$/;
const DROP_HEAD = /^(약정한|해당|다음의|아래의|위의|이|그|각|및|또는|나머지|모든|동일|기|지급|미지급|지급할|받을|받은|청구|청구한|정한|따른|해당되는|추가로)\s+/;

// 반환: [{ name, index }] (index 는 이름이 끝나는 보험금 종류 낱말의 위치)
function findBenefitsAt(text) {
  const out = [];
  for (const m of text.matchAll(SUFFIX_RE)) {
    const end = m.index + m[0].length;
    if (/[가-힣]/.test(text[end] || '') && !/^(과|와|을|를|은|는|이|가|의|에|으로|로|도|만)/.test(text.slice(end))) continue; // 더 긴 낱말의 앞부분
    // 붙어 있는 앞부분
    let start = m.index;
    while (start > 0 && /[가-힣A-Za-z0-9ⅠⅡⅢⅣⅤ·]/.test(text[start - 1])) start--;
    let attached = text.slice(start, m.index);
    // 띄어 쓴 앞 낱말(최대 3개)
    const words = [];
    let pos = start;
    while (words.length < 3 && text[pos - 1] === ' ') {
      let ws = pos - 1;
      while (ws > 0 && /[가-힣A-Za-z0-9ⅠⅡⅢⅣⅤ·]/.test(text[ws - 1])) ws--;
      const w = text.slice(ws, pos - 1);
      if (!w || !NAME_WORD.test(w) || STOP_WORD.test(w) || PARTICLE_END.test(w) || /^\d+$/.test(w)) break;
      words.unshift(w);
      pos = ws;
    }
    if (/^\d+$/.test(attached)) continue; // "1일당", "3일당"은 이름이 아님
    if (attached && (STOP_WORD.test(attached) || PARTICLE_END.test(attached)) && !words.length) attached = '';
    // "진단비"·"보험금"만 홀로 있으면 이름이 아니지만, "생활자금"·"입원일당"처럼 그 자체가 담보명인 네 글자 이상 낱말은 인정합니다.
    if (!attached && !words.length && m[0].length < 4) continue;
    // 바로 뒤의 괄호 설명(예: "(유사암 제외)")은 이름에 붙입니다.
    const paren = text.slice(end).match(/^\s?[(（][^)）]{1,20}[)）]/);
    let name = [...words, `${attached}${m[0]}`].join(' ') + (paren ? paren[0].trim() : '');
    name = name.replace(DROP_HEAD, '').trim();
    const compact = name.replace(/\s+/g, '');
    if (compact.length < 4 || NOT_BENEFIT.test(compact) || NOT_BENEFIT.test(name)) continue;
    out.push({ name, index: m.index });
  }
  // "5대 질환 수술비 지원금"처럼 한 이름 안에 다른 이름이 들어 있으면 긴 이름만 남깁니다.
  return out.filter((o) => !out.some((x) => x !== o && x.name.startsWith(`${o.name} `)));
}
const findBenefits = (text) => [...new Set(findBenefitsAt(text).map((o) => o.name))];

// 조문 줄들을 한 글로 잇습니다. 오른쪽 끝까지 찬 줄이 한글 글자 사이에서 끊겼으면 띄어 쓰지 않고 잇습니다
// (한글 약관은 낱말 중간에서 줄이 바뀌는 경우가 많기 때문: "뇌혈관질환진" / "단비"). 반환: { text, starts }
function joinLines(lines) {
  const maxLen = Math.max(0, ...lines.map((l) => l.t.length));
  let text = '';
  const starts = [];
  lines.forEach((l, k) => {
    if (k > 0) {
      const prev = lines[k - 1].t;
      // 표의 행(열 구분 " | ")은 행끼리 이어지지 않도록 " | "로 나눕니다.
      const table = prev.includes(' | ') || l.t.includes(' | ');
      const tight = !table && prev.length >= maxLen * 0.85 && /[가-힣]$/.test(prev) && /^[가-힣]/.test(l.t);
      text += table ? ' | ' : tight ? '' : ' ';
    }
    starts.push(text.length);
    text += l.t;
  });
  return { text, starts };
}

// 약관이 참조하는 보험금 지급표 별표. 같은 번호의 별표가 여럿이면(특약마다 별표1이 있는 경우) 그 약관 바로 뒤의 것을 고릅니다.
const PAY_TABLE = /지급|보험금|급부|급여/;
function referencedPayTables(section, sections, stream) {
  let text = '';
  for (let i = section.start; i < section.end; i++) text += `${stream[i].t}\n`;
  const nums = [...new Set([...text.matchAll(/별표\s*(\d+)/g)].map((m) => Number(m[1])))];
  const idx = sections.indexOf(section);
  const after = sections.slice(idx + 1);
  const tables = [];
  for (const n of nums) {
    const t = after.find((x) => x.kind === '별표' && x.appendixNo === n) || sections.find((x) => x.kind === '별표' && x.appendixNo === n);
    if (t && PAY_TABLE.test(t.title) && !tables.includes(t)) tables.push(t);
  }
  // 번호 없이 "별표"만 언급하면 바로 뒤에 붙은 지급표 별표를 씁니다.
  if (!tables.length && /별표/.test(text)) {
    for (const x of after) { if (x.kind !== '별표') break; if (PAY_TABLE.test(x.title)) { tables.push(x); break; } }
  }
  return tables;
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
      // 조문 제목 줄은 빼고 본문 줄을 이어 붙여 담보명을 찾습니다(줄바꿈으로 끊긴 이름도 찾기 위해).
      const body = stream.slice(a.from + 1, a.to);
      const { text, starts } = joinLines(body);
      for (const { name, index } of findBenefitsAt(text)) {
        let k = 0;
        while (k + 1 < starts.length && starts[k + 1] <= index) k++;
        const i = a.from + 1 + k;
        if (!found.has(name)) {
          const ctx = itemContext(stream, i, a);
          const head = stream[ctx.from];
          found.set(name, { mentions: 0, evidence: { page: head.p, printed: printedOf.get(head.p) ?? null, lineIndex: head.i, article: `제${a.no}조${a.sub ? `의${a.sub}` : ''}(${a.title})`, quote: ctx.text } });
        }
        found.get(name).mentions += 1;
      }
    }
    if (!found.size) {
      // 조문에 보험금명이 없고 "별표N 보험금 지급기준표"를 참조하는 약관은 그 별표에서 보험금명을 찾습니다.
      for (const ap of referencedPayTables(s, sections, stream)) {
        for (let i = ap.start; i < ap.end; i++) {
          const line = stream[i];
          for (const name of findBenefits(line.t)) {
            if (!found.has(name)) found.set(name, { mentions: 0, fromAppendix: ap.title, evidence: { page: line.p, printed: printedOf.get(line.p) ?? null, lineIndex: line.i, article: ap.title, quote: line.t } });
            found.get(name).mentions += 1;
          }
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
      const c = categorize(name, h.evidence.quote);
      if (h.fromAppendix) c.reason += ` (보험금명은 약관이 참조한 ${h.fromAppendix}에서 찾았습니다.)`;
      items.push({ id: `${s.id}#${k}`, name, ...c, group: s.title, sectionId: s.id, sectionTitle: s.title, evidence: h.evidence, mentions: h.mentions, fromAppendix: h.fromAppendix || null });
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
    const v = { ...c, ...pick(e, ['name', 'category', 'group', 'excluded', 'sectionId', 'sectionTitle']), auto: { name: c.name, category: c.category, group: c.group, reason: c.reason }, edited: true };
    if (v.category !== c.category || v.group !== c.group) v.reason = `사용자가 ${v.category} › ${v.group}(으)로 옮겼습니다. (자동 분류: ${c.category} — ${c.reason})`;
    return v;
  });
  for (const a of review.added || []) merged.push({ ...a, ...pick(edits[a.id] || {}, ['name', 'category', 'group', 'excluded', 'sectionId', 'sectionTitle']), manual: true, edited: true });
  return merged;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

module.exports = { CATEGORIES, categorize, extractCoverages, applyOverrides, findBenefits, findBenefitsAt, joinLines };
