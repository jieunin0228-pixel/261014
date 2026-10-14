"use strict";
// 3·4단계: 담보별 결과 카드와 ECS 룰 입력 초안 화면

const A = { view: null, cid: null, data: null, sub: "card", checked: new Set() };

window.anLoad = async function () {
  if (!S.doc) return;
  try { A.view = await api(`/api/docs/${S.doc}/analysis`); } catch (e) { return toast(e.message, true); }
  const p = A.view.product || {};
  $("#pCode").value = p["상품코드"] || ""; $("#pName").value = p["상품명"] || ""; $("#pDate").value = p["판매개시일자"] || "";
  const m = A.view.master;
  $("#mStatus").textContent = m.loaded ? `적용 중 (${m.imported_at}, 필드 ${Object.keys(m.fields).length}개)` : "없음 — 코드는 비우고 명칭만 적은 뒤 '코드 확인 필요'로 표시합니다.";
  anBanner(); anList();
  if (A.cid) anOpen(A.cid);
};

function anBanner() {
  const v = A.view, b = $("#anBanner");
  const msgs = [];
  if (!v.approved) msgs.push('<div class="banner bad">1단계 변환이 승인되지 않아 AI 해석(3·4단계)을 실행할 수 없습니다. 검증 후 화면 오른쪽 위 [변환 미승인]을 눌러 승인하세요.</div>');
  if (!v.ai_available) msgs.push('<div class="banner warn">ANTHROPIC_API_KEY 환경변수가 없어 AI 해석을 실행할 수 없습니다. README의 \'AI 사용 설정\'대로 키를 넣고 프로그램을 다시 실행하세요. 이미 만든 결과는 볼 수 있습니다.</div>');
  if (v.approved && v.ai_available) msgs.push(`<div class="banner ok">AI 해석 준비됨(모델 ${esc(v.model)}). 담보마다 그 담보의 조문과 참조 조문·표만 보냅니다. 근거 인용이 원문과 맞지 않는 항목은 '근거 불일치'로 격리합니다.</div>`);
  b.innerHTML = msgs.join("");
  const off = !(v.approved && v.ai_available);
  ["#anCards", "#anEcs", "#anBoth"].forEach((s) => ($(s).disabled = off));
}

function anList() {
  const v = A.view;
  const sel = new Set(v.selected);
  const only = $("#anOnlySel").checked && sel.size;
  const q = $("#anSearch").value.replace(/\s/g, "");
  const items = v.coverages.filter((c) => (!only || sel.has(c.cid)) && (!q || c.name.replace(/\s/g, "").includes(q)));
  $("#anItems").innerHTML = (only ? "" : (sel.size ? "" : '<p class="hint">2단계에서 선택한 담보가 없어 전체를 보여 줍니다.</p>')) +
    items.map((c) => `<div class="anit ${c.cid === A.cid ? "on" : ""}" data-c="${c.cid}">
      <input type="checkbox" class="anck" value="${c.cid}" ${A.checked.has(c.cid) ? "checked" : ""}>
      <div><div>${esc(c.display_name || c.name)}</div><div class="meta">${c.cid} · ${esc(c.class || c.type)} ·
      ${c.has_card ? '<span class="tag ok">카드</span>' : '<span class="tag">카드 없음</span>'} ${c.has_ecs ? '<span class="tag ok">ECS</span>' : '<span class="tag">ECS 없음</span>'}</div></div></div>`).join("");
  $$("#anItems .anit").forEach((e) => e.addEventListener("click", (ev) => { if (ev.target.classList.contains("anck")) return; anOpen(e.dataset.c); }));
  $$("#anItems .anck").forEach((e) => e.addEventListener("change", () => (e.checked ? A.checked.add(e.value) : A.checked.delete(e.value))));
  A.shown = items.map((c) => c.cid);
}
["#anOnlySel", "#anSearch"].forEach((s) => $(s).addEventListener("input", () => A.view && anList()));
$("#anAll").addEventListener("change", (e) => { (A.shown || []).forEach((c) => (e.target.checked ? A.checked.add(c) : A.checked.delete(c))); anList(); });

async function anOpen(cid) {
  A.cid = cid;
  $$("#anItems .anit").forEach((e) => e.classList.toggle("on", e.dataset.c === cid));
  try { A.data = await api(`/api/docs/${S.doc}/card/${cid}`); } catch (e) { return toast(e.message, true); }
  anRender();
}

