// 시험용 더미 약관 PDF(samples/sample_policy.pdf)와 정답(samples/sample_expected.json)을 만듭니다.
// 실제 약관과 같은 형태를 흉내 냅니다: 표지·목차(쪽번호 없음) → 본문(머리글·"- n -" 쪽번호), 표 형식 지급사유, 별표, 스캔(이미지) 쪽.
// 실행: NODE_PATH=$(npm root -g) node scripts/build-sample-pdf.js   (Playwright 필요)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PRODUCT = '무배당 더미건강종신보험';
const LINES_PER_PAGE = 40;
const WRAP = 46;

// ───────────── 약관 내용 ─────────────
// [특약명, 담보 목록 [담보명, 지급사유 문장, 지급금액], 표 형식 여부, 기대 대분류 목록]
const RIDERS = [
  ['재해사망특약', [['재해사망보험금', '재해로 인하여 사망하였을 경우', '가입금액']], false, ['사망']],
  ['재해장해특약', [['재해장해급여금', '재해로 인하여 장해분류표(별표1)에서 정한 장해지급률 3% 이상 80% 미만에 해당하는 장해상태가 되었을 경우', '가입금액 × 해당 장해지급률'], ['재해고도장해보험금', '재해로 인하여 장해분류표(별표1)에서 정한 장해지급률 80% 이상에 해당하는 장해상태가 되었을 경우', '가입금액']], true, ['장해', '장해']],
  ['무배당 암진단특약(갱신형)', [['암진단보험금', '암보장개시일 이후에 「암」으로 진단확정되었을 경우(최초 1회에 한함)', '가입금액'], ['소액암진단보험금', '보험기간 중 「기타피부암」 또는 「갑상선암」으로 진단확정되었을 경우(각각 최초 1회에 한함)', '가입금액의 20%']], false, ['진단', '진단']],
  ['뇌출혈진단특약', [['뇌출혈진단보험금', '보험기간 중 「뇌출혈」로 진단확정되었을 경우(최초 1회에 한함)', '가입금액']], true, ['진단']],
  ['급성심근경색증진단특약', [['급성심근경색증진단보험금', '보험기간 중 「급성심근경색증」으로 진단확정되었을 경우(최초 1회에 한함)', '가입금액']], false, ['진단']],
  ['질병수술특약', [['질병수술보험금', '질병의 치료를 직접적인 목적으로 수술분류표(별표2)에서 정한 수술을 받은 경우(수술 1회당)', '수술분류표에서 정한 수술종류별 지급액']], true, ['치료']],
  ['암수술특약', [['암수술보험금', '암보장개시일 이후에 「암」으로 진단확정되고 그 치료를 직접적인 목적으로 수술을 받은 경우(수술 1회당)', '가입금액']], false, ['치료']],
  ['질병입원특약', [['질병입원급여금', '질병으로 그 치료를 직접적인 목적으로 4일 이상 계속하여 입원한 경우(3일 초과 입원일수 1일당, 120일 한도)', '가입금액의 1%']], false, ['입원']],
  ['재해입원특약', [['재해입원급여금', '재해로 그 치료를 직접적인 목적으로 4일 이상 계속하여 입원한 경우(3일 초과 입원일수 1일당, 120일 한도)', '가입금액의 1%']], true, ['입원']],
  ['암직접치료입원특약', [['암직접치료입원급여금', '「암」의 직접적인 치료를 목적으로 입원한 경우(1일 이상 입원일수 1일당, 120일 한도)', '가입금액의 2%']], false, ['입원']],
  ['항암방사선약물치료특약', [['항암방사선약물치료보험금', '「암」으로 진단확정되고 그 직접적인 치료를 목적으로 항암방사선치료 또는 항암약물치료를 받은 경우(최초 1회에 한함)', '가입금액']], false, ['치료']],
  ['장기요양간병특약', [['장기요양간병자금', '노인장기요양보험법에서 정한 장기요양등급 1등급 판정을 받은 경우', '가입금액']], true, ['치료']],
  ['생활자금지급특약', [['생활자금', '보험기간 중 매년 계약해당일에 살아 있을 경우', '가입금액의 10%']], false, ['기타']],
  ['응급실내원특약', [['응급실내원보험금', '질병 또는 재해로 응급의료기관의 응급실에 내원하여 진료를 받은 경우(내원 1회당)', '가입금액']], false, ['기타']],
  ['골절진단특약', [['골절진단보험금', '재해로 인하여 「골절」로 진단확정되었을 경우(사고 1회당)', '가입금액']], true, ['진단']],
  ['화상진단특약', [['화상진단보험금', '재해로 인하여 심재성 2도 이상의 「화상」으로 진단확정되었을 경우(사고 1회당)', '가입금액']], false, ['진단']],
  ['중증치매진단특약', [['중증치매진단보험금', '보험기간 중 「중증치매상태」로 진단확정되었을 경우(최초 1회에 한함)', '가입금액']], false, ['진단']],
  ['표적항암약물허가치료특약', [['표적항암약물허가치료보험금', '「암」으로 진단확정되고 그 치료를 목적으로 표적항암약물허가치료를 받은 경우(최초 1회에 한함)', '가입금액']], true, ['치료']],
  ['중대한수술특약', [['중대한수술보험금', '보험기간 중 「중대한 수술」을 받은 경우(수술 1회당)', '가입금액']], false, ['치료']],
  ['질병통원특약', [['질병통원급여금', '질병으로 그 치료를 직접적인 목적으로 통원한 경우(통원 1회당, 연간 30회 한도)', '가입금액의 1%']], false, ['치료']],
  ['깁스치료특약', [['깁스치료보험금', '재해로 인하여 그 치료를 직접적인 목적으로 깁스(Cast)치료를 받은 경우(사고 1회당)', '가입금액']], true, ['치료']],
  ['상해입원일당특약', [['상해입원일당', '상해로 그 치료를 직접적인 목적으로 입원한 경우(입원 1일당, 180일 한도)', '가입금액']], false, ['입원']],
  ['만기축하특약', [['만기축하금', '보험기간이 끝날 때까지 살아 있을 경우', '가입금액']], false, ['기타']],
  ['질병사망특약', [['질병사망보험금', '질병으로 인하여 사망하였을 경우', '가입금액']], true, ['사망']],
  ['유족연금특약', [['유족연금', '보험기간 중 사망하였을 경우(매년 사망해당일에 10회 지급)', '가입금액의 10%']], false, ['사망']],
  ['뇌혈관질환진단특약', [['뇌혈관질환진단보험금', '보험기간 중 「뇌혈관질환」으로 진단확정되었을 경우(최초 1회에 한함)', '가입금액']], false, ['진단']],
  ['허혈성심장질환진단특약', [['허혈성심장질환진단보험금', '보험기간 중 「허혈성심장질환」으로 진단확정되었을 경우(최초 1회에 한함)', '가입금액']], true, ['진단']],
];
// 보험금명이 없는 특약(약관 제목이 담보로 올라와야 함)
const WAIVER = '보험료납입면제특약';

