"use strict";
// 2단계: 담보 분류 트리 화면 (app.js의 S, $, api, post, esc, toast, user, dialog, showTab, openCov를 씁니다)

const C = { view: null };
const MAJ = ["사망", "장해", "진단", "입원", "치료", "기타"];

window.clsLoad = async function () {
  if (!S.doc) return;
  try { C.view = await api(`/api/docs/${S.doc}/classification`); } catch (e) { toast(e.message, true); return; }
  clsRender();
};

function clsPost(op, body) {
  return api(`/api/docs/${S.doc}/classification/${op}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, user: user() }),
  });
}

function clsBanner() {
  const v = C.view, b = $("#clsBanner");
  if (!v.approved) {
    b.innerHTML = `<div class="banner bad">1단계 변환이 승인되지 않았습니다. 검증을 마치고 화면 오른쪽 위 [변환 미승인]을 눌러 승인해야 2단계를 실행할 수 있습니다.${v.data ? " 아래는 이전 승인 때 만든 분류이며 최신 변환과 다를 수 있습니다." : ""}</div>`;
  } else if (v.stale) {
    b.innerHTML = `<div class="banner warn">분류를 만든 뒤 변환이 다시 승인되었습니다. [자동 구성]을 눌러 최신 변환을 반영하세요(사용자가 정한 분류는 유지됩니다).</div>`;
  } else if (!v.data) {
    b.innerHTML = `<div class="banner ok">변환이 승인되었습니다. [자동 구성]을 눌러 분류를 만드세요.</div>`;
  } else {
    b.innerHTML = `<div class="banner ok">분류 생성 ${esc(v.data.generated_at)} · 승인본 ${esc(v.data.approval_at || "")} 기준</div>`;
  }
  const off = !v.approved;
  $("#clsGen").disabled = off; $("#clsReset").disabled = off;
  $("#clsAi").disabled = off || !v.ai_available || !v.data;
  $("#clsAi").title = v.ai_available ? "담보명·지급사유 조문·지급기준표 급부명만 Claude API로 보내 분류를 제안받습니다." : "ANTHROPIC_API_KEY 환경변수가 없어 사용할 수 없습니다(README 참고).";
  $("#clsApplyAll").disabled = off || !v.data;
}

function clsRender() {
  clsBanner();
  const v = C.view, box = $("#clsTree");
  if (!v.data) { box.innerHTML = '<p class="hint">분류가 아직 없습니다.</p>'; $("#clsSelInfo").textContent = ""; return; }
  const items = Object.values(v.data.items);
  const sel = new Set(v.data.selected || []);
  $("#clsSelInfo").textContent = `선택 ${sel.size} / ${items.length}개 담보`;
  const q = $("#clsSearch").value.replace(/\s/g, "");
  const onlyDiff = $("#clsOnlyDiff").checked, onlyTodo = $("#clsOnlyTodo").checked;
  const diff = (it) => it.ai && (it.ai.major !== it.major || it.ai.mid !== it.mid || it.ai.minor !== it.minor);
  const shown = items.filter((it) => (!q || (it.name + (it.display_name || "")).replace(/\s/g, "").includes(q))
    && (!onlyDiff || diff(it)) && (!onlyTodo || it.review !== "검토완료"));
  const tree = {};
  shown.forEach((it) => { ((tree[it.major] ||= {})[it.mid] ||= {})[it.minor] ||= []; tree[it.major][it.mid][it.minor].push(it); });
  const cb = (cids) => {
    const n = cids.filter((c) => sel.has(c)).length;
    return `<input type="checkbox" class="csel" data-cids="${cids.join(",")}" ${n && n === cids.length ? "checked" : ""} data-part="${n > 0 && n < cids.length ? 1 : 0}">`;
  };
  const srcTag = (s) => s === "사용자" ? '<span class="tag warn">사용자</span>' : s === "기억" ? '<span class="tag key">이전 분류 기억</span>' : s === "AI(적용)" ? '<span class="tag">AI 적용</span>' : '<span class="tag">규칙</span>';
  let h = "<div class='ctree'><ul>";
  for (const major of MAJ) {
    const mids = tree[major]; if (!mids) continue;
    const all1 = Object.values(mids).flatMap((m) => Object.values(m).flat()).map((it) => it.cid);
    h += `<li><div class="grp l1">${cb(all1)} ${esc(major)} <span class="cnt">${all1.length}</span></div><ul>`;
    for (const mid of Object.keys(mids).sort()) {
      const all2 = Object.values(mids[mid]).flat().map((it) => it.cid);
      h += `<li><div class="grp">${cb(all2)} ${esc(mid)} <span class="cnt">${all2.length}</span> <button data-rg="${esc(major)}|${esc(mid)}|">이름 변경</button></div><ul>`;
      for (const minor of Object.keys(mids[mid]).sort()) {
        const its = mids[mid][minor];
        h += `<li><div class="grp" style="font-weight:600">${cb(its.map((i) => i.cid))} ${esc(minor)} <span class="cnt">${its.length}</span> <button data-rg="${esc(major)}|${esc(mid)}|${esc(minor)}">이름 변경</button></div><ul>`;
        for (const it of its.sort((a, b) => (a.start || 0) - (b.start || 0))) {
          const ai = it.ai;
          h += `<li><div class="it">${cb([it.cid])}
            <span class="nm" data-open="${it.cid}" title="${esc(it.name)}">${esc(it.display_name || it.short)}</span>
            <span class="hint">${it.cid} · ${it.start ?? "?"}쪽 · ${esc(it.type)}</span>${srcTag(it.source)}
            ${it.review === "검토완료" ? '<span class="tag ok">검토완료</span>' : '<span class="tag">미검토</span>'}
            <button data-mv="${it.cid}">분류 옮기기</button><button data-nm="${it.cid}">표시 이름</button>
            <button data-rv="${it.cid}">${it.review === "검토완료" ? "검토 해제" : "검토완료"}</button>
            <div class="why">근거: ${esc(it.reason)}${it.evidence ? ` <span class="pg" data-node="${esc(it.evidence.node)}" data-c="${it.cid}">[${esc(it.evidence.node.split("/").slice(-1)[0])}]</span> “${esc(it.evidence.quote)}”` : ""}
              ${it.benefits && it.benefits.length ? `<br>지급기준표 급부명: ${esc(it.benefits.join(", "))}` : ""}</div>
            ${ai ? `<div class="ai ${ai.verified ? "" : "bad"}">AI 제안: <b>${esc(ai.major)} / ${esc(ai.mid)} / ${esc(ai.minor)}</b> — ${esc(ai.reason)}
              <br>근거 ${esc(ai.evidence.node === "담보명" ? "담보명" : ai.evidence.node.split("/").slice(-1)[0])}: “${esc(ai.evidence.quote)}”
              <span class="tag ${ai.verified ? "ok" : "bad"}">${esc(ai.status)}</span>
              ${ai.verified && diff(it) ? `<button data-ap="${it.cid}">적용</button>` : ""}${!ai.verified ? " 인용문이 원문에 없어 적용 대상에서 뺐습니다." : ""}</div>` : ""}
          </div></li>`;
        }
        h += "</ul></li>";
      }
      h += "</ul></li>";
    }
    h += "</ul></li>";
  }
  h += "</ul></div>";
  box.innerHTML = shown.length ? h : '<p class="hint">조건에 맞는 담보가 없습니다.</p>';
  $$(".csel", box).forEach((e) => { if (e.dataset.part === "1") e.indeterminate = true; });
  $$(".csel", box).forEach((e) => e.addEventListener("change", async () => {
    const cids = e.dataset.cids.split(",");
    cids.forEach((c) => (e.checked ? sel.add(c) : sel.delete(c)));
    await act("select", { cids: [...sel] });
  }));
  $$("[data-open]", box).forEach((e) => e.addEventListener("click", () => { showTab("verify"); openCov(e.dataset.open); }));
  $$("[data-node]", box).forEach((e) => e.addEventListener("click", async () => { showTab("verify"); await openCov(e.dataset.c, false); selectNode(e.dataset.node); }));
  $$("[data-rv]", box).forEach((b) => b.addEventListener("click", () => {
    const it = C.view.data.items[b.dataset.rv];
    act("review", { cid: it.cid, status: it.review === "검토완료" ? "미검토" : "검토완료" });
  }));
  $$("[data-ap]", box).forEach((b) => b.addEventListener("click", () => act("apply_ai", { cids: [b.dataset.ap] })));
  $$("[data-mv]", box).forEach((b) => b.addEventListener("click", () => moveItem(b.dataset.mv)));
  $$("[data-nm]", box).forEach((b) => b.addEventListener("click", () => renameItem(b.dataset.nm)));
  $$("[data-rg]", box).forEach((b) => b.addEventListener("click", () => renameGroup(...b.dataset.rg.split("|"))));
}

async function act(op, body) {
  try { C.view = await clsPost(op, body); clsRender(); return C.view; } catch (e) { toast(e.message, true); }
}

function datalist(id, vals) { return `<datalist id="${id}">${[...new Set(vals)].sort().map((v) => `<option value="${esc(v)}">`).join("")}</datalist>`; }

async function moveItem(cid) {
  const it = C.view.data.items[cid];
  const all = Object.values(C.view.data.items);
  const ok = await dialog(`분류 옮기기: ${it.display_name || it.short}`, `
    <label>대분류 <select id="mvMaj">${MAJ.map((m) => `<option ${m === it.major ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    <label>중분류 <input id="mvMid" list="dlMid" value="${esc(it.mid)}"></label>
    <label>소분류 <input id="mvMin" list="dlMin" value="${esc(it.minor)}"></label>
    ${datalist("dlMid", all.map((x) => x.mid))}${datalist("dlMin", all.map((x) => x.minor))}
    <p class="hint">옮긴 분류는 이 PC의 분류 기억에 저장되어 다음 약관의 같은 담보에 먼저 적용됩니다.</p>`);
  if (!ok) return;
  await act("move", { cid, major: $("#mvMaj").value, mid: $("#mvMid").value, minor: $("#mvMin").value });
  toast("분류를 옮겼습니다.");
}

async function renameItem(cid) {
  const it = C.view.data.items[cid];
  const ok = await dialog("담보 표시 이름", `<p class="hint">${esc(it.name)}</p><label>표시 이름(비우면 기본 이름) <input id="nmIn" value="${esc(it.display_name || "")}" placeholder="${esc(it.short)}"></label>`);
  if (!ok) return;
  await act("rename_item", { cid, display_name: $("#nmIn").value });
}

async function renameGroup(major, mid, minor) {
  const cur = minor || mid;
  const ok = await dialog(`${minor ? "소분류" : "중분류"} 이름 변경`, `<p class="hint">${esc(major)} / ${esc(mid)}${minor ? " / " + esc(minor) : ""}</p><label>새 이름 <input id="rgIn" value="${esc(cur)}"></label>`);
  if (!ok) return;
  await act("rename_group", { major, mid, minor: minor || null, new_name: $("#rgIn").value });
}

$("#clsGen").onclick = async () => { await act("generate", {}); toast("분류를 구성했습니다. 사용자가 정한 분류는 유지했습니다."); };
$("#clsReset").onclick = async () => {
  if (!confirm("사용자가 옮긴 분류까지 모두 버리고 규칙·기억으로 다시 구성합니다. 계속할까요?")) return;
  await act("generate", { reset: true });
};
$("#clsApplyAll").onclick = async () => {
  const cids = Object.values(C.view.data.items).filter((it) => it.ai && it.ai.verified).map((it) => it.cid);
  if (!cids.length) return toast("근거가 확인된 AI 제안이 없습니다.", true);
  if (!confirm(`근거가 확인된 AI 제안 ${cids.length}건을 적용합니다. 근거 불일치 제안은 적용하지 않습니다. 계속할까요?`)) return;
  const v = await act("apply_ai", { cids });
  if (v) toast(`적용 ${v.applied.length}건, 제외 ${v.skipped.length}건`);
};
$("#clsAi").onclick = async () => {
  const n = Object.keys(C.view.data.items).length;
  if (!confirm(`담보 ${n}개의 담보명·지급사유 조문·지급기준표 급부명을 Claude API로 보내 분류 제안을 받습니다(약관 전체는 보내지 않습니다). 계속할까요?`)) return;
  let job;
  try { job = await clsPost("ai", {}); } catch (e) { return toast(e.message, true); }
  $("#clsProg").classList.remove("hidden");
  while (!job.done) {
    $("#clsBar").style.width = Math.round((job.frac || 0) * 100) + "%";
    $("#clsProgText").textContent = `${job.stage || ""} ${job.msg || ""}`;
    await new Promise((r) => setTimeout(r, 1000));
    job = await api(`/api/jobs/${job.id}`);
  }
  $("#clsProg").classList.add("hidden");
  if (job.error) toast("AI 분류 실패: " + job.error, true); else toast("AI 분류 제안을 받았습니다. 제안은 [적용]을 눌러야 반영됩니다.");
  await clsLoad();
};
const selCids = () => (C.view && C.view.data ? C.view.data.selected || [] : []);
$("#clsX").onclick = () => { const s = selCids(); if (!s.length) return toast("담보를 선택하세요.", true); location.href = `/api/docs/${S.doc}/export.xlsx?cids=${s.join(",")}`; };
$("#clsJ").onclick = () => { const s = selCids(); if (!s.length) return toast("담보를 선택하세요.", true); location.href = `/api/docs/${S.doc}/export.zip?cids=${s.join(",")}`; };
["#clsSearch", "#clsOnlyDiff", "#clsOnlyTodo"].forEach((s) => $(s).addEventListener("input", () => C.view && clsRender()));
if (S.doc) clsLoad();
