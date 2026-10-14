// 화면: PDF 업로드 → 진행률 → 담보 분류 트리(중복 선택·편집) → 선택 담보 결과 카드
(function () {
  'use strict';
  const T = window.CoverageTree;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let doc = null;          // GET /api/docs/:id 응답
  let review = {};         // { edits, added, selected }
  let selected = new Set();
  let collapsed = new Set();
  let editing = null;      // 편집 중인 담보(새로 추가하면 null)

  // ───────────── 업로드와 진행률 ─────────────
  $('file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) upload(file);
  });
  $('recent').addEventListener('change', (e) => { if (e.target.value) openDoc(e.target.value); });

  function showProgress(ratio, msg) {
    $('progress').hidden = false;
    $('bar-fill').style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    $('progress-msg').textContent = msg;
  }

  function upload(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return alert('PDF 파일만 올릴 수 있습니다.');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) showProgress(e.loaded / e.total * 0.1, `PDF를 올리는 중입니다. (${Math.round(e.loaded / e.total * 100)}%)`); };
    xhr.onload = () => {
      let res = {};
      try { res = JSON.parse(xhr.responseText); } catch { /* 빈 응답 */ }
      if (xhr.status !== 200) { showProgress(0, res.error || '업로드에 실패했습니다.'); return; }
      if (res.cached) { showProgress(1, '이미 분석한 PDF입니다. 저장된 결과를 엽니다.'); openDoc(res.id); return; }
      follow(res.id);
    };
    xhr.onerror = () => showProgress(0, '업로드 중 연결이 끊겼습니다. 앱이 실행 중인지 확인해 주십시오.');
    xhr.send(file);
  }

  function follow(id) {
    const es = new EventSource(`/api/docs/${id}/events`);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.stage === 'extract') showProgress(0.1 + (ev.total ? ev.done / ev.total : 0) * 0.8, ev.message);
      else if (ev.stage === 'structure') showProgress(0.9 + (ev.done / ev.total) * 0.1, ev.message);
      else if (ev.stage === 'done') { es.close(); showProgress(1, ev.message); openDoc(id); }
      else if (ev.stage === 'error') { es.close(); showProgress(0, ev.message); }
    };
    es.onerror = () => { es.close(); };
  }

  async function loadRecent() {
    const list = await (await fetch('/api/docs')).json();
    $('recent').innerHTML = '<option value="">최근 분석한 약관 열기</option>' + list.filter((d) => d.status === 'done')
      .map((d) => `<option value="${d.id}">${esc(d.lastFileName || d.fileName)} (${d.numPages}쪽, 담보 ${d.coverageCount}개)</option>`).join('');
  }

  async function openDoc(id) {
    const res = await fetch(`/api/docs/${id}`);
    if (!res.ok) { showProgress(0, '분석 결과를 열지 못했습니다.'); return; }
    doc = await res.json();
    review = { edits: doc.review.edits || {}, added: doc.review.added || [], selected: doc.review.selected || [] };
    selected = new Set(review.selected);
    $('empty').hidden = true;
    $('workspace').hidden = false;
    setTimeout(() => { $('progress').hidden = true; }, 800);
    renderMeta();
    renderAll();
    loadRecent();
  }

  // ───────────── 문서 요약·경고 ─────────────
  function renderMeta() {
    const m = doc.meta;
    $('summary').hidden = false;
    $('summary').innerHTML = `<strong>${esc(m.lastFileName || m.fileName)}</strong>
      <span>전체 ${m.numPages}쪽</span><span>약관 ${m.sectionCount}개</span><span>별표 ${m.appendixCount}개</span>
      <span>자동 추출 담보 ${m.coverageCount}개</span><span>인쇄 쪽번호 인식 ${m.printedPagesFound}쪽</span>`;
    $('warnings').innerHTML = (m.warnings || []).map((w) => {
      let detail = '';
      if (w.pages) detail = `<div class="muted">해당 PDF 쪽: ${w.pages.slice(0, 40).join(', ')}${w.pages.length > 40 ? ' …' : ''}</div>`;
      if (w.items) detail = `<ul>${w.items.slice(0, 20).map((it) => `<li>${esc(it.title)}${it.printed ? ` (목차 ${it.printed}쪽)` : ''}${it.pdfPage ? ` (PDF ${it.pdfPage}쪽)` : ''}</li>`).join('')}</ul>`;
      return `<div class="warning ${w.type === 'ocr' ? 'strong' : ''}"><strong>${w.type === 'ocr' ? 'OCR 필요' : '확인 필요'}</strong> ${esc(w.message)}${detail}</div>`;
    }).join('');
  }

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
          ${c.edited ? '<span class="tag">수정됨</span>' : ''}${c.manual ? '<span class="tag">직접 추가</span>' : ''}
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
    form.querySelector('.section-field').hidden = !!c;
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
      setEdit(editing.id, { ...v, excluded: form.excluded.checked });
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
    const res = await fetch(`/api/docs/${doc.meta.id}`);
    const fresh = await res.json();
    doc.coverages = fresh.coverages;
    renderAll();
  }

  // ───────────── 저장 ─────────────
  let timer = null;
  function saveSoon() { clearTimeout(timer); timer = setTimeout(save, 400); }
  async function save() {
    clearTimeout(timer);
    $('save-state').textContent = '저장 중…';
    const res = await fetch(`/api/docs/${doc.meta.id}/review`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits: review.edits, added: review.added, selected: [...selected] }),
    });
    $('save-state').textContent = res.ok ? '이 PC에 저장됨' : '저장 실패';
  }

  // ───────────── 결과 카드 ─────────────
  function renderCards() {
    const order = T.build(doc.categories, coverages()).flatMap((cat) => cat.groups.flatMap((g) => g.items));
    const list = order.filter((c) => selected.has(c.id));
    $('selected-count').textContent = list.length;
    if (!list.length) { $('cards').innerHTML = '<p class="muted">왼쪽 트리에서 담보를 선택하면 담보마다 결과 카드가 만들어집니다.</p>'; return; }
    $('cards').innerHTML = list.map((c) => {
      const ev = c.evidence;
      return `<article class="card">
        <header><h3>${esc(c.name)}</h3><span class="chip">${esc(c.category)}</span><span class="chip light">${esc(c.group)}</span></header>
        <table class="kv">
          <tr><th>분류 근거</th><td>${esc(c.reason)}</td></tr>
          <tr><th>정의 약관</th><td>${esc(c.sectionTitle || '사용자 지정 없음')}</td></tr>
          ${ev ? `<tr><th>근거 조문</th><td>${esc(ev.article || '약관 제목 줄')}</td></tr>
          <tr><th>근거 위치</th><td>${pageLabel(ev)}</td></tr>
          <tr><th>원문</th><td class="quote">“${esc(ev.quote)}”</td></tr>` : '<tr><th>근거</th><td>직접 추가한 담보이므로 자동 근거가 없습니다.</td></tr>'}
        </table>
        <div class="areas">
          <div class="area"><h4>A. 보장 세부조건</h4><p class="muted">2단계에서 채워집니다.</p></div>
          <div class="area"><h4>B. 전산화 시 주의사항</h4><p class="muted">2단계에서 채워집니다.</p></div>
          <div class="area"><h4>C. 근거 페이지</h4><p class="muted">3단계에서 PDF 뷰어와 연결됩니다.</p></div>
          <div class="area"><h4>D. ECS 룰 입력 초안</h4><p class="muted">2단계에서 채워집니다.</p></div>
        </div>
      </article>`;
    }).join('');
  }

  loadRecent();
})();