function evHTML(evs) {
  return (evs || []).map((e, k) => `<span class="ev ${e.verified ? "" : "bad"}">${e.verified ? "" : "✖ 원문 불일치 "}
    <span class="pg" data-ev="${k}">${esc(e.id ? e.id.split("/").slice(-2).join("/") : e.ref)} · ${e.page ?? "?"}쪽</span>“${esc(e.quote)}”</span>`).join("");
}

function anRender() {
  const d = A.data, c = A.view.coverages.find((x) => x.cid === A.cid) || {};
  let h = `<h3>${esc(c.display_name || c.name || A.cid)}</h3><div class="hint">${A.cid} · ${esc(c.class || "")}</div>
    <div class="ptabs"><button data-st="card" class="${A.sub === "card" ? "on" : ""}">결과 카드(3단계)</button><button data-st="ecs" class="${A.sub === "ecs" ? "on" : ""}">ECS 룰 입력 초안(4단계)</button></div>`;
  if (d.stale) h += '<div class="banner warn">이 결과는 현재 승인본보다 이전 승인본으로 만들었습니다. 다시 만들어야 최신 변환이 반영됩니다.</div>';
  h += A.sub === "card" ? cardHTML(d.card) : ecsHTML(d.ecs, d.compare_mode);
  $("#anPanel").innerHTML = h;
  $$("#anPanel .ptabs button").forEach((b) => b.addEventListener("click", () => { A.sub = b.dataset.st; anRender(); }));
  bindEv();
}

function bindEv() {
  $$("#anPanel [data-evsrc]").forEach((box) => {
    const evs = JSON.parse(box.dataset.evsrc);
    $$("[data-ev]", box).forEach((e) => e.addEventListener("click", () => showQuote(S.doc, null, evs[+e.dataset.ev])));
  });
  $$("#anPanel [data-rv]").forEach((b) => b.addEventListener("click", async () => {
    await post(`/api/docs/${S.doc}/card/${A.cid}/review`, { item: b.dataset.rv, status: b.dataset.to, user: user() });
    anOpen(A.cid);
  }));
  $$("#anPanel [data-erv]").forEach((b) => b.addEventListener("click", async () => {
    await post(`/api/docs/${S.doc}/ecs/${A.cid}/review`, { row: b.dataset.erv, field: b.dataset.f || null, status: b.dataset.to, user: user() });
    anOpen(A.cid);
  }));
  $$("#anPanel [data-edit]").forEach((b) => b.addEventListener("click", () => editCell(b.dataset.edit, b.dataset.f)));
  $$("#anPanel [data-tbl]").forEach((b) => b.addEventListener("click", () => showQuote(S.doc, null, { kind: "table", id: b.dataset.tbl })));
}

const evBox = (evs) => `<div data-evsrc="${esc(JSON.stringify(evs || []))}">${evHTML(evs)}</div>`;
const chk = (s) => s === "근거 확인" ? '<span class="tag ok">근거 확인</span>' : s === "근거 불일치" ? '<span class="tag bad">근거 불일치</span>'
  : s === "약관에 명시 없음" ? '<span class="tag warn">약관에 명시 없음</span>' : `<span class="tag">${esc(s || "")}</span>`;
const rvBtn = (id, st) => `<button data-rv="${id}" data-to="${st === "검토완료" ? "미검토" : "검토완료"}">${st === "검토완료" ? "✔ 검토완료" : "미검토"}</button>`;

