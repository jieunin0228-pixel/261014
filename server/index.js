// 약관 담보 분석기 로컬 서버. 이 PC(127.0.0.1)에서만 접속할 수 있습니다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

// .env 파일이 있으면 환경변수로 읽습니다(ANTHROPIC_API_KEY 등). 키는 브라우저에 보내지 않습니다.
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* .env 없음 */ }

const store = require('./store');
const jobs = require('./analyze/jobs');
const { CATEGORIES, applyOverrides } = require('./analyze/classify');
const { docView } = require('./analyze/pipeline');
const analysisJobs = require('./analyze/analysis-jobs');
const { buildView, FLAG_TEXT } = require('./analyze/coverage');
const { aiStatus } = require('./analyze/ai-client');
const codemaster = require('./ecs/codemaster');
const { FIELDS } = require('./ecs/fields');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD = 500 * 1024 * 1024;

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// 화면의 [샘플 약관 열기]용 시험 PDF
app.use('/samples', express.static(path.join(__dirname, '..', 'samples')));

// PDF 업로드: 본문을 그대로 받아 파일로 쓰면서 SHA-256 해시를 계산합니다. 같은 해시가 이미 분석돼 있으면 재사용합니다.
app.post('/api/upload', (req, res, next) => {
  const fileName = decodeURIComponent(req.get('x-file-name') || 'upload.pdf');
  const tmp = path.join(store.dirs.tmp, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let size = 0, head = Buffer.alloc(0), aborted = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (head.length < 5) head = Buffer.concat([head, chunk]).subarray(0, 5);
    if (size > MAX_UPLOAD && !aborted) { aborted = true; req.unpipe(out); out.destroy(); fs.rm(tmp, { force: true }, () => {}); res.status(413).json({ error: 'PDF가 500MB를 넘습니다.' }); }
    hash.update(chunk);
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    try {
      if (head.toString('latin1') !== '%PDF-') { fs.rmSync(tmp, { force: true }); return res.status(400).json({ error: 'PDF 파일이 아닙니다.' }); }
      const id = hash.digest('hex');
      const dest = store.pdfPath(id);
      if (fs.existsSync(dest)) fs.rmSync(tmp, { force: true }); else fs.renameSync(tmp, dest);
      const cached = jobs.isCached(id);
      if (cached) touch(id, fileName);
      else jobs.start(id, fileName);
      res.json({ id, cached });
    } catch (err) { next(err); }
  });
  out.on('error', next);
});

function touch(id, fileName) {
  const meta = store.readCache(id, 'meta');
  if (meta) store.writeCache(id, 'meta', { ...meta, openedAt: new Date().toISOString(), lastFileName: fileName || meta.fileName });
}

