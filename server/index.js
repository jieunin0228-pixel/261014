// 약관 담보 분석기 로컬 서버. 이 PC(127.0.0.1)에서만 접속할 수 있습니다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

// .env 파일이 있으면 환경변수로 읽습니다(ANTHROPIC_API_KEY 등). 키는 브라우저에 보내지 않습니다.
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* .env 없음 */ }

const store = require('./store');
const jobs = require('./analyze/jobs');
const { applyOverrides, CATEGORIES } = require('./analyze/classify');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD = 500 * 1024 * 1024;

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  const structure = store.readCache(id, 'structure');
  const review = store.readReview(id);
  const sections = structure.sections.map(({ id: sid, title, kind, appendixNo, startPage, endPage, articles, toc, guessed }) => ({
    id: sid, title, kind, appendixNo, startPage, endPage, guessed, articleCount: articles.length, toc,
  }));
  res.json({ meta, categories: CATEGORIES, sections, coverages: applyOverrides(store.readCache(id, 'coverages'), review), review });
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
  store.writeReview(id, next);
  res.json({ ok: true, savedAt: store.readReview(id).savedAt });
});

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
function sanitizeEdits(edits) {
  const out = {};
  for (const [key, e] of Object.entries(edits).slice(0, 5000)) {
    if (!e || typeof e !== 'object') continue;
    const v = { name: str(e.name), category: CATEGORIES.includes(e.category) ? e.category : undefined, group: str(e.group), excluded: typeof e.excluded === 'boolean' ? e.excluded : undefined };
    out[str(key, 80)] = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
  }
  return out;
}
function sanitizeAdded(a) {
  if (!a || typeof a !== 'object' || !str(a.name) || !/^U\d+$/.test(a.id)) return null;
  return { id: a.id, name: str(a.name), category: CATEGORIES.includes(a.category) ? a.category : '기타', group: str(a.group) || '직접 추가', reason: '사용자가 직접 추가한 담보입니다.', sectionId: str(a.sectionId, 20) || null, sectionTitle: str(a.sectionTitle) || null, evidence: null };
}

// 원본 PDF(3단계 뷰어용)
app.get('/api/docs/:id/pdf', (req, res) => {
  const file = store.pdfPath(req.params.id);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type('application/pdf').sendFile(file);
});

app.use((err, req, res, _next) => {
  console.error(err);
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
