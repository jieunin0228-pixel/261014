// 담보 결과 카드의 A·B·C·D 영역 그리기(2단계). 상태는 app.js 가 갖고, 여기서는 HTML 만 만듭니다.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function pageLabel(c) {
    return `PDF ${c.pdfPage}쪽${c.printed != null ? ` · 인쇄 ${c.printed}쪽` : ' · 인쇄 쪽 미확인'}`;
  }

  const CHECK_TEXT = { partial: '원문 일부 일치', moved: '쪽번호 보정' };

  // 근거 한 건: 조문 · 쪽 + 인용
  function cite(c, withQuote = true) {
    const warn = c.check !== 'exact' ? ` <span class="pill warn" title="${esc(c.reason || '')}">${esc(CHECK_TEXT[c.check] || c.check)}</span>` : '';
    return `<div class="cite"><span class="cite-loc" data-page="${c.pdfPage}" data-quote="${esc(c.quote)}">${esc(c.article || '조문 미기재')} · ${pageLabel(c)}</span>${warn}${withQuote ? `<div class="cite-quote">“${esc(c.quote)}”</div>` : ''}</div>`;
  }
  const cites = (list, withQuote) => (list.length ? list.map((c) => cite(c, withQuote)).join('') : '<span class="muted">—</span>');

  function reviewBox(item) {
    return `<label class="review"><input type="checkbox" data-review="${esc(item.reviewKey)}" ${item.reviewed ? 'checked' : ''}> 검토완료</label>`;
  }

  function interp(list) {
    if (!list || !list.length) return '';
    return `<div class="interp"><span class="pill warn">해석 확인 필요</span><ul>${list.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
  }

  function areaA(r) {
    return `<table class="grid a-table"><thead><tr><th>항목</th><th>내용</th><th>근거</th><th>검토</th></tr></thead><tbody>
      ${r.A.map((a) => `<tr class="st-${a.status}">
        <th scope="row">${esc(a.label)}</th>
        <td>${a.status === 'found' ? esc(a.value) : `<span class="muted">${esc(a.value)}</span>`}${interp(a.interpretations)}</td>
        <td class="cites">${cites(a.citations, true)}</td>
        <td>${a.status === 'found' ? reviewBox(a) : ''}</td>
      </tr>`).join('')}
    </tbody></table>`;
  }

  function areaB(r) {
    if (!r.B.length) return `<p class="muted">원문 근거가 확인된 주의사항이 없습니다.${r.droppedB ? ` (근거를 확인하지 못한 ${r.droppedB}건은 표시하지 않았습니다.)` : ''}</p>`;
    return `<ul class="b-list">${r.B.map((b) => `<li>
        <div class="b-head"><span class="pill">${esc(b.type)}</span> <strong>${esc(b.title)}</strong> ${reviewBox(b)}</div>
        <p>${esc(b.detail)}</p>
        ${b.tableName ? `<p class="muted">참조 표: ${esc(b.tableName)} (표 안의 수치는 원문 위치에서 직접 확인하십시오.)</p>` : ''}
        ${interp(b.interpretations)}
        <div class="cites">${cites(b.citations, true)}</div>
      </li>`).join('')}</ul>${r.droppedB ? `<p class="muted">근거를 원문에서 확인하지 못한 ${r.droppedB}건은 표시하지 않았습니다.</p>` : ''}`;
  }

  function areaC(r) {
    if (!r.C.length) return '<p class="muted">확인된 근거가 없습니다.</p>';
    return `<ol class="c-list">${r.C.map((c) => `<li>${cite(c, true)}<div class="muted used">사용처: ${esc(c.usedBy.join(', '))}</div></li>`).join('')}</ol>
      <p class="muted">쪽번호를 누르면 PDF 뷰어로 이동하는 기능은 3단계에서 연결됩니다.</p>`;
  }

  function flagPills(f, flagText) {
    return f.flags.map((k) => `<span class="pill ${k === 'code_provisional' || k === 'user_input' ? '' : 'warn'}">${esc(flagText[k] || k)}</span>`).join(' ')
      + (f.edited ? ' <span class="pill accent">직접 수정</span>' : '');
  }

  function fieldRow(f, rowIdx, flagText) {
    const coded = f.fill === 'code';
    const after = f.after || { code: '', name: '' };
    const placeholder = f.display || '';
    const afterCell = f.fill === 'user'
      ? `<span class="${after.name ? '' : 'muted'}">${esc(after.name || '위 "상품 정보"에 입력')}</span>`
      : `<div class="pair">${coded ? `<input class="code-in" data-edit="${esc(f.reviewKey)}" data-part="code" value="${esc(after.code)}" placeholder="${coded && after.name ? '코드 확인 필요' : ''}" aria-label="${esc(f.label)} 코드">` : ''}
         <input class="name-in" data-edit="${esc(f.reviewKey)}" data-part="name" value="${esc(after.name)}" placeholder="${esc(placeholder)}" aria-label="${esc(f.label)} 명칭"></div>`;
    return `<tr class="st-${f.status}">
      <th scope="row">${esc(f.label)}</th>
      <td class="before muted">${coded ? '<span class="code">—</span> ' : ''}—</td>
      <td class="after">${afterCell}${f.note ? `<div class="muted note">${esc(f.note)}</div>` : ''}</td>
      <td class="flags">${flagPills(f, flagText)}</td>
      <td class="cites">${cites(f.citations, false)}</td>
      <td>${f.status === 'filled' || f.edited || (f.fill === 'user' && after.name) ? reviewBox(f) : ''}</td>
    </tr>`;
  }

  function areaD(r, flagText) {
    return r.rows.map((row, i) => `<div class="d-row">
      <h5>${r.rows.length > 1 ? `룰 ${i + 1}행 · ` : ''}${esc(row.label)}</h5>
      ${row.splitReason ? `<p class="split">행을 나눈 근거: ${esc(row.splitReason)}</p><div class="cites">${cites(row.splitCitations, false)}</div>` : ''}
      <div class="table-scroll"><table class="grid d-table">
        <thead><tr><th>필드</th><th>수정 전</th><th>수정 후</th><th>상태</th><th>근거</th><th>검토</th></tr></thead>
        <tbody>${r.groups.map((g) => `<tr class="group"><th colspan="6">${esc(g)}</th></tr>${row.fields.filter((f) => f.group === g).map((f) => fieldRow(f, i, flagText)).join('')}`).join('')}</tbody>
      </table></div>
    </div>`).join('') || '<p class="muted">룰 행이 제안되지 않았습니다.</p>';
  }

  // r: 분석 결과(view), flagText: 표시 문구
  function render(r, flagText) {
    const notes = [
      ...r.stale.map((t) => `<div class="note-box">${esc(t)} [다시 분석]을 누르면 갱신됩니다.</div>`),
      r.lastError ? `<div class="note-box error">마지막 분석이 실패했습니다: ${esc(r.lastError)} (아래는 이전 결과입니다.)</div>` : '',
      r.coverageFound === false ? '<div class="note-box error">AI가 이 담보를 주어진 약관에서 찾지 못했다고 답했습니다. 담보의 정의 약관이 맞는지 확인해 주십시오.</div>' : '',
      r.omitted && r.omitted.length ? `<div class="note-box">약관 분량이 많아 담보와 관계없는 조문 ${r.omitted.length}개는 분석에서 뺐습니다.</div>` : '',
    ].join('');
    const s = r.stats || {};
    return `${notes}
      <div class="result-meta muted">분석 ${esc(new Date(r.createdAt).toLocaleString('ko-KR'))} · 근거 ${s.citations || 0}건 중 원문 미확인 ${s.failed || 0}건 · 근거 미확인으로 숨긴 값 ${s.unverified || 0}건 · 검토 ${r.progress.reviewed}/${r.progress.total}</div>
      <details class="area" open><summary>A. 보장 세부조건</summary>${areaA(r)}</details>
      <details class="area" open><summary>B. 전산화 시 주의사항 <span class="muted">(${r.B.length}건)</span></summary>${areaB(r)}</details>
      <details class="area"><summary>C. 근거 페이지 <span class="muted">(${r.C.length}건)</span></summary>${areaC(r)}</details>
      <details class="area" open><summary>D. ECS 룰 입력 초안 <span class="muted">(${r.rows.length}행${r.codeFlags ? ` · 코드 확인 필요 ${r.codeFlags}건` : ''})</span></summary>
        <p class="muted">단일 약관 모드에서는 "수정 후"만 채웁니다. "수정 전"은 4단계(구약관 비교)에서 채워집니다. "수정 후" 칸은 직접 고칠 수 있으며 고친 값은 이 PC에 저장됩니다.</p>
        ${areaD(r, flagText)}
      </details>`;
  }

  window.AnalysisView = { render };
})();
