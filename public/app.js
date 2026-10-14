// 화면: PDF 업로드 → 진행률 → 담보 분류 트리(중복 선택·편집) → 선택 담보 결과 카드
(function () {
  'use strict';
  const T = window.CoverageTree;
  const api = window.CoverageApi;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let doc = null;          // GET /api/docs/:id 응답
  let review = {};         // { edits, added, selected }
  let selected = new Set();
  let collapsed = new Set();
  let editing = null;      // 편집 중인 담보(새로 추가하면 null)
  let config = null;       // { ai, codemaster, flagText } (2단계, 로컬 실행판만)
  let results = {};        // 담보 id → 분석 결과(view)
  let jobStates = {};      // 담보 id → waiting | running | done | error | stopped
  let running = false;
  let stopWatch = null;

  // ───────────── 업로드와 진행률 ─────────────
  $('file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) analyzeFile(file);
  });
  $('recent').addEventListener('change', (e) => { if (e.target.value) openDoc(e.target.value); });

  function showProgress(ratio, msg) {
    $('progress').hidden = false;
    $('bar-fill').style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    $('progress-msg').textContent = msg;
  }

  async function analyzeFile(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { showProgress(0, 'PDF 파일만 올릴 수 있습니다.'); return; }
    try {
      showProgress(0, 'PDF를 여는 중입니다.');
      const res = await api.analyze(file, showProgress);
      showProgress(1, res.cached ? '이미 분석한 PDF입니다. 저장된 결과를 엽니다.' : '분석이 끝났습니다.');
      await openDoc(res.id);
    } catch (err) {
      showProgress(0, err.message);
    }
  }

  async function openSample() {
    try {
      showProgress(0, '시험용 가상 약관을 불러오는 중입니다.');
      const blob = await (await fetch(api.sampleUrl)).blob();
      await analyzeFile(new File([blob], 'sample_policy.pdf', { type: 'application/pdf' }));
    } catch (err) {
      showProgress(0, `샘플 약관을 불러오지 못했습니다. (${err.message})`);
    }
  }
  for (const b of document.querySelectorAll('[data-open-sample]')) b.addEventListener('click', openSample);

  async function loadRecent() {
    let list = [];
    try { list = await api.list(); } catch { /* 목록 없음 */ }
    $('recent').innerHTML = '<option value="">최근 분석한 약관 열기</option>' + list.filter((d) => d.status === 'done')
      .map((d) => `<option value="${d.id}">${esc(d.lastFileName || d.fileName)} (${d.numPages}쪽, 담보 ${d.coverageCount}개)</option>`).join('');
    return list;
  }

  async function openDoc(id) {
    try { doc = await api.open(id, showProgress); } catch (err) { showProgress(0, err.message); return; }
    review = {
      edits: doc.review.edits || {}, added: doc.review.added || [], selected: doc.review.selected || [],
      reviewStatus: doc.review.reviewStatus || {}, fieldEdits: doc.review.fieldEdits || {}, product: doc.review.product || {},
    };
    selected = new Set(review.selected);
    results = {}; jobStates = {};
    renderProduct();
    $('empty').hidden = true;
    $('workspace').hidden = false;
    setTimeout(() => { $('progress').hidden = true; }, 800);
    renderMeta();
    renderAll();
    loadRecent();
    loadResults();
  }

  // ───────────── 문서 요약·경고 ─────────────
  function renderMeta() {
    const m = doc.meta;
    $('summary').hidden = false;
    const example = (m.lastFileName || m.fileName) === 'sample_policy.pdf' ? '<span class="example">예시: 시험용 가상 약관</span>' : '';
    $('summary').innerHTML = `<strong>${esc(m.lastFileName || m.fileName)}</strong>${example}
      <span>전체 ${m.numPages}쪽</span><span>약관 ${m.sectionCount}개</span><span>별표 ${m.appendixCount}개</span>
      <span>자동 추출 담보 ${m.coverageCount}개</span><span>조문 제목 인식 ${m.articleCount ?? '-'}개</span>
      <span>인쇄 쪽번호 인식 ${m.printedPagesFound}쪽</span>${m.twoColumnPages ? `<span>2단 편집 ${m.twoColumnPages}쪽</span>` : ''}`;
    $('page-peek').hidden = false;
    $('peek-page').max = m.numPages;
    $('warnings').innerHTML = (m.warnings || []).map((w) => {
      let detail = '';
      if (w.pages) detail = `<div class="muted">해당 PDF 쪽: ${w.pages.slice(0, 40).join(', ')}${w.pages.length > 40 ? ' …' : ''}</div>`;
      if (w.items) detail = `<ul>${w.items.slice(0, 20).map((it) => `<li>${esc(it.title)}${it.printed ? ` (목차 ${it.printed}쪽)` : ''}${it.pdfPage ? ` (PDF ${it.pdfPage}쪽)` : ''}</li>`).join('')}</ul>`;
      return `<div class="warning ${w.type === 'ocr' ? 'strong' : ''}"><strong>${w.type === 'ocr' ? 'OCR 필요' : '확인 필요'}</strong> ${esc(w.message)}${detail}</div>`;
    }).join('');
  }

  // ───────────── PDF 글자 확인 ─────────────
  async function peek() {
    const n = Number($('peek-page').value);
    try {
      const p = await api.pageText(doc.meta.id, n);
      $('peek-info').textContent = `PDF ${p.n}쪽 / 전체 ${p.total}쪽 · 인쇄 쪽번호 ${p.printed ?? '미확인'} · ${p.columns === 2 ? '2단 편집으로 읽음' : '1단으로 읽음'}${p.scanned ? ' · 스캔 쪽(글자 없음)' : ''}`;
      $('peek-lines').innerHTML = p.lines.length
        ? p.lines.map((l) => `<div class="${l.noise ? 'noise' : ''}">${esc(l.t)}</div>`).join('')
        : '<div class="noise">이 쪽에서 읽은 글자가 없습니다.</div>';
    } catch (err) {
      $('peek-info').textContent = err.message;
      $('peek-lines').innerHTML = '';
    }
  }
  $('peek-go').addEventListener('click', peek);
  $('peek-page').addEventListener('keydown', (e) => { if (e.key === 'Enter') peek(); });

  // ───────────── 트리 ─────────────
  const coverages = () => doc.coverages;
  const findCov = (id) => coverages().find((c) => c.id === id);

  function renderAll() {
    // 제외한 담보는 선택에서도 뺍니다.
    for (const c of coverages()) if (c.excluded) selected.delete(c.id);
    renderTree();
    renderExcluded();
    renderCards();
  }

  function pageLabel(ev) {
    if (!ev) return '';
    return `PDF ${ev.page}쪽${ev.printed != null ? ` · 인쇄 ${ev.printed}쪽` : ' · 인쇄 쪽 미확인'}`;
  }

  function checkbox(st, attrs) {
    return `<input type="checkbox" ${attrs} ${st === 'all' ? 'checked' : ''} data-state="${st}">`;
  }

  function renderTree() {
    const tree = T.build(doc.categories, coverages(), $('search').value);
    $('tree').innerHTML = tree.map((cat) => {
      const ids = T.idsOfCategory(cat);
      const open = !collapsed.has(`c:${cat.name}`);
      return `<div class="node cat">
        <div class="node-row">
          <button class="caret" data-collapse="c:${esc(cat.name)}" aria-label="펼치기">${open ? '▾' : '▸'}</button>
          <label>${checkbox(T.state(ids, selected), `data-ids="${esc(ids.join('|'))}"`)} <strong>${esc(cat.name)}</strong> <span class="muted">(${cat.count})</span></label>
        </div>
        ${open ? `<div class="children">${cat.groups.length ? cat.groups.map((g) => renderGroup(cat, g)).join('') : '<p class="muted none">해당 담보가 없습니다.</p>'}</div>` : ''}
      </div>`;
    }).join('');
    for (const el of $('tree').querySelectorAll('input[data-state="some"]')) el.indeterminate = true;
    $('selected-count').textContent = selected.size;
  }

  function renderGroup(cat, g) {
    const ids = T.idsOfGroup(g);
    const key = `g:${cat.name}:${g.name}`;
    const open = !collapsed.has(key);
    return `<div class="node group">
      <div class="node-row">
        <button class="caret" data-collapse="${esc(key)}" aria-label="펼치기">${open ? '▾' : '▸'}</button>
        <label>${checkbox(T.state(ids, selected), `data-ids="${esc(ids.join('|'))}"`)} ${esc(g.name)} <span class="muted">(${g.items.length})</span></label>
      </div>
      ${open ? `<ul class="children">${g.items.map((c) => `<li class="leaf">
        <div class="node-row">
          <label>${checkbox(selected.has(c.id) ? 'all' : 'none', `data-ids="${esc(c.id)}"`)} ${esc(c.name)}</label>
          ${c.edited ? '<span class="tag">수정됨</span>' : ''}${c.manual ? '<span class="tag">직접 추가</span>' : ''}${c.fromToc ? '<span class="tag warn">목차 추정</span>' : ''}
          <button class="btn tiny" data-edit="${esc(c.id)}">편집</button>
        </div>
        <div class="reason">${esc(c.reason || '')}</div>
        ${c.evidence ? `<div class="where muted">${esc(c.evidence.article || '약관 제목')} · ${pageLabel(c.evidence)}</div>` : ''}
      </li>`).join('')}</ul>` : ''}
    </div>`;
  }

  $('tree').addEventListener('click', (e) => {
    const caret = e.target.closest('[data-collapse]');
    if (caret) {
      const k = caret.dataset.collapse;
      collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k);
      renderTree();
      return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) openEdit(findCov(edit.dataset.edit));
  });
  $('tree').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-ids]');
    if (!box) return;
    selected = T.toggle(box.dataset.ids.split('|').filter(Boolean), selected);
    saveSoon();
    renderTree();
    renderCards();
  });
  $('search').addEventListener('input', renderTree);
  $('select-all').addEventListener('click', () => {
    const tree = T.build(doc.categories, coverages(), $('search').value);
    selected = new Set([...selected, ...tree.flatMap(T.idsOfCategory)]);
    saveSoon(); renderTree(); renderCards();
  });
  $('select-none').addEventListener('click', () => { selected = new Set(); saveSoon(); renderTree(); renderCards(); });

  function renderExcluded() {
    const ex = coverages().filter((c) => c.excluded);
    $('excluded-box').hidden = !ex.length;
    $('excluded-count').textContent = `(${ex.length})`;
    $('excluded-list').innerHTML = ex.map((c) => `<li>${esc(c.name)} <span class="muted">${esc(c.group)}</span> <button class="btn tiny" data-restore="${esc(c.id)}">복원</button></li>`).join('');
  }
  $('excluded-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    setEdit(b.dataset.restore, { excluded: false });
  });

  // ───────────── 편집·추가 ─────────────
  const form = $('edit-form');
  form.category.innerHTML = '';

  function fillSelects() {
    form.category.innerHTML = doc.categories.map((c) => `<option>${esc(c)}</option>`).join('');
    $('group-list').innerHTML = [...new Set(coverages().map((c) => c.group))].map((g) => `<option value="${esc(g)}">`).join('');
    form.sectionId.innerHTML = doc.sections.filter((s) => s.kind !== '별표').map((s) => `<option value="${s.id}">${esc(s.title)} (PDF ${s.startPage}쪽~)</option>`).join('');
  }

  function openEdit(c) {
    editing = c || null;
    fillSelects();
    $('edit-title').textContent = c ? '담보 편집' : '담보 직접 추가';
    form.name.value = c ? c.name : '';
    form.category.value = c ? c.category : '기타';
    form.group.value = c ? c.group : '';
    form.excluded.checked = !!(c && c.excluded);
    // 새로 추가하는 담보와, 본문 약관이 정해지지 않은 담보(목차 추정 등)는 정의 약관을 고를 수 있습니다.
    form.querySelector('.section-field').hidden = !!(c && c.sectionId && !c.fromToc);
    if (c && c.sectionId) form.sectionId.value = c.sectionId;
    form.excluded.closest('label').hidden = !c;
    $('edit-reset').hidden = !(c && c.edited && !c.manual);
    $('edit-auto').textContent = c && c.auto ? `자동 분류 값: ${c.auto.category} › ${c.auto.group} › ${c.auto.name}` : '';
    $('edit-dialog').showModal();
  }

  $('add-coverage').addEventListener('click', () => openEdit(null));
  form.sectionId.addEventListener('change', () => {
    if (editing) return;
    const s = doc.sections.find((x) => x.id === form.sectionId.value);
    if (s && !form.group.value) form.group.value = s.title;
  });
  $('edit-reset').addEventListener('click', () => {
    if (!editing) return;
    delete review.edits[editing.id];
    $('edit-dialog').close();
    refresh();
  });
  $('edit-dialog').addEventListener('close', () => {
    if ($('edit-dialog').returnValue !== 'save') return;
    const v = { name: form.name.value.trim(), category: form.category.value, group: form.group.value.trim() || '분류 미지정' };
    if (!v.name) return;
    if (editing) {
      const patch = { ...v, excluded: form.excluded.checked };
      if (!form.querySelector('.section-field').hidden) {
        const sec = doc.sections.find((x) => x.id === form.sectionId.value);
        if (sec) Object.assign(patch, { sectionId: sec.id, sectionTitle: sec.title });
      }
      setEdit(editing.id, patch);
    } else {
      const s = doc.sections.find((x) => x.id === form.sectionId.value);
      const n = Math.max(0, ...review.added.map((a) => Number(a.id.slice(1)))) + 1;
      review.added.push({ id: `U${n}`, ...v, group: form.group.value.trim() || (s ? s.title : '직접 추가'), sectionId: s ? s.id : null, sectionTitle: s ? s.title : null });
      selected.add(`U${n}`);
      refresh();
    }
  });

  function setEdit(id, patch) {
    const c = findCov(id);
    const base = c.manual ? c : (c.auto || c);
    const e = { ...(review.edits[id] || {}), ...patch };
    // 자동 값과 같은 항목은 저장하지 않습니다.
    for (const k of ['name', 'category', 'group']) if (!c.manual && e[k] === base[k]) delete e[k];
    if (e.excluded === false) delete e.excluded;
    if (Object.keys(e).length) review.edits[id] = e; else delete review.edits[id];
    refresh();
  }

  // 수정 내역을 서버에 저장한 뒤 다시 읽어 화면을 맞춥니다(수정 반영은 서버 한 곳에서만 합니다).
  async function refresh() {
    await save();
    const fresh = await api.open(doc.meta.id);
    doc.coverages = fresh.coverages;
    renderAll();
  }

  // ───────────── 저장 ─────────────
  let timer = null;
  function saveSoon() { clearTimeout(timer); timer = setTimeout(save, 400); }
  async function save() {
    clearTimeout(timer);
    $('save-state').textContent = '저장 중…';
    let ok = false;
    try {
      ok = await api.save(doc.meta.id, {
        edits: review.edits, added: review.added, selected: [...selected],
        reviewStatus: review.reviewStatus, fieldEdits: review.fieldEdits, product: review.product,
      });
    } catch { ok = false; }
    $('save-state').textContent = ok ? api.savedLabel : '저장하지 못했습니다. 이 창을 닫으면 수정 내용이 사라집니다.';
  }

  // ───────────── 결과 카드 ─────────────
  const STATE_TEXT = { waiting: '분석 대기', running: '분석 중', done: '분석 완료', error: '분석 실패', stopped: '중지됨' };

  function cardStatus(c) {
    if (!api.supportsAnalysis) return '';
    const st = jobStates[c.id];
    const r = results[c.id];
    let label = '미분석', cls = '';
    if (st === 'waiting' || st === 'running') { label = STATE_TEXT[st]; cls = 'busy'; }
    else if (r && r.error) { label = '분석 실패'; cls = 'bad'; }
    else if (r && r.stale && r.stale.length) { label = '다시 분석 필요'; cls = 'warn'; }
    else if (r) { label = `분석 완료 · 검토 ${r.progress.reviewed}/${r.progress.total}`; cls = r.progress.reviewed === r.progress.total ? 'good' : ''; }
    const btn = running ? '' : `<button class="btn tiny" data-analyze="${esc(c.id)}" data-force="${r ? '1' : ''}">${r ? '다시 분석' : '분석'}</button>`;
    return `<span class="status ${cls}">${esc(label)}</span>${btn}`;
  }

  function cardBody(c) {
    if (!api.supportsAnalysis) {
      return `<div class="areas">
        <div class="area"><h4>A·B·D 영역</h4><p class="muted">담보 요약과 ECS 룰 입력 초안은 로컬 실행판에서 Claude API로 만듭니다.</p></div>
        <div class="area"><h4>C. 근거 페이지</h4><p class="muted">3단계에서 PDF 뷰어와 연결됩니다.</p></div>
      </div>`;
    }
    const r = results[c.id];
    if (r && r.A) return window.AnalysisView.render(r, (config && config.flagText) || {});
    if (r && r.error) return `<div class="note-box error">분석하지 못했습니다: ${esc(r.error)}</div>`;
    return `<p class="muted pending-note">아직 분석하지 않았습니다. 위의 [선택 담보 분석] 또는 이 카드의 [분석]을 누르면 A(보장 세부조건)·B(전산화 시 주의사항)·C(근거 페이지)·D(ECS 룰 입력 초안)가 채워집니다.</p>`;
  }

  function renderCards() {
    const order = T.build(doc.categories, coverages()).flatMap((cat) => cat.groups.flatMap((g) => g.items));
    const list = order.filter((c) => selected.has(c.id));
    $('selected-count').textContent = list.length;
    renderAnalysisBar(list);
    if (!list.length) { $('cards').innerHTML = '<p class="muted">왼쪽 트리에서 담보를 선택하면 담보마다 결과 카드가 만들어집니다.</p>'; return; }
    $('cards').innerHTML = list.map((c) => {
      const ev = c.evidence;
      return `<article class="card" data-card="${esc(c.id)}">
        <header><h3>${esc(c.name)}</h3><span class="chip">${esc(c.category)}</span><span class="chip light">${esc(c.group)}</span><span class="card-status">${cardStatus(c)}</span></header>
        <details class="basis"><summary>자동 분류 근거 · ${ev ? esc(`${ev.article || '약관 제목 줄'} · ${pageLabel(ev)}`) : '직접 추가한 담보'}</summary>
        <table class="kv">
          <tr><th>분류 근거</th><td>${esc(c.reason)}</td></tr>
          <tr><th>정의 약관</th><td>${esc(c.sectionTitle || '지정 없음')}</td></tr>
          ${ev ? `<tr><th>원문</th><td class="quote">“${esc(ev.quote)}”</td></tr>` : ''}
        </table></details>
        <div class="card-body">${cardBody(c)}</div>
      </article>`;
    }).join('');
  }

  // ───────────── 2단계: 분석 실행·코드마스터·상품 정보 ─────────────
  function renderAnalysisBar(list) {
    if (!api.supportsAnalysis) { $('analysis-bar').hidden = true; return; }
    $('analysis-bar').hidden = false;
    const ai = config && config.ai;
    const todo = list.filter((c) => !results[c.id] || results[c.id].error || (results[c.id].stale && results[c.id].stale.length));
    $('run-analysis').textContent = todo.length ? `선택 담보 분석 (${todo.length}건)` : '선택 담보 모두 분석됨';
    $('run-analysis').disabled = running || !todo.length || !(ai && ai.ready);
    $('stop-analysis').hidden = !running;
    $('ai-state').innerHTML = !ai ? '' : ai.ready
      ? `<span class="muted">Claude 분석 사용 가능${ai.mode === 'claude' ? ` · 모델 ${esc(ai.model)}` : ` · ${ai.mode === 'fake' ? '시험용 응답 모드' : '시험 모드'}`}. 분석 1건마다 Claude API를 한 번 호출합니다(이미 분석한 담보는 다시 부르지 않음).</span>`
      : `<span class="warn-text">${esc(ai.message)}</span>`;
  }

  async function loadConfig() {
    if (!api.supportsAnalysis) return;
    try { config = await api.config(); } catch (err) { config = null; }
    renderMaster();
  }

  async function loadResults() {
    if (!api.supportsAnalysis || !doc) return;
    try {
      const res = await api.results(doc.meta.id);
      results = res.results || {};
      jobStates = res.states || {};
      if (res.running && !running) watch();
    } catch { /* 결과 없음 */ }
    renderCards();
  }

  function watch() {
    running = true;
    if (stopWatch) stopWatch();
    stopWatch = api.watchAnalysis(doc.meta.id, (ev) => {
      if (ev.states) jobStates = ev.states;
      if (ev.message) $('analysis-progress').textContent = ev.total ? `${ev.message} (${ev.done}/${ev.total})` : ev.message;
      if (ev.stage === 'coverage' && jobStates[ev.coverageId] !== 'running') { loadResults(); return; }
      if (ev.stage === 'done' || ev.stage === 'idle') { running = false; stopWatch = null; loadResults(); return; }
      renderCards();
    });
  }

  async function runAnalysis(ids, force) {
    if (!ids.length) return;
    try {
      const res = await api.runAnalysis(doc.meta.id, ids, force);
      $('analysis-progress').textContent = res.total ? `${res.total}건 분석을 시작했습니다.${res.skipped ? ` (이미 분석한 ${res.skipped}건은 건너뜀)` : ''}` : '이미 모두 분석되어 있습니다.';
      watch();
    } catch (err) {
      $('analysis-progress').textContent = err.message;
    }
  }

  $('run-analysis').addEventListener('click', () => {
    const order = T.build(doc.categories, coverages()).flatMap((cat) => cat.groups.flatMap((g) => g.items));
    runAnalysis(order.filter((c) => selected.has(c.id)).map((c) => c.id), false);
  });
  $('stop-analysis').addEventListener('click', () => api.stopAnalysis(doc.meta.id).catch(() => {}));

  $('cards').addEventListener('click', (e) => {
    const b = e.target.closest('[data-analyze]');
    if (b) runAnalysis([b.dataset.analyze], !!b.dataset.force);
  });
  $('cards').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-review]');
    if (box) {
      if (box.checked) review.reviewStatus[box.dataset.review] = 'done'; else delete review.reviewStatus[box.dataset.review];
      saveSoon();
      return;
    }
    const inp = e.target.closest('input[data-edit]');
    if (inp) {
      const k = inp.dataset.edit;
      const card = inp.closest('tr');
      const code = card.querySelector('[data-part="code"]');
      const name = card.querySelector('[data-part="name"]');
      review.fieldEdits[k] = { ...(code ? { code: code.value.trim() } : {}), name: name.value.trim() };
      saveSoon();
    }
  });
  // 검토 상태와 직접 수정은 저장 뒤 결과를 다시 받아 진행률·표시를 맞춥니다.
  $('cards').addEventListener('change', () => setTimeout(() => { if (!running) loadResults(); }, 900));

  function renderProduct() {
    if (!api.supportsAnalysis) { $('product-box').hidden = true; return; }
    $('product-box').hidden = false;
    for (const k of ['productCode', 'productName', 'saleDate']) $(`p-${k}`).value = (review.product || {})[k] || '';
  }
  for (const k of ['productCode', 'productName', 'saleDate']) {
    $(`p-${k}`).addEventListener('change', (e) => { review.product = { ...review.product, [k]: e.target.value.trim() }; saveSoon(); setTimeout(loadResults, 900); });
  }

  function renderMaster() {
    if (!api.supportsAnalysis || !config) { $('codemaster-box').hidden = true; return; }
    const m = config.codemaster;
    $('codemaster-box').hidden = false;
    $('cm-label').innerHTML = m.provisional
      ? '<span class="pill warn">임시 코드마스터 사용 중</span> 실제 ECS 코드가 아닙니다'
      : `<span class="pill accent">업로드한 코드마스터</span> ${esc(m.source)}${m.provisionalCount ? ` · 임시(TMP-) 코드 ${m.provisionalCount}개 남음` : ''}`;
    $('cm-detail').innerHTML = `<p class="muted">${m.provisional
      ? '실제 코드마스터를 받기 전까지 앱이 만든 임시 코드표를 씁니다. "화면캡처" 코드는 이전에 받은 ECS 화면 캡처에서 확인한 값이고, TMP-로 시작하는 코드는 지어낸 값입니다. 임시 코드를 쓴 칸에는 "임시 코드" 표시가 붙습니다.'
      : '이 코드마스터에 있는 코드만 제안합니다. 없는 코드는 비우고 "코드 확인 필요"로 표시합니다.'}</p>
      <p class="muted">${Object.entries(m.counts).map(([k, n]) => `${esc(k)} ${n}`).join(' · ')}</p>
      ${(m.warnings || []).length ? `<ul class="warn-text">${m.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
    $('cm-download').href = api.masterDownloadUrl;
    $('cm-reset').hidden = m.provisional;
  }
  $('cm-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    $('cm-status').textContent = '코드마스터를 읽는 중입니다.';
    try { await api.uploadMaster(f); $('cm-status').textContent = '코드마스터를 바꿨습니다. 이미 분석한 담보는 새 코드마스터 기준으로 코드를 다시 검사했습니다.'; }
    catch (err) { $('cm-status').textContent = err.message; }
    await loadConfig(); loadResults();
  });
  $('cm-reset').addEventListener('click', async () => {
    try { await api.resetMaster(); $('cm-status').textContent = '임시 코드마스터로 되돌렸습니다.'; } catch (err) { $('cm-status').textContent = err.message; }
    await loadConfig(); loadResults();
  });

  loadConfig();

  $('storage-note').textContent = api.storageNote;
  // 처음 연 화면이 비어 있지 않도록, 저장된 약관이 없으면 시험용 가상 약관을 자동으로 엽니다.
  loadRecent().then((list) => {
    const done = list.filter((d) => d.status === 'done');
    if (done.length) openDoc(done[0].id);
    else if (api.autoOpenSample) openSample();
  });
})();
