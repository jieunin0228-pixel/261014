// 목차는 있으나 본문의 특약 제목을 규칙만으로 알아보기 어려운 경우를 담은 시험용 PDF(test/fixtures/toc-variant-policy.pdf).
//  - 암진단특약: 제목 뒤에 긴 안내문이 있어 제목 바로 다음에 제1조가 오지 않음
//  - 뇌출혈진단특약: 제목에 장식 기호(◆)
//  - 골절치료특약: 본문에 제목 줄이 없음(목차 쪽번호로만 알 수 있음)
//  - 수술특약: 본문 제목이 목차와 다름("수술 보장 안내")
//  - 화상진단특약: 목차에만 있고 본문에 없음
// 실행: NODE_PATH=$(npm root -g) node scripts/build-toc-variant-pdf.js   (Playwright 필요)
const path = require('path');
const { chromium } = require('playwright');

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const filler = (n) => Array.from({ length: n }, (_, i) => ['① 계약자는 회사가 정한 방법에 따라 이 계약의 내용을 변경할 수 있습니다.', '② 회사는 계약자가 요청하는 경우 관련 서류를 제공합니다.'][i % 2]);
const rider = (title, benefit, cause) => [
  ...(title ? [title, ''] : []),
  '제1조(목적)', '이 특약은 피보험자에 대한 위험을 보장하기 위하여 체결됩니다.',
  '제2조(보험금의 지급사유)', '회사는 다음의 사유가 발생한 경우 보험금을 지급합니다.', `1. 피보험자가 ${cause} : ${benefit}`,
  '제3조(보험금의 지급금액)', `${benefit}은 가입금액을 지급합니다.`,
  '제4조(준용규정)', ...filler(6),
];
const body = [
  ['무배당 목차건강보험 보통약관', '', '제1조(목적)', '이 보험계약은 피보험자의 사망에 대한 위험을 보장합니다.', '제2조(보험금의 지급사유)', '1. 피보험자가 보험기간 중 사망한 경우 : 사망보험금', '제3조(보험금의 지급금액)', '사망보험금은 가입금액을 지급합니다.', ...filler(6)],
  ['무배당 암진단특약', '', ...Array.from({ length: 16 }, (_, i) => `이 특약의 가입 안내 ${i + 1}: 계약자는 이 안내를 반드시 읽어야 합니다.`), ...rider(null, '암진단보험금', '암으로 진단확정된 경우')],
  rider('◆ 무배당 뇌출혈진단특약 ◆', '뇌출혈진단보험금', '뇌출혈로 진단확정된 경우'),
  rider(null, '골절치료보험금', '골절로 치료를 받은 경우'),
  rider('수술 보장 안내', '수술보험금', '수술을 받은 경우'),
];
const toc = [['무배당 목차건강보험 보통약관', 1], ['무배당 암진단특약', 2], ['무배당 뇌출혈진단특약', 3], ['무배당 골절치료특약', 4], ['무배당 수술특약', 5], ['무배당 화상진단특약', 9]];

(async () => {
  const pageHtml = (lines, printed) => `<section class="page"><div class="hd">${printed ? '무배당 목차건강보험 약관' : '&nbsp;'}</div><div class="bd">${lines.map((l) => `<div>${esc(l) || '&nbsp;'}</div>`).join('')}</div><div class="ft">${printed ? `- ${printed} -` : '&nbsp;'}</div></section>`;
  const tocLines = ['목 차', ...toc.map(([t, p]) => `${t} ··········· ${p}`), ...Array.from({ length: 4 }, (_, i) => `제${i + 1}조(목적 등) ··········· 1`)];
  const html = [pageHtml(tocLines, null), ...body.map((lines, i) => pageHtml(lines, i + 1))].join('');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`<html><head><style>
    @page { size: A4; margin: 0; }
    body { margin: 0; font: 10pt/15pt 'WenQuanYi Zen Hei', 'Noto Sans CJK KR', sans-serif; }
    .page { width: 210mm; height: 297mm; padding: 12mm 18mm; box-sizing: border-box; page-break-after: always; display: flex; flex-direction: column; overflow: hidden; }
    .hd { font-size: 8pt; border-bottom: 0.5pt solid #999; margin-bottom: 4mm; } .bd { flex: 1; } .ft { text-align: center; font-size: 9pt; }
  </style></head><body>${html}</body></html>`);
  await page.pdf({ path: path.join(__dirname, '..', 'test', 'fixtures', 'toc-variant-policy.pdf'), preferCSSPageSize: true });
  await browser.close();
  console.log('test/fixtures/toc-variant-policy.pdf 생성');
})();
