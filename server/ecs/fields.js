// ECS "약관분석 데이터 관리" 화면의 필드 순서·필드명. 화면 D 영역과 엑셀 내보내기가 이 순서를 따릅니다.
// fill: user = 사용자가 직접 입력(앱이 추정하지 않음), code = 코드마스터 값만 제안하는 코드·명칭 쌍, text = 약관에서 추출하는 값
// 실제 ECS 화면과 순서·이름이 다르면 이 파일만 고치면 됩니다.

const GROUPS = ['상품·청구', '계산식', '상세계산식·처리'];

const numbered = (key, label, n, type, group) => Array.from({ length: n }, (_, i) => ({ key: `${key}${i + 1}`, label: `${label}${i + 1}`, fill: 'code', type, group }));

const FIELDS = [
  { key: 'productCode', label: '상품코드', fill: 'user', group: '상품·청구' },
  { key: 'productName', label: '상품명', fill: 'user', group: '상품·청구' },
  { key: 'saleDate', label: '판매개시일자', fill: 'user', group: '상품·청구' },
  { key: 'claim', label: '청구사유', fill: 'code', type: 'claim', group: '상품·청구' },
  { key: 'accident', label: '사고유형', fill: 'code', type: 'accident', group: '상품·청구' },
  { key: 'benefit', label: '구보장급부', fill: 'code', type: 'benefit', group: '상품·청구' },
  { key: 'insuredType', label: '사고자유형', fill: 'code', type: 'insuredType', group: '상품·청구' },
  { key: 'signGroup', label: '사인그룹', fill: 'code', type: 'signGroup', group: '상품·청구' },
  { key: 'riskBenefit', label: '위험급부', fill: 'code', type: 'riskBenefit', group: '상품·청구' },
  ...numbered('benefitCond', '급부결정조건', 6, 'benefitCond', '상품·청구'),
  ...numbered('calcCond', '계산식결정조건', 6, 'calcCond', '계산식'),
  { key: 'calcType', label: '계산구분', fill: 'text', group: '계산식' },
  { key: 'calcTarget', label: '계산대상', fill: 'text', group: '계산식' },
  { key: 'targetTable', label: '대상테이블', fill: 'text', group: '계산식' },
  { key: 'baseAmount', label: '1구좌기준금액', fill: 'text', group: '계산식' },
  { key: 'numerator', label: '분자', fill: 'text', group: '계산식' },
  { key: 'denominator', label: '분모', fill: 'text', group: '계산식' },
  { key: 'multiplier', label: '적용배수', fill: 'text', group: '계산식' },
  { key: 'formula', label: '계산식', fill: 'text', group: '계산식' },
  ...numbered('amountType', '금액유형', 5, 'amountType', '계산식'),
  ...numbered('detailFormula', '상세계산식', 5, 'detailFormula', '상세계산식·처리'),
  { key: 'contractStatus', label: '계약상태처리', fill: 'code', type: 'contractStatus', group: '상세계산식·처리' },
  { key: 'waiver', label: '납면처리', fill: 'code', type: 'waiver', group: '상세계산식·처리' },
  { key: 'renewable', label: '갱신가능불가', fill: 'code', type: 'renewable', group: '상세계산식·처리' },
  { key: 'futureAnnuity', label: '장래연금구분', fill: 'code', type: 'futureAnnuity', group: '상세계산식·처리' },
  { key: 'investment', label: '보험투자요소', fill: 'code', type: 'investment', group: '상세계산식·처리' },
];

// AI 에게 채우게 하는 필드(사용자 입력 필드 제외)
const AI_FIELDS = FIELDS.filter((f) => f.fill !== 'user');
const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

// 필드별로 AI 에게 주는 작성 요령
const FIELD_GUIDE = {
  claim: '담보의 지급사유에서 판단합니다(예: 사망, 진단).',
  accident: '지급사유의 원인 범위(일반·일반재해·교통재해 등)에서 판단합니다.',
  benefit: '지급하는 보험금(예: 재해사망보험금)입니다.',
  insuredType: '보험금 지급 대상 피보험자(예: 주피)입니다. 약관에 피보험자 구분이 없으면 약관에 명시 없음으로 둡니다.',
  signGroup: '보험금 지급 원인 그룹입니다.',
  riskBenefit: '위험급부 구분입니다.',
  benefitCond: '이 급부가 지급되는 조건을 약관에 나오는 순서대로 하나씩 채웁니다(예: 사인그룹, 진단확정, 입원일수).',
  calcCond: '같은 담보 안에서 산식을 가르는 조건(경과기간, 연령, 계약구분 등)을 하나씩 채웁니다.',
  calcType: '계산 방식 구분(예: 정액, 일당, 지급률)입니다.',
  calcTarget: '산식의 기준 금액(예: 가입금액)입니다.',
  targetTable: '산식이 참조하는 별표·부표 이름(예: 장해분류표)입니다. 표의 수치는 옮기지 않습니다.',
  baseAmount: '1구좌 기준금액이 약관에 있을 때만 적습니다.',
  numerator: '지급률이 분수로 정해진 경우의 분자입니다.',
  denominator: '지급률이 분수로 정해진 경우의 분모입니다.',
  multiplier: '가입금액에 곱하는 배수·비율(예: 50%)입니다.',
  formula: '전체 계산식을 약관 문구에 맞춰 [변수]로 적습니다(예: [가입금액] × 50%).',
  amountType: '지급금액을 이루는 금액 종류(가입금액, 기납입보험료 등)를 하나씩 채웁니다.',
  detailFormula: '세부 산식을 약관 문구 그대로 옮기고 산식 변수를 대괄호로 표기합니다(예: "[가입금액]의 50%를 지급").',
  contractStatus: '보험금 지급 후 계약 상태(예: 소멸, 유지)입니다.',
  waiver: '보험금 지급 후 보험료 납입면제 여부입니다.',
  renewable: '이 담보(특약)의 갱신 가능 여부입니다.',
  futureAnnuity: '보험금을 장래 연금으로 지급하는지 여부입니다.',
  investment: '보험투자요소 해당 여부입니다. 약관에 근거가 없으면 약관에 명시 없음으로 둡니다.',
};
const guideOf = (key) => FIELD_GUIDE[key] || FIELD_GUIDE[key.replace(/\d+$/, '')] || '';

module.exports = { GROUPS, FIELDS, AI_FIELDS, FIELD_BY_KEY, guideOf };
