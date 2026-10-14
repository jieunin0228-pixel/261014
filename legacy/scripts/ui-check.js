// 브라우저 화면 점검: 샘플 변환 → 행 클릭 → 탭 → 엑셀 다운로드 → (있으면) 정답지 비교.
// 실행: NODE_PATH=$(npm root -g) node scripts/ui-check.js [스크린샷 폴더]
const path = require('path');
const { chromium } = require('playwright');
const XLSX = require('xlsx');

(async () => {
  const out = process.argv[2] || '.';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
  await page.click('#btnSample');
  await page.click('#btnRun');
  const rows = await page.locator('tr.rule').count();
  console.log('룰 행 수:', rows);
  console.log('요약:', await page.locator('#summary').innerText());
  const colors = await page.$$eval('tr.rule', (trs) => [...new Set(trs.map((tr) => `${tr.className.match(/cat-\S+/)[0]}=${getComputedStyle(tr.cells[1]).backgroundColor}`))]);
  console.log('구분 색상:', colors.join(', '));
  await page.click('tr.rule[data-no="1"]');
  console.log('행1 상세:', (await page.locator('#detail').innerText()).split('\n').slice(0, 4).join(' | '));
  await page.screenshot({ path: path.join(out, 'ui-rules.png') });
  await page.click('.tab[data-view="manual"]');
  console.log('수기 행 수:', await page.locator('#view-manual tbody tr').count());
  await page.screenshot({ path: path.join(out, 'ui-manual.png') });
  await page.click('.tab[data-view="rules"]');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExcel')]);
  const file = path.join(out, 'download.xlsx');
  await dl.saveAs(file);
  const book = XLSX.readFile(file);
  console.log('다운로드 시트:', book.SheetNames.join(', '), '/ 룰테이블 행:', XLSX.utils.sheet_to_json(book.Sheets['룰테이블']).length);

  if (await page.locator('#fileAnswer').count()) {
    await page.setInputFiles('#fileAnswer', path.resolve(__dirname, '..', 'samples', 'answer_key.xlsx'));
    await page.waitForTimeout(300);
    console.log('비교 후 요약:', await page.locator('#summary').innerText());
    if (await page.locator('#view-compare tbody tr').count()) {
      console.log('비교 행:', await page.locator('#view-compare tbody tr').count());
      await page.screenshot({ path: path.join(out, 'ui-compare.png') });
      const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btnExcel')]);
      await dl2.saveAs(file);
      const b2 = XLSX.readFile(file);
      console.log('비교 후 다운로드 시트:', b2.SheetNames.join(', '), '/ 정답지비교 행:', XLSX.utils.sheet_to_json(b2.Sheets['정답지비교']).length);
    }
  }
  console.log('페이지 오류:', errors.length ? errors : '없음');
  await browser.close();
  if (errors.length) process.exit(1);
})();
