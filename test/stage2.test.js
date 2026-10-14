// 2단계: 코드마스터·원문 대조·응답 형식·담보 분석 API(Claude 대신 시험용 응답 사용)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-s2-'));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.COVERAGE_AI_FAKE;

const SAMPLE = path.join(__dirname, '..', 'samples', 'sample_policy.pdf');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'ai-fixtures', '사망보험금.json'), 'utf8'));
const codemaster = require('../server/ecs/codemaster');
const { verifyCitation, pageTexts } = require('../server/analyze/verify');
const { SCHEMA, A_ITEMS, systemPrompt } = require('../server/analyze/prompt');
const { FIELDS } = require('../server/ecs/fields');
const ai = require('../server/analyze/ai-client');

test('임시 코드마스터: TMP 코드는 임시로, 화면캡처 코드는 출처를 남겨 엑셀로 주고받는다', async () => {
  const m = codemaster.provisionalMaster();
  assert.ok(Object.values(m.types).flat().every((e) => e.origin === '화면캡처' || /^TMP-/.test(e.code) || e.code === '1'));
  const back = await codemaster.fromXlsx(Buffer.from(await codemaster.toXlsx(m)), '임시_코드마스터.xlsx');
  for (const { type } of codemaster.CODE_TYPES) assert.deepEqual(back.types[type].map((e) => e.code), m.types[type].map((e) => e.code), type);
  assert.equal(back.types.claim.find((e) => e.code === 'S01').origin, '화면캡처');
  assert.equal(back.types.claim.find((e) => e.code === 'TMP-CL01').origin, '임시생성');
  assert.ok(back.provisionalCount > 0);
});

test('코드 검사: 마스터에 없는 코드는 비우고, 명칭이 같으면 코드를 채우고, 임시 코드는 표시한다', () => {
  const real = { id: 'r', provisional: false, types: { claim: [{ code: 'S01', name: '사망', origin: '실제' }, { code: 'TMP-CL01', name: '입원', origin: '임시생성' }] } };
  assert.deepEqual(codemaster.checkCode(real, 'claim', 'S01', '사망'), { code: 'S01', name: '사망', masterName: '사망', flags: [] });
  assert.deepEqual(codemaster.checkCode(real, 'claim', 'X99', '사망').flags, ['code_unknown', 'code_check']);
  assert.equal(codemaster.checkCode(real, 'claim', 'X99', '사망').code, '');
  assert.equal(codemaster.checkCode(real, 'claim', '', '사 망').code, 'S01');
  assert.deepEqual(codemaster.checkCode(real, 'claim', '', '통원').flags, ['code_check']);
  assert.deepEqual(codemaster.checkCode(real, 'claim', 'TMP-CL01', '입원').flags, ['code_provisional']);
  assert.deepEqual(codemaster.checkCode(real, 'benefit', '', '사망보험금').flags, ['code_check']);
});

test('코드마스터 엑셀: 시트·머리글이 없으면 알려 주고, 빈 파일은 거부한다', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('청구사유 코드');
  ws.addRow(['코드', '명칭']); ws.addRow(['S01', '사망']); ws.addRow(['', '코드없음']);
  const m = await codemaster.fromXlsx(Buffer.from(await wb.xlsx.writeBuffer()), 'real.xlsx');
  assert.deepEqual(m.types.claim, [{ code: 'S01', name: '사망', desc: '', origin: '실제' }]);
  assert.ok(m.warnings.some((w) => w.includes("'사고유형' 시트가 없어")));
  assert.ok(m.warnings.some((w) => w.includes('코드가 비어 있어')));
  await assert.rejects(codemaster.fromXlsx(Buffer.from('not xlsx')), /엑셀/);
});