const FILLER = [
  ['보험금 지급에 관한 세부규정', ['① 보험금의 지급사유가 같은 사고로 둘 이상 발생한 경우에는 각각의 보험금을 더하여 지급하지 않고 회사가 정한 기준에 따라 지급합니다.', '② 이 특약의 보험금 지급사유가 발생한 경우 회사는 관련 법령과 의학적 판단에 따라 보험금 지급 여부를 결정합니다.']],
  ['보험금을 지급하지 않는 사유', ['① 회사는 다음 중 어느 한 가지로 보험금 지급사유가 발생한 때에는 보험금을 지급하지 않습니다.', '1. 피보험자가 고의로 자신을 해친 경우', '2. 보험수익자가 고의로 피보험자를 해친 경우', '3. 계약자가 고의로 피보험자를 해친 경우', '② 회사는 다른 약정이 없으면 피보험자가 직업, 직무 또는 동호회 활동 목적으로 아래에 열거된 행위로 인하여 제1항의 보험금 지급사유가 발생한 때에는 해당 보험금을 지급하지 않습니다.']],
  ['보험금 지급사유의 통지', ['계약자 또는 피보험자나 보험수익자는 보험금 지급사유의 발생을 안 때에는 지체 없이 그 사실을 회사에 알려야 합니다.']],
  ['보험금의 청구', ['① 보험수익자는 다음의 서류를 제출하고 보험금을 청구하여야 합니다.', '1. 청구서(회사 양식)', '2. 사고증명서', '3. 신분증(본인 신분을 확인할 수 있는 신분증)', '4. 기타 보험수익자가 보험금 수령에 필요하여 제출하는 서류']],
  ['보험금의 지급절차', ['① 회사는 보험금 청구서류를 접수한 때에는 접수증을 드리고 휴대전화 문자메시지 또는 전자우편 등으로도 송부하며, 그 서류를 접수한 날부터 3영업일 이내에 보험금을 지급합니다.', '② 회사는 보험금 지급사유를 조사·확인하기 위하여 필요한 기간이 제1항의 지급기일을 초과할 것이 명백히 예상되는 경우에는 그 구체적인 사유와 지급예정일을 보험수익자에게 통지합니다.']],
  ['특약의 체결 및 소멸', ['① 이 특약은 주계약을 체결할 때 계약자의 청약과 회사의 승낙으로 주계약에 부가하여 이루어집니다.', '② 주계약이 해지 또는 기타 사유에 의하여 효력을 가지지 않게 되는 경우에는 이 특약도 더 이상 효력을 가지지 않습니다.']],
  ['보험기간 및 보험료 납입기간', ['이 특약의 보험기간 및 보험료 납입기간은 주계약의 보험기간 및 보험료 납입기간 범위 내에서 회사가 정한 기간으로 합니다.']],
  ['특약의 해지', ['① 계약자는 이 특약이 소멸하기 전에 언제든지 이 특약을 해지할 수 있으며, 이 경우 회사는 해지환급금을 계약자에게 지급합니다.', '② 이 특약의 해지환급금은 보험료 및 책임준비금 산출방법서에 따라 계산합니다.']],
  ['계약 전 알릴 의무', ['계약자 또는 피보험자는 청약할 때 청약서에서 질문한 사항에 대하여 알고 있는 사실을 반드시 사실대로 알려야 합니다. 다만, 진단계약의 경우 의료법에 따른 종합병원과 병원에서 직장 또는 개인이 실시한 건강검진서 사본 등 건강상태를 판단할 수 있는 자료로 건강진단을 대신할 수 있습니다.']],
  ['준용규정', ['이 특약에서 정하지 않은 사항에 대하여는 주계약 약관을 따릅니다.']],
];

