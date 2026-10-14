const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../src/ai');

const REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'realistic-policy.txt'), 'utf8');
const sections = A.splitSections(REAL);
const catalog = A.extractCatalog(sections);

test('실제 PDF 형태(목차·쪽 머리글·쪽 번호·번호 붙은 특약 제목)에서 구간을 나눈다', () => {
  assert.deepStrictEqual(sections.map((s) => [s.kind, s.title]), [
    ['보통약관', '보통약관'],
    ['특별약관', '무배당 암진단특약(갱신형) 약관'],
    ['특별약관', '무배당 뇌혈관질환진단특약 약관'],
    ['특별약관', '질병수술특약 약관'],
    ['특별약관', '무배당 질병입원특약 약관'],
    ['특별약관', '장기요양진단특약 약관'],
    ['별표', '[별표 1] 장해분류표'],
  ]);
  assert.ok(!sections.some((s) => /- 31 -|더미건강보험\(갱신형\) 약관$/.test(s.text)), '쪽 번호·머리글 제거');
});

test('약관 전체에서 담보를 빠짐없이 찾아 대분류로 묶는다(표 형식 지급사유 포함)', () => {
  const byCat = Object.fromEntries(A.CATEGORIES.map((c) => [c, catalog.filter((x) => x.category === c).map((x) => x.name)]));
  assert.deepStrictEqual(byCat, {
    사망: ['사망보험금'],
    진단: ['암진단비', '소액암진단비', '뇌혈관질환진단보험금', '뇌출혈진단보험금'],
    수술: ['질병수술급여금', '암수술비'],
    요양: ['장기요양진단비', '간병생활자금'],
    입원: ['질병입원급여금'],
    기타: ['재해장해급여금'],
  });
});

test('제목 줄이 없어도 조문이 제1조로 다시 시작하면 새 구간으로 나눈다', () => {
  const t = '제1조(목적)\n목적입니다.\n제2조(지급사유)\n① 사망하였을 경우: 사망보험금\n치아치료보장\n제1조(보험금의 지급사유)\n① 충전치료를 받은 경우: 치아치료급여금';
  const ss = A.splitSections(t);
  assert.deepStrictEqual(ss.map((s) => s.title), ['머리말', '치아치료보장']);
  assert.deepStrictEqual(A.extractCatalog(ss).map((c) => [c.category, c.name]), [['사망', '사망보험금'], ['기타', '치아치료급여금']]);
});

test('담보를 고르면 정의 구간별로 묶어 그 담보 목록으로만 호출한다', () => {
  const ids = catalog.filter((c) => ['암진단비', '소액암진단비', '암수술비', '재해장해급여금'].includes(c.name)).map((c) => c.id);
  const calls = A.planBenefitCalls(sections, catalog, ids, A.defaultMaster());
  assert.deepStrictEqual(calls.map((c) => [c.sectionTitle, c.names]), [
    ['무배당 암진단특약(갱신형) 약관', ['암진단비', '소액암진단비']],
    ['질병수술특약 약관', ['암수술비']],
    ['보통약관', ['재해장해급여금']],
  ]);
  assert.match(calls[0].prompt, /\[담보 목록\]\n- 암진단비\n- 소액암진단비/);
  assert.ok(!calls[0].prompt.includes('질병수술급여금'));
});

test('고른 담보가 AI 결과 어디에도 없으면 근거 없음에 올린다', () => {
  const out = A.finalize([{ rows: [], manual: [{ subject: '암진단비 일반', ref: '', text: '', reason: '' }], missing: [] }], A.defaultMaster(), ['암진단비', '소액암진단비']);
  assert.deepStrictEqual(out.missing.map((m) => m.subject), ['소액암진단비']);
});

test('짧은 담보명 결과가 긴 담보명(소액암진단비)을 가리지 않는다', () => {
  const row = { benefit: '암진단비', flags: [], evidence: [], calcCondition: '-', formula: '[가입금액]', claim: '진단', accident: '일반', signGroupCode: 'T03' };
  const out = A.finalize([{ rows: [row], manual: [], missing: [] }], A.defaultMaster(), ['암진단비', '소액암진단비']);
  assert.deepStrictEqual(out.missing.map((m) => m.subject), ['소액암진단비']);
});

test('같은 이름의 담보가 여러 특약에서 정의되면 특약별로 따로 올리고 따로 분석한다', () => {
  const t = `무배당 암진단특약(갱신형) 약관
제1조(보험금의 지급사유)
① 암으로 진단확정되었을 경우: 암진단비
무배당 암진단특약(비갱신형) 약관
제1조(보험금의 지급사유)
① 암으로 진단확정되었을 경우: 암진단비
제2조(보험금을 지급하지 않는 사유)
① 보장개시일 전 진단확정 시 암진단비를 지급하지 않습니다.`;
  const ss = A.splitSections(t);
  const cat = A.extractCatalog(ss);
  assert.deepStrictEqual(cat.map((c) => [c.id, c.shared]), [['암진단비@1', true], ['암진단비@2', true]]);
  const calls = A.planBenefitCalls(ss, cat, cat.map((c) => c.id), A.defaultMaster());
  assert.deepStrictEqual(calls.map((c) => c.sectionTitle), ['무배당 암진단특약(갱신형) 약관', '무배당 암진단특약(비갱신형) 약관']);
});
