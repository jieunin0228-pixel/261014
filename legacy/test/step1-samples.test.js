const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const XLSX = require('xlsx');
const { ANSWER_KEY_COLUMNS } = require('../src/schema');

test('정답지 엑셀은 필수 컬럼 헤더와 22개 행을 가진다', () => {
  const book = XLSX.readFile(path.join(__dirname, '..', 'samples', 'answer_key.xlsx'));
  const aoa = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1 });
  assert.deepStrictEqual(aoa[0], ANSWER_KEY_COLUMNS);
  assert.strictEqual(aoa.length - 1, 22);
  for (const row of aoa.slice(1)) assert.strictEqual(row.length, ANSWER_KEY_COLUMNS.length);
});

test('더미 약관 txt 는 조문 8개를 포함한다', () => {
  const fs = require('fs');
  const text = fs.readFileSync(path.join(__dirname, '..', 'samples', 'dummy_terms.txt'), 'utf8');
  assert.strictEqual((text.match(/^제\d+조\(/gm) || []).length, 8);
});
