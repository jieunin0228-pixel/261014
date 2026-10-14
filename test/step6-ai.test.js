const test = require('node:test');
const assert = require('node:assert');
const A = require('../src/ai');
const FULL = `${require('../samples/dummy-terms')}\n${require('../samples/dummy-riders')}`;
const FIXTURE = require('./fixtures/ai-surgery.json');

const sections = A.splitSections(FULL);

test('약관을 보통약관·특별약관·별표 구간으로 나눈다', () => {
  assert.deepStrictEqual(sections.map((s) => [s.kind, s.title, s.articles.length]), [
    ['보통약관', '(무)더미안심갱신정기보험 보통보험약관', 8],
    ['특별약관', '수술비보장 특별약관', 4],
    ['특별약관', '암진단 특별약관', 3],
    ['별표', '[별표 4] 수술분류표', 0],
  ]);
});

test('담보로 분석 대상을 고르고, 인용된 별표를 함께 고른다', () => {
  assert.deepStrictEqual(A.selectSections(sections, '전체'), [1, 2, 3, 4]);
  assert.deepStrictEqual(A.selectSections(sections, '수술비'), [2, 4]);
  assert.deepStrictEqual(A.selectSections(sections, '암진단보험금'), [3]);
  assert.deepStrictEqual(A.selectSections(sections, '수술비, 사망'), [1, 2, 4]);
  assert.deepStrictEqual(A.selectSections(sections, '치매'), []);
});

test('호출 계획: 구간마다 한 번, 인용된 별표를 붙이고 상한을 넘으면 조문 단위로 나눈다', () => {
  const m = A.defaultMaster();
  const calls = A.planCalls(sections, [2, 4], '수술비', m);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].prompt, /담보 "수술비"/);
  assert.match(calls[0].text, /### \[별표 4\] 수술분류표/);
  const big = [{ id: 1, kind: '특별약관', title: '큰 특약', text: '가'.repeat(180000), articles: Array.from({ length: 6 }, (_, i) => ({ no: String(i + 1), title: '조', paragraphs: [{ no: null, text: '가'.repeat(30000), items: [] }] })) }];
  const parts = A.planCalls(big, [1], '전체', m);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(new TextEncoder().encode(p.prompt).length <= A.MAX_PROMPT_BYTES);
});

test('Claude 결과 검증: 원문 불일치 인용·없는 코드·사인그룹 없음을 걸러 낸다', () => {
  const call = A.planCalls(sections, [2, 4], '수술비', A.defaultMaster())[0];
  const v = A.verifyAiResult(FIXTURE, { sourceText: call.text, sectionTitle: call.sectionTitle, master: A.defaultMaster() });
  // 5행 중: 정상 3행 통과, T99(없는 사인그룹 코드) → 수기, 원문에 없는 인용만 있는 3종 → 근거 없음
  assert.strictEqual(v.rows.length, 3);
  assert.deepStrictEqual(v.missing.map((m) => m.reason), ['인용한 원문을 약관에서 찾지 못해 행을 만들지 않았습니다.']);
  assert.strictEqual(v.manual.length, 2);
  assert.match(v.manual[0].reason, /사인그룹 코드표에 대응 코드가 없어/);
  assert.match(v.manual[1].subject, /출산/);
  assert.strictEqual(v.rows[0].evidence[0].ref, '수술비보장 특별약관 제2조 제1항 제1호');
  assert.ok(v.rows.every((r) => r.signGroupCode && r.claimCode === 'S11'));
});

test('최종 정리: 경계일 🔴(일 단위)·🟡 중복·행번호', () => {
  const call = A.planCalls(sections, [2, 4], '수술비', A.defaultMaster())[0];
  const m = A.defaultMaster();
  const out = A.finalize([A.verifyAiResult(FIXTURE, { sourceText: call.text, sectionTitle: call.sectionTitle, master: m })], m);
  assert.deepStrictEqual(out.rows.map((r) => r.no), [1, 2, 3]);
  assert.match(out.rows[0].flagText, /🔴 경계일 조건\(경과기간 90일\)/);
  assert.match(out.rows[0].testText, /90일-1일, 90일 당일, 90일\+1일인 수술 3건/);
  assert.ok(!/🟡/.test(out.rows[2].flagText));
});

test('코드표 엑셀(시트별 레코드)을 읽고, 빠진 시트는 경고한다', () => {
  const m = A.parseCodeMaster({
    '사인그룹 ': [{ 코드: 'T03', 명칭: '사인그룹|질병', 설명: '' }],
    급부: [{ 구보장급부코드: 'S11K236671', 구보장급부명: '수술보험금', 위험급부코드: 'R01', 위험급부명: '질병수술' }],
    변수: [{ 변수명: '가입금액' }, { 변수명: '경과기간' }],
  });
  assert.deepStrictEqual(m.signGroups, [{ code: 'T03', name: '사인그룹|질병', desc: '' }]);
  assert.strictEqual(m.benefits[0].riskCode, 'R01');
  assert.deepStrictEqual(m.variables, ['가입금액', '경과기간']);
  assert.ok(m.warnings.some((w) => w.includes('청구사유')));
  const call = A.planCalls(sections, [2, 4], '수술비', m)[0];
  const v = A.verifyAiResult(FIXTURE, { sourceText: call.text, sectionTitle: call.sectionTitle, master: m });
  assert.strictEqual(v.rows[0].benefitCode, 'S11K236671'); // 급부명으로 코드 채움
  assert.match(v.rows[0].flagText || v.rows[0].flags.map((f) => f.reason).join(), /청구사유 코드 S11는 코드표에 없어 비웠습니다/);
});
