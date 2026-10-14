// 보통약관 + 특별약관 + 별표를 묶은 다담보 샘플 PDF(samples/dummy_policy.pdf)를 만듭니다.
// 실행: NODE_PATH=$(npm root -g) node scripts/build-sample-pdf.js   (Playwright 필요)
const path = require('path');
const { chromium } = require('playwright');
const text = `${require('../samples/dummy-terms')}\n${require('../samples/dummy-riders')}`;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`<html><body style="font: 10.5pt/1.7 'WenQuanYi Zen Hei', 'Noto Sans CJK KR', sans-serif; margin: 0">
    <pre style="white-space: pre-wrap; font: inherit; margin: 0">${esc(text)}</pre></body></html>`);
  const out = path.join(__dirname, '..', 'samples', 'dummy_policy.pdf');
  await page.pdf({ path: out, format: 'A4', margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' } });
  await browser.close();
  console.log('samples/dummy_policy.pdf 생성');
})();
