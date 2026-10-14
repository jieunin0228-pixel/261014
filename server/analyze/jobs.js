// 1단계 분석 작업: 쪽별 추출 → 목차 인식 → 약관 구간 분리 → 담보 추출·분류.
// 진행 상황은 구독자(SSE)에게 보내고, 결과는 data/cache/<해시>/ 에 파일로 남깁니다.
const fs = require('fs');
const { EventEmitter } = require('events');
const store = require('../store');
const { extractPdf } = require('../pdf/extract');
const { analyzeStructure, STRUCTURE_VERSION } = require('./pipeline');

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
  const { pages } = await extractPdf(data, (n, total) => {
    if (n === total || Date.now() - lastSent > 200) {
      lastSent = Date.now();
      emit({ stage: 'extract', done: n, total, message: `쪽별 글자 추출 ${n} / ${total}쪽` });
    }
  });

  const { meta, structure, coverages } = analyzeStructure(pages, (done, total, message) => emit({ stage: 'structure', done, total, message }));
  store.writeCache(id, 'pages', pages);
  store.writeCache(id, 'structure', structure);
  store.writeCache(id, 'coverages', coverages);
  store.writeCache(id, 'meta', { id, fileName, status: 'done', ...meta, createdAt: new Date().toISOString(), seconds: Math.round((Date.now() - startedAt) / 100) / 10 });
  emit({ stage: 'structure', done: 3, total: 3, message: '분석 결과를 저장했습니다.' });
}

module.exports = { start, jobs, isCached, STRUCTURE_VERSION };
