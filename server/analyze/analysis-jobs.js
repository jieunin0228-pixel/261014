// 담보 분석 작업: 선택한 담보를 두 개씩 동시에 Claude 로 분석하고, 진행 상황을 구독자(SSE)에게 보냅니다.
// 결과는 담보마다 파일로 저장하므로, 같은 담보는 [다시 분석]을 누르기 전까지 다시 호출하지 않습니다.
const { EventEmitter } = require('events');
const store = require('../store');
const { applyOverrides } = require('./classify');
const { analyzeCoverage } = require('./coverage');
const { PROMPT_VERSION } = require('./prompt');
const { provisionalMaster } = require('../ecs/codemaster');

const CONCURRENCY = 2;
const jobs = new Map(); // 문서 id → job

const currentMaster = () => store.readMaster() || provisionalMaster();

function loadDoc(id) {
  return { pages: store.readCache(id, 'pages'), structure: store.readCache(id, 'structure') };
}

// 저장된 결과가 지금 담보 이름·분석 기준과 맞으면 다시 부르지 않습니다.
function isFresh(stored, coverage) {
  return stored && stored.name === coverage.name && stored.promptVersion === PROMPT_VERSION;
}

function start(id, coverageIds, { force = false } = {}) {
  const running = jobs.get(id);
  if (running && !running.done) throw Object.assign(new Error('이미 분석 중입니다. 끝난 뒤 다시 시도하거나 [중지]를 눌러 주십시오.'), { status: 409 });
  const coverages = applyOverrides(store.readCache(id, 'coverages'), store.readReview(id));
  const targets = coverageIds.map((cid) => coverages.find((c) => c.id === cid)).filter((c) => c && !c.excluded);
  const todo = targets.filter((c) => force || !isFresh(store.readAnalysis(id, c.id), c));
  const job = { emitter: new EventEmitter(), controller: new AbortController(), done: false, last: null, states: {}, total: todo.length, finished: 0, skipped: targets.length - todo.length };
  job.emitter.setMaxListeners(50);
  jobs.set(id, job);
  const emit = (ev) => { job.last = { ...ev, states: job.states, done: job.finished, total: job.total }; job.emitter.emit('progress', job.last); };
  for (const c of todo) job.states[c.id] = 'waiting';

  const doc = loadDoc(id);
  const master = currentMaster();
  const queue = [...todo];
  const worker = async () => {
    while (queue.length && !job.controller.signal.aborted) {
      const c = queue.shift();
      job.states[c.id] = 'running';
      emit({ stage: 'coverage', coverageId: c.id, message: `${c.name} 분석 중` });
      try {
        const result = await analyzeCoverage({ doc, coverage: c, master, signal: job.controller.signal });
        store.writeAnalysis(id, c.id, result);
        job.states[c.id] = 'done';
      } catch (err) {
        job.states[c.id] = err.aborted ? 'stopped' : 'error';
        store.writeAnalysis(id, c.id, { ...(store.readAnalysis(id, c.id) || {}), coverageId: c.id, lastError: err.message, lastErrorAt: new Date().toISOString() });
      }
      job.finished += 1;
      emit({ stage: 'coverage', coverageId: c.id, message: `${c.name} ${job.states[c.id] === 'done' ? '분석 완료' : '분석 실패'}` });
    }
  };
  Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length || 1) }, worker)).then(() => {
    job.done = true;
    for (const [cid, st] of Object.entries(job.states)) if (st === 'waiting') job.states[cid] = 'stopped';
    const failed = Object.values(job.states).filter((s) => s === 'error').length;
    emit({ stage: 'done', message: job.controller.signal.aborted ? '분석을 중지했습니다.' : `분석이 끝났습니다.${failed ? ` 실패 ${failed}건은 카드의 오류 내용을 확인해 주십시오.` : ''}` });
  });
  return { total: job.total, skipped: job.skipped };
}

function stop(id) {
  const job = jobs.get(id);
  if (job && !job.done) job.controller.abort();
}

module.exports = { start, stop, jobs, currentMaster, isFresh };
