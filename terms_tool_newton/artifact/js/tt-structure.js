/* 1단계-B: 목차·머리글 대조, 담보-쪽 배정, 조문 트리, 유형, 참조 연결, 품질 보고서 (converter/structure.py 이식) */
(function (root) {
  "use strict";
  const TT = (root.TT = root.TT || {});
  const norm = (s) => TT.normText(s);

  const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
  const SUB_ORDER = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허";
  TT.COVERAGE_TYPES = ["보통약관", "특약공통", "개별특약", "납입면제류", "서비스·인수·전환류", "인용조문", "부속자료", "미분류"];
  TT.ANALYZABLE_TYPES = new Set(["보통약관", "특약공통", "개별특약", "납입면제류", "서비스·인수·전환류", "인용조문"]);

  const RE_TOC = /^(\d{3,4})\s+(\S.*)$/;
  const RE_ART = /^제\s*(\d+)(?:\s*-\s*(\d+))?\s*조(?:\s*의\s*(\d+))?\s*【\s*(.+?)\s*】\s*(.*)$/;
  const RE_PART = /^제\s*(\d+)\s*편\s*(?![에은는의을를이가과와])(\S.{0,40})?$/;
  const RE_CHAP = /^제\s*(\d+)\s*관\s*(?![에은는의을를이가과와])(\S.{0,40})?$/;
  const RE_ANNEX = /^\[?\s*별표\s*(\d+(?:\s*-\s*\d+)?)\s*\]?\s*(?![에은는의을를이가과와및중(（‘'“])(\S.{0,80})$/;
  const RE_PARA = new RegExp("^([" + CIRCLED + "])(?![과와,·~및\\-]|\\s*[" + CIRCLED + "])\\s*(.*)$");
  const RE_ITEM = /^(\d{1,2})\.(?!\d)\s*(.*)$/;
  const RE_SUB = /^([가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허])\.\s*(.*)$/;
  const RE_SUBSUB = /^\((\d{1,2})\)\s*(.*)$/;
  const RE_LAW = /^(\d{1,3})\.\s*「(.+?)」\s*$/;
  const RE_LAWART = /^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*[(（]([^)）]{1,40})[)）]\s*(.*)$/;
  const SENTENCE_END = /(니다|한다|이다|있다|없다|된다)\s*[.。]?\s*$/;
  const RE_REF_LAW = /「([^」]{1,80})」\s*(?:제\s*(\d+(?:-\d+)?)\s*조(?:\s*의\s*(\d+))?)?/g;
  const RE_REF_ART = /제\s*(\d+)(?:\s*-\s*(\d+))?\s*조(?:\s*의\s*(\d+))?(?:\s*[(（]([^)）]{0,60})[)）])?(?:\s*제\s*(\d+)\s*항)?/g;
  const RE_REF_ANX = /별표\s*(\d+)(?:\s*-\s*(\d+))?/g;
  const RE_REF_PART1 = /제\s*1\s*편\s*일\s*반\s*사\s*항/g;

  const artKey = (a, b, c) => (b ? `제${a}-${b}조` : `제${a}조`) + (c ? `의${c}` : "");
  const artSort = (a, b, c) => [+a, +(b || 0), +(c || 0)];
  const annexKey = (s) => "별표" + s.replace(/\s+/g, "");
  const pad = (n, w) => String(n).padStart(w, "0");
  TT.artKey = artKey;

  // difflib.SequenceMatcher.ratio()에 가까운 유사도(최장 공통 부분수열 기반)
  TT.similarity = function (a, b) {
    if (!a && !b) return 1;
    const n = a.length, m = b.length;
    let prev = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      const cur = new Array(m + 1).fill(0);
      for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      prev = cur;
    }
    return (2 * prev[m]) / (n + m);
  };

  function mostCommon(counter) {
    let best = null, bc = -1;
    for (const [k, v] of counter) if (v > bc) { best = k; bc = v; }
    return [best, bc];
  }

  // ------------------------------------------------------------ 목차
  function parseToc(pages) {
    const cands = [];
    for (const pg of pages.slice(0, 80)) {
      const n = pg.lines.filter((l) => RE_TOC.test(l.t)).length;
      const hasWord = pg.lines.slice(0, 5).some((l) => l.t.includes("목차"));
      if (n >= 5 || (n >= 2 && hasWord)) cands.push(pg.p);
    }
    if (!cands.length) return { found: false, pages: [], entries: [], problems: ["목차(쪽번호 + 담보명 형식)를 찾지 못했습니다."] };
    const run = [cands[0]];
    for (const p of cands.slice(1)) { if (p === run[run.length - 1] + 1) run.push(p); else break; }
    const entries = [], problems = [];
    for (const p of run) {
      const lines = pages[p - 1].lines;
      let k = 0;
      while (k < lines.length) {
        let l = lines[k];
        const m = l.t.match(RE_TOC);
        if (!m) { k++; continue; }
        let name = m[2].trim();
        const nameX = l.b[0], h = l.b[3] - l.b[1];
        while (k + 1 < lines.length) {
          const nx = lines[k + 1];
          if (RE_TOC.test(nx.t) || /^\d+$/.test(nx.t)) break;
          if (nx.b[1] - l.b[3] > 1.2 * h || nx.b[0] < nameX + 20) break;
          name += nx.t.trim(); l = nx; k++;
        }
        entries.push({ order: entries.length + 1, label: m[1], toc_page: +m[1], name, name_norm: norm(name), src_page: p });
        k++;
      }
    }
    for (let i = 0; i + 1 < entries.length; i++) {
      const a = entries[i], b = entries[i + 1];
      if (b.toc_page < a.toc_page) problems.push(`목차 쪽번호가 줄어듭니다: ${a.name}(${a.toc_page}) → ${b.name}(${b.toc_page})`);
    }
    return { found: true, pages: run, entries, problems };
  }

  function pageOffset(pages) {
    const diffs = new Map();
    for (const pg of pages) if (pg.printed !== null && pg.printed !== undefined) { const d = pg.p - pg.printed; diffs.set(d, (diffs.get(d) || 0) + 1); }
    if (!diffs.size) return { offset: 0, known: false, basis: "인쇄 쪽번호를 찾지 못했습니다.", mismatch_pages: [], no_number_pages: pages.map((p) => p.p) };
    const [off, cnt] = mostCommon(diffs);
    return { offset: off, known: true, agree_pages: cnt,
      mismatch_pages: pages.filter((pg) => pg.printed != null && pg.p - pg.printed !== off).map((pg) => pg.p),
      no_number_pages: pages.filter((pg) => pg.printed == null).map((pg) => pg.p) };
  }

  // ------------------------------------------------------------ 쪽 배정
  function assignPages(pages, toc, off, covOverrides) {
    const n = pages.length;
    const covs = toc.entries.map((e) => ({ cid: "C" + pad(e.order, 3), name: e.name, name_norm: e.name_norm, toc_label: e.label, toc_start: e.toc_page + off.offset }));
    const order = covs.map((_, i) => i).sort((i, j) => covs[i].toc_start - covs[j].toc_start);
    order.forEach((i, k) => {
      const nxt = k + 1 < order.length ? covs[order[k + 1]].toc_start - 1 : n;
      covs[i].toc_end = Math.max(covs[i].toc_start, Math.min(nxt, n));
    });
    const byNorm = new Map(covs.map((c) => [c.name_norm, c]));
    const headerHits = {}, unknownHeaders = {}, pageRows = [];
    for (const pg of pages) {
      const p = pg.p, hn = pg.header_norm;
      let hc = null, how = null;
      if (hn) {
        if (byNorm.has(hn)) { hc = byNorm.get(hn); how = "일치"; }
        else {
          let best = null, bs = 0;
          for (const [k, c] of byNorm) { const s = TT.similarity(hn, k); if (s > bs) { bs = s; best = c; } }
          if (best && bs >= 0.9) { hc = best; how = "유사 일치"; }
          else (unknownHeaders[pg.header] = unknownHeaders[pg.header] || []).push(p);
        }
      }
      const tc = covs.find((c) => c.toc_start <= p && p <= c.toc_end) || null;
      if (hc) (headerHits[hc.cid] = headerHits[hc.cid] || []).push(p);
      pageRows.push({ p, header: pg.header, header_cid: hc ? hc.cid : null, header_match: how, toc_cid: tc ? tc.cid : null });
    }
    const ov = {};
    for (const o of covOverrides) for (let p = o.start; p <= o.end; p++) ov[p] = o.cid;
    for (const r of pageRows) {
      const p = r.p;
      if (ov[p]) { r.cid = ov[p]; r.source = "사용자 수정"; }
      else if (r.header_cid) { r.cid = r.header_cid; r.source = "머리글"; }
      else if (r.toc_cid && !toc.pages.includes(p)) { r.cid = r.toc_cid; r.source = "목차 범위(머리글 없음)"; }
      else { r.cid = null; r.source = "미배정"; }
      r.mismatch = !!(r.header_cid && r.toc_cid && r.header_cid !== r.toc_cid) || !!(pages[p - 1].header_norm && !r.header_cid);
    }
    const covPages = {};
    for (const r of pageRows) if (r.cid) (covPages[r.cid] = covPages[r.cid] || []).push(r.p);
    for (const c of covs) {
      const ps = covPages[c.cid] || [];
      c.pages = ps; c.start = ps.length ? ps[0] : null; c.end = ps.length ? ps[ps.length - 1] : null;
      c.header_pages = (headerHits[c.cid] || []).length;
      c.header_start = headerHits[c.cid] ? headerHits[c.cid][0] : null;
      c.gaps = [];
      for (let i = 0; i + 1 < ps.length; i++) if (ps[i + 1] !== ps[i] + 1) c.gaps.push([ps[i] + 1, ps[i + 1] - 1]);
    }
    return { covs, pageRows, unknownHeaders };
  }

  // ------------------------------------------------------------ 조문 트리
  function isInternalToc(pg) {
    const ls = pg.lines;
    if (!ls.length) return false;
    if (ls.slice(0, 3).some((l) => l.t.includes("목차"))) return true;
    const heads = ls.filter((l) => RE_ART.test(l.t) || RE_CHAP.test(l.t) || RE_PART.test(l.t) || /^별표\s*\d/.test(l.t)).length;
    return heads >= 4 && heads >= 0.6 * ls.length;
  }

  function headingMargin(pages) {
    const xs = new Map();
    for (const pg of pages) for (const l of pg.lines) if (RE_ART.test(l.t)) { const x = Math.round(l.b[0]); xs.set(x, (xs.get(x) || 0) + 1); }
    return xs.size ? mostCommon(xs)[0] : 72;
  }

  class Builder {
    constructor(cov, nodes, dup) { Object.assign(this, { cov, name: cov.name, nodes, dup, article: null, stack: [], box: null, boxRegion: null, part: null, chap: null, law: null, order: [] }); }
    make(kind, key, title, parent, ref, page, text = "", extra = {}) {
      let nid = parent ? `${parent.id}/${key}` : `${this.name}/${key}`;
      if (this.nodes[nid]) {
        let k = 2;
        while (this.nodes[`${nid}#${k}`]) k++;
        this.dup.push({ cid: this.cov.cid, id: nid, page });
        nid = `${nid}#${k}`;
      }
      const node = Object.assign({ id: nid, cid: this.cov.cid, kind, key, title, parent: parent ? parent.id : null, children: [], lines: [], text: "", page_start: page, page_end: page }, extra);
      if (text) node.text = text;
      if (ref) node.lines.push(ref);
      if (parent) parent.children.push(nid);
      this.nodes[nid] = node;
      this.order.push(nid);
      return node;
    }
    addLine(node, text, ref, page) {
      node.text = node.text ? node.text + "\n" + text : text;
      node.lines.push(ref);
      node.page_end = page;
      let pid = node.parent;
      while (pid) { const pn = this.nodes[pid]; pn.page_end = Math.max(pn.page_end, page); pid = pn.parent; }
    }
    top() { return this.box || (this.stack.length ? this.stack[this.stack.length - 1][1] : this.article); }
    ensurePreface(page) { if (!this.article) this.article = this.make("preface", "머리말", "머리말", null, null, page); }
    startTop(kind, key, title, ref, page, rest = "", extra = {}) {
      this.stack = []; this.box = null; this.boxRegion = null;
      const parent = kind === "article" && this.law ? this.law : null;
      const node = this.make(kind, key, title, parent, ref, page, (rest || "").trim(), Object.assign({ part: this.part, chap: this.chap }, extra));
      if (["article", "annex", "preface", "part", "chap", "law"].includes(kind)) this.article = node;
      return node;
    }
    marker(level, kind, label, num, rest, ref, page) {
      const st = this.stack.slice();
      let prevSame = null;
      while (st.length && st[st.length - 1][0] >= level) { const [lv, nd] = st.pop(); if (lv === level) prevSame = nd; }
      const expected = prevSame ? prevSame.num + 1 : 1;
      if (num !== expected) return null;
      this.stack = st;
      const parent = this.stack.length ? this.stack[this.stack.length - 1][1] : this.article;
      const node = this.make(kind, label, "", parent, ref, page, (rest || "").trim(), { num });
      this.stack.push([level, node]);
      return node;
    }
  }

  function parseCoverage(cov, pages, nodes, dup, headingX, force, suppress, boxRegions, tocInternal) {
    const b = new Builder(cov, nodes, dup);
    const isLaw = cov.type_guess === "인용조문";
    const lineOwner = {};
    const xs = new Map();
    for (const p of cov.pages) {
      if (tocInternal.has(p)) continue;
      for (const l of pages[p - 1].lines) if ((isLaw ? RE_LAW : RE_ART).test(l.t)) { const x = Math.round(l.b[0]); xs.set(x, (xs.get(x) || 0) + 1); }
    }
    if (xs.size) {
      const top = mostCommon(xs)[1];
      headingX = Math.min(...[...xs].filter(([, n]) => n >= Math.max(1, Math.floor(top / 3))).map(([x]) => x));
    }
    const lawX = headingX;
    for (const p of cov.pages) {
      if (tocInternal.has(p)) continue;
      const pg = pages[p - 1], regions = boxRegions[p] || [];
      pg.lines.forEach((l, i) => {
        const ref = [p, i], t = l.t, x0 = l.b[0], yc = (l.b[1] + l.b[3]) / 2, xc = (l.b[0] + l.b[2]) / 2, key = p + ":" + i;
        const region = regions.find((r) => r[0] - 1 <= xc && xc <= r[2] + 1 && r[1] - 1 <= yc && yc <= r[3] + 1) || null;
        const fh = force[key], sup = suppress.has(key), atMargin = x0 <= headingX + 4;
        let m, node;
        if (fh) {
          node = b.startTop(fh.kind === "annex" ? "annex" : "article", fh.key, fh.title, ref, p, "", { forced: true });
          lineOwner[key] = node.id; return;
        }
        if (!sup && !region) {
          if (isLaw) {
            if ((m = t.match(RE_LAW))) {
              b.law = null;
              node = b.startTop("law", `「${m[2].trim()}」`, m[2].trim(), ref, p, "", { law_norm: norm(m[2]) });
              b.law = node; lineOwner[key] = node.id; return;
            }
            if ((m = t.match(RE_LAWART)) && b.law && x0 <= lawX + 14) {
              node = b.startTop("article", artKey(m[1], null, m[2]), m[3], ref, p, m[4], { sort: artSort(m[1], null, m[2]) });
              lineOwner[key] = node.id; return;
            }
          } else {
            if ((m = t.match(RE_ART)) && atMargin) {
              node = b.startTop("article", artKey(m[1], m[2], m[3]), m[4], ref, p, m[5], { sort: artSort(m[1], m[2], m[3]) });
              lineOwner[key] = node.id; return;
            }
            if ((m = t.match(RE_PART)) && t.length <= 40 && !SENTENCE_END.test(t)) {
              b.part = `제${m[1]}편`; b.chap = null;
              node = b.startTop("part", b.part, (m[2] || "").trim(), ref, p);
              lineOwner[key] = node.id; return;
            }
            if ((m = t.match(RE_CHAP)) && atMargin && t.length <= 45 && !SENTENCE_END.test(t)) {
              b.chap = `제${m[1]}관`;
              node = b.startTop("chap", (b.part ? b.part + "/" : "") + b.chap, (m[2] || "").trim(), ref, p);
              lineOwner[key] = node.id; return;
            }
            if ((m = t.match(RE_ANNEX)) && x0 <= headingX + 12 && i <= 2 && t.length <= 90 && !SENTENCE_END.test(t)) {
              const akey = annexKey(m[1]);
              if (b.article && b.article.kind === "annex" && b.article.key === akey) {
                (b.article.repeated_heading_pages = b.article.repeated_heading_pages || []).push(p);
                b.addLine(b.article, t, ref, p); lineOwner[key] = b.article.id; return;
              }
              node = b.startTop("annex", akey, m[2].trim(), ref, p);
              lineOwner[key] = node.id; return;
            }
          }
        }
        if (region && b.article && b.article.kind !== "annex") {
          if (!b.box || b.boxRegion !== region) {
            const parent = b.stack.length ? b.stack[b.stack.length - 1][1] : b.article;
            const nbox = parent.children.filter((c) => b.nodes[c].kind === "box").length + 1;
            b.box = b.make("box", `설명${nbox}`, t.startsWith("【") ? t : "", parent, null, p);
            b.boxRegion = region;
          }
          b.addLine(b.box, t, ref, p); lineOwner[key] = b.box.id; return;
        }
        b.box = null; b.boxRegion = null;
        b.ensurePreface(p);
        if (b.article.kind === "article" && !sup) {
          node = null;
          if ((m = t.match(RE_PARA)) && x0 <= headingX + 22) node = b.marker(1, "para", m[1], CIRCLED.indexOf(m[1]) + 1, m[2], ref, p);
          if (!node && (m = t.match(RE_ITEM))) node = b.marker(2, "item", m[1], +m[1], m[2], ref, p);
          if (!node && (m = t.match(RE_SUB))) node = b.marker(3, "sub", m[1], SUB_ORDER.indexOf(m[1]) + 1, m[2], ref, p);
          if (!node && (m = t.match(RE_SUBSUB))) node = b.marker(4, "subsub", `(${m[1]})`, +m[1], m[2], ref, p);
          if (node) { lineOwner[key] = node.id; return; }
        }
        node = b.top();
        b.addLine(node, t, ref, p);
        lineOwner[key] = node.id;
      });
    }
    return { order: b.order, lineOwner };
  }

  TT.fullText = function fullText(nodes, nid) {
    const n = nodes[nid], parts = [];
    if (["article", "annex", "part", "chap", "law"].includes(n.kind)) parts.push((n.kind === "article" && n.title ? `${n.key}【${n.title}】` : `${n.key} ${n.title || ""}`).trim());
    if (n.text) {
      const lead = n.kind === "item" || n.kind === "sub" ? n.key + ". " : n.kind === "para" || n.kind === "subsub" ? n.key + " " : "";
      parts.push(lead + n.text);
    }
    for (const c of n.children) parts.push(fullText(nodes, c));
    return parts.filter(Boolean).join("\n");
  };

  // ------------------------------------------------------------ 유형·핵심 조문·번호 점검
  function classifyCov(cov, nodes, order) {
    const name = cov.name_norm;
    const arts = order.map((i) => nodes[i]).filter((n) => n.kind === "article");
    const titles = arts.map((a) => norm(a.title));
    const dash1 = arts.filter((a) => /^제1-\d+조/.test(a.key)).length;
    const payout = titles.some((t) => t.includes("지급사유") && !t.includes("통지"));
    const waiver = titles.some((t) => t.includes("납입면제사유"));
    if (name.includes("인용조문")) return "인용조문";
    if (cov.header_pages === 0 && !arts.length) return "부속자료";
    if (name.includes("일반사항") && dash1 >= Math.max(1, Math.floor(arts.length / 2))) return "특약공통";
    if (waiver || (name.includes("납입면제") && !payout)) return "납입면제류";
    if (/(서비스|인수|전환)특약|지정대리/.test(name)) return "서비스·인수·전환류";
    if (payout && !name.includes("특약")) return "보통약관";
    if (payout) return "개별특약";
    return "미분류";
  }

  function keyArticles(nodes, order) {
    const out = { payout: null, detail: null, exclusion: null, benefit_table: null };
    for (const nid of order) {
      const n = nodes[nid], t = norm(n.title || "");
      if (n.kind === "article") {
        if (!out.payout && ((t.includes("지급사유") && !t.includes("통지")) || t.includes("납입면제사유"))) out.payout = nid;
        else if (!out.detail && t.includes("세부규정")) out.detail = nid;
        else if (!out.exclusion && (t.includes("지급하지않는사유") || t.includes("면제하지않는사유") || t.includes("면책"))) out.exclusion = nid;
      } else if (n.kind === "annex" && !out.benefit_table && t.includes("지급기준표")) out.benefit_table = nid;
    }
    return out;
  }

  function numberingProblems(cov, nodes, order) {
    const probs = [], seen = {};
    let prev = null;
    for (const nid of order) {
      const n = nodes[nid];
      if (n.kind !== "article" || !n.sort) { if (n.kind === "law") prev = null; continue; }
      const s = n.sort, k = (n.parent || "") + "|" + n.key;
      if (seen[k]) probs.push({ cid: cov.cid, kind: "중복", key: n.key, page: n.page_start, detail: `${n.key}가 ${seen[k]}쪽과 ${n.page_start}쪽에 두 번 나옵니다.` });
      seen[k] = n.page_start;
      if (prev) {
        const [a, b, c] = s, [pa, pb, pc] = prev;
        const ok = (a === pa && b === pb && (c === pc + 1 || (pc === 0 && c === 2))) || (b && a === pa && b === pb + 1 && c === 0) ||
          (!b && a === pa + 1 && c === 0) || (b && a === pa + 1 && b === 1 && c === 0) || (b && a !== pa && b === 1);
        if (!ok) probs.push({ cid: cov.cid, kind: "끊김·역전", key: n.key, page: n.page_start, detail: `직전 조문 ${artKey(prev[0], prev[1] || null, prev[2] || null)} 다음에 ${n.key}가 나옵니다.` });
      }
      prev = s;
    }
    return probs;
  }

  // ------------------------------------------------------------ 참조 연결
  function resolveRefs(covs, nodes, covOrders) {
    const common = covs.filter((c) => c.type === "특약공통"), main = covs.filter((c) => c.type === "보통약관"), lawcov = covs.filter((c) => c.type === "인용조문");
    const lawIndex = new Map();
    if (lawcov.length) for (const nid of covOrders[lawcov[0].cid]) if (nodes[nid].kind === "law") lawIndex.set(nodes[nid].law_norm, nid);
    const artIndex = new Map();
    for (const c of covs) for (const nid of covOrders[c.cid] || []) { const n = nodes[nid]; if ((n.kind === "article" || n.kind === "annex") && !n.parent) artIndex.set(c.cid + "|" + n.key, nid); }
    const refs = [];
    for (const c of covs) {
      if (c.type === "인용조문" || c.type === "부속자료") continue;
      const dashStyle = (covOrders[c.cid] || []).some((n) => nodes[n].kind === "article" && /^제\d+-\d+조/.test(nodes[n].key));
      for (const nid of covOrders[c.cid] || []) {
        const n = nodes[nid];
        if (!n.text && n.kind !== "article") continue;
        let text = (n.text || "").replace(/\n/g, " ");
        if (n.kind === "box" && /법|규칙|령|고시/.test(n.title || "")) text = (n.text || "").split("\n")[0];
        let top = n;
        while (top.parent) top = nodes[top.parent];
        const spans = [];
        const add = (kind, raw, target, tcid, status, reason, start) => refs.push({ cid: c.cid, src: nid, src_page: n.page_start, kind, raw, target, target_cid: tcid, status, reason, ctx: text.slice(Math.max(0, start - 25), start + raw.length + 25) });
        for (const m of text.matchAll(RE_REF_LAW)) {
          spans.push([m.index, m.index + m[0].length]);
          const lid = lawIndex.get(norm(m[1])), raw = m[0].trim();
          if (!lid) { if (text.slice(m.index + m[0].length, m.index + m[0].length + 25).includes("인용조문")) add("법령", raw, null, null, "미해결", "인용조문 구간에서 해당 법령을 찾지 못함", m.index); continue; }
          if (m[2]) {
            const tid = `${lid}/제${m[2]}조` + (m[3] ? `의${m[3]}` : "");
            if (nodes[tid]) add("법령", raw, tid, lawcov[0].cid, "연결", "", m.index);
            else add("법령", raw, lid, lawcov[0].cid, "미해결", "법령은 있으나 해당 조문이 인용조문에 없음", m.index);
          } else add("법령", raw, lid, lawcov[0].cid, "연결", "법령 단위 연결", m.index);
        }
        for (const m of text.matchAll(RE_REF_ART)) {
          if (spans.some(([a, b]) => a <= m.index && m.index < b)) continue;
          const before = text.slice(Math.max(0, m.index - 40), m.index);
          const [, a, b2, cc] = m, key = artKey(a, b2, cc), raw = m[0].trim();
          if (/(같은\s*법|이\s*법)\s*$/.test(before)) continue;
          if (/(법률|법|령|규칙|규정|고시)\s*$/.test(before)) {
            const nb = norm(before);
            let lid = null;
            for (const [k2, v] of lawIndex) if (nb.endsWith(k2)) { lid = v; break; }
            if (lid) {
              const tid = `${lid}/${key}`;
              if (nodes[tid]) add("법령", raw, tid, lawcov[0].cid, "연결", "", m.index);
              else add("법령", raw, lid, lawcov[0].cid, "미해결", "법령은 있으나 해당 조문이 인용조문에 없음", m.index);
            } else add("법령", raw, null, null, "미해결", "인용조문에 없는 외부 법령·고시의 조문", m.index);
            continue;
          }
          if (/(적용대상\s*특약|해당\s*특약|각\s*특약)[^.。]{0,10}$/.test(before)) { add("조문", raw, null, null, "각 특약 조문", "다른 특약(적용대상 특약)의 같은 번호 조문을 가리킴", m.index); continue; }
          if (b2 && a === "2" && c.type === "특약공통") { add("조문", raw, null, null, "각 특약 조문", "특약 공통 조항이 각 개별 특약의 같은 번호 조문을 가리킴", m.index); continue; }
          let tc;
          if (b2) {
            if (a === "1") { if (!common.length) { add("조문", raw, null, null, "미해결", "특약 공통(일반사항) 구간을 찾지 못함", m.index); continue; } tc = common[0]; }
            else tc = c;
          } else if (!dashStyle) tc = c;
          else if (/(주계약|보통약관)/.test(text.slice(Math.max(0, m.index - 30), m.index))) {
            if (!main.length) { add("조문", raw, null, null, "미해결", "보통약관 구간을 찾지 못함", m.index); continue; }
            tc = main[0];
          } else { add("조문", raw, null, null, "미해결", "번호 체계(N-M)와 다른 '제N조' 참조이며 소속(주계약·법령 등)이 문맥에 없음", m.index); continue; }
          let tid = artIndex.get(tc.cid + "|" + key);
          if (!tid) { add("조문", raw, null, tc.cid, "미해결", `${tc.name}에서 ${key}를 찾지 못함`, m.index); continue; }
          if (tid === top.id) continue;
          if (m[5]) { const sub = `${tid}/${CIRCLED[+m[5] - 1] || ""}`; if (nodes[sub]) tid = sub; }
          add("조문", raw, tid, tc.cid, "연결", "", m.index);
        }
        for (const m of text.matchAll(RE_REF_ANX)) {
          const [, a, b2] = m, key = b2 ? `별표${a}-${b2}` : `별표${a}`;
          if (top.kind === "annex" && top.key === key) continue;
          const raw = m[0], before = text.slice(Math.max(0, m.index - 15), m.index);
          if ((!b2 && dashStyle) || /(법률|법|령|규칙|고시|」)\s*(제\s*\d+\s*[조항]\s*)*$/.test(before)) { add("별표", raw, null, null, "미해결", "외부 법령·고시의 별표로 보임(이 약관의 별표 번호 체계와 다름)", m.index); continue; }
          const tc = b2 && a === "1" && c.type !== "특약공통" ? common[0] || null : c;
          if (!tc) { add("별표", raw, null, null, "미해결", "특약 공통(일반사항) 구간을 찾지 못함", m.index); continue; }
          const tid = artIndex.get(tc.cid + "|" + key);
          if (tid) add("별표", raw, tid, tc.cid, "연결", "", m.index);
          else add("별표", raw, null, tc.cid, "미해결", `${tc.name}에서 ${key}를 찾지 못함`, m.index);
        }
        if (c.type !== "특약공통") for (const m of text.matchAll(RE_REF_PART1)) {
          if (common.length) add("공통 전체", m[0], common[0].cid, common[0].cid, "연결", "제1편 일반사항 전체를 이 특약에 적용", m.index);
          else add("공통 전체", m[0], null, null, "미해결", "특약 공통(일반사항) 구간을 찾지 못함", m.index);
        }
        if (n.kind === "article" && norm(n.title || "").includes("준용") && c.type !== "보통약관") {
          const ft = norm(TT.fullText(nodes, nid));
          if (ft.includes("주계약") || ft.includes("보통약관")) {
            if (main.length) add("주계약 준용", n.key, main[0].cid, main[0].cid, "연결", "주계약(보통약관) 약관을 준용", 0);
            else add("주계약 준용", n.key, null, null, "미해결", "보통약관 구간을 찾지 못함", 0);
          }
        }
      }
    }
    return refs;
  }

  function analysisInputs(cov, nodes, covOrders, refs, byCid) {
    const own = (covOrders[cov.cid] || []).filter((nid) => !nodes[nid].parent);
    const common = [], main = [], annex = [], law = [], whole = [];
    for (const r of refs) {
      if (r.cid !== cov.cid || r.status !== "연결") continue;
      const tc = byCid[r.target_cid];
      if (r.kind === "공통 전체" || r.kind === "주계약 준용") { whole.push({ kind: r.kind, cid: r.target_cid, name: tc ? tc.name : "" }); continue; }
      if (r.kind === "법령") law.push(r.target);
      else if (r.kind === "별표" && r.target_cid !== cov.cid) annex.push(r.target);
      else if (r.kind === "조문" && r.target_cid !== cov.cid && tc) (tc.type === "특약공통" ? common : main).push(r.target);
    }
    const uniq = (xs) => [...new Set(xs.filter(Boolean))];
    const wh = [];
    for (const w of whole) if (!wh.some((x) => x.kind === w.kind && x.cid === w.cid)) wh.push(w);
    return { own, common_refs: uniq(common), main_refs: uniq(main), annex_refs: uniq(annex), law_refs: uniq(law), whole: wh };
  }

  // ------------------------------------------------------------ 전체 조립
  TT.buildStructure = function (pages, meta, edits) {
    const active = (edits || []).filter((e) => e.active !== false);
    const covRange = {}, covType = {}, force = {}, suppress = new Set();
    for (const e of active) {
      const key = e.page + ":" + e.line;
      if (e.action === "coverage_range") covRange[e.cid] = { cid: e.cid, start: +e.start, end: +e.end };
      else if (e.action === "coverage_type") covType[e.cid] = e.type;
      else if (e.action === "split" || e.action === "rename") { force[key] = { kind: e.kind || "article", key: e.key, title: e.title || "" }; suppress.delete(key); }
      else if (e.action === "merge") { suppress.add(key); delete force[key]; }
    }
    const toc = parseToc(pages), off = pageOffset(pages);
    const { covs, pageRows, unknownHeaders } = assignPages(pages, toc, off, Object.values(covRange));
    const headingX = headingMargin(pages);
    const tocInternal = new Set(pages.filter((pg) => !toc.pages.includes(pg.p) && isInternalToc(pg)).map((pg) => pg.p));
    const boxRegions = {};
    for (const pg of pages) for (const t of pg.tables) if (t.kind === "box") (boxRegions[pg.p] = boxRegions[pg.p] || []).push(t.bbox);
    const nodes = {}, dup = [], covOrders = {}, lineOwner = {};
    for (const c of covs) {
      c.type_guess = c.name_norm.includes("인용조문") ? "인용조문" : null;
      if (c.header_pages === 0 && !covRange[c.cid]) { covOrders[c.cid] = []; continue; }
      const r = parseCoverage(c, pages, nodes, dup, headingX, force, suppress, boxRegions, tocInternal);
      covOrders[c.cid] = r.order;
      Object.assign(lineOwner, r.lineOwner);
    }
    for (const c of covs) {
      const auto = classifyCov(c, nodes, covOrders[c.cid]);
      c.type_auto = auto; c.type = covType[c.cid] || auto;
      c.type_edited = c.cid in covType; c.range_edited = c.cid in covRange;
      delete c.type_guess;
      c.key = keyArticles(nodes, covOrders[c.cid]);
      c.n_articles = covOrders[c.cid].filter((i) => nodes[i].kind === "article").length;
      c.annexes = covOrders[c.cid].filter((i) => nodes[i].kind === "annex").map((i) => ({ id: i, key: nodes[i].key, title: nodes[i].title, page: nodes[i].page_start }));
    }
    const refs = resolveRefs(covs, nodes, covOrders);
    const byCid = Object.fromEntries(covs.map((c) => [c.cid, c]));
    for (const c of covs) c.inputs = analysisInputs(c, nodes, covOrders, refs, byCid);

    const pageCid = Object.fromEntries(pageRows.map((r) => [r.p, r.cid]));
    const tables = [];
    for (const pg of pages) {
      const p = pg.p;
      for (const t of pg.tables) {
        if (t.kind !== "table") continue;
        const top = t.bbox[1];
        let own = null;
        pg.lines.forEach((l, i) => { const o = lineOwner[p + ":" + i]; if (o && l.b[1] <= top + 2) own = o; });
        if (!own && p > 1) { const prevs = pages[p - 2].lines.map((_, i) => lineOwner[(p - 1) + ":" + i]).filter(Boolean); own = prevs.length ? prevs[prevs.length - 1] : null; }
        let ownerTop = own;
        while (ownerTop && nodes[ownerTop] && nodes[ownerTop].parent) ownerTop = nodes[ownerTop].parent;
        let cap = "";
        for (const l of pg.lines) if (l.b[3] <= top + 1 && top - l.b[3] < 25) cap = l.t;
        tables.push({ id: `T${pad(p, 4)}-${t.idx + 1}`, cid: pageCid[p] || null, page: p, owner: ownerTop, owner_node: own,
          annex: ownerTop && nodes[ownerTop].kind === "annex" ? nodes[ownerTop].key : null, caption: cap, bbox: t.bbox,
          n_rows: t.n_rows, n_cols: t.n_cols, grid: t.grid, cells: t.cells, complete: t.complete, problems: t.problems, image: null });
      }
    }
    for (let i = 0; i + 1 < tables.length; i++) {
      const a = tables[i], b = tables[i + 1];
      if (b.page === a.page + 1 && a.cid === b.cid && a.n_cols === b.n_cols) {
        const ha = pages[a.page - 1].h;
        if (a.bbox[3] > ha * 0.8 && b.bbox[1] < ha * 0.3) { a.continues_to = b.id; b.continued_from = a.id; }
      }
    }
    for (const c of covs) c.tables = tables.filter((t) => t.cid === c.cid).map((t) => t.id);
    let numbering = [];
    for (const c of covs) if (TT.ANALYZABLE_TYPES.has(c.type) && c.type !== "인용조문") numbering = numbering.concat(numberingProblems(c, nodes, covOrders[c.cid]));
    const report = makeReport(pages, meta, toc, off, covs, pageRows, unknownHeaders, refs, tables, numbering, dup, tocInternal);
    return { toc, offset: off, coverages: covs, page_rows: pageRows, nodes, cov_orders: covOrders, refs, tables, report,
      heading_x: headingX, toc_internal: [...tocInternal].sort((a, b) => a - b), line_owner: lineOwner };
  };

  function makeReport(pages, meta, toc, off, covs, pageRows, unknownHeaders, refs, tables, numbering, dup, tocInternal) {
    const byCid = Object.fromEntries(covs.map((c) => [c.cid, c]));
    return {
      page_count: meta.page_count,
      text_pages: pages.filter((pg) => pg.chars > 0).length,
      scanned_pages: pages.filter((pg) => pg.scanned).length,
      ocr_engine: false,
      toc: { found: toc.found, pages: toc.pages, count: toc.entries.length, problems: toc.problems },
      offset: off,
      header_coverages: covs.filter((c) => c.header_pages > 0).length,
      toc_count: covs.length,
      count_diff: covs.length - covs.filter((c) => c.header_pages > 0).length,
      toc_no_header: covs.filter((c) => c.header_pages === 0).map((c) => ({ cid: c.cid, name: c.name, toc_start: c.toc_start, toc_end: c.toc_end })),
      unknown_headers: Object.entries(unknownHeaders).map(([header, ps]) => ({ header, pages: ps })),
      start_diff: covs.filter((c) => c.header_start && c.header_start !== c.toc_start).map((c) => ({ cid: c.cid, name: c.name, toc_start: c.toc_start, header_start: c.header_start })),
      unassigned_pages: pageRows.filter((r) => !r.cid).map((r) => ({ p: r.p, first_line: ((pages[r.p - 1].lines[0] || {}).t || "").slice(0, 60) })),
      mismatch_pages: pageRows.filter((r) => r.mismatch).map((r) => ({ p: r.p, header: r.header, header_cid: r.header_cid, toc_cid: r.toc_cid, assigned: r.cid })),
      no_header_assigned: pageRows.filter((r) => r.cid && r.source === "목차 범위(머리글 없음)").map((r) => r.p),
      internal_toc_pages: [...tocInternal].sort((a, b) => a - b),
      no_payout: covs.filter((c) => ["보통약관", "개별특약", "납입면제류", "미분류", "서비스·인수·전환류"].includes(c.type) && !c.key.payout).map((c) => ({ cid: c.cid, name: c.name, type: c.type })),
      numbering, duplicate_ids: dup,
      unresolved_refs: refs.filter((r) => r.status === "미해결"),
      ref_total: refs.length,
      table_total: tables.length,
      table_incomplete: tables.filter((t) => !t.complete && TT.ANALYZABLE_TYPES.has((byCid[t.cid] || {}).type)).map((t) => ({ id: t.id, cid: t.cid, page: t.page, annex: t.annex, problems: t.problems, image: null })),
      low_text_pages: pages.filter((pg) => pg.low_text).map((pg) => ({ p: pg.p, chars: pg.chars, cid: pageRows[pg.p - 1].cid })),
      ocr: pages.filter((pg) => pg.ocr && !pg.ocr.done).map((pg) => ({ p: pg.p, status: "OCR 미실행", detail: pg.ocr.reason })),
      summary: covs.map((c) => ({ cid: c.cid, name: c.name, start: c.start, end: c.end, type: c.type, payout: c.key.payout, annexes: c.annexes, n_articles: c.n_articles, toc_start: c.toc_start, header_pages: c.header_pages, gaps: c.gaps })),
    };
  }
})(typeof self !== "undefined" ? self : globalThis);
