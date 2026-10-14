"use strict";
// 1단계 검증 화면: 원본 PDF 쪽과 추출 조문을 나란히 대조하고, 수정·승인합니다.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const KIND_COLORS = { article: "#1f6feb", paragraph: "#8250df", item: "#1a7f37", subitem: "#0a7d8c",
  appendix: "#b26a00", note: "#8c959f" };
const KIND_OPTIONS = [["article", "조"], ["paragraph", "항"], ["item", "호"], ["subitem", "목"], ["appendix", "별표"],
  ["note", "해설"], ["chapter", "관"], ["part", "편"], ["section", "절"], ["preamble", "머리말(본문 아님)"]];

const state = { doc: null, summary: null, page: 1, zoom: 1, view: null, editing: null, focusCid: null };

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (e) { /* 본문 없음 */ }
    throw new Error(msg);
  }
  return res.json();
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...body, user: reviewer() }) });

function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), ms);
}
function reviewer() { return $("#reviewer").value.trim(); }
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

// ------------------------------------------------------------------ 문서 목록·올리기
async function loadDocs(selectId) {
  const docs = await api("/api/docs");
  const sel = $("#docSelect");
  sel.innerHTML = '<option value="">— 변환한 약관 선택 —</option>' + docs.map((d) =>
    `<option value="${d.id}">${esc(d.filename || d.id)}${d.pages ? ` (${d.pages}쪽)` : ""}${d.approved ? " ✔승인" : ""}${d.converting ? " (변환 중)" : ""}</option>`).join("");
  const want = selectId || store("lastDoc");
  if (want && docs.some((d) => d.id === want)) { sel.value = want; await openDoc(want); }
}

async function upload(file) {
  const fd = new FormData(); fd.append("file", file);
  showProgress({ stage: "올리는 중", done: 0, total: 1 });
  try {
    const r = await api("/api/upload", { method: "POST", body: fd });
    if (r.cached) { toast("같은 PDF를 이미 변환했습니다. 저장된 결과를 엽니다."); hideProgress(); await loadDocs(r.id); return; }
    await waitConvert(r.id);
    await loadDocs(r.id);
  } catch (e) { hideProgress(); toast("올리기 실패: " + e.message, 5000); }
}

