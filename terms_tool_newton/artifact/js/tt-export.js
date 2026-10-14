/* 내보내기: 엑셀(SheetJS)·JSON(zip, JSZip). converter/export.py·compare.excel 이식. */
(function (root) {
  "use strict";
  const TT = (root.TT = root.TT || {});
  const X = () => root.XLSX;
  const KIND_KO = { article: "조", para: "항", item: "호", sub: "목", subsub: "세목", box: "설명상자", annex: "별표", preface: "머리말", part: "편", chap: "관", law: "법령" };

  function sheet(wb, name, header, rows, widths = {}) {
    const ws = X().utils.aoa_to_sheet([header, ...rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v)))]);
    ws["!cols"] = header.map((h) => ({ wch: widths[h] || 14 }));
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };
    X().utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }

  TT.exportExcel = async function (doc, cids) {
    const cmap = await TT.get(doc, "coverage_map.json"), terms = await TT.get(doc, "terms.json"), tables = (await TT.get(doc, "tables.json")).tables;
    const pages = (await TT.get(doc, "pages.json")).pages, rep = await TT.get(doc, "report.json");
    const reviews = (await TT.get(doc, "reviews.json", {})) || {}, history = (await TT.get(doc, "history.json", [])) || [];
    const appr = (await TT.get(doc, "approval.json", {})) || {}, meta = (await TT.get(doc, "meta.json")) || {};
    const covs = cmap.coverages, sel = new Set(cids && cids.length ? cids : covs.map((c) => c.cid)), nodes = terms.nodes;
    const wb = X().utils.book_new();
    const pg = (id) => (id && nodes[id] ? nodes[id].page_start : "");
    sheet(wb, "담보별요약", ["담보ID", "담보명", "시작쪽", "끝쪽", "유형", "지급사유 조문", "지급사유 쪽", "별표(쪽)", "조문 수", "표 수", "검토상태"],
      covs.filter((c) => sel.has(c.cid)).map((c) => [c.cid, c.name, c.start, c.end, c.type, c.key.payout ? `${nodes[c.key.payout].key} ${nodes[c.key.payout].title}` : "없음",
        pg(c.key.payout), c.annexes.map((a) => `${a.key} ${a.title} (p.${a.page})`).join("; "), c.n_articles, c.tables.length, (reviews[c.cid] || {}).status || "미검토"]),
      { 담보명: 55, "지급사유 조문": 30, "별표(쪽)": 70 });
    sheet(wb, "품질보고서", ["항목", "값"], [["파일명", meta.filename], ["전체 쪽수", rep.page_count], ["목차 쪽", rep.toc.pages.join(", ")], ["목차 항목 수", rep.toc_count],
      ["머리글로 찾은 담보 수", rep.header_coverages], ["차이", rep.count_diff], ["목차 쪽번호 - PDF 쪽번호 오프셋", rep.offset.offset], ["미배정 쪽 수", rep.unassigned_pages.length],
      ["목차·머리글 불일치 쪽 수", rep.mismatch_pages.length], ["지급사유 조문 없는 담보 수", rep.no_payout.length], ["조문 번호 이상 수", rep.numbering.length],
      ["참조 수(전체/미해결)", `${rep.ref_total} / ${rep.unresolved_refs.length}`], ["표 수(전체/불완전)", `${rep.table_total} / ${rep.table_incomplete.length}`],
      ["텍스트가 거의 없는 쪽 수", rep.low_text_pages.length], ["스캔형 쪽 수", rep.scanned_pages], ["변환 승인", appr.approved ? "승인" : "미승인"]], { 항목: 34, 값: 40 });
    sheet(wb, "쪽배정", ["PDF쪽", "인쇄쪽", "머리글", "배정 담보", "배정 근거", "머리글 담보", "목차 범위 담보", "불일치"],
      pages.map((p) => [p.p, p.printed, p.header, p.cid, p.source, p.header_cid, p.toc_cid, p.mismatch ? "불일치" : ""]), { 머리글: 50 });
    sheet(wb, "미배정쪽", ["PDF쪽", "첫 줄"], rep.unassigned_pages.map((u) => [u.p, u.first_line]), { "첫 줄": 70 });
    sheet(wb, "목차머리글불일치", ["PDF쪽", "머리글", "머리글 담보", "목차 범위 담보", "최종 배정"],
      rep.mismatch_pages.map((m) => [m.p, m.header, m.header_cid, m.toc_cid, m.assigned]).concat(rep.start_diff.map((s) => ["", `목차 시작쪽 ${s.toc_start} / 머리글 시작쪽 ${s.header_start}`, s.cid, s.name, ""])), { 머리글: 60 });
    sheet(wb, "지급사유없음", ["담보ID", "담보명", "유형"], rep.no_payout.map((x) => [x.cid, x.name, x.type]), { 담보명: 60 });
    sheet(wb, "조문번호이상", ["담보ID", "구분", "조문", "쪽", "내용"], rep.numbering.map((x) => [x.cid, x.kind, x.key, x.page, x.detail]).concat(rep.duplicate_ids.map((x) => [x.cid, "ID 중복", x.id, x.page, ""])), { 내용: 60 });
    sheet(wb, "참조미해결", ["담보ID", "출처 ID", "쪽", "종류", "참조 표현", "사유", "문맥"], rep.unresolved_refs.filter((r) => sel.has(r.cid)).map((r) => [r.cid, r.src, r.src_page, r.kind, r.raw, r.reason, r.ctx]), { "출처 ID": 50, 사유: 45, 문맥: 70 });
    sheet(wb, "표추출불완전", ["표ID", "담보ID", "쪽", "별표", "문제"], rep.table_incomplete.map((t) => [t.id, t.cid, t.page, t.annex, t.problems.join("; ")]), { 문제: 40 });
    sheet(wb, "저텍스트쪽", ["PDF쪽", "글자 수", "담보ID"], rep.low_text_pages.map((x) => [x.p, x.chars, x.cid]));
    const trows = [];
    for (const c of covs) if (sel.has(c.cid)) for (const nid of terms.orders[c.cid] || []) { const n = nodes[nid]; trows.push([nid, c.cid, KIND_KO[n.kind] || n.kind, n.key, n.title || "", n.page_start, n.page_end, n.text]); }
    sheet(wb, "조문", ["ID", "담보ID", "종류", "번호", "제목", "시작쪽", "끝쪽", "본문"], trows, { ID: 60, 제목: 30, 본문: 90 });
    const trs = [];
    for (const t of tables) if (sel.has(t.cid)) {
      trs.push([`[${t.id}]`, `담보 ${t.cid}`, `쪽 ${t.page}`, `소속 ${t.owner || ""}`, `제목줄 ${t.caption || ""}`, t.complete ? "완전" : "표 추출 불완전: " + t.problems.join("; ")]);
      for (const r of t.grid) trs.push([""].concat(r.map((v) => (v === null ? "〃" : v))));
      trs.push([]);
    }
    const wsT = X().utils.aoa_to_sheet(trs.length ? trs : [["표 없음"]]);
    wsT["!cols"] = [{ wch: 14 }, ...Array(10).fill({ wch: 30 })];
    X().utils.book_append_sheet(wb, wsT, "표");
    const cls = await TT.get(doc, "classification.json");
    if (cls) {
      const order = Object.fromEntries(TT.MAJORS.map((m, i) => [m, i]));
      const its = Object.values(cls.items).filter((it) => sel.has(it.cid)).sort((a, b) => (order[a.major] - order[b.major]) || a.mid.localeCompare(b.mid) || a.minor.localeCompare(b.minor) || a.cid.localeCompare(b.cid));
      const sc = new Set(cls.selected || []);
      sheet(wb, "담보분류", ["대분류", "중분류", "소분류", "담보ID", "담보명", "표시 이름", "분류 출처", "분류 근거", "근거 조문", "근거 인용", "AI 제안(대/중/소)", "AI 근거 상태", "검토상태", "선택"],
        its.map((it) => [it.major, it.mid, it.minor, it.cid, it.name, it.display_name, it.source, it.reason, (it.evidence || {}).node, (it.evidence || {}).quote,
          it.ai ? [it.ai.major, it.ai.mid, it.ai.minor].join("/") : "", (it.ai || {}).status, it.review || "미검토", sc.has(it.cid) ? "선택" : ""]), { 담보명: 50, "분류 근거": 60, "근거 인용": 60 });
    }
    const cd = (await TT.get(doc, "cards.json", {})) || {};
    const crow = [];
    for (const [cid, card] of Object.entries(cd)) if (sel.has(cid)) for (const [sec, lab] of [["items", "A 보장 세부조건"], ["cautions", "B 전산화 주의사항"], ["isolated", "근거 불일치(격리)"]])
      for (const it of card[sec] || []) crow.push([cid, card.name, lab, it.field || it.topic, it.content, it.check, (it.interpretations || []).join("; "),
        (it.evidence || []).map((e) => `${e.id} (${e.page}쪽) “${e.quote}”`).join("\n"), it.review || "미검토"]);
    if (crow.length) sheet(wb, "결과카드", ["담보ID", "담보명", "구분", "항목", "내용", "근거 상태", "가능한 해석", "근거(조문·쪽·인용)", "검토"], crow, { 담보명: 30, 내용: 70, "근거(조문·쪽·인용)": 70 });
    const ed = (await TT.get(doc, "ecs.json", {})) || {};
    const erow = [];
    for (const cid of Object.keys(ed)) if (sel.has(cid)) {
      const v = await TT.ecsViewRows(doc, cid);
      for (const r of v.rows) for (const f of TT.ECS_FIELDS) {
        const c = r.fields[f.key], b = c.before || {};
        erow.push([cid, v.name, r.label, f.group, f.label, b.code, b.name, c.code, c.name, c.status, (c.flags || []).join(", "), c.evidence.map((e) => e.page + "쪽").join(", "), c.note, c.review]);
      }
    }
    if (erow.length) sheet(wb, "ECS초안", ["담보ID", "담보명", "룰 행", "구역", "필드", "수정 전 코드", "수정 전 명칭", "수정 후 코드", "수정 후 명칭", "상태", "표시", "근거 쪽", "비고", "검토"], erow, { 담보명: 30, "룰 행": 30, "수정 후 명칭": 30, 표시: 30 });
    sheet(wb, "수정이력", ["시각", "작업자", "구분", "내용"], history.map((h) => [h.at, h.user, h.what, JSON.stringify(h.data)]), { 내용: 100 });
    return X().write(wb, { type: "array", bookType: "xlsx" });
  };

  TT.exportZip = async function (doc, cids) {
    const sel = cids && cids.length ? new Set(cids) : null;
    const cmap = JSON.parse(JSON.stringify(await TT.get(doc, "coverage_map.json")));
    const terms = JSON.parse(JSON.stringify(await TT.get(doc, "terms.json")));
    const tables = JSON.parse(JSON.stringify(await TT.get(doc, "tables.json")));
    const pages = JSON.parse(JSON.stringify(await TT.get(doc, "pages.json")));
    const reviews = (await TT.get(doc, "reviews.json", {})) || {};
    if (sel) {
      cmap.coverages = cmap.coverages.filter((c) => sel.has(c.cid));
      terms.nodes = Object.fromEntries(Object.entries(terms.nodes).filter(([, v]) => sel.has(v.cid)));
      terms.orders = Object.fromEntries(Object.entries(terms.orders).filter(([k]) => sel.has(k)));
      terms.refs = terms.refs.filter((r) => sel.has(r.cid));
      delete terms.line_owner;
      tables.tables = tables.tables.filter((t) => sel.has(t.cid));
      pages.pages = pages.pages.filter((p) => sel.has(p.cid));
    }
    for (const c of cmap.coverages) c.review = reviews[c.cid] || { status: "미검토" };
    const zip = new root.JSZip();
    const files = { "coverage_map.json": cmap, "terms.json": terms, "tables.json": tables, "pages.json": pages, "report.json": await TT.get(doc, "report.json") };
    for (const extra of ["classification.json", "cards.json", "ecs.json"]) {
      let v = await TT.get(doc, extra);
      if (!v) continue;
      v = JSON.parse(JSON.stringify(v));
      if (sel && extra === "classification.json") v.items = Object.fromEntries(Object.entries(v.items).filter(([k]) => sel.has(k)));
      else if (sel) v = Object.fromEntries(Object.entries(v).filter(([k]) => sel.has(k)));
      files[extra] = v;
    }
    for (const [k, v] of Object.entries(files)) zip.file(k, JSON.stringify(v, null, 1));
    return zip.generateAsync({ type: "blob" });
  };

  TT.compareExcel = async function (doc, onlyChanged) {
    const d = await TT.get(doc, "compare.json");
    if (!d) throw new Error("비교 결과가 없습니다.");
    const wb = X().utils.book_new();
    const ps = d.pairs.filter((p) => !onlyChanged || p.status !== "동일");
    sheet(wb, "비교요약", ["변경구분", "의견", "신 담보ID", "신 담보명", "신 쪽", "구 담보ID", "구 담보명", "구 쪽", "매칭", "ECS 룰 수정 필요 필드", "필드 판단 근거"],
      ps.map((p) => [p.status, p.opinion, p.new, p.new_name, (p.new_range || []).join("-"), p.old, p.old_name, (p.old_range || []).join("-"), `${p.how} ${p.score}`, p.fields.join(", "), p.field_source]), { "신 담보명": 40, "구 담보명": 40, "ECS 룰 수정 필요 필드": 40 });
    const rows = [];
    for (const p of d.pairs) for (const a of p.articles) if (a.status !== "동일") {
      const side = (keep) => a.ops.filter(([o]) => o === "=" || o === keep).map(([o, t]) => (o === "=" ? t : `[[${t}]]`)).join(" ");
      rows.push([p.new || p.old, a.key, a.title, a.status, a.opinion, a.old_page, a.new_page, side("-"), side("+"), a.fields.join(", ")]);
    }
    sheet(wb, "조문변경", ["신 담보ID", "조문", "제목", "변경구분", "의견", "구 쪽", "신 쪽", "구 원문(바뀐 부분)", "신 원문(바뀐 부분)", "ECS 수정 필요 필드"], rows, { "구 원문(바뀐 부분)": 70, "신 원문(바뀐 부분)": 70 });
    const er = [];
    const newEcs = (await TT.get(doc, "ecs.json", {})) || {}, oldEcs = (await TT.get(d.old_doc, "ecs.json", {})) || {};
    for (const p of ps) {
      if (p.new && newEcs[p.new]) {
        const v = await TT.ecsViewRows(doc, p.new, p.old && oldEcs[p.old] ? oldEcs[p.old].rows : []);
        for (const r of v.rows) for (const f of TT.ECS_FIELDS) {
          const c = r.fields[f.key], b = c.before || {};
          const ch = (b.code || "") + "|" + (b.name || "") !== c.code + "|" + c.name;
          er.push([p.new, p.new_name, r.label, f.label, b.code, b.name, c.code, c.name, ch ? "변경" : "", c.status, c.evidence.map((e) => e.page).join(", ")]);
        }
      } else for (const f of p.fields) er.push([p.new || p.old, p.new_name || p.old_name, "(4단계 초안 없음)", f, "", "", "", "", "수정 필요 추정", p.status, ""]);
    }
    sheet(wb, "ECS 수정전후", ["신 담보ID", "담보명", "룰 행", "필드", "수정 전 코드", "수정 전 명칭", "수정 후 코드", "수정 후 명칭", "변경", "상태", "근거 쪽(신)"], er, { 담보명: 30, "룰 행": 30 });
    return X().write(wb, { type: "array", bookType: "xlsx" });
  };
})(typeof self !== "undefined" ? self : globalThis);
