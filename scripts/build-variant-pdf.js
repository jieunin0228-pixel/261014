// 실제 약관에 흔한 변형 형식을 담은 시험용 PDF(test/fixtures/variant-policy.pdf)를 만듭니다.
//  - 2단 편집(한 쪽을 왼쪽·오른쪽 두 단으로 나눔)
//  - 조문 제목 "제1조【목적】", 괄호 없는 "제1조 목적"
//  - 번호가 붙은 특약 제목 "1. 무배당 암진단특약 약관", 구분 머리줄 "【특별약관】"
//  - 보험금명이 조문에 없고 "별표1 보험금 지급기준표"에만 있는 특약
// 실행: NODE_PATH=$(npm root -g) node scripts/build-variant-pdf.js   (Playwright 필요)
const path = require('path');
const { chromium } = require('playwright');

const filler = (n, seed) => Array.from({ length: n }, (_, i) => `<p>${['① 계약자는 회사가 정한 방법에 따라 이 계약의 내용을 변경할 수 있습니다.', '② 회사는 계약자가 요청하는 경우 관련 서류를 서면 또는 전자문서로 제공합니다.', '③ 이 조항에서 정하지 않은 사항은 관련 법령 및 회사의 내부 기준에 따릅니다.'][(i + seed) % 3]}</p>`).join('');
const general = (from, count, style) => Array.from({ length: count }, (_, i) => {
  const no = from + i;
  const t = ['계약의 성립', '청약의 철회', '계약의 무효', '계약내용의 변경', '보험나이', '계약의 소멸', '보험료의 납입', '해지환급금'][i % 8];
  return `<h4>${style(no, t)}</h4>${filler(3, i)}`;
}).join('');

const html = `
<h2>무배당 변형건강보험 보통약관</h2>
<h4>제1조【목적】</h4><p>이 보험계약은 보험계약자와 보험회사 사이에 피보험자의 사망에 대한 위험을 보장하기 위하여 체결됩니다.</p>
<h4>제2조【보험금의 지급사유】</h4>
<p>회사는 피보험자에게 다음 사항 중 어느 한 가지의 경우에 해당되는 사유가 발생한 때에는 보험수익자에게 약정한 보험금을 지급합니다.</p>
<p>1. 피보험자가 보험기간 중 사망한 경우 : 사망보험금</p>
<h4>제3조【보험금의 지급금액】</h4><p>사망보험금은 가입금액을 지급합니다.</p>
${general(4, 14, (n, t) => `제${n}조【${t}】`)}
<h3>【특별약관】</h3>
<h3>1. 무배당 암진단특약 약관</h3>
<h4>제1조 목적</h4><p>이 특약은 피보험자의 암 진단에 대한 위험을 보장하기 위하여 체결됩니다.</p>
<h4>제2조 보험금의 지급사유</h4>
<p>회사는 이 특약의 보험기간 중 피보험자가 별표1 「보험금 지급기준표」에서 정한 보험금 지급사유에 해당하는 경우 보험수익자에게 약정한 보험금을 지급합니다.</p>
${general(3, 12, (n, t) => `제${n}조 ${t}`)}
<h3>【별표1】 보험금 지급기준표</h3>
<table><tr><th>급부명</th><th>지급사유</th><th>지급금액</th></tr>
<tr><td>암진단보험금</td><td>암보장개시일 이후 암으로 진단확정 시</td><td>가입금액</td></tr>
<tr><td>유사암진단보험금</td><td>갑상선암 등으로 진단확정 시</td><td>가입금액의 20%</td></tr></table>
<h3>2. 무배당 질병입원특약 약관</h3>
<h4>제1조(목적)</h4><p>이 특약은 피보험자의 질병 입원에 대한 위험을 보장하기 위하여 체결됩니다.</p>
<h4>제2조(보험금의 지급사유)</h4>
<p>회사는 피보험자가 질병으로 4일 이상 계속하여 입원한 경우 3일을 초과하는 입원일수 1일당 다음의 보험금을 지급합니다.</p>
<p>1. 질병으로 입원한 경우 : 질병입원급여금</p>
${general(3, 12, (n, t) => `제${n}조(${t})`)}
`;

// 쪽마다 2단 상자를 만들고, 글자 수로 줄 수를 어림해 쪽을 나눕니다(브라우저 인쇄가 다단 본문을 여러 쪽으로 나누지 못하기 때문).
function paginate(markup) {
  const blocks = markup.match(/<(h2|h3|h4|p|table)[\s\S]*?<\/\1>/g);
  const lines = (b) => Math.ceil(b.replace(/<[^>]+>/g, '').length / 22) + (/^<h[23]/.test(b) ? 2 : 0) + (/^<table/.test(b) ? 6 : 0);
  const pages = [];
  let cur = [], used = 0;
  for (const b of blocks) {
    if (used + lines(b) > 84 && cur.length) { pages.push(cur); cur = []; used = 0; }
    cur.push(b); used += lines(b);
  }
  if (cur.length) pages.push(cur);
  return pages.map((p) => `<section class="page">${p.join('')}</section>`).join('');
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`<html><head><style>
    @page { size: A4; margin: 16mm 14mm; }
    body { font: 9.5pt/1.55 'WenQuanYi Zen Hei', 'Noto Sans CJK KR', sans-serif; word-break: keep-all; margin: 0; }
    .page { height: 262mm; columns: 2; column-gap: 9mm; column-fill: auto; overflow: hidden; page-break-after: always; }
    h2 { font-size: 13pt; margin: 0 0 6pt; } h3 { font-size: 11pt; margin: 10pt 0 4pt; break-after: avoid; } h4 { font-size: 9.5pt; margin: 6pt 0 2pt; break-after: avoid; }
    p { margin: 0 0 2pt; } table { border-collapse: collapse; width: 100%; font-size: 8.5pt; } td, th { border: 0.5pt solid #999; padding: 2pt 3pt; text-align: left; }
  </style></head><body>${paginate(html)}</body></html>`);
  const out = path.join(__dirname, '..', 'test', 'fixtures', 'variant-policy.pdf');
  await page.pdf({ path: out, preferCSSPageSize: true });
  await browser.close();
  console.log('test/fixtures/variant-policy.pdf 생성');
})();
