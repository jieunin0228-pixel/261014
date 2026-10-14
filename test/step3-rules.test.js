const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/engine');
const TERMS = require('../samples/dummy-terms');
const ANSWER = require('../scripts/answer-key-data');

const norm = (s) => String(s).replace(/\s+/g, '');
const key = (b, a, sg, c) => [b, a, sg, c].map(norm).join('|');
const { rows, manual, missing } = E.generateRules(TERMS);

test('정답지 대비: 20행 매칭, 계산식 불일치 1행, 정답지 전용 2행(의도된 차이)', () => {
  const gen = new Map(rows.map((r) => [key(r.benefit, r.accident, r.signGroupCode, r.calcCondition), r]));
  const mismatched = [], answerOnly = [];
  for (const [b, a, sg, c, formula, status] of ANSWER) {
    const r = gen.get(key(b, a, sg, c));
    if (!r) { answerOnly.push(`${b}/${a}/${sg}`); continue; }
    if (norm(r.formula) !== norm(formula) || r.status !== status) mismatched.push(`${b}/${a}/${c}`);
    gen.delete(key(b, a, sg, c));
  }
  assert.strictEqual(rows.length, 20);
  assert.deepStrictEqual(mismatched, ['교통재해사망보험금/교통재해/계약구분=갱신']);
  assert.deepStrictEqual(answerOnly, ['사망보험금/일반재해/T20', '사망보험금/일반재해/T20']);
  assert.strictEqual(gen.size, 0);
});

test('규칙 1~4: 사고유형별 행, 경과기간 감액 분리, 면책 *0, 갱신 Math.max', () => {
  const find = (b, a, sg, c) => rows.find((r) => r.benefit === b && r.accident === a && r.signGroupCode === sg && r.calcCondition === c);
  assert.deepStrictEqual(rows.filter((r) => r.benefit === '사망보험금' && r.signGroupCode.match(/T0[123]/)).map((r) => r.accident),
    ['일반', '일반', '일반', '일반재해', '일반재해', '교통재해', '교통재해']);
  assert.strictEqual(find('사망보험금', '일반', 'T03', '계약구분=최초 AND 경과기간<=1년').category, '감액');
  assert.strictEqual(find('사망보험금', '일반', 'T03', '계약구분=최초 AND 경과기간>1년').formula, '[가입금액]');
  assert.strictEqual(find('사망보험금', '일반', 'T03', '계약구분=갱신').formula, 'Math.max([가입금액], [기납입보험료])');
  for (const r of rows.filter((x) => x.category === '면책')) assert.strictEqual(r.formula, '[가입금액] * 0');
});

test('규칙 5: 사인그룹 없는 사유는 행 없이 심사자 수기 목록으로 간다', () => {
  assert.deepStrictEqual(manual.map((m) => m.ref), ['제6조 제1항 제1호 가목', '제6조 제1항 제2호', '제6조 제1항 제3호', '제8조 제1항']);
  assert.ok(!rows.some((r) => /심신상실|수익자가/.test(r.excerptText.split('\n').filter((l) => !l.startsWith('[제6조 제1항 제1호]')).join())));
});

test('규칙 6: 모든 행에 조항과 원문 발췌가 있고, 금액 조항이 없으면 근거 없음 처리한다', () => {
  assert.deepStrictEqual(missing, []);
  for (const r of rows) {
    assert.ok(r.evidence.length >= 2, `행 ${r.no} 근거 부족`);
    for (const e of r.evidence) assert.match(e.ref, /^제\d+조/) && assert.ok(e.text.length > 0);
  }
  const noAmount = E.generateRules('제1조(보험금의 지급사유)\n① 다음의 경우 지급합니다.\n1. 사망하였을 경우: 사망보험금');
  assert.strictEqual(noAmount.rows.length, 0);
  assert.strictEqual(noAmount.missing[0].subject, '사망보험금');
});

test('규칙 7·8: ⚠/🔴/🟡 표시와 테스트 시나리오', () => {
  const r1 = rows[0];
  assert.match(r1.flagText, /⚠ '1년 이내' 경계일/);
  assert.match(r1.flagText, /🔴 경계일 조건/);
  assert.match(r1.testText, /1년-1일, 1년 당일, 1년\+1일/);
  const max = rows.filter((r) => r.formula.includes('Math.max'));
  for (const r of max) assert.match(r.flagText, /🔴 Math\.max 산식[\s\S]*🔴 신규 변수\([^)]*기납입보험료/);
  const t01 = rows.filter((r) => r.signGroupCode === 'T01' && r.calcCondition === '계약구분=최초');
  assert.strictEqual(t01.length, 3);
  for (const r of t01) assert.match(r.flagText, /🟡 동일 사고유형/);
  assert.match(rows.find((r) => r.benefit === '재해사망보험금' && r.calcCondition === '계약구분=갱신').flagText, /⚠ 갱신계약 산식 조항\(제5조 제2항\)/);
});

test('갱신 조문이 없으면 계약구분을 나누지 않는다', () => {
  const t = TERMS.replace(/제5조\(계약의 갱신\)[\s\S]*?(?=제6조)/, '').replace(/④ 제1항 단서.*\n/, '');
  const r = E.generateRules(t);
  assert.ok(r.rows.every((x) => !x.calcCondition.includes('계약구분')));
  assert.ok(r.rows.every((x) => !x.formula.includes('Math.max')));
});
