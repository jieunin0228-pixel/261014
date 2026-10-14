"use strict";
// 약관 구조화 도구 - 화면 스크립트 (1단계: 변환과 검증)

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KIND = { article: "조", para: "항", item: "호", sub: "목", subsub: "세목", box: "설명", annex: "별표", preface: "머리말", part: "편", chap: "관", law: "법령" };

const S = {
  doc: null, summary: null, report: null, cov: null, covData: null,
  page: 1, scale: 1.4, lines: null, selNode: null, selNodeFull: null, ptab: "terms", openNodes: new Set(),
};

function user() { return $("#user").value.trim(); }
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : "");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), err ? 6000 : 2500);
}
// 서버 대신 브라우저 안의 함수(TT.route)를 부릅니다. 데이터는 이 브라우저에만 저장됩니다.
async function api(url, opt = {}) {
  try { return await TT.route(url, opt); }
  catch (e) { console.error(e); throw new Error((e && e.message) || String(e)); }
}
// 확인 창: 아티팩트에서는 confirm()이 동작하지 않으므로 페이지 안의 대화상자를 씁니다.
function ask(msg) { return dialog("확인", `<p>${esc(msg)}</p>`); }
// 파일 내려받기: claude.ai의 내려받기 기능(downloads)을 씁니다.
async function saveFile(filename, makeData) {
  const dl = window.claude && window.claude.use ? await window.claude.use("downloads").catch(() => null) : null;
  if (!dl) return toast("이 화면에서는 파일을 내려받을 수 없습니다. claude.ai에서 이 아티팩트를 열어 주세요.", true);
  toast("파일을 만드는 중입니다…");
  try {
    const data = await makeData();
    await dl.save({ filename, data });
    toast("내려받기를 요청했습니다.");
  } catch (e) {
    if (e && e.code === "declined") return toast("내려받기를 취소했습니다.");
    toast("내려받기 실패: " + ((e && (e.message || e.code)) || e), true);
  }
}
const fname = (suffix, ext) => `${((S.summary && S.summary.meta.filename) || "약관").replace(/\.pdf$/i, "")}_${suffix}.${ext}`;
const post = (url, body) => {
  if (url.endsWith("/edits")) toast("수정을 반영하고 조문을 다시 추출하는 중입니다…");
  return api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
};

// ------------------------------------------------------------ 탭
function showTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + name));
  try { localStorage.setItem("tab", name); } catch (e) { /* 저장 불가 */ }
}
$$("#tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ------------------------------------------------------------ 문서 목록·업로드
async function loadDocs() {
  const docs = await api("/api/docs");
  const tb = $("#docList tbody");
  tb.innerHTML = docs.map((d) => `<tr class="click" data-id="${d.id}">
    <td>${esc(d.filename)}</td><td>${d.page_count ?? ""}</td><td>${esc(d.created || "")}</td>
    <td>${d.converted ? "완료" : "미완료"}</td><td>${d.approved ? '<span class="badge ok">승인</span>' : '<span class="badge gray">미승인</span>'}</td>
    <td><button data-re="${d.id}">다시 변환</button> <button data-del="${d.id}" class="danger">삭제</button></td></tr>`).join("") || `<tr><td colspan="6" class="hint">저장된 문서가 없습니다.</td></tr>`;
  $$("#docList button[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await ask("이 문서와 변환 결과·수정 이력을 이 브라우저에서 지웁니다. 되돌릴 수 없습니다. 계속할까요?"))) return;
    await TT.deleteDoc(b.dataset.del);
    if (S.doc === b.dataset.del) { S.doc = null; S.summary = null; try { localStorage.removeItem("doc"); } catch (e) { /* 저장 불가 */ } }
    toast("삭제했습니다."); loadDocs();
  }));
  $$("#docList tr.click").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.dataset.re || e.target.dataset.del) return;
    openDoc(tr.dataset.id);
  }));
  $$("#docList button[data-re]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await ask("이 문서를 다시 변환합니다. 사용자 수정 지시문은 유지되어 다시 적용됩니다. 계속할까요?"))) return;
    const job = await api(`/api/docs/${b.dataset.re}/reconvert`, { method: "POST" });
    track(job);
  }));
}

$("#btnUpload").addEventListener("click", async () => {
  const f = $("#pdfFile").files[0];
  if (!f) return toast("PDF 파일을 고르세요.", true);
  const fd = new FormData(); fd.append("file", f);
  $("#progress").classList.remove("hidden");
  $("#progText").textContent = "파일 올리는 중…";
  try {
    const job = await api(`/api/docs?force=${$("#forceConv").checked}`, { method: "POST", body: fd });
    track(job);
  } catch (e) { toast(e.message, true); }
});

async function track(job) {
  $("#progress").classList.remove("hidden");
  let j = job;
  while (true) {
    $("#progBar").style.width = Math.round((j.frac || 0) * 100) + "%";
    $("#progText").textContent = `${j.stage || "대기"} ${j.msg || ""} (${Math.round((j.frac || 0) * 100)}%)`;
    if (j.done) break;
    await new Promise((r) => setTimeout(r, 800));
    j = await api(`/api/jobs/${job.id}`);
  }
  if (j.error) { $("#progText").textContent = "변환 실패: " + j.error; toast("변환 실패: " + j.error, true); return; }
  if (j.cached) toast("같은 PDF의 이전 변환 결과를 사용합니다.");
  await loadDocs();
  await openDoc(j.doc_id);
  showTab("report");
}

// ------------------------------------------------------------ 문서 열기
async function openDoc(id) {
  S.doc = id;
  try { localStorage.setItem("doc", id); } catch (e) { /* 저장 불가 */ }
  S.summary = await api(`/api/docs/${id}/summary`);
  S.report = await api(`/api/docs/${id}/report`);
  $("#docName").textContent = S.summary.meta.filename + ` (${S.summary.doc.page_count}쪽)`;
  $("#pTotal").textContent = "/ " + S.summary.doc.page_count;
  renderApproval();
  renderReport();
  renderCovList();
  loadEdits();
  if (window.clsLoad) window.clsLoad(); if (window.anLoad) window.anLoad(); if (window.cmpLoad) window.cmpLoad();
  if (!S.cov) gotoPage(1);
}

