// 1단계 분석의 순수 부분: 쪽별 추출 결과 → 목차·구간·담보·경고. 서버(jobs.js)와 브라우저(아티팩트)가 함께 씁니다.
const { findToc, bodyStream, splitSections, matchToc } = require('../pdf/toc');
const { extractCoverages, applyOverrides, CATEGORIES } = require('./classify');

// 추출 규칙을 고치면 이 값을 올립니다. 값이 다른 캐시는 다시 분석합니다(사용자 수정·검토 기록은 별도로 저장되어 유지됩니다).
const STRUCTURE_VERSION = 'structure-1';

// onStep(done, total, message) 로 진행 단계를 알립니다.
function analyzeStructure(pages, onStep = () => {}) {
  onStep(0, 3, '목차를 찾는 중입니다.');
  const toc = findToc(pages);
  const stream = bodyStream(pages, toc.tocPages);
  onStep(1, 3, '약관 구간을 나누는 중입니다.');
  const sections = splitSections(stream);
  const tocMatch = matchToc(sections, toc, pages);
  onStep(2, 3, '담보를 찾아 분류하는 중입니다.');
  const coverages = extractCoverages(sections, stream, pages);

  const scannedPages = pages.filter((p) => p.scanned).map((p) => p.n);
  const warnings = [];
  if (scannedPages.length) {
    warnings.push({ type: 'ocr', message: `${scannedPages.length}개 쪽이 이미지(스캔)로 되어 있어 글자를 읽지 못했습니다. 이 쪽의 내용은 분석에서 빠지므로 OCR(글자 인식)을 거친 PDF를 다시 올려야 합니다.`, pages: scannedPages });
  }
  if (!toc.tocPages.length) warnings.push({ type: 'toc', message: '목차 쪽을 찾지 못해 본문의 약관 제목과 조문 번호만으로 구간을 나눴습니다.' });
  if (tocMatch.missing.length) {
    warnings.push({ type: 'toc-missing', message: `목차에는 있으나 본문에서 찾지 못한 약관·별표가 ${tocMatch.missing.length}개 있습니다. 해당 담보가 목록에서 빠졌을 수 있습니다.`, items: tocMatch.missing });
  }
  const guessed = sections.filter((s) => s.guessed);
  if (guessed.length) warnings.push({ type: 'title', message: `제목을 확인하지 못한 구간이 ${guessed.length}개 있습니다. 담보 편집에서 중분류 이름을 고쳐 주십시오.`, items: guessed.map((s) => ({ title: s.title, pdfPage: s.startPage })) });

  const meta = {
    version: STRUCTURE_VERSION, numPages: pages.length, textPages: pages.filter((p) => !p.scanned && !p.blank).length, scannedPages,
    printedPagesFound: pages.filter((p) => p.printed != null).length,
    sectionCount: sections.filter((s) => s.kind !== '별표').length, appendixCount: sections.filter((s) => s.kind === '별표').length,
    coverageCount: coverages.length, warnings,
  };
  return { meta, structure: { tocPages: toc.tocPages, toc: tocMatch.entries, sections }, coverages };
}

// 화면에 보낼 문서 묶음(사용자 수정 반영)
function docView(meta, structure, coverages, review = {}) {
  const sections = structure.sections.map(({ id, title, kind, appendixNo, startPage, endPage, articles, toc, guessed }) => ({
    id, title, kind, appendixNo, startPage, endPage, guessed, articleCount: articles.length, toc,
  }));
  return { meta, categories: CATEGORIES, sections, coverages: applyOverrides(coverages, review), review };
}

module.exports = { STRUCTURE_VERSION, analyzeStructure, docView };