async function waitConvert(id) {
  for (;;) {
    const p = await api(`/api/docs/${id}/progress`);
    showProgress(p);
    if (p.finished) {
      hideProgress();
      if (p.error) throw new Error(p.error);
      return;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}
function showProgress(p) {
  $("#progress").hidden = false;
  const pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
  $("#progressText").textContent = `${p.stage} ${p.total > 1 ? `${p.done} / ${p.total}` : ""} (${pct}%)`;
  $("#progressBar").style.width = pct + "%";
}
function hideProgress() { $("#progress").hidden = true; }

async function openDoc(id) {
  if (!id) return;
  state.doc = id; store("lastDoc", id);
  state.summary = await api(`/api/docs/${id}/summary`);
  $("#main").hidden = false; $("#empty").hidden = true;
  $("#pageTotal").textContent = state.summary.meta.pages;
  renderSummary();
  const saved = Number(store("page:" + id)) || firstBodyPage();
  await gotoPage(saved);
}
function firstBodyPage() {
  // 첫 약관 구간의 목차 쪽을 건너뛴 본문 첫 쪽
  const s = state.summary.sections.find((x) => x.kind === "terms");
  if (!s) return 1;
  const toc = s.toc_pages || [];
  return toc.length ? Math.min(s.page_end, Math.max(...toc) + 1) : s.page_start;
}

function renderSummary() {
  const s = state.summary;
  const st = s.status;
  const badge = $("#approvalBadge");
  badge.className = "badge " + (st.approved ? "ok" : "no");
  badge.textContent = st.approved ? `승인됨 ${st.approved_at || ""}` : "미승인";
  $("#approveBtn").textContent = st.approved ? "승인 해제" : "변환 승인";
  const warn = ["article_gaps", "sub_gaps", "dup_ids", "unresolved", "bad_tables", "low_text", "ocr_low"]
    .reduce((a, k) => a + (s.counts[k] || 0), 0);
  $("#reportCount").textContent = warn || "";
}

// ------------------------------------------------------------------ 대조 검증
async function gotoPage(n, focusCid) {
  const total = state.summary.meta.pages;
  n = Math.max(1, Math.min(total, Number(n) || 1));
  state.page = n; store("page:" + state.doc, n);
  state.focusCid = focusCid || null;
  state.editing = null;
  $("#pageInput").value = n;
  state.view = await api(`/api/docs/${state.doc}/pages/${n}`);
  const pg = state.view.page;
  $("#printedPage").textContent = pg.printed_page != null ? `(인쇄 쪽번호 ${pg.printed_page})` : "(인쇄 쪽번호 없음)";
  $("#sectionName").textContent = state.view.section ? `${state.view.section.id} ${state.view.section.title}` : "";
  const img = $("#pageImg");
  img.onload = () => drawOverlay();
  $("#pdfWrap").style.width = Math.round(state.zoom * 100) + "%";
  img.src = `/api/docs/${state.doc}/pages/${n}/image?zoom=2`;
  renderText();
  if (focusCid) {
    const el = document.querySelector(`.card[data-cid="${CSS.escape(focusCid)}"]`);
    if (el) { el.scrollIntoView({ block: "center" }); highlight(el.dataset.uid, true); }
  }
}

function drawOverlay(hlUid) {
  const v = state.view; if (!v) return;
  const img = $("#pageImg");
  const scale = img.clientWidth / v.page.width;
  const ov = $("#overlay");
  ov.classList.toggle("hidebox", !$("#showAllBoxes").checked);
  const parts = [];
  for (const n of v.nodes) {
    const color = KIND_COLORS[n.kind] || "#57606a";
    for (const b of n.boxes) {
      parts.push(`<div class="b${n.uid === hlUid ? " hl" : ""}" style="left:${b[0] * scale - 1}px;top:${b[1] * scale - 1}px;width:${(b[2] - b[0]) * scale + 2}px;height:${(b[3] - b[1]) * scale + 2}px;border-color:${color}"></div>`);
    }
  }
  for (const t of v.tables) {
    const b = t.bbox;
    parts.push(`<div class="b" style="left:${b[0] * scale}px;top:${b[1] * scale}px;width:${(b[2] - b[0]) * scale}px;height:${(b[3] - b[1]) * scale}px;border:2px dashed ${t.incomplete ? "#c62828" : "#b26a00"}"></div>`);
  }
  ov.innerHTML = parts.join("");
}

function highlight(uid, keep) {
  drawOverlay(uid);
  document.querySelectorAll(".card.hl").forEach((c) => c.classList.remove("hl"));
  if (keep) document.querySelector(`.card[data-uid="${CSS.escape(uid)}"]`)?.classList.add("hl");
}

function refChip(r) {
  if (r.status === "연결") {
    return `<span class="ref" data-goto="${esc(r.target[0])}" title="${esc(r.target.join(", "))}">${esc(r.text)} → ${esc(r.target[0].split("|")[1] || r.target[0])}${r.target.length > 1 ? ` 외 ${r.target.length - 1}` : ""}</span>`;
  }
  if (r.status === "법령") return `<span class="ref law" title="법령 조문 인용">${esc(r.text)} (법령)</span>`;
  return `<span class="ref bad" title="${esc(r.note)}">${esc(r.text)} ✕ 참조 미해결</span>`;
}

function renderText() {
  const v = state.view;
  const pg = v.page;
  const refsBy = {};
  for (const r of v.refs) (refsBy[r.from_uid] ||= []).push(r);
  const out = [];
  if (pg.is_toc) out.push(`<div class="hf">이 쪽은 목차 쪽으로 판단하여 조문 분해에서 뺐습니다.</div>`);
  if (pg.header_footer?.length) out.push(`<div class="hf">머리글·바닥글로 뺀 줄: ${pg.header_footer.map(esc).join(" · ")}</div>`);
  if (pg.ocr) out.push(`<div class="hf flag">OCR: ${esc(pg.ocr)}</div>`);
  if (!v.nodes.length) out.push(`<div class="hf">이 쪽에서 추출한 조각이 없습니다. 원본에 글자가 있다면 품질 보고서를 확인하십시오.</div>`);
  for (const n of v.nodes) {
    const editing = state.editing && state.editing.uid === n.uid ? state.editing : null;
    const span = n.page_start !== n.page_end ? `${n.page_start}~${n.page_end}쪽` : `${n.page_start}쪽`;
    const head = `<div class="head"><span class="kind">${esc(n.kind_name)}</span>
      <span class="cid">${esc(n.cid)}</span>${n.title ? `<span class="title">${esc(n.title)}</span>` : ""}
      <span class="pages">${span}</span>${n.edited ? '<span class="edited">수정됨</span>' : ""}
      ${n.dup ? '<span class="dup">ID 중복</span>' : ""}</div>
      <div class="pages">${esc(n.path)}</div>`;
    let body;
    if (editing && editing.mode === "text") {
      body = `<textarea class="edit" data-edit="${n.uid}">${esc(n.text)}</textarea>
        <div class="actions"><button class="btn primary" data-act="saveText">저장</button><button class="btn" data-act="cancel">취소</button></div>`;
    } else if (editing && editing.mode === "split") {
      const lines = n.text.split("\n");
      body = `<div class="hf">새 조각이 시작될 줄의 [여기부터]를 누르십시오.</div><div class="txt">${lines.map((l, i) =>
        `<span class="ln">${i > 0 ? `<button class="btn small" data-act="splitAt" data-line="${i}">여기부터</button>` : ""}${esc(l)}</span>`).join("")}</div>
        <div class="actions"><button class="btn" data-act="cancel">취소</button></div>`;
    } else {
      body = `<div class="txt">${esc(n.text)}</div>
        <div class="actions">
          <button class="btn" data-act="text">글자 수정</button>
          <button class="btn" data-act="meta">종류·번호·제목</button>
          <button class="btn" data-act="split" ${n.text.includes("\n") ? "" : "disabled"}>나누기</button>
          <button class="btn" data-act="merge_prev">앞 조각과 합치기</button>
          <button class="btn" data-act="line_to_prev" title="이 조각의 첫 줄을 앞 조각 끝으로 보냅니다">첫 줄 ↑앞으로</button>
          <button class="btn" data-act="line_to_next" title="이 조각의 마지막 줄을 다음 조각 처음으로 보냅니다">끝 줄 ↓뒤로</button>
        </div>`;
    }
    const refs = (refsBy[n.uid] || []).map(refChip).join("");
    out.push(`<div class="card k-${n.kind}${n.cid === state.focusCid ? " hl" : ""}" data-uid="${esc(n.uid)}" data-cid="${esc(n.cid)}">${head}${body}${refs ? `<div class="refs">${refs}</div>` : ""}</div>`);
  }
  for (const t of v.tables) out.push(tableCard(t));
  $("#textPane").innerHTML = out.join("");
}

function tableHtml(rows) {
  return `<table class="t">${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
}
function tableCard(t, withPage) {
  const flags = [];
  if (t.incomplete) flags.push(`<span class="flag">표 추출 불완전: ${esc(t.reasons.join(", "))}</span>`);
  if (t.rebuilt) flags.push(`<span class="flag warn">세로선 없는 표 — 글자 위치로 칸을 재구성함. 원본 대조 필요</span>`);
  return `<div class="tcard${t.incomplete ? " bad" : ""}">
    <div class="head"><span class="kind" style="background:#b26a00">표</span><span class="cid">${esc(t.id)}</span>
    ${withPage ? `<a href="#" data-page="${t.page}">${t.page}쪽</a>` : `<span class="pages">${t.page}쪽</span>`}
    <span class="pages">${esc(t.node || "")}</span> ${flags.join(" ")}</div>
    ${tableHtml(t.rows)}
    ${t.image ? `<div class="pages">원본 이미지</div><img loading="lazy" src="/api/docs/${state.doc}/table-image/${t.id}" alt="${esc(t.id)} 원본">` : ""}</div>`;
}

async function doEdit(body, okMsg) {
  try {
    const r = await post(`/api/docs/${state.doc}/edit`, body);
    state.summary = r.summary; renderSummary();
    toast(okMsg || "저장했습니다. 수정 이력에 남았습니다.");
    await gotoPage(state.page, r.entry.cid_after || null);
  } catch (e) { toast("수정 실패: " + e.message, 5000); }
}

function metaDialog(n, title, onOk) {
  const box = $("#modalBox");
  box.innerHTML = `<h3>${esc(title)}</h3>
    <label>종류 <select id="mKind">${KIND_OPTIONS.map(([k, l]) => `<option value="${k}" ${k === n.kind ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label>번호 <input id="mNum" value="${esc(n.num)}" size="10"> <span class="muted">조: 12, 2-1, 2-1의3 / 항: 1, 2 / 호: 1, 2 / 목: 가, 나 / 별표: 1, 2-1</span></label>
    <label>제목 <input id="mTitle" value="${esc(n.title)}" size="40"></label>
    <div class="row"><button class="btn" id="mCancel">취소</button><button class="btn primary" id="mOk">확인</button></div>`;
  $("#modal").hidden = false;
  $("#mCancel").onclick = () => ($("#modal").hidden = true);
  $("#mOk").onclick = () => { $("#modal").hidden = true; onOk({ kind: $("#mKind").value, num: $("#mNum").value, title: $("#mTitle").value }); };
}

$("#textPane").addEventListener("click", async (ev) => {
  const ref = ev.target.closest("[data-goto]");
  if (ref) { await gotoCid(ref.dataset.goto); return; }
  const btn = ev.target.closest("[data-act]");
  const card = ev.target.closest(".card");
  if (!btn || !card) { if (card) highlight(card.dataset.uid, true); return; }
  const uid = card.dataset.uid;
  const n = state.view.nodes.find((x) => x.uid === uid);
  const act = btn.dataset.act;
  if (act === "text") { state.editing = { uid, mode: "text" }; renderText(); highlight(uid, true); return; }
  if (act === "split") { state.editing = { uid, mode: "split" }; renderText(); highlight(uid, true); return; }
  if (act === "cancel") { state.editing = null; renderText(); return; }
  if (act === "saveText") {
    const text = card.querySelector("textarea").value;
    await doEdit({ op: "edit_text", uid, text }); return;
  }
  if (act === "splitAt") {
    const line = Number(btn.dataset.line);
    metaDialog({ kind: n.kind, num: "", title: "" }, `${line + 1}번째 줄부터 새 조각 만들기`, (m) =>
      doEdit({ op: "split", uid, at_line: line, ...m }, "조각을 나눴습니다."));
    return;
  }
  if (act === "meta") { metaDialog(n, `${n.cid} 종류·번호·제목 고치기`, (m) => doEdit({ op: "edit_meta", uid, ...m })); return; }
  if (["merge_prev", "line_to_prev", "line_to_next"].includes(act)) {
    const label = { merge_prev: "이 조각을 앞 조각에 합칩니다", line_to_prev: "첫 줄을 앞 조각으로 보냅니다",
      line_to_next: "마지막 줄을 다음 조각으로 보냅니다" }[act];
    if (confirm(`${n.cid}: ${label}. 계속할까요?`)) await doEdit({ op: act, uid });
  }
});
$("#textPane").addEventListener("mouseover", (ev) => {
  const card = ev.target.closest(".card");
  if (card && card.dataset.uid !== state.hoverUid) { state.hoverUid = card.dataset.uid; drawOverlay(card.dataset.uid); }
});
$("#textPane").addEventListener("click", (ev) => {
  const a = ev.target.closest("a[data-page]"); if (a) { ev.preventDefault(); gotoPage(a.dataset.page); }
});

async function gotoCid(cid) {
  try {
    const r = await api(`/api/docs/${state.doc}/locate?cid=${encodeURIComponent(cid)}`);
    switchTab("verify");
    await gotoPage(r.page, cid);
  } catch (e) { toast("이동할 조각을 찾지 못했습니다: " + cid); }
}

// ------------------------------------------------------------------ 품질 보고서·표·구간·이력
async function renderReport() {
  const r = await api(`/api/docs/${state.doc}/report`);
  const s = r.stats;
  const stat = (label, v) => `<div class="stat">${label}<b>${v}</b></div>`;
  const html = [`<div class="stats">${stat("쪽", s.pages)}${stat("구간(주계약·특약 등)", s.sections)}${stat("조", s.articles)}
    ${stat("항", s.paragraphs)}${stat("호", s.items)}${stat("목", s.subitems)}${stat("별표", s.appendices)}
    ${stat("해설 상자", s.notes)}${stat("표", s.tables)}${stat("참조 연결", `${s.refs_linked} / ${s.refs - s.refs_law}`)}</div>`,
    `<p class="muted">각 줄을 누르면 해당 쪽으로 이동합니다. 목차 인식 방식: ${esc(state.summary.toc_source)} · 조문 제목 형식: ${state.summary.article_style === "bracket" ? "제N조【제목】" : "제N조(제목)"}</p>`];
  for (const g of r.groups) {
    html.push(`<details class="group" ${g.count && g.count < 60 ? "open" : ""}><summary>${esc(g.title)} — ${g.count}건</summary>
      ${g.count ? `<ul>${g.items.map((it) => `<li data-page="${it.page}" data-cid="${esc(it.id || "")}">${it.page}쪽 · ${esc(it.message)}</li>`).join("")}</ul>` : '<p class="muted" style="padding:0 12px">없음</p>'}</details>`);
  }
  $("#reportBody").innerHTML = html.join("");
}
$("#reportBody").addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-page]"); if (!li) return;
  switchTab("verify");
  const cid = li.dataset.cid;
  gotoPage(li.dataset.page, cid && cid.includes("|") ? cid : null);
});

async function renderTables() {
  const issues = document.querySelector('input[name=tfilter]:checked').value === "issues";
  const list = await api(`/api/docs/${state.doc}/tables${issues ? "?issues=true" : ""}`);
  $("#tablesBody").innerHTML = (list.length ? "" : '<p class="muted">해당하는 표가 없습니다.</p>') +
    list.slice(0, 300).map((t) => tableCard(t, true)).join("") + (list.length > 300 ? `<p class="muted">앞의 300개만 표시했습니다(전체 ${list.length}개).</p>` : "");
}
document.querySelectorAll("input[name=tfilter]").forEach((r) => r.addEventListener("change", renderTables));
$("#tablesBody").addEventListener("click", (ev) => {
  const a = ev.target.closest("a[data-page]"); if (!a) return; ev.preventDefault();
  switchTab("verify"); gotoPage(a.dataset.page);
});

function renderSections() {
  const rows = state.summary.sections.map((s) => `<tr class="click" data-page="${s.page_start}"><td>${s.id}</td><td>${esc(s.title)}</td>
    <td>${s.kind === "terms" ? "약관" : "부속 자료(조문 분해 안 함)"}</td><td>${s.page_start}~${s.page_end}</td><td>${(s.toc_pages || []).join(", ")}</td></tr>`).join("");
  $("#sectionsBody").innerHTML = `<p class="muted">책 앞쪽 목차(또는 북마크)로 구간을 나눴습니다. 목차에 없는 특약은 쪽 첫 줄의 "○○ 약관" 제목으로 찾았습니다.</p>
    <table class="list"><tr><th>ID</th><th>제목</th><th>구분</th><th>PDF 쪽</th><th>구간 목차 쪽</th></tr>${rows}</table>`;
}
$("#sectionsBody").addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr[data-page]"); if (!tr) return;
  switchTab("verify"); gotoPage(tr.dataset.page);
});