// 실제 약관의 분량(특약당 수 쪽)을 흉내 내기 위한 일반 조항
const GENERAL_TITLES = ['청약의 철회', '약관교부 및 설명의무 등', '계약의 무효', '계약내용의 변경 등', '보험나이 등', '계약의 소멸', '보험료의 납입', '제1회 보험료 및 회사의 보장개시', '보험료의 자동대출납입', '보험료의 납입연체 시 납입최고와 계약의 해지', '보험료의 납입을 연체하여 해지된 계약의 부활', '강제집행 등으로 인하여 해지된 계약의 특별부활', '계약자의 임의해지', '중대사유로 인한 해지', '회사의 파산선고와 해지', '해지환급금', '배당금의 지급', '보험계약대출', '분쟁의 조정', '관할법원', '소멸시효', '약관의 해석', '설명서 교부 및 보험안내자료 등의 효력', '회사의 손해배상책임', '개인정보보호', '준거법', '예금보험에 의한 지급보장', '계약자의 주소변경통지', '보험수익자의 지정', '대표자의 지정', '타인을 위한 계약', '외국인 보험계약의 특칙', '전자적 방법에 의한 통지', '계약자의 의무', '회사의 의무', '계약의 갱신 거절', '보험료의 할인', '보험료 산출기초의 변경', '보험금 수령방법의 변경', '보험금의 분할 수령', '휴면보험금의 안내', '계약 이전', '단체계약의 특칙', '공시이율의 적용', '납입면제 후의 처리'];
const SENTENCES = ['계약자는 회사가 정한 방법에 따라 이 계약의 내용을 변경할 수 있습니다.', '회사는 계약자가 요청하는 경우 관련 서류를 서면 또는 전자문서로 제공합니다.', '이 경우 회사는 그 사실을 계약자에게 지체 없이 알려 드립니다.', '다만, 회사가 정한 기준에 해당하지 않는 경우에는 그러하지 않습니다.', '회사는 계약자의 요청이 있는 경우 그 처리 결과를 14일 이내에 알려 드립니다.', '이 조항에서 정하지 않은 사항은 관련 법령 및 회사의 내부 기준에 따릅니다.', '계약자는 언제든지 회사에 해당 내용의 확인을 요청할 수 있습니다.', '제1항의 규정에도 불구하고 회사는 금융감독원장이 정하는 기준에 따라 처리합니다.'];
function generalArticles(seed, count) {
  return GENERAL_TITLES.slice(0, count).map((t, i) => {
    const n = 3 + ((seed + i) % 3);
    const paras = [];
    for (let k = 0; k < n; k++) paras.push(`${'①②③④⑤'[k]} ${SENTENCES[(seed * 3 + i + k) % SENTENCES.length]} ${SENTENCES[(seed + i * 2 + k + 3) % SENTENCES.length]}`);
    return [t, paras];
  });
}

