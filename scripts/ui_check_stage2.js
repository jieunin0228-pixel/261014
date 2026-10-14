// 2단계 화면 점검: node scripts/ui_check_stage2.js <저장 폴더>  (서버 실행 중, 1단계 변환된 문서 1개 이상)
const { chromium } = require("playwright");
const out = process.argv[2] || ".";
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const ok = async () => { await page.waitForSelector("#askOk"); await page.click("#askOk"); };
  await page.goto("http://127.0.0.1:8765/");
  await page.waitForSelector("#docSelect option[value]:not([value=''])", { state: "attached" });
  const id = await page.$eval("#docSelect option[value]:not([value=''])", (o) => o.value);
  await page.selectOption("#docSelect", id);
  await page.waitForSelector(".card");
  // 승인 전에는 잠김: 승인을 해제하고 다시 엽니다.
  await page.evaluate((id) => fetch(`/api/docs/${id}/approve`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: false }) }), id);
  await page.reload();
  await page.waitForSelector(".card");
  await page.click("#tabs button[data-tab=coverage]");
  await page.waitForSelector("#covLocked:not([hidden])");
  console.log("승인 전:", (await page.textContent("#covLocked")).slice(0, 40));
  await page.fill("#reviewer", "검토자B");
  await page.click("#approveBtn"); await ok(); await page.waitForTimeout(800);
  // 이전 점검의 이동·이름 수정을 지우고 시작합니다.
  await page.evaluate((id) => fetch(`/api/docs/${id}/coverage/rebuild`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keep_user: false }) }), id);
  await page.click("#tabs button[data-tab=coverage]");
  await page.waitForSelector("#covTree .leaf", { state: "attached" });
  await page.click("#covOpenAll");
  console.log("담보 수:", await page.textContent("#covCount"));
  console.log("대분류:", await page.$$eval(".tree > .lv1 > details > summary", (s) => s.map((x) => x.textContent.trim()).join(" | ")));
  // 소분류(특약) 하나 선택 → 상위 부분 선택 표시
  const minorBox = page.locator('.lv3 summary input[type=checkbox]').first();
  await minorBox.check(); await page.waitForTimeout(600);
  const partial = await page.$$eval(".lv1 > details > summary input", (c) => c.filter((x) => x.indeterminate).length);
  console.log("부분 선택 대분류 수:", partial, "/", await page.textContent("#covCount"));
  // 자세히·이름 수정·이동
  const leaf = page.locator(".leaf").first();
  await leaf.locator("[data-cov=more]").click(); await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/ui-coverage.png` });
  await page.locator(".leaf").first().locator("[data-cov=rename]").click();
  await page.fill("#askInput", "점검용 담보명"); await ok(); await page.waitForTimeout(800);
  console.log("이름 수정:", await page.locator(".leaf", { hasText: "점검용 담보명" }).count());
  await page.locator(".leaf", { hasText: "점검용 담보명" }).locator("[data-cov=move]").click();
  await page.selectOption("#mvMajor", "기타"); await page.fill("#mvMid", "점검중분류");
  await page.click("#mvOk"); await page.waitForTimeout(800);
  await page.fill("#covSearch", "점검용"); await page.waitForTimeout(300);
  console.log("이동 결과:", await page.$$eval(".tree summary", (s) => s.map((x) => x.textContent.trim()).join(" > ")));
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#covXlsx")]);
  await dl.saveAs(`${out}/coverage.xlsx`); console.log("엑셀:", dl.suggestedFilename());
  console.log("이력 행:", await page.$$eval("#covHistory tr", (r) => r.length - 1));
  console.log("오류:", errors.length ? errors : "없음");
  await browser.close();
})();
