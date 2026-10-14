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

  return { splitClauses, cite, paragraphText, flatten, findArticle, mentions, extractDeathBenefits, SCOPE_ACCIDENTS, _S: S };
});
