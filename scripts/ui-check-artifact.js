// 아티팩트판 점검: build/ 를 정적 파일로 띄우고, 샘플 자동 열기·브라우저 내 분석·저장 유지를 확인한 뒤 화면을 캡처합니다.
// 실행: node scripts/build-artifact.js && NODE_PATH=$(npm root -g) node scripts/ui-check-artifact.js <캡처 저장 폴더>
// CDN 에 닿지 않는 환경에서는 PDFJS_DIR=<pdf.min.js·pdf.worker.min.js 3.11.174 가 있는 폴더> 를 함께 줍니다.
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const express = require('express');
const { chromium } = require('playwright');
const outDir = process.argv[2] || os.tmpdir();

(async () => {
  const app = express();
  const build = path.join(__dirname, '..', 'build');
  // 아티팩트처럼 문서 골격을 씌워 제공합니다.
  app.get('/', (req, res) => res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>${require('fs').readFileSync(path.join(build, 'artifact.html'), 'utf8')}</body></html>`));
  app.use(express.static(build));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    // 점검 환경에서 CDN 에 닿지 않을 수 있으므로, 같은 버전(3.11.174)의 pdf.js 를 PDFJS_DIR 에서 대신 줍니다.
    if (process.env.PDFJS_DIR) {
      await page.route('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/*', (route) => route.fulfill({ path: path.join(process.env.PDFJS_DIR, path.basename(new URL(route.request().url()).pathname)), contentType: 'text/javascript' }));
    }
    await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ body: '', contentType: 'text/css' }));
    page.on('pageerror', (e) => errors.push(e.message));
    const uploads = [];
    page.on('request', (r) => { if (r.method() !== 'GET') uploads.push(r.url()); });
    await page.goto(url);
    // 저장된 약관이 없으므로 샘플을 자동으로 열어야 합니다.
    await page.waitForSelector('#workspace:not([hidden])', { timeout: 90000 });
    assert.match(await page.textContent('#summary'), /예시: 시험용 가상 약관/);
    assert.match(await page.textContent('#summary'), /자동 추출 담보 32개/);
    assert.match(await page.textContent('.warning.strong'), /OCR 필요/);
    await page.locator('.node.cat', { hasText: '사망' }).first().locator('.node-row input').first().check();
    assert.equal(await page.locator('.card').count(), 4);
    await page.waitForFunction(() => document.getElementById('save-state').textContent.includes('저장됨'));
    await page.screenshot({ path: path.join(outDir, 'artifact-desktop.png') });

    // 새로 고침하면 최근 약관과 선택 상태가 이 브라우저 저장소에서 복원돼야 합니다.
    await page.reload();
    await page.waitForSelector('#workspace:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 4);
    assert.deepEqual(uploads, [], 'PDF 가 어디로도 전송되지 않아야 합니다');

    // 목차 쪽 직접 지정(브라우저 안에서 다시 분석)
    await page.setInputFiles('#file', path.join(__dirname, '..', 'test', 'fixtures', 'toc-listed-policy.pdf'));
    await page.waitForFunction(() => document.getElementById('summary').textContent.includes('자동 추출 담보 4개'), null, { timeout: 60000 });
    await page.click('#toc-box > summary');
    await page.fill('#toc-from', '7');
    await page.fill('#toc-to', '8');
    await page.click('#toc-apply');
    await page.waitForFunction(() => document.getElementById('summary').textContent.includes('자동 추출 담보 7개'), null, { timeout: 60000 });
    assert.deepEqual(uploads, [], 'PDF 가 어디로도 전송되지 않아야 합니다');

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 400, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, '휴대폰 폭에서 가로 스크롤이 생기면 안 됩니다');
    await page.screenshot({ path: path.join(outDir, 'artifact-phone-dark.png') });
    assert.deepEqual(errors, []);
    console.log(`아티팩트판 점검 통과. 캡처: ${outDir}/artifact-desktop.png, artifact-phone-dark.png`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
