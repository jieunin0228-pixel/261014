// ECS 룰 테이블 컬럼 정의와 코드 마스터(모두 더미 값).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EcsSchema = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // 엑셀 다운로드·화면 표시 공통 컬럼 순서. key 는 행 객체의 속성명입니다.
  const RULE_COLUMNS = [
    { key: 'no', label: '행번호' },
    { key: 'category', label: '구분' },
    { key: 'claimCode', label: '청구사유코드' },
    { key: 'claim', label: '청구사유' },
    { key: 'accidentCode', label: '사고유형코드' },
    { key: 'accident', label: '사고유형' },
    { key: 'benefitCode', label: '구보장급부코드' },
    { key: 'benefit', label: '구보장급부명' },
    { key: 'riskBenefitCode', label: '위험급부코드' },
    { key: 'riskBenefit', label: '위험급부명' },
    { key: 'signGroupCode', label: '사인그룹코드' },
    { key: 'signGroup', label: '급부결정조건(사인그룹)' },
    { key: 'codeNote', label: '코드상태' },
    { key: 'calcCondition', label: '계산식결정조건' },
    { key: 'calcTarget', label: '계산대상' },
    { key: 'formula', label: '상세계산식' },
    { key: 'statusCode', label: '계약상태처리코드' },
    { key: 'status', label: '계약상태처리' },
    { key: 'section', label: '약관구간' },
    { key: 'citations', label: '약관근거조항' },
    { key: 'excerptText', label: '원문발췌' },
    { key: 'flagText', label: '주의·테스트표시' },
    { key: 'testText', label: '테스트시나리오' },
  ];

  // 정답지 엑셀의 필수 컬럼. 앞의 4개가 행 매칭 키, 뒤의 2개가 비교 대상입니다.
  const ANSWER_KEY_COLUMNS = ['구보장급부명', '사고유형', '사인그룹코드', '계산식결정조건', '상세계산식', '계약상태처리'];
  const ANSWER_KEY_MATCH = ANSWER_KEY_COLUMNS.slice(0, 4);
  const ANSWER_KEY_COMPARE = ANSWER_KEY_COLUMNS.slice(4);

  const CLAIM = { code: 'S01', name: '사망' };

  const ACCIDENT_TYPES = {
    일반: { code: 'G01', signGroup: 'T03' },
    일반재해: { code: 'B12', signGroup: 'T02' },
    교통재해: { code: 'B03', signGroup: 'T01' },
  };

  // 사인그룹 마스터. keywords 가 있는 그룹만 면책 사유와 매핑할 수 있습니다.
  // 여기에 없는 사유(심신상실, 수익자·계약자 고의 등)는 "심사자 수기" 대상입니다.
  const SIGN_GROUPS = {
    T01: { name: '사인그룹|교통재해' },
    T02: { name: '사인그룹|일반재해' },
    T03: { name: '사인그룹|질병및일반' },
    T10: { name: '사인그룹|고의자해', keywords: ['고의로 자신을 해친', '자살'], accidents: ['일반'] },
    T20: {
      name: '사인그룹|전쟁·내란',
      keywords: ['전쟁', '무력행사', '혁명', '내란', '사변', '폭동'],
      accidents: ['일반재해', '교통재해'],
    },
  };

  const STATUS = { 소멸: '9', 유지: '1' };

  // ECS 에 이미 등록된 계산 변수. 이 밖의 변수가 쓰이면 "신규 변수"로 보고 🔴 표시합니다.
  const KNOWN_VARIABLES = ['가입금액', '경과기간', '계약구분'];

  return {
    RULE_COLUMNS, ANSWER_KEY_COLUMNS, ANSWER_KEY_MATCH, ANSWER_KEY_COMPARE,
    CLAIM, ACCIDENT_TYPES, SIGN_GROUPS, STATUS, KNOWN_VARIABLES,
  };
});
