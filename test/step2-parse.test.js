const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/engine');
const TERMS = require('../samples/dummy-terms');

test('조문·항·호·목을 분리한다', () => {
  const arts = E.splitClauses(TERMS);
  assert.deepStrictEqual(arts.map((a) => a.no), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.strictEqual(arts[0].paragraphs[0].no, null); // 제1조는 ① 없는 묵시적 항
  const a6 = arts[5];
  assert.strictEqual(a6.title, '보험금을 지급하지 않는 사유');
  assert.strictEqual(a6.paragraphs.length, 2);
  assert.strictEqual(a6.paragraphs[0].items.length, 3);
  assert.deepStrictEqual(a6.paragraphs[0].items[0].subitems.map((s) => s.no), ['가', '나']);
  assert.strictEqual(E.cite(a6, a6.paragraphs[0], a6.paragraphs[0].items[0], a6.paragraphs[0].items[0].subitems[1]), '제6조 제1항 제1호 나목');
  assert.strictEqual(E.cite(arts[0], arts[0].paragraphs[0]), '제1조');
});

test('"제N조의M" 과 본문이 같은 줄에 있는 조문도 분리한다', () => {
  const arts = E.splitClauses('제3조의2(특칙) 본문입니다.\n이어지는 문장입니다.');
  assert.strictEqual(arts[0].no, '3의2');
  assert.strictEqual(arts[0].paragraphs[0].text, '본문입니다. 이어지는 문장입니다.');
});

test('사망 급부만 추출하고 사고유형 범위를 판정한다', () => {
  const { benefits, missing } = E.extractDeathBenefits(E.splitClauses(TERMS));
  assert.deepStrictEqual(missing, []);
  assert.deepStrictEqual(
    benefits.map((b) => [b.name, b.accidents.join('/'), b.ref]),
    [
      ['사망보험금', '일반/일반재해/교통재해', '제3조 제1항 제1호'],
      ['재해사망보험금', '일반재해/교통재해', '제3조 제1항 제2호'],
      ['교통재해사망보험금', '교통재해', '제3조 제1항 제3호'],
    ],
  ); // 고도장해보험금은 사망 급부가 아니므로 제외
});

test('지급사유 조문이 없으면 근거 없음으로 돌려준다', () => {
  const r = E.extractDeathBenefits(E.splitClauses('제1조(목적)\n목적입니다.'));
  assert.strictEqual(r.benefits.length, 0);
  assert.strictEqual(r.missing.length, 1);
});

test('급부명 부분일치를 배제한다', () => {
  assert.strictEqual(E.mentions('갱신계약의 사망보험금은', '사망보험금'), true);
  assert.strictEqual(E.mentions('재해사망보험금 및 교통재해사망보험금의', '사망보험금'), false);
  assert.strictEqual(E.mentions('재해사망보험금 및 교통재해사망보험금의', '재해사망보험금'), true);
});
