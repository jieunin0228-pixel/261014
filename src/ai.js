// 실제 약관(PDF) 분석 경로: 약관을 보통약관·특별약관·별표 단위로 나누고, 담보로 분석 대상을 고르고,
// Claude 에게 보낼 지시문을 만들고, 돌아온 행을 원문·코드표로 검증합니다.
// Claude 호출 자체는 화면(app.js)이 하고, 이 파일은 순수 함수만 둡니다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./schema'), require('./engine'));
  else root.EcsAi = factory(root.EcsSchema, root.EcsEngine);
})(typeof self !== 'undefined' ? self : this, function (S, E) {
  'use strict';

  // ───────────────────────── 약관 구간 분리 ─────────────────────────
  const SECTION_RE = /^[\s【\[<〈《]*([^\n]{0,60}?(?:보통보험약관|보통약관|특별약관|특약))\s*(?:약관)?[\s】\]>〉》]*$/;
  const APPENDIX_RE = /^[【\[]\s*별표\s*\d+\s*[】\]]\s*\S.{0,40}$/;
  const isBodyLine = (line) => /^(제\s*\d+\s*조|[①-⑳]|\d+\.|[가-하]\.)/.test(line) || /다\.$/.test(line);

  function sectionTitle(line) {
    if (isBodyLine(line) || line.length > 80) return null;
    if (APPENDIX_RE.test(line)) return { title: line, kind: '별표' };
    const m = line.replace(/\s*\[[^\]]*\]\s*$/, '').match(SECTION_RE);
    if (!m) return null;
    return { title: m[1].trim(), kind: /보통/.test(m[1]) ? '보통약관' : '특별약관' };
  }

  // 반환: [{ id, title, kind, text, articles }]. 조문이 없는 구간(목차 등)은 별표가 아니면 버립니다.
  function splitSections(text) {
    const sections = [];
    let cur = { title: '머리말', kind: '기타', lines: [] };
    const flush = () => { if (cur.lines.length) sections.push(cur); };
    for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim();
      const head = line && sectionTitle(line);
      if (head) { flush(); cur = { ...head, lines: [] }; continue; }
      cur.lines.push(raw);
    }
    flush();
    return sections
      .map((s) => ({ title: s.title, kind: s.kind, text: s.lines.join('\n').trim() }))
      .map((s) => ({ ...s, articles: E.splitClauses(s.text) }))
      .filter((s) => s.text && (s.articles.length || s.kind === '별표'))
      .map((s, i) => ({ id: i + 1, ...s }));
  }

  // ───────────────────────── 담보로 분석 대상 고르기 ─────────────────────────
  // query: "전체" 또는 "수술비, 암진단" 처럼 쉼표·공백으로 나눈 담보 키워드.
  // 키워드가 구간 제목 또는 지급사유 조문에 나오면 선택하고, 선택된 구간이 인용하는 [별표 N] 도 함께 고릅니다.
  function selectSections(sections, query) {
    const words = String(query || '').split(/[,\s]+/).map((w) => w.trim()).filter(Boolean);
    if (!words.length || words.includes('전체')) return sections.map((s) => s.id);
    const stems = words.map((w) => w.replace(/(보험금|특별약관|특약|보장|비)$/, '') || w);
    const hit = (s) => {
      const pay = s.articles.filter((a) => /지급사유/.test(a.title)).map((a) => E.paragraphText(a.paragraphs[0] || { text: '', items: [] })).join(' ');
      return stems.some((w) => s.title.includes(w) || pay.includes(w));
    };
    const chosen = sections.filter((s) => s.kind !== '별표' && hit(s));
    const refs = new Set(chosen.flatMap((s) => [...s.text.matchAll(/별표\s*(\d+)/g)].map((m) => m[1])));
    const appendices = sections.filter((s) => s.kind === '별표' && [...refs].some((n) => new RegExp(`별표\\s*${n}\\b`).test(s.title)));
    return [...chosen, ...appendices].map((s) => s.id);
  }

  // ───────────────────────── 코드표 ─────────────────────────
  // 코드표 엑셀의 시트·컬럼 규격. 시트 이름이나 컬럼 순서가 달라도 아래 이름이 들어 있으면 읽습니다.
  const MASTER_SHEETS = {
    claims: { sheet: '청구사유', cols: ['코드', '명칭'] },
    accidents: { sheet: '사고유형', cols: ['코드', '명칭'] },
    signGroups: { sheet: '사인그룹', cols: ['코드', '명칭', '설명'] },
    benefits: { sheet: '급부', cols: ['구보장급부코드', '구보장급부명', '위험급부코드', '위험급부명'] },
    statuses: { sheet: '계약상태', cols: ['코드', '명칭'] },
    variables: { sheet: '변수', cols: ['변수명', '설명'] },
  };

  // 화면 사진에서 확인한 일부 코드와 더미 코드. 실제 코드표를 올리면 대체됩니다.
  function defaultMaster() {
    return {
      source: '기본(더미) 코드표',
      claims: [{ code: 'S01', name: '사망' }, { code: 'S08', name: '장해' }, { code: 'S11', name: '수술' }, { code: 'S15', name: '진단' }],
      accidents: [{ code: 'G01', name: '일반' }, { code: 'B12', name: '일반재해' }, { code: 'B03', name: '교통재해' }],
      signGroups: Object.entries(S.SIGN_GROUPS).map(([code, g]) => ({ code, name: g.name, desc: (g.keywords || []).join(', ') })),
      benefits: [],
      statuses: Object.entries(S.STATUS).map(([name, code]) => ({ code, name })),
      variables: [...S.KNOWN_VARIABLES],
    };
  }

  // sheets: { 시트이름: [ {컬럼: 값} ] } (XLSX.utils.sheet_to_json 결과)
  function parseCodeMaster(sheets) {
    const names = Object.keys(sheets);
    const pick = (want) => names.find((n) => n.replace(/\s/g, '').includes(want));
    const master = { source: '업로드한 코드표', warnings: [] };
    for (const [key, spec] of Object.entries(MASTER_SHEETS)) {
      const name = pick(spec.sheet);
      const recs = name ? sheets[name] : [];
      if (!name) master.warnings.push(`'${spec.sheet}' 시트가 없습니다.`);
      const val = (r, col) => String(r[col] == null ? '' : r[col]).trim();
      if (key === 'variables') master.variables = recs.map((r) => val(r, '변수명')).filter(Boolean);
      else if (key === 'benefits') master.benefits = recs.map((r) => ({ code: val(r, '구보장급부코드'), name: val(r, '구보장급부명'), riskCode: val(r, '위험급부코드'), riskName: val(r, '위험급부명') })).filter((b) => b.code || b.name);
      else master[key] = recs.map((r) => ({ code: val(r, '코드'), name: val(r, '명칭'), desc: val(r, '설명') })).filter((c) => c.code);
    }
    return master;
  }

  // 코드표 템플릿(빈 양식 + 예시 1행). 반환: { 시트이름: [[헤더...], [예시...]] }
  function codeMasterTemplate() {
    const d = defaultMaster();
    return {
      청구사유: [MASTER_SHEETS.claims.cols, ...d.claims.map((c) => [c.code, c.name])],
      사고유형: [MASTER_SHEETS.accidents.cols, ...d.accidents.map((c) => [c.code, c.name])],
      사인그룹: [MASTER_SHEETS.signGroups.cols, ...d.signGroups.map((c) => [c.code, c.name, c.desc])],
      급부: [MASTER_SHEETS.benefits.cols, ['S01G010221', '기타사망보험금', '', '일반사망']],
      계약상태: [MASTER_SHEETS.statuses.cols, ...d.statuses.map((c) => [c.code, c.name])],
      변수: [MASTER_SHEETS.variables.cols, ...d.variables.map((v) => [v, ''])],
    };
  }

  function masterText(m) {
    const list = (arr, f) => (arr.length ? arr.map(f).join('\n') : '(없음)');
    return [
      `[청구사유]\n${list(m.claims, (c) => `${c.code} ${c.name}`)}`,
      `[사고유형]\n${list(m.accidents, (c) => `${c.code} ${c.name}`)}`,
      `[사인그룹]\n${list(m.signGroups, (c) => `${c.code} ${c.name}${c.desc ? ` (${c.desc})` : ''}`)}`,
      `[급부] 구보장급부코드 구보장급부명 / 위험급부코드 위험급부명\n${list(m.benefits, (b) => `${b.code} ${b.name} / ${b.riskCode} ${b.riskName}`)}`,
      `[계약상태]\n${list(m.statuses, (c) => `${c.code} ${c.name}`)}`,
      `[계산 변수]\n${m.variables.length ? m.variables.map((v) => `[${v}]`).join(' ') : '(없음)'}`,
    ].join('\n\n');
  }

  // ───────────────────────── Claude 지시문 ─────────────────────────
  const MAX_PROMPT_BYTES = 240000; // sample 입력 상한(256 KiB)보다 여유를 둡니다.
  const byteLength = (s) => new TextEncoder().encode(s).length;

  const OUTPUT_EXAMPLE = {
    rows: [{
      category: '감액', claim: '진단', claimCode: 'S15', accident: '일반', accidentCode: 'G01',
      benefit: '암진단보험금', benefitCode: '', riskBenefit: '암진단', riskBenefitCode: '',
      signGroup: '사인그룹|질병및일반', signGroupCode: 'T03',
      calcCondition: '경과기간<1년', calcTarget: '가입금액', formula: '[가입금액] * 0.5',
      status: '소멸', statusCode: '9',
      evidence: [{ ref: '제2조 제1항', quote: '다만, 계약일부터 1년 미만에 진단확정된 경우에는 가입금액의 50%를 지급합니다.' }],
      flags: [{ level: 'warn', reason: '1년 미만의 경계일 포함 여부가 문언상 불명확합니다.' }],
    }],
    manual: [{ subject: '심신상실 상태의 자해', ref: '제3조 제1항 제1호', quote: '피보험자가 심신상실 등으로 자유로운 의사결정을 할 수 없는 상태에서 자신을 해친 경우', reason: '대응 사인그룹 코드가 없습니다.' }],
    missing: [{ subject: '입원보험금', reason: '지급금액 조항을 찾지 못했습니다.' }],
  };

  function instructions(coverage, master) {
    return `당신은 생명보험 보험금 심사 시스템(ECS)의 룰 테이블을 만드는 심사 실무자입니다.
아래 [약관]을 읽고, 담보 "${coverage || '전체'}"에 해당하는 급부만 ECS 룰 행으로 변환하십시오. "전체"이면 [약관]의 모든 급부를 변환합니다.

[변환 규칙]
1. 급부마다 사고유형(코드표의 사고유형)별로 각각 한 행을 만듭니다. 질병·재해 등 원인이 나뉘면 원인별로 행을 나눕니다.
2. 경과기간 등 기간 조건에 따라 금액이 달라지면 조건별로 행을 나눕니다. 예: 1년 이내 50% → calcCondition "경과기간<=1년", formula "[가입금액] * 0.5" / 1년 초과 → "경과기간>1년", "[가입금액]". 조건이 여럿이면 " AND "로 잇고, 조건이 없으면 "-"로 씁니다.
3. 면책(지급하지 않음) 대상은 category "면책", formula "[가입금액] * 0"으로 씁니다.
4. 갱신형이면 "계약구분=최초"와 "계약구분=갱신" 행을 나눕니다. 갱신계약에 가입금액과 기납입보험료 중 큰 금액을 지급한다는 문언이 있으면 "Math.max([가입금액], [기납입보험료])"를 씁니다.
5. 코드표의 사인그룹 중 어느 것에도 대응하지 않는 사유(예: 심신상실, 수익자 고의, 출산 등 사인코드로 구분할 수 없는 사유)는 rows에 넣지 말고 manual에 넣습니다.
6. 모든 행의 evidence에 근거 조항(ref, 예: "제2조 제1항")과 원문(quote)을 붙입니다. quote는 [약관] 원문의 한 문장 이상을 글자 그대로 복사합니다. 요약·말바꿈·생략 부호를 쓰지 마십시오. 근거 조항을 찾지 못한 급부는 행을 만들지 말고 missing에 넣습니다.
7. 약관 문언만으로 확정할 수 없는 사항은 임의로 판단하지 말고 flags에 {"level":"warn","reason":"사유"}로 적습니다. 다른 약관(보통약관 등)을 준용한다는 문언이 있어 이 [약관]만으로 확정할 수 없는 사항도 같습니다.
8. 금액 오산출 위험이 큰 행(경계일, Math.max, 코드표 변수 목록에 없는 신규 변수)은 {"level":"red","reason":"...","test":"테스트 시나리오"}, 매핑·중복 점검이 필요한 행은 {"level":"yellow",...}로 표시합니다.

[작성 규칙]
- category는 "정상", "감액", "면책" 중 하나입니다. status는 계약상태 코드표의 명칭을 씁니다.
- 코드는 아래 코드표에 있는 값만 씁니다. 대응하는 코드가 없으면 빈 문자열("")로 두고 flags에 warn으로 적습니다. 코드를 지어내지 마십시오.
- formula의 변수는 [변수명] 형식이며, 가입금액 비율은 "[가입금액] * 0.1"처럼 소수로 씁니다.
- 수술 종류·진단 종류처럼 금액이 달라지는 구분이 있으면 구분별로 행을 나누고 calcCondition에 "수술종류=1종"처럼 적습니다.

[코드표: ${master.source}]
${masterText(master)}

[출력 형식]
설명 없이 아래 형태의 JSON 객체 하나만 답하십시오.
${JSON.stringify(OUTPUT_EXAMPLE)}`;
  }

  function articleText(a) {
    return [`제${a.no}조(${a.title})`, ...a.paragraphs.map((p) => {
      const lead = p.no == null ? '' : `${String.fromCharCode(0x245f + p.no)} `;
      return lead + E.paragraphText(p);
    })].join('\n');
  }

  // 분석 호출 계획. 구간이 너무 크면 조문 단위로 잘라 여러 번 호출합니다.
  // 반환: [{ label, sectionId, sectionTitle, prompt, text }]
  function planCalls(sections, selectedIds, coverage, master) {
    const chosen = sections.filter((s) => selectedIds.includes(s.id));
    const appendices = chosen.filter((s) => s.kind === '별표');
    const head = instructions(coverage, master);
    const calls = [];
    for (const s of chosen.filter((x) => x.kind !== '별표')) {
      const apx = appendices.filter((a) => [...s.text.matchAll(/별표\s*(\d+)/g)].some((m) => new RegExp(`별표\\s*${m[1]}\\b`).test(a.title)));
      const apxText = apx.map((a) => `\n\n### ${a.title}\n${a.text}`).join('');
      const make = (body, part) => {
        const text = `### ${s.title}\n${body}${apxText}`;
        return { label: part ? `${s.title} (${part})` : s.title, sectionId: s.id, sectionTitle: s.title, text, prompt: `${head}\n\n[약관]\n${text}` };
      };
      const whole = make(s.text);
      if (byteLength(whole.prompt) <= MAX_PROMPT_BYTES) { calls.push(whole); continue; }
      let buf = [], n = 1;
      const budget = MAX_PROMPT_BYTES - byteLength(make('').prompt);
      for (const a of s.articles) {
        const t = articleText(a);
        if (buf.length && byteLength([...buf, t].join('\n')) > budget) { calls.push(make(buf.join('\n'), `${n++}부`)); buf = []; }
        buf.push(t); // 한 조문이 상한을 넘으면 그 호출이 prompt_too_large 로 실패하고 화면에 표시됩니다.
      }
      if (buf.length) calls.push(make(buf.join('\n'), `${n}부`));
    }
    return calls;
  }

  // ───────────────────────── Claude 결과 검증 ─────────────────────────
  const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
  const CODE_FIELDS = [
    ['claimCode', 'claim', 'claims', '청구사유'],
    ['accidentCode', 'accident', 'accidents', '사고유형'],
    ['signGroupCode', 'signGroup', 'signGroups', '사인그룹'],
    ['statusCode', 'status', 'statuses', '계약상태'],
  ];
  const LEVELS = new Set(['red', 'yellow', 'warn']);

  // ai: Claude 가 돌려준 JSON. sourceText: 그 호출에 보낸 약관 원문(인용 검증 기준).
  // 반환: { rows, manual, missing } — 행은 engine 행과 같은 모양(evidence·flags 포함, 위험 표시 전)
  function verifyAiResult(ai, { sourceText, sectionTitle, master }) {
    const text = squash(sourceText);
    const out = { rows: [], manual: [], missing: [] };
    const inSource = (q) => squash(q).length >= 8 && text.includes(squash(q));
    const refOf = (ref) => `${sectionTitle} ${String(ref || '').trim()}`.trim();
    const str = (v) => String(v == null ? '' : v).trim();
    if (!ai || typeof ai !== 'object') {
      out.missing.push({ subject: sectionTitle, ref: '', reason: 'Claude 응답이 JSON 객체가 아닙니다.' });
      return out;
    }

    for (const r of Array.isArray(ai.rows) ? ai.rows : []) {
      const flags = (Array.isArray(r.flags) ? r.flags : [])
        .filter((f) => f && LEVELS.has(f.level) && f.reason)
        .map((f) => ({ level: f.level, reason: str(f.reason), ...(f.test ? { test: str(f.test) } : {}) }));
      const evidence = [];
      for (const e of Array.isArray(r.evidence) ? r.evidence : []) {
        if (e && inSource(e.quote)) evidence.push({ ref: refOf(e.ref), text: str(e.quote) });
        else if (e) flags.push({ level: 'warn', reason: `인용문이 약관 원문과 일치하지 않아 근거에서 뺐습니다: "${str(e.quote).slice(0, 60)}"` });
      }
      const row = {
        category: ['정상', '감액', '면책'].includes(str(r.category)) ? str(r.category) : '정상',
        claim: str(r.claim), claimCode: str(r.claimCode), accident: str(r.accident), accidentCode: str(r.accidentCode),
        benefit: str(r.benefit), benefitCode: str(r.benefitCode), riskBenefit: str(r.riskBenefit), riskBenefitCode: str(r.riskBenefitCode),
        signGroup: str(r.signGroup), signGroupCode: str(r.signGroupCode),
        calcCondition: str(r.calcCondition) || '-', calcTarget: str(r.calcTarget), formula: str(r.formula),
        status: str(r.status) || '확인필요', statusCode: str(r.statusCode), section: sectionTitle, evidence, flags,
      };
      if (!['정상', '감액', '면책'].includes(str(r.category))) flags.push({ level: 'warn', reason: `구분 값 "${str(r.category)}"을 알 수 없어 정상으로 두었습니다.` });

      // 규칙 6: 원문으로 확인된 근거가 없으면 행을 만들지 않습니다.
      if (!evidence.length) {
        out.missing.push({ subject: `${row.benefit} ${row.accident} ${row.calcCondition}`.trim(), ref: sectionTitle, reason: '인용한 원문을 약관에서 찾지 못해 행을 만들지 않았습니다.' });
        continue;
      }
      // 코드표 대조: 없는 코드는 비우고, 비어 있으면 명칭이 정확히 같은 코드로 채웁니다.
      for (const [codeKey, nameKey, listKey, label] of CODE_FIELDS) {
        const list = master[listKey] || [];
        if (row[codeKey] && !list.some((c) => c.code === row[codeKey])) {
          flags.push({ level: 'warn', reason: `${label} 코드 ${row[codeKey]}는 코드표에 없어 비웠습니다.` });
          row[codeKey] = '';
        }
        if (!row[codeKey]) {
          const byName = list.find((c) => c.name === row[nameKey]);
          if (byName) row[codeKey] = byName.code;
          else if (codeKey !== 'signGroupCode') flags.push({ level: 'warn', reason: `${label} "${row[nameKey]}"에 대응하는 코드가 코드표에 없습니다.` });
        }
      }
      if (master.benefits && master.benefits.length) {
        for (const [codeKey, field, label] of [['benefitCode', 'code', '구보장급부'], ['riskBenefitCode', 'riskCode', '위험급부']]) {
          if (row[codeKey] && !master.benefits.some((b) => b[field] === row[codeKey])) {
            flags.push({ level: 'warn', reason: `${label}코드 ${row[codeKey]}는 코드표에 없어 비웠습니다.` });
            row[codeKey] = '';
          }
        }
        const b = master.benefits.find((x) => x.name === row.benefit);
        if (b && !row.benefitCode) row.benefitCode = b.code;
        if (b && !row.riskBenefitCode && b.riskCode) row.riskBenefitCode = b.riskCode;
        if (!b && !row.benefitCode) flags.push({ level: 'warn', reason: `구보장급부 "${row.benefit}"이(가) 코드표에 없습니다.` });
      }
      // 규칙 5: 사인그룹 코드가 없으면 룰 행 대신 심사자 수기로 보냅니다.
      if (!row.signGroupCode) {
        out.manual.push({ subject: `${row.benefit} ${row.accident} ${row.calcCondition}`.trim(), ref: evidence[0].ref, text: evidence[0].text, reason: '사인그룹 코드표에 대응 코드가 없어 룰 행을 만들지 않았습니다.' });
        continue;
      }
      if (!/^[\s\[\]가-힣\w.*+\-/(),]+$/.test(row.formula) || (row.formula.match(/\[/g) || []).length !== (row.formula.match(/\]/g) || []).length) {
        flags.push({ level: 'red', reason: `상세계산식 "${row.formula}"의 형식이 올바르지 않습니다.`, test: 'ECS 계산식 검증 화면에서 산식이 오류 없이 해석되는지 확인합니다.' });
      }
      row.calcTarget = row.calcTarget || [...new Set([...row.formula.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]))].join(', ');
      out.rows.push(row);
    }

    for (const m of Array.isArray(ai.manual) ? ai.manual : []) {
      if (!m) continue;
      const ok = inSource(m.quote);
      out.manual.push({ subject: str(m.subject), ref: refOf(m.ref), text: str(m.quote), reason: str(m.reason) + (ok ? '' : ' (인용문이 원문과 일치하지 않습니다. 조항을 직접 확인하십시오.)') });
    }
    for (const m of Array.isArray(ai.missing) ? ai.missing : []) {
      if (m) out.missing.push({ subject: str(m.subject), ref: sectionTitle, reason: str(m.reason) });
    }
    return out;
  }

  // 여러 호출의 결과를 합치고 🔴/🟡 표시·행번호를 붙입니다.
  function finalize(parts, master) {
    const rows = parts.flatMap((p) => p.rows);
    E.markRisks(rows, master.variables);
    rows.forEach((r, i) => { r.no = i + 1; });
    return { rows, manual: parts.flatMap((p) => p.manual), missing: parts.flatMap((p) => p.missing) };
  }

  return {
    splitSections, selectSections, sectionTitle,
    MASTER_SHEETS, defaultMaster, parseCodeMaster, codeMasterTemplate,
    instructions, planCalls, verifyAiResult, finalize, MAX_PROMPT_BYTES,
  };
});
