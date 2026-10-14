// 1단계 분석의 순수 부분: 쪽별 추출 결과 → 목차·구간·담보·경고. 서버(jobs.js)와 브라우저(아티팩트)가 함께 씁니다.
const { findToc, bodyStream, splitSections, matchToc, locateTocEntries, cleanTitle, norm } = require('../pdf/toc');
const { extractCoverages, applyOverrides, categorize, CATEGORIES } = require('./classify');

// 추출 규칙을 고치면 이 값을 올립니다. 값이 다른 캐시는 다시 분석합니다(사용자 수정·검토 기록은 별도로 저장되어 유지됩니다).
const STRUCTURE_VERSION = 'structure-5';

// onStep(done, total, message) 로 진행 단계를 알립니다.
// options.tocPages: 사용자가 지정한 목차 쪽 번호 목록(없으면 자동으로 찾음)
function analyzeStructure(pages, onStep = () => {}, options = {}) {
  onStep(0, 3, '목차를 찾는 중입니다.');
  const toc = findToc(pages, { forcedPages: options.tocPages });
  const stream = bodyStream(pages, toc.tocPages);
  onStep(1, 3, '약관 구간을 나누는 중입니다.');
  let sections = splitSections(stream);
  let tocMatch = matchToc(sections, toc, pages);
  // 목차에는 있는데 본문 구간과 짝이 없는 약관은, 본문에서 그 제목 줄을 찾아 경계로 삼아 다시 나눕니다.
  if (tocMatch.missing.length) {
    const forced = locateTocEntries(tocMatch.missing, stream);
    if (forced.length) {
      sections = splitSections(stream, forced);
      tocMatch = matchToc(sections, toc, pages);
    }
  }
  onStep(2, 3, '담보를 찾아 분류하는 중입니다.');
  const coverages = extractCoverages(sections, stream, pages);
  // 목차에 담보 이름이 직접 나열된 경우(예: "암진단비"): 본문에서 찾은 담보와 이름이 겹치지 않으면 후보로 올립니다.
  // 바로 앞의 약관 항목이 본문 구간과 연결돼 있으면 그 약관을 정의 약관으로 둡니다.
  let lastTop = null;
  let tocCov = 0;
  for (const e of toc.entries) {
    if (e.level === '보통약관' || e.level === '특별약관') { lastTop = e; continue; }
    if (e.level !== '담보') continue;
    const name = cleanTitle(e.title).replace(/\s+/g, ' ');
    // 괄호 안 설명을 뺀 이름이 정확히 같을 때만 같은 담보로 봅니다("유사암진단비"와 "암진단비"는 다른 담보).
    const base = (n) => norm(String(n).replace(/[(（][^)）]*[)）]/g, ''));
    const k = base(name);
    if (coverages.some((c) => base(c.name) === k)) { e.coverageFound = true; continue; }
    const sec = lastTop && lastTop.sectionId ? sections.find((s) => s.id === lastTop.sectionId) : null;
    const c = categorize(name);
    tocCov += 1;
    coverages.push({
      id: `TC${tocCov}`, name, category: c.category, group: sec ? sec.title : (lastTop ? cleanTitle(lastTop.title) : '목차 담보'),
      sectionId: sec ? sec.id : null, sectionTitle: sec ? sec.title : null, fromToc: true, mentions: 0,
      reason: `${c.reason} (목차에 나열된 담보 이름이며 본문 지급사유에서는 확인되지 않았습니다. 본문을 확인해 주십시오.)`,
      evidence: { page: e.tocPage, printed: null, lineIndex: null, article: '목차', quote: `${e.title}${e.printed ? ` …… ${e.printed}` : ''}` },
    });
  }

  // 그래도 본문에서 찾지 못한 약관은 목차를 근거로 한 담보 후보로 올립니다(본문 근거가 없어 확인 필요).
  tocMatch.missing.filter((e) => !/별표/.test(e.title)).forEach((e, k) => {
    const name = cleanTitle(e.title);
    const c = categorize(name);
    coverages.push({
      id: `T${k + 1}`, name, category: c.category, group: name, sectionId: null, sectionTitle: null, fromToc: true, mentions: 0,
      reason: `${c.reason} (목차에만 있고 본문에서 이 약관을 찾지 못한 담보 후보입니다. 본문에 실제로 있는지 확인해 주십시오.)`,
      evidence: { page: e.tocPage, printed: null, lineIndex: null, article: '목차', quote: `${e.title} …… ${e.printed}` },
    });
  });

  const scannedPages = pages.filter((p) => p.scanned).map((p) => p.n);
  const warnings = [];
  if (scannedPages.length) {
    warnings.push({ type: 'ocr', message: `${scannedPages.length}개 쪽이 이미지(스캔)로 되어 있어 글자를 읽지 못했습니다. 이 쪽의 내용은 분석에서 빠지므로 OCR(글자 인식)을 거친 PDF를 다시 올려야 합니다.`, pages: scannedPages });
  }
  if (!toc.tocPages.length) warnings.push({ type: 'toc', message: '목차 쪽을 찾지 못해 본문의 약관 제목과 조문 번호만으로 구간을 나눴습니다. 담보가 적게 나오면 아래 [목차 인식 결과]에서 목차가 있는 쪽을 직접 지정해 주십시오.' });
  const missingTables = tocMatch.missing.filter((e) => /별표/.test(e.title));
  if (missingTables.length) {
    warnings.push({ type: 'toc-missing', message: `목차에는 있으나 본문에서 찾지 못한 별표가 ${missingTables.length}개 있습니다.`, items: missingTables });
  }
  const tocOnly = coverages.filter((c) => c.fromToc);
  if (tocOnly.length) {
    const noSection = tocOnly.filter((c) => !c.sectionId).length;
    warnings.push({ type: 'toc-only', message: `본문 지급사유에서는 확인되지 않고 목차에서만 확인되는 담보 ${tocOnly.length}개를 "목차 추정" 후보로 올렸습니다. 본문에 실제로 있는 담보인지 확인해 주십시오.${noSection ? ` 이 가운데 정의 약관이 정해지지 않은 ${noSection}개는 담보 분석(2단계) 전에 [편집]에서 정의 약관을 지정해 주십시오.` : ''}`, items: tocOnly.map((c) => ({ title: c.sectionTitle ? `${c.name} — ${c.sectionTitle}` : c.name })) });
  }
  const titledByToc = sections.filter((s) => s.titledByToc || s.fromToc).length;
  const guessed = sections.filter((s) => s.guessed);
  if (guessed.length) warnings.push({ type: 'title', message: `제목을 확인하지 못한 구간이 ${guessed.length}개 있습니다. 담보 편집에서 중분류 이름을 고쳐 주십시오.`, items: guessed.map((s) => ({ title: s.title, pdfPage: s.startPage })) });

  const articleCount = sections.reduce((n, x) => n + x.articles.length, 0);
  if (!articleCount && pages.some((p) => !p.scanned && !p.blank)) {
    warnings.push({ type: 'no-article', message: '조문 제목(예: 제1조(목적))을 하나도 찾지 못해 담보를 나눌 수 없었습니다. 아래 [PDF 글자 확인]에서 조문이 시작하는 쪽을 열어, 조문 제목 줄이 어떤 모양으로 읽히는지 알려 주십시오.' });
  }
  const titleOnly = coverages.filter((c) => c.fromTitle);
  if (titleOnly.length) {
    warnings.push({ type: 'title-only', message: `보험금 이름을 찾지 못해 약관 제목을 담보명으로 대신 쓴 약관이 ${titleOnly.length}개 있습니다. 이 약관의 지급사유 조문에서 보험금 이름이 어떻게 적혀 있는지 확인해 주십시오.`, items: titleOnly.map((c) => ({ title: c.name, pdfPage: c.evidence && c.evidence.page })) });
  }

  const meta = {
    version: STRUCTURE_VERSION, numPages: pages.length, textPages: pages.filter((p) => !p.scanned && !p.blank).length, scannedPages,
    printedPagesFound: pages.filter((p) => p.printed != null).length,
    sectionCount: sections.filter((s) => s.kind !== '별표').length, appendixCount: sections.filter((s) => s.kind === '별표').length,
    coverageCount: coverages.length, tocEntryCount: toc.entries.filter((e) => e.level === '보통약관' || e.level === '특별약관').length, titledByToc, articleCount, twoColumnPages: pages.filter((p) => p.columns === 2).length, warnings,
  };
  const tocAll = toc.entries.map((e) => ({ title: e.title, printed: e.printed, level: e.level, tocPage: e.tocPage, sectionId: e.sectionId || null, coverageFound: !!e.coverageFound }));
  return { meta: { ...meta, tocPages: toc.tocPages, tocForced: !!toc.forced }, structure: { tocPages: toc.tocPages, toc: tocMatch.entries, tocAll, sections }, coverages };
}

// 화면에 보낼 문서 묶음(사용자 수정 반영)
function docView(meta, structure, coverages, review = {}) {
  const sections = structure.sections.map(({ id, title, kind, appendixNo, startPage, endPage, articles, toc, guessed }) => ({
    id, title, kind, appendixNo, startPage, endPage, guessed, articleCount: articles.length, toc,
  }));
  return { meta, categories: CATEGORIES, sections, tocAll: structure.tocAll || [], coverages: applyOverrides(coverages, review), review };
}

module.exports = { STRUCTURE_VERSION, analyzeStructure, docView };
