// 코드마스터: 코드 종류별 [코드, 명칭, 설명] 목록.
// 실제 코드마스터를 받기 전에는 아래 "임시 코드마스터"를 씁니다.
//   - 출처 '화면캡처': 이전에 받은 ECS 화면 캡처에서 확인한 코드입니다(실제 코드일 가능성이 높지만 확인 필요).
//   - 출처 '임시생성': 담보를 표현하려고 지어낸 코드이며 모두 "TMP-"로 시작합니다. 실제 코드로 바꿔야 합니다.
// 실제 코드마스터 엑셀을 올리면 그 값만 씁니다. 올린 파일에 남은 "TMP-" 코드는 계속 임시로 표시합니다.
const crypto = require('crypto');

const CODE_TYPES = [
  { type: 'claim', sheet: '청구사유' },
  { type: 'accident', sheet: '사고유형' },
  { type: 'benefit', sheet: '구보장급부' },
  { type: 'insuredType', sheet: '사고자유형' },
  { type: 'signGroup', sheet: '사인그룹' },
  { type: 'riskBenefit', sheet: '위험급부' },
  { type: 'benefitCond', sheet: '급부결정조건' },
  { type: 'calcCond', sheet: '계산식결정조건' },
  { type: 'amountType', sheet: '금액유형' },
  { type: 'detailFormula', sheet: '상세계산식' },
  { type: 'contractStatus', sheet: '계약상태처리' },
  { type: 'waiver', sheet: '납면처리' },
  { type: 'renewable', sheet: '갱신가능불가' },
  { type: 'futureAnnuity', sheet: '장래연금구분' },
  { type: 'investment', sheet: '보험투자요소' },
];
const SHEET_OF = Object.fromEntries(CODE_TYPES.map((t) => [t.type, t.sheet]));

const CAPTURED = '화면캡처';
const MADE_UP = '임시생성';
const c = (code, name, desc = '') => ({ code, name, desc, origin: CAPTURED });
const t = (code, name, desc = '') => ({ code, name, desc, origin: MADE_UP });

function provisionalMaster() {
  return {
    id: 'provisional-1',
    source: '임시 코드마스터(실제 ECS 코드 아님)',
    provisional: true,
    types: {
      claim: [c('S01', '사망'), c('S08', '장해'), c('S11', '수술'), c('S15', '진단'), t('TMP-CL01', '입원'), t('TMP-CL02', '통원'), t('TMP-CL03', '요양·간병'), t('TMP-CL04', '생존·만기'), t('TMP-CL05', '기타')],
      accident: [c('G01', '일반', '질병 등 재해 이외의 원인'), c('B12', '일반재해', '교통재해 이외의 재해'), c('B03', '교통재해'), t('TMP-AC01', '질병'), t('TMP-AC02', '상해')],
      benefit: [t('TMP-BN01', '사망보험금'), t('TMP-BN02', '재해사망보험금'), t('TMP-BN03', '장해급여금'), t('TMP-BN04', '진단보험금'), t('TMP-BN05', '수술보험금'), t('TMP-BN06', '입원급여금'), t('TMP-BN07', '통원급여금'), t('TMP-BN08', '치료보험금'), t('TMP-BN09', '생존·만기보험금')],
      insuredType: [t('TMP-IT01', '주피', '주피보험자'), t('TMP-IT02', '종피', '종피보험자'), t('TMP-IT03', '자녀')],
      signGroup: [
        c('T00', '사인그룹|재해', '재해 전체'), c('T01', '사인그룹|교통재해'), c('T02', '사인그룹|일반재해'), c('T03', '사인그룹|질병및일반', '질병 등 재해 이외'),
        t('TMP-SG01', '사인그룹|암', '일반암(소액암 제외)'), t('TMP-SG02', '사인그룹|소액암', '갑상선암, 기타피부암, 제자리암, 경계성종양'),
        t('TMP-SG03', '사인그룹|뇌혈관질환'), t('TMP-SG04', '사인그룹|뇌출혈'), t('TMP-SG05', '사인그룹|급성심근경색증'), t('TMP-SG06', '사인그룹|허혈성심장질환'),
        t('TMP-SG07', '사인그룹|치매'), t('TMP-SG08', '사인그룹|장기요양'), t('TMP-SG09', '사인그룹|골절'), t('TMP-SG10', '사인그룹|화상'),
        t('TMP-SG11', '사인그룹|고의자해', '고의로 자신을 해친 경우'), t('TMP-SG12', '사인그룹|전쟁·내란')],
      riskBenefit: [t('TMP-RB01', '일반사망'), t('TMP-RB02', '재해사망'), t('TMP-RB03', '장해'), t('TMP-RB04', '진단'), t('TMP-RB05', '수술'), t('TMP-RB06', '입원'), t('TMP-RB07', '통원'), t('TMP-RB08', '치료'), t('TMP-RB09', '생존')],
      benefitCond: [t('TMP-BC01', '사인그룹'), t('TMP-BC02', '장해지급률'), t('TMP-BC03', '진단확정'), t('TMP-BC04', '입원일수'), t('TMP-BC05', '수술분류'), t('TMP-BC06', '지급횟수'), t('TMP-BC07', '보장개시일 경과'), t('TMP-BC08', '생존 여부')],
      calcCond: [t('TMP-CC01', '경과기간'), t('TMP-CC02', '계약구분(최초·갱신)'), t('TMP-CC03', '피보험자 연령'), t('TMP-CC04', '성별'), t('TMP-CC05', '장해지급률'), t('TMP-CC06', '입원일수'), t('TMP-CC07', '수술종류')],
      amountType: [t('TMP-AT01', '가입금액'), t('TMP-AT02', '기납입보험료'), t('TMP-AT03', '책임준비금'), t('TMP-AT04', '일당(1일 지급액)'), t('TMP-AT05', '별표 지급액')],
      detailFormula: [t('TMP-DF01', '정액(가입금액×비율)'), t('TMP-DF02', '일당×입원·통원일수'), t('TMP-DF03', '가입금액×장해지급률'), t('TMP-DF04', 'MAX(가입금액, 기납입보험료)'), t('TMP-DF05', '별표 지급액')],
      contractStatus: [c('9', '소멸'), t('1', '유지', '이전 앱에서 추정한 값'), t('TMP-ST1', '특약소멸')],
      waiver: [t('TMP-WV0', '해당없음'), t('TMP-WV1', '납입면제')],
      renewable: [t('TMP-RN0', '갱신불가(비갱신형)'), t('TMP-RN1', '갱신가능(갱신형)')],
      futureAnnuity: [t('TMP-FA0', '해당없음'), t('TMP-FA1', '장래연금')],
      investment: [t('TMP-IV0', '해당없음'), t('TMP-IV1', '해당')],
    },
  };
}

