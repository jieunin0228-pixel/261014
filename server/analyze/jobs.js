// 1단계 분석 작업: 쪽별 추출 → 목차 인식 → 약관 구간 분리 → 담보 추출·분류.
// 진행 상황은 구독자(SSE)에게 보내고, 결과는 data/cache/<해시>/ 에 파일로 남깁니다.
const fs = require('fs');
const { EventEmitter } = require('events');
const store = require('../store');
const { extractPdf } = require('../pdf/extract');
const { analyzeStructure, STRUCTURE_VERSION } = require('./pipeline');

// 쪽별 글자 추출 방식이 바뀌면 올립니다. 같으면 목차 쪽 지정 등으로 다시 분석할 때 저장된 추출 결과를 그대로 씁니다.
const EXTRACT_VERSION = 'extract-2';

const jobs = new Map(); // id → { emitter, last, done, error }

function isCached(id) {
  const meta = store.readCache(id, 'meta');
  return !!(meta && meta.version === STRUCTURE_VERSION && meta.status === 'done');
}

function start(id, fileName) {
  const prev = jobs.get(id);
  if (prev && prev.done) jobs.delete(id);
  if (jobs.has(id) && !jobs.get(id).done) return jobs.get(id);
  // 목차 쪽 지정 등으로 다시 분석할 때 저장된 쪽별 추출 결과가 있으면 PDF 를 다시 읽지 않습니다.
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
  const oldMeta = store.readCache(id, 'meta');
  const cachedPages = oldMeta && oldMeta.extractVersion === EXTRACT_VERSION ? store.readCache(id, 'pages') : null;
  const data = cachedPages ? null : fs.readFileSync(store.pdfPath(id));
  let lastSent = 0;
  const { pages } = cachedPages ? { pages: cachedPages } : await extractPdf(data, (n, total) => {
    if (n === total || Date.now() - lastSent > 200) {
      lastSent = Date.now();
      emit({ stage: 'extract', done: n, total, message: `쪽별 글자 추출 ${n} / ${total}쪽` });
    }
  });

  // 사용자가 목차 쪽을 지정했으면 그 쪽을 목차로 읽습니다.
  const range = (store.readReview(id) || {}).tocRange;
  const tocPages = range ? Array.from({ length: range.to - range.from + 1 }, (_, k) => range.from + k) : undefined;
  const { meta, structure, coverages } = analyzeStructure(pages, (done, total, message) => emit({ stage: 'structure', done, total, message }), { tocPages });
  const previous = store.readCache(id, 'coverages');
  if (previous) remapReview(id, previous, coverages);
  store.writeCache(id, 'pages', pages);
  store.writeCache(id, 'structure', structure);
  store.writeCache(id, 'coverages', coverages);
  store.writeCache(id, 'meta', { id, fileName, status: 'done', ...meta, extractVersion: EXTRACT_VERSION, tocRange: range || null, createdAt: new Date().toISOString(), seconds: Math.round((Date.now() - startedAt) / 100) / 10 });
  emit({ stage: 'structure', done: 3, total: 3, message: '분석 결과를 저장했습니다.' });
}

// 분석 규칙이 바뀌어 같은 PDF 를 다시 분석하면 담보 ID 가 달라질 수 있습니다.
// 사용자 수정·선택·검토 기록과 담보별 분석 결과를 "약관 제목 + 자동 담보명"이 같은 새 담보로 옮기고, 짝이 없는 것은 버립니다.
function remapReview(id, oldCoverages, newCoverages) {
  const key = (c) => `${c.sectionTitle}|${c.name}`;
  const newByKey = new Map(newCoverages.map((c) => [key(c), c.id]));
  const map = new Map(oldCoverages.map((c) => [c.id, newByKey.get(key(c))]));
  const to = (oldId) => (/^U\d+$/.test(oldId) ? oldId : map.get(oldId));
  const review = store.readReview(id);
  if (Object.keys(review).length) {
    const rekey = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => { const [cid, ...rest] = k.split('|'); const n = to(cid); return n ? [[n, ...rest].join('|'), v] : null; }).filter(Boolean));
    store.writeReview(id, {
      ...review,
      edits: rekey(review.edits), reviewStatus: rekey(review.reviewStatus), fieldEdits: rekey(review.fieldEdits),
      selected: (review.selected || []).map(to).filter(Boolean),
    });
  }
  for (const a of store.listAnalyses(id)) {
    const n = to(a.coverageId);
    store.removeAnalysis(id, a.coverageId);
    if (n) store.writeAnalysis(id, n, { ...a, coverageId: n });
  }
}

module.exports = { start, jobs, isCached, STRUCTURE_VERSION, remapReview };
