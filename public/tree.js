// 담보 분류 트리의 순수 로직(화면과 테스트에서 함께 씁니다).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoverageTree = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 대분류(고정 6개) → 중분류(처음 나온 순) → 담보. 제외한 담보는 트리에 넣지 않습니다.
  function build(categories, coverages, query = '') {
    const q = query.replace(/\s/g, '');
    const visible = coverages.filter((c) => !c.excluded && (!q || (c.name + c.group).replace(/\s/g, '').includes(q)));
    return categories.map((cat) => {
      const groups = [];
      for (const c of visible.filter((x) => x.category === cat)) {
        let g = groups.find((x) => x.name === c.group);
        if (!g) groups.push((g = { name: c.group, items: [] }));
        g.items.push(c);
      }
      return { name: cat, groups, count: groups.reduce((s, g) => s + g.items.length, 0) };
    });
  }

  // 하위 담보 id 목록의 선택 상태: 'all' | 'some' | 'none'
  function state(ids, selected) {
    if (!ids.length) return 'none';
    const n = ids.filter((id) => selected.has(id)).length;
    return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
  }

  // 상위 체크박스를 누르면: 모두 선택된 상태면 모두 해제, 아니면 모두 선택
  function toggle(ids, selected) {
    const next = new Set(selected);
    if (state(ids, selected) === 'all') ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    return next;
  }

  const idsOfCategory = (cat) => cat.groups.flatMap((g) => g.items.map((c) => c.id));
  const idsOfGroup = (g) => g.items.map((c) => c.id);

  return { build, state, toggle, idsOfCategory, idsOfGroup };
});