const isProvisionalEntry = (e) => e.origin === MADE_UP || /^TMP-/i.test(e.code);

// 코드 검사: { code, name, flags[] } 를 돌려줍니다.
//  - 마스터에 없는 코드 → 코드를 비우고 'code_unknown'(명칭으로 다른 코드를 끌어오지 않음)
//  - 코드 없이 명칭만 있고 명칭이 마스터와 정확히 같으면 → 코드를 채움
//  - 코드가 비어 있으면 'code_check'(코드 확인 필요), 임시 코드면 'code_provisional'
function checkCode(master, type, code, name) {
  const list = (master.types && master.types[type]) || [];
  const flags = [];
  let entry = null;
  const cd = String(code || '').trim();
  const nm = String(name || '').trim();
  if (cd) {
    entry = list.find((e) => e.code === cd);
    if (!entry) return { code: '', name: nm, flags: ['code_unknown', 'code_check'] };
  }
  if (!entry && nm) {
    const key = nm.replace(/\s/g, '');
    entry = list.find((e) => e.name.replace(/\s/g, '') === key) || null;
  }
  if (!entry) return { code: '', name: nm, flags: [...flags, 'code_check'] };
  if (isProvisionalEntry(entry) || master.provisional) flags.push('code_provisional');
  return { code: entry.code, name: nm || entry.name, masterName: entry.name, flags };
}

// AI 지시문에 넣을 코드 목록
function masterText(master) {
  return CODE_TYPES.map(({ type, sheet }) => {
    const list = master.types[type] || [];
    return `[${sheet}] (type=${type})\n${list.length ? list.map((e) => `${e.code}\t${e.name}${e.desc ? `\t(${e.desc})` : ''}`).join('\n') : '(코드 없음)'}`;
  }).join('\n\n');
}

function masterId(master) {
  return crypto.createHash('sha1').update(JSON.stringify(master.types)).digest('hex').slice(0, 12);
}

