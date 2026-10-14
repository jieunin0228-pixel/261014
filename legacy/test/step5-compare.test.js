const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const XLSX = require('xlsx');
const E = require('../src/engine');
const TERMS = require('../samples/dummy-terms');

const readKey = (file) => {
  const book = XLSX.readFile(file);
  return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { defval: '' });
};
const { rows } = E.generateRules(TERMS);

test('샘플 정답지 엑셀과 비교: 일치 19, 불일치 1, 정답지에만 2, 생성에만 0', () => {
  const r = E.compareWithAnswerKey(rows, readKey(path.join(__dirname, '..', 'samples', 'answer_key.xlsx')));
  assert.deepStrictEqual(r.summary, { 일치: 19, 불일치: 1, 정답지에만: 2, 생성에만: 0 });
  const bad = r.items.find((i) => i.result === '불일치');
  assert.strictEqual(bad.row.benefit, '교통재해사망보험금');
  assert.deepStrictEqual(bad.diffs, ['상세계산식']);
  assert.strictEqual(bad.answerLine, 14);
});

test('공백 차이는 일치로, 정답지에 없는 생성 행은 생성에만으로 본다', () => {
  const recs = [{ 구보장급부명: '사망보험금', 사고유형: '일반', 사인그룹코드: 'T03', 계산식결정조건: '계약구분=최초AND 경과기간 <= 1년', 상세계산식: '[가입금액]*0.5', 계약상태처리: '소멸' }];
  const r = E.compareWithAnswerKey(rows, recs);
  assert.strictEqual(r.summary.일치, 1);
  assert.strictEqual(r.summary.생성에만, rows.length - 1);
});

test('필수 컬럼이 없으면 오류를 돌려준다', () => {
  const r = E.compareWithAnswerKey(rows, [{ 급부: 'x' }]);
  assert.match(r.error, /필수 컬럼이 없습니다: 구보장급부명/);
});
