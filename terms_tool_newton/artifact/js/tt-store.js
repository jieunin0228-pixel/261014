/* 저장소와 변환 작업 관리(converter/pipeline.py 이식).
 * 모든 데이터는 이 브라우저의 IndexedDB에만 저장합니다(다른 사람·다른 PC와 공유되지 않음).
 */
(function (root) {
  "use strict";
  const TT = (root.TT = root.TT || {});
  const DB_NAME = "terms-tool", STORE = "kv";
  TT.PIPELINE_VERSION = "js-1.0";
  let dbp = null;
  const mem = new Map();   // 같은 페이지 안에서 다시 읽지 않도록 하는 캐시

  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { rej(e); return; }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    }).catch((e) => { console.warn("IndexedDB를 쓸 수 없어 이 창을 닫으면 데이터가 사라집니다.", e); return null; });
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await openDb();
    if (!db) return fn(null);
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode), st = t.objectStore(STORE);
      const r = fn(st);
      t.oncomplete = () => res(r && r.result !== undefined ? r.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("저장 실패(브라우저 저장 공간이 부족할 수 있습니다)"));
    });
  }
  TT.persistent = async () => !!(await openDb());

  TT.get = async function (doc, name, dflt = null) {
    const k = doc + "/" + name;
    if (mem.has(k)) return mem.get(k);
    const v = await tx("readonly", (st) => (st ? st.get(k) : null));
    const out = v === undefined || v === null ? dflt : v;
    if (v !== undefined && v !== null) mem.set(k, v);
    return out;
  };
  TT.put = async function (doc, name, value) {
    const k = doc + "/" + name;
    mem.set(k, value);
    await tx("readwrite", (st) => (st ? st.put(value, k) : null));
  };
  TT.del = async function (doc, name) {
    const k = doc + "/" + name;
    mem.delete(k);
    await tx("readwrite", (st) => (st ? st.delete(k) : null));
  };
  TT.keys = async function () {
    const db = await openDb();
    if (!db) return [...mem.keys()];
    return new Promise((res) => {
      const r = db.transaction(STORE).objectStore(STORE).getAllKeys();
      r.onsuccess = () => res(r.result);
      r.onerror = () => res([]);
    });
  };

  TT.now = () => {
    const d = new Date(), z = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
  };
  TT.uid = () => Math.random().toString(16).slice(2, 10);

  TT.sha256 = async function (buf) {
    const h = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  TT.listDocs = async function () {
    const docs = (await TT.get("_", "docs", [])) || [];
    const out = [];
    for (const d of docs) {
      const meta = await TT.get(d, "meta.json");
      if (!meta) continue;
      const appr = (await TT.get(d, "approval.json", {})) || {};
      out.push({ id: d, filename: meta.filename, page_count: meta.page_count, created: meta.created, converted: !!meta.converted, approved: !!appr.approved, version: meta.version });
    }
    return out;
  };

  // ------------------------------------------------------------ 작업(진행률)
  const jobs = {};
  TT.job = (id) => jobs[id];
  TT.startTask = function (doc, fn, label) {
    const job = { id: TT.uid(), doc_id: doc, done: false, error: null, stage: label, frac: 0, msg: "" };
    jobs[job.id] = job;
    const set = async (s, f, m = "") => { Object.assign(job, { stage: s, frac: Math.round(f * 1000) / 1000, msg: m }); await new Promise((r) => setTimeout(r, 0)); };
    (async () => {
      try { await fn(set); await set("완료", 1); }
      catch (e) { job.error = (e && e.message) || String(e); console.error(e); }
      job.done = true;
    })();
    return job;
  };

  // PDF 열기(pdf.js). 같은 문서는 다시 열지 않습니다.
  const pdfCache = new Map();
  TT.openPdf = async function (doc) {
    if (pdfCache.has(doc)) return pdfCache.get(doc);
    const bytes = await TT.get(doc, "source.pdf");
    if (!bytes) throw new Error("원본 PDF가 이 브라우저에 없습니다. 문서를 다시 올려 주세요.");
    const p = root.pdfjsLib.getDocument(Object.assign({ data: new Uint8Array(bytes.slice(0)) }, TT.pdfOptions || {})).promise;
    pdfCache.set(doc, p);
    return p;
  };

  TT.startConversion = async function (file, force) {
    const buf = await file.arrayBuffer();
    const digest = await TT.sha256(buf);
    const doc = digest.slice(0, 16);
    const docs = (await TT.get("_", "docs", [])) || [];
    if (!docs.includes(doc)) { docs.push(doc); await TT.put("_", "docs", docs); }
    if (!(await TT.get(doc, "source.pdf"))) await TT.put(doc, "source.pdf", buf);
    const meta = (await TT.get(doc, "meta.json")) || {};
    meta.filename = meta.filename || file.name;
    meta.created = meta.created || TT.now();
    meta.sha256 = digest;
    await TT.put(doc, "meta.json", meta);
    if (!force && meta.version === TT.PIPELINE_VERSION && (await TT.get(doc, "report.json"))) {
      return { id: TT.uid(), doc_id: doc, done: true, cached: true, stage: "캐시 사용", frac: 1, msg: "같은 PDF의 이전 변환 결과를 사용합니다." };
    }
    return TT.startTask(doc, async (set) => {
      const pdf = await TT.openPdf(doc);
      const raw = await TT.extractPdf(pdf, root.pdfjsLib.OPS, set);
      await set("저장", 0.92);
      await TT.put(doc, "raw_pages.json", raw);
      await set("목차·머리글 대조, 조문 구조화, 참조 연결", 0.95);
      await TT.rebuild(doc, raw);
      const m = await TT.get(doc, "meta.json");
      Object.assign(m, { version: TT.PIPELINE_VERSION, page_count: raw.meta.page_count, converted: TT.now() });
      await TT.put(doc, "meta.json", m);
    }, "변환");
  };

  TT.rebuild = async function (doc, raw) {
    raw = raw || (await TT.get(doc, "raw_pages.json"));
    const edits = (await TT.get(doc, "edits.json", [])) || [];
    const res = TT.buildStructure(raw.pages, raw.meta, edits);
    const meta = (await TT.get(doc, "meta.json")) || {};
    await TT.put(doc, "coverage_map.json", { doc: { id: doc, filename: meta.filename, page_count: raw.meta.page_count }, toc: res.toc, offset: res.offset, heading_x: res.heading_x, coverages: res.coverages });
    await TT.put(doc, "terms.json", { nodes: res.nodes, orders: res.cov_orders, refs: res.refs, line_owner: res.line_owner });
    await TT.put(doc, "tables.json", { tables: res.tables });
    await TT.put(doc, "pages.json", { pages: res.page_rows.map((r, i) => {
      const pg = raw.pages[i];
      return Object.assign({}, r, { printed: pg.printed, chars: pg.chars, low_text: pg.low_text, scanned: pg.scanned, ocr: pg.ocr, internal_toc: res.toc_internal.includes(pg.p), w: pg.w, h: pg.h });
    }) });
    await TT.put(doc, "report.json", res.report);
    return res;
  };

  // ------------------------------------------------------------ 수정·검토·승인
  async function history(doc, what, data, user) {
    const h = (await TT.get(doc, "history.json", [])) || [];
    h.push({ at: TT.now(), user, what, data });
    await TT.put(doc, "history.json", h);
  }
  TT.history = history;

  async function touchAfterEdit(doc, cid, user) {
    if (cid) {
      const rv = (await TT.get(doc, "reviews.json", {})) || {};
      if ((rv[cid] || {}).status === "검토완료") { rv[cid] = { status: "미검토", at: TT.now(), user, note: "수정으로 검토 상태 초기화" }; await TT.put(doc, "reviews.json", rv); }
    }
    const appr = (await TT.get(doc, "approval.json", {})) || {};
    if (appr.approved) {
      Object.assign(appr, { approved: false, revoked_at: TT.now(), revoked_reason: "승인 후 수정이 발생함" });
      await TT.put(doc, "approval.json", appr);
      await history(doc, "승인 자동 해제", { reason: "승인 후 수정" }, user);
    }
  }

  TT.addEdit = async function (doc, edit, user) {
    const edits = (await TT.get(doc, "edits.json", [])) || [];
    Object.assign(edit, { eid: TT.uid(), at: TT.now(), user, active: true });
    edits.push(edit);
    await TT.put(doc, "edits.json", edits);
    await history(doc, "수정", edit, user);
    await touchAfterEdit(doc, edit.cid, user);
    return TT.rebuild(doc);
  };
  TT.undoEdit = async function (doc, eid, user) {
    const edits = (await TT.get(doc, "edits.json", [])) || [];
    const hit = edits.find((e) => e.eid === eid && e.active !== false);
    if (!hit) throw new Error("수정 항목 없음");
    hit.active = false; hit.undone_at = TT.now();
    await TT.put(doc, "edits.json", edits);
    await history(doc, "되돌리기", hit, user);
    await touchAfterEdit(doc, hit.cid, user);
    return TT.rebuild(doc);
  };
  TT.setReview = async function (doc, cid, status, user) {
    if (!["미검토", "검토완료"].includes(status)) throw new Error("검토 상태는 미검토/검토완료 중 하나입니다.");
    const rv = (await TT.get(doc, "reviews.json", {})) || {};
    rv[cid] = { status, at: TT.now(), user };
    await TT.put(doc, "reviews.json", rv);
    await history(doc, "검토 상태", { cid, status }, user);
    return rv;
  };
  TT.setApproval = async function (doc, approved, user) {
    let appr = (await TT.get(doc, "approval.json", {})) || {};
    if (approved) {
      const rep = (await TT.get(doc, "report.json")) || {};
      const edits = ((await TT.get(doc, "edits.json", [])) || []).filter((e) => e.active !== false).length;
      appr = { approved: true, at: TT.now(), user, snapshot: { edits, toc_count: rep.toc_count } };
    } else Object.assign(appr, { approved: false, revoked_at: TT.now(), revoked_reason: "사용자 승인 취소" });
    await TT.put(doc, "approval.json", appr);
    await history(doc, approved ? "변환 승인" : "승인 취소", {}, user);
    return appr;
  };
  TT.isApproved = async (doc) => !!((await TT.get(doc, "approval.json", {})) || {}).approved;

  TT.deleteDoc = async function (doc) {
    const keys = (await TT.keys()).filter((k) => String(k).startsWith(doc + "/"));
    for (const k of keys) await TT.del(doc, String(k).slice(doc.length + 1));
    const docs = ((await TT.get("_", "docs", [])) || []).filter((d) => d !== doc);
    await TT.put("_", "docs", docs);
    pdfCache.delete(doc);
  };
})(typeof self !== "undefined" ? self : globalThis);
