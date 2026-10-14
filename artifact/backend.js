/* 브라우저 안 처리 계층. 로컬 서버(termsapp/server.py)와 같은 주소로 응답하므로 화면 코드(app.js)를 그대로 씁니다.
 * - PDF와 변환 결과는 이 브라우저의 IndexedDB에만 저장합니다(외부 전송 없음).
 * - 3단계 요약만 claude.ai의 Claude 호출 기능(sample)을 씁니다. */
(function (root) {
  "use strict";
  const E = root.TermsEngine;
  const enc = new TextEncoder();
  const nowStr = () => { const d = new Date(), p = (v) => String(v).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  // ------------------------------------------------------------ 저장소(IndexedDB)
  let dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open("terms-app", 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }).catch(() => null);
    return dbp;
  }
  const mem = new Map(); // IndexedDB를 쓸 수 없을 때(사생활 보호 창 등) 이 화면에서만 보관
  async function put(key, val) {
    mem.set(key, val);
    const d = await idb(); if (!d) return;
    await new Promise((res) => { try { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(val, key); t.oncomplete = res; t.onerror = res; } catch (e) { res(); } });
  }
  async function get(key) {
    if (mem.has(key)) return mem.get(key);
    const d = await idb(); if (!d) return undefined;
    return new Promise((res) => { try { const r = d.transaction("kv").objectStore("kv").get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); } catch (e) { res(undefined); } });
  }
  async function del(key) {
    mem.delete(key);
    const d = await idb(); if (!d) return;
    await new Promise((res) => { try { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").delete(key); t.oncomplete = res; t.onerror = res; } catch (e) { res(); } });
  }
  const storageOk = async () => !!(await idb());

  // ------------------------------------------------------------ pdf.js
  class BundledCMapReader {
    async fetch({ name }) {
      const b64 = root.PDF_CMAPS_KO && root.PDF_CMAPS_KO[name];
      if (!b64) throw new Error(`문자표 ${name}이(가) 없어 이 글꼴의 글자를 읽을 수 없습니다.`);
      const bin = atob(b64), data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      return { cMapData: data, compressionType: 1 };
    }
  }
  const pdfCache = new Map();
  async function openPdf(id, bytes) {
    if (pdfCache.has(id)) return pdfCache.get(id);
    bytes = bytes || (await get(`${id}:pdf`));
    if (!bytes) throw new HttpError(404, "원본 PDF가 이 브라우저에 없습니다");
    const p = root.pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false, CMapReaderFactory: BundledCMapReader, useWorkerFetch: false }).promise;
    pdfCache.set(id, p);
    return p;
  }
  async function sha(bytes) {
    try { const h = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24); }
    catch (e) { let h = 0; const v = new Uint8Array(bytes); for (let i = 0; i < v.length; i += 97) h = (h * 31 + v[i]) >>> 0; return "x" + h.toString(16) + v.length.toString(16); }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // ------------------------------------------------------------ 문서
  const docs = new Map(); const jobs = new Map();
  async function listDocs() {
    const ids = (await get("doc-ids")) || [];
    const out = [];
    for (const id of ids) {
      const meta = await get(`${id}:meta`); if (!meta) continue;
      const st = (await get(`${id}:status`)) || {};
      out.push({ id, filename: meta.filename, pages: meta.pages, converted_at: meta.converted_at, approved: !!st.approved, current: true });
    }
    for (const [id, j] of jobs) if (!j.finished && !out.some((d) => d.id === id)) out.push({ id, filename: j.filename, converting: true });
    return out;
  }

  async function loadDoc(id) {
    if (docs.has(id)) return docs.get(id);
    const meta = await get(`${id}:meta`);
    if (!meta) throw new HttpError(404, "변환된 문서가 없습니다");
    const d = { id, meta, terms: await get(`${id}:terms`), pages: await get(`${id}:pages`), tables: await get(`${id}:tables`),
      report: await get(`${id}:report`), edits: (await get(`${id}:edits`)) || [], status: (await get(`${id}:status`)) || { approved: false, history: [] },
      coverage: await get(`${id}:coverage`), covEdits: (await get(`${id}:covEdits`)) || [], summaries: (await get(`${id}:summaries`)) || {} };
    index(d); docs.set(id, d); return d;
  }
  function index(d) {
    d.byUid = new Map(d.terms.nodes.map((n) => [n.uid, n])); d.byCid = new Map(d.terms.nodes.map((n) => [n.cid, n]));
    d.pageNodes = new Map();
    for (const n of d.terms.nodes) for (const p of new Set(n.lines.map((l) => l.p))) (d.pageNodes.get(p) || d.pageNodes.set(p, []).get(p)).push(n);
  }
  async function save(d, ...names) {
    const map = { terms: d.terms, tables: d.tables, report: d.report, edits: d.edits, status: d.status, coverage: d.coverage, covEdits: d.covEdits, summaries: d.summaries };
    for (const n of names) await put(`${d.id}:${n}`, clone(map[n]));
  }

  async function convert(file, force) {
    const bytes = await file.arrayBuffer();
    const id = await sha(bytes);
    if (!force && (await get(`${id}:meta`))) return { id, cached: true };
    const job = { stage: "PDF 여는 중", done: 0, total: 1, filename: file.name, finished: false, error: "" };
    jobs.set(id, job);
    (async () => {
      try {
        await put(`${id}:pdf`, bytes);
        pdfCache.delete(id);
        const pdf = await openPdf(id, bytes);
        const pages = [], tables = [], OPS = root.pdfjsLib.OPS;
        job.total = pdf.numPages; job.stage = "쪽별 텍스트·표 추출";
        for (let n = 1; n <= pdf.numPages; n++) {
          const pg = await pdf.getPage(n), vp = pg.getViewport({ scale: 1 });
          const tc = await pg.getTextContent(), ops = await pg.getOperatorList();
          pages.push(E.processPage(n, vp.width, vp.height, tc.items, ops, OPS, tables));
          pg.cleanup(); job.done = n;
          if (n % 4 === 0) await tick();
        }
        job.stage = "목차·구간·조문 분해"; job.done = 0; job.total = 1; await tick();
        const bms = [];
        try {
          for (const o of (await pdf.getOutline()) || []) {
            try { const dd = typeof o.dest === "string" ? await pdf.getDestination(o.dest) : o.dest; bms.push({ level: 1, title: o.title, page: (await pdf.getPageIndex(dd[0])) + 1 }); } catch (e) { /* 연결 안 된 북마크 */ }
          }
        } catch (e) { /* 북마크 없음 */ }
        const terms = E.structureDoc(pages, bms);
        job.stage = "참조 연결·품질 점검"; await tick();
        const report = E.finalize(terms, pages, tables);
        terms.doc = { filename: file.name, pages: pdf.numPages };
        const pageMeta = pages.map(({ lines, ...rest }) => rest);
        const meta = { version: "web-1.0", filename: file.name, pages: pdf.numPages, converted_at: nowStr() };
        job.stage = "저장"; await tick();
        await put(`${id}:terms`, terms); await put(`${id}:orig`, terms); await put(`${id}:pages`, pageMeta);
        await put(`${id}:tables`, tables); await put(`${id}:report`, report); await put(`${id}:edits`, []);
        await put(`${id}:status`, { approved: false, history: [] });
        for (const k of ["coverage", "covEdits", "summaries"]) await del(`${id}:${k}`);
        await put(`${id}:meta`, meta);
        const ids = (await get("doc-ids")) || []; if (!ids.includes(id)) ids.push(id); await put("doc-ids", ids);
        docs.delete(id); job.stage = "완료"; job.done = 1;
      } catch (e) { job.error = `${e.name || "오류"}: ${e.message}`; }
      finally { job.finished = true; }
    })();
    return { id, cached: false };
  }

  function summary(d) {
    return { id: d.id, meta: d.meta, status: d.status, stats: d.report.stats, counts: Object.fromEntries(d.report.groups.map((g) => [g.key, g.count])),
      toc_source: d.terms.toc_source, article_style: d.terms.article_style,
      sections: d.terms.sections.map((s) => ({ id: s.id, title: s.title, kind: s.kind, page_start: s.page_start, page_end: s.page_end, toc_pages: s.toc_pages })),
      edits: d.edits.length };
  }
  function pageView(d, pn) {
    const page = d.pages[pn - 1];
    const order = new Map(d.terms.nodes.map((n, i) => [n.uid, i]));
    const nodes = (d.pageNodes.get(pn) || []).slice().sort((a, b) => order.get(a.uid) - order.get(b.uid)).map((n) => ({
      uid: n.uid, cid: n.cid, kind: n.kind, num: n.num, title: n.title, label: n.label, text: n.text, path: n.path, page_start: n.page_start,
      page_end: n.page_end, parent: n.parent, dup: n.dup, edited: n.edited, boxes: n.lines.filter((l) => l.p === pn).map((l) => l.bbox),
      lines_total: n.lines.length, kind_name: E.KIND_NAMES[n.kind] || n.kind }));
    const uids = new Set(nodes.map((n) => n.uid));
    return { page, section: d.terms.sections.find((s) => s.id === page.section) || null, nodes,
      refs: d.terms.refs.filter((r) => uids.has(r.from_uid)), tables: d.tables.filter((t) => t.page === pn) };
  }
  async function recompute(d) { d.report = E.finalize(d.terms, d.pages, d.tables); index(d); await save(d, "terms", "tables", "report"); }

  async function applyEdit(d, body) {
    let entry;
    try { entry = E.applyEdit(d.terms, body.op, body); } catch (e) { throw new HttpError(400, e.message); }
    await recompute(d);
    const after = d.byUid.get(body.uid);
    Object.assign(entry, { ts: nowStr(), user: body.user || "", cid_after: after ? after.cid : "" });
    d.edits.push(entry);
    if (d.status.approved) { d.status.approved = false; d.status.history.push({ ts: nowStr(), user: body.user || "", action: "승인 해제", note: "승인 후 수정이 있어 승인이 해제되었습니다" }); }
    await save(d, "edits", "status");
    return { entry, summary: summary(d) };
  }

  // ------------------------------------------------------------ 2단계
  function requireApproved(d) { if (!d.status.approved) throw new HttpError(409, "1단계 변환 승인 전에는 담보 분류를 열 수 없습니다. 원본 대조 후 [변환 승인]을 눌러 주십시오."); }
  async function coverage(d) {
    requireApproved(d);
    if (!d.coverage) await buildCoverage(d, true);
    return { ...d.coverage, stale: (d.coverage.built_from || {}).edits !== d.edits.length };
  }
  async function buildCoverage(d, keepUser) {
    requireApproved(d);
    const cov = E.buildCoverage(d.terms, d.tables);
    if (d.coverage && keepUser) {
      const prev = new Map(d.coverage.items.map((i) => [E.itemKey(i), i]));
      for (const it of cov.items) { const o = prev.get(E.itemKey(it)); if (o) for (const k of ["name", "major", "middle", "minor", "selected", "moved", "renamed"]) it[k] = o[k]; }
    }
    cov.built_from = { approved_at: d.status.approved_at, built_at: nowStr(), edits: d.edits.length };
    d.coverage = cov; await save(d, "coverage"); return cov;
  }
  async function coverageEdit(d, body) {
    const cov = await coverage(d);
    const ids = new Set(body.ids || (body.id ? [body.id] : []));
    const items = d.coverage.items.filter((i) => ids.has(i.id));
    if (!items.length) throw new HttpError(400, "담보를 찾지 못했습니다");
    const entry = { ts: nowStr(), user: body.user || "", op: body.op, ids: [...ids].sort() };
    if (body.op === "move") {
      if (!E.MAJORS.includes(body.major)) throw new HttpError(400, "대분류는 사망·장해·진단·입원·치료·기타 중 하나여야 합니다");
      const middle = (body.middle || "").trim() || "기타";
      entry.before = items.map((i) => ({ id: i.id, major: i.major, middle: i.middle, minor: i.minor }));
      for (const i of items) { i.major = body.major; i.middle = middle; if ((body.minor || "").trim()) i.minor = body.minor.trim(); i.moved = true; }
      entry.after = { major: body.major, middle, minor: body.minor || "" };
    } else if (body.op === "rename") {
      const name = (body.name || "").trim();
      if (!name || items.length !== 1) throw new HttpError(400, "이름을 바꿀 담보 하나와 새 이름이 필요합니다");
      entry.before = items[0].name; entry.after = name; items[0].name = name; items[0].renamed = name !== items[0].auto_name;
    } else if (body.op === "select") { for (const i of items) i.selected = !!body.selected; }
    else throw new HttpError(400, `알 수 없는 작업: ${body.op}`);
    await save(d, "coverage");
    if (body.op !== "select") { d.covEdits.push(entry); await save(d, "covEdits"); }
    return { ...d.coverage, stale: cov.stale };
  }

  // ------------------------------------------------------------ 3단계
  let samplePromise = null;
  const getSample = () => (samplePromise ||= (root.claude && root.claude.use ? root.claude.use("sample").catch(() => null) : Promise.resolve(null)));
  const sumJobs = new Map();
  async function summaryStatus(d) {
    await coverage(d);
    const sample = await getSample();
    const items = {};
    for (const it of d.coverage.items) {
      const s = d.summaries[it.id];
      if (s) items[it.id] = { state: "완료", mismatch: s.card.mismatch.length, at: s.at, stale: s.terms_edits !== d.edits.length };
    }
    const job = sumJobs.get(d.id);
    for (const [k, v] of Object.entries((job || {}).errors || {})) if (!items[k]) items[k] = { state: "오류", error: v };
    return { api_key: !!sample, model: "claude.ai Claude(보는 사람의 계정)", job: job ? { ...job, ctl: undefined } : {}, items };
  }
  async function runSummaries(d, body) {
    await coverage(d);
    const sample = await getSample();
    if (!sample) throw new HttpError(400, "이 화면에서는 Claude를 부를 수 없습니다(claude.ai 아티팩트로 열었는지 확인).");
    const cur = sumJobs.get(d.id);
    if (cur && !cur.finished) throw new HttpError(400, "이미 요약을 실행하고 있습니다");
    const byId = new Map(d.coverage.items.map((i) => [i.id, i]));
    let todo = (body.ids || []).map((i) => byId.get(i)).filter(Boolean);
    if (!body.force) todo = todo.filter((i) => !d.summaries[i.id]);
    const job = { total: todo.length, done: 0, current: "", errors: {}, finished: false, started_at: nowStr() };
    sumJobs.set(d.id, job);
    (async () => {
      for (const it of todo) {
        if (job.stop) break;
        job.current = it.name;
        try {
          const input = E.buildInput(it, d.terms, d.tables, d.coverage.common_sections || []);
          const prompt = E.buildPrompt(input);
          if (enc.encode(prompt).length > 250000) throw new Error(`입력이 Claude 호출 한도(256KiB)를 넘습니다(${prompt.length.toLocaleString()}자).`);
          let data;
          try { data = await sample.json(prompt, { modelTier: "complex" }); }
          catch (e) {
            if (e && e.code === "not_granted") { job.stop = true; throw new Error("Claude 사용이 허용되지 않았습니다."); }
            if (e && e.code === "rate_limited") { job.stop = true; throw new Error("Claude 사용 한도에 걸렸습니다. 잠시 후 다시 실행하십시오."); }
            throw new Error((e && e.message) || "Claude 호출 실패");
          }
          const card = E.verify(data, d.terms, d.tables, d.pages, input.ids);
          d.summaries[it.id] = { item_id: it.id, item_name: it.name, input_chars: input.common.length + input.item.length, input_ids: input.ids,
            raw: data, card, meta: { model: "claude.ai Claude (complex)" }, at: nowStr(), terms_edits: d.edits.length };
          await save(d, "summaries");
        } catch (e) { job.errors[it.id] = e.message; }
        job.done++;
      }
      job.finished = true; job.current = "";
    })();
    return job;
  }

  // ------------------------------------------------------------ 이미지·내려받기
  const imgCache = new Map();
  async function pageImage(id, pn, scale = 2) {
    const key = `${id}:${pn}:${scale}`;
    if (imgCache.has(key)) return imgCache.get(key);
    const pdf = await openPdf(id), pg = await pdf.getPage(pn), vp = pg.getViewport({ scale });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    const url = c.toDataURL("image/png");
    if (imgCache.size > 40) imgCache.delete(imgCache.keys().next().value);
    imgCache.set(key, url); return url;
  }
  async function tableImage(id, t) {
    const pdf = await openPdf(id), pg = await pdf.getPage(t.page), s = 2, vp = pg.getViewport({ scale: s });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    const [x0, y0, x1, y1] = t.bbox.map((v) => v * s), pad = 12;
    const o = document.createElement("canvas"); o.width = x1 - x0 + pad * 2; o.height = y1 - y0 + pad * 2;
    o.getContext("2d").drawImage(c, x0 - pad, y0 - pad, o.width, o.height, 0, 0, o.width, o.height);
    return o.toDataURL("image/png");
  }
  let dlPromise = null;
  const getDownloads = () => (dlPromise ||= (root.claude && root.claude.use ? root.claude.use("downloads").catch(() => null) : Promise.resolve(null)));
  async function saveFile(filename, data) {
    const dl = await getDownloads();
    if (!dl) throw new Error("이 화면에서는 파일을 내려받을 수 없습니다(claude.ai에서 열었는지 확인).");
    try { await dl.save({ filename, data }); }
    catch (e) { if (e && e.code === "cancelled") return false; throw new Error((e && e.message) || "내려받기 실패"); }
    return true;
  }
  function xlsxBytes(sheets) {
    const X = root.XLSX, wb = X.utils.book_new();
    for (const [name, rows, widths] of sheets) {
      const ws = X.utils.aoa_to_sheet(rows);
      if (widths) ws["!cols"] = widths.map((w) => ({ wch: w }));
      X.utils.book_append_sheet(wb, ws, name);
    }
    return new Uint8Array(X.write(wb, { type: "array", bookType: "xlsx" }));
  }
  function coverageXlsx(d, items, selectedOnly) {
    const head = ["ID", "대분류", "중분류", "소분류(특약)", "담보명", "자동 인식 이름", "급부 그룹", "지급사유(지급기준표 원문)", "지급금액(지급기준표 원문)", "분류 근거", "구간", "조문 범위", "주요 조문", "근거 위치", "사용자 수정"];
    const rows = [head].concat(items.map((it) => {
      const r = it.range, src = it.source;
      return [it.id, it.major, it.middle, it.minor, it.name, it.auto_name, it.group, it.pay_reason, it.pay_amount, it.reason_note, it.section_title,
        `${r.first} ~ ${r.last} (${r.pages[0]}~${r.pages[1]}쪽)`, it.key_articles.map((c) => c.split("|")[1]).join(", "),
        src.type === "지급기준표" ? `${src.appendix} ${src.table} ${src.row + 1}번째 급부 (${src.page}쪽)` : `특약 전체 (${src.page}쪽)`,
        [it.moved && "분류 이동", it.renamed && "이름 수정"].filter(Boolean).join(" ")];
    }));
    const info = [["약관", d.meta.filename], ["범위", selectedOnly ? "선택한 담보만" : "전체 담보"], ["주의", "지급사유·지급금액은 지급기준표 원문을 옮긴 것이며 해석하지 않았습니다. 분류는 낱말 규칙에 따른 제안입니다."]];
    return xlsxBytes([["담보 분류", rows, [8, 8, 12, 34, 34, 30, 26, 60, 40, 50, 40, 30, 50, 26, 14]], ["정보", info]]);
  }
  function summariesXlsx(d, items) {
    const ev = (evs) => evs.map((e) => `${e.node_id} (${e.page ?? ""}쪽/인쇄 ${e.printed_page ?? ""}): ${e.quote}`).join("\n");
    const A = [["담보ID", "담보명", "항목", "상태", "내용", "가능한 해석", "근거(조문 ID·쪽·인용)"]], B = [["담보ID", "담보명", "구분", "내용", "해석 확인 필요", "가능한 해석", "근거(조문 ID·쪽·인용)"]],
      M = [["담보ID", "담보명", "영역", "항목", "AI가 낸 내용", "격리 사유", "AI가 낸 근거"]];
    for (const it of items) {
      const s = d.summaries[it.id];
      if (!s) { A.push([it.id, it.name, "", "요약 안 함", "", "", ""]); continue; }
      for (const f of s.card.A) A.push([it.id, it.name, f.label, f.status, f.value, f.interpretations.join("\n"), ev(f.evidence)]);
      for (const x of s.card.B) B.push([it.id, it.name, x.category, x.content, x.needs_confirmation ? "예" : "", x.interpretations.join("\n"), ev(x.evidence)]);
      for (const x of s.card.mismatch) M.push([it.id, it.name, x.section, x.label || "", x.value || x.content || "", x.mismatch_reason || "", ev(x.evidence)]);
    }
    return xlsxBytes([["A 보장 세부조건", A, [8, 30, 26, 14, 70, 40, 70]], ["B 전산화 주의사항", B, [8, 30, 24, 70, 10, 40, 70]], ["근거 불일치(격리)", M, [8, 30, 8, 24, 60, 30, 70]],
      ["정보", [["약관", d.meta.filename], ["주의", "AI 해석 결과입니다. 모든 근거 인용문은 프로그램이 원문과 대조했으며, 일치하지 않은 항목은 '근거 불일치' 시트로 격리했습니다."]]]]);
  }
  async function download(d, name, opts = {}) {
    const json = (o) => JSON.stringify(o, null, 1);
    if (name === "terms.json") return saveFile(name, json(d.terms));
    if (name === "tables.json") return saveFile(name, json(d.tables));
    if (name === "pages.json") return saveFile(name, json(d.pages));
    if (name === "report.json") return saveFile(name, json(d.report));
    if (name === "edits.json") return saveFile(name, json(d.edits));
    if (name === "status.json") return saveFile(name, json(d.status));
    const cov = await coverage(d), items = cov.items.filter((i) => i.selected || !opts.selected);
    if (name === "coverage.xlsx") return saveFile(opts.selected ? "담보분류_선택.xlsx" : "담보분류_전체.xlsx", coverageXlsx(d, items, opts.selected));
    if (name === "coverage.json") return saveFile(opts.selected ? "담보분류_선택.json" : "담보분류_전체.json", json({ ...cov, items }));
    if (name === "summaries.xlsx") return saveFile(opts.selected ? "담보별요약_선택.xlsx" : "담보별요약_전체.xlsx", summariesXlsx(d, items));
    throw new HttpError(404, "내려받을 수 없는 파일입니다");
  }
  async function deleteDoc(id) {
    for (const k of ["pdf", "meta", "terms", "orig", "pages", "tables", "report", "edits", "status", "coverage", "covEdits", "summaries"]) await del(`${id}:${k}`);
    await put("doc-ids", ((await get("doc-ids")) || []).filter((x) => x !== id));
    docs.delete(id); pdfCache.delete(id);
  }

  // ------------------------------------------------------------ 주소 처리(server.py와 같은 주소)
  async function request(path, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : {};
    const url = new URL(path, "http://local"); const q = url.searchParams;
    const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // api, docs, id, ...
    if (seg[0] !== "api") throw new HttpError(404, "없는 주소");
    if (seg[1] === "docs" && seg.length === 2) return listDocs();
    const id = seg[2], rest = seg.slice(3).join("/");
    if (rest === "progress") { const j = jobs.get(id); if (j) return j; if (await get(`${id}:meta`)) return { stage: "완료", done: 1, total: 1, finished: true, error: "" }; return { stage: "없음", finished: true, error: "변환 기록이 없습니다" }; }
    if (rest === "reconvert") {
      const bytes = await get(`${id}:pdf`), meta = await get(`${id}:meta`);
      if (!bytes) throw new HttpError(404, "원본 PDF가 없습니다");
      docs.delete(id); return convert({ arrayBuffer: async () => bytes, name: meta ? meta.filename : "약관.pdf" }, true);
    }
    if (rest === "delete") { await deleteDoc(id); return { ok: true }; }
    const d = await loadDoc(id);
    if (rest === "summary") return summary(d);
    if (rest === "report") return d.report;
    if (/^pages\/\d+$/.test(rest)) { const pn = +seg[4]; if (pn < 1 || pn > d.pages.length) throw new HttpError(404, "쪽 번호가 범위를 벗어났습니다"); return pageView(d, pn); }
    if (rest === "tables") { let t = d.tables; if (q.get("page")) t = t.filter((x) => x.page === +q.get("page")); if (q.get("issues") === "true") t = t.filter((x) => x.incomplete || x.rebuilt); return t; }
    if (rest === "locate") { const n = d.byCid.get(q.get("cid")); if (!n) throw new HttpError(404, "조각을 찾지 못했습니다"); return { cid: n.cid, uid: n.uid, page: n.own_page_start || n.page_start }; }
    if (rest === "search") {
      const s = q.get("q") || "", s2 = s.replace(/ /g, ""), out = [];
      for (const n of d.terms.nodes) if (n.cid.includes(s) || (s2 && n.text.replace(/[ \n]/g, "").includes(s2))) { out.push({ cid: n.cid, uid: n.uid, page: n.own_page_start, path: n.path, text: n.text.slice(0, 80) }); if (out.length >= 50) break; }
      return out;
    }
    if (rest === "edits") return d.edits;
    if (rest === "edit") return applyEdit(d, body);
    if (rest === "reset") {
      d.terms = await get(`${id}:orig`); await recompute(d);
      d.edits.push({ ts: nowStr(), user: body.user || "", op: "reset", uid: "", cid: "", after: "모든 수정을 버리고 변환 직후 상태로 되돌림" });
      d.status.approved = false; d.status.history.push({ ts: nowStr(), user: body.user || "", action: "승인 해제", note: "원본으로 되돌려 승인 해제" });
      await save(d, "edits", "status"); return summary(d);
    }
    if (rest === "approve") {
      d.status.approved = !!body.approved;
      if (body.approved) Object.assign(d.status, { approved_at: nowStr(), approved_by: body.user || "", approved_report: Object.fromEntries(d.report.groups.map((g) => [g.key, g.count])) });
      d.status.history.push({ ts: nowStr(), user: body.user || "", action: body.approved ? "변환 승인" : "승인 해제", note: body.note || "" });
      await save(d, "status"); return d.status;
    }
    if (rest === "coverage") return coverage(d);
    if (rest === "coverage/edit") return coverageEdit(d, body);
    if (rest === "coverage/rebuild") return buildCoverage(d, body.keep_user !== false);
    if (rest === "coverage/edits") return d.covEdits;
    if (rest === "summaries") return summaryStatus(d);
    if (rest === "summaries/run") return runSummaries(d, body);
    if (rest === "summaries/stop") { const j = sumJobs.get(id); if (j) j.stop = true; return { ok: true }; }
    if (seg[3] === "summaries" && seg[4]) { const s = d.summaries[seg[4]]; if (!s) throw new HttpError(404, "아직 요약하지 않은 담보입니다"); return s; }
    throw new HttpError(404, "없는 주소");
  }

  root.TermsBackend = { request, convert, pageImage, tableImage, download, loadDoc, storageOk, getSample, getDownloads, deleteDoc, HttpError };
})(typeof self !== "undefined" ? self : this);