// ───────────── 엑셀 읽기·쓰기 ─────────────
// 엑셀 양식: 코드 종류마다 시트 하나(시트 이름에 '청구사유' 등이 들어 있으면 됨), 1행 머리글 [코드, 명칭, 설명, 출처].
async function toXlsx(master) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const guide = wb.addWorksheet('안내');
  guide.columns = [{ width: 110 }];
  [
    master.provisional ? '이 파일은 앱이 만든 임시 코드마스터입니다. 실제 ECS 코드가 아닙니다.' : `이 파일은 업로드한 코드마스터(${master.source})를 다시 내려받은 것입니다.`,
    '출처가 "화면캡처"인 코드는 이전에 받은 ECS 화면 캡처에서 확인한 값이고, "임시생성"인 코드(TMP-로 시작)는 앱이 지어낸 값입니다.',
    '실제 코드마스터로 바꾸려면 각 시트의 코드·명칭을 실제 값으로 고치고 출처 칸을 지우거나 "실제"로 바꾼 뒤 앱의 [코드마스터 올리기]로 올립니다.',
    '시트 이름과 1행 머리글(코드, 명칭, 설명)은 그대로 두어야 합니다. 시트를 더하거나 빼도 되며, 없는 시트의 코드는 모두 "코드 확인 필요"로 표시됩니다.',
  ].forEach((line) => guide.addRow([line]));
  for (const { type, sheet } of CODE_TYPES) {
    const ws = wb.addWorksheet(sheet);
    ws.columns = [{ header: '코드', key: 'code', width: 16 }, { header: '명칭', key: 'name', width: 34 }, { header: '설명', key: 'desc', width: 40 }, { header: '출처', key: 'origin', width: 12 }];
    ws.getRow(1).font = { bold: true };
    for (const e of master.types[type] || []) {
      const row = ws.addRow({ code: e.code, name: e.name, desc: e.desc || '', origin: e.origin || '' });
      if (isProvisionalEntry(e)) row.getCell('origin').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    }
  }
  return wb.xlsx.writeBuffer();
}

const cellText = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.result ?? (v.richText ? v.richText.map((r) => r.text).join('') : '')).trim();
  return String(v).trim();
};

async function fromXlsx(buffer, fileName) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw Object.assign(new Error('엑셀(.xlsx) 파일을 읽지 못했습니다. 파일 형식을 확인해 주십시오.'), { status: 400 }); }
  const types = {};
  const warnings = [];
  for (const { type, sheet } of CODE_TYPES) {
    const ws = wb.worksheets.find((w) => w.name.replace(/\s/g, '').includes(sheet));
    if (!ws) { warnings.push(`'${sheet}' 시트가 없어 이 종류의 코드는 모두 "코드 확인 필요"로 표시됩니다.`); types[type] = []; continue; }
    const head = (ws.getRow(1).values || []).map(cellText);
    const col = (want, fallback) => { const i = head.findIndex((h) => h && h.includes(want)); return i > 0 ? i : fallback; };
    const ci = col('코드', 1), ni = col('명칭', 2), di = col('설명', 0), oi = col('출처', 0);
    const list = [];
    ws.eachRow((row, r) => {
      if (r === 1) return;
      const code = cellText(row.getCell(ci).value);
      const name = cellText(row.getCell(ni).value);
      if (!code && !name) return;
      if (!code) { warnings.push(`'${sheet}' 시트 ${r}행: 코드가 비어 있어 건너뛰었습니다.`); return; }
      const origin = oi ? cellText(row.getCell(oi).value) : '';
      list.push({ code, name, desc: di ? cellText(row.getCell(di).value) : '', origin: /임시/.test(origin) ? MADE_UP : (origin === CAPTURED ? CAPTURED : '실제') });
    });
    types[type] = list;
  }
  const total = Object.values(types).reduce((s, l) => s + l.length, 0);
  if (!total) throw Object.assign(new Error('코드를 하나도 읽지 못했습니다. 시트 이름(예: 청구사유)과 1행 머리글(코드, 명칭)을 확인해 주십시오.'), { status: 400 });
  const provisionalCount = Object.values(types).flat().filter(isProvisionalEntry).length;
  const master = { source: fileName || '업로드한 코드마스터', provisional: false, uploadedAt: new Date().toISOString(), types, warnings, provisionalCount };
  master.id = masterId(master);
  return master;
}

function summary(master) {
  return {
    id: master.id, source: master.source, provisional: !!master.provisional, uploadedAt: master.uploadedAt || null, warnings: master.warnings || [],
    counts: Object.fromEntries(CODE_TYPES.map(({ type, sheet }) => [sheet, (master.types[type] || []).length])),
    provisionalCount: Object.values(master.types).flat().filter(isProvisionalEntry).length,
  };
}

module.exports = { CODE_TYPES, SHEET_OF, provisionalMaster, checkCode, masterText, masterId, toXlsx, fromXlsx, summary, isProvisionalEntry };
