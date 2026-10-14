"use strict";
// 5단계: 구약관 대비 비교 화면

const K = { view: null, open: null };

window.cmpLoad = async function () {
  if (!S.doc) return;
  try { K.view = await api(`/api/docs/${S.doc}/compare`); } catch (e) { return toast(e.message, true); }
  const sel = $("#cmpOld");
  const cur = K.view.data ? K.view.data.old_doc : "";
  sel.innerHTML = '<option value="">구약관 문서를 고르세요</option>' + K.view.candidates.map((d) =>
    `<option value="${d.id}" ${d.id === cur ? "selected" : ""} ${d.approved ? "" : "disabled"}>${esc(d.filename)} (${d.page_count}쪽)${d.approved ? "" : " — 미승인"}</option>`).join("");
  cmpRender();
};

const ST = { "신규": "ok", "변경": "warn", "삭제": "bad", "동일": "" };

function cmpRender() {
  const d = K.view.data;
  if (!d) { $("#cmpSummary").innerHTML = ""; $("#cmpTable").innerHTML = '<p class="hint">비교 결과가 없습니다. 구약관을 고르고 [비교 실행]을 누르세요.</p>'; $("#cmpDetail").innerHTML = ""; return; }
  $("#cmpSummary").innerHTML = `<div class="kpis">${["변경", "신규", "삭제", "동일"].map((s) => `<div class="kpi ${s === "변경" ? "warn" : s === "삭제" ? "bad" : ""}"><div class="v">${d.counts[s]}</div><div class="l">${s}</div></div>`).join("")}</div>
    <p class="hint">구약관: ${esc(d.old_filename)} · 비교 ${esc(d.generated_at)}</p>`;
  const only = $("#cmpOnlyChanged").checked;
  const olds = d.pairs.filter((p) => p.old).map((p) => [p.old, p.old_name]);
  const rows = d.pairs.filter((p) => !only || p.status !== "동일");
  $("#cmpTable").innerHTML = rows.length ? `<table class="grid"><thead><tr><th>변경구분</th><th>의견</th><th>신약관 담보</th><th>구약관 담보(짝 바꾸기)</th><th>매칭</th><th>ECS 룰 수정 필요 필드</th><th></th></tr></thead><tbody>
    ${rows.map((p) => `<tr><td><span class="tag ${ST[p.status]}">${p.status}</span></td><td>${esc(p.opinion)}</td>
      <td>${p.new ? `${esc(p.new_name)} <span class="hint">${p.new} · ${p.new_range.join("–")}쪽</span>` : '<span class="hint">없음</span>'}</td>
      <td>${p.new ? `<select data-new="${p.new}"><option value="">(짝 없음 — 신규)</option>${olds.map(([c, n]) => `<option value="${c}" ${c === p.old ? "selected" : ""}>${esc(n)} (${c})</option>`).join("")}</select>`
        : `${esc(p.old_name)} <span class="hint">${p.old} · ${p.old_range.join("–")}쪽</span>`}</td>
      <td class="hint">${p.how}${p.old && p.new ? " " + p.score : ""}</td>
      <td>${esc(p.fields.join(", "))}<div class="hint">${esc(p.field_source)}</div></td>
      <td><button data-open="${p.new || p.old}">상세</button></td></tr>`).join("")}</tbody></table>` : '<p class="hint">변경된 담보가 없습니다.</p>';
  $$("#cmpTable select[data-new]").forEach((s) => s.addEventListener("change", async () => {
    try { K.view.data = (await post(`/api/docs/${S.doc}/compare/match`, { new: s.dataset.new, old: s.value, user: user() })).data; toast("담보 짝을 바꿨습니다."); cmpRender(); }
    catch (e) { toast(e.message, true); }
  }));
  $$("#cmpTable [data-open]").forEach((b) => b.addEventListener("click", () => { K.open = b.dataset.open; cmpDetail(); }));
  cmpDetail();
}

function opsHTML(ops, side) {
  return ops.filter(([op]) => op === "=" || op === side).map(([op, t]) => op === "=" ? esc(t) : op === "-" ? `<del>${esc(t)}</del>` : `<ins>${esc(t)}</ins>`).join(" ");
}

function cmpDetail() {
  const d = K.view.data;
  const p = d && d.pairs.find((x) => x.new === K.open || (!x.new && x.old === K.open));
  if (!p) { $("#cmpDetail").innerHTML = '<p class="hint">표에서 [상세]를 누르면 조문별 구·신 원문 대조가 나옵니다.</p>'; return; }
  const arts = p.articles.filter((a) => a.status !== "동일");
  $("#cmpDetail").innerHTML = `<h3>${esc(p.new_name || p.old_name)} <span class="tag ${ST[p.status]}">${p.status}</span> ${esc(p.opinion)}</h3>
    <p class="hint">바뀐 조문 ${arts.length}개 / 전체 ${p.articles.length}개. 빨간 줄은 구약관에서 빠진 부분, 초록은 신약관에서 더해진 부분입니다. 쪽번호를 누르면 원본을 엽니다.</p>
    ${arts.map((a) => `<h4>${esc(a.key)}${a.old_key && a.old_key !== a.key ? ` (구 ${esc(a.old_key)})` : ""} ${esc(a.title)} <span class="tag ${ST[a.status]}">${a.status}</span> <span class="tag ${a.opinion === "의미 변경 가능성 높음" ? "bad" : ""}">${esc(a.opinion)}</span></h4>
      <div class="hint">ECS 수정 필요 필드(추정): ${esc(a.fields.join(", ") || "없음")}</div>
      <div class="cmpcols"><div><b>구약관</b> ${a.old_page ? `<span class="pg" data-oldp="${a.old_page}">${a.old_page}쪽</span>` : ""}<br>${opsHTML(a.ops, "-")}</div>
      <div><b>신약관</b> ${a.new_page ? `<span class="pg" data-newp="${a.new_page}" data-c="${p.new}">${a.new_page}쪽</span>` : ""}<br>${opsHTML(a.ops, "+")}</div></div>`).join("") || '<p class="hint">바뀐 조문이 없습니다.</p>'}`;
  $$("#cmpDetail [data-oldp]").forEach((e) => e.addEventListener("click", () => window.open(`/api/docs/${d.old_doc}/page/${e.dataset.oldp}.png?scale=1.6`, "_blank")));
  $$("#cmpDetail [data-newp]").forEach((e) => e.addEventListener("click", async () => { showTab("verify"); await openCov(e.dataset.c, false); gotoPage(+e.dataset.newp); }));
}

$("#cmpRun").onclick = async () => {
  const old = $("#cmpOld").value;
  if (!old) return toast("구약관 문서를 고르세요.", true);
  toast("비교 중입니다…");
  try { K.view.data = (await post(`/api/docs/${S.doc}/compare`, { old_doc: old, user: user() })).data; toast("비교를 마쳤습니다."); cmpRender(); }
  catch (e) { toast(e.message, true); }
};
$("#cmpOnlyChanged").addEventListener("change", () => K.view && cmpRender());
$("#cmpX").onclick = () => { if (!K.view || !K.view.data) return toast("비교 결과가 없습니다.", true); location.href = `/api/docs/${S.doc}/compare.xlsx?all=${!$("#cmpOnlyChanged").checked}`; };
