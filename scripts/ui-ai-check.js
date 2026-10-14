// AI 분석 흐름 점검: claude.ai 의 window.claude 를 가짜로 심어 PDF 열기 → 담보 선택 → AI 분석 → 검증 → 엑셀 저장까지 확인합니다.
// 가짜 Claude 는 test/fixtures/ai-surgery.json 을 그대로 돌려줍니다(실제 Claude 응답 품질은 이 스크립트로 확인할 수 없습니다).
// 실행: NODE_PATH=$(npm root -g) node scripts/ui-ai-check.js [스크린샷 폴더]
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const XLSX = require('xlsx');

(async () => {
  const out = process.argv[2] || '.';
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'ai-surgery.json'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((fx) => {
    window.__prompts = [];
    const sample = async () => { throw new Error('json 만 씁니다'); };
    sample.json = async (prompt, opts) => {
      window.__prompts.push({ prompt, tier: opts.modelTier });
      await new Promise((r) => setTimeout(r, 200));
      opts.onText && opts.onText({ text: fx, delta: fx });
      return JSON.parse(fx);
    };
    const downloads = { save: async ({ filename, data }) => { window.__saved = { filename, bytes: Array.from(new Uint8Array(data)) }; return { status: 'saved' }; } };
    window.claude = { use: async (name) => ({ sample, downloads })[name] || null };
  }, fixture);
  await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
  await page.setInputFiles('#fileTerms', path.resolve(__dirname, '..', 'samples', 'dummy_policy.pdf'));
  await page.waitForFunction(() => /구간 \d+개를 찾았습니다/.test(document.getElementById('status').textContent));
  console.log('PDF 읽기:', await page.locator('#status').innerText());
  await page.fill('#coverage', '수술비');
  await page.click('#btnFind');
  console.log('대상 찾기:', await page.locator('#status').innerText());
  console.log('선택 구간:', await page.$$eval('#sections input:checked', (xs) => xs.map((x) => x.closest('label').querySelector('.t').textContent)));
  await page.click('#btnAi');
  await page.waitForFunction(() => /AI 분석:/.test(document.getElementById('status').textContent));
  console.log('AI 결과:', await page.locator('#status').innerText());
  const prompts = await page.evaluate(() => window.__prompts);
  console.log('호출 수:', prompts.length, '/ 모델:', prompts[0].tier, '/ 지시문에 수술분류표 포함:', prompts[0].prompt.includes('[별표 4] 수술분류표'));
  console.log('룰 행:', await page.locator('tr.rule').count(), '/ 수기:', await page.locator('#view-manual tbody tr').count(), '/ 근거 없음:', await page.locator('#view-missing tbody tr').count());
  await page.click('tr.rule[data-no="1"]');
  console.log('행1 상세:', (await page.locator('#detail').innerText()).split('\n').slice(0, 3).join(' | '));
  await page.screenshot({ path: path.join(out, 'ui-ai.png') });
  await page.click('#btnExcel');
  await page.waitForFunction(() => window.__saved);
  const saved = await page.evaluate(() => window.__saved);
  const book = XLSX.read(Buffer.from(saved.bytes), { type: 'buffer' });
  console.log('저장 파일:', saved.filename, '/ 시트:', book.SheetNames.join(', '));
  console.log('분석정보:', JSON.stringify(XLSX.utils.sheet_to_json(book.Sheets['분석정보'], { header: 1 }).slice(2, 6)));
  console.log('페이지 오류:', errors.length ? errors : '없음');
  await browser.close();
  if (errors.length) process.exit(1);
})();
