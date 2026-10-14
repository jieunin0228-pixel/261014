// 화면 ↔ 브라우저 내부 분석(아티팩트판). PDF 는 어디로도 전송하지 않고 이 브라우저 안에서 읽습니다.
// 분석 결과와 수정 기록은 이 브라우저의 저장소(IndexedDB)에만 남깁니다. 저장소를 쓸 수 없으면 창을 닫을 때까지만 유지합니다.
(function () {
  'use strict';
  const C = window.CoverageCore;

  // pdf.js 의 문자표 읽기: 비내장 한글 CID 글꼴용 문자표를 cmaps-ko.js 에 담아 함께 게시했습니다.
  class BundledCMapReader {
    async fetch({ name }) {
      const b64 = window.PDF_CMAPS_KO && window.PDF_CMAPS_KO[name];
      if (!b64) throw new Error(`문자표 ${name}이(가) 없어 이 글꼴의 글자를 읽을 수 없습니다.`);
      const bin = atob(b64);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      return { cMapData: data, compressionType: 1 };
    }
  }

  // ───────────── 저장소 ─────────────
  const memory = { docs: new Map(), pages: new Map(), reviews: new Map() };
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open('coverage-analyzer', 1);
          req.onupgradeneeded = () => { for (const s of ['docs', 'pages', 'reviews']) req.result.createObjectStore(s); };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    return dbPromise;
  }
  async function get(store, key) {
    const d = await db();
    if (!d) return memory[store].get(key);
    try {
      return await new Promise((resolve, reject) => {
        const r = d.transaction(store).objectStore(store).get(key);
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
    } catch { return memory[store].get(key); }
  }
  async function put(store, key, value) {
    memory[store].set(key, value);
    const d = await db();
    if (!d) return false;
    try {
      await new Promise((resolve, reject) => {
        const tx = d.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      return true;
    } catch { return false; }
  }
  async function all(store) {
    const d = await db();
    if (!d) return [...memory[store].values()];
    try {
      return await new Promise((resolve, reject) => {
        const r = d.transaction(store).objectStore(store).getAll();
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
    } catch { return [...memory[store].values()]; }
  }

  // ───────────── 분석 ─────────────
  async function sha256(buf) {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function analyze(file, onProgress) {
    if (!window.pdfjsLib) throw new Error('PDF 읽기 도구(pdf.js)를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 페이지를 새로 고쳐 주십시오.');
    const buf = await file.arrayBuffer();
    if (new TextDecoder('latin1').decode(new Uint8Array(buf, 0, 5)) !== '%PDF-') throw new Error('PDF 파일이 아닙니다.');
    const id = await sha256(buf);
    const cached = await get('docs', id);
    if (cached && cached.meta.version === C.STRUCTURE_VERSION) {
      cached.meta.openedAt = new Date().toISOString();
      cached.meta.lastFileName = file.name;
      await put('docs', id, cached);
      return { id, cached: true };
    }
    const startedAt = Date.now();
    let last = 0;
    const { pages } = await C.extractPages(window.pdfjsLib, {
      data: new Uint8Array(buf), CMapReaderFactory: BundledCMapReader, useWorkerFetch: false, disableFontFace: true,
    }, (n, total) => {
      if (n === total || Date.now() - last > 120) { last = Date.now(); onProgress(0.05 + (n / total) * 0.85, `쪽별 글자 추출 ${n} / ${total}쪽`); }
    });
    // 진행 막대가 다시 그려질 틈을 줍니다.
    await new Promise((r) => setTimeout(r, 0));
    const { meta, structure, coverages } = C.analyzeStructure(pages, (done, total, message) => onProgress(0.9 + (done / total) * 0.1, message));
    const fullMeta = { id, fileName: file.name, status: 'done', ...meta, createdAt: new Date().toISOString(), seconds: Math.round((Date.now() - startedAt) / 100) / 10 };
    await put('pages', id, pages);
    await put('docs', id, { meta: fullMeta, structure, coverages });
    return { id, cached: false };
  }

  async function list() {
    return (await all('docs')).map((d) => d.meta)
      .sort((a, b) => String(b.openedAt || b.createdAt).localeCompare(String(a.openedAt || a.createdAt)));
  }

  async function open(id) {
    const d = await get('docs', id);
    if (!d) throw new Error('이 브라우저에 저장된 분석 결과가 없습니다. PDF를 다시 올려 주십시오.');
    return C.docView(d.meta, d.structure, d.coverages, (await get('reviews', id)) || {});
  }

  async function save(id, review) {
    const ok = await put('reviews', id, { ...review, savedAt: new Date().toISOString() });
    return ok;
  }

  window.CoverageApi = {
    analyze, list, open, save,
    sampleUrl: 'sample_policy.pdf',
    autoOpenSample: true,
    storageNote: '올린 PDF는 어디로도 전송되지 않고 이 브라우저 안에서만 읽습니다. 분석 결과와 수정 내용도 이 브라우저에만 저장되며, 다른 사람이나 다른 PC에서는 보이지 않습니다.',
    savedLabel: '이 브라우저에 저장됨',
  };
})();