test('응답 형식: 모든 객체가 additionalProperties:false 이고 required 에 모든 속성이 들어 있다', () => {
  const walk = (s, where) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, where);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), where);
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${where}.${k}`);
    }
    if (s.type === 'array') walk(s.items, `${where}[]`);
  };
  walk(SCHEMA, 'root');
  // 사용자 입력 필드는 AI 가 채우지 않습니다.
  const keys = SCHEMA.properties.rows.items.properties.fields.items.properties.key.enum;
  assert.ok(!keys.includes('productCode') && !keys.includes('saleDate') && keys.includes('detailFormula5'));
  assert.equal(FIELDS.length, 44);
  const sys = systemPrompt(codemaster.provisionalMaster());
  assert.match(sys, /TMP-로 시작하는 코드는 지어낸 값/);
  assert.match(sys, /S01\t사망/);
});

test('원문 대조: 그대로 있음·다른 쪽에 있음·일부 일치·없음을 구분한다', () => {
  const pages = [
    { n: 1, printed: null, lines: [{ t: '제1조(목적) 이 계약은 위험을 보장하기 위하여 체결됩니다.' }] },
    { n: 2, printed: 1, lines: [{ t: '제4조(보험금의 지급금액) ① 사망보험금은 가입금액을 지급합니다. 다만, 재해 이외의 원인으로' }, { t: '계약일부터 2년 이내에 사망한 경우에는 가입금액의 50%를 지급합니다.' }] },
    { n: 3, printed: 2, lines: [{ t: '머리글', noise: true }, { t: '제5조 ① 회사는 보험금을 지급합니다.' }] },
  ];
  const texts = pageTexts(pages);
  const ranges = [{ startPage: 1, endPage: 3 }];
  const q = '다만, 재해 이외의 원인으로 계약일부터 2년 이내에 사망한 경우에는 가입금액의 50%를 지급합니다.';
  assert.equal(verifyCitation({ article: '제4조', pdfPage: 2, quote: q }, texts, pages, ranges).check, 'exact');
  const moved = verifyCitation({ article: '제4조', pdfPage: 1, quote: q }, texts, pages, ranges);
  assert.equal(moved.check, 'moved');
  assert.equal(moved.pdfPage, 2);
  assert.equal(moved.printed, 1);
  assert.equal(verifyCitation({ article: '제4조', pdfPage: 2, quote: '다만, 재해 이외의 원인으로 계약일부터 2년 이내에 사망한 경우에는 가입금액의 반액을 지급합니다.' }, texts, pages, ranges).check, 'partial');
  assert.equal(verifyCitation({ article: '제4조', pdfPage: 2, quote: '사망보험금은 가입금액의 200%를 지급합니다.' }, texts, pages, ranges).check, 'failed');
  assert.equal(verifyCitation({ article: '-', pdfPage: 3, quote: '머리글' }, texts, pages, ranges).check, 'failed');
});

test('서버: 담보 분석 → 원문 대조 → 코드 검사 → 검토 상태·직접 수정·상품 정보 저장', async () => {
  const app = require('../server/index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const post = (p, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const up = await (await fetch(`${base}/api/upload`, { method: 'POST', body: fs.readFileSync(SAMPLE) })).json();
    await (await fetch(`${base}/api/docs/${up.id}/events`)).text();
    const doc = (await j(`/api/docs/${up.id}`)).body;
    const death = doc.coverages.find((c) => c.name === '사망보험금');

    // API 키가 없으면 분석을 시작하지 않고 설정 방법을 알려 줍니다.
    const cfg = (await j('/api/config')).body;
    assert.equal(cfg.ai.ready, false);
    assert.equal(cfg.codemaster.provisional, true);
    const noKey = await post(`/api/docs/${up.id}/analysis`, { coverageIds: [death.id] });
    assert.equal(noKey.status, 400);
    assert.match(noKey.body.error, /API 키/);

    // Claude 대신 시험용 응답을 돌려줍니다. 보낸 원문에는 쪽 표시와 담보 정보가 들어 있어야 합니다.
    const calls = [];
    ai.setCaller(async (args) => { calls.push(args); return { json: FIXTURE, usage: null, model: 'test' }; });
    const started = await post(`/api/docs/${up.id}/analysis`, { coverageIds: [death.id] });
    assert.deepEqual(started.body, { total: 1, skipped: 0 });
    await (await fetch(`${base}/api/docs/${up.id}/analysis/events`)).text();
    assert.equal(calls.length, 1);
    assert.match(calls[0].documentText, /〔PDF 5쪽 \| 인쇄 1쪽〕/);
    assert.match(calls[0].documentText, /\[별표1\]|별표1 장해분류표: PDF/);
    assert.match(calls[0].request, /담보명: 사망보험금/);

    let res = (await j(`/api/docs/${up.id}/analysis`)).body.results[death.id];
    // A: 원문에 없는 인용만 단 항목은 값을 숨깁니다.
    const after = res.A.find((a) => a.key === 'afterPayment');
    assert.equal(after.status, 'unverified');
    assert.deepEqual(after.citations, []);
    const amount = res.A.find((a) => a.key === 'amount');
    assert.equal(amount.citations[0].printed, 1);
    assert.equal(amount.interpretations.length, 2);
    // B: 근거 없는 항목은 빠집니다.
    assert.deepEqual(res.B.map((b) => b.title), ['재해 이외 원인 2년 이내 사망 감액', '재해분류표']);
    assert.equal(res.droppedB, 1);
    // D: 행 2개, 필드 순서 고정, 코드 검사
    assert.equal(res.rows.length, 2);
    assert.deepEqual(res.rows[0].fields.map((f) => f.label), FIELDS.map((f) => f.label));
    const f = (row, key) => res.rows[row].fields.find((x) => x.key === key);
    assert.deepEqual(f(0, 'productCode').flags, ['user_input']);
    assert.deepEqual(f(0, 'claim').after, { code: 'S01', name: '사망' });
    assert.ok(f(0, 'claim').flags.includes('code_provisional'));
    assert.deepEqual(f(0, 'benefit').after, { code: '', name: '사망보험금' });
    assert.ok(f(0, 'benefit').flags.includes('code_unknown'));
    assert.equal(f(0, 'contractStatus').status, 'unverified');
    assert.equal(f(0, 'contractStatus').after.name, '');
    assert.equal(f(0, 'insuredType').display, '약관에 명시 없음');
    assert.equal(f(1, 'multiplier').after.name, '100%');

    // 같은 담보를 다시 요청하면 캐시를 써서 부르지 않습니다.
    assert.deepEqual((await post(`/api/docs/${up.id}/analysis`, { coverageIds: [death.id] })).body, { total: 0, skipped: 1 });
    await (await fetch(`${base}/api/docs/${up.id}/analysis/events`)).text();
    assert.equal(calls.length, 1);

    // 검토 상태·직접 수정·상품 정보
    const claimKey = f(0, 'claim').reviewKey;
    const benefitKey = f(0, 'benefit').reviewKey;
    await fetch(`${base}/api/docs/${up.id}/review`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewStatus: { [claimKey]: 'done', [res.A[0].reviewKey]: 'done', bad: 'x' }, fieldEdits: { [benefitKey]: { code: 'S01G010221', name: '기타사망보험금' } }, product: { productCode: 'P123', productName: '더미건강종신', saleDate: '2026-11-01' } }),
    });
    res = (await j(`/api/docs/${up.id}/analysis`)).body.results[death.id];
    assert.equal(res.rows[0].fields.find((x) => x.key === 'claim').reviewed, true);
    assert.equal(res.A[0].reviewed, true);
    assert.equal(res.progress.reviewed, 2);
    assert.deepEqual(res.rows[0].fields.find((x) => x.key === 'benefit').after, { code: 'S01G010221', name: '기타사망보험금' });
    assert.deepEqual(res.rows[0].fields.find((x) => x.key === 'benefit').flags, ['code_not_in_master']);
    assert.equal(res.rows[0].fields.find((x) => x.key === 'productCode').after.name, 'P123');
    assert.equal(res.rows[1].fields.find((x) => x.key === 'productCode').after.name, 'P123');

    // 실제 코드마스터를 올리면 그 기준으로 다시 검사하고, 되돌릴 수 있습니다.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('청구사유');
    ws.addRow(['코드', '명칭']); ws.addRow(['S01', '사망']);
    const upm = await j('/api/codemaster', { method: 'POST', headers: { 'X-File-Name': 'real.xlsx' }, body: Buffer.from(await wb.xlsx.writeBuffer()) });
    assert.equal(upm.status, 200);
    assert.equal(upm.body.provisional, false);
    res = (await j(`/api/docs/${up.id}/analysis`)).body.results[death.id];
    assert.deepEqual(res.rows[0].fields.find((x) => x.key === 'claim').flags, []);
    assert.deepEqual(res.rows[0].fields.find((x) => x.key === 'amountType1').flags, ['code_unknown', 'code_check']);
    assert.ok(res.stale.some((t) => t.includes('코드마스터가 바뀌었습니다')));
    const dl = await fetch(`${base}/api/codemaster/download`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /xlsx/);
    assert.equal((await j('/api/codemaster', { method: 'DELETE' })).body.provisional, true);
    assert.equal((await j('/api/codemaster', { method: 'POST', body: Buffer.from('nope') })).status, 400);

    // 분석 실패는 카드에 오류로 남고, 이전 결과는 유지합니다.
    ai.setCaller(async () => { throw new Error('시험용 실패'); });
    await post(`/api/docs/${up.id}/analysis`, { coverageIds: [death.id], force: true });
    await (await fetch(`${base}/api/docs/${up.id}/analysis/events`)).text();
    res = (await j(`/api/docs/${up.id}/analysis`)).body.results[death.id];
    assert.equal(res.lastError, '시험용 실패');
    assert.equal(res.rows.length, 2);
  } finally {
    ai.setCaller(null);
    server.close();
  }
});
