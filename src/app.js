// 화면 제어: 약관(PDF·텍스트) 입력 → 구간 분리·담보 선택 → AI 분석(또는 규칙 엔진) →
// 룰 테이블·수기·근거 없음 표시, 행 클릭 시 원문 발췌, 정답지 비교, 엑셀 저장.
(function () {
  'use strict';
  const S = window.EcsSchema;
  const E = window.EcsEngine;
  const A = window.EcsAi;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inArtifact = !!(window.claude && typeof window.claude.use === 'function');
  const MASTER_KEY = 'ecs-code-master';
  const state = { result: null, compare: null, selected: null, sections: [], master: loadMaster(), meta: null, ctl: null };

  function setStatus(msg) { $('status').textContent = msg; }

  // ───────── 코드표 ─────────
  // 코드표는 보는 사람의 브라우저에만 저장합니다(다른 사람·서버로 가지 않습니다).
  function loadMaster() {
    try {
      const raw = localStorage.getItem(MASTER_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* 저장소를 쓸 수 없으면 기본 코드표를 씁니다. */ }
    return A.defaultMaster();
  }

  function renderMaster() {
    const m = state.master;
    $('masterInfo').textContent = `${m.source} · 사인그룹 ${m.signGroups.length} · 급부 ${m.benefits.length} · 변수 ${m.variables.length}`;
  }

  async function uploadMaster(file) {
    const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheets = Object.fromEntries(book.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(book.Sheets[n], { defval: '' })]));
    const m = A.parseCodeMaster(sheets);
    m.source = `코드표(${file.name})`;
    state.master = m;
    try { localStorage.setItem(MASTER_KEY, JSON.stringify(m)); } catch (e) { /* 저장 실패 시 이번 화면에서만 씁니다. */ }
    renderMaster();
    setStatus(`${file.name} 을(를) 코드표로 적용했습니다.${m.warnings.length ? ` 확인 필요: ${m.warnings.join(' ')}` : ''}`);
  }

  async function downloadTemplate() {
    const book = XLSX.utils.book_new();
    for (const [name, aoa] of Object.entries(A.codeMasterTemplate())) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), name);
    await saveBook(book, 'ECS_코드표_양식.xlsx');
  }

  // ───────── 약관 구간 ─────────
  function resplit() {
    state.sections = A.splitSections($('terms').value);
    selectByCoverage();
  }

  function selectedIds() {
    return [...document.querySelectorAll('#sections input:checked')].map((x) => Number(x.dataset.id));
  }

  function renderSections(checked) {
    const box = $('sections');
    if (!state.sections.length) { box.innerHTML = '<div class="empty">구간을 찾지 못했습니다. 조문(제N조) 형식인지 확인하세요.</div>'; return; }
    const size = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)}만자` : `${n.toLocaleString()}자`);
    box.innerHTML = state.sections.map((s) => `<label class="sec"><input type="checkbox" data-id="${s.id}"${checked.includes(s.id) ? ' checked' : ''}>
      <span class="kind">${esc(s.kind)}</span><span class="t">${esc(s.title)}</span><small>${s.kind === '별표' ? '' : `조문 ${s.articles.length} · `}${size(s.text.length)}</small></label>`).join('');
  }

  function selectByCoverage() {
    const ids = A.selectSections(state.sections, $('coverage').value);
    renderSections(ids);
    return ids;
  }

  // ───────── 분석 실행 ─────────
  function show(result, meta, message) {
    state.result = result;
    state.meta = meta;
    state.compare = null;
    state.selected = null;
    renderRules();
    renderList('manual', MANUAL_COLS, '심사자 수기 대상이 없습니다.');
    renderList('missing', MISSING_COLS, '근거 없음 항목이 없습니다. 모든 행에 약관 조항이 연결되었습니다.');
    $('view-compare').innerHTML = '<div class="empty">[정답지와 비교]로 정답지 엑셀을 올리면 결과가 여기에 표시됩니다.</div>';
    renderSummary();
    $('btnExcel').disabled = false;
    setStatus(message);
    showTab('rules');
  }

  function textOfSelection() {
    const ids = selectedIds();
    const chosen = state.sections.filter((s) => ids.includes(s.id));
    return chosen.length ? chosen.map((s) => `${s.title}\n${s.text}`).join('\n\n') : $('terms').value;
  }

  function runRules() {
    const text = textOfSelection();
    if (!text.trim()) { setStatus('약관 텍스트가 비어 있습니다.'); return; }
    const r = E.generateRules(text);
    show(r, { mode: '규칙 엔진(사망)', coverage: '사망', master: '기본(더미) 코드표' },
      `규칙 엔진: 조문 ${r.articles.length}개, 사망 급부 ${r.benefits.length}개를 인식해 룰 ${r.rows.length}행을 만들었습니다.`);
  }

  const SAMPLE_ERRORS = {
    not_granted: 'Claude 사용을 허용하지 않아 분석할 수 없습니다.',
    sampling_disabled: '이 계정에서는 Claude 분석을 쓸 수 없습니다.',
    rate_limited: 'Claude 사용 한도에 걸렸습니다. 잠시 후 다시 시도하세요.',
    session_expired: '로그인이 만료되었습니다. 다시 로그인한 뒤 시도하세요.',
    prompt_too_large: '분석 대상이 너무 큽니다. 담보를 좁혀 구간을 줄이세요.',
    invalid_json: 'Claude 응답을 표로 읽지 못했습니다. 구간을 줄여 다시 시도하세요.',
    refused: 'Claude가 이 요청에 답하지 않았습니다.',
  };
  const STOP_CODES = new Set(['not_granted', 'sampling_disabled', 'rate_limited', 'session_expired', 'not_declared', 'capability_disabled', 'capability_removed']);

  async function runAi() {
    if (!inArtifact) { setStatus('AI 분석은 claude.ai 아티팩트에서 열었을 때만 동작합니다. 로컬에서는 [규칙 엔진(사망)]을 쓰세요.'); return; }
    const sample = await window.claude.use('sample');
    if (!sample) { setStatus('이 화면에서는 Claude 분석을 쓸 수 없습니다.'); return; }
    const coverage = $('coverage').value.trim() || '전체';
    const calls = A.planCalls(state.sections, selectedIds(), coverage, state.master);
    if (!calls.length) { setStatus('분석할 약관 구간을 하나 이상 고르세요(별표만으로는 분석할 수 없습니다).'); return; }

    const ctl = new AbortController();
    state.ctl = ctl;
    $('btnAi').disabled = true;
    $('btnStop').hidden = false;
    const parts = [];
    let stopped = '';
    for (const [i, call] of calls.entries()) {
      const step = `${i + 1}/${calls.length} ${call.label}`;
      setStatus(`${step}: Claude가 약관을 읽고 있습니다. 구간당 1~3분 걸릴 수 있습니다.`);
      try {
        const json = await sample.json(call.prompt, {
          modelTier: $('tier').value, signal: ctl.signal,
          onText: ({ text }) => setStatus(`${step}: 결과를 받는 중입니다(${text.length.toLocaleString()}자).`),
        });
        parts.push(A.verifyAiResult(json, { sourceText: call.text, sectionTitle: call.sectionTitle, master: state.master }));
      } catch (e) {
        const code = (e && e.code) || 'upstream_error';
        if (code === 'cancelled') { stopped = '중지했습니다.'; break; }
        parts.push({ rows: [], manual: [], missing: [{ subject: call.label, ref: call.sectionTitle, reason: `분석 실패: ${SAMPLE_ERRORS[code] || `오류(${code})`}` }] });
        if (STOP_CODES.has(code)) { stopped = SAMPLE_ERRORS[code] || `분석을 멈췄습니다(${code}).`; break; }
      }
    }
    state.ctl = null;
    $('btnAi').disabled = false;
    $('btnStop').hidden = true;
    const r = A.finalize(parts, state.master);
    show(r, { mode: `AI 분석(${$('tier').selectedOptions[0].text})`, coverage, master: state.master.source, sections: calls.map((c) => c.label).join(', ') },
      `${stopped ? `${stopped} ` : ''}AI 분석: ${parts.length}/${calls.length}개 구간에서 룰 ${r.rows.length}행, 심사자 수기 ${r.manual.length}건, 근거 없음 ${r.missing.length}건입니다. 모든 행은 원문 인용과 코드표로 검증했습니다.`);
  }

  // ───────── 결과 표시 ─────────
  function showTab(view) {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.view === view);
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('on', v.id === `view-${view}`);
    $('detail').hidden = view !== 'rules' || state.selected == null;
  }

  function renderSummary() {
    const { rows, manual, missing } = state.result;
    const count = (lv) => rows.filter((r) => r.flags.some((f) => f.level === lv)).length;
    const byCat = (c) => rows.filter((r) => r.category === c).length;
    const chips = [
      state.meta.mode, `룰 ${rows.length}행`, `정상 ${byCat('정상')}`, `감액 ${byCat('감액')}`, `면책 ${byCat('면책')}`,
      `🔴 ${count('red')}행`, `🟡 ${count('yellow')}행`, `⚠ ${count('warn')}행`,
      `심사자 수기 ${manual.length}건`, `근거 없음 ${missing.length}건`,
    ];
    if (state.compare) {
      const c = state.compare.summary;
      chips.push(`비교: 일치 ${c.일치} · 불일치 ${c.불일치} · 정답지에만 ${c.정답지에만} · 생성에만 ${c.생성에만}`);
    }
    $('summary').innerHTML = chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('');
  }

  // 화면은 검토 순서(산식·표시 우선)로 보여 주고, 엑셀은 S.RULE_COLUMNS 의 ECS 순서를 따릅니다.
  const TABLE_COLS = ['no', 'category', 'claim', 'benefit', 'accident', 'signGroupCode', 'calcCondition', 'formula', 'status', 'flagText', 'citations', 'benefitCode', 'riskBenefit', 'signGroup', 'calcTarget', 'testText'];
  const label = (k) => S.RULE_COLUMNS.find((c) => c.key === k).label;

  function renderRules() {
    const { rows } = state.result;
    if (!rows.length) { $('view-rules').innerHTML = '<div class="empty">생성된 룰 행이 없습니다. [심사자 수기]·[근거 없음] 탭을 확인하세요.</div>'; return; }
    const cmp = state.compare ? new Map(state.compare.items.filter((i) => i.row).map((i) => [i.row.no, i])) : null;
    const body = rows.map((r) => {
      const cells = TABLE_COLS.map((k) => {
        const v = r[k];
        if (k === 'category') return `<td><span class="badge b-${esc(v)}">${esc(v)}</span></td>`;
        if (k === 'status') return `<td><span class="badge b-${esc(v === '소멸' ? '소멸' : v === '확인필요' ? '확인필요' : '정상')}">${esc(v)}</span> ${esc(r.statusCode)}</td>`;
        if (k === 'formula' || k === 'calcCondition') return `<td class="mono">${esc(v)}</td>`;
        if (k === 'flagText' || k === 'testText') return `<td class="wrap">${esc(v)}</td>`;
        if (k === 'citations') return `<td class="wrap">${esc(String(v).replace(/ \/ /g, '\n'))}</td>`;
        return `<td>${esc(v)}</td>`;
      }).join('');
      const c = cmp && cmp.get(r.no);
      const mark = c ? `<td>${c.result === '일치' ? '✅' : c.result === '불일치' ? '❌' : '➕'} ${esc(c.result)}</td>` : '';
      return `<tr class="rule cat-${esc(r.category)}${state.selected === r.no ? ' sel' : ''}" data-no="${r.no}" tabindex="0">${cells}${mark}</tr>`;
    }).join('');
    $('view-rules').innerHTML = `<table><thead><tr>${TABLE_COLS.map((k) => `<th>${esc(label(k))}</th>`).join('')}${cmp ? '<th>정답지 비교</th>' : ''}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function renderDetail() {
    const r = state.result.rows.find((x) => x.no === state.selected);
    const box = $('detail');
    if (!r) { box.hidden = true; return; }
    const ev = r.evidence.map((e) => `<div><span class="ref">${esc(e.ref)}</span><blockquote>${esc(e.text)}</blockquote></div>`).join('');
    const flags = r.flags.length ? `<h3>주의·테스트</h3><ul>${r.flags.map((f) => `<li>${{ red: '🔴', yellow: '🟡', warn: '⚠' }[f.level]} ${esc(f.reason)}${f.test ? `<br><small>테스트: ${esc(f.test)}</small>` : ''}</li>`).join('')}</ul>` : '';
    box.innerHTML = `<h3>행 ${r.no} · ${esc(r.benefit)} · ${esc(r.accident)} · ${esc(r.signGroupCode)} · <code>${esc(r.formula)}</code></h3>${ev}${flags}`;
    box.hidden = false;
  }

  const MANUAL_COLS = [['ref', '약관 근거조항'], ['subject', '사유'], ['reason', '수기 처리 이유'], ['text', '원문 발췌']];
  const MISSING_COLS = [['subject', '대상'], ['ref', '확인한 조항'], ['reason', '근거 없음 사유']];

  function renderList(view, cols, emptyMsg) {
    const items = state.result[view];
    $(`view-${view}`).innerHTML = items.length
      ? `<table><thead><tr>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>${
        items.map((it) => `<tr>${cols.map(([k]) => `<td class="wrap">${esc(it[k])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : `<div class="empty">${esc(emptyMsg)}</div>`;
  }

  // ───────── 엑셀 ─────────
  async function saveBook(book, filename) {
    if (!inArtifact) { XLSX.writeFile(book, filename); return; }
    // claude.ai 아티팩트 안에서는 페이지가 직접 내려받을 수 없어 downloads 기능으로 저장을 요청합니다.
    const downloads = await window.claude.use('downloads');
    if (!downloads) { setStatus('이 화면에서는 파일 저장을 쓸 수 없습니다.'); return; }
    try {
      await downloads.save({ filename, data: XLSX.write(book, { type: 'array', bookType: 'xlsx' }) });
      setStatus(`${filename} 을(를) 저장했습니다.`);
    } catch (err) {
      setStatus(err && err.code === 'declined' ? '저장을 취소했습니다.' : `저장하지 못했습니다(${(err && err.code) || '알 수 없는 오류'}).`);
    }
  }

  async function downloadExcel() {
    const { rows, manual, missing } = state.result;
    const book = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([S.RULE_COLUMNS.map((c) => c.label), ...rows.map((r) => S.RULE_COLUMNS.map((c) => r[c.key] == null ? '' : r[c.key]))]);
    ws['!cols'] = S.RULE_COLUMNS.map((c) => ({ wch: ['excerptText', 'flagText', 'testText'].includes(c.key) ? 60 : ['formula', 'calcCondition', 'citations'].includes(c.key) ? 36 : 14 }));
    XLSX.utils.book_append_sheet(book, ws, '룰테이블');
    const sheetOf = (items, cols) => XLSX.utils.aoa_to_sheet([cols.map(([, l]) => l), ...items.map((it) => cols.map(([k]) => it[k] || ''))]);
    XLSX.utils.book_append_sheet(book, sheetOf(manual, MANUAL_COLS), '심사자수기');
    XLSX.utils.book_append_sheet(book, sheetOf(missing, MISSING_COLS), '근거없음');
    if (state.compare) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(compareAoa()), '정답지비교');
    const m = state.meta;
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['항목', '값'], ['작성일시', new Date().toLocaleString('ko-KR')], ['분석 방식', m.mode], ['담보', m.coverage],
      ['분석 구간', m.sections || ''], ['코드표', m.master], ['주의', 'AI 분석 결과는 원문 인용과 코드표로 검증했으나, ECS 반영 전 심사자 확인이 필요합니다.'],
    ]), '분석정보');
    await saveBook(book, `ECS_룰테이블_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // ───────── 정답지 비교 ─────────
  const CMP_COLS = ['결과', '차이 항목', '정답지 행', '생성 행번호', '구보장급부명', '사고유형', '사인그룹코드', '계산식결정조건', '상세계산식(정답지)', '상세계산식(생성)', '계약상태처리(정답지)', '계약상태처리(생성)', '주의·테스트표시(생성)'];

  function compareRecord(it) {
    const a = it.answer || {}, r = it.row || {};
    return [it.result, it.diffs.join(', '), it.answerLine || '', r.no || '',
      a.구보장급부명 || r.benefit, a.사고유형 || r.accident, a.사인그룹코드 || r.signGroupCode, a.계산식결정조건 || r.calcCondition,
      a.상세계산식 || '', r.formula || '', a.계약상태처리 || '', r.status || '', r.flagText || ''];
  }

  function compareAoa() { return [CMP_COLS, ...state.compare.items.map(compareRecord)]; }

  function renderCompare() {
    const order = { 불일치: 0, 정답지에만: 1, 생성에만: 2, 일치: 3 };
    const items = [...state.compare.items].sort((x, y) => order[x.result] - order[y.result]);
    const diffCol = { 8: '상세계산식', 9: '상세계산식', 10: '계약상태처리', 11: '계약상태처리' };
    const body = items.map((it) => `<tr class="cmp-${esc(it.result)}">${compareRecord(it).map((v, i) => {
      const cls = [i === 12 ? 'wrap' : '', i >= 7 && i <= 9 ? 'mono' : '', diffCol[i] && it.diffs.includes(diffCol[i]) ? 'diff' : ''].filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}>${esc(v)}</td>`;
    }).join('')}</tr>`).join('');
    $('view-compare').innerHTML = `<table><thead><tr>${CMP_COLS.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function applyCompare(name, records) {
    const cmp = E.compareWithAnswerKey(state.result.rows, records);
    if (cmp.error) { setStatus(`${name}: ${cmp.error}`); return; }
    state.compare = cmp;
    renderRules();
    renderCompare();
    renderSummary();
    const s = cmp.summary;
    setStatus(`${name} 비교 결과: 일치 ${s.일치}, 불일치 ${s.불일치}, 정답지에만 ${s.정답지에만}, 생성에만 ${s.생성에만}입니다.`);
    showTab('compare');
  }

  // 함께 게시된 samples/answer_key.json(answer_key.xlsx 와 같은 내용)으로 비교합니다. file:// 로 연 경우에는 브라우저가 읽기를 막습니다.
  async function compareSample() {
    try {
      const res = await fetch('samples/answer_key.json');
      if (!res.ok) throw new Error(res.status);
      applyCompare('샘플 정답지', await res.json());
    } catch (e) {
      setStatus('샘플 정답지를 읽지 못했습니다. [정답지와 비교]로 samples/answer_key.xlsx 파일을 직접 올리세요.');
    }
  }

  // ───────── 파일 읽기 ─────────
  // .txt: UTF-8 로 읽고, 깨진 문자가 있으면 EUC-KR 로 다시 읽습니다. .pdf: pdf.js 로 텍스트를 뽑습니다.
  async function readTermsFile(file) {
    const buf = await file.arrayBuffer();
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      const { pages, text } = await window.EcsPdf.extractPdfText(buf, (n, total) => setStatus(`${file.name}: ${n}/${total}쪽 읽는 중입니다.`));
      if (text.replace(/\s/g, '').length < pages.length * 20) {
        setStatus(`${file.name}: 글자를 거의 찾지 못했습니다. 스캔 이미지 PDF는 글자 인식(OCR) 후 텍스트 PDF로 올려야 합니다.`);
      }
      return { text, note: `${pages.length}쪽` };
    }
    const utf8 = new TextDecoder('utf-8').decode(buf);
    if (!utf8.includes('\uFFFD')) return { text: utf8, note: '텍스트' };
    try { return { text: new TextDecoder('euc-kr').decode(buf), note: '텍스트(EUC-KR)' }; } catch (e) { return { text: utf8, note: '텍스트' }; }
  }

  function loadText(text) {
    $('terms').value = text;
    resplit();
  }

  // ───────── 이벤트 ─────────
  let resplitTimer;
  $('terms').addEventListener('input', () => { clearTimeout(resplitTimer); resplitTimer = setTimeout(resplit, 400); });
  $('btnSample').addEventListener('click', () => {
    loadText(`${window.DUMMY_TERMS}\n${window.DUMMY_RIDERS}`);
    setStatus('샘플(더미) 약관을 불러왔습니다. 담보를 입력하고 [대상 찾기] 후 [AI 분석]을 누르세요.');
  });
  $('fileTerms').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const { text, note } = await readTermsFile(f);
      loadText(text);
      if (!/OCR/.test($('status').textContent)) setStatus(`${f.name}(${note})에서 구간 ${state.sections.length}개를 찾았습니다. 담보를 입력하고 [대상 찾기]를 누르세요.`);
    } catch (err) {
      setStatus(`${f.name} 을(를) 읽지 못했습니다: ${err && err.message ? err.message : err}`);
    }
  });
  $('btnFind').addEventListener('click', () => {
    const ids = selectByCoverage();
    setStatus(ids.length ? `담보 "${$('coverage').value}"에 해당하는 구간 ${ids.length}개를 골랐습니다. 목록에서 더하거나 뺄 수 있습니다.` : `담보 "${$('coverage').value}"에 해당하는 구간을 찾지 못했습니다. 목록에서 직접 고르세요.`);
  });
  $('coverage').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnFind').click(); });
  $('fileMaster').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await uploadMaster(f).catch((err) => setStatus(`코드표를 읽지 못했습니다: ${err.message || err}`));
  });
  $('btnTemplate').addEventListener('click', downloadTemplate);
  $('btnAi').addEventListener('click', runAi);
  $('btnStop').addEventListener('click', () => state.ctl && state.ctl.abort());
  $('btnRun').addEventListener('click', runRules);
  $('btnExcel').addEventListener('click', downloadExcel);
  $('btnSampleKey').addEventListener('click', compareSample);
  $('fileAnswer').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const book = XLSX.read(await f.arrayBuffer(), { type: 'array' });
    applyCompare(f.name, XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { defval: '' }));
  });
  $('tabs').addEventListener('click', (e) => { if (e.target.dataset.view) showTab(e.target.dataset.view); });
  const pick = (tr) => {
    state.selected = Number(tr.dataset.no);
    for (const x of document.querySelectorAll('tr.rule')) x.classList.toggle('sel', x === tr);
    renderDetail();
  };
  $('view-rules').addEventListener('click', (e) => { const tr = e.target.closest('tr.rule'); if (tr) pick(tr); });
  $('view-rules').addEventListener('keydown', (e) => { const tr = e.target.closest('tr.rule'); if (tr && e.key === 'Enter') pick(tr); });

  // 첫 화면: 샘플 약관을 불러와 규칙 엔진 결과를 보여 줍니다. AI 분석은 사용자가 버튼을 눌러야 시작합니다.
  renderMaster();
  loadText(`${window.DUMMY_TERMS}\n${window.DUMMY_RIDERS}`);
  runRules();
  setStatus(inArtifact
    ? '샘플(더미) 약관의 규칙 엔진 결과입니다. PDF를 열고 담보를 입력한 뒤 [AI 분석]을 누르세요.'
    : '샘플(더미) 약관의 규칙 엔진 결과입니다. AI 분석은 claude.ai 아티팩트에서 열었을 때 동작합니다.');

  window.EcsApp = { state, runRules, runAi };
})();