async function renderHistory() {
  const edits = await api(`/api/docs/${state.doc}/edits`);
  const st = state.summary.status;
  const opName = { edit_text: "글자 수정", edit_meta: "종류·번호·제목", split: "나누기", merge_prev: "앞과 합치기",
    line_to_prev: "첫 줄 앞으로", line_to_next: "끝 줄 뒤로", reset: "원본으로 되돌림" };
  const show = (v) => typeof v === "string" ? esc(v.length > 160 ? v.slice(0, 160) + "…" : v) : esc(JSON.stringify(v ?? ""));
  $("#historyBody").innerHTML = `<h3>승인 이력</h3>
    <table class="list"><tr><th>일시</th><th>검토자</th><th>내용</th><th>비고</th></tr>
    ${(st.history || []).map((h) => `<tr><td>${esc(h.ts)}</td><td>${esc(h.user)}</td><td>${esc(h.action)}</td><td>${esc(h.note)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">없음</td></tr>'}</table>
    <h3>수정 이력 (${edits.length}건)</h3>
    <p><button class="btn danger" id="resetBtn">모든 수정 버리고 변환 직후로 되돌리기</button></p>
    <table class="list"><tr><th>일시</th><th>검토자</th><th>작업</th><th>조각</th><th>수정 전</th><th>수정 후</th></tr>
    ${edits.slice().reverse().map((e) => `<tr class="click" data-page="${e.page || ""}" data-cid="${esc(e.cid_after || "")}"><td>${esc(e.ts)}</td><td>${esc(e.user)}</td><td>${opName[e.op] || esc(e.op)}</td>
      <td>${esc(e.cid)}${e.cid_after && e.cid_after !== e.cid ? ` → ${esc(e.cid_after)}` : ""}</td><td>${show(e.before)}</td><td>${show(e.after)}</td></tr>`).join("")}</table>`;
  $("#resetBtn").onclick = async () => {
    if (!confirm("모든 수정을 버리고 변환 직후 상태로 되돌립니다. 이력은 남습니다. 계속할까요?")) return;
    state.summary = await post(`/api/docs/${state.doc}/reset`, {}); renderSummary(); renderHistory(); toast("되돌렸습니다.");
  };
}
$("#historyBody").addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr[data-page]"); if (!tr || !tr.dataset.page) return;
  switchTab("verify"); gotoPage(tr.dataset.page, tr.dataset.cid || null);
});

function renderFiles() {
  const f = (name, desc) => `<tr><td><a href="/api/docs/${state.doc}/download/${name}">${name}</a></td><td>${desc}</td></tr>`;
  $("#filesBody").innerHTML = `<table class="list"><tr><th>파일</th><th>내용</th></tr>
    ${f("terms.json", "조문 트리: 구간, 조·항·호·목·별표·해설 조각(ID, 소속 경로, 시작·끝 쪽, 원문), 참조 연결")}
    ${f("tables.json", "표: 행·열 구조, 추출 불완전·재구성 표시")}
    ${f("pages.json", "PDF 쪽 ↔ 인쇄 쪽번호, 쪽별 글자 수·이미지 비율·2단 여부·OCR 여부")}
    ${f("report.json", "변환 품질 보고서")}
    ${f("edits.json", "수정 이력")}${f("status.json", "승인 상태와 이력")}</table>
    <p><button class="btn" id="reconvertBtn">같은 PDF를 처음부터 다시 변환</button> <span class="muted">수정 이력과 승인이 초기화됩니다.</span></p>`;
  $("#reconvertBtn").onclick = async () => {
    if (!confirm("다시 변환하면 지금까지의 수정과 승인이 사라집니다. 계속할까요?")) return;
    await post(`/api/docs/${state.doc}/reconvert`, {});
    try { await waitConvert(state.doc); await openDoc(state.doc); toast("다시 변환했습니다."); } catch (e) { toast("변환 실패: " + e.message, 5000); }
  };
}

function switchTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + name));
  if (name === "report") renderReport();
  if (name === "tables") renderTables();
  if (name === "sections") renderSections();
  if (name === "history") renderHistory();
  if (name === "files") renderFiles();
  if (name === "coverage") renderCoverage();
}

// ------------------------------------------------------------------ 2단계: 담보 분류
const MAJORS = ["사망", "장해", "진단", "입원", "치료", "기타"];
const cov = { data: null, open: new Set(["m:사망", "m:장해", "m:진단", "m:입원", "m:치료", "m:기타"]), more: new Set() };

async function renderCoverage() {
  $("#covLocked").hidden = true; $("#covMain").hidden = true;
  try {
    cov.data = await api(`/api/docs/${state.doc}/coverage`);
  } catch (e) {
    $("#covLocked").hidden = false;
    $("#covLocked").innerHTML = `${esc(e.message)}<br><button class="btn" id="covGoReport">품질 보고서 보기</button>`;
    $("#covGoReport").onclick = () => switchTab("report");
    return;
  }
  $("#covMain").hidden = false;
  $("#covStale").hidden = !cov.data.stale;
  drawCoverageTree();
  const common = cov.data.common_sections || [];
  $("#covCommon").textContent = common.length ? `특약 공통 조문: ${common.map((c) => `${c.title}(${c.section})`).join(", ")} — 담보가 아니며, 3단계에서 각 담보가 참조하는 조문으로 함께 씁니다.` : "";
  await drawCovHistory();
}

async function drawCovHistory() {
  const hist = await api(`/api/docs/${state.doc}/coverage/edits`);
  const names = Object.fromEntries(cov.data.items.map((i) => [i.id, i.name]));
  $("#covHistory").innerHTML = hist.length ? `<table class="list"><tr><th>일시</th><th>검토자</th><th>작업</th><th>담보</th><th>내용</th></tr>${hist.slice().reverse().map((h) =>
    `<tr><td>${esc(h.ts)}</td><td>${esc(h.user)}</td><td>${h.op === "move" ? "분류 이동" : "이름 수정"}</td><td>${esc(h.ids.map((i) => names[i] || i).join(", "))}</td>
     <td>${h.op === "move" ? esc(`${h.after.major} > ${h.after.middle}${h.after.minor ? " > " + h.after.minor : ""}`) : esc(`${h.before} → ${h.after}`)}</td></tr>`).join("")}</table>` : '<p class="muted">없음</p>';
}

function covFiltered() {
  const q = $("#covSearch").value.trim().replace(/\s/g, "");
  if (!q) return cov.data.items;
  return cov.data.items.filter((i) => [i.name, i.minor, i.middle, i.pay_reason, i.group].some((v) => (v || "").replace(/\s/g, "").includes(q)));
}

function drawCoverageTree() {
  const items = covFiltered();
  const searching = !!$("#covSearch").value.trim();
  const sel = cov.data.items.filter((i) => i.selected).length;
  $("#covCount").textContent = `담보 ${cov.data.items.length}개 중 ${sel}개 선택${searching ? ` · 검색 결과 ${items.length}개` : ""}`;
  const tree = {};
  for (const it of items) ((tree[it.major] ||= {})[it.middle] ||= {})[it.minor] ||= [];
  for (const it of items) tree[it.major][it.middle][it.minor].push(it);
  const ids = (list) => list.map((i) => i.id).join(",");
  const box = (list) => {
    const n = list.filter((i) => i.selected).length;
    return `<input type="checkbox" data-ids="${ids(list)}" ${n && n === list.length ? "checked" : ""} data-partial="${n > 0 && n < list.length ? 1 : 0}">`;
  };
  const isOpen = (k) => searching || cov.open.has(k);
  const html = ['<ul class="tree">'];
  for (const major of MAJORS) {
    const mids = tree[major]; if (!mids) continue;
    const all = Object.values(mids).flatMap((m) => Object.values(m).flat());
    const km = "m:" + major;
    html.push(`<li class="lv1"><details data-key="${km}" ${isOpen(km) ? "open" : ""}><summary>${box(all)} ${esc(major)}<span class="cnt">${all.length}</span></summary><ul>`);
    for (const [mid, minors] of Object.entries(mids).sort()) {
      const list = Object.values(minors).flat();
      const kd = `d:${major}:${mid}`;
      html.push(`<li class="lv2"><details data-key="${esc(kd)}" ${isOpen(kd) ? "open" : ""}><summary>${box(list)} ${esc(mid)}<span class="cnt">${list.length}</span></summary><ul>`);
      for (const [minor, leaves] of Object.entries(minors).sort()) {
        const kn = `n:${major}:${mid}:${minor}`;
        html.push(`<li class="lv3"><details data-key="${esc(kn)}" ${isOpen(kn) ? "open" : ""}><summary>${box(leaves)} ${esc(minor)}<span class="cnt">${leaves.length}</span></summary><ul>`);
        for (const it of leaves) html.push(`<li>${leafHtml(it)}</li>`);
        html.push("</ul></details></li>");
      }
      html.push("</ul></details></li>");
    }
    html.push("</ul></details></li>");
  }
  html.push("</ul>");
  $("#covTree").innerHTML = items.length ? html.join("") : '<p class="muted">해당하는 담보가 없습니다.</p>';
  document.querySelectorAll('#covTree input[data-partial="1"]').forEach((c) => (c.indeterminate = true));
}

function leafHtml(it) {
  const src = it.source;
  const more = cov.more.has(it.id) ? `<div class="more">
      <div><b>지급사유</b> ${esc(it.pay_reason || "지급기준표 없음")}</div>
      <div><b>지급금액</b> ${esc(it.pay_amount || "지급기준표에서 읽지 못함 — 원본 확인")}</div>
      <div><b>분류 근거</b> ${esc(it.reason_note)}</div>
      <div><b>조문 범위</b> <span class="ref" data-goto="${esc(it.range.first)}">${esc(it.range.first)}</span> ~ <span class="ref" data-goto="${esc(it.range.last)}">${esc(it.range.last)}</span> (${it.range.pages[0]}~${it.range.pages[1]}쪽)</div>
      <div><b>주요 조문</b> ${it.key_articles.map((c) => `<span class="ref" data-goto="${esc(c)}">${esc(c.split("|")[1])}</span>`).join("") || "없음"}</div>
      ${it.renamed ? `<div><b>자동 인식 이름</b> ${esc(it.auto_name)}</div>` : ""}</div>` : "";
  return `<div class="leaf" data-id="${it.id}"><div class="row1"><input type="checkbox" data-ids="${it.id}" ${it.selected ? "checked" : ""}>
    <span class="nm">${esc(it.name)}</span><span class="amt">${esc((it.pay_amount || "").slice(0, 60))}</span>
    ${it.moved ? '<span class="tag">이동됨</span>' : ""}${it.renamed ? '<span class="tag">이름 수정</span>' : ""}
    <span class="spacer"></span>
    <button class="btn small" data-cov="more">${cov.more.has(it.id) ? "접기" : "자세히"}</button>
    <button class="btn small" data-cov="rename">이름 수정</button>
    <button class="btn small" data-cov="move">분류 이동</button>
    <button class="btn small" data-cov="src" data-page="${src.page}" data-cid="${esc(src.appendix || it.range.first)}">근거 보기</button></div>
    <div class="why">${esc(it.id)} · ${esc(it.reason_note)}</div>${more}</div>`;
}

async function covEdit(body) {
  try {
    cov.data = Object.assign(await post(`/api/docs/${state.doc}/coverage/edit`, body), { stale: cov.data.stale });
    drawCoverageTree();
    if (body.op !== "select") await drawCovHistory();
  } catch (e) { toast("저장 실패: " + e.message, 5000); }
}

function covMoveDialog(ids) {
  if (!ids.length) { toast("이동할 담보를 먼저 선택하십시오."); return; }
  const first = cov.data.items.find((i) => i.id === ids[0]);
  const mids = [...new Set(cov.data.items.map((i) => i.middle))].sort();
  const minors = [...new Set(cov.data.items.map((i) => i.minor))].sort();
  $("#modalBox").innerHTML = `<h3>담보 ${ids.length}개 분류 이동</h3>
    <label>대분류 <select id="mvMajor">${MAJORS.map((m) => `<option ${m === first.major ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    <label>중분류 <input id="mvMid" list="mvMids" value="${esc(first.middle)}"><datalist id="mvMids">${mids.map((m) => `<option value="${esc(m)}">`).join("")}</datalist></label>
    <label>소분류 <input id="mvMinor" list="mvMinors" placeholder="비우면 그대로 둡니다" size="36"><datalist id="mvMinors">${minors.map((m) => `<option value="${esc(m)}">`).join("")}</datalist></label>
    <div class="row"><button class="btn" id="mvCancel">취소</button><button class="btn primary" id="mvOk">이동</button></div>`;
  $("#modal").hidden = false;
  $("#mvCancel").onclick = () => ($("#modal").hidden = true);
  $("#mvOk").onclick = () => { $("#modal").hidden = true;
    covEdit({ op: "move", ids, major: $("#mvMajor").value, middle: $("#mvMid").value, minor: $("#mvMinor").value }); };
}

$("#covTree").addEventListener("toggle", (ev) => {
  const d = ev.target; if (!d.dataset || !d.dataset.key || $("#covSearch").value.trim()) return;
  if (d.open) cov.open.add(d.dataset.key); else cov.open.delete(d.dataset.key);
}, true);
$("#covTree").addEventListener("click", async (ev) => {
  const cb = ev.target.closest("input[type=checkbox][data-ids]");
  if (cb) {
    ev.stopPropagation();
    const ids = cb.dataset.ids.split(",");
    for (const it of cov.data.items) if (ids.includes(it.id)) it.selected = cb.checked;
    drawCoverageTree();
    covEdit({ op: "select", ids, selected: cb.checked });
    return;
  }
  const ref = ev.target.closest("[data-goto]");
  if (ref) { await gotoCid(ref.dataset.goto); return; }
  const b = ev.target.closest("[data-cov]"); if (!b) return;
  const id = b.closest(".leaf").dataset.id;
  const it = cov.data.items.find((i) => i.id === id);
  if (b.dataset.cov === "more") { cov.more.has(id) ? cov.more.delete(id) : cov.more.add(id); drawCoverageTree(); }
  if (b.dataset.cov === "rename") { const n = prompt("새 담보명", it.name); if (n && n.trim() && n.trim() !== it.name) covEdit({ op: "rename", id, name: n.trim() }); }
  if (b.dataset.cov === "move") covMoveDialog([id]);
  if (b.dataset.cov === "src") { switchTab("verify"); gotoPage(b.dataset.page, b.dataset.cid); }
});
$("#covSearch").addEventListener("input", () => drawCoverageTree());
$("#covMoveSel").onclick = () => covMoveDialog(cov.data.items.filter((i) => i.selected).map((i) => i.id));
$("#covOpenAll").onclick = () => { document.querySelectorAll("#covTree details").forEach((d) => { d.open = true; cov.open.add(d.dataset.key); }); };
$("#covCloseAll").onclick = () => { cov.open.clear(); drawCoverageTree(); };
const covExport = (fmt) => { location.href = `/api/docs/${state.doc}/coverage/export?fmt=${fmt}&selected=${$("#covSelOnly").checked}`; };
$("#covXlsx").onclick = () => covExport("xlsx");
$("#covJson").onclick = () => covExport("json");
$("#covRebuild").onclick = async () => {
  if (!confirm("승인된 1단계 결과로 담보를 다시 찾습니다. 이동·이름 수정·선택은 같은 담보에 그대로 이어 붙입니다. 계속할까요?")) return;
  try { await post(`/api/docs/${state.doc}/coverage/rebuild`, { keep_user: true }); await renderCoverage(); toast("다시 만들었습니다."); }
  catch (e) { toast("실패: " + e.message, 5000); }
};

// ------------------------------------------------------------------ 이벤트
$("#tabs").addEventListener("click", (ev) => { const b = ev.target.closest("button[data-tab]"); if (b) switchTab(b.dataset.tab); });
$("#fileInput").addEventListener("change", (ev) => { const f = ev.target.files[0]; if (f) upload(f); ev.target.value = ""; });
$("#docSelect").addEventListener("change", (ev) => openDoc(ev.target.value));
$("#prevPage").onclick = () => gotoPage(state.page - 1);
$("#nextPage").onclick = () => gotoPage(state.page + 1);
$("#pageInput").addEventListener("change", (ev) => gotoPage(ev.target.value));
$("#showAllBoxes").addEventListener("change", () => drawOverlay());
document.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
  state.zoom = Math.max(1, Math.min(3, state.zoom + (b.dataset.zoom === "+" ? 0.25 : -0.25)));
  $("#pdfWrap").style.width = Math.round(state.zoom * 100) + "%";
  drawOverlay();
}));
document.addEventListener("keydown", (ev) => {
  if (ev.target.closest("input, textarea, select")) return;
  if (!$("#tab-verify").classList.contains("on") || !state.doc) return;
  if (ev.key === "ArrowRight" || ev.key === "PageDown") { ev.preventDefault(); gotoPage(state.page + 1); }
  if (ev.key === "ArrowLeft" || ev.key === "PageUp") { ev.preventDefault(); gotoPage(state.page - 1); }
});
window.addEventListener("resize", () => drawOverlay());

