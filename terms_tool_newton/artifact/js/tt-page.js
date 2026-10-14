/* 브라우저 전용: pdf.js 설정과 쪽 그림 그리기 */
(function (root) {
  "use strict";
  const TT = (root.TT = root.TT || {});
  // 비내장 한글 CID 글꼴용 문자표는 vendor/cmaps-ko.js에 넣어 두고 네트워크 없이 꺼내 씁니다.
  class BundledCMapReader {
    async fetch({ name }) {
      const b64 = root.PDF_CMAPS_KO && root.PDF_CMAPS_KO[name];
      if (!b64) throw new Error(`문자표 ${name}이(가) 없어 이 글꼴의 글자를 읽을 수 없습니다.`);
      const bin = atob(b64), data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      return { cMapData: data, compressionType: 1 };
    }
  }
  TT.setupPdf = function () {
    if (!root.pdfjsLib) throw new Error("PDF 라이브러리(pdf.js)를 불러오지 못했습니다. 페이지를 새로고침하세요.");
    root.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    TT.pdfOptions = { CMapReaderFactory: BundledCMapReader, useWorkerFetch: false, isEvalSupported: false, disableFontFace: false };
  };
  const cache = new Map();
  TT.pageImage = async function (doc, p, scale) {
    const key = `${doc}|${p}|${scale}`;
    if (cache.has(key)) return cache.get(key);
    const pdf = await TT.openPdf(doc);
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    const url = URL.createObjectURL(blob);
    cache.set(key, url);
    if (cache.size > 12) { const [k, u] = cache.entries().next().value; cache.delete(k); URL.revokeObjectURL(u); }
    return url;
  };
})(typeof self !== "undefined" ? self : globalThis);