const MAIN_ARTICLES = [
  ['제1관 목적 및 용어의 정의', null],
  ['목적', ['이 보험계약은 보험계약자와 보험회사 사이에 피보험자의 사망 및 장해에 대한 위험을 보장하기 위하여 체결됩니다.']],
  ['용어의 정의', ['이 계약에서 사용되는 용어의 뜻은 다음과 같습니다.', '1. 계약자: 회사와 계약을 체결하고 보험료를 납입할 의무를 지는 사람을 말합니다.', '2. 보험수익자: 보험금 지급사유가 발생하는 때에 회사에 보험금을 청구하여 받을 수 있는 사람을 말합니다.', '3. 장해: 장해분류표(별표1)에서 정한 기준에 따른 장해상태를 말합니다.', '4. 재해: 재해분류표에서 정한 재해를 말합니다.']],
  ['제2관 보험금의 지급', null],
  ['보험금의 지급사유', ['회사는 피보험자에게 다음 중 어느 하나의 사유가 발생한 경우에는 보험수익자에게 약정한 보험금을 지급합니다.', '1. 보험기간 중 피보험자가 사망하였을 경우: 사망보험금', '2. 보험기간 중 동일한 재해 또는 재해 이외의 동일한 원인으로 여러 신체부위의 장해지급률을 더하여 80% 이상인 장해상태가 되었을 경우(최초 1회한): 고도장해보험금']],
  ['보험금의 지급금액', ['① 사망보험금은 가입금액을 지급합니다. 다만, 재해 이외의 원인으로 계약일부터 2년 이내에 사망한 경우에는 가입금액의 50%를 지급합니다.', '② 고도장해보험금은 가입금액을 지급하며, 고도장해보험금을 지급한 경우 이 계약은 더 이상 효력이 없습니다.']],
  ...FILLER.slice(0, 5),
  ['제3관 계약자의 계약 전 알릴 의무 등', null],
  ...FILLER.slice(8),
  ['보험료의 납입이 연체되는 경우 납입최고와 계약의 해지', ['① 계약자가 제2회 이후의 보험료를 납입기일까지 납입하지 않아 보험료 납입이 연체 중인 경우에 회사는 14일 이상의 기간을 납입최고기간으로 정하여 계약자에게 서면, 전화 또는 전자문서 등으로 알립니다.', '② 납입최고기간이 끝나는 날까지 보험료를 납입하지 않은 경우 납입최고기간이 끝나는 날의 다음날 계약은 해지됩니다.']],
  ['보험계약대출', ['계약자는 이 계약의 해지환급금 범위 내에서 회사가 정한 방법에 따라 대출을 받을 수 있습니다.']],
  ['분쟁의 조정', ['계약에 관하여 분쟁이 있는 경우 분쟁 당사자 또는 기타 이해관계인과 회사는 금융감독원장에게 조정을 신청할 수 있습니다.']],
  ['제4관 계약의 일반사항', null],
  ...generalArticles(0, 45),
];

