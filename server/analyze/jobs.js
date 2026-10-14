// 1단계 분석 작업: 쪽별 추출 → 목차 인식 → 약관 구간 분리 → 담보 추출·분류.
// 진행 상황은 구독자(SSE)에게 보내고, 결과는 data/cache/<해시>/ 에 파일로 남깁니다.
const fs = require('fs');
const { EventEmitter } = require('events');
const store = require('../store');
const { extractPdf } = require('../pdf/extract');
const { findToc, bodyStream, splitSections, matchToc } = require('../pdf/toc');
const { extractCoverages } = require('./classify');

// 추출 규칙을 고치면 이 값을 올립니다. 값이 다른 캐시는 다시 분석합니다(사용자 수정·검토 기록은 별도 파일이라 유지됩니다).
const STRUCTURE_VERSION = 'structure-1';

const jobs = new Map(); // id → { emitter, last, done, error }

function isCached(id) {
  const meta = store.readCache(id, 'meta');
  return !!(meta && meta.version === STRUCTURE_VERSION && meta.status === 'done');
}

function start(id, fileName) {
  if (jobs.has(id) && !jobs.get(id).done) return jobs.get(id);
  const job = { emitter: new EventEmitter(), last: null, done: false, error: null };
  job.emitter.setMaxListeners(50);
  jobs.set(id, job);
  const emit = (ev) => { job.last = ev; job.emitter.emit('progress', ev); };
  run(id, fileName, emit)
    .then(() => { job.done = true; emit({ stage: 'done', message: '분석이 끝났습니다.' }); })
    .catch((err) => {
      job.done = true; job.error = err.message;
      store.writeCache(id, 'meta', { ...(store.readCache(id, 'meta') || {}), id, fileName, status: 'error', error: err.message });
      emit({ stage: 'error', message: `분석 중 오류가 났습니다: ${err.message}` });
    });
  return job;
}

async function run(id, fileName, emit) {
  const startedAt = Date.now();
  emit({ stage: 'extract', done: 0, total: 0, message: 'PDF를 여는 중입니다.' });
  const data = fs.readFileSync(store.pdfPath(id));
  let lastSent = 0;
  const { numPages, pages } = await extractPdf(data, (n, total) => {
    if (n === total || Date.now() - lastSent > 200) {
      lastSent = Date.now();
      emit({ stage: 'extract', done: n, total, message: `쪽별 글자 추출 ${n} / ${total}쪽` });
    }
  });

  emit({ stage: 'structure', done: 0, total: 3, message: '목차를 찾는 중입니다.' });
  const toc = findToc(pages);
  const stream = bodyStream(pages, toc.tocPages);
  emit({ stage: 'structure', done: 1, total: 3, message: '약관 구간을 나누는 중입니다.' });
  const sections = splitSections(stream);
  const tocMatch = matchToc(sections, toc, pages);
  emit({ stage: 'structure', done: 2, total: 3, message: '담보를 찾아 분류하는 중입니다.' });
  const coverages = extractCoverages(sections, stream, pages);

  const scannedPages = pages.filter((p) => p.scanned).map((p) => p.n);
  const textPages = pages.filter((p) => !p.scanned && !p.blank).length;
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

  store.writeCache(id, 'pages', pages);
  store.writeCache(id, 'structure', { tocPages: toc.tocPages, toc: tocMatch.entries, sections });
  store.writeCache(id, 'coverages', coverages);
  store.writeCache(id, 'meta', {
    id, fileName, status: 'done', version: STRUCTURE_VERSION, numPages, textPages, scannedPages,
    printedPagesFound: pages.filter((p) => p.printed != null).length,
    sectionCount: sections.filter((s) => s.kind !== '별표').length, appendixCount: sections.filter((s) => s.kind === '별표').length,
    coverageCount: coverages.length, warnings, createdAt: new Date().toISOString(), seconds: Math.round((Date.now() - startedAt) / 100) / 10,
  });
  emit({ stage: 'structure', done: 3, total: 3, message: '분석 결과를 저장했습니다.' });
}

module.exports = { start, jobs, isCached, STRUCTURE_VERSION };
