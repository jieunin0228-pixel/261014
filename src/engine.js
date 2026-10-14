// 약관 텍스트 → 조항 구조 → 사망 급부 추출 → ECS 룰 행 생성.
// 브라우저(window.EcsEngine)와 Node(require) 양쪽에서 씁니다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./schema'));
  else root.EcsEngine = factory(root.EcsSchema);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  // ───────────────────────── 조항 분리 ─────────────────────────
  const ARTICLE_RE = /^제\s*(\d+)\s*조(?:의\s*(\d+))?\s*[(（]([^)）]*)[)）]\s*(.*)$/;
  const PARA_RE = /^([①-⑳])\s*(.*)$/; // ①~⑳
  const ITEM_RE = /^(\d+)\.\s*(.*)$/;
  const SUBITEM_RE = /^([가-하])\.\s*(.*)$/;

  // 반환: [{ no, title, paragraphs: [{ no, text, items: [{ no, text, subitems: [{ no, text }] }] }] }]
  // ①이 없는 조문은 no=null 인 묵시적 항 하나로 둡니다(인용 시 "제N조"만 표기).
  function splitClauses(text) {
    const articles = [];
    let art = null, para = null, item = null, sub = null;
    const append = (unit, line) => { unit.text = unit.text ? `${unit.text} ${line}` : line; };

    for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let m;
      if ((m = line.match(ARTICLE_RE))) {
        art = { no: m[2] ? `${m[1]}의${m[2]}` : m[1], title: m[3].trim(), paragraphs: [] };
        articles.push(art);
        para = item = sub = null;
        if (m[4]) { para = { no: null, text: m[4], items: [] }; art.paragraphs.push(para); }
        continue;
      }
      if (!art) continue; // 첫 조문 앞의 표제 등은 버립니다.
      if ((m = line.match(PARA_RE))) {
        para = { no: m[1].charCodeAt(0) - 0x245f, text: m[2], items: [] };
        art.paragraphs.push(para);
        item = sub = null;
      } else if (para && (m = line.match(ITEM_RE))) {
        item = { no: Number(m[1]), text: m[2], subitems: [] };
        para.items.push(item);
        sub = null;
      } else if (item && (m = line.match(SUBITEM_RE))) {
        sub = { no: m[1], text: m[2] };
        item.subitems.push(sub);
      } else {
        if (!para) { para = { no: null, text: '', items: [] }; art.paragraphs.push(para); }
        append(sub || item || para, line);
      }
    }
    return articles;
  }

  function cite(art, para, item, sub) {
    let s = `제${art.no}조`;
    if (para && para.no != null) s += ` 제${para.no}항`;
    if (item) s += ` 제${item.no}호`;
    if (sub) s += ` ${sub.no}목`;
    return s;
  }

  // 항 단위 원문(호·목 포함)을 한 덩어리 문자열로 만듭니다.
  function paragraphText(para) {
    const parts = [para.text];
    for (const it of para.items) {
      parts.push(`${it.no}. ${it.text}`);
      for (const s of it.subitems) parts.push(`${s.no}. ${s.text}`);
    }
    return parts.filter(Boolean).join(' ');
  }

  // 조항 단위로 평탄화: 각 원소는 { ref, text, art, para, item, sub }
  function flatten(articles) {
    const out = [];
    for (const art of articles) for (const para of art.paragraphs) {
      out.push({ ref: cite(art, para), text: para.text, art, para });
      for (const item of para.items) {
        out.push({ ref: cite(art, para, item), text: item.text, art, para, item });
        for (const sub of item.subitems) out.push({ ref: cite(art, para, item, sub), text: sub.text, art, para, item, sub });
      }
    }
    return out;
  }

  const findArticle = (articles, re) => articles.find((a) => re.test(a.title));

  // 급부명이 다른 급부명의 일부로 들어간 경우("재해사망보험금" 안의 "사망보험금")를 배제합니다.
  function mentions(text, name) {
    return new RegExp(`(^|[^가-힣])${name}`).test(text);
  }

  // ───────────────────────── 사망 급부 추출 ─────────────────────────
  // scope: 지급사유 문언에서 읽은 원인 범위 → 사고유형 목록
  const SCOPE_ACCIDENTS = {
    전체: ['일반', '일반재해', '교통재해'],
    재해: ['일반재해', '교통재해'],
    교통재해: ['교통재해'],
    재해이외: ['일반'],
  };

  function scopeOf(condition) {
    if (/교통재해로/.test(condition)) return '교통재해';
    if (/재해\s*이외|질병으로/.test(condition)) return '재해이외';
    if (/재해로/.test(condition)) return '재해';
    return '전체';
  }

  // 반환: { benefits: [...], missing: [...] }
  function extractDeathBenefits(articles) {
    const art = findArticle(articles, /지급사유/);
    if (!art) return { benefits: [], missing: [{ subject: '보험금 지급사유', reason: '"지급사유" 조문을 찾지 못했습니다.' }] };
    const benefits = [];
    for (const para of art.paragraphs) for (const item of para.items) {
      const m = item.text.match(/^(.*?)[:：]\s*([^\s:：]+보험금)\s*$/);
      if (!m || !/사망/.test(m[1])) continue;
      const scope = scopeOf(m[1]);
      benefits.push({
        name: m[2],
        scope,
        accidents: SCOPE_ACCIDENTS[scope],
        ref: cite(art, para, item),
        excerpt: item.text,
        loc: { art: art.no, para: para.no, item: item.no },
      });
    }
    return { benefits, missing: [] };
  }

  // ───────────────────────── 금액·갱신·면책·소멸 조항 추출 ─────────────────────────
  const sentences = (text) => String(text).split(/(?<=다\.)\s+/).filter(Boolean);
  const unit = (ref, text) => ({ ref, text });

  // 급부별 지급금액: 기본 지급률과 경과기간 감액(단서)
  function extractAmount(articles, benefit) {
    const byCite = `제${benefit.loc.art}조 제${benefit.loc.para}항 제${benefit.loc.item}호의 ${benefit.name}`;
    for (const art of articles) for (const para of art.paragraphs) {
      const sents = sentences(para.text);
      const i = sents.findIndex((s) => (s.includes(byCite) || mentions(s, benefit.name)) && /가입금액의\s*\d/.test(s));
      if (i < 0) continue;
      const pct = sents[i].match(/가입금액의\s*(\d+(?:\.\d+)?)\s*%/);
      const result = { mult: Number(pct[1]) / 100, ...unit(cite(art, para), para.text) };
      for (const s of sents.slice(i + 1)) {
        const r = s.match(/^다만,?\s*(재해\s*이외의\s*원인으로)?.*?(계약일|보장개시일)부터\s*(\d+)\s*년\s*이내에?.*?가입금액의\s*(\d+(?:\.\d+)?)\s*%/);
        if (r) result.reduction = {
          years: Number(r[3]), mult: Number(r[4]) / 100, basis: r[2],
          accidents: r[1] ? ['일반'] : benefit.accidents, ...unit(`${cite(art, para)} 단서`, s),
        };
      }
      return result;
    }
    return null;
  }

  function extractRenewal(articles, units) {
    const art = findArticle(articles, /갱신/);
    if (!art) return null;
    const max = units.find((u) => /갱신계약/.test(u.text) && /가입금액과\s*기납입보험료\s*중\s*큰\s*금액/.test(u.text));
    const initialOnly = units.find((u) => /최초계약에만\s*적용/.test(u.text));
    return {
      article: unit(`제${art.no}조`, art.title),
      max: max && { ...unit(max.ref, max.text) },
      initialOnly: initialOnly && unit(initialOnly.ref, initialOnly.text),
    };
  }

  function matchSignGroup(text) {
    for (const [code, g] of Object.entries(S.SIGN_GROUPS)) {
      if (g.keywords && g.keywords.some((k) => text.includes(k))) return code;
    }
    return null;
  }

  function manualReason(text) {
    if (/심신상실|의사결정/.test(text)) return '사인그룹 없음: 심신상실 등 의사결정능력 여부는 사인코드로 판정할 수 없습니다.';
    if (/수익자가\s*고의/.test(text)) return '사인그룹 없음: 고의 행위 주체(보험수익자)와 일부 수익자 여부는 사인코드로 구분할 수 없습니다.';
    if (/계약자가\s*고의/.test(text)) return '사인그룹 없음: 고의 행위 주체(계약자)는 사인코드로 구분할 수 없습니다.';
    if (/실종선고/.test(text)) return '사인그룹 없음: 사망 간주일(실종기간 만료일)을 기준으로 경과기간·면책기간을 수기 확인해야 합니다.';
    return '사인그룹 마스터에 대응 코드가 없어 룰 행을 만들 수 없습니다.';
  }

  // 반환: { exclusions: [{ signGroupCode, ref, text, targets, payout? }], manual: [...] }
  function extractExclusions(articles, benefits) {
    const art = findArticle(articles, /지급하지\s*않는\s*사유/);
    const out = { exclusions: [], manual: [] };
    if (!art) return out;
    for (const para of art.paragraphs) {
      const named = benefits.filter((b) => mentions(para.text, b.name));
      const targets = named.length ? named : benefits;
      for (const item of para.items) {
        const ref = cite(art, para, item);
        const main = item.text.split(/다만/)[0];
        const code = matchSignGroup(main);
        if (!code) {
          out.manual.push({ subject: main.replace(/[.\s]+$/, ''), ref, text: item.text, reason: manualReason(item.text) });
          continue;
        }
        const ex = { signGroupCode: code, ref, text: `${para.text} ${item.text}`, targets };
        for (const sub of item.subitems) {
          const subRef = cite(art, para, item, sub);
          const p = sub.text.match(/(보장개시일|계약일)부터\s*(\d+)\s*년이?\s*지난\s*후/);
          if (p && /재해\s*이외의\s*원인으로\s*사망한\s*경우에\s*해당하는\s*보험금/.test(sub.text)) {
            ex.payout = { basis: p[1], years: Number(p[2]), ...unit(subRef, sub.text) };
          } else if (!matchSignGroup(sub.text)) {
            out.manual.push({ subject: sub.text.replace(/[.\s]+$/, ''), ref: subRef, text: sub.text, reason: `면책의 예외(지급) 사유이나 ${manualReason(sub.text)}` });
          }
        }
        out.exclusions.push(ex);
      }
    }
    return out;
  }

  function extractExtinction(units) {
    return {
      paid: units.find((u) => /사망/.test(u.text) && /소멸합니다/.test(u.text)) || null,
      void: units.find((u) => /사망/.test(u.text) && /효력이\s*없습니다/.test(u.text)) || null,
    };
  }

  // ───────────────────────── 룰 행 생성 ─────────────────────────
  const MAX_FORMULA = 'Math.max([가입금액], [기납입보험료])';
  const fmt = (mult) => (mult === 1 ? '[가입금액]' : `[가입금액] * ${+mult.toFixed(4)}`);
  const elapsedVar = (basis) => (basis === '보장개시일' ? '보장개시경과기간' : '경과기간');

  function generateRules(text) {
    const articles = splitClauses(text);
    const units = flatten(articles);
    const { benefits, missing } = extractDeathBenefits(articles);
    const renewal = extractRenewal(articles, units);
    const { exclusions, manual } = extractExclusions(articles, benefits);
    const extinction = extractExtinction(units);
    const contracts = renewal ? ['최초', '갱신'] : [null];
    const rows = [];

    for (const u of units) {
      if (/실종선고/.test(u.text)) manual.push({ subject: '실종선고에 따른 사망 간주', ref: u.ref, text: u.text, reason: manualReason(u.text) });
    }

    const amounts = new Map();
    for (const b of benefits) {
      const a = extractAmount(articles, b);
      if (a) amounts.set(b.name, a);
      else missing.push({ subject: b.name, ref: b.ref, reason: '지급금액(가입금액의 N%) 조항을 찾지 못해 행을 만들지 않았습니다.' });
    }
    const payable = benefits.filter((b) => amounts.has(b.name));

    function addRow(r) {
      const conds = [];
      if (r.contract) conds.push(`계약구분=${r.contract}`);
      if (r.cond) conds.push(r.cond);
      const exempt = r.formula.endsWith('* 0');
      const status = exempt ? extinction.void : extinction.paid;
      const evidence = [unit(r.benefit.ref, r.benefit.excerpt), ...r.evidence];
      const flags = [...(r.flags || [])];
      if (status) {
        evidence.push(status);
        if (!exempt && !mentions(status.text, r.benefit.name)) {
          flags.push({ level: 'warn', reason: `${status.ref}은 '사망보험금' 지급 시 소멸로 규정합니다. 이 급부만 단독 지급되는 경우의 소멸 여부는 문언으로 확정할 수 없습니다.` });
        }
        if (exempt) flags.push({ level: 'warn', reason: `면책 시 소멸 근거는 ${status.ref}(효력 없음)입니다. 책임준비금 등 환급금 지급 여부는 약관 문언에 없습니다.` });
      } else {
        flags.push({ level: 'warn', reason: '사망 시 계약 소멸 조항을 찾지 못해 계약상태처리를 확정할 수 없습니다.' });
      }
      const sg = S.SIGN_GROUPS[r.signGroupCode];
      rows.push({
        category: r.category || (exempt ? '면책' : '정상'),
        claimCode: S.CLAIM.code,
        claim: S.CLAIM.name,
        accidentCode: S.ACCIDENT_TYPES[r.accident].code,
        accident: r.accident,
        benefit: r.benefit.name,
        riskBenefit: `${r.accident}사망`,
        signGroupCode: r.signGroupCode,
        signGroup: sg.name,
        calcCondition: conds.length ? conds.join(' AND ') : '-',
        formula: r.formula,
        calcTarget: [...new Set([...r.formula.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]))].join(', '),
        statusCode: status ? S.STATUS.소멸 : '',
        status: status ? '소멸' : '확인필요',
        evidence: dedupe(evidence),
        flags,
      });
    }

    // 계약구분·사고유형별 지급 산식. 반환: [{ cond, formula, category, evidence, flags }]
    function payoutVariants(b, accident, contract, { skipReduction } = {}) {
      const amt = amounts.get(b.name);
      const base = { formula: fmt(amt.mult), evidence: [unit(amt.ref, amt.text)], flags: [] };
      if (contract === '갱신') {
        if (renewal.max && mentions(renewal.max.text, b.name)) {
          return [{ formula: MAX_FORMULA, evidence: [renewal.max, ...(renewal.initialOnly ? [renewal.initialOnly] : [])], flags: [] }];
        }
        if (renewal.max) {
          base.flags.push({ level: 'warn', reason: `갱신계약 산식 조항(${renewal.max.ref})은 '사망보험금'만 명시합니다. 이 급부의 갱신계약 산식은 ${amt.ref} 문언대로 두었으며, 갱신계약에 별도 산식이 필요한지 문언으로 확정할 수 없습니다.` });
          base.evidence.push(renewal.max);
        }
      }
      const red = amt.reduction;
      const reductionApplies = red && red.accidents.includes(accident) && !skipReduction &&
        !(contract === '갱신' && renewal && renewal.initialOnly);
      if (!reductionApplies) return [base];
      const v = elapsedVar(red.basis);
      const boundary = { level: 'warn', reason: `'${red.years}년 이내' 경계일(${red.basis}+${red.years}년 당일)의 포함 여부와 초일 산입 여부가 문언상 불명확합니다.` };
      const ev = [unit(red.ref, red.text)];
      if (renewal && renewal.initialOnly) ev.push(renewal.initialOnly);
      else if (contract === '갱신') {
        boundary.reason += ' 또한 갱신계약에 감액을 적용하는지에 대한 문언이 없어 단서를 그대로 적용했습니다.';
      }
      return [
        { cond: `${v}<=${red.years}년`, formula: fmt(red.mult), category: '감액', evidence: ev, flags: [boundary] },
        { cond: `${v}>${red.years}년`, formula: base.formula, evidence: [...base.evidence, ...ev], flags: [boundary] },
      ];
    }

    // 1) 사인그룹별 정상·감액 행: 급부 × 사고유형 × 계약구분
    for (const b of payable) for (const accident of b.accidents) for (const contract of contracts) {
      for (const v of payoutVariants(b, accident, contract)) {
        addRow({ benefit: b, accident, signGroupCode: S.ACCIDENT_TYPES[accident].signGroup, contract, ...v });
      }
    }

    // 2) 면책 사인그룹 행
    for (const ex of exclusions) {
      const g = S.SIGN_GROUPS[ex.signGroupCode];
      const exUnit = unit(ex.ref, ex.text);
      for (const b of ex.targets.filter((t) => amounts.has(t.name))) {
        for (const accident of b.accidents.filter((a) => g.accidents.includes(a))) {
          const common = { benefit: b, accident, signGroupCode: ex.signGroupCode };
          if (!ex.payout) {
            const untouched = payable.filter((p) => !ex.targets.includes(p) && p.accidents.some((a) => g.accidents.includes(a)));
            const flags = untouched.length ? [{ level: 'warn', reason: `${untouched.map((p) => p.name).join(', ')}은(는) ${ex.ref.replace(/ 제\d+호$/, '')} 면책 대상에 없습니다. ${g.name} 사망 시 해당 급부의 매핑 행이 필요한지 확인해야 합니다.` }] : [];
            addRow({ ...common, contract: null, formula: fmt(0), category: '면책', evidence: [exUnit], flags });
            continue;
          }
          const p = ex.payout;
          const v = elapsedVar(p.basis);
          const flagsFor = (contract) => {
            const f = [{ level: 'warn', reason: `면책기간 기산점은 ${p.basis}입니다. 경과기간 정의(계약일 기준)와 다르므로 별도 변수가 필요합니다.` }];
            if (contract === '갱신') f.push({ level: 'warn', reason: `갱신계약에서 기산점(${p.basis})을 다시 정하는지 문언에 없습니다.` });
            return f;
          };
          for (const contract of contracts) {
            addRow({ ...common, contract, cond: `${v}<=${p.years}년`, formula: fmt(0), category: '면책', evidence: [exUnit], flags: flagsFor(contract) });
            const reduction = amounts.get(b.name).reduction;
            const extra = reduction && reduction.years >= p.years
              ? [{ level: 'warn', reason: `감액기간(${reduction.years}년)이 면책기간(${p.years}년) 이상이어서 감액 적용 여부를 문언으로 확정할 수 없습니다.` }] : [];
            for (const pv of payoutVariants(b, '일반', contract, { skipReduction: true })) {
              addRow({ ...common, contract, cond: `${v}>${p.years}년`, formula: pv.formula, evidence: [exUnit, unit(p.ref, p.text), ...pv.evidence], flags: [...flagsFor(contract), ...extra, ...pv.flags] });
            }
          }
        }
      }
    }

    markRisks(rows);
    rows.forEach((r, i) => { r.no = i + 1; });
    return { articles, benefits, rows, manual, missing };
  }

  function dedupe(units) {
    const seen = new Set();
    return units.filter((u) => u && !seen.has(u.ref) && seen.add(u.ref));
  }

  // 규칙 8: 🔴 금액 오산출 위험 / 🟡 매핑·중복 점검 표시와 테스트 시나리오
  function markRisks(rows) {
    for (const r of rows) {
      const boundary = r.calcCondition.match(/(\S+?)(<=|>)(\d+)년/);
      if (boundary) {
        const [, v, , n] = boundary;
        r.flags.push({ level: 'red', reason: `경계일 조건(${v} ${n}년)`, test: `${v} 값이 ${n}년-1일, ${n}년 당일, ${n}년+1일인 사망 3건을 입력해 감액·면책 경계와 산출액을 확인합니다.` });
      }
      if (r.formula.includes('Math.max')) {
        r.flags.push({ level: 'red', reason: 'Math.max 산식', test: '가입금액>기납입보험료, 가입금액<기납입보험료, 두 값이 같은 경우 3건을 입력해 큰 금액이 산출되는지 확인합니다.' });
      }
      const vars = new Set([
        ...[...r.formula.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]),
        ...[...r.calcCondition.matchAll(/([가-힣]+)(?:<=|>=|<|>|=)/g)].map((m) => m[1]),
      ]);
      const fresh = [...vars].filter((v) => !S.KNOWN_VARIABLES.includes(v));
      if (fresh.length) {
        r.flags.push({ level: 'red', reason: `신규 변수(${fresh.join(', ')})`, test: `ECS에 [${fresh.join('], [')}] 변수를 등록하고, 값이 비었거나 0일 때 산출 결과가 오류 없이 처리되는지 확인합니다.` });
      }
    }
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.accidentCode}|${r.signGroupCode}|${r.calcCondition}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const g of groups.values()) {
      const names = [...new Set(g.map((r) => r.benefit))];
      if (names.length < 2) continue;
      for (const r of g) r.flags.push({
        level: 'yellow',
        reason: `동일 사고유형·사인그룹·조건에 복수 급부 매핑(${names.join(', ')})`,
        test: `${r.accident} 사고·${r.signGroupCode} 사망 1건을 입력해 ${names.join('+')}이(가) 의도대로 함께 산출되는지, 중복 지급이 아닌지 확인합니다.`,
      });
    }
    for (const r of rows) {
      const icon = { red: '🔴', yellow: '🟡', warn: '⚠' };
      r.citations = r.evidence.map((e) => e.ref).join(' / ');
      r.excerptText = r.evidence.map((e) => `[${e.ref}] ${e.text}`).join('\n');
      r.flagText = r.flags.map((f) => `${icon[f.level]} ${f.reason}`).join('\n');
      r.testText = r.flags.filter((f) => f.test).map((f) => `- ${f.test}`).join('\n');
    }
  }

  // ───────────────────────── 정답지 비교 ─────────────────────────
  // answerRecords: 정답지 첫 시트를 헤더 기준 객체 배열로 읽은 값(sheet_to_json).
  // 매칭 키(급부·사고유형·사인그룹코드·계산식결정조건)로 짝을 짓고, 상세계산식·계약상태처리를 비교합니다.
  // 공백 차이는 무시합니다.
  const ROW_FIELD = { 구보장급부명: 'benefit', 사고유형: 'accident', 사인그룹코드: 'signGroupCode', 계산식결정조건: 'calcCondition', 상세계산식: 'formula', 계약상태처리: 'status' };
  const normCell = (v) => String(v == null ? '' : v).replace(/\s+/g, '');

  function compareWithAnswerKey(rows, answerRecords) {
    const headers = new Set(answerRecords.flatMap((r) => Object.keys(r)));
    const lacking = S.ANSWER_KEY_COLUMNS.filter((c) => !headers.has(c));
    if (!answerRecords.length || lacking.length) {
      return { error: `정답지에 필수 컬럼이 없습니다: ${(lacking.length ? lacking : S.ANSWER_KEY_COLUMNS).join(', ')}` };
    }
    const keyOf = (get) => S.ANSWER_KEY_MATCH.map((c) => normCell(get(c))).join('|');
    const pool = new Map();
    for (const r of rows) {
      const k = keyOf((c) => r[ROW_FIELD[c]]);
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k).push(r);
    }
    const items = [];
    answerRecords.forEach((a, i) => {
      if (S.ANSWER_KEY_MATCH.every((c) => !normCell(a[c]))) return; // 빈 행
      const k = keyOf((c) => a[c]);
      const cand = pool.get(k);
      const row = cand && cand.shift();
      if (!row) { items.push({ result: '정답지에만', answer: a, answerLine: i + 2, diffs: [] }); return; }
      const diffs = S.ANSWER_KEY_COMPARE.filter((c) => normCell(a[c]) !== normCell(row[ROW_FIELD[c]]));
      items.push({ result: diffs.length ? '불일치' : '일치', row, answer: a, answerLine: i + 2, diffs });
    });
    for (const rest of pool.values()) for (const row of rest) items.push({ result: '생성에만', row, diffs: [] });
    const summary = { 일치: 0, 불일치: 0, 정답지에만: 0, 생성에만: 0 };
    for (const it of items) summary[it.result]++;
    return { items, summary };
  }

  return {
    compareWithAnswerKey,
    splitClauses, cite, paragraphText, flatten, findArticle, mentions, extractDeathBenefits,
    extractAmount, extractRenewal, extractExclusions, extractExtinction, generateRules, SCOPE_ACCIDENTS,
  };
});
