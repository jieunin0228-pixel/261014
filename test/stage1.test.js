// 1단계: PDF 추출·목차·구간 분리·담보 분류·트리 선택·서버 API
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAMPLE = path.join(__dirname, '..', 'samples', 'sample_policy.pdf');
const expected = require('../samples/sample_expected.json');

// 서버 API 시험은 임시 data 폴더를 씁니다(store 를 불러오기 전에 정해야 합니다).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-data-'));

const { extractPdf, resolvePrintedPages } = require('../server/pdf/extract');
const { findToc, bodyStream, splitSections, matchToc, sectionTitle } = require('../server/pdf/toc');
const { extractCoverages, categorize, applyOverrides } = require('../server/analyze/classify');
const T = require('../public/tree');

let pages, toc, stream, sections, coverages;
test.before(async () => {
  ({ pages } = await extractPdf(fs.readFileSync(SAMPLE)));
  toc = findToc(pages);
  stream = bodyStream(pages, toc.tocPages);
  sections = splitSections(stream);
  coverages = extractCoverages(sections, stream, pages);
});

test('쪽 수·스캔 쪽·인쇄 쪽번호를 읽는다', () => {
  assert.equal(pages.length, expected.totalPages);
  assert.deepEqual(pages.filter((p) => p.scanned).map((p) => p.n), [expected.scannedPdfPage]);
  // 표지·목차에는 쪽번호가 없고, 본문 첫 쪽이 인쇄 1쪽입니다.
  for (const p of pages.slice(0, expected.bodyStartPdfPage - 1)) assert.equal(p.printed, null, `PDF ${p.n}쪽`);
  const body = pages.slice(expected.bodyStartPdfPage - 1);
  for (const p of body) assert.equal(p.printed, p.n - expected.bodyStartPdfPage + 1, `PDF ${p.n}쪽`);
});

test('머리글·쪽번호만 잡음으로 표시하고 본문 줄은 지우지 않는다', () => {
  const noise = new Set(pages.flatMap((p) => p.lines.filter((l) => l.noise).map((l) => l.t.replace(/\d+/g, '#'))));
  assert.deepEqual([...noise].sort(), ['- # -', '무배당 더미건강종신보험 약관'].sort());
});

test('목차 쪽을 찾고 목차의 약관·별표가 모두 본문 구간과 짝지어진다', () => {
  assert.deepEqual(toc.tocPages, expected.tocPages);
  const m = matchToc(sections, toc, pages);
  assert.deepEqual(m.missing, []);
  for (const s of sections) assert.equal(s.toc && s.toc.pageAgrees, true, s.title);
});

test('약관·별표 구간을 제목·시작 쪽까지 정확히 나눈다', () => {
  const got = sections.map((s) => ({ title: s.title, kind: s.kind, pdfPage: s.startPage }));
  const want = expected.sections.map((s) => ({ title: s.title.replace(/^\[별표(\d+)\]/, '별표$1'), kind: s.kind, pdfPage: s.pdfPage }));
  assert.deepEqual(got, want);
});

test('담보를 빠짐없이 찾고 대분류를 정답대로 나눈다', () => {
  const titleOf = new Map(sections.map((s) => [s.id, s.title]));
  const got = coverages.map((c) => `${titleOf.get(c.sectionId)} / ${c.name} / ${c.category}`);
  const want = expected.coverages.map((c) => `${c.section} / ${c.name} / ${c.category}`);
  assert.deepEqual(got, want);
  for (const c of coverages) {
    assert.ok(c.reason.length > 10, `${c.name} 분류 근거`);
    assert.ok(c.evidence.quote.includes(c.fromTitle ? c.sectionTitle : c.name), `${c.name} 원문 인용`);
    assert.ok(c.evidence.printed >= 1, `${c.name} 인쇄 쪽번호`);
  }
});

