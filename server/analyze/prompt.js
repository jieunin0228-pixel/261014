// 담보 분석 지시문과 응답 형식(JSON 스키마). 지시문을 고치면 PROMPT_VERSION 을 올립니다(이전 분석 결과는 "다시 분석 필요"로 표시).
const { AI_FIELDS, guideOf } = require('../ecs/fields');
const { masterText } = require('../ecs/codemaster');

const PROMPT_VERSION = 'coverage-1';

// A 영역(보장 세부조건) 항목
const A_ITEMS = [
  ['name', '담보명'],
  ['cause', '지급사유'],
  ['amount', '지급금액과 산식'],
  ['limit', '지급횟수와 한도(1회·연간·통산)'],
  ['coverageStart', '보장개시일'],
  ['exemptPeriod', '면책기간'],
  ['reduction', '감액기간과 감액비율'],
  ['term', '보험기간과 갱신 여부'],
  ['exclusions', '지급하지 않는 사유'],
  ['definitions', '요건의 세부 정의(진단확정·입원일수 등)'],
  ['afterPayment', '보험금 지급 후 계약 소멸·납입면제·가입금액 감액'],
];

// B 영역(전산화 시 주의사항) 유형
const B_TYPES = ['별표·부표 참조', '산출 영향 용어 정의', '단서·예외에 따른 조건 분기', '다른 담보와의 중복지급·택일', '경과기간·연령·성별별 지급률 차이', '기준일 판단', '기타'];

const citation = {
  type: 'object',
  additionalProperties: false,
  required: ['article', 'pdfPage', 'quote'],
  properties: {
    article: { type: 'string', description: '조·항·호 번호(예: 제3조 제1항 제2호, 별표1)' },
    pdfPage: { type: 'integer', description: '〔PDF n쪽〕 표시에서 읽은 PDF 쪽번호' },
    quote: { type: 'string', description: '원문을 한 글자도 바꾸지 않고 옮긴 한두 문장(150자 이내)' },
  },
};
const citations = { type: 'array', items: citation };
const interpretation = {
  interpretationNeeded: { type: 'boolean', description: '해석이 갈릴 수 있으면 true' },
  interpretations: { type: 'array', items: { type: 'string' }, description: '가능한 해석들(해석 확인이 필요할 때만)' },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['coverageFound', 'A', 'B', 'rows'],
  properties: {
    coverageFound: { type: 'boolean', description: '요청한 담보가 주어진 약관에 있으면 true' },
    A: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['key', 'status', 'value', 'citations', 'interpretationNeeded', 'interpretations'],
        properties: {
          key: { type: 'string', enum: A_ITEMS.map(([k]) => k) },
          status: { type: 'string', enum: ['found', 'not_in_terms'] },
          value: { type: 'string' },
          citations,
          ...interpretation,
        },
      },
    },
    B: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'title', 'detail', 'tableName', 'citations', 'interpretationNeeded', 'interpretations'],
        properties: {
          type: { type: 'string', enum: B_TYPES },
          title: { type: 'string' },
          detail: { type: 'string' },
          tableName: { type: 'string', description: '별표·부표를 참조하면 그 표 이름, 아니면 빈 문자열' },
          citations,
          ...interpretation,
        },
      },
    },
    rows: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['label', 'splitReason', 'splitCitations', 'fields'],
        properties: {
          label: { type: 'string', description: '행 이름(예: 경과기간 2년 이내 감액)' },
          splitReason: { type: 'string', description: '행을 나눈 근거. 한 행이면 빈 문자열' },
          splitCitations: citations,
          fields: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['key', 'status', 'code', 'name', 'note', 'citations'],
              properties: {
                key: { type: 'string', enum: AI_FIELDS.map((f) => f.key) },
                status: { type: 'string', enum: ['filled', 'not_in_terms'] },
                code: { type: 'string', description: '코드마스터에 있는 코드만. 맞는 코드가 없으면 빈 문자열' },
                name: { type: 'string' },
                note: { type: 'string', description: '판단 메모(짧게). 없으면 빈 문자열' },
                citations,
              },
            },
          },
        },
      },
    },
  },
};

function fieldGuideText() {
  return AI_FIELDS.map((f) => `- ${f.key} (${f.label})${f.fill === 'code' ? ` [코드: type=${f.type}]` : ''}: ${guideOf(f.key)}`).join('\n');
}

