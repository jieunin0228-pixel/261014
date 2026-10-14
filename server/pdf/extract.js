// 서버용 PDF 추출: pdf.js 를 불러 extract-core 에 넘깁니다. 한글 문자표·표준 글꼴은 pdfjs-dist 패키지의 파일을 씁니다.
const path = require('path');
const core = require('./extract-core');

const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
let pdfjsPromise;
const loadPdfjs = () => (pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'));

// 반환: { numPages, pages: [{ n, printed, width, height, chars, scanned, blank, lines: [{ t, x, y, w, h, noise? }] }] }
async function extractPdf(data, onProgress) {
  return core.extractPages(await loadPdfjs(), {
    data: new Uint8Array(data),
    cMapUrl: path.join(PDFJS_DIR, 'cmaps') + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(PDFJS_DIR, 'standard_fonts') + path.sep,
    disableFontFace: true,
  }, onProgress);
}

module.exports = { ...core, extractPdf };
