/* 5단계: 구약관 대비 비교(converter/compare.py 이식). AI를 쓰지 않습니다. */
(function (root) {
  "use strict";
  const TT = (root.TT = root.TT || {});
  const norm = (s) => TT.normText(s);
  const TYPES = new Set(["보통약관", "특약공통", "개별특약", "납입면제류", "서비스·인수·전환류", "미분류"]);
  const MEANING = /\d|%|일|년|개월|회|세|원|배|다만|제외|않|한하여|한함|이내|이상|이하|미만|초과|포함|최초|감액|면책|지급하지/;
  const G6 = (p) => [1, 2, 3, 4, 5, 6].map((i) => p + i);
  const FIELD_BY_TOPIC = [
    [/지급사유|납입면제사유/, ["청구사유", "사고유형", "사인그룹", ...G6("급부결정조건")]],
    [/세부규정/, [...G6("급부결정조건"), ...G6("계산식결정조건"), "계산식"]],
    [/지급하지|면제하지|면책/, ["사인그룹", ...G6("급부결정조건")]],
    [/보장개시/, G6("급부결정조건")], [/보험기간|갱신/, ["갱신가능불가"]], [/소멸/, ["계약상태처리"]],
    [/납입면제|보험료의납입/, ["납면처리"]], [/지급기준표/, ["분자", "분모", "계산식", "상세계산식1", "금액유형1"]],
    [/정의|분류표|진단확정|수술|입원/, ["사인그룹", ...G6("급부결정조건")]],
  ];
  const keyOf = (name) => norm(TT.shortName(name)).replace(/\d+(\.\d+)+/g, "");
  const fieldsFor = (title) => { const t = norm(title), out = []; for (const [rx, fs] of FIELD_BY_TOPIC) if (rx.test(t)) fs.forEach((f) => { if (!out.includes(f)) out.push(f); }); return out; };

  async function covs(doc) { return (await TT.get(doc, "coverage_map.json")).coverages.filter((c) => TYPES.has(c.type)); }

  async function match(newDoc, oldDoc, overrides) {
    const nw = await covs(newDoc), od = await covs(oldDoc);
    const pairs = {}, used = new Set();
    for (const n of nw) if (n.cid in overrides) { const o = overrides[n.cid]; pairs[n.cid] = [o || null, o ? 1 : 0, "사용자"]; if (o) used.add(o); }
    const cands = [];
    nw.forEach((n, i) => {
      if (pairs[n.cid]) return;
      od.forEach((o, j) => {
        if (used.has(o.cid)) return;
        if (n.type !== o.type && n.type !== "미분류" && o.type !== "미분류") return;
        const nm = TT.similarity(keyOf(n.name), keyOf(o.name));
        const pos = 1 - Math.abs(i / Math.max(1, nw.length - 1) - j / Math.max(1, od.length - 1));
        cands.push([0.85 * nm + 0.15 * pos, nm, n.cid, o.cid]);
      });
    });
    cands.sort((a, b) => b[0] - a[0]);
    for (const [score, nm, nc, oc] of cands) {
      if (pairs[nc] || used.has(oc) || nm < 0.6) continue;
      pairs[nc] = [oc, Math.round(score * 1000) / 1000, "자동"]; used.add(oc);
    }
    const out = nw.map((n) => { const [o, s, h] = pairs[n.cid] || [null, 0, "자동"]; return { new: n.cid, old: o, score: s, how: h }; });
    for (const o of od) if (!used.has(o.cid)) out.push({ new: null, old: o.cid, score: 0, how: "자동" });
    return out;
  }

  // 낱말 단위 차이(앞뒤 같은 부분을 먼저 떼고, 가운데만 최장 공통 부분수열로 비교)
  TT.diffOps = function (a, b) {
    const ta = TT.joinLines(a).split(/\s+/).filter(Boolean), tb = TT.joinLines(b).split(/\s+/).filter(Boolean);
    let s = 0;
    while (s < ta.length && s < tb.length && ta[s] === tb[s]) s++;
    let e = 0;
    while (e < ta.length - s && e < tb.length - s && ta[ta.length - 1 - e] === tb[tb.length - 1 - e]) e++;
    const A = ta.slice(s, ta.length - e), B = tb.slice(s, tb.length - e);
    const ops = [];
    if (s) ops.push(["=", ta.slice(0, s).join(" ")]);
    if (A.length * B.length > 4e6) { if (A.length) ops.push(["-", A.join(" ")]); if (B.length) ops.push(["+", B.join(" ")]); }
    else {
      const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      let i = 0, j = 0;
      const push = (op, t) => { const last = ops[ops.length - 1]; if (last && last[0] === op) last[1] += " " + t; else ops.push([op, t]); };
      while (i < n && j < m) {
        if (A[i] === B[j]) { push("=", A[i]); i++; j++; }
        else if (L[i + 1][j] >= L[i][j + 1]) { push("-", A[i]); i++; }
        else { push("+", B[j]); j++; }
      }
      while (i < n) push("-", A[i++]);
      while (j < m) push("+", B[j++]);
    }
    if (e) { const last = ops[ops.length - 1], t = ta.slice(ta.length - e).join(" "); if (last && last[0] === "=") last[1] += " " + t; else ops.push(["=", t]); }
    return ops;
  };
  const opinion = (ops) => (MEANING.test(ops.filter(([o]) => o !== "=").map(([, t]) => t).join(" ")) ? "의미 변경 가능성 높음" : "표현 변경으로 보임");

  function articles(P, cid) { return (P.orders[cid] || []).map((i) => P.nodes[i]).filter((n) => !n.parent && (n.kind === "article" || n.kind === "annex")); }
  const tableTextOf = (P, owner) => P.tables.filter((t) => t.owner === owner).map(TT.tableText).join("\n");

  function comparePair(nc, oc, N, O) {
    const na = nc ? articles(N, nc) : [], oa = oc ? articles(O, oc) : [];
    const left = Object.fromEntries(oa.map((a) => [a.key, a]));
    const used = new Set(), rows = [];
    for (const a of na) {
      let b = left[a.key];
      if (b && TT.similarity(norm(a.title || ""), norm(b.title || "")) < 0.5) b = null;
      if (!b) b = oa.find((x) => !used.has(x.key) && norm(x.title || "") === norm(a.title || "")) || null;
      if (b) used.add(b.key);
      rows.push([b, a]);
    }
    for (const b of oa) if (!used.has(b.key)) rows.push([b, null]);
    return rows.map(([b, a]) => {
      const nt = a ? TT.fullText(N.nodes, a.id) + (a.kind === "annex" ? "\n[표]\n" + tableTextOf(N, a.id) : "") : "";
      const ot = b ? TT.fullText(O.nodes, b.id) + (b.kind === "annex" ? "\n[표]\n" + tableTextOf(O, b.id) : "") : "";
      let st, ops = [], op = "";
      if (a && b) { if (norm(nt) === norm(ot)) st = "동일"; else { ops = TT.diffOps(ot, nt); st = "변경"; op = opinion(ops); } }
      else if (a) { st = "신규"; ops = [["+", TT.joinLines(nt)]]; op = "의미 변경 가능성 높음"; }
      else { st = "삭제"; ops = [["-", TT.joinLines(ot)]]; op = "의미 변경 가능성 높음"; }
      const x = a || b;
      return { key: x.key, title: x.title || "", status: st, opinion: op, ops, new_id: a ? a.id : null, old_id: b ? b.id : null,
        new_page: a ? a.page_start : null, old_page: b ? b.page_start : null, old_key: b ? b.key : null, fields: st !== "동일" ? fieldsFor(x.title || "") : [] };
    });
  }

  async function pack(doc) {
    const t = await TT.get(doc, "terms.json");
    return { nodes: t.nodes, orders: t.orders, tables: (await TT.get(doc, "tables.json")).tables, covs: Object.fromEntries((await TT.get(doc, "coverage_map.json")).coverages.map((c) => [c.cid, c])) };
  }

  TT.compareRun = async function (newDoc, oldDoc, user, overrides) {
    if (!(await TT.isApproved(newDoc)) || !(await TT.isApproved(oldDoc))) throw new Error("비교하려면 신약관과 구약관 모두 1단계 변환이 승인되어 있어야 합니다.");
    if (newDoc === oldDoc) throw new Error("같은 문서끼리는 비교할 수 없습니다.");
    const prev = (await TT.get(newDoc, "compare.json")) || {};
    if (!overrides) overrides = prev.old_doc === oldDoc ? prev.overrides || {} : {};
    const N = await pack(newDoc), O = await pack(oldDoc);
    const newEcs = (await TT.get(newDoc, "ecs.json", {})) || {}, oldEcs = (await TT.get(oldDoc, "ecs.json", {})) || {};
    const pairs = [];
    for (const m of await match(newDoc, oldDoc, overrides)) {
      const nc = m.new, oc = m.old, arts = comparePair(nc, oc, N, O);
      const status = nc && !oc ? "신규" : oc && !nc ? "삭제" : arts.every((a) => a.status === "동일") ? "동일" : "변경";
      const changed = arts.filter((a) => a.status !== "동일");
      const op = status === "동일" ? "" : changed.some((a) => a.opinion === "의미 변경 가능성 높음") ? "의미 변경 가능성 높음" : "표현 변경으로 보임";
      let fields = [], src = "조문 종류로 추정";
      if (nc && oc && newEcs[nc] && oldEcs[oc]) {
        const v = await TT.ecsViewRows(newDoc, nc, oldEcs[oc].rows);
        for (const r of v.rows) for (const [k, cell] of Object.entries(r.fields)) { const bc = cell.before || {}; if ((bc.code || "") + "|" + (bc.name || "") !== cell.code + "|" + cell.name && !fields.includes(k)) fields.push(k); }
        src = "양쪽 4단계 ECS 초안의 필드별 차이";
        if (!fields.length && status === "변경") { changed.forEach((a) => a.fields.forEach((f) => { if (!fields.includes(f)) fields.push(f); })); src = "ECS 초안 값은 같지만 조문이 바뀜 — 조문 종류로 추정(초안 재생성 권장)"; }
      } else changed.forEach((a) => a.fields.forEach((f) => { if (!fields.includes(f)) fields.push(f); }));
      pairs.push({ new: nc, old: oc, new_name: nc ? N.covs[nc].name : null, old_name: oc ? O.covs[oc].name : null,
        new_range: nc ? [N.covs[nc].start, N.covs[nc].end] : null, old_range: oc ? [O.covs[oc].start, O.covs[oc].end] : null,
        score: m.score, how: m.how, status, opinion: op, fields, field_source: src, articles: arts });
    }
    const metaOld = (await TT.get(oldDoc, "meta.json")) || {};
    const counts = {};
    for (const s of ["신규", "변경", "삭제", "동일"]) counts[s] = pairs.filter((p) => p.status === s).length;
    const data = { old_doc: oldDoc, old_filename: metaOld.filename, generated_at: TT.now(), overrides, pairs, counts };
    await TT.put(newDoc, "compare.json", data);
    await TT.history(newDoc, "5단계 구약관 비교", { old_doc: oldDoc, counts }, user);
    return data;
  };
  TT.compareSetMatch = async function (newDoc, nc, oc, user) {
    const d = await TT.get(newDoc, "compare.json");
    if (!d) throw new Error("비교 결과가 없습니다.");
    const ov = Object.assign({}, d.overrides || {}, { [nc]: oc || "" });
    return TT.compareRun(newDoc, d.old_doc, user, ov);
  };
})(typeof self !== "undefined" ? self : globalThis);