function systemPrompt(master) {
  return `당신은 생명보험사 보험금심사팀에서 신약관의 보험금 자동산출 룰을 ECS(Expert Claim System)에 입력하는 담당자를 돕습니다.
담당자는 당신의 결과를 보고 ECS "약관분석 데이터 관리" 화면에 값을 옮겨 입력합니다. 결과는 보험금 산출 룰의 근거가 되므로, 틀린 값보다 빈 값이 낫습니다.

# 정확성 원칙
1. 주어진 [약관 원문]에 적힌 내용만 씁니다. 상식이나 다른 상품의 관행으로 추정하지 않습니다.
2. 약관에서 찾지 못한 항목은 status를 "not_in_terms"로 하고 value·name·code는 빈 문자열로 둡니다.
3. status가 "found" 또는 "filled"인 항목에는 반드시 citations를 하나 이상 답니다.
   - article: 조·항·호 번호(예: "제3조 제1항 제2호"). 별표이면 "별표1"처럼 적습니다.
   - pdfPage: 원문 앞의 〔PDF n쪽〕 표시에서 읽은 n입니다. 약관 인쇄 쪽번호가 아닙니다.
   - quote: 원문을 한 글자도 바꾸지 않고 그대로 옮긴 한두 문장(150자 이내)입니다. 요약하거나 고쳐 쓰면 프로그램이 근거로 인정하지 않고 그 항목을 지웁니다.
4. 별표·부표 안의 수치와 지급률은 풀어 쓰지 않습니다. 표 이름과 위치(〔별표 목록〕의 쪽)만 안내합니다.
5. 해석이 갈릴 수 있으면 interpretationNeeded를 true로 하고 가능한 해석을 interpretations에 모두 적습니다(예: 경계일 포함 여부, 면책기간 기산점).
6. 특약이 주계약 약관을 준용한다고만 적혀 있고 해당 내용이 주어진 원문에 없으면, 그 항목은 not_in_terms로 두고 B 영역에 "주계약 약관 준용 확인 필요"를 남깁니다.

# A 영역: 보장 세부조건
다음 항목을 모두 하나씩 채웁니다(key: 항목).
${A_ITEMS.map(([k, l]) => `- ${k}: ${l}`).join('\n')}
value는 담당자가 바로 읽을 수 있는 완결된 문장으로 씁니다.

# B 영역: 전산화 시 주의사항
산출 룰을 만들 때 놓치기 쉬운 점을 유형별로 적습니다. 유형: ${B_TYPES.join(', ')}.
"다만" 단서와 예외의 예외로 조건이 갈리는 곳, 다른 담보와의 중복지급·택일, 경과기간·연령·성별별 지급률 차이, 기준일(사고일·진단일·입원개시일·수술일) 판단을 빠짐없이 찾습니다.

# D 영역: ECS 룰 입력 초안
rows의 각 행이 ECS의 룰 한 행입니다. 같은 담보라도 조건 분기(경과기간별 지급률, 최초·갱신계약, 사고유형별 지급액 등)로 산식이 달라지면 행을 나누고, splitReason과 splitCitations에 나눈 근거를 적습니다.
각 행의 fields에는 아래 필드를 모두 하나씩 넣습니다. 상품코드·상품명·판매개시일자는 담당자가 직접 입력하므로 넣지 않습니다.
${fieldGuideText()}

코드 필드 규칙:
- code는 아래 [코드마스터]의 해당 type 목록에 있는 코드만 씁니다. 목록에 맞는 코드가 없으면 code는 빈 문자열로 두고 name에 약관 용어로 명칭만 적습니다.
- name은 코드마스터의 명칭과 같은 뜻이면 그 명칭을 그대로 씁니다.
- 급부결정조건1~6, 계산식결정조건1~6, 금액유형1~5, 상세계산식1~5는 해당하는 것만 앞 번호부터 채우고 나머지는 not_in_terms로 둡니다.

# [코드마스터]
${master.provisional ? '※ 현재 코드마스터는 임시입니다. TMP-로 시작하는 코드는 지어낸 값이므로, 뜻이 정확히 맞을 때만 고릅니다.\n' : ''}${masterText(master)}`;
}

function requestText(coverage) {
  return `[분석 요청]
담보명: ${coverage.name}
정의 약관: ${coverage.sectionTitle || '(지정 없음)'}
${coverage.evidence && coverage.evidence.quote ? `자동 추출 근거: ${coverage.evidence.article || ''} (PDF ${coverage.evidence.page}쪽) "${coverage.evidence.quote}"\n` : ''}
위 담보 하나에 대해서만 A·B 영역과 D 영역(rows)을 작성하십시오. 같은 약관의 다른 담보 내용은 이 담보의 조건과 관계있을 때(중복지급·택일 등)만 B 영역에 적습니다.`;
}

module.exports = { PROMPT_VERSION, A_ITEMS, B_TYPES, SCHEMA, systemPrompt, requestText };
