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
console.log(`dummy_terms.txt ${terms.length}자, answer_key.xlsx ${rows.length}행 생성`);
