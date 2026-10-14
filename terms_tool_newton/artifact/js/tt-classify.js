/* 2단계: 담보 분류 트리(converter/classify.py 이식). 규칙 분류가 기본이며, AI 분류 제안은 선택입니다. */
(function (root) {
  "use strict";
  const TT = (root.TT = root.TT || {});
  const norm = (s) => TT.normText(s);
  TT.MAJORS = ["사망", "장해", "진단", "입원", "치료", "기타"];
  TT.CLASSIFY_TYPES = new Set(["보통약관", "개별특약", "납입면제류", "서비스·인수·전환류", "미분류"]);

  TT.shortName = function (name) {
    let s = name.replace(/\s+/g, "").replace(/^R?\(무\)/, "").replace(/\((갱신형|비갱신형|간편심사형|간편고지형|일반심사형|무해지환급형|해약환급금미지급형)\)/g, "").replace(/특약/g, "");
    if (s.endsWith("보장") && s.length > 4) s = s.replace(/보장$/, "");
    return s || name;
  };
  const memKey = (name) => norm(TT.shortName(name));

  TT.buildClassItems = async function (doc) {
    const cmap = await TT.get(doc, "coverage_map.json"), terms = await TT.get(doc, "terms.json");
    const tables = Object.fromEntries((await TT.get(doc, "tables.json")).tables.map((t) => [t.id, t]));
    const nodes = terms.nodes, items = [];
    for (const c of cmap.coverages) {
      if (!TT.CLASSIFY_TYPES.has(c.type)) continue;
      const pid = c.key.payout, benefits = [];
      for (const tid of c.tables) {
        const t = tables[tid];
        if (!t || t.owner !== c.key.benefit_table || !t.grid.length) continue;
        const col = t.grid[0].findIndex((h) => norm(h || "").includes("급부명"));
        if (col < 0) continue;
        for (const r of t.grid.slice(1)) {
          let v = r[col];
          if (!v) continue;
          v = v.replace(/\s*\n\s*/g, " ").trim().replace(/\s*\(제[\d-]+조(의\d+)?\)$/, "");
          if (v && !benefits.includes(v)) benefits.push(v);
        }
      }
      items.push({ cid: c.cid, name: c.name, short: TT.shortName(c.name), type: c.type, payout_id: pid, payout_key: pid ? nodes[pid].key : null,
        payout_page: pid ? nodes[pid].page_start : null, payout_text: pid ? TT.fullText(nodes, pid) : "", benefits, start: c.start });
    }
    return items;
  };

  const MID_RULES = [["납입면제", /납입면제/], ["서비스·인수·전환", /(서비스|인수|전환)$|지정대리/], ["특정질병", /양성신생물/], ["뇌·심장", /뇌.*심장|심장.*뇌|순환계/],
    ["암", /암|신생물|종양|항암/], ["뇌혈관", /뇌졸중|뇌출혈|뇌경색|뇌혈관/], ["심장", /심장|심근|부정맥|관상동맥|대동맥|판막|허혈/], ["재해", /재해|골절/],
    ["특정질병", /간경변|대상포진|통풍|갑상선기능|뇌전증|6대질병|조혈모|장기이식/], ["질병", /질병/]];
  const MINOR_RULES = {
    사망: [["재해사망", /재해사망/], ["일반사망", /./]],
    장해: [["3~100% 장해", /3~100/], ["50% 이상 장해", /50%이상|50%/], ["80% 이상 장해", /80%/]],
    진단: [["산정특례", /산정특례/], ["전이암", /전이/], ["고액암", /고액/], ["소액암", /소액/], ["3대·주요암", /3대|주요암/], ["남녀특정암", /남녀/], ["일반암", /일반암/],
      ["뇌졸중", /뇌졸중/], ["뇌출혈", /뇌출혈/], ["뇌혈관질환", /뇌혈관/], ["급성심근경색증", /급성심근경색/], ["허혈성심장질환", /허혈/], ["부정맥", /부정맥/]],
    입원: [["중환자실", /중환자실/], ["상급종합병원", /상급종합/], ["종합병원", /종합병원/], ["요양병원", /요양병원(?!제외)/], ["간병·간호", /간병|간호/], ["일반 입원", /./]],
    치료: [["로봇수술", /다빈치|로봇/], ["방사선치료", /방사선|양성자|중입자/], ["약물치료", /약물|호르몬|면역항암|표적항암/], ["주요치료", /주요치료/], ["통원", /통원/],
      ["검사", /검사|생검|촬영|조영술|MRI|PET/], ["혈전용해치료", /혈전용해/], ["응급실", /응급실/], ["골절·깁스", /골절|깁스/], ["이식수술", /이식/], ["수술", /수술/], ["기타 치료", /./]],
    기타: [["납입면제", /납입면제/], ["서비스·인수·전환", /(서비스|인수|전환)$|지정대리/], ["기타", /./]],
  };
  function sentenceWith(text, word) {
    const flat = text.replace(/\n/g, "");
    const i = flat.indexOf(word);
    if (i < 0) return null;
    const s = Math.max(flat.lastIndexOf(".", i), flat.lastIndexOf("】", i)) + 1;
    let e = flat.indexOf(".", i);
    e = e < 0 ? flat.length : e + 1;
    return flat.slice(s, e).trim().slice(0, 200);
  }
  TT.ruleClassify = function (it) {
    const nm = norm(it.short), ptxt = it.payout_text || "";
    let major, why, ev = null;
    if (it.type === "서비스·인수·전환류" || /납입면제|(서비스|인수|전환)$|지정대리/.test(nm)) [major, why] = ["기타", "납입면제·서비스·인수·전환 성격의 특약"];
    else if (nm.includes("사망")) [major, why] = ["사망", "담보명에 '사망'"];
    else if (nm.includes("장해")) [major, why] = ["장해", "담보명에 '장해'"];
    else if (/입원|간병|간호/.test(nm)) [major, why] = ["입원", "담보명에 '입원·간병·간호'"];
    else if (/검사|생검|촬영|조영술/.test(nm)) [major, why] = ["치료", "담보명에 '검사·생검·촬영·조영술'(영상진단 검사지원 포함)"];
    else if (/진단|산정특례/.test(nm)) [major, why] = ["진단", "담보명에 '진단' 또는 '산정특례'"];
    else if (/수술|치료|통원|검사|응급실|깁스|이식|혈전|약물|방사선|생검|촬영|조영술/.test(nm)) [major, why] = ["치료", "담보명에 치료 관련 낱말(수술·치료·통원·검사 등)"];
    else {
      [major, why] = ["기타", "담보명과 지급사유 조문에서 대분류 낱말을 찾지 못함"];
      for (const [maj, word] of [["사망", "사망"], ["장해", "장해"], ["진단", "진단확정"], ["입원", "입원"], ["치료", "수술"], ["치료", "치료"]]) {
        const q = sentenceWith(ptxt, word);
        if (q) { major = maj; why = `지급사유 조문(${it.payout_key})의 '${word}' 표현`; ev = { node: it.payout_id, quote: q }; break; }
      }
    }
    let mid = (MID_RULES.find(([, rx]) => rx.test(nm)) || [null])[0];
    if (!mid) mid = major !== "기타" ? "질병·재해 공통" : "기타";
    const minor = major === "기타" && (mid === "납입면제" || mid === "서비스·인수·전환")
      ? TT.shortName(it.name).replace(/납입면제$/, "") || TT.shortName(it.name)
      : (MINOR_RULES[major].find(([, rx]) => rx.test(nm)) || [TT.shortName(it.name)])[0];
    let reason = `${why} → ${major}; 중분류 '${mid}', 소분류 '${minor}' (담보명 '${it.short}' 기준)`;
    if (major === "기타") reason = "기타로 분류: " + reason;
    return { major, mid, minor, reason, evidence: ev, source: "규칙" };
  };

  // ------------------------------------------------------------ 저장·기억
  const loadMemory = async () => (await TT.get("_memory", "classification_memory.json", {})) || {};
  async function remember(doc, it, user) {
    const mem = await loadMemory();
    mem[memKey(it.name)] = { major: it.major, mid: it.mid, minor: it.minor, display_name: it.display_name || null, name: it.name, doc, at: TT.now(), user };
    await TT.put("_memory", "classification_memory.json", mem);
  }
  const load = (doc) => TT.get(doc, "classification.json");
  const save = (doc, d) => TT.put(doc, "classification.json", d);
  async function must(doc) { const d = await load(doc); if (!d) throw new Error("분류가 아직 없습니다. [자동 구성]을 먼저 누르세요."); return d; }

  TT.classGenerate = async function (doc, user, reset) {
    if (!(await TT.isApproved(doc))) throw new Error("1단계 변환이 승인되지 않았습니다. 검증 후 [변환 승인]을 먼저 누르세요.");
    const items = await TT.buildClassItems(doc);
    const prevData = (await load(doc)) || {};
    const old = reset ? {} : prevData.items || {};
    const mem = await loadMemory();
    const out = {};
    for (const it of items) {
      const prev = old[it.cid];
      if (prev && (prev.source === "사용자" || prev.source === "AI(적용)")) { out[it.cid] = Object.assign({}, prev, { name: it.name, short: it.short }); continue; }
      const m = mem[memKey(it.name)];
      let r;
      if (m && TT.MAJORS.includes(m.major)) {
        r = { major: m.major, mid: m.mid, minor: m.minor, evidence: null, source: "기억", reason: `이전 약관의 분류 기억 적용(${m.at || ""}, ${m.name || ""})` };
        if (m.display_name) r.display_name = m.display_name;
      } else r = TT.ruleClassify(it);
      out[it.cid] = Object.assign({ cid: it.cid, name: it.name, short: it.short, type: it.type, payout_id: it.payout_id, payout_page: it.payout_page,
        benefits: it.benefits, start: it.start, review: (prev || {}).review || "미검토", ai: (prev || {}).ai || null }, r);
    }
    const appr = (await TT.get(doc, "approval.json", {})) || {};
    const data = { generated_at: TT.now(), approval_at: appr.at, items: out, selected: (prevData.selected || []).filter((c) => out[c]) };
    await save(doc, data);
    await TT.history(doc, "분류: 자동 구성" + (reset ? "(초기화)" : ""), { count: Object.keys(out).length }, user);
    return data;
  };

  TT.classView = async function (doc) {
    const data = await load(doc);
    const appr = (await TT.get(doc, "approval.json", {})) || {};
    const sample = await TT.getSample();
    return { data, approved: !!appr.approved, stale: !!data && (!appr.approved || appr.at !== data.approval_at), majors: TT.MAJORS, ai_available: !!sample };
  };

  TT.classOp = async function (doc, op, b, user) {
    const data = await must(doc);
    if (op === "move") {
      if (!TT.MAJORS.includes(b.major)) throw new Error("대분류는 사망·장해·진단·입원·치료·기타 중 하나입니다.");
      const it = data.items[b.cid], before = { major: it.major, mid: it.mid, minor: it.minor };
      Object.assign(it, { major: b.major, mid: (b.mid || "").trim() || "기타", minor: (b.minor || "").trim() || it.short, source: "사용자",
        reason: `사용자가 분류함(${user || "이름 없음"}, ${TT.now()}) · 이전: ${before.major}/${before.mid}/${before.minor}`, review: "미검토" });
      await remember(doc, it, user);
      await TT.history(doc, "분류: 담보 이동", { cid: b.cid, before, after: { major: b.major, mid: b.mid, minor: b.minor } }, user);
    } else if (op === "rename_item") {
      const it = data.items[b.cid];
      it.display_name = (b.display_name || "").trim() || null;
      await remember(doc, it, user);
    } else if (op === "rename_group") {
      const nn = (b.new_name || "").trim();
      if (!nn) throw new Error("새 이름을 넣으세요.");
      for (const it of Object.values(data.items)) {
        if (it.major !== b.major || it.mid !== b.mid) continue;
        if (!b.minor) it.mid = nn; else if (it.minor === b.minor) it.minor = nn; else continue;
        it.source = "사용자"; it.reason = `사용자가 그룹 이름을 바꿈(${user || "이름 없음"}, ${TT.now()})`;
        await remember(doc, it, user);
      }
    } else if (op === "select") data.selected = (b.cids || []).filter((c) => data.items[c]);
    else if (op === "review") {
      const it = data.items[b.cid];
      Object.assign(it, { review: b.status, review_at: TT.now(), review_user: user });
      if (b.status === "검토완료") await remember(doc, it, user);
    } else if (op === "apply_ai") {
      const applied = [], skipped = [];
      for (const cid of b.cids || []) {
        const it = data.items[cid], ai = it && it.ai;
        if (!ai || !ai.verified) { skipped.push(cid); continue; }
        Object.assign(it, { major: ai.major, mid: ai.mid, minor: ai.minor, reason: "AI 제안 적용: " + ai.reason, evidence: ai.evidence.node !== "담보명" ? ai.evidence : null, source: "AI(적용)", review: "미검토" });
        applied.push(cid);
      }
      await save(doc, data);
      return Object.assign(await TT.classView(doc), { applied, skipped });
    } else throw new Error("알 수 없는 작업");
    await save(doc, data);
    return TT.classView(doc);
  };

  TT.classAiSuggest = function (doc, user) {
    return TT.startTask(doc, async (set) => {
      if (!(await TT.isApproved(doc))) throw new Error("1단계 변환이 승인되지 않았습니다.");
      const data = await must(doc);
      const items = await TT.buildClassItems(doc);
      const mem = await loadMemory();
      const examples = [...new Set(Object.values(mem).map((v) => `${v.major}/${v.mid}/${v.minor}`))].slice(0, 200);
      for (let k = 0; k < items.length; k += 15) {
        const batch = items.slice(k, k + 15);
        await set("AI 분류 제안", k / items.length, `${k}/${items.length}개 담보`);
        const payload = batch.map((it) => ({ cid: it.cid, 담보명: it.name, payout_id: it.payout_id || "", 지급사유_조문: it.payout_text || "(지급사유 조문 없음)", 지급기준표_급부명: it.benefits }));
        const prompt = `당신은 생명보험 보험금 심사팀의 약관 분류 보조자입니다. 주어진 담보(특약)마다 대분류·중분류·소분류를 제안합니다.
규칙:
- 대분류는 반드시 사망, 장해, 진단, 입원, 치료, 기타 중 하나입니다. 어디에도 맞지 않으면 기타입니다.
- 중분류는 질환군·사고군(예: 암, 뇌혈관, 심장, 뇌·심장, 재해, 질병, 특정질병, 질병·재해 공통, 납입면제), 소분류는 보장 형태(예: 수술, 로봇수술, 방사선치료, 약물치료, 통원, 검사, 상급종합병원, 중환자실, 일반암, 고액암)입니다. 기존 분류 예시가 있으면 그 이름을 그대로 씁니다.
- 판단은 제공된 담보명, 지급사유 조문 원문, 지급기준표 급부명만 근거로 합니다.
- evidence_node에는 근거로 쓴 조문 ID(제공된 payout_id)를, 담보명만으로 판단했다면 "담보명"을 적습니다.
- quote에는 근거 원문을 한 문장 이내로 글자 그대로 복사해 적습니다. reason은 한국어 한 문장입니다.
출력은 JSON 하나만: {"results":[{"cid":"C001","major":"진단","mid":"암","minor":"일반암","reason":"...","evidence_node":"...","quote":"..."}]}

기존 분류 예시(대/중/소): ${JSON.stringify(examples)}

분류할 담보:
${JSON.stringify(payload, null, 1)}`;
        const out = (await TT.callJson(prompt, { tier: "default" })) || {};
        for (const r of Array.isArray(out.results) ? out.results : []) {
          const it = batch.find((x) => x.cid === r.cid);
          if (!it || !TT.MAJORS.includes(r.major)) continue;
          const src = r.evidence_node === "담보명" ? it.name : r.evidence_node === it.payout_id ? it.payout_text : "";
          const ok = TT.verifyQuote(String(r.quote || ""), src);
          data.items[it.cid].ai = { major: r.major, mid: String(r.mid || ""), minor: String(r.minor || ""), reason: String(r.reason || ""),
            evidence: { node: String(r.evidence_node || ""), quote: String(r.quote || "") }, verified: ok, status: ok ? "근거 확인" : "근거 불일치", at: TT.now(), model: "claude.ai" };
        }
        await save(doc, data);
      }
      await TT.history(doc, "분류: AI 분류 제안", { count: items.length }, user);
    }, "AI 분류 제안");
  };
})(typeof self !== "undefined" ? self : globalThis);