// ───────────── 줄 만들기 ─────────────
function wrap(text, width = WRAP) {
  const out = [];
  let cur = '';
  for (const word of text.split(' ')) {
    if (cur && (cur + ' ' + word).length > width) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out.map((t, i) => ({ t, indent: i > 0 }));
}

function articleLines(no, title, paras) {
  const lines = [{ t: `제${no}조(${title})`, bold: true }];
  for (const p of paras) lines.push(...wrap(p));
  lines.push({ t: '' });
  return lines;
}

function benefitArticle(no, benefits, table) {
  const lines = [{ t: `제${no}조(보험금의 지급사유)`, bold: true }, ...wrap('회사는 이 특약의 보험기간 중 피보험자에게 다음 중 어느 하나의 사유가 발생한 경우에는 보험수익자에게 약정한 보험금을 지급합니다.')];
  if (table) {
    lines.push({ row: ['지급구분', '지급사유', '지급금액'], head: true });
    for (const [name, cause, amount] of benefits) {
      const parts = wrap(cause, 24);
      parts.forEach((p, i) => lines.push({ row: [i === 0 ? name : '', p.t, i === 0 ? amount : ''] }));
    }
  } else {
    benefits.forEach(([name, cause], i) => lines.push(...wrap(`${i + 1}. 피보험자가 ${cause}: ${name}`)));
  }
  lines.push({ t: '' });
  const pay = [{ t: `제${no + 1}조(보험금의 지급금액)`, bold: true }];
  for (const [name, , amount] of benefits) pay.push(...wrap(`${name}은(는) ${amount}을(를) 지급합니다.`));
  pay.push({ t: '' });
  return [...lines, ...pay];
}

function riderLines(title, benefits, table, seed) {
  const lines = [{ t: title, title: true }, { t: '' }];
  lines.push(...articleLines(1, '목적', ['이 특약은 보험계약자와 보험회사 사이에 피보험자에 대한 위험을 보장하기 위하여 체결됩니다.']));
  lines.push(...articleLines(2, '용어의 정의', ['이 특약에서 사용되는 용어의 뜻은 주계약 약관에서 정한 바에 따릅니다. 다만, 이 특약에서 따로 정한 용어는 해당 조항에서 정한 바에 따릅니다.']));
  lines.push(...benefitArticle(3, benefits, table));
  [...FILLER, ...generalArticles(seed, 18 + (seed % 10))].forEach(([t, p], i) => lines.push(...articleLines(5 + i, t, p)));
  return lines;
}

function waiverLines() {
  const lines = [{ t: WAIVER, title: true }, { t: '' }];
  lines.push(...articleLines(1, '목적', ['이 특약은 피보험자가 장해상태가 되었을 때 차회 이후의 보험료 납입을 면제하기 위하여 체결됩니다.']));
  lines.push(...articleLines(2, '보험료 납입면제 사유', ['회사는 피보험자가 보험료 납입기간 중 장해지급률 50% 이상의 장해상태가 되었을 경우에는 차회 이후의 보험료 납입을 면제합니다.']));
  FILLER.slice(5).forEach(([t, p], i) => lines.push(...articleLines(3 + i, t, p)));
  return lines;
}

function appendixLines(no, title, rows) {
  const lines = [{ t: `[별표${no}] ${title}`, title: true }, { t: '' }];
  for (const r of rows) lines.push({ row: r });
  lines.push({ t: '' });
  return lines;
}

function mainLines() {
  const lines = [{ t: `${PRODUCT} 보통약관`, title: true }, { t: '' }];
  let no = 1;
  for (const [t, p] of MAIN_ARTICLES) {
    if (!p) { lines.push({ t, bold: true }, { t: '' }); continue; }
    lines.push(...articleLines(no++, t, p));
  }
  return lines;
}

// 구간을 쪽으로 자릅니다. 각 약관·별표는 새 쪽에서 시작합니다.
function paginate(blocks) {
  const pages = [];
  for (const b of blocks) {
    b.firstPage = pages.length;
    for (let i = 0; i < b.lines.length; i += LINES_PER_PAGE) pages.push({ lines: b.lines.slice(i, i + LINES_PER_PAGE) });
  }
  return pages;
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function lineHtml(l) {
  if (l.row) return `<div class="row${l.head ? ' head' : ''}${l.row.length === 2 ? ' two' : ''}">${l.row.map((c) => `<span>${esc(c)}</span>`).join('')}</div>`;
  const cls = [l.title && 'title', l.bold && 'bold', l.indent && 'indent'].filter(Boolean).join(' ');
  return `<div class="l ${cls}">${esc(l.t) || '&nbsp;'}</div>`;
}

(async () => {
  const appendixRows = {
    1: [['장해의 분류', '장해지급률'], ['두 눈이 멀었을 때', '100'], ['한 눈이 멀었을 때', '50'], ['한 눈의 교정시력이 0.02 이하로 된 때', '35'], ['두 귀의 청력을 완전히 잃었을 때', '80'], ['씹어먹는 기능과 말하는 기능 모두에 심한 장해를 남긴 때', '100']],
    2: [['수술종류', '수술명', '지급액'], ['1종', '피부이식술(25㎠ 미만)', '가입금액의 10%'], ['2종', '갑상선 수술', '가입금액의 20%'], ['3종', '심장 수술', '가입금액의 50%'], ['4종', '두개 내 수술', '가입금액의 100%']],
    3: [['대상 질병명', '분류번호'], ['입술, 구강 및 인두의 악성신생물', 'C00-C14'], ['소화기관의 악성신생물', 'C15-C26'], ['호흡기 및 흉곽내기관의 악성신생물', 'C30-C39']],
  };
  // 장해분류표는 여러 쪽에 걸치도록 행을 늘립니다.
  for (let i = 1; i <= 300; i++) appendixRows[1].push([`(세부 장해 ${i}) 신체부위 ${((i - 1) % 9) + 1}의 기능에 뚜렷한 장해를 남긴 때`, String((i % 6 + 1) * 5)]);

  const blocks = [{ title: `${PRODUCT} 보통약관`, kind: '보통약관', lines: mainLines() }];
  RIDERS.forEach(([title, benefits, table], i) => blocks.push({ title, kind: '특별약관', lines: riderLines(title, benefits, table, i + 1) }));
  blocks.push({ title: WAIVER, kind: '특별약관', lines: waiverLines() });
  blocks.push({ title: '[별표1] 장해분류표', kind: '별표', lines: appendixLines(1, '장해분류표', appendixRows[1]) });
  blocks.push({ title: '[별표2] 수술분류표', kind: '별표', lines: appendixLines(2, '수술분류표', appendixRows[2]) });
  blocks.push({ title: '[별표3] 악성신생물 분류표', kind: '별표', lines: appendixLines(3, '악성신생물 분류표', appendixRows[3]) });
  const body = paginate(blocks);

  // 목차: 약관·별표 제목과 보통약관의 조문, 인쇄 쪽번호(본문 첫 쪽 = 1쪽)
  const toc = [];
  let mainNo = 1;
  for (const b of blocks) {
    toc.push({ t: b.title, printed: b.firstPage + 1, bold: true });
    if (b.kind === '보통약관') {
      for (const [t, p] of MAIN_ARTICLES) {
        if (!p) continue;
        const idx = b.lines.findIndex((l) => l.t === `제${mainNo}조(${t})`);
        toc.push({ t: `제${mainNo}조(${t})`, printed: b.firstPage + Math.floor(idx / LINES_PER_PAGE) + 1, indent: true });
        mainNo++;
      }
    }
  }
  const tocPages = [];
  for (let i = 0; i < toc.length; i += 34) tocPages.push(toc.slice(i, i + 34));

  // 스캔 쪽: 별표3의 둘째 쪽을 이미지로 넣습니다(본문 쪽수를 하나 늘림).
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
  await page.setContent(`<body style="margin:0;background:#fff;font:15px/1.8 'WenQuanYi Zen Hei';padding:40px">
    <h3>[별표3] 악성신생물 분류표(계속)</h3>${['남성생식기관의 악성신생물 C60-C63', '요로의 악성신생물 C64-C68', '눈, 뇌 및 중추신경계통의 기타 부분의 악성신생물 C69-C72', '갑상선 및 기타 내분비선의 악성신생물 C73-C75'].map((t) => `<p>${t}</p>`).join('')}</body>`);
  const scanPng = (await page.screenshot({ type: 'png' })).toString('base64');
  body.push({ scan: scanPng });

  const pageHtml = (inner, printed) => `<section class="page"><div class="hd">${printed ? esc(`${PRODUCT} 약관`) : '&nbsp;'}</div><div class="bd">${inner}</div><div class="ft">${printed ? `- ${printed} -` : '&nbsp;'}</div></section>`;
  const html = [
    pageHtml(`<div class="cover"><h1>${esc(PRODUCT)}</h1><p>보험약관</p><p class="note">이 약관은 프로그램 시험용 가상 약관이며 실제 상품과 무관합니다.</p></div>`, null),
    ...tocPages.map((entries, i) => pageHtml(`${i === 0 ? '<h2 class="toc-h">목 차</h2>' : ''}${entries.map((e) => `<div class="toc${e.indent ? ' indent' : ''}${e.bold ? ' bold' : ''}"><span>${esc(e.t)}</span><span class="dots">${'·'.repeat(8)}</span><span>${e.printed}</span></div>`).join('')}`, null)),
    ...body.map((p, i) => pageHtml(p.scan ? `<img src="data:image/png;base64,${p.scan}" style="width:100%">` : p.lines.map(lineHtml).join(''), i + 1)),
  ].join('');

  await page.setContent(`<html><head><style>
    @page { size: A4; margin: 0; }
    body { margin: 0; font: 10pt/15.5pt 'WenQuanYi Zen Hei', 'Noto Sans CJK KR', sans-serif; }
    .page { width: 210mm; height: 297mm; padding: 12mm 18mm; box-sizing: border-box; page-break-after: always; display: flex; flex-direction: column; overflow: hidden; }
    .hd { font-size: 8pt; color: #555; border-bottom: 0.5pt solid #999; margin-bottom: 4mm; }
    .bd { flex: 1; }
    .ft { text-align: center; font-size: 9pt; }
    .l.title { font-size: 13pt; font-weight: bold; }
    .l.bold { font-weight: bold; }
    .l.indent { padding-left: 1.2em; }
    .row { display: grid; grid-template-columns: 30% 45% 25%; border-bottom: 0.5pt solid #bbb; }
    .row.head { font-weight: bold; background: #eee; }
    .row.two { grid-template-columns: 80% 20%; }
    .row span { padding: 0 4px; }
    .cover { text-align: center; margin-top: 80mm; } .cover .note { font-size: 9pt; color: #555; margin-top: 30mm; }
    .toc-h { text-align: center; } .toc { display: flex; gap: 6px; } .toc span:first-child { flex: 0 1 auto; } .toc .dots { flex: 1; overflow: hidden; color: #888; } .toc.indent { padding-left: 1.5em; } .toc.bold { font-weight: bold; }
  </style></head><body>${html}</body></html>`);
  const outDir = path.join(__dirname, '..', 'samples');
  fs.mkdirSync(outDir, { recursive: true });
  await page.pdf({ path: path.join(outDir, 'sample_policy.pdf'), preferCSSPageSize: true, printBackground: true });
  await browser.close();

  const totalPages = 1 + tocPages.length + body.length;
  const expected = {
    totalPages, tocPages: tocPages.map((_, i) => i + 2), bodyStartPdfPage: 2 + tocPages.length, scannedPdfPage: totalPages,
    sections: blocks.map((b) => ({ title: b.title, kind: b.kind, pdfPage: b.firstPage + 2 + tocPages.length, printed: b.firstPage + 1 })),
    coverages: [
      { section: `${PRODUCT} 보통약관`, name: '사망보험금', category: '사망' },
      { section: `${PRODUCT} 보통약관`, name: '고도장해보험금', category: '장해' },
      ...RIDERS.flatMap(([title, benefits, , cats]) => benefits.map(([name], i) => ({ section: title, name, category: cats[i] }))),
      { section: WAIVER, name: WAIVER, category: '기타', fromTitle: true },
    ],
  };
  fs.writeFileSync(path.join(outDir, 'sample_expected.json'), JSON.stringify(expected, null, 2));
  console.log(`samples/sample_policy.pdf 생성(${totalPages}쪽), samples/sample_expected.json 생성`);
})();
