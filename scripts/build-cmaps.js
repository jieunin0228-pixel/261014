// pdf.js 의 한글 문자표(CMap)를 vendor/cmaps-ko.js 하나로 묶습니다.
// 아티팩트는 외부에서 .bcmap 파일을 받아 올 수 없어, 문자표를 스크립트 안에 base64 로 넣어 둡니다.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'cmaps');
const names = fs.readdirSync(dir).filter((f) => /^(Adobe-Korea1|KSC|UniKS)/.test(f) && f.endsWith('.bcmap'));
const map = Object.fromEntries(names.map((f) => [f.replace(/\.bcmap$/, ''), fs.readFileSync(path.join(dir, f)).toString('base64')]));
const out = `// 자동 생성(scripts/build-cmaps.js): pdfjs-dist 3.11.174 의 한글 CMap ${names.length}개. 원본 라이선스는 node_modules/pdfjs-dist/cmaps/LICENSE 를 따릅니다.\nself.PDF_CMAPS_KO = ${JSON.stringify(map)};\n`;
fs.writeFileSync(path.join(__dirname, '..', 'vendor', 'cmaps-ko.js'), out);
console.log(`vendor/cmaps-ko.js: ${names.length}개, ${out.length.toLocaleString()} bytes`);
