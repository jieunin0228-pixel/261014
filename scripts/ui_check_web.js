// 아티팩트판 점검: node scripts/ui_check_web.js <약관 PDF> <저장 폴더> <pdfjs-dist·xlsx가 설치된 node_modules>
// CDN 파일은 로컬 사본으로 대신하고, claude.ai 기능(sample·downloads)은 가짜로 넣습니다.
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const [pdfPath, out, nm] = process.argv.slice(2);
const WEB = path.join(__dirname, "..", "build", "web");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "cdnjs.cloudflare.com") {
      const map = { "pdf.min.js": "pdfjs-dist/build/pdf.min.js", "pdf.worker.min.js": "pdfjs-dist/build/pdf.worker.min.js", "xlsx.full.min.js": "xlsx/dist/xlsx.full.min.js" };
      return route.fulfill({ body: fs.readFileSync(path.join(nm, map[path.basename(u.pathname)])), contentType: "text/javascript" });
    }
    if (u.hostname === "app.local") {
      const f = u.pathname === "/" ? null : path.join(WEB, u.pathname);
      if (!f) return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + fs.readFileSync(path.join(WEB, "index.html"), "utf8") + "</body></html>" });
      return route.fulfill({ body: fs.readFileSync(f), contentType: "text/javascript" });
    }
    return route.abort();
  });
  await page.addInitScript(() => {
    window.__saved = [];
    const fake = async (prompt) => {
      const sec = (prompt.match(/\[(S\d+)\|제2-2조\]/) || [])[1] || "S000";
      const a = {};
      for (const k of ["pay_reason", "amount", "limits", "coverage_start", "exemption_period", "reduction", "term_renewal", "exclusions", "definitions", "after_payment"])
        a[k] = { status: "약관에 명시 없음", value: "", interpretations: [], evidence: [] };
      a.pay_reason = { status: "명시", value: "진단확정 시 지급합니다.", interpretations: [], evidence: [{ node_id: `${sec}|제2-2조`, quote: "초1회에 한하며 최초계약의 계약일로부터 1년미만 진단시 진단자금의 50%를 지급합니다." }] };
      a.amount = { status: "명시", value: "별표2-1에 따릅니다.", interpretations: [], evidence: [{ node_id: `${sec}|별표2-1`, quote: "특약 보험가입금액의 100%" }] };
      a.coverage_start = { status: "명시", value: "꾸며낸 내용", interpretations: [], evidence: [{ node_id: `${sec}|제2-7조`, quote: "이 문장은 약관에 없습니다" }] };
      return { A: a, B: [], tables_referenced: [`${sec}|별표2-1`] };
    };
    window.claude = { use: async (name) => name === "sample" ? Object.assign(async () => ({ text: "" }), { json: fake }) : name === "downloads" ? { save: async (r) => { window.__saved.push(r.filename); return {}; } } : null };
  });
  await page.goto("http://app.local/");
  const t0 = Date.now();
  await page.setInputFiles("#fileInput", pdfPath);
  await page.waitForSelector(".card", { timeout: 600000 });
  console.log("변환 시간(초):", (Date.now() - t0) / 1000);
  await page.fill("#pageInput", "51"); await page.press("#pageInput", "Enter");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/web-verify.png` });
  console.log("51쪽 조각:", (await page.$$eval(".card", (c) => c.map((x) => x.dataset.cid))).slice(0, 6).join(", "));
  const ok = async () => { await page.waitForSelector("#askOk"); await page.click("#askOk"); };
  await page.click("#tabs button[data-tab=report]"); await page.waitForSelector(".group");
  console.log("보고서:", await page.$$eval(".group summary", (s) => s.map((x) => x.textContent.trim()).join(" | ")));
  await page.fill("#reviewer", "검토자W");
  await page.click("#approveBtn"); await ok(); await page.waitForTimeout(500);
  await page.click("#tabs button[data-tab=coverage]"); await page.waitForSelector("#covTree .leaf", { state: "attached" });
  console.log("담보:", await page.textContent("#covCount"));
  await page.fill("#covSearch", "3대주요암"); await page.waitForTimeout(300);
  await page.locator(".leaf input[type=checkbox]").first().check(); await page.waitForTimeout(500);
  await page.click("#covXlsx"); await page.waitForTimeout(800);
  await page.click("#tabs button[data-tab=summary]"); await page.waitForSelector("#sumList .it");
  await page.click("#sumRun"); await ok();
  await page.waitForSelector("#sumList .st.done", { timeout: 60000 });
  await page.click("#sumList .it"); await page.waitForSelector("#sumCard table");
  await page.screenshot({ path: `${out}/web-summary.png`, fullPage: false });
  console.log("요약 목록:", await page.textContent("#sumList"));
  console.log("격리 상자:", await page.locator(".mismatch-box").count());
  await page.click("#sumXlsx"); await page.waitForTimeout(800);
  await page.locator("#sumCard .ev").first().click(); await page.waitForSelector(".overlay .quote-hl", { timeout: 20000 });
  console.log("근거 이동 쪽:", await page.inputValue("#pageInput"), "강조:", await page.locator("mark.q").count());
  await page.click("#tabs button[data-tab=files]"); await page.click("[data-dl='terms.json']"); await page.waitForTimeout(1500);
  console.log("내려받기 요청:", await page.evaluate(() => window.__saved));
  // 다시 열기: 저장된 결과를 IndexedDB에서 읽는지
  await page.reload(); await page.waitForSelector(".card", { timeout: 60000 });
  console.log("다시 연 뒤 승인 표시:", await page.textContent("#approvalBadge"));
  console.log("오류:", errors.length ? errors.slice(0, 5) : "없음");
  await browser.close();
})();