function cardHTML(card) {
  if (!card) return '<p class="hint">결과 카드가 아직 없습니다. 왼쪽에서 담보를 체크하고 [결과 카드 만들기]를 누르세요.</p>';
  let h = `<p class="hint">생성 ${esc(card.generated_at)} · 모델 ${esc(card.meta.model || "")} · 입력 조문·표 ${card.input.refs}개${card.input.common_whole ? " · 특약 공통 조항 포함" : ""}${card.input.main_whole ? " · 주계약 준용(참조 조문만 포함)" : ""}.
    근거의 조문·쪽을 누르면 [검증] 화면에서 원본 쪽으로 이동해 인용 문장을 주황색으로 강조합니다.</p>`;
  h += `<h4>A. 보장 세부조건</h4><table class="card"><tr><th style="width:130px">항목</th><th>내용</th><th style="width:38%">근거(조·항·호, 쪽, 원문 인용)</th><th style="width:90px">상태</th><th style="width:80px">검토</th></tr>
    ${card.items.map((it) => `<tr><td>${esc(it.field)}</td><td>${esc(it.content)}</td><td>${evBox(it.evidence)}</td><td>${chk(it.check)}</td><td>${rvBtn(it.id, it.review)}</td></tr>`).join("")}</table>`;
  h += `<h4>B. 전산화 시 주의사항</h4><table class="card"><tr><th style="width:130px">주제</th><th>내용</th><th style="width:38%">근거</th><th style="width:90px">상태</th><th style="width:80px">검토</th></tr>
    ${card.cautions.map((c) => `<tr><td>${esc(c.topic)}</td><td>${esc(c.content)}${c.needs_interpretation ? `<div class="tag warn">해석 확인 필요</div><ul class="interp">${c.interpretations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</td>
      <td>${evBox(c.evidence)}</td><td>${chk(c.check)}</td><td>${rvBtn(c.id, c.review)}</td></tr>`).join("") || '<tr><td colspan="5" class="hint">없음</td></tr>'}</table>`;
  h += `<h4>C. 산출에 쓰는 표 (1단계에서 추출한 표를 그대로 표시)</h4>`;
  h += (card.table_data || []).map((t) => {
    const use = (card.tables.find((x) => x.table === t.id) || {}).use || "";
    return `<div class="tblhead"><b>${esc(t.id)}</b> · <span class="pg" data-tbl="${esc(t.id)}">${t.page}쪽</span> · ${esc(use)} ${t.complete ? "" : '<span class="tag bad">표 추출 불완전 — 원본 확인</span>'}</div>${renderTableHTML(t)}`;
  }).join("") || '<p class="hint">없음</p>';
  if (card.isolated.length) {
    h += `<details class="sec"><summary>근거 불일치로 격리한 항목 <span class="cnt warn">${card.isolated.length}건</span></summary><div>
      <p class="hint">AI가 적은 인용문이 해당 조문 원문에 없어 결과에서 뺀 항목입니다. 참고만 하고 그대로 쓰지 마세요.</p>
      <table class="card"><tr><th>항목</th><th>내용</th><th>근거</th></tr>${card.isolated.map((it) => `<tr><td>${esc(it.field || it.topic)}</td><td>${esc(it.content)}</td><td>${evBox(it.evidence)}</td></tr>`).join("")}</table></div></details>`;
  }
  return h;
}

function ecsHTML(e, cmpMode) {
  if (!e) return '<p class="hint">ECS 초안이 아직 없습니다. 결과 카드를 만든 뒤 [ECS 초안 만들기]를 누르세요.</p>';
  const groups = ["상품·청구", "계산식", "상세계산식·처리"];
  let h = `<p class="hint">생성 ${esc(e.generated_at)} · 코드마스터 ${e.master_used ? "사용" : "없음(코드는 비우고 명칭만 표시)"} ·
    ${cmpMode ? "비교 모드: 수정 전 칸에 구약관 초안 값을 표시합니다." : "단일 약관 모드: 수정 후 칸만 채웁니다."}</p>`;
  for (const r of e.rows) {
    h += `<h4>룰 행 ${esc(r.id)}: ${esc(r.label)} <button data-erv="${r.id}" data-to="검토완료">행 전체 검토완료</button></h4>
      <div class="hint">행 분리 근거: ${esc(r.split_reason)}</div>${evBox(r.split_evidence)}
      <table class="card"><tr><th style="width:130px">필드</th><th>수정 전</th><th style="width:70px">코드</th><th>수정 후(명칭·값)</th><th style="width:150px">상태</th><th style="width:30%">근거</th><th style="width:110px">검토</th></tr>`;
    for (const g of groups) {
      h += `<tr class="grp"><td colspan="7">${g}</td></tr>`;
      for (const f of A.view.fields.filter((x) => x.group === g)) {
        const c = r.fields[f.key];
        const b = c.before;
        const changed = cmpMode && b && ((b.code || "") !== (c.code || "") || (b.name || "") !== (c.name || ""));
        const st = c.status === "값" ? "" : `<span class="tag ${c.status === "약관에 명시 없음" ? "" : "warn"}">${esc(c.status)}</span>`;
        h += `<tr class="${changed ? "chg" : ""}"><td>${esc(f.label)}</td><td>${b ? esc([b.code, b.name].filter(Boolean).join(" ")) : '<span class="hint">—</span>'}</td>
          <td>${esc(c.code)}</td><td>${esc(c.name)}${c.note ? `<div class="hint">${esc(c.note)}</div>` : ""}</td>
          <td>${st}${(c.flags || []).map((x) => `<span class="tag ${/코드 확인/.test(x) ? "bad" : ""}">${esc(x)}</span>`).join("")}</td>
          <td>${evBox(c.evidence)}</td>
          <td><button data-erv="${r.id}" data-f="${esc(f.key)}" data-to="${c.review === "검토완료" ? "미검토" : "검토완료"}">${c.review === "검토완료" ? "✔" : "미검토"}</button>
            <button data-edit="${r.id}" data-f="${esc(f.key)}">수정</button></td></tr>`;
      }
    }
    h += "</table>";
    if (r.isolated.length) h += `<div class="banner warn">근거 불일치로 비운 칸: ${r.isolated.map((x) => `${esc(x.field)}(AI 값: ${esc([x.code, x.name].filter(Boolean).join(" "))})`).join(", ")}</div>`;
  }
  return h;
}

async function editCell(rowId, field) {
  const r = A.data.ecs.rows.find((x) => x.id === rowId), c = r.fields[field];
  const ok = await dialog(`${field} 값 수정`, `<label>코드 <input id="ecCode" value="${esc(c.code)}"></label><label>명칭·값 <input id="ecName" value="${esc(c.name)}"></label>
    <p class="hint">담당자가 직접 고친 값으로 표시되고 수정 이력에 남습니다.</p>`);
  if (!ok) return;
  await post(`/api/docs/${S.doc}/ecs/${A.cid}/edit`, { row: rowId, field, code: $("#ecCode").value, name: $("#ecName").value, user: user() });
  anOpen(A.cid);
}

async function anRun(stage) {
  const cids = [...A.checked];
  if (!cids.length) return toast("왼쪽 목록에서 분석할 담보를 체크하세요.", true);
  const label = { cards: "결과 카드", ecs: "ECS 초안", both: "결과 카드와 ECS 초안" }[stage];
  if (!confirm(`체크한 담보 ${cids.length}개의 ${label}를 만듭니다. 담보마다 Claude API를 호출하므로 시간과 비용이 듭니다. 계속할까요?`)) return;
  let job;
  try { job = await post(`/api/docs/${S.doc}/analysis/run`, { cids, stage, user: user() }); } catch (e) { return toast(e.message, true); }
  $("#anProg").classList.remove("hidden");
  while (!job.done) {
    $("#anBar").style.width = Math.round((job.frac || 0) * 100) + "%";
    $("#anProgText").textContent = `${job.stage || ""} ${job.msg || ""}`;
    await new Promise((r) => setTimeout(r, 1500));
    job = await api(`/api/jobs/${job.id}`);
  }
  $("#anProg").classList.add("hidden");
  if (job.error) toast("실패: " + job.error, true); else toast(`${label}를 만들었습니다.`);
  await anLoad();
}
$("#anCards").onclick = () => anRun("cards");
$("#anEcs").onclick = () => anRun("ecs");
$("#anBoth").onclick = () => anRun("both");

$("#pSave").onclick = async () => {
  await post(`/api/docs/${S.doc}/product`, { "상품코드": $("#pCode").value, "상품명": $("#pName").value, "판매개시일자": $("#pDate").value, user: user() });
  toast("상품 정보를 저장했습니다."); anLoad();
};
$("#mUpload").onclick = async () => {
  const f = $("#mFile").files[0];
  if (!f) return toast("코드마스터 엑셀 파일을 고르세요.", true);
  const fd = new FormData(); fd.append("file", f);
  try {
    const r = await api("/api/master", { method: "POST", body: fd });
    toast(`코드마스터를 적용했습니다(필드 ${Object.keys(r.fields).length}개${r.unknown_fields.length ? `, 알 수 없는 필드명 ${r.unknown_fields.join(", ")}` : ""}).`);
    anLoad();
  } catch (e) { toast(e.message, true); }
};