test('줄바꿈된 지급사유 문장 전체를 근거로 인용한다', () => {
  const c = coverages.find((x) => x.name === '유족연금');
  assert.match(c.evidence.quote, /^1\. 피보험자가 보험기간 중 사망하였을 경우.*유족연금$/);
  assert.match(c.reason, /지급사유 문장의 '사망하였을'/);
});

test('대분류 규칙: 담보명 단서가 우선하고, 단서가 없으면 기타와 근거를 남긴다', () => {
  assert.equal(categorize('암직접치료입원급여금').category, '입원');
  assert.equal(categorize('재해장해연금').category, '장해');
  assert.equal(categorize('골절진단보험금').category, '진단');
  assert.equal(categorize('항암방사선약물치료보험금').category, '치료');
  const other = categorize('응급실내원보험금', '응급실에 내원하여 진료를 받은 경우');
  assert.equal(other.category, '기타');
  assert.match(other.reason, /기타로 분류/);
  assert.match(categorize('장해급여금').reason, /장해로 분류/);
});

test('약관 제목 줄 변형을 인식한다', () => {
  assert.deepEqual(sectionTitle('3. 무배당 암진단특약(갱신형) 약관'), { title: '무배당 암진단특약(갱신형) 약관', kind: '특별약관' });
  assert.equal(sectionTitle('【별표 1】 장해분류표').kind, '별표');
  assert.equal(sectionTitle('이 특약은 주계약에 부가하여 체결합니다.'), null);
  assert.equal(sectionTitle('제3조(보험금의 지급사유)'), null);
});

test('인쇄 쪽번호는 앞뒤 쪽과 차이가 맞을 때만 인정한다', () => {
  assert.deepEqual(resolvePrintedPages([[], [1], [2], [7], [4]]), [null, 1, 2, null, 4]);
  assert.deepEqual(resolvePrintedPages([[5], [], [], [], [], [9]]), [null, null, null, null, null, null]);
});

test('트리: 상위 체크는 하위 전체 선택·해제, 일부 선택은 부분 상태', () => {
  const covs = [
    { id: 'a', name: '사망보험금', category: '사망', group: '보통약관' },
    { id: 'b', name: '재해사망보험금', category: '사망', group: '재해사망특약' },
    { id: 'c', name: '암진단보험금', category: '진단', group: '암특약' },
    { id: 'd', name: '오탐', category: '기타', group: 'x', excluded: true },
  ];
  const tree = T.build(['사망', '장해', '진단', '입원', '치료', '기타'], covs);
  assert.deepEqual(tree.map((c) => c.count), [2, 0, 1, 0, 0, 0]);
  const deathIds = T.idsOfCategory(tree[0]);
  let sel = T.toggle(deathIds, new Set());
  assert.equal(T.state(deathIds, sel), 'all');
  sel.delete('b');
  assert.equal(T.state(deathIds, sel), 'some');
  sel = T.toggle(deathIds, sel); // 부분 상태에서 누르면 모두 선택
  assert.equal(T.state(deathIds, sel), 'all');
  sel = T.toggle(deathIds, sel);
  assert.equal(T.state(deathIds, sel), 'none');
  assert.equal(T.build(['사망'], covs, '재해')[0].count, 1);
});

test('사용자 수정(이름·이동·제외·추가)을 자동 결과에 덧씌운다', () => {
  const base = [{ id: 'S001#1', name: '사망보험금', category: '사망', group: '보통약관' }];
  const merged = applyOverrides(base, {
    edits: { 'S001#1': { name: '일반사망보험금', category: '기타', group: '수동' } },
    added: [{ id: 'U1', name: '추가담보', category: '치료', group: '직접 추가' }],
  });
  assert.equal(merged[0].name, '일반사망보험금');
  assert.equal(merged[0].category, '기타');
  assert.deepEqual(merged[0].auto, { name: '사망보험금', category: '사망', group: '보통약관', reason: undefined });
  assert.match(merged[0].reason, /^사용자가 기타 › 수동\(으\)로 옮겼습니다/);
  assert.equal(merged[1].manual, true);
});

