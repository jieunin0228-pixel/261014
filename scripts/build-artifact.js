// claude.ai 아티팩트 게시용 페이지(build/artifact.html)를 index.html 에서 만듭니다.
// 아티팩트는 문서 골격(doctype·html·head·body)을 자동으로 씌우고 외부 스크립트를 허용된 CDN 에서만 받으므로,
// 골격 태그를 걷어 내고 SheetJS 를 jsDelivr 의 같은 버전으로 바꿉니다.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<\/?html[^>]*>\s*/gi, '')
  .replace(/<\/?head>\s*/gi, '')
  .replace(/<\/?body>\s*/gi, '')
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '')
  .replace('src="vendor/xlsx.full.min.js"', 'src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"');
if (!html.startsWith('<title>')) throw new Error('title 이 맨 앞에 와야 합니다.');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'artifact.html'), html);
console.log('build/artifact.html', html.length, 'bytes');
