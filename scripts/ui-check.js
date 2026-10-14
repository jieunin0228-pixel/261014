// 화면 점검: 서버를 띄우고 샘플 PDF 를 올린 뒤 트리 선택·부분 선택·편집·캐시 재사용을 확인하고 화면을 캡처합니다.
// 실행: NODE_PATH=$(npm root -g) node scripts/ui-check.js <캡처 저장 폴더>   (Playwright 필요)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-ui-'));
const app = require('../server/index');
const outDir = process.argv[2] || os.tmpdir();

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(url);
    await page.setInputFiles('#file', path.join(__dirname, '..', 'samples', 'sample_policy.pdf'));
    await page.waitForSelector('#workspace:not([hidden])', { timeout: 60000 });
    await page.waitForSelector('.warning.strong');
    assert.match(await page.textContent('.warning.strong'), /OCR 필요/);

    // 대분류 "진단" 체크 → 하위 전체 선택
    const diag = page.locator('.node.cat', { hasText: '진단' }).first();
    await diag.locator('.node-row input').first().check();
    const diagCount = await diag.locator('.leaf input').count();
    assert.equal(await page.locator('.card').count(), diagCount);

    // 담보 하나 해제 → 대분류 부분 선택
    await diag.locator('.leaf input').first().uncheck();
    assert.equal(await diag.locator('.node-row input').first().evaluate((el) => el.indeterminate), true);
    assert.equal(await page.locator('.card').count(), diagCount - 1);
    await page.screenshot({ path: path.join(outDir, 'ui-1-tree.png'), fullPage: false });

    // 편집: "응급실내원보험금"을 치료로 옮기고 이름을 고침
    const leaf = page.locator('.leaf', { hasText: '응급실내원보험금' });
    await leaf.locator('[data-edit]').click();
    await page.fill('#edit-form input[name=name]', '응급실내원보험금(수정)');
    await page.selectOption('#edit-form select[name=category]', '치료');
    await page.click('#edit-form button[value=save]');
    await page.waitForSelector('.node.cat:has-text("치료") .leaf:has-text("응급실내원보험금(수정)")');
    assert.equal(await page.locator('.node.cat').nth(5).locator('.leaf', { hasText: '응급실내원보험금' }).count(), 0);
    assert.match(await page.locator('.leaf', { hasText: '응급실내원보험금(수정)' }).locator('.reason').textContent(), /사용자가 치료/);

    // 새로 고침해도 수정·선택이 유지되는지(이 PC에 저장)
    await page.waitForFunction(() => document.getElementById('save-state').textContent.includes('저장됨'));
    const id = await page.evaluate(() => document.querySelector('#recent option[value]:not([value=""])').value);
    await page.reload();
    await page.selectOption('#recent', id);
    await page.waitForSelector('.leaf:has-text("응급실내원보험금(수정)")');
    assert.equal(await page.locator('.card').count(), diagCount - 1);

    // 같은 PDF 재업로드 → 캐시 사용 안내
    await page.setInputFiles('#file', path.join(__dirname, '..', 'samples', 'sample_policy.pdf'));
    await page.waitForFunction(() => document.getElementById('progress-msg').textContent.includes('이미 분석한 PDF'));
    await page.screenshot({ path: path.join(outDir, 'ui-2-cards.png'), fullPage: false });
    assert.deepEqual(errors, []);
    console.log(`화면 점검 통과. 캡처: ${outDir}/ui-1-tree.png, ui-2-cards.png`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
