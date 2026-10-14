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

  // 두 번째 시험용 PDF(toc-listed-policy.pdf): 1~6쪽 안내문, 7~8쪽 목차(쪽번호 없이 특약 이름과 그 아래 담보 이름만 나열),
  // 본문에는 담보 이름 일부만 있음 → 사용자가 목차 쪽(7~8)을 지정하면 목차의 담보 이름이 후보로 올라와야 함
  const guide = (n) => Array.from({ length: 24 }, (_, i) => `상품 안내 ${n}-${i + 1}: 이 안내는 계약자가 반드시 알아야 할 사항을 설명합니다.`);
  const toc2a = ['목 차', '무배당 목록건강보험 보통약관', '무배당 암보장특약', '암진단비(유사암 제외)', '유사암진단비'];
  const toc2b = ['무배당 뇌질환보장특약', '뇌출혈진단비', '뇌졸중진단비', '무배당 상해수술특약', '골절수술비'];
  const rider2 = (title, line) => [title, '', '제1조(목적)', '이 특약은 피보험자에 대한 위험을 보장하기 위하여 체결됩니다.', '제2조(보험금의 지급사유)', line, '제3조(준용규정)', ...filler(4)];
  const body2 = [
    ['무배당 목록건강보험 보통약관', '', '제1조(목적)', '이 보험계약은 피보험자의 사망에 대한 위험을 보장합니다.', '제2조(보험금의 지급사유)', '1. 피보험자가 보험기간 중 사망한 경우 : 사망보험금', ...filler(4)],
    rider2('무배당 암보장특약', '회사는 보험금 지급기준표에서 정한 사유가 발생한 경우 약정한 보험금을 지급합니다.'),
    rider2('무배당 뇌질환보장특약', '1. 피보험자가 뇌출혈로 진단확정된 경우 : 뇌출혈진단비'),
    rider2('무배당 상해수술특약', '1. 피보험자가 골절로 수술을 받은 경우 : 골절수술비'),
  ];
  const html2 = [...Array.from({ length: 6 }, (_, i) => pageHtml(guide(i + 1), null)), pageHtml(toc2a, null), pageHtml(toc2b, null), ...body2.map((lines, i) => pageHtml(lines, i + 1))].join('');
  await page.setContent(`<html><head><style>
    @page { size: A4; margin: 0; }
    body { margin: 0; font: 10pt/15pt 'WenQuanYi Zen Hei', 'Noto Sans CJK KR', sans-serif; }
    .page { width: 210mm; height: 297mm; padding: 12mm 18mm; box-sizing: border-box; page-break-after: always; display: flex; flex-direction: column; overflow: hidden; }
    .hd { font-size: 8pt; border-bottom: 0.5pt solid #999; margin-bottom: 4mm; } .bd { flex: 1; } .ft { text-align: center; font-size: 9pt; }
  </style></head><body>${html2}</body></html>`);
  await page.pdf({ path: path.join(__dirname, '..', 'test', 'fixtures', 'toc-listed-policy.pdf'), preferCSSPageSize: true });

  // 세 번째(spaced-names-policy.pdf): 띄어 쓴 담보명, 표 안의 담보명, 줄 끝에서 낱말 중간이 끊긴 담보명
  const body3 = [[
    '무배당 뇌질환보장특약', '', '제1조(목적)', '이 특약은 피보험자의 뇌질환 위험을 보장하기 위하여 체결됩니다.',
    '제2조(보험금의 지급사유)', '회사는 피보험자에게 다음 중 어느 하나의 사유가 발생한 경우 보험금을 지급합니다.',
    '1. 피보험자가 뇌졸중으로 진단확정된 경우 : 뇌졸중 진단비',
    '2. 피보험자가 보험기간 중 뇌혈관질환으로 진단확정된 경우(최초 1회한) : 뇌혈관질환진',
    '단비',
    '3. 피보험자가 대상포진으로 진단확정된 경우 : 대상포진 진단비',
    '제3조(보험금의 지급금액)', '지급구분 | 지급사유 | 지급금액', '뇌동맥류 진단비 | 뇌동맥류로 진단확정 시 | 가입금액', '제4조(준용규정)', ...filler(4),
  ]];
  await page.setContent(`<html><head><style>
    @page { size: A4; margin: 0; }
    body { margin: 0; font: 10pt/15pt 'WenQuanYi Zen Hei', 'Noto Sans CJK KR', sans-serif; }
    .page { width: 210mm; height: 297mm; padding: 12mm 18mm; box-sizing: border-box; page-break-after: always; display: flex; flex-direction: column; overflow: hidden; }
    .hd { font-size: 8pt; border-bottom: 0.5pt solid #999; margin-bottom: 4mm; } .bd { flex: 1; } .ft { text-align: center; font-size: 9pt; }
  </style></head><body>${body3.map((lines, i) => pageHtml(lines, i + 1)).join('')}</body></html>`);
  await page.pdf({ path: path.join(__dirname, '..', 'test', 'fixtures', 'spaced-names-policy.pdf'), preferCSSPageSize: true });
  await browser.close();
  console.log('test/fixtures/toc-variant-policy.pdf, toc-listed-policy.pdf, spaced-names-policy.pdf 생성');
})();
