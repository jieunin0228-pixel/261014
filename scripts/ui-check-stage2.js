// 2단계 화면 점검: 시험용 응답(samples/ai-fixtures)으로 담보 분석 → 카드 A·B·C·D 표시 → 검토·직접 수정 저장을 확인하고 캡처합니다.
// 실행: NODE_PATH=$(npm root -g) node scripts/ui-check-stage2.js <캡처 저장 폴더>   (Playwright 필요, Claude API 는 부르지 않음)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-ui2-'));
process.env.COVERAGE_AI_FAKE = path.join(__dirname, '..', 'samples', 'ai-fixtures');
const app = require('../server/index');
const outDir = process.argv[2] || os.tmpdir();

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(url);
    await page.click('[data-open-sample] >> nth=0');
    await page.waitForSelector('#workspace:not([hidden])', { timeout: 60000 });
    await page.waitForSelector('#analysis-bar:not([hidden])');
    assert.match(await page.textContent('#cm-label'), /임시 코드마스터 사용 중/);

    // 사망보험금(시험용 응답 있음)과 재해사망보험금(없음 → 실패 표시)을 선택하고 분석
    await page.locator('.leaf', { hasText: /^\s*사망보험금/ }).first().locator('input[type=checkbox]').check();
    await page.locator('.leaf', { hasText: '재해사망보험금' }).locator('input[type=checkbox]').check();
    assert.match(await page.textContent('#run-analysis'), /선택 담보 분석 \(2건\)/);
    await page.click('#run-analysis');
    await page.waitForFunction(() => [...document.querySelectorAll('.card .status')].map((s) => s.textContent).join('|').match(/분석 완료.*\|.*분석 실패|분석 실패.*\|.*분석 완료/), null, { timeout: 30000 });

    const card = page.locator('.card', { hasText: '사망보험금' }).filter({ hasNotText: '재해사망보험금' });
    assert.match(await card.locator('.a-table').textContent(), /가입금액의 50%/);
    assert.match(await card.locator('.a-table').textContent(), /해석 확인 필요/);
    assert.match(await card.locator('.a-table').textContent(), /근거를 원문에서 확인하지 못해 표시하지 않습니다/);
    assert.equal(await card.locator('.d-row').count(), 2);
    assert.match(await card.locator('.d-table').first().textContent(), /코드 확인 필요/);
    assert.match(await page.locator('.card', { hasText: '재해사망보험금' }).textContent(), /시험용 응답 파일이 없습니다/);

    // 검토완료 체크와 "수정 후" 직접 수정이 새로 고침 뒤에도 남는지
    await card.locator('.a-table input[data-review]').first().check();
    const benefitRow = card.locator('.d-table').first().locator('tr', { hasText: '구보장급부' });
    await benefitRow.locator('input[data-part=code]').fill('S01G010221');
    await benefitRow.locator('input[data-part=code]').press('Tab');
    await page.waitForFunction(() => document.getElementById('save-state').textContent.includes('저장됨'));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(outDir, 'stage2-card.png'), fullPage: false });
    await card.locator('.d-table').first().screenshot({ path: path.join(outDir, 'stage2-dtable.png') });

    await page.reload();
    await page.waitForSelector('.card .a-table');
    const card2 = page.locator('.card', { hasText: '사망보험금' }).filter({ hasNotText: '재해사망보험금' });
    assert.equal(await card2.locator('.a-table input[data-review]').first().isChecked(), true);
    assert.equal(await card2.locator('.d-table').first().locator('tr', { hasText: '구보장급부' }).locator('input[data-part=code]').inputValue(), 'S01G010221');
    assert.match(await card2.locator('.card-status').textContent(), /검토 [1-9]/);
    assert.deepEqual(errors, []);
    console.log(`2단계 화면 점검 통과. 캡처: ${outDir}/stage2-card.png, stage2-dtable.png`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