// 분석 진행률(Server-Sent Events)
app.get('/api/docs/:id/events', (req, res) => {
  const id = store.checkId(req.params.id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const job = jobs.jobs.get(id);
  if (!job) { send(jobs.isCached(id) ? { stage: 'done', message: '이미 분석된 문서입니다.' } : { stage: 'error', message: '진행 중인 분석이 없습니다. PDF를 다시 올려 주십시오.' }); return res.end(); }
  if (job.last) send(job.last);
  if (job.done) return res.end();
  const onProgress = (ev) => { send(ev); if (ev.stage === 'done' || ev.stage === 'error') res.end(); };
  job.emitter.on('progress', onProgress);
  req.on('close', () => job.emitter.off('progress', onProgress));
});

app.get('/api/docs', (req, res) => res.json(store.listDocs()));

// 문서 열기: 메타·구간·담보(사용자 수정 반영)·검토 상태
app.get('/api/docs/:id', (req, res) => {
  const id = store.checkId(req.params.id);
  const meta = store.readCache(id, 'meta');
  if (!meta || meta.status !== 'done') return res.status(404).json({ error: '분석 결과가 없습니다.', meta });
  // 분석 규칙이 바뀐 뒤 처음 여는 문서는 저장된 PDF 로 다시 분석합니다(사용자 수정은 옮겨 둡니다).
  if (meta.version !== jobs.STRUCTURE_VERSION) {
    if (!fs.existsSync(store.pdfPath(id))) return res.status(404).json({ error: '원본 PDF가 없어 다시 분석할 수 없습니다. PDF를 다시 올려 주십시오.' });
    jobs.start(id, meta.fileName);
    return res.status(409).json({ reanalyzing: true, error: '앱의 약관 읽기 규칙이 개선되어 이 약관을 다시 분석합니다.' });
  }
  res.json(docView(meta, store.readCache(id, 'structure'), store.readCache(id, 'coverages'), store.readReview(id)));
});

// 사용자 수정·선택 상태 저장. 받은 값 중 정해진 키만 저장합니다.
app.put('/api/docs/:id/review', (req, res) => {
  const id = store.checkId(req.params.id);
  if (!store.readCache(id, 'meta')) return res.status(404).json({ error: '문서가 없습니다.' });
  const body = req.body || {};
  const prev = store.readReview(id);
  const next = { ...prev };
  if (body.edits && typeof body.edits === 'object') next.edits = sanitizeEdits(body.edits);
  if (Array.isArray(body.added)) next.added = body.added.slice(0, 500).map(sanitizeAdded).filter(Boolean);
  if (Array.isArray(body.selected)) next.selected = body.selected.filter((s) => typeof s === 'string').slice(0, 5000);
  if (body.reviewStatus && typeof body.reviewStatus === 'object') next.reviewStatus = sanitizeMap(body.reviewStatus, (v) => (v === 'done' ? 'done' : undefined));
  if (body.fieldEdits && typeof body.fieldEdits === 'object') next.fieldEdits = sanitizeMap(body.fieldEdits, (v) => (v && typeof v === 'object' ? clean({ code: str(v.code, 40), name: str(v.name, 500) }) : undefined));
  if (body.product && typeof body.product === 'object') next.product = clean({ productCode: str(body.product.productCode, 40), productName: str(body.product.productName, 200), saleDate: str(body.product.saleDate, 20) });
  store.writeReview(id, next);
  res.json({ ok: true, savedAt: store.readReview(id).savedAt });
});

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));
function sanitizeMap(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 20000)) { const x = fn(v); if (x !== undefined && typeof k === 'string' && k.length <= 200) out[k] = x; }
  return out;
}
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
function sanitizeEdits(edits) {
  const out = {};
  for (const [key, e] of Object.entries(edits).slice(0, 5000)) {
    if (!e || typeof e !== 'object') continue;
    const v = {
      name: str(e.name), category: CATEGORIES.includes(e.category) ? e.category : undefined, group: str(e.group), excluded: typeof e.excluded === 'boolean' ? e.excluded : undefined,
      sectionId: /^S\d{3}$/.test(e.sectionId) ? e.sectionId : undefined, sectionTitle: str(e.sectionTitle),
    };
    out[str(key, 80)] = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
  }
  return out;
}
function sanitizeAdded(a) {
  if (!a || typeof a !== 'object' || !str(a.name) || !/^U\d+$/.test(a.id)) return null;
  return { id: a.id, name: str(a.name), category: CATEGORIES.includes(a.category) ? a.category : '기타', group: str(a.group) || '직접 추가', reason: '사용자가 직접 추가한 담보입니다.', sectionId: str(a.sectionId, 20) || null, sectionTitle: str(a.sectionTitle) || null, evidence: null };
}

// 요청 본문을 그대로 읽습니다(코드마스터 엑셀 업로드용, 20MB 제한).
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('파일이 너무 큽니다.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 앱 설정 상태: AI 사용 가능 여부, 현재 코드마스터
app.get('/api/config', (req, res) => {
  res.json({ ai: aiStatus(), codemaster: codemaster.summary(analysisJobs.currentMaster()), fields: FIELDS, flagText: FLAG_TEXT });
});

// ───────────── 코드마스터 ─────────────
app.get('/api/codemaster/download', async (req, res) => {
  const m = analysisJobs.currentMaster();
  const buf = await codemaster.toXlsx(m);
  const name = m.provisional ? '임시_코드마스터.xlsx' : '코드마스터.xlsx';
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buf));
});
app.post('/api/codemaster', async (req, res) => {
  const fileName = decodeURIComponent(req.get('x-file-name') || '코드마스터.xlsx');
  const master = await codemaster.fromXlsx(await readBody(req), fileName);
  store.writeMaster(master);
  res.json(codemaster.summary(master));
});
app.delete('/api/codemaster', (req, res) => {
  store.clearMaster();
  res.json(codemaster.summary(analysisJobs.currentMaster()));
});

