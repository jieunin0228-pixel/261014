// PDF → 텍스트(브라우저 전용). pdf.js 의 워커 스크립트를 일반 <script> 로 먼저 불러 두면
// 별도 워커 없이 메인 스레드에서 처리합니다(아티팩트는 외부 워커 생성을 막기 때문입니다).
(function (root) {
  'use strict';
  // 같은 줄로 볼 y 좌표 허용 오차(pt)
  const LINE_TOLERANCE = 2;

  async function extractPdfText(arrayBuffer, onProgress) {
    const pdf = await root.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const { items } = await page.getTextContent();
      let out = '', lastY = null;
      for (const it of items) {
        const y = it.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > LINE_TOLERANCE && !out.endsWith('\n')) out += '\n';
        out += it.str;
        if (it.hasEOL) out += '\n';
        lastY = y;
      }
      pages.push(out.replace(/[ \t]+\n/g, '\n'));
      if (onProgress) onProgress(n, pdf.numPages);
    }
    return { pages, text: pages.join('\n') };
  }

  root.EcsPdf = { extractPdfText };
})(typeof self !== 'undefined' ? self : this);
