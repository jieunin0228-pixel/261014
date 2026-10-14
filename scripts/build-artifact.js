// claude.ai 아티팩트 게시용 페이지(build/artifact.html)를 만듭니다. 로컬 서버 없이 브라우저 안에서만 분석하는 판입니다.
//  - 화면(public/)은 로컬판과 같은 파일을 쓰고, 서버 통신(api-server.js) 대신 브라우저 분석(artifact/api-local.js)을 넣습니다.
//  - 분석 로직(server/pdf/extract-core·toc, server/analyze/classify·pipeline)은 서버와 같은 파일을 묶어 넣습니다.
//  - pdf.js 는 jsDelivr 의 3.11.174 를 쓰고(아티팩트는 별도 워커를 막으므로 워커 스크립트를 일반 스크립트로 불러 메인 스레드에서 처리),
//    비내장 한글 글꼴용 문자표는 pdfjs-dist 패키지에서 꺼내 페이지에 넣습니다.
// 실행: node scripts/build-artifact.js  →  build/artifact.html, build/sample_policy.pdf
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// CommonJS 모듈을 브라우저에서 쓰도록 묶습니다. require 는 파일 이름(확장자 제외)으로 찾습니다.
const MODULES = ['server/pdf/extract-core.js', 'server/pdf/toc.js', 'server/analyze/classify.js', 'server/analyze/pipeline.js'];
const bundle = `(function () {
  const defs = {}, cache = {};
  const require = (p) => { const k = p.split('/').pop().replace(/\\.js$/, ''); if (!cache[k]) { const module = { exports: {} }; cache[k] = module; defs[k](module, module.exports, require); } return cache[k].exports; };
${MODULES.map((m) => `  defs[${JSON.stringify(path.basename(m, '.js'))}] = function (module, exports, require) {\n${read(m)}\n};`).join('\n')}
  const core = require('extract-core'), pipeline = require('pipeline');
  window.CoverageCore = { extractPages: core.extractPages, analyzeStructure: pipeline.analyzeStructure, docView: pipeline.docView, STRUCTURE_VERSION: pipeline.STRUCTURE_VERSION };
})();`;

// 한글 문자표(.bcmap)를 base64 로 담습니다.
const cmapDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'cmaps');
const cmaps = {};
for (const f of fs.readdirSync(cmapDir)) {
  if (/^(Adobe-Korea1|KSC|UniKS)/.test(f) && f.endsWith('.bcmap')) cmaps[f.replace('.bcmap', '')] = fs.readFileSync(path.join(cmapDir, f)).toString('base64');
}

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build';
const script = (code) => `<script>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`;
let html = read('public/index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/\s*<script src="[^"]+"><\/script>/g, '');
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0];

html = `<title>약관 담보 분석기</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>
${read('public/style.css')}
</style>
${body.trim()}
<script src="${PDFJS}/pdf.worker.min.js"></script>
<script src="${PDFJS}/pdf.min.js"></script>
${script(`window.PDF_CMAPS_KO = ${JSON.stringify(cmaps)};`)}
${script(bundle)}
${script(read('public/tree.js'))}
${script(read('artifact/api-local.js'))}
${script(read('public/app.js'))}
`;
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'artifact.html'), html);
fs.copyFileSync(path.join(root, 'samples', 'sample_policy.pdf'), path.join(root, 'build', 'sample_policy.pdf'));
console.log(`build/artifact.html ${Math.round(html.length / 1024)}KB, 문자표 ${Object.keys(cmaps).length}개`);