function renderApproval() {
  const a = S.summary.approval || {};
  const b = $("#apprBadge");
  if (a.approved) { b.className = "badge ok"; b.textContent = `변환 승인됨 (${a.at || ""})`; }
  else if (a.revoked_reason) { b.className = "badge warn"; b.textContent = "승인 해제됨: " + a.revoked_reason; }
  else { b.className = "badge gray"; b.textContent = "변환 미승인"; }
}

async function refresh(keepCov = true) {
  const cid = S.cov;
  S.summary = await api(`/api/docs/${S.doc}/summary`);
  S.report = await api(`/api/docs/${S.doc}/report`);
  renderApproval(); renderReport(); renderCovList(); loadEdits();
  if (window.clsLoad) window.clsLoad(); if (window.anLoad) window.anLoad(); if (window.cmpLoad) window.cmpLoad();
  if (keepCov && cid) await openCov(cid, false);
}

// ------------------------------------------------------------ 품질 보고서
function kpi(label, v, cls = "") { return `<div class="kpi ${cls}"><div class="v">${esc(v)}</div><div class="l">${esc(label)}</div></div>`; }
function pg(p) { return p ? `<span class="pg" data-page="${p}">${p}</span>` : ""; }
function cv(cid) {
  if (!cid) return "";
  const c = S.summary.coverages.find((x) => x.cid === cid);
  return `<span class="pg" data-cov="${cid}">${esc(cid)}</span>${c ? " " + esc(c.name) : ""}`;
}
function sec(title, n, body, warnIfAny = true) {
  return `<details class="sec"><summary>${esc(title)}<span class="cnt ${n && warnIfAny ? "warn" : ""}">${n}건</span></summary><div>${n ? body : '<p class="hint">없음</p>'}</div></details>`;
}
function tbl(head, rows) {
  return `<table class="grid"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderReport() {
  const r = S.report; if (!r) return;
  const off = r.offset;
  let h = `<div class="kpis">
    ${kpi("목차 항목 수", r.toc_count)}
    ${kpi("머리글로 찾은 담보 수", r.header_coverages)}
    ${kpi("차이(목차 − 머리글)", r.count_diff, r.count_diff ? "warn" : "ok")}
    ${kpi("목차·PDF 쪽번호 오프셋", off.known ? off.offset : "알 수 없음", off.known && off.offset === 0 ? "ok" : "warn")}
    ${kpi("미배정 쪽", r.unassigned_pages.length, r.unassigned_pages.length ? "warn" : "ok")}
    ${kpi("목차·머리글 불일치 쪽", r.mismatch_pages.length, r.mismatch_pages.length ? "bad" : "ok")}
    ${kpi("지급사유 조문 없는 담보", r.no_payout.length, r.no_payout.length ? "warn" : "ok")}
    ${kpi("조문 번호 끊김·중복", r.numbering.length + r.duplicate_ids.length, r.numbering.length + r.duplicate_ids.length ? "warn" : "ok")}
    ${kpi("참조 미해결 / 전체", `${r.unresolved_refs.length} / ${r.ref_total}`, r.unresolved_refs.length ? "warn" : "ok")}
    ${kpi("표 추출 불완전 / 전체", `${r.table_incomplete.length} / ${r.table_total}`, r.table_incomplete.length ? "warn" : "ok")}
    ${kpi("텍스트가 거의 없는 쪽", r.low_text_pages.length, r.low_text_pages.length ? "warn" : "ok")}
    ${kpi("스캔형 쪽 / OCR 항목", `${r.scanned_pages} / ${r.ocr.length}`, r.ocr.length ? "bad" : "ok")}
  </div>`;
  h += `<div class="card"><div class="row"><b>목차 위치</b> ${r.toc.pages.map(pg).join(", ") || "못 찾음"}
    <span class="hint">· 인쇄 쪽번호와 PDF 쪽번호가 같은 쪽 ${off.agree_pages ?? 0}개, 다른 쪽 ${(off.mismatch_pages || []).length}개, 쪽번호 없는 쪽 ${(off.no_number_pages || []).map(pg).join(", ") || "없음"}</span></div>
    ${r.toc.problems.map((p) => `<div class="tag bad">${esc(p)}</div>`).join("")}</div>`;

  h += sec("목차에는 있으나 머리글이 없는 항목", r.toc_no_header.length,
    tbl(["담보", "목차 범위"], r.toc_no_header.map((x) => `<tr><td>${cv(x.cid)}</td><td>${pg(x.toc_start)}–${pg(x.toc_end)}</td></tr>`)) +
    `<p class="hint">머리글이 없는 쪽은 목차 범위로 배정하였습니다. 약관 본문이 아니라면 유형을 '부속자료'로 둡니다.</p>`);
  h += sec("머리글은 있으나 목차에 없는 머리글", r.unknown_headers.length,
    tbl(["머리글", "쪽"], r.unknown_headers.map((x) => `<tr><td>${esc(x.header)}</td><td>${x.pages.map(pg).join(", ")}</td></tr>`)));
  h += sec("목차 시작쪽과 머리글 시작쪽이 다른 담보", r.start_diff.length,
    tbl(["담보", "목차 시작쪽", "머리글 시작쪽"], r.start_diff.map((x) => `<tr><td>${cv(x.cid)}</td><td>${pg(x.toc_start)}</td><td>${pg(x.header_start)}</td></tr>`)));
  h += sec("어느 담보에도 배정되지 않은 쪽", r.unassigned_pages.length,
    tbl(["쪽", "첫 줄"], r.unassigned_pages.map((x) => `<tr><td>${pg(x.p)}</td><td>${esc(x.first_line)}</td></tr>`)));
  h += sec("목차와 머리글이 불일치하는 쪽", r.mismatch_pages.length,
    tbl(["쪽", "머리글", "머리글 담보", "목차 범위 담보", "최종 배정"], r.mismatch_pages.map((x) => `<tr><td>${pg(x.p)}</td><td>${esc(x.header)}</td><td>${cv(x.header_cid)}</td><td>${cv(x.toc_cid)}</td><td>${cv(x.assigned)}</td></tr>`)));
  h += sec("머리글 없이 목차 범위로 배정한 쪽", r.no_header_assigned.length, `<p>${r.no_header_assigned.map(pg).join(", ")}</p>`, false);
  h += sec("담보 안의 자체 목차 쪽(조문 추출에서 제외)", r.internal_toc_pages.length, `<p>${r.internal_toc_pages.map(pg).join(", ")}</p>`, false);
  h += sec("지급사유(또는 납입면제사유) 조문이 없는 담보", r.no_payout.length,
    tbl(["담보", "유형"], r.no_payout.map((x) => `<tr><td>${cv(x.cid)}</td><td>${esc(x.type)}</td></tr>`)));
  h += sec("조문 번호 끊김·역전·중복", r.numbering.length + r.duplicate_ids.length,
    tbl(["담보", "구분", "조문", "쪽", "내용"], r.numbering.map((x) => `<tr><td>${cv(x.cid)}</td><td>${esc(x.kind)}</td><td>${esc(x.key)}</td><td>${pg(x.page)}</td><td>${esc(x.detail)}</td></tr>`)
      .concat(r.duplicate_ids.map((x) => `<tr><td>${cv(x.cid)}</td><td>ID 중복</td><td>${esc(x.id)}</td><td>${pg(x.page)}</td><td></td></tr>`))));
  h += sec("참조 미해결", r.unresolved_refs.length,
    tbl(["담보", "쪽", "종류", "참조 표현", "사유", "문맥"], r.unresolved_refs.map((x) => `<tr><td>${cv(x.cid)}</td><td>${pg(x.src_page)}</td><td>${esc(x.kind)}</td><td>${esc(x.raw)}</td><td>${esc(x.reason)}</td><td>${esc(x.ctx)}</td></tr>`)));
  h += sec("표 추출 불완전", r.table_incomplete.length,
    tbl(["표", "담보", "쪽", "문제", "원본 쪽"], r.table_incomplete.map((x) => `<tr><td>${esc(x.id)}</td><td>${cv(x.cid)}</td><td>${pg(x.page)}</td><td>${esc(x.problems.join("; "))}</td><td>${pg(x.page)}</td></tr>`)));
  h += sec("텍스트가 거의 없는 쪽", r.low_text_pages.length,
    tbl(["쪽", "글자 수", "담보"], r.low_text_pages.map((x) => `<tr><td>${pg(x.p)}</td><td>${x.chars}</td><td>${cv(x.cid)}</td></tr>`)), false);
  h += sec("OCR 저신뢰·미실행 구간", r.ocr.length,
    tbl(["쪽", "상태", "내용"], r.ocr.map((x) => `<tr><td>${pg(x.p)}</td><td>${esc(x.status)}</td><td>${esc(x.detail)}</td></tr>`)));

  // 담보별 요약표
  const rv = Object.fromEntries(S.summary.coverages.map((c) => [c.cid, c]));
  h += `<div class="card"><div class="row"><h2 style="margin:0">담보별 요약표</h2>
    <button id="xAll">엑셀(전체)</button><button id="xSel">엑셀(선택 담보)</button><button id="jAll">JSON(전체)</button><button id="jSel">JSON(선택 담보)</button>
    <label class="chk"><input type="checkbox" id="selAll"> 전체 선택</label></div>
    <table class="grid" style="margin-top:8px"><thead><tr><th></th><th>ID</th><th>담보명</th><th>시작</th><th>끝</th><th>유형</th><th>지급사유 조문(쪽)</th><th>별표(쪽)</th><th>조문 수</th><th>검토</th></tr></thead><tbody>
    ${r.summary.map((s) => {
      const c = rv[s.cid] || {};
      const p = c.payout;
      return `<tr><td><input type="checkbox" class="xsel" value="${s.cid}"></td><td>${cv(s.cid).split("</span>")[0]}</span></td><td>${esc(s.name)}</td><td>${pg(s.start)}</td><td>${pg(s.end)}</td>
      <td>${esc(c.type || s.type)}${c.type_edited ? '<span class="tag warn">수정</span>' : ""}</td>
      <td>${p ? `${esc(p.key)} ${esc(p.title)} (${pg(p.page)})` : '<span class="tag warn">없음</span>'}</td>
      <td>${s.annexes.map((a) => `${esc(a.key)} ${esc(a.title)} (${pg(a.page)})`).join("<br>")}</td>
      <td>${s.n_articles}</td><td>${c.review && c.review.status === "검토완료" ? '<span class="tag ok">검토완료</span>' : '<span class="tag">미검토</span>'}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  $("#reportBody").innerHTML = h;
  bindJumps($("#reportBody"));
  const sel = () => $$(".xsel:checked").map((x) => x.value);
  $("#selAll").addEventListener("change", (e) => $$(".xsel").forEach((x) => (x.checked = e.target.checked)));
  $("#xAll").onclick = () => saveFile(fname("변환결과", "xlsx"), () => TT.exportExcel(S.doc));
  $("#jAll").onclick = () => saveFile(fname("변환결과", "zip"), () => TT.exportZip(S.doc));
  $("#xSel").onclick = () => { const s = sel(); if (!s.length) return toast("담보를 선택하세요.", true); saveFile(fname("선택담보", "xlsx"), () => TT.exportExcel(S.doc, s)); };
  $("#jSel").onclick = () => { const s = sel(); if (!s.length) return toast("담보를 선택하세요.", true); saveFile(fname("선택담보", "zip"), () => TT.exportZip(S.doc, s)); };
}

function bindJumps(root) {
  $$("[data-page]", root).forEach((e) => e.addEventListener("click", (ev) => { ev.stopPropagation(); showTab("verify"); gotoPage(+e.dataset.page); }));
  $$("[data-cov]", root).forEach((e) => e.addEventListener("click", (ev) => { ev.stopPropagation(); showTab("verify"); openCov(e.dataset.cov); }));
}

// ------------------------------------------------------------ 담보 목록
function renderCovList() {
  const types = S.summary.types;
  const sel = $("#covType");
  if (sel.options.length <= 1) types.forEach((t) => sel.add(new Option(t, t)));
  const q = $("#covSearch").value.replace(/\s/g, "");
  const ft = sel.value, fr = $("#covReview").value;
  const items = S.summary.coverages.filter((c) => (!q || c.name.replace(/\s/g, "").includes(q) || c.cid.includes(q))
    && (!ft || c.type === ft) && (!fr || c.review.status === fr));
  $("#covItems").innerHTML = items.map((c) => `<div class="cov ${c.cid === S.cov ? "on" : ""}" data-c="${c.cid}">
    <span class="rv ${c.review.status === "검토완료" ? "done" : "todo"}">${c.review.status === "검토완료" ? "✔ 검토완료" : "미검토"}</span>
    <div>${esc(c.name)}</div><div class="meta">${c.cid} · ${esc(c.type)} · ${c.start ?? "?"}–${c.end ?? "?"}쪽 · 조문 ${c.n_articles}</div></div>`).join("");
  $$("#covItems .cov").forEach((e) => e.addEventListener("click", () => openCov(e.dataset.c)));
}
["#covSearch", "#covType", "#covReview"].forEach((s) => $(s).addEventListener("input", renderCovList));

// ------------------------------------------------------------ 담보 패널
async function openCov(cid, jump = true) {
  S.cov = cid;
  S.covData = await api(`/api/docs/${S.doc}/coverage/${cid}`);
  renderCovList();
  renderPanel();
  if (jump && S.covData.coverage.start) gotoPage(S.covData.coverage.start);
  else drawOverlay();
}

function renderPanel() {
  const d = S.covData, c = d.coverage;
  const types = S.summary.types.map((t) => `<option ${t === c.type ? "selected" : ""}>${esc(t)}</option>`).join("");
  const k = c.key || {};
  const keyTag = (id, label) => id ? `<span class="pg" data-node="${esc(id)}">${esc(label)}: ${esc(nodeLabel(id))}</span>` : `<span class="tag warn">${esc(label)} 없음</span>`;
  let h = `<h3>${esc(c.name)}</h3>
  <div class="hint">${c.cid} · 목차 ${c.toc_label}쪽 · 머리글 쪽 ${c.header_pages}개 ${c.gaps && c.gaps.length ? `<span class="tag bad">쪽 끊김 ${c.gaps.map((g) => g.join("–")).join(", ")}</span>` : ""}</div>
  <div class="kv">
    <span class="k">검토 상태</span><span><button id="rvBtn">${d.review.status === "검토완료" ? "✔ 검토완료 (해제)" : "검토완료로 표시"}</button> <span class="hint">${esc(d.review.at || "")} ${esc(d.review.user || "")}</span></span>
    <span class="k">담보 유형</span><span><select id="cType">${types}</select> <span class="hint">자동: ${esc(c.type_auto)}</span>${c.type_edited ? '<span class="tag warn">수정됨</span>' : ""}</span>
    <span class="k">쪽 범위</span><span><input id="cStart" size="5" value="${c.start ?? ""}"> – <input id="cEnd" size="5" value="${c.end ?? ""}"> <button id="cRange">범위 저장</button> <span class="hint">목차 범위 ${c.toc_start}–${c.toc_end}</span>${c.range_edited ? '<span class="tag warn">수정됨</span>' : ""}</span>
    <span class="k">핵심 조문</span><span>${keyTag(k.payout, "지급사유")} · ${keyTag(k.detail, "세부규정")} · ${keyTag(k.exclusion, "면책")} · ${keyTag(k.benefit_table, "지급기준표")}</span>
  </div>
  <div class="ptabs">${[["terms", `조문 (${d.nodes.filter((n) => n.kind === "article").length})`], ["tables", `표 (${d.tables.length})`], ["refs", `참조 (${d.refs.length})`], ["inputs", "분석 입력 구성"]]
    .map(([t, l]) => `<button data-pt="${t}" class="${S.ptab === t ? "on" : ""}">${l}</button>`).join("")}</div>
  <div id="ptBody"></div>`;
  $("#panel").innerHTML = h;
  $$("#panel .ptabs button").forEach((b) => b.addEventListener("click", () => { S.ptab = b.dataset.pt; renderPanel(); }));
  $("#rvBtn").onclick = async () => {
    const st = d.review.status === "검토완료" ? "미검토" : "검토완료";
    await post(`/api/docs/${S.doc}/review`, { cid: c.cid, status: st, user: user() });
    toast(`검토 상태: ${st}`); await refresh();
  };
  $("#cType").onchange = async (e) => {
    await post(`/api/docs/${S.doc}/edits`, { action: "coverage_type", cid: c.cid, type: e.target.value, before: c.type, user: user() });
    toast("담보 유형을 수정했습니다."); await refresh();
  };
  $("#cRange").onclick = async () => {
    try {
      await post(`/api/docs/${S.doc}/edits`, { action: "coverage_range", cid: c.cid, start: +$("#cStart").value, end: +$("#cEnd").value, before: [c.start, c.end], user: user() });
      toast("쪽 범위를 수정했습니다. 조문을 다시 추출했습니다."); await refresh();
    } catch (e) { toast(e.message, true); }
  };
  $$("#panel [data-node]").forEach((e) => e.addEventListener("click", () => selectNode(e.dataset.node)));
  const body = $("#ptBody");
  if (S.ptab === "terms") renderTerms(body);
  else if (S.ptab === "tables") renderTables(body);
  else if (S.ptab === "refs") renderRefs(body);
  else renderInputs(body);
}

function nodeLabel(id) {
  const n = S.covData.nodes.find((x) => x.id === id);
  if (n) return `${n.key}${n.title ? " " + n.title : ""} (${n.page_start}쪽)`;
  return id.split("/").slice(1).join("/");
}

function renderTerms(body) {
  const d = S.covData;
  const editing = $("#editMode").checked;
  body.classList.toggle("editing", editing);
  const depth = (n) => { let k = 0, p = n.parent; const m = Object.fromEntries(d.nodes.map((x) => [x.id, x])); while (p) { k++; p = m[p] && m[p].parent; } return k; };
  const keyOf = new Set(Object.values(d.coverage.key || {}).filter(Boolean));
  body.innerHTML = `<p class="hint">조문을 누르면 원본 쪽으로 이동하고 해당 줄을 노란색으로 표시합니다. ${editing ? "수정 모드: 조문 제목줄의 [번호·제목]/[앞 조문에 합치기] 단추, 또는 원본 쪽의 줄을 눌러 새 조문을 시작할 수 있습니다." : "경계를 고치려면 위쪽 '조문 경계 수정'을 켭니다."}</p>` +
    d.nodes.map((n) => {
      const pad = depth(n) * 14;
      const label = n.kind === "article" || n.kind === "annex" ? `${n.key}${n.title ? "【" + n.title + "】" : ""}`
        : n.kind === "item" || n.kind === "sub" ? `${n.key}.` : n.kind === "box" ? (n.title || "설명") : n.kind === "part" || n.kind === "chap" ? `${n.key} ${n.title || ""}` : n.key;
      const snippet = n.kind === "article" || n.kind === "annex" || n.kind === "box" ? "" : esc((n.text || "").slice(0, 70));
      const open = S.openNodes.has(n.id);
      const forced = n.forced ? '<span class="tag warn">수정됨</span>' : "";
      const acts = (n.kind === "article" || n.kind === "annex") && n.parent === null && n.first_line ? `<span class="acts"><button data-ren="${esc(n.id)}">번호·제목</button><button data-mrg="${esc(n.id)}">앞 조문에 합치기</button></span>` : "";
      return `<div class="node k-${n.kind} ${S.selNode === n.id ? "on" : ""}" style="margin-left:${pad}px" data-n="${esc(n.id)}">${acts}<span class="nk">${esc(label)}</span>${keyOf.has(n.id) ? '<span class="tag key">핵심</span>' : ""}${forced}
        <span class="np">${n.page_start}${n.page_end !== n.page_start ? "–" + n.page_end : ""}쪽</span> ${snippet}</div>
        ${open && n.text ? `<div class="ntext" style="margin-left:${pad}px">${esc(n.text)}</div>` : ""}`;
    }).join("");
  $$(".node", body).forEach((e) => e.addEventListener("click", (ev) => {
    if (ev.target.tagName === "BUTTON") return;
    const id = e.dataset.n;
    if (S.openNodes.has(id)) S.openNodes.delete(id); else S.openNodes.add(id);
    selectNode(id, true);
  }));
  $$("[data-ren]", body).forEach((b) => b.addEventListener("click", () => renameNode(b.dataset.ren)));
  $$("[data-mrg]", body).forEach((b) => b.addEventListener("click", () => mergeNode(b.dataset.mrg)));
}

function renderTableHTML(t) {
  const rows = [];
  for (let r = 0; r < t.n_rows; r++) {
    const cells = t.cells.filter((c) => c.r === r).sort((a, b) => a.c - b.c);
    rows.push(`<tr>${cells.map((c) => `<td${c.rs > 1 ? ` rowspan="${c.rs}"` : ""}${c.cs > 1 ? ` colspan="${c.cs}"` : ""}>${esc(c.text)}</td>`).join("")}</tr>`);
  }
  return `<table class="term">${rows.join("")}</table>`;
}

function renderTables(body) {
  const d = S.covData;
  body.innerHTML = d.tables.length ? d.tables.map((t) => `<div class="tblhead"><b>${esc(t.id)}</b> · ${pg(t.page)}쪽 · 소속 ${esc(t.owner ? nodeLabel(t.owner) : "없음")}
    ${t.caption ? ` · 제목줄 "${esc(t.caption)}"` : ""} ${t.complete ? '<span class="tag ok">추출 완전</span>' : `<span class="tag bad">표 추출 불완전: ${esc(t.problems.join("; "))}</span>`}
    ${t.continued_from ? `<span class="tag">앞 쪽 ${esc(t.continued_from)}에서 이어짐</span>` : ""}${t.continues_to ? `<span class="tag">다음 쪽 ${esc(t.continues_to)}로 이어짐</span>` : ""}
</div>${renderTableHTML(t)}`).join("")
    : '<p class="hint">이 담보에서 추출한 표가 없습니다.</p>';
  bindJumps(body);
}

function renderRefs(body) {
  const d = S.covData;
  const order = { "미해결": 0, "각 특약 조문": 1, "연결": 2 };
  const refs = [...d.refs].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
  body.innerHTML = refs.length ? tbl(["상태", "종류", "참조 표현", "대상", "쪽", "사유·문맥"], refs.map((r) => `<tr>
    <td>${r.status === "연결" ? '<span class="tag ok">연결</span>' : r.status === "미해결" ? '<span class="tag bad">참조 미해결</span>' : `<span class="tag">${esc(r.status)}</span>`}</td>
    <td>${esc(r.kind)}</td><td>${esc(r.raw)}</td>
    <td>${r.target ? `<span class="pg" data-tnode="${esc(r.target)}" data-tcid="${esc(r.target_cid || "")}">${esc(r.target.length > 60 ? "…" + r.target.slice(-60) : r.target)}</span>` : ""}</td>
    <td>${pg(r.src_page)}</td><td>${esc(r.reason)}<div class="hint">${esc(r.ctx)}</div></td></tr>`)) : '<p class="hint">참조 표현이 없습니다.</p>';
  bindJumps(body);
  $$("[data-tnode]", body).forEach((e) => e.addEventListener("click", async () => {
    const id = e.dataset.tnode, tc = e.dataset.tcid;
    if (tc && tc !== S.cov && !id.includes("/")) { await openCov(tc); return; }
    if (tc && tc !== S.cov) { await openCov(tc, false); }
    selectNode(id);
  }));
}

function renderInputs(body) {
  const i = S.covData.inputs;
  const list = (arr) => arr.length ? `<ul>${arr.map((n) => `<li>${n.missing ? esc(n.id) : `<span class="pg" data-tnode="${esc(n.id)}" data-tcid="${esc(n.cid)}">${esc(n.key)} ${esc(n.title)}</span> <span class="hint">(${n.cid}, ${n.page}쪽)</span>`}</li>`).join("")}</ul>` : '<p class="hint">없음</p>';
  body.innerHTML = `<p class="hint">2단계 이후 AI에는 이 담보에 대해 아래 구성만 전달합니다(매칭 규칙 6). 승인 전에는 AI 해석을 실행하지 않습니다.</p>
    <h4>(a) 이 담보 구간 전체</h4>${list(i.own)}
    <h4>(b) 특약 공통 조항 중 참조하는 조문</h4>${list(i.common_refs)}
    <h4>(c) 준용·참조하는 보통약관 조문</h4>${list(i.main_refs)}
    <h4>전체 적용·준용 표시</h4>${i.whole.length ? `<ul>${i.whole.map((w) => `<li>${esc(w.kind)} → <span class="pg" data-cov="${w.cid}">${esc(w.cid)} ${esc(w.name)}</span></li>`).join("")}</ul>` : '<p class="hint">없음</p>'}
    <h4>(d) 본문이 참조하는 다른 구간의 별표</h4>${list(i.annex_refs)}
    <h4>(d) 본문이 참조하는 인용조문(법령)</h4>${list(i.law_refs)}`;
  bindJumps(body);
  $$("[data-tnode]", body).forEach((e) => e.addEventListener("click", async () => {
    const tc = e.dataset.tcid;
    if (tc && tc !== S.cov) await openCov(tc, false);
    selectNode(e.dataset.tnode);
  }));
}

// ------------------------------------------------------------ 조문 선택·강조
async function selectNode(id, rerender) {
  S.selNode = id;
  S.quoteHL = null;
  try { S.selNodeFull = await api(`/api/docs/${S.doc}/node?id=${encodeURIComponent(id)}`); }
  catch (e) { toast(e.message, true); return; }
  const p = S.selNodeFull.page_start;
  if (rerender || S.ptab === "terms") { if (S.ptab !== "terms") S.ptab = "terms"; renderPanel(); }
  await gotoPage(p);
  const el = $(`#panel .node.on`);
  if (el) el.scrollIntoView({ block: "nearest" });
}

// ------------------------------------------------------------ 쪽 보기
async function gotoPage(p) {
  if (!S.doc) return;
  const total = S.summary.doc.page_count;
  p = Math.max(1, Math.min(total, p | 0));
  S.page = p;
  $("#pNum").value = p;
  const img = $("#pageImg");
  S.lines = await api(`/api/docs/${S.doc}/page/${p}/lines`);
  if (!S.fitted) {
    // 처음 한 번은 보기 칸 너비에 맞춥니다. 이후에는 ＋/－ 단추로 조절합니다.
    const w = $("#pageWrap").clientWidth - 24;
    if (w > 200) { S.scale = Math.max(0.6, Math.min(2.6, +(w / S.lines.w).toFixed(2))); S.fitted = true; }
  }
  const want = p, sc = S.scale;
  TT.pageImage(S.doc, p, sc).then((src) => { if (S.page === want && S.scale === sc) img.src = src; }).catch((e) => toast("쪽 그림을 그리지 못했습니다: " + e.message, true));
  $("#pageBox").style.width = Math.round(S.lines.w * S.scale) + "px";
  const r = S.lines.row;
  $("#pageInfo").innerHTML = `PDF ${p}쪽 · 인쇄 쪽번호 ${r.printed ?? "없음"} · 머리글 "${esc(S.lines.header || "없음")}" · 배정 ${r.cid ? cv(r.cid) : "미배정"} (${esc(r.source)})
    ${r.mismatch ? '<span class="mm"> · 목차·머리글 불일치</span>' : ""}${r.internal_toc ? " · 담보 자체 목차 쪽(조문 추출 제외)" : ""}${r.low_text ? " · 텍스트 적음" : ""}`;
  bindJumps($("#pageInfo"));
  drawOverlay();
}

function drawOverlay() {
  const ov = $("#overlay");
  if (!S.lines) { ov.innerHTML = ""; return; }
  const s = S.scale, p = S.page;
  const parts = [];
  const box = (b, cls, extra = "") => `<div class="ov ${cls}" ${extra} style="left:${b[0] * s - 2}px;top:${b[1] * s - 1}px;width:${(b[2] - b[0]) * s + 4}px;height:${(b[3] - b[1]) * s + 2}px"></div>`;
  if ($("#showTables").checked) S.lines.tables.forEach((t) => parts.push(box(t.bbox, t.kind === "table" ? "tbl" + (t.complete ? "" : " bad") : "box")));
  if (S.selNodeFull) {
    const want = new Set();
    const collect = (n) => { n.lines.forEach(([pp, i]) => { if (pp === p) want.add(i); }); };
    collect(S.selNodeFull);
    // 하위 항·호·목 줄도 함께 강조
    const kids = S.covData ? S.covData.nodes.filter((n) => n.id.startsWith(S.selNodeFull.id + "/")) : [];
    S.lines.lines.forEach((l) => { if (l.owner && (l.owner === S.selNodeFull.id || kids.some((k) => k.id === l.owner))) want.add(l.i); });
    S.lines.lines.forEach((l) => { if (want.has(l.i)) parts.push(box(l.b, "hl")); });
  }
  if (S.quoteHL && S.quoteHL.page === p) {
    if (S.quoteHL.bbox) parts.push(box(S.quoteHL.bbox, "q"));
    S.lines.lines.forEach((l) => { if (S.quoteHL.lines.includes(l.i)) parts.push(box(l.b, "q")); });
  }
  if ($("#editMode").checked) {
    const heads = new Set((S.covData ? S.covData.nodes : []).filter((n) => n.first_line && n.first_line[0] === p && (n.kind === "article" || n.kind === "annex") && n.parent === null).map((n) => n.first_line[1]));
    S.lines.lines.forEach((l) => parts.push(box(l.b, "ln" + (heads.has(l.i) ? " head" : ""), `data-li="${l.i}" title="${esc(l.t)}"`)));
  }
  ov.innerHTML = parts.join("");
  $$(".ov.ln", ov).forEach((e) => e.addEventListener("click", () => lineClicked(+e.dataset.li)));
  const first = $(".ov.q", ov) || $(".ov.hl", ov);
  if (first) {
    const wrap = $("#pageWrap");
    const top = first.offsetTop - 60;
    if (top < wrap.scrollTop || top > wrap.scrollTop + wrap.clientHeight - 80) wrap.scrollTop = Math.max(0, top);
  }
}

$("#pPrev").onclick = () => gotoPage(S.page - 1);
$("#pNext").onclick = () => gotoPage(S.page + 1);
$("#pNum").addEventListener("change", (e) => gotoPage(+e.target.value));
$("#zIn").onclick = () => { S.fitted = true; S.scale = Math.min(2.6, +(S.scale + 0.2).toFixed(1)); gotoPage(S.page); };
$("#zOut").onclick = () => { S.fitted = true; S.scale = Math.max(0.8, +(S.scale - 0.2).toFixed(1)); gotoPage(S.page); };
$("#toStart").onclick = () => { if (S.covData && S.covData.coverage.start) gotoPage(S.covData.coverage.start); };
$("#showTables").onchange = drawOverlay;
$("#editMode").onchange = () => { drawOverlay(); if (S.covData) renderPanel(); };
document.addEventListener("keydown", (e) => {
  if (!$("#tab-verify").classList.contains("on") || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  if (e.key === "ArrowRight" || e.key === "PageDown") gotoPage(S.page + 1);
  if (e.key === "ArrowLeft" || e.key === "PageUp") gotoPage(S.page - 1);
});

// ------------------------------------------------------------ 경계 수정
function dialog(title, html) {
  return new Promise((res) => {
    $("#dlgTitle").textContent = title;
    $("#dlgBody").innerHTML = html;
    const d = $("#dlg");
    d.returnValue = "";
    d.showModal();
    d.addEventListener("close", function h() { d.removeEventListener("close", h); res(d.returnValue === "ok"); });
  });
}

function guessHeading(t) {
  let m = t.match(/^제\s*(\d+)(?:\s*-\s*(\d+))?\s*조(?:\s*의\s*(\d+))?\s*[【(]?\s*([^】)]*)/);
  if (m) return { key: `제${m[1]}${m[2] ? "-" + m[2] : ""}조${m[3] ? "의" + m[3] : ""}`, title: (m[4] || "").trim() };
  m = t.match(/^\[?\s*별표\s*(\d+(?:\s*-\s*\d+)?)\s*\]?\s*(.*)$/);
  if (m) return { key: "별표" + m[1].replace(/\s/g, ""), title: m[2].trim() };
  return { key: "", title: "" };
}

async function lineClicked(i) {
  const l = S.lines.lines[i];
  const cid = S.lines.row.cid;
  if (!cid) return toast("이 쪽은 어느 담보에도 배정되지 않았습니다. 먼저 담보의 쪽 범위를 수정하세요.", true);
  const g = guessHeading(l.t);
  const ok = await dialog("이 줄에서 새 조문(또는 별표) 시작", `<div class="quote">${esc(l.t)}</div>
    <p class="hint">${S.page}쪽 ${i + 1}번째 줄. 이 줄부터 다음 조문 머리 전까지가 새 조문이 됩니다. 이미 조문 머리인 줄이면 번호·제목만 바뀝니다.</p>
    <label>번호 (예: 제2-3조, 제2-1조의2, 별표2-1) <input id="fKey" value="${esc(g.key)}"></label>
    <label>제목 <input id="fTitle" value="${esc(g.title)}"></label>`);
  if (!ok) return;
  try {
    await post(`/api/docs/${S.doc}/edits`, { action: "split", cid, page: S.page, line: i, key: $("#fKey").value.trim(), title: $("#fTitle").value.trim(), before: l.t, user: user() });
    toast("조문 경계를 수정했습니다."); await refresh(); await gotoPage(S.page);
  } catch (e) { toast(e.message, true); }
}

async function renameNode(id) {
  const n = S.covData.nodes.find((x) => x.id === id);
  const ok = await dialog("조문 번호·제목 수정", `<label>번호 <input id="fKey" value="${esc(n.key)}"></label><label>제목 <input id="fTitle" value="${esc(n.title || "")}"></label>`);
  if (!ok) return;
  try {
    await post(`/api/docs/${S.doc}/edits`, { action: "rename", cid: n.cid, page: n.first_line[0], line: n.first_line[1], key: $("#fKey").value.trim(), title: $("#fTitle").value.trim(), before: `${n.key} ${n.title || ""}`, user: user() });
    toast("수정했습니다."); await refresh();
  } catch (e) { toast(e.message, true); }
}

async function mergeNode(id) {
  const n = S.covData.nodes.find((x) => x.id === id);
  if (!(await ask(`${n.key} ${n.title || ""} 의 머리를 해제하여 앞 조문에 합칩니다. 계속할까요?`))) return;
  try {
    await post(`/api/docs/${S.doc}/edits`, { action: "merge", cid: n.cid, page: n.first_line[0], line: n.first_line[1], before: `${n.key} ${n.title || ""}`, user: user() });
    toast("앞 조문에 합쳤습니다."); S.selNode = null; S.selNodeFull = null; await refresh();
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------ 수정 이력·승인
const ACT = { coverage_range: "쪽 범위", coverage_type: "담보 유형", split: "조문 시작", rename: "번호·제목", merge: "앞 조문에 합치기" };
async function loadEdits() {
  if (!S.doc) return;
  const { edits } = await api(`/api/docs/${S.doc}/edits`);
  const tb = $("#editList tbody");
  const desc = (e) => e.action === "coverage_range" ? `${e.start}–${e.end}쪽 (이전 ${JSON.stringify(e.before ?? "")})`
    : e.action === "coverage_type" ? `${e.type} (이전 ${e.before ?? ""})`
    : e.action === "merge" ? `${e.page}쪽 ${+e.line + 1}번째 줄 머리 해제 (${e.before ?? ""})`
    : `${e.page}쪽 ${+e.line + 1}번째 줄 → ${e.key} ${e.title || ""} (이전: ${e.before ?? ""})`;
  tb.innerHTML = edits.slice().reverse().map((e) => `<tr style="${e.active ? "" : "opacity:.5"}"><td>${esc(e.at)}</td><td>${esc(e.user)}</td><td>${ACT[e.action] || e.action}</td><td>${cv(e.cid)}</td><td>${esc(desc(e))}${e.active ? "" : ` <span class="tag">되돌림 ${esc(e.undone_at || "")}</span>`}</td>
    <td>${e.active ? `<button data-undo="${e.eid}">되돌리기</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="hint">수정 이력이 없습니다.</td></tr>`;
  $$("[data-undo]", tb).forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/docs/${S.doc}/edits/${b.dataset.undo}?user=${encodeURIComponent(user())}`, { method: "DELETE" });
    toast("되돌렸습니다."); await refresh();
  }));
  bindJumps(tb);
}

$("#apprBadge").addEventListener("click", async () => {
  if (!S.summary) return;
  const a = S.summary.approval || {};
  if (a.approved) {
    if (!(await ask("변환 승인을 취소합니다. 계속할까요?"))) return;
    S.summary.approval = await post(`/api/docs/${S.doc}/approval`, { approved: false, user: user() });
    renderApproval(); if (window.clsLoad) window.clsLoad(); if (window.anLoad) window.anLoad(); if (window.cmpLoad) window.cmpLoad(); return;
  }
  const r = S.report;
  const todo = S.summary.coverages.filter((c) => c.review.status !== "검토완료" && c.type !== "부속자료").length;
  const ok = await dialog("변환 승인", `<p>승인하면 이 변환 결과를 2단계 이후(AI 해석)의 입력으로 확정합니다. 승인 후 수정하면 승인은 자동으로 해제됩니다.</p>
    <ul><li>검토완료가 아닌 담보: <b>${todo}</b>개</li><li>목차·머리글 불일치 쪽: ${r.mismatch_pages.length}개</li><li>지급사유 없는 담보: ${r.no_payout.length}개</li>
    <li>참조 미해결: ${r.unresolved_refs.length}건</li><li>표 추출 불완전: ${r.table_incomplete.length}건</li></ul>
    <p class="hint">작업자: ${esc(user() || "(이름 미입력)")}</p>`);
  if (!ok) return;
  S.summary.approval = await post(`/api/docs/${S.doc}/approval`, { approved: true, user: user() });
  renderApproval(); toast("변환을 승인했습니다."); if (window.clsLoad) window.clsLoad(); if (window.anLoad) window.anLoad(); if (window.cmpLoad) window.cmpLoad();
});
$("#apprBadge").style.cursor = "pointer";
$("#apprBadge").title = "눌러서 변환 승인 / 승인 취소";

// ------------------------------------------------------------ 시작
(async function init() {
  try { $("#user").value = localStorage.getItem("user") || ""; } catch (e) { /* 저장 불가 */ }
  $("#user").addEventListener("change", () => { try { localStorage.setItem("user", user()); } catch (e) { /* 저장 불가 */ } });
  await loadDocs();
  let last = null, tab = null;
  try { last = localStorage.getItem("doc"); tab = localStorage.getItem("tab"); } catch (e) { /* 저장 불가 */ }
  if (last) { try { await openDoc(last); if (tab) showTab(tab); } catch (e) { /* 지워진 문서 */ } }
})();

// 근거 인용 보기: 검증 화면에서 해당 쪽으로 이동하고 인용 문장이 걸친 줄을 주황색으로 강조합니다.
window.showQuote = async function (docId, cid, ev) {
  const qs = ev.kind === "table" ? `table=${encodeURIComponent(ev.id)}` : `node=${encodeURIComponent(ev.id)}&quote=${encodeURIComponent(ev.quote || "")}`;
  let loc;
  try { loc = await api(`/api/docs/${docId}/locate?${qs}`); } catch (e) { return toast(e.message, true); }
  showTab("verify");
  const target = loc.cid || cid;
  if (target && S.cov !== target) await openCov(target, false);
  S.selNode = null; S.selNodeFull = null;
  S.quoteHL = { page: loc.page, lines: loc.lines || [], bbox: loc.bbox || null };
  await gotoPage(loc.page);
  if (loc.found === false) toast("인용 문장의 정확한 줄을 찾지 못해 조문 첫 줄을 표시합니다.", true);
};
