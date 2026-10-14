/* AI 해석 공통 + 3단계(결과 카드) + 4단계(ECS 초안). converter/ai.py·cards.py·ecs.py 이식.
 * - AI는 claude.ai 아티팩트의 sample 기능으로 부릅니다(보는 사람 본인의 Claude 계정, API 키 불필요).
 * - 담보 하나씩, 매칭 규칙 6의 입력(담보 구간, 참조 공통조항·보통약관 조문·별표·인용조문·표)만 보냅니다.
 * - AI가 적은 인용문이 해당 원문에 실제로 있는지 프로그램이 대조하고, 맞지 않으면 "근거 불일치"로 격리합니다.
 */
(function (root) {
  "use strict";
  const TT = (root.TT = root.TT || {});
  const norm = (s) => TT.normText(s);
  const MAX_BYTES = 250000;

  // ------------------------------------------------------------ Claude 호출
  let samplePromise = null;
  TT.getSample = function () {
    if (!samplePromise) samplePromise = root.claude && root.claude.use ? root.claude.use("sample").catch(() => null) : Promise.resolve(null);
    return samplePromise;
  };
  TT.aiTier = "default";
  const ERR = {
    not_granted: "Claude 사용을 허락하지 않아 AI 해석을 할 수 없습니다. 페이지를 다시 열면 다시 물어봅니다.",
    sampling_disabled: "이 계정(조직)에서는 아티팩트의 Claude 사용이 막혀 있습니다.",
    rate_limited: "Claude 사용 한도에 걸렸습니다. 잠시 뒤 다시 시도하세요.",
    prompt_too_large: "보내는 약관 분량이 한 번에 보낼 수 있는 양을 넘었습니다.",
    refused: "Claude가 이 요청을 거절했습니다.",
    invalid_json: "AI 응답을 표 형식(JSON)으로 읽지 못했습니다. 다시 시도해 주세요.",
    session_expired: "claude.ai 로그인이 만료되었습니다. 다시 로그인하세요.",
    cancelled: "중지했습니다.",
  };
  TT.callJson = async function (prompt, opts = {}) {
    const sample = await TT.getSample();
    if (!sample) throw new Error("이 화면에서는 Claude를 부를 수 없습니다. claude.ai에서 이 아티팩트를 열어 주세요.");
    const bytes = new TextEncoder().encode(prompt).length;
    if (bytes > MAX_BYTES) throw new Error(`보낼 내용이 너무 큽니다(${Math.round(bytes / 1024)}KB > ${Math.round(MAX_BYTES / 1024)}KB).`);
    try {
      return await sample.json(prompt, { modelTier: opts.tier || TT.aiTier, signal: opts.signal, cache: false });
    } catch (e) {
      const code = e && e.code;
      throw new Error((ERR[code] || "AI 호출 실패") + (code ? ` (${code})` : "") + (e && e.message && !ERR[code] ? ": " + e.message : ""));
    }
  };

  TT.joinLines = (text) => String(text || "").replace(/(?<=[가-힣])\n(?=[가-힣])/g, "").replace(/\s*\n\s*/g, " ");
  TT.tableText = (t) => t.grid.map((r) => r.map((v) => (v === null ? "〃" : String(v || "").replace(/\n/g, " "))).join(" | ")).join("\n");
  TT.verifyQuote = (quote, source) => { const q = norm(quote); return q.length >= 4 && norm(source).includes(q); };
  const top = (nodes, nid) => { while (nodes[nid].parent) nid = nodes[nid].parent; return nid; };

  // ------------------------------------------------------------ 분석 입력 묶음(매칭 규칙 6)
  class Bundle {
    constructor(data, cid) {
      Object.assign(this, { cid, nodes: data.terms.nodes, orders: data.terms.orders, refs: {}, byId: {}, counters: {} });
      this.tables = Object.fromEntries(data.tables.tables.map((t) => [t.id, t]));
      this.covs = Object.fromEntries(data.cmap.coverages.map((c) => [c.cid, c]));
      this.cov = this.covs[cid];
      const w = this.cov.inputs.whole;
      this.commonCid = (w.find((x) => x.kind === "공통 전체") || {}).cid || null;
      this.mainWhole = (w.find((x) => x.kind === "주계약 준용") || {}).cid || null;
      this.slimCommon = false;
    }
    handle(prefix, kind, id) {
      if (this.byId[id]) return this.byId[id];
      this.counters[prefix] = (this.counters[prefix] || 0) + 1;
      const h = prefix + this.counters[prefix];
      this.refs[h] = { kind, id };
      this.byId[id] = h;
      return h;
    }
    emitNode(prefix, nid, out) {
      const n = this.nodes[nid];
      if (this.skipBoxes && n.kind === "box") return;
      const h = this.handle(prefix, "node", nid);
      const label = { article: `${n.key}【${n.title || ""}】`, annex: `${n.key} ${n.title || ""}`, para: n.key, item: n.key + ".", sub: n.key + ".", subsub: n.key,
        box: n.title || "설명", part: `${n.key} ${n.title || ""}`, chap: `${n.key} ${n.title || ""}`, preface: "머리말", law: n.key }[n.kind] || n.key;
      out.push(`[${h}] (${n.page_start}쪽) ${label} ${TT.joinLines(n.text)}`.trimEnd());
      for (const c of n.children) this.emitNode(prefix, c, out);
    }
    emitTables(owners, out) {
      for (const t of Object.values(this.tables)) {
        if (!owners.has(t.owner)) continue;
        const h = this.handle("T", "table", t.id);
        out.push(`[${h}] 표 ${t.id} (${t.page}쪽, 소속 ${(this.nodes[t.owner] || {}).key || ""})${t.caption ? " 제목줄: " + t.caption : ""}${t.complete ? "" : " (표 추출 불완전 — 원본 쪽 확인 필요)"}\n${TT.tableText(t)}`);
      }
    }
    commonBlock() {
      const out = [];
      let ids;
      if (this.commonCid && !this.slimCommon) ids = this.orders[this.commonCid].filter((i) => !this.nodes[i].parent && this.nodes[i].kind === "article");
      else ids = this.cov.inputs.common_refs.filter((i) => this.nodes[i]).map((i) => top(this.nodes, i));
      for (const nid of [...new Set(ids)]) this.emitNode("C", nid, out);
      return out.join("\n");
    }
    ownBlock() {
      const out = [], tops = (this.orders[this.cid] || []).filter((i) => !this.nodes[i].parent);
      for (const nid of tops) this.emitNode("N", nid, out);
      this.emitTables(new Set(tops), out);
      return out.join("\n");
    }
    extraBlock() {
      const inp = this.cov.inputs, out = [];
      const mains = [...new Set(inp.main_refs.filter((i) => this.nodes[i]).map((i) => top(this.nodes, i)))];
      if (mains.length) { out.push("## 참조하는 보통약관 조문"); mains.forEach((n) => this.emitNode("M", n, out)); }
      if (this.mainWhole) out.push(`## 주계약 약관 준용 표시: 이 담보는 '${this.covs[this.mainWhole].name}' 약관을 준용한다고 정합니다(준용 대상 조문 전체는 입력에 없으며, 위에 실은 조문만 근거로 쓸 수 있습니다).`);
      const annexes = [...new Set(inp.annex_refs.filter((i) => this.nodes[i]))];
      if (annexes.length) { out.push("## 참조하는 다른 구간의 별표"); annexes.forEach((n) => this.emitNode("X", n, out)); this.emitTables(new Set(annexes), out); }
      const laws = [...new Set(inp.law_refs.filter((i) => this.nodes[i]))];
      if (laws.length) { out.push("## 참조하는 인용조문(법령)"); laws.forEach((n) => this.emitNode("L", n, out)); }
      return out.join("\n");
    }
    build() {
      this.refs = {}; this.byId = {}; this.counters = {};
      const common = this.commonBlock(), own = this.ownBlock(), extra = this.extraBlock();
      return { common, user: `# 분석할 담보: ${this.cov.name} (${this.cid}, ${this.cov.start}~${this.cov.end}쪽, 유형 ${this.cov.type})\n\n## 이 담보 구간 전체\n${own}\n\n${extra}` };
    }
    sourceOf(h) {
      const r = this.refs[h];
      if (!r) return [null, null, null];
      if (r.kind === "table") { const t = this.tables[r.id]; return [TT.tableText(t), r.id, t.page]; }
      return [TT.fullText(this.nodes, r.id), r.id, this.nodes[r.id].page_start];
    }
    check(evidence) {
      const out = [];
      let ok = Array.isArray(evidence) && evidence.length > 0;
      for (const e of evidence || []) {
        const ref = String((e && e.ref) || ""), quote = String((e && e.quote) || "");
        const [src, id, page] = this.sourceOf(ref);
        const good = !!src && TT.verifyQuote(quote, src);
        ok = ok && good;
        out.push({ ref, id, page, quote, verified: good, kind: (this.refs[ref] || {}).kind || null });
      }
      return [out, ok];
    }
  }
  TT.Bundle = Bundle;

  TT.loadDocData = async function (doc) {
    return { cmap: await TT.get(doc, "coverage_map.json"), terms: await TT.get(doc, "terms.json"), tables: await TT.get(doc, "tables.json") };
  };

  // 입력이 너무 크면 공통 조항을 '참조한 조문만'으로 줄입니다(잘라내지 않음). 그래도 크면 오류로 알립니다.
  function fitPrompt(b, makePrompt) {
    let { common, user } = b.build();
    let p = makePrompt(common, user);
    if (new TextEncoder().encode(p).length > MAX_BYTES && b.commonCid) {
      b.slimCommon = true;
      ({ common, user } = b.build());
      p = makePrompt(common, user);
    }
    if (new TextEncoder().encode(p).length > MAX_BYTES) {
      // 그래도 크면 설명 상자(【예시】 등 이해를 돕는 상자)를 빼고 보냅니다. 조문 본문과 표는 그대로입니다.
      b.skipBoxes = true;
      ({ common, user } = b.build());
      p = makePrompt(common, user + "\n\n(입력이 커서 설명 상자【…】는 빼고 보냈습니다.)");
    }
    return p;
  }

  const COMMON_RULES = `공통 규칙(반드시 지킵니다):
- 근거는 아래 입력에 실린 원문만 씁니다. 입력에 없는 내용은 추정하지 않고 "약관에 명시 없음"으로 답합니다.
- 모든 근거(evidence)는 ref에 입력의 참조 번호(예: N12, C3, M2, L1, X1, T2)를, quote에 그 원문에서 글자 그대로 복사한 한두 문장을 적습니다. 요약·바꿔쓰기·생략 부호를 넣지 않습니다.
- 표(T번호)의 수치와 지급률은 풀어 쓰지 않고 "T2 표 참조"처럼 표 번호로 가리킵니다.
- 해석이 갈릴 수 있으면 하나로 단정하지 않고 가능한 해석을 모두 적습니다.
- 한국어로, 실무자가 읽기 쉬운 완결된 문장으로 씁니다.
- 답은 설명 없이 JSON 하나만 출력합니다.`;

  // ------------------------------------------------------------ 3단계: 결과 카드
  TT.A_FIELDS = ["지급사유", "지급금액과 산식", "지급횟수와 한도", "보장개시일", "면책기간", "감액기간과 감액비율", "보험기간과 갱신 여부", "지급하지 않는 사유", "요건의 세부 정의", "지급 후 처리(특약 소멸·납입면제·가입금액 감액)"];
  TT.B_TOPICS = ["별표 참조와 표 이름", "산출에 영향을 주는 용어 정의", "단서·예외에 따른 분기", "다른 담보와의 중복지급·택일", "경과기간·연령·성별별 지급률 차이", "기준일 판단(사고일·진단일·입원개시일·수술일)", "기타 주의사항"];

  const CARD_INSTR = `당신은 생명보험사 보험금심사팀에서 신약관의 보험금 자동산출 룰을 입력하는 담당자를 돕는 약관 분석가입니다.
입력으로 담보(특약) 하나의 약관 원문과, 그 담보가 참조하는 특약 공통 조항·보통약관 조문·별표·인용조문만 받습니다.
결과는 담당자가 ECS에 룰을 입력할 때 보는 참고자료이며, 사람이 원문과 대조해 검토합니다.

해야 할 일:
A. 보장 세부조건(items): 다음 항목을 각각 한 번 이상 답합니다. 급부가 여럿이면 급부별로 나누어도 됩니다.
   ${TT.A_FIELDS.join(", ")}
   - 지급금액은 산식(예: 보험가입금액의 100%)과 감액 조건을 함께 적습니다. 지급횟수·한도는 1회·연간·통산 구분을 밝힙니다.
   - 근거를 찾지 못한 항목은 status를 "약관에 명시 없음"으로, content에 무엇을 찾지 못했는지 적고 evidence는 빈 배열로 둡니다.
B. 전산화 시 주의사항(cautions): ${TT.B_TOPICS.join(", ")}
   - "다만" 단서와 예외의 예외로 생기는 분기, 다른 담보와의 중복지급·택일, 경과기간(예: 계약일부터 1년 미만 50%)·연령·성별별 지급률 차이, 기준일 판단을 빠짐없이 봅니다.
   - 해석이 갈릴 수 있으면 needs_interpretation을 true로 하고 interpretations에 가능한 해석을 모두 적습니다.
C. tables: 산출에 쓰이는 표의 참조 번호(T번호)와 용도를 적습니다.

출력 JSON 형식:
{"items":[{"field":"(A 항목 이름 중 하나)","content":"...","status":"명시 또는 약관에 명시 없음","evidence":[{"ref":"N12","quote":"원문 그대로"}]}],
 "cautions":[{"topic":"(B 주제 이름 중 하나)","content":"...","needs_interpretation":false,"interpretations":[],"evidence":[{"ref":"...","quote":"..."}]}],
 "tables":[{"ref":"T1","use":"..."}]}

${COMMON_RULES}`;

  TT.analyzeCard = async function (doc, cid, signal) {
    const data = await TT.loadDocData(doc);
    const b = new Bundle(data, cid);
    const prompt = fitPrompt(b, (common, user) => `${CARD_INSTR}\n\n${common ? "# 특약 공통 조항(제1편 일반사항)\n" + common + "\n\n" : ""}${user}`);
    const out = (await TT.callJson(prompt, { signal })) || {};
    const items = [], isolated = [];
    (Array.isArray(out.items) ? out.items : []).forEach((it, k) => {
      const field = TT.A_FIELDS.includes(it.field) ? it.field : String(it.field || "기타");
      const status = it.status === "약관에 명시 없음" ? "약관에 명시 없음" : "명시";
      const [ev, ok] = b.check(it.evidence);
      const rec = { id: `A${k + 1}`, field, content: String(it.content || ""), status, evidence: ev, review: "미검토" };
      if (status === "약관에 명시 없음") { rec.check = "약관에 명시 없음"; items.push(rec); }
      else if (ok) { rec.check = "근거 확인"; items.push(rec); }
      else { rec.check = "근거 불일치"; isolated.push(rec); }
    });
    const answered = new Set(items.map((i) => i.field)), iso = new Set(isolated.map((i) => i.field));
    for (const f of TT.A_FIELDS) if (!answered.has(f)) {
      items.push({ id: `A${items.length + isolated.length + 1}`, field: f, status: "약관에 명시 없음", evidence: [], review: "미검토",
        content: iso.has(f) ? "AI 답의 근거 인용이 원문과 맞지 않아 격리했습니다. 원본을 직접 확인하세요." : "AI 응답에 이 항목이 없습니다.",
        check: iso.has(f) ? "근거 불일치로 격리" : "AI 미응답" });
    }
    const cautions = [];
    (Array.isArray(out.cautions) ? out.cautions : []).forEach((c, k) => {
      const [ev, ok] = b.check(c.evidence);
      const rec = { id: `B${k + 1}`, topic: TT.B_TOPICS.includes(c.topic) ? c.topic : "기타 주의사항", content: String(c.content || ""),
        needs_interpretation: !!c.needs_interpretation, interpretations: Array.isArray(c.interpretations) ? c.interpretations.map(String) : [],
        evidence: ev, review: "미검토", check: ok ? "근거 확인" : "근거 불일치" };
      (ok ? cautions : isolated).push(rec);
    });
    const tables = [];
    for (const t of Array.isArray(out.tables) ? out.tables : []) { const r = b.refs[String(t.ref || "")]; if (r && r.kind === "table") tables.push({ table: r.id, use: String(t.use || "") }); }
    const bt = b.cov.key.benefit_table;
    for (const tid of b.cov.tables) if (b.tables[tid].owner === bt && !tables.some((x) => x.table === tid)) tables.push({ table: tid, use: "보험금 지급기준표(자동 첨부)" });
    const appr = (await TT.get(doc, "approval.json", {})) || {};
    const card = { cid, name: b.cov.name, generated_at: TT.now(), approval_at: appr.at, meta: { model: "claude.ai (" + TT.aiTier + ")" },
      items, cautions, isolated, tables, input: { refs: Object.keys(b.refs).length, common_whole: !!b.commonCid && !b.slimCommon, main_whole: !!b.mainWhole } };
    const all = (await TT.get(doc, "cards.json", {})) || {};
    all[cid] = card;
    await TT.put(doc, "cards.json", all);
    return card;
  };

  TT.setCardReview = async function (doc, cid, itemId, status, user) {
    const all = (await TT.get(doc, "cards.json", {})) || {};
    for (const sec of ["items", "cautions"]) for (const it of all[cid][sec]) if (it.id === itemId) Object.assign(it, { review: status, review_at: TT.now(), review_user: user });
    await TT.put(doc, "cards.json", all);
  };

  // ------------------------------------------------------------ 4단계: ECS 초안
  const F = (key, group, kind = "code") => ({ key, label: key, group, kind });
  TT.ECS_FIELDS = [F("상품코드", "상품·청구", "user"), F("상품명", "상품·청구", "user"), F("판매개시일자", "상품·청구", "user"),
    F("청구사유", "상품·청구"), F("사고유형", "상품·청구"), F("구보장급부", "상품·청구"), F("사고자유형", "상품·청구"), F("사인그룹", "상품·청구"),
    ...[1, 2, 3, 4, 5, 6].map((i) => F("급부결정조건" + i, "상품·청구")), F("위험급부", "상품·청구"),
    ...[1, 2, 3, 4, 5, 6].map((i) => F("계산식결정조건" + i, "계산식")), F("계산구분", "계산식"), F("계산대상", "계산식"),
    F("대상테이블", "계산식", "value"), F("1구좌기준금액", "계산식", "value"), F("분자", "계산식", "value"), F("분모", "계산식", "value"),
    F("적용배수", "계산식", "value"), F("계산식", "계산식", "value"), ...[1, 2, 3, 4, 5].map((i) => F("금액유형" + i, "계산식")),
    ...[1, 2, 3, 4, 5].map((i) => F("상세계산식" + i, "상세계산식·처리")), F("계약상태처리", "상세계산식·처리"), F("납면처리", "상세계산식·처리"),
    F("갱신가능불가", "상세계산식·처리"), F("장래연금구분", "상세계산식·처리"), F("보험투자요소", "상세계산식·처리")];
  const AI_KEYS = TT.ECS_FIELDS.filter((f) => f.kind !== "user").map((f) => f.key);
  const STATUSES = ["값", "약관에 명시 없음", "사용자 입력 필요", "해석 확인 필요"];
  const ROW_SPLIT_EXAMPLE = `기존 ECS 룰 예시(행 분리 기준, 다른 상품의 화면에서 옮김):
- 같은 담보라도 청구사유(사망·장해·진단·수술 등) × 사고유형(일반(질병)·일반재해·교통재해 등)마다 행을 나눕니다.
  예) 재해사망보험금: [사망·일반재해] 행과 [사망·교통재해] 행이 따로 있고, 급부결정조건1이 각각 '사인그룹|일반재해', '사인그룹|교통재해'입니다.
  예) 기타사망보험금: [사망·일반] 행, 급부결정조건1 '사인그룹|질병(암포함)', 급부결정조건2 '기타|주피사망시'.
- 같은 청구사유·사고유형이라도 지급 조건(예: 장해지급률 80% 이상 여부)이 다르면 급부결정조건으로 구분해 행을 나눕니다.
- 진단·수술처럼 사인그룹(질병군)이 정해지는 담보는 사인그룹 명칭을 채웁니다. 사고자유형은 보통 '주피'(주피보험자)입니다.
- 계산식 예: 계산구분 '단일식', 계산대상 '가입금액2', 분자 300000, 분모 1000, 금액유형1 '가입금액', 계약상태처리 '소멸'.`;
  const ECS_INSTR = `당신은 생명보험사 보험금심사팀의 ECS(보험금 자동산출 시스템) 룰 입력을 돕는 분석가입니다.
담보 하나의 약관 원문 묶음과, 같은 담보를 이미 분석해 근거가 확인된 결과 카드를 받아 ECS "약관분석 데이터 관리" 화면의 룰 행 초안을 만듭니다.

규칙:
- 필드는 다음 이름만 씁니다: ${AI_KEYS.join(", ")}
- 코드와 명칭은 쌍입니다. '코드마스터'가 있으면 그 필드의 코드마스터에 있는 코드만 code에 적고, 맞는 코드가 없으면 code는 빈 문자열입니다. 코드마스터가 없으면 code는 항상 빈 문자열입니다.
- 값(대상테이블·1구좌기준금액·분자·분모·적용배수·계산식)은 name에 적고 code는 빈 문자열입니다.
- 약관에서 판단할 수 없는 필드는 status를 "약관에 명시 없음", 회사가 정해야 하는 필드는 "사용자 입력 필요"로 둡니다(이때 name·evidence는 비워도 되며, 필드를 아예 빼도 됩니다).
- 해석이 갈리는 값은 status를 "해석 확인 필요"로, note에 가능한 해석을 적습니다.
- status가 "값" 또는 "해석 확인 필요"면 evidence가 반드시 있어야 합니다.
- 조건 분기로 룰 행이 나뉘어야 하면 행을 나누고 split_reason·split_evidence에 이유와 근거를 적습니다. label은 '급부명 · 청구사유 · 사고유형 · 조건' 형식입니다.

${ROW_SPLIT_EXAMPLE}

출력 JSON 형식:
{"rows":[{"label":"...","split_reason":"...","split_evidence":[{"ref":"...","quote":"..."}],
  "fields":[{"field":"청구사유","code":"","name":"진단","status":"값","evidence":[{"ref":"N5","quote":"..."}],"note":""}]}]}

${COMMON_RULES}`;

  TT.loadMaster = async () => (await TT.get("_memory", "code_master.json", {})) || {};
  TT.importMaster = async function (arrayBuffer) {
    const wb = root.XLSX.read(arrayBuffer, { type: "array" });
    const master = {}, bad = new Set();
    const alias = Object.fromEntries(TT.ECS_FIELDS.map((f) => [norm(f.key), f.key]));
    for (const name of wb.SheetNames) {
      const rows = root.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
      if (!rows.length) continue;
      const head = rows[0].map((c) => norm(String(c)));
      const fi = head.findIndex((h) => ["필드명", "필드", "항목"].includes(h)), ci = head.findIndex((h) => h === "코드"), ni = head.findIndex((h) => ["명칭", "코드명", "이름"].includes(h));
      if (fi < 0 || ci < 0 || ni < 0) continue;
      for (const r of rows.slice(1)) {
        const fld = norm(String(r[fi] || "")), code = String(r[ci] || "").trim(), nm = String(r[ni] || "").trim();
        if (!fld || !code) continue;
        const key = alias[fld] || alias[fld.replace("코드", "")] || alias[fld.replace(/명$/, "")];
        if (!key) { bad.add(fld); continue; }
        (master[key] = master[key] || []).push({ code, name: nm });
      }
    }
    if (!Object.keys(master).length) throw new Error("코드마스터에서 '필드명·코드·명칭' 머리글이 있는 시트를 찾지 못했습니다. [양식 내려받기]의 양식에 맞춰 주세요.");
    await TT.put("_memory", "code_master.json", { imported_at: TT.now(), fields: master, unknown_fields: [...bad] });
    return { fields: Object.fromEntries(Object.entries(master).map(([k, v]) => [k, v.length])), unknown_fields: [...bad] };
  };
  TT.masterTemplate = function () {
    const wb = root.XLSX.utils.book_new();
    root.XLSX.utils.book_append_sheet(wb, root.XLSX.utils.aoa_to_sheet([["필드명", "코드", "명칭", "비고"], ["청구사유", "", "", "필드명은 '필드명 목록' 시트의 이름 중 하나로 적습니다. 한 행에 코드 하나입니다."]]), "코드마스터");
    root.XLSX.utils.book_append_sheet(wb, root.XLSX.utils.aoa_to_sheet([["필드명(코드 필드)"], ...TT.ECS_FIELDS.filter((f) => f.kind === "code").map((f) => [f.key])]), "필드명 목록");
    return root.XLSX.write(wb, { type: "array", bookType: "xlsx" });
  };
  TT.getProduct = async (doc) => (await TT.get(doc, "product.json", {})) || {};
  TT.setProduct = async function (doc, info, user) {
    const p = {};
    for (const k of ["상품코드", "상품명", "판매개시일자"]) p[k] = String(info[k] || "").trim();
    Object.assign(p, { at: TT.now(), user });
    await TT.put(doc, "product.json", p);
    await TT.history(doc, "4단계 상품 정보 입력", p, user);
    return p;
  };

  function cardText(card) {
    const lines = ["# 3단계 결과 카드(근거가 확인된 항목만)"];
    for (const it of card.items) lines.push(`- [${it.field}] (${it.status}) ${it.content} ${it.evidence.length ? "근거 " + it.evidence.map((e) => `${e.ref}:“${e.quote}”`).join("; ") : ""}`);
    for (const c of card.cautions) lines.push(`- 주의[${c.topic}] ${c.content}${c.needs_interpretation ? " / 가능한 해석: " + c.interpretations.join(" | ") : ""}`);
    return lines.join("\n");
  }
  function masterText(m) {
    if (!m.fields || !Object.keys(m.fields).length) return "# 코드마스터: 없음 (모든 code는 빈 문자열로 둡니다)";
    return ["# 코드마스터(이 안의 코드만 사용)", ...Object.entries(m.fields).map(([k, vs]) => `- ${k}: ` + vs.map((v) => `${v.code}=${v.name}`).join(", "))].join("\n");
  }

  function postRow(b, master, r, k) {
    const [splitEv] = b.check(r.split_evidence);
    const got = {}, isolated = [];
    for (const f of Array.isArray(r.fields) ? r.fields : []) {
      if (!AI_KEYS.includes(f.field)) continue;
      const status = STATUSES.includes(f.status) ? f.status : "값";
      const [ev, ok] = b.check(f.evidence);
      const cell = { code: String(f.code || "").trim(), name: String(f.name || "").trim(), status, evidence: ev, note: String(f.note || ""), flags: [], review: "미검토" };
      if ((status === "값" || status === "해석 확인 필요") && !ok) { isolated.push(Object.assign({ field: f.field }, cell, { flags: ["근거 불일치"] })); continue; }
      const fdef = TT.ECS_FIELDS.find((x) => x.key === f.field);
      if (fdef.kind === "code" && (status === "값" || status === "해석 확인 필요")) {
        const opts = (master.fields || {})[f.field];
        if (!opts) { if (cell.code) cell.flags.push(`AI가 적은 코드 '${cell.code}'는 코드마스터가 없어 비웠습니다`); cell.code = ""; cell.flags.push("코드 확인 필요"); }
        else {
          const hit = opts.find((o) => o.code === cell.code);
          if (!hit) {
            const byName = opts.filter((o) => norm(o.name) === norm(cell.name));
            if (byName.length === 1) { cell.code = byName[0].code; cell.flags.push("명칭으로 코드 매칭"); }
            else { cell.code = ""; cell.flags.push("코드 확인 필요(코드마스터에 맞는 코드 없음)"); }
          } else if (norm(hit.name) !== norm(cell.name)) cell.flags.push(`코드마스터 명칭은 '${hit.name}'`);
        }
      }
      got[f.field] = cell;
    }
    const fields = {};
    for (const fdef of TT.ECS_FIELDS) {
      if (fdef.kind === "user") fields[fdef.key] = { code: "", name: "", status: "사용자 입력 필요", evidence: [], note: "", flags: [], review: "미검토" };
      else fields[fdef.key] = got[fdef.key] || { code: "", name: "", status: "약관에 명시 없음", evidence: [], note: "", flags: [], review: "미검토" };
    }
    return { id: `R${k + 1}`, label: String(r.label || ""), split_reason: String(r.split_reason || ""), split_evidence: splitEv, fields, isolated };
  }

  TT.analyzeEcs = async function (doc, cid, signal) {
    const card = ((await TT.get(doc, "cards.json", {})) || {})[cid];
    if (!card) throw new Error(`${cid}: 3단계 결과 카드가 없습니다. 결과 카드를 먼저 만드세요.`);
    const data = await TT.loadDocData(doc);
    const b = new Bundle(data, cid);
    const master = await TT.loadMaster();
    const prompt = fitPrompt(b, (common, user) => `${ECS_INSTR}\n\n${common ? "# 특약 공통 조항(제1편 일반사항)\n" + common + "\n\n" : ""}${user}\n\n${cardText(card)}\n\n${masterText(master)}`);
    const out = (await TT.callJson(prompt, { signal })) || {};
    const rows = (Array.isArray(out.rows) ? out.rows : []).map((r, k) => postRow(b, master, r, k));
    const appr = (await TT.get(doc, "approval.json", {})) || {};
    const all = (await TT.get(doc, "ecs.json", {})) || {};
    all[cid] = { cid, name: b.cov.name, generated_at: TT.now(), approval_at: appr.at, meta: { model: "claude.ai" }, rows, master_used: !!(master.fields && Object.keys(master.fields).length) };
    await TT.put(doc, "ecs.json", all);
    return all[cid];
  };

  TT.editEcsCell = async function (doc, cid, rowId, field, code, name, user) {
    const all = (await TT.get(doc, "ecs.json", {})) || {};
    const cell = all[cid].rows.find((r) => r.id === rowId).fields[field];
    const before = { code: cell.code, name: cell.name };
    Object.assign(cell, { code: code.trim(), name: name.trim(), status: (code || name).trim() ? "값" : cell.status, edited: true, edited_at: TT.now(), edited_by: user });
    cell.flags = cell.flags.filter((f) => !f.startsWith("코드 확인 필요")).concat(["사용자 수정"]);
    await TT.put(doc, "ecs.json", all);
    await TT.history(doc, "4단계 값 수정", { cid, row: rowId, field, before, after: { code, name } }, user);
  };
  TT.setEcsReview = async function (doc, cid, rowId, field, status) {
    const all = (await TT.get(doc, "ecs.json", {})) || {};
    const row = all[cid].rows.find((r) => r.id === rowId);
    for (const f of field ? [field] : Object.keys(row.fields)) row.fields[f].review = status;
    await TT.put(doc, "ecs.json", all);
  };

  const sim = (a, b) => TT.similarity(norm(a), norm(b));
  function matchRow(r, cands) {
    const key = r.fields["청구사유"].name + "|" + r.fields["사고유형"].name;
    const same = cands.filter((c) => c.fields["청구사유"].name + "|" + c.fields["사고유형"].name === key);
    const pick = (xs) => xs.reduce((a, c) => (!a || sim(c.label, r.label) > sim(a.label, r.label) ? c : a), null);
    if (same.length) return pick(same);
    const best = pick(cands);
    return best && sim(best.label, r.label) > 0.6 ? best : null;
  }
  TT.ecsViewRows = async function (doc, cid, beforeRows) {
    const d = ((await TT.get(doc, "ecs.json", {})) || {})[cid];
    if (!d) return null;
    const prod = await TT.getProduct(doc);
    const rows = JSON.parse(JSON.stringify(d.rows));
    for (const r of rows) {
      for (const k of ["상품코드", "상품명", "판매개시일자"]) if (prod[k]) Object.assign(r.fields[k], { name: prod[k], status: "값", flags: ["사용자 입력"] });
      if (beforeRows) {
        const br = matchRow(r, beforeRows);
        r.before_label = br ? br.label : null;
        for (const [k, cell] of Object.entries(r.fields)) { const bc = br ? br.fields[k] : null; cell.before = bc ? { code: bc.code, name: bc.name, status: bc.status } : null; }
      }
    }
    return Object.assign({}, d, { rows });
  };

  TT.runAnalysis = function (doc, cids, stage, user) {
    return TT.startTask(doc, async (set) => {
      if (!(await TT.isApproved(doc))) throw new Error("1단계 변환이 승인되지 않아 AI 해석을 실행할 수 없습니다.");
      const errors = [];
      const steps = (stage === "both" ? ["cards", "ecs"] : [stage]);
      let k = 0;
      const total = cids.length * steps.length;
      for (const st of steps) for (const cid of cids) {
        await set(st === "cards" ? "3단계 결과 카드" : "4단계 ECS 초안", k / total, `${Math.min(k + 1, total)}/${total} · ${cid} (담보 하나에 1~3분)`);
        try { if (st === "cards") await TT.analyzeCard(doc, cid); else await TT.analyzeEcs(doc, cid); }
        catch (e) { errors.push(`${cid}: ${e.message}`); if (/허락하지|막혀|로그인/.test(e.message)) { k = total; break; } }
        k++;
      }
      await TT.history(doc, "AI 해석(" + stage + ")", { cids, errors }, user);
      if (errors.length) throw new Error(errors.slice(0, 3).join(" / ") + (errors.length > 3 ? ` 외 ${errors.length - 3}건` : ""));
    }, "AI 해석");
  };
})(typeof self !== "undefined" ? self : globalThis);