async function search() {
  const q = $("#searchInput").value.trim(); if (!q) return;
  const res = await api(`/api/docs/${state.doc}/search?q=${encodeURIComponent(q)}`);
  const box = $("#searchResults"); box.hidden = false;
  box.innerHTML = res.length ? res.map((r) => `<div data-page="${r.page}" data-cid="${esc(r.cid)}">${r.page}쪽 · <b>${esc(r.cid)}</b> ${esc(r.text.replace(/\n/g, " "))}</div>`).join("")
    : '<span class="muted">찾은 조각이 없습니다.</span>';
}
$("#searchBtn").onclick = search;
$("#searchInput").addEventListener("keydown", (ev) => { if (ev.key === "Enter") search(); });
$("#searchResults").addEventListener("click", (ev) => {
  const d = ev.target.closest("div[data-page]"); if (!d) return;
  $("#searchResults").hidden = true; gotoPage(d.dataset.page, d.dataset.cid);
});

$("#approveBtn").onclick = async () => {
  if (!state.doc) return;
  const st = state.summary.status;
  if (st.approved) {
    if (!confirm("승인을 해제합니다. 계속할까요?")) return;
    state.summary.status = await post(`/api/docs/${state.doc}/approve`, { approved: false, note: "수동 해제" });
    renderSummary(); return;
  }
  if (!reviewer()) { toast("검토자 이름을 먼저 입력하십시오."); $("#reviewer").focus(); return; }
  const c = state.summary.counts;
  const lines = [["조문 번호 연속성", c.article_gaps], ["항·호·목 번호 끊김·중복", c.sub_gaps], ["참조 미해결", c.unresolved],
    ["표 추출 불완전", c.bad_tables], ["표 재구성(원본 대조 권장)", c.rebuilt_tables], ["텍스트 거의 없는 쪽", c.low_text], ["OCR 저신뢰", c.ocr_low]]
    .map(([k, v]) => `${k}: ${v || 0}건`).join("\n");
  if (!confirm(`남아 있는 경고\n${lines}\n\n원본과 대조를 마쳤고, 위 경고를 확인했다면 승인합니다. 승인해야 다음 단계(담보 분류·AI 해석)로 넘어갈 수 있습니다.\n승인 후 수정하면 승인은 자동으로 해제됩니다.`)) return;
  state.summary.status = await post(`/api/docs/${state.doc}/approve`, { approved: true, note: "" });
  renderSummary(); toast("변환을 승인했습니다.");
};

$("#reviewer").value = store("reviewer") || "";
$("#reviewer").addEventListener("change", () => store("reviewer", reviewer()));
loadDocs().catch((e) => toast("서버에 연결하지 못했습니다: " + e.message, 6000));
new ResizeObserver(() => drawOverlay()).observe($("#pageImg"));