test('서버: 업로드 → 진행률 → 결과 → 수정 저장 → 같은 PDF 재업로드 시 캐시 사용', async () => {
  const app = require('../server/index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = fs.readFileSync(SAMPLE);
    const up = await (await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'X-File-Name': encodeURIComponent('샘플 약관.pdf') }, body })).json();
    assert.equal(up.cached, false);
    assert.match(up.id, /^[a-f0-9]{64}$/);

    // SSE 를 끝까지 읽어 마지막 단계가 done 인지 확인합니다.
    const sse = await (await fetch(`${base}/api/docs/${up.id}/events`)).text();
    const events = sse.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, '')));
    assert.equal(events[events.length - 1].stage, 'done', sse.slice(-300));

    const doc = await (await fetch(`${base}/api/docs/${up.id}`)).json();
    assert.equal(doc.meta.numPages, expected.totalPages);
    assert.equal(doc.coverages.length, expected.coverages.length);
    assert.ok(doc.meta.warnings.some((w) => w.type === 'ocr' && w.pages.includes(expected.scannedPdfPage)));

    const target = doc.coverages[0];
    const put = await fetch(`${base}/api/docs/${up.id}/review`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits: { [target.id]: { name: '고친 이름', category: '기타', group: '옮긴 그룹' } }, added: [{ id: 'U1', name: '직접 담보', category: '치료' }], selected: [target.id, 'U1'] }),
    });
    assert.equal(put.status, 200);
    const again = await (await fetch(`${base}/api/docs/${up.id}`)).json();
    const edited = again.coverages.find((c) => c.id === target.id);
    assert.equal(edited.name, '고친 이름');
    assert.equal(edited.group, '옮긴 그룹');
    assert.ok(again.coverages.some((c) => c.id === 'U1' && c.manual));
    assert.deepEqual(again.review.selected, [target.id, 'U1']);

    const up2 = await (await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'X-File-Name': 'renamed.pdf' }, body })).json();
    assert.deepEqual(up2, { id: up.id, cached: true });

    const bad = await fetch(`${base}/api/upload`, { method: 'POST', body: Buffer.from('not a pdf') });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/api/docs/../../etc`)).status, 404);
    assert.equal((await fetch(`${base}/api/docs/abc`)).status, 400);
  } finally {
    server.close();
  }
});

test('목차·쪽번호가 없고 제목에 꼬리표가 붙은 약관도 구간과 담보를 찾는다', async () => {
  const { pages: p2 } = await extractPdf(fs.readFileSync(path.join(__dirname, 'fixtures', 'no-toc-policy.pdf')));
  const t2 = findToc(p2);
  assert.deepEqual(t2.tocPages, []);
  const s2 = bodyStream(p2, []);
  const secs = splitSections(s2);
  assert.deepEqual(secs.map((s) => s.title), ['(무)더미안심갱신정기보험 보통보험약관', '수술비보장 특별약관', '암진단 특별약관', '별표4 수술분류표']);
  const covs = extractCoverages(secs, s2, p2).map((c) => `${c.category}:${c.name}`);
  assert.deepEqual(covs, ['사망:사망보험금', '사망:재해사망보험금', '사망:교통재해사망보험금', '장해:고도장해보험금', '치료:수술보험금', '진단:암진단보험금']);
});

test('실제 약관 변형 형식: 2단 편집·【】 조문·괄호 없는 조문·번호 붙은 특약 제목·지급기준표 별표', async () => {
  const { pages: p3 } = await extractPdf(fs.readFileSync(path.join(__dirname, 'fixtures', 'variant-policy.pdf')));
  assert.ok(p3.every((p) => p.columns === 2), '모든 쪽을 2단으로 읽어야 합니다');
  // 2단을 왼쪽 단부터 읽으므로 조문 제목 다음 줄이 그 조문의 본문입니다.
  const first = p3[0].lines.map((l) => l.t);
  assert.ok(first[first.indexOf('제2조【보험금의 지급사유】') + 1].startsWith('회사는 피보험자에게'));
  const s3 = bodyStream(p3, findToc(p3).tocPages);
  const secs = splitSections(s3);
  assert.deepEqual(secs.map((s) => `${s.kind}:${s.title}`), ['보통약관:무배당 변형건강보험 보통약관', '특별약관:무배당 암진단특약 약관', '별표:별표1 보험금 지급기준표', '특별약관:무배당 질병입원특약 약관']);
  assert.ok(secs[1].articles.some((a) => a.no === 2 && a.title === '보험금의 지급사유'));
  const covs = extractCoverages(secs, s3, p3);
  assert.deepEqual(covs.map((c) => `${c.group}/${c.name}/${c.category}`), [
    '무배당 변형건강보험 보통약관/사망보험금/사망',
    '무배당 암진단특약 약관/암진단보험금/진단',
    '무배당 암진단특약 약관/유사암진단보험금/진단',
    '무배당 질병입원특약 약관/질병입원급여금/입원',
  ]);
  assert.match(covs[1].reason, /별표1 보험금 지급기준표에서 찾았습니다/);
});

test('1단 쪽(목차·표·본문)은 2단으로 잘못 읽지 않는다', () => {
  assert.ok(pages.every((p) => (p.columns || 1) === 1));
});

test('조문 제목 형식 변형을 읽고 본문 문장은 제목으로 보지 않는다', () => {
  const { parseArticle } = require('../server/pdf/toc');
  assert.deepEqual(parseArticle('제3조【보험금의 지급사유】'), { no: 3, sub: null, title: '보험금의 지급사유' });
  assert.deepEqual(parseArticle('제 3 조 [보험금의 지급]'), { no: 3, sub: null, title: '보험금의 지급' });
  assert.deepEqual(parseArticle('제3조의2「특칙」'), { no: 3, sub: 2, title: '특칙' });
  assert.deepEqual(parseArticle('제1조 목적'), { no: 1, sub: null, title: '목적' });
  assert.equal(parseArticle('제3조 제1항에 따라 지급합니다.'), null);
  assert.equal(parseArticle('제3조 제1항의 보험금'), null);
  assert.equal(parseArticle('제3조에서 정한 보험금을'), null);
});

test('서버: 읽기 규칙이 바뀐 문서는 열 때 다시 분석하고, 직접 고친 내용을 새 담보로 옮긴다', async () => {
  const store = require('../server/store');
  const app = require('../server/index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const up = await (await fetch(`${base}/api/upload`, { method: 'POST', body: fs.readFileSync(path.join(__dirname, 'fixtures', 'no-toc-policy.pdf')) })).json();
    await (await fetch(`${base}/api/docs/${up.id}/events`)).text();
    const doc = await (await fetch(`${base}/api/docs/${up.id}`)).json();
    const surgery = doc.coverages.find((c) => c.name === '수술보험금');
    await fetch(`${base}/api/docs/${up.id}/review`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ edits: { [surgery.id]: { name: '수술비(고침)' } }, selected: [surgery.id] }) });
    // 옛 규칙으로 분석한 것처럼 만들고, 담보 ID 도 옛 번호로 바꿔 둡니다.
    const meta = store.readCache(up.id, 'meta');
    store.writeCache(up.id, 'meta', { ...meta, version: 'structure-0' });
    const old = store.readCache(up.id, 'coverages').map((c) => ({ ...c, id: `OLD-${c.id}` }));
    store.writeCache(up.id, 'coverages', old);
    const review = store.readReview(up.id);
    store.writeReview(up.id, { ...review, edits: { [`OLD-${surgery.id}`]: { name: '수술비(고침)' } }, selected: [`OLD-${surgery.id}`] });

    const stale = await fetch(`${base}/api/docs/${up.id}`);
    assert.equal(stale.status, 409);
    await (await fetch(`${base}/api/docs/${up.id}/events`)).text();
    const fresh = await (await fetch(`${base}/api/docs/${up.id}`)).json();
    const moved = fresh.coverages.find((c) => c.id === surgery.id);
    assert.equal(moved.name, '수술비(고침)');
    assert.deepEqual(fresh.review.selected, [surgery.id]);

    const page = await (await fetch(`${base}/api/docs/${up.id}/pages/1`)).json();
    assert.equal(page.n, 1);
    assert.ok(page.lines.some((l) => l.t.startsWith('제1조(목적)')));
    assert.equal((await fetch(`${base}/api/docs/${up.id}/pages/99`)).status, 404);
  } finally {
    server.close();
  }
});

test('목차 활용: 본문 제목을 못 읽은 특약은 목차로 이름을 붙이고, 목차에만 있는 특약은 "목차 추정" 후보로 올린다', async () => {
  const { analyzeStructure } = require('../server/analyze/pipeline');
  const { pages: p4 } = await extractPdf(fs.readFileSync(path.join(__dirname, 'fixtures', 'toc-variant-policy.pdf')));
  const { structure, coverages: covs, meta } = analyzeStructure(p4);
  assert.deepEqual(structure.sections.map((s) => s.title), ['무배당 목차건강보험 보통약관', '무배당 암진단특약', '무배당 뇌출혈진단특약', '무배당 골절치료특약', '수술 보장 안내']);
  assert.ok(!structure.sections.some((s) => s.guessed), '제목 미확인 구간이 남으면 안 됩니다');
  assert.deepEqual(covs.filter((c) => !c.fromToc).map((c) => `${c.group}/${c.name}`), [
    '무배당 목차건강보험 보통약관/사망보험금', '무배당 암진단특약/암진단보험금', '무배당 뇌출혈진단특약/뇌출혈진단보험금',
    '무배당 골절치료특약/골절치료보험금', '수술 보장 안내/수술보험금',
  ]);
  const tocOnly = covs.filter((c) => c.fromToc);
  assert.deepEqual(tocOnly.map((c) => c.name), ['무배당 수술특약', '무배당 화상진단특약']);
  assert.equal(tocOnly[0].sectionId, null);
  assert.match(tocOnly[1].reason, /목차에만 있고/);
  assert.ok(meta.warnings.some((w) => w.type === 'toc-only'));
});

test('장식 기호·번호·꼬리표가 붙은 약관 제목을 읽는다', () => {
  assert.equal(sectionTitle('◆ 무배당 뇌출혈진단특약 ◆').title, '무배당 뇌출혈진단특약');
  assert.equal(sectionTitle('(3) 무배당 암진단특약Ⅱ').title, '무배당 암진단특약Ⅱ');
  assert.equal(sectionTitle('상해사망 담보').kind, '특별약관');
  assert.equal(sectionTitle('■ 무배당 질병입원특약(갱신형) 약관 ■').title, '무배당 질병입원특약(갱신형) 약관');
});

test('목차 쪽 직접 지정: 쪽번호 없는 목차도 읽고, 목차에 나열된 담보 이름을 그 특약의 담보 후보로 올린다', async () => {
  const { analyzeStructure } = require('../server/analyze/pipeline');
  const { pages: p5 } = await extractPdf(fs.readFileSync(path.join(__dirname, 'fixtures', 'toc-listed-policy.pdf')));
  const auto = analyzeStructure(p5);
  assert.deepEqual(auto.structure.tocPages, []);
  assert.ok(auto.meta.warnings.some((w) => w.type === 'toc' && /직접 지정/.test(w.message)));
  const forced = analyzeStructure(p5, () => {}, { tocPages: [7, 8] });
  assert.equal(forced.meta.tocForced, true);
  const cand = forced.coverages.filter((c) => c.fromToc);
  assert.deepEqual(cand.map((c) => `${c.group}/${c.name}/${c.category}`), [
    '무배당 암보장특약/암진단비(유사암 제외)/진단', '무배당 암보장특약/유사암진단비/진단', '무배당 뇌질환보장특약/뇌졸중진단비/진단',
  ]);
  assert.ok(cand.every((c) => c.sectionId), '목차에서 바로 앞 특약이 본문과 연결돼 있으면 정의 약관이 정해져야 합니다');
  // 본문에 이미 있는 담보(뇌출혈진단비·골절수술비)는 중복으로 올리지 않습니다.
  assert.equal(forced.coverages.filter((c) => c.name === '뇌출혈진단비').length, 1);
  assert.ok(forced.structure.tocAll.find((e) => e.title === '뇌출혈진단비').coverageFound);
});

test('서버: 목차 쪽 지정 → 저장된 추출 결과로 다시 분석 → 자동 찾기로 되돌리기', async () => {
  const app = require('../server/index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const up = await (await fetch(`${base}/api/upload`, { method: 'POST', body: fs.readFileSync(path.join(__dirname, 'fixtures', 'toc-listed-policy.pdf')) })).json();
    await (await fetch(`${base}/api/docs/${up.id}/events`)).text();
    let doc = await (await fetch(`${base}/api/docs/${up.id}`)).json();
    assert.equal(doc.coverages.length, 4);
    assert.equal((await post(`/api/docs/${up.id}/toc`, { from: 9, to: 99 })).status, 400);
    assert.equal((await post(`/api/docs/${up.id}/toc`, { from: 7, to: 8 })).status, 200);
    await (await fetch(`${base}/api/docs/${up.id}/events`)).text();
    doc = await (await fetch(`${base}/api/docs/${up.id}`)).json();
    assert.equal(doc.coverages.length, 7);
    assert.deepEqual(doc.meta.tocRange, { from: 7, to: 8 });
    assert.ok(doc.tocAll.length >= 9);
    await post(`/api/docs/${up.id}/toc`, { clear: true });
    await (await fetch(`${base}/api/docs/${up.id}/events`)).text();
    doc = await (await fetch(`${base}/api/docs/${up.id}`)).json();
    assert.equal(doc.coverages.length, 4);
    assert.equal(doc.meta.tocRange, null);
  } finally {
    server.close();
  }
});

test('띄어 쓴 담보명·표 안의 담보명·줄 끝에서 낱말 중간이 끊긴 담보명을 찾는다', async () => {
  const { analyzeStructure } = require('../server/analyze/pipeline');
  const { findBenefits } = require('../server/analyze/classify');
  const { pages: p6 } = await extractPdf(fs.readFileSync(path.join(__dirname, 'fixtures', 'spaced-names-policy.pdf')));
  const { coverages: covs } = analyzeStructure(p6);
  assert.deepEqual(covs.map((c) => `${c.name}/${c.category}`), ['뇌졸중 진단비/진단', '뇌혈관질환진단비/진단', '대상포진 진단비/진단', '뇌동맥류 진단비/진단']);
  // 문장 속 낱말은 이름에 붙이지 않습니다.
  assert.deepEqual(findBenefits('회사는 다음의 암 진단비(유사암 제외)를 지급합니다.'), ['암 진단비(유사암 제외)']);
  assert.deepEqual(findBenefits('회사는 매년 생활자금을 지급합니다'), ['생활자금']);
  assert.deepEqual(findBenefits('입원일수 1일당 가입금액의 1%'), []);
  assert.deepEqual(findBenefits('회사는 약정한 보험금을 지급합니다. 해당 진단비를 지급합니다'), []);
  assert.deepEqual(findBenefits('고도장해보험금과 사망보험금을 지급합니다'), ['고도장해보험금', '사망보험금']);
});
