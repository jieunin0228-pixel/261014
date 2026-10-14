/* 화면이 쓰던 서버 주소(/api/...)를 브라우저 안의 함수로 연결합니다(app.py 이식). 서버는 없습니다. */
(function (root) {
  "use strict";
  const TT = (root.TT = root.TT || {});
  const norm = (s) => TT.normText(s);

  class HttpError extends Error {}
  const fail = (msg) => { throw new HttpError(msg); };
  const body = (opt) => (opt && typeof opt.body === "string" ? JSON.parse(opt.body) : (opt && opt.body) || {});
  async function mustDoc(doc) { if (!doc || !(await TT.get(doc, "meta.json"))) fail("문서를 찾을 수 없습니다."); }

  const brief = (nodes, nid) => { const n = nodes[nid]; return n ? { id: nid, cid: n.cid, kind: n.kind, key: n.key, title: n.title || "", page: n.page_start } : { id: nid, missing: true }; };

  async function summary(doc) {
    const cmap = await TT.get(doc, "coverage_map.json"), nodes = (await TT.get(doc, "terms.json")).nodes;
    const reviews = (await TT.get(doc, "reviews.json", {})) || {};
    return {
      doc: cmap.doc, types: TT.COVERAGE_TYPES, approval: (await TT.get(doc, "approval.json", {})) || {}, meta: await TT.get(doc, "meta.json"),
      coverages: cmap.coverages.map((c) => ({ cid: c.cid, name: c.name, start: c.start, end: c.end, type: c.type, type_auto: c.type_auto, type_edited: c.type_edited,
        range_edited: c.range_edited, toc_start: c.toc_start, toc_end: c.toc_end, header_pages: c.header_pages, n_articles: c.n_articles, n_tables: c.tables.length,
        annexes: c.annexes, payout: c.key.payout ? { id: c.key.payout, key: nodes[c.key.payout].key, title: nodes[c.key.payout].title, page: nodes[c.key.payout].page_start } : null,
        review: reviews[c.cid] || { status: "미검토" } })),
    };
  }

  async function coverage(doc, cid) {
    const cmap = await TT.get(doc, "coverage_map.json"), terms = await TT.get(doc, "terms.json"), tables = (await TT.get(doc, "tables.json")).tables;
    const c = cmap.coverages.find((x) => x.cid === cid);
    if (!c) fail("담보 없음");
    const nodes = terms.nodes, inc = c.inputs, byCid = Object.fromEntries(cmap.coverages.map((x) => [x.cid, x.name]));
    const tree = (terms.orders[cid] || []).map((i) => { const n = Object.assign({}, nodes[i]); const fl = n.lines[0] || null, nl = n.lines.length; delete n.lines; return Object.assign(n, { first_line: fl, n_lines: nl }); });
    const cov = Object.assign({}, c); delete cov.inputs; delete cov.pages;
    return {
      coverage: cov, nodes: tree, tables: tables.filter((t) => t.cid === cid), refs: terms.refs.filter((r) => r.cid === cid),
      inputs: { own: inc.own.map((i) => brief(nodes, i)), common_refs: inc.common_refs.map((i) => brief(nodes, i)), main_refs: inc.main_refs.map((i) => brief(nodes, i)),
        annex_refs: inc.annex_refs.map((i) => brief(nodes, i)), law_refs: inc.law_refs.map((i) => brief(nodes, i)), whole: inc.whole.map((w) => Object.assign({}, w, { name: byCid[w.cid] || "" })) },
      review: ((await TT.get(doc, "reviews.json", {})) || {})[cid] || { status: "미검토" },
    };
  }

  async function pageLines(doc, p) {
    const raw = await TT.get(doc, "raw_pages.json");
    if (p < 1 || p > raw.pages.length) fail("쪽 범위 밖");
    const pg = raw.pages[p - 1], owner = (await TT.get(doc, "terms.json")).line_owner, row = (await TT.get(doc, "pages.json")).pages[p - 1];
    return { p, w: pg.w, h: pg.h, header: pg.header, footer: pg.footer, row,
      lines: pg.lines.map((l, i) => ({ i, t: l.t, b: l.b, owner: owner[p + ":" + i] || null })),
      tables: pg.tables.map((t) => ({ idx: t.idx, kind: t.kind, bbox: t.bbox, complete: t.complete })) };
  }

  async function locate(doc, q) {
    const raw = (await TT.get(doc, "raw_pages.json")).pages;
    if (q.table) { const t = (await TT.get(doc, "tables.json")).tables.find((x) => x.id === q.table); if (!t) fail("표 없음"); return { page: t.page, lines: [], bbox: t.bbox, cid: t.cid }; }
    const nodes = (await TT.get(doc, "terms.json")).nodes;
    if (!nodes[q.node]) fail("조문 없음");
    const refs = [];
    (function collect(nid) { refs.push(...nodes[nid].lines); nodes[nid].children.forEach(collect); })(q.node);
    refs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const qq = norm(q.quote || "");
    let joined = "";
    const spans = refs.map(([p, i]) => { const t = norm(raw[p - 1].lines[i].t), s = [joined.length, joined.length + t.length]; joined += t; return s; });
    const k = qq ? joined.indexOf(qq) : -1;
    const cid = nodes[q.node].cid;
    if (k < 0) { const p0 = refs.length ? refs[0][0] : nodes[q.node].page_start; return { page: p0, lines: refs.filter(([p]) => p === p0).slice(0, 1).map(([, i]) => i), found: false, cid }; }
    const hit = refs.filter((_, j) => spans[j][0] < k + qq.length && spans[j][1] > k);
    return { page: hit[0][0], lines: hit.filter(([p]) => p === hit[0][0]).map(([, i]) => i), found: true, cid };
  }

  const ALLOWED = { coverage_range: ["cid", "start", "end"], coverage_type: ["cid", "type"], split: ["cid", "page", "line", "key", "title", "kind"], rename: ["cid", "page", "line", "key", "title", "kind"], merge: ["cid", "page", "line"] };
  async function addEdit(doc, b) {
    if (!ALLOWED[b.action]) fail("알 수 없는 수정 종류");
    const e = { action: b.action };
    for (const k of ALLOWED[b.action]) if (k in b) e[k] = b[k];
    if (b.action === "coverage_type" && !TT.COVERAGE_TYPES.includes(e.type)) fail("알 수 없는 유형");
    if (b.action === "coverage_range") {
      const s = +e.start, en = +e.end, meta = await TT.get(doc, "meta.json");
      if (!(s >= 1 && s <= en && en <= meta.page_count)) fail("쪽 범위가 올바르지 않습니다.");
      e.start = s; e.end = en;
    }
    if ((b.action === "split" || b.action === "rename")) { if (!String(e.key || "").trim()) fail("조문 번호(예: 제2-3조, 별표2-1)를 넣으세요."); e.kind = String(e.key).startsWith("별표") ? "annex" : "article"; }
    if ("before" in b) e.before = b.before;
    await TT.addEdit(doc, e, b.user || "");
    return { ok: true };
  }

  async function analysisView(doc) {
    const cls = (await TT.get(doc, "classification.json")) || {}, cmap = await TT.get(doc, "coverage_map.json");
    const cd = (await TT.get(doc, "cards.json", {})) || {}, ed = (await TT.get(doc, "ecs.json", {})) || {};
    const covs = cmap.coverages.filter((c) => TT.CLASSIFY_TYPES.has(c.type)).map((c) => {
      const it = (cls.items || {})[c.cid] || {};
      return { cid: c.cid, name: c.name, type: c.type, start: c.start, end: c.end, class: [it.major, it.mid, it.minor].filter(Boolean).join("/"), display_name: it.display_name, has_card: !!cd[c.cid], has_ecs: !!ed[c.cid] };
    });
    const appr = (await TT.get(doc, "approval.json", {})) || {}, m = await TT.loadMaster();
    return { coverages: covs, selected: cls.selected || [], approved: !!appr.approved, approval_at: appr.at, ai_available: !!(await TT.getSample()), model: "claude.ai " + TT.aiTier,
      product: await TT.getProduct(doc), master: { loaded: !!(m.fields && Object.keys(m.fields).length), imported_at: m.imported_at, fields: Object.fromEntries(Object.entries(m.fields || {}).map(([k, v]) => [k, v.length])) },
      fields: TT.ECS_FIELDS };
  }

  async function cardGet(doc, cid) {
    const all = (await TT.get(doc, "cards.json", {})) || {};
    let card = all[cid];
    const tables = Object.fromEntries((await TT.get(doc, "tables.json")).tables.map((t) => [t.id, t]));
    if (card) card = Object.assign({}, card, { table_data: card.tables.map((t) => tables[t.table]).filter(Boolean) });
    const appr = (await TT.get(doc, "approval.json", {})) || {}, cmp = await TT.get(doc, "compare.json");
    let before = null;
    if (cmp) { const p = cmp.pairs.find((x) => x.new === cid); if (p && p.old) before = (((await TT.get(cmp.old_doc, "ecs.json", {})) || {})[p.old] || {}).rows || null; }
    return { card, ecs: await TT.ecsViewRows(doc, cid, before), stale: !!(card && card.approval_at !== appr.at), compare_mode: before !== null };
  }

  // ------------------------------------------------------------ 라우터
  TT.route = async function (url, opt = {}) {
    const method = (opt.method || "GET").toUpperCase();
    const u = new URL(url, "http://x");
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);   // api, docs, {id}, ...
    const q = Object.fromEntries(u.searchParams);
    const b = method === "GET" || method === "DELETE" ? {} : body(opt);
    if (parts[0] !== "api") fail("알 수 없는 주소");
    if (parts[1] === "jobs") { const j = TT.job(parts[2]); if (!j) fail("작업 없음"); return Object.assign({}, j); }
    if (parts[1] === "master") return TT.importMaster(await opt.body.get("file").arrayBuffer());
    if (parts[1] !== "docs") fail("알 수 없는 주소");
    if (parts.length === 2) {
      if (method === "GET") return TT.listDocs();
      const f = opt.body.get("file");
      if (!f || !/\.pdf$/i.test(f.name)) fail("PDF 파일만 올릴 수 있습니다.");
      return TT.startConversion(f, q.force === "true");
    }
    const doc = parts[2], rest = parts.slice(3);
    await mustDoc(doc);
    const [a, c, d] = rest;
    switch (a) {
      case "reconvert": { const bytes = await TT.get(doc, "source.pdf"), meta = await TT.get(doc, "meta.json"); return TT.startConversion({ name: meta.filename, arrayBuffer: async () => bytes.slice(0) }, true); }
      case "summary": return summary(doc);
      case "report": return TT.get(doc, "report.json");
      case "coverage": return coverage(doc, c);
      case "node": { const n = (await TT.get(doc, "terms.json")).nodes[q.id]; if (!n) fail("조문 없음"); return n; }
      case "page": return pageLines(doc, +c);
      case "edits":
        if (method === "GET") return { edits: (await TT.get(doc, "edits.json", [])) || [], history: (await TT.get(doc, "history.json", [])) || [] };
        if (method === "DELETE") { await TT.undoEdit(doc, c, q.user || ""); return { ok: true }; }
        return addEdit(doc, b);
      case "review": return TT.setReview(doc, b.cid, b.status, b.user || "");
      case "approval": return TT.setApproval(doc, !!b.approved, b.user || "");
      case "classification":
        if (!c) return TT.classView(doc);
        if (c === "generate") { await TT.classGenerate(doc, b.user || "", !!b.reset); return TT.classView(doc); }
        if (c === "ai") return TT.classAiSuggest(doc, b.user || "");
        return TT.classOp(doc, c, b, b.user || "");
      case "analysis":
        if (c === "run") { if (!b.cids || !b.cids.length) fail("분석할 담보를 고르세요."); if (b.tier) TT.aiTier = b.tier; return TT.runAnalysis(doc, b.cids, b.stage, b.user || ""); }
        return analysisView(doc);
      case "card":
        if (d === "review") { await TT.setCardReview(doc, c, b.item, b.status, b.user || ""); return { ok: true }; }
        return cardGet(doc, c);
      case "ecs":
        if (d === "edit") await TT.editEcsCell(doc, c, b.row, b.field, b.code || "", b.name || "", b.user || "");
        else if (d === "review") await TT.setEcsReview(doc, c, b.row, b.field, b.status);
        return { ok: true };
      case "product": return TT.setProduct(doc, b, b.user || "");
      case "locate": return locate(doc, q);
      case "compare":
        if (c === "match") return { data: await TT.compareSetMatch(doc, b.new, b.old || "", b.user || "") };
        if (method === "POST") { await mustDoc(b.old_doc); return { data: await TT.compareRun(doc, b.old_doc, b.user || "") }; }
        return { data: await TT.get(doc, "compare.json"), candidates: (await TT.listDocs()).filter((x) => x.id !== doc), approved: await TT.isApproved(doc) };
      default: fail("알 수 없는 주소");
    }
  };
  TT.HttpError = HttpError;
})(typeof self !== "undefined" ? self : globalThis);
