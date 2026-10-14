// 화면 제어: 약관 입력 → 변환 → 룰 테이블·수기·근거 없음 표시, 행 클릭 시 원문 발췌, 엑셀 다운로드.
(function () {
  'use strict';
  const S = window.EcsSchema;
  const E = window.EcsEngine;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { result: null, compare: null, selected: null };

  function setStatus(msg) { $('status').textContent = msg; }

  function showTab(view) {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.view === view);
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('on', v.id === `view-${view}`);
    $('detail').hidden = view !== 'rules' || state.selected == null;
  }

  function run() {
    const text = $('terms').value;
    if (!text.trim()) { setStatus('약관 텍스트가 비어 있습니다.'); return; }
    state.result = E.generateRules(text);
    state.compare = null;
    state.selected = null;
    const { articles, benefits, rows, manual, missing } = state.result;
    renderRules();
    renderManual();
    renderMissing();
    $('view-compare').innerHTML = '<div class="empty">[정답지와 비교]로 정답지 엑셀을 올리면 결과가 여기에 표시됩니다.</div>';
    renderSummary();
    $('btnExcel').disabled = rows.length === 0 && manual.length === 0 && missing.length === 0;
    setStatus(`조문 ${articles.length}개, 사망 급부 ${benefits.length}개를 인식해 룰 ${rows.length}행을 만들었습니다.`);
    showTab('rules');
  }

  function renderSummary() {
    const { rows, manual, missing } = state.result;
    const count = (lv) => rows.filter((r) => r.flags.some((f) => f.level === lv)).length;
    const byCat = (c) => rows.filter((r) => r.category === c).length;
    const chips = [
      `룰 ${rows.length}행`, `정상 ${byCat('정상')}`, `감액 ${byCat('감액')}`, `면책 ${byCat('면책')}`,
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
  const TABLE_COLS = ['no', 'category', 'benefit', 'accident', 'signGroupCode', 'calcCondition', 'formula', 'status', 'flagText', 'citations', 'signGroup', 'riskBenefit', 'calcTarget', 'testText'];

  function renderRules() {
    const { rows } = state.result;
    if (!rows.length) { $('view-rules').innerHTML = '<div class="empty">생성된 룰 행이 없습니다. [근거 없음] 탭을 확인하세요.</div>'; return; }
    const head = TABLE_COLS.map((k) => `<th>${esc(S.RULE_COLUMNS.find((c) => c.key === k).label)}</th>`).join('');
    const cmp = state.compare ? new Map(state.compare.items.filter((i) => i.row).map((i) => [i.row.no, i])) : null;
    const body = rows.map((r) => {
      const cells = TABLE_COLS.map((k) => {
        const v = r[k];
        if (k === 'category') return `<td><span class="badge b-${esc(v)}">${esc(v)}</span></td>`;
        if (k === 'status') return `<td><span class="badge b-${esc(v)}">${esc(v)}</span> ${esc(r.statusCode)}</td>`;
        if (k === 'formula' || k === 'calcCondition') return `<td class="mono">${esc(v)}</td>`;
        if (k === 'flagText' || k === 'testText') return `<td class="wrap">${esc(v)}</td>`;
        if (k === 'citations') return `<td class="wrap">${esc(v.replace(/ \/ /g, '\n'))}</td>`;
        return `<td>${esc(v)}</td>`;
      }).join('');
      const c = cmp && cmp.get(r.no);
      const mark = c ? `<td>${c.result === '일치' ? '✅' : c.result === '불일치' ? '❌' : '➕'} ${esc(c.result)}</td>` : '';
      return `<tr class="rule cat-${esc(r.category)}${state.selected === r.no ? ' sel' : ''}" data-no="${r.no}">${cells}${mark}</tr>`;
    }).join('');
    $('view-rules').innerHTML = `<table><thead><tr>${head}${cmp ? '<th>정답지 비교</th>' : ''}</tr></thead><tbody>${body}</tbody></table>`;
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

  function listTable(items, cols, emptyMsg) {
    if (!items.length) return `<div class="empty">${esc(emptyMsg)}</div>`;
    return `<table><thead><tr>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>${
      items.map((it) => `<tr>${cols.map(([k]) => `<td class="wrap">${esc(it[k])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  const MANUAL_COLS = [['ref', '약관 근거조항'], ['subject', '사유'], ['reason', '수기 처리 이유'], ['text', '원문 발췌']];
  const MISSING_COLS = [['subject', '대상'], ['ref', '확인한 조항'], ['reason', '근거 없음 사유']];

  function renderManual() {
    $('view-manual').innerHTML = listTable(state.result.manual, MANUAL_COLS, '심사자 수기 대상이 없습니다.');
  }
  function renderMissing() {
    $('view-missing').innerHTML = listTable(state.result.missing, MISSING_COLS, '근거 없음 항목이 없습니다. 모든 행에 약관 조항이 연결되었습니다.');
  }

  function downloadExcel() {
    const { rows, manual, missing } = state.result;
    const book = XLSX.utils.book_new();
    const aoa = [S.RULE_COLUMNS.map((c) => c.label), ...rows.map((r) => S.RULE_COLUMNS.map((c) => r[c.key]))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = S.RULE_COLUMNS.map((c) => ({ wch: ['excerptText', 'flagText', 'testText'].includes(c.key) ? 60 : ['formula', 'calcCondition', 'citations'].includes(c.key) ? 36 : 14 }));
    XLSX.utils.book_append_sheet(book, ws, '룰테이블');
    const sheetOf = (items, cols) => XLSX.utils.aoa_to_sheet([cols.map(([, l]) => l), ...items.map((it) => cols.map(([k]) => it[k] || ''))]);
    XLSX.utils.book_append_sheet(book, sheetOf(manual, MANUAL_COLS), '심사자수기');
    XLSX.utils.book_append_sheet(book, sheetOf(missing, MISSING_COLS), '근거없음');
    if (state.compare) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(compareAoa()), '정답지비교');
    XLSX.writeFile(book, `ECS_룰테이블_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function compareAoa() { return []; }

  // .txt 업로드: UTF-8 로 읽고, 깨진 문자가 있으면 EUC-KR 로 다시 읽습니다.
  async function readTextFile(file) {
    const buf = await file.arrayBuffer();
    const utf8 = new TextDecoder('utf-8').decode(buf);
    if (!utf8.includes('�')) return utf8;
    try { return new TextDecoder('euc-kr').decode(buf); } catch (e) { return utf8; }
  }

  $('btnSample').addEventListener('click', () => { $('terms').value = window.DUMMY_TERMS; setStatus('샘플(더미) 약관을 불러왔습니다. [변환]을 누르세요.'); });
  $('btnRun').addEventListener('click', run);
  $('fileTerms').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('terms').value = await readTextFile(f);
    setStatus(`${f.name} 을(를) 불러왔습니다. [변환]을 누르세요.`);
    e.target.value = '';
  });
  $('btnExcel').addEventListener('click', downloadExcel);
  $('tabs').addEventListener('click', (e) => { if (e.target.dataset.view) showTab(e.target.dataset.view); });
  $('view-rules').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.rule');
    if (!tr) return;
    state.selected = Number(tr.dataset.no);
    for (const x of document.querySelectorAll('tr.rule')) x.classList.toggle('sel', x === tr);
    renderDetail();
  });

  window.EcsApp = { state, run };
})();
