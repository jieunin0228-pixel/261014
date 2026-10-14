// 화면 점검: node scripts/ui_check.js <저장 폴더> [문서ID]  (서버가 127.0.0.1:8765에서 실행 중이어야 함)
const { chromium } = require("playwright");
const out = process.argv[2] || ".";
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("http://127.0.0.1:8765/");
  await page.waitForSelector("#docSelect option[value]:not([value=''])", { state: "attached" });
  const id = process.argv[3] || await page.$eval("#docSelect option[value]:not([value=''])", (o) => o.value);
  await page.selectOption("#docSelect", id);
  await page.fill("#pageInput", "51"); await page.press("#pageInput", "Enter");
  await page.waitForSelector(".card");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/ui-verify.png` });
  const cards = await page.$$eval(".card", (cs) => cs.map((c) => c.dataset.cid));
  console.log("51쪽 조각:", cards.join(", "));
  // 참조 칩을 눌러 이동
  const chip = await page.$(".ref[data-goto]");
  if (chip) { const t = await chip.textContent(); await chip.click(); await page.waitForTimeout(600);
    console.log("참조 이동:", t, "→ 쪽", await page.inputValue("#pageInput")); }
  // 글자 수정
  await page.fill("#pageInput", "51"); await page.press("#pageInput", "Enter"); await page.waitForTimeout(500);
  await page.fill("#reviewer", "검토자A");
  const first = page.locator('.card[data-cid="S006|제7조"]');
  await first.locator("[data-act=text]").click();
  const ta = first.locator("textarea");
  await ta.fill((await ta.inputValue()) + "\n(점검용 수정)");
  await first.locator("[data-act=saveText]").click();
  await page.waitForSelector('.card:has-text("점검용 수정")', { timeout: 15000 });
  console.log("수정 후 표시:", await page.locator('.card:has-text("점검용 수정")').count() > 0);
  await page.screenshot({ path: `${out}/ui-edited.png` });
  // 품질 보고서
  await page.click("#tabs button[data-tab=report]"); await page.waitForSelector(".group");
  await page.screenshot({ path: `${out}/ui-report.png`, fullPage: false });
  console.log("보고서 그룹:", await page.$$eval(".group summary", (s) => s.map((x) => x.textContent.trim()).join(" | ")));
  // 표
  await page.click("#tabs button[data-tab=tables]"); await page.waitForSelector(".tcard");
  await page.screenshot({ path: `${out}/ui-tables.png` });
  // 이력
  await page.click("#tabs button[data-tab=history]"); await page.waitForSelector("#historyBody table");
  console.log("이력 행:", await page.$$eval("#historyBody table:nth-of-type(2) tr", (r) => r.length - 1));
  // 승인
  page.on("dialog", (d) => d.accept());
  await page.click("#approveBtn"); await page.waitForTimeout(800);
  console.log("승인 표시:", await page.textContent("#approvalBadge"));
  // 되돌리기
  await page.click("#tabs button[data-tab=history]"); await page.waitForSelector("#resetBtn");
  await page.click("#resetBtn"); await page.waitForTimeout(2500);
  console.log("되돌린 뒤 승인 표시:", await page.textContent("#approvalBadge"));
  // 구간
  await page.click("#tabs button[data-tab=sections]"); await page.waitForSelector("#sectionsBody table");
  console.log("구간 수:", await page.$$eval("#sectionsBody tr.click", (r) => r.length));
  console.log("오류:", errors.length ? errors : "없음");
  await browser.close();
})();