// ───────────── 담보 분석(2단계) ─────────────
app.post('/api/docs/:id/analysis', (req, res) => {
  const id = store.checkId(req.params.id);
  if (!store.readCache(id, 'meta')) return res.status(404).json({ error: '문서가 없습니다.' });
  const st = aiStatus();
  if (!st.ready) return res.status(400).json({ error: st.message });
  const ids = Array.isArray(req.body && req.body.coverageIds) ? req.body.coverageIds.filter((x) => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ error: '분석할 담보를 선택해 주십시오.' });
  res.json(analysisJobs.start(id, ids, { force: !!req.body.force }));
});
app.post('/api/docs/:id/analysis/stop', (req, res) => {
  analysisJobs.stop(store.checkId(req.params.id));
  res.json({ ok: true });
});
app.get('/api/docs/:id/analysis/events', (req, res) => {
  const id = store.checkId(req.params.id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const job = analysisJobs.jobs.get(id);
  if (!job) { send({ stage: 'idle' }); return res.end(); }
  if (job.last) send(job.last);
  if (job.done) { send({ stage: 'done', message: job.last ? job.last.message : '' }); return res.end(); }
  const on = (ev) => { send(ev); if (ev.stage === 'done') res.end(); };
  job.emitter.on('progress', on);
  req.on('close', () => job.emitter.off('progress', on));
});
// 분석 결과(화면용). 코드 검사는 현재 코드마스터 기준으로 매번 다시 합니다.
app.get('/api/docs/:id/analysis', (req, res) => {
  const id = store.checkId(req.params.id);
  const review = store.readReview(id);
  const coverages = applyOverrides(store.readCache(id, 'coverages') || [], review);
  const master = analysisJobs.currentMaster();
  const out = {};
  for (const stored of store.listAnalyses(id)) {
    const c = coverages.find((x) => x.id === stored.coverageId);
    if (!c) continue;
    out[c.id] = stored.verified ? { ...buildView(stored, c, master, review), lastError: stored.lastError || null } : { error: stored.lastError || '분석 결과가 없습니다.' };
  }
  const job = analysisJobs.jobs.get(id);
  res.json({ results: out, running: !!(job && !job.done), states: job ? job.states : {} });
});

// [PDF 글자 확인]: 앱이 한 쪽에서 읽은 글자 줄(머리글·쪽번호로 뺀 줄 표시)
app.get('/api/docs/:id/pages/:n', (req, res) => {
  const id = store.checkId(req.params.id);
  const pages = store.readCache(id, 'pages');
  const n = Number(req.params.n);
  if (!pages || !Number.isInteger(n) || n < 1 || n > pages.length) return res.status(404).json({ error: `1~${pages ? pages.length : 0}쪽 사이의 번호를 넣어 주십시오.` });
  const p = pages[n - 1];
  res.json({ n, total: pages.length, printed: p.printed, columns: p.columns || 1, scanned: p.scanned, lines: p.lines.map((l) => ({ t: l.t, noise: !!l.noise })) });
});

// 원본 PDF(3단계 뷰어용)
app.get('/api/docs/:id/pdf', (req, res) => {
  const file = store.pdfPath(req.params.id);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type('application/pdf').sendFile(file);
});

app.use((err, req, res, _next) => {
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`\n  약관 담보 분석기가 실행되었습니다.  브라우저에서 http://localhost:${PORT} 을 여십시오.`);
    console.log(`  데이터 저장 위치: ${store.DATA_DIR}`);
    console.log('  끝내려면 이 창에서 Ctrl+C 를 누릅니다.\n');
  });
}

module.exports = app;
