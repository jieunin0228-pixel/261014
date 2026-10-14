// 더미 약관 텍스트(samples/dummy_terms.txt)와 정답지 엑셀(samples/answer_key.xlsx)을 생성합니다.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { ANSWER_KEY_COLUMNS } = require('../src/schema');
const terms = require('../samples/dummy-terms');
const rows = require('./answer-key-data');

const outDir = path.join(__dirname, '..', 'samples');
fs.writeFileSync(path.join(outDir, 'dummy_terms.txt'), terms, 'utf8');

const sheet = XLSX.utils.aoa_to_sheet([ANSWER_KEY_COLUMNS, ...rows]);
sheet['!cols'] = [18, 10, 12, 44, 44, 12].map((wch) => ({ wch }));
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, sheet, '정답지');
XLSX.writeFile(book, path.join(outDir, 'answer_key.xlsx'));
// 아티팩트에는 .xlsx 를 첨부할 수 없어 [샘플 정답지로 비교] 버튼은 같은 내용의 JSON 을 읽습니다.
const records = rows.map((r) => Object.fromEntries(ANSWER_KEY_COLUMNS.map((c, i) => [c, r[i]])));
fs.writeFileSync(path.join(outDir, 'answer_key.json'), JSON.stringify(records, null, 1) + '\n', 'utf8');
console.log(`dummy_terms.txt ${terms.length}자, answer_key.xlsx·json ${rows.length}행 생성`);
