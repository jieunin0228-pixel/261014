"""AI 해석 공통: 분석 입력 묶음(매칭 규칙 6), Claude 호출, 근거 인용 대조.

원칙
- 변환 승인된 데이터만 입력으로 씁니다(호출하는 쪽에서 pipeline.is_approved 확인).
- PDF를 통째로 보내지 않고, 담보 하나의 조문과 그 담보가 참조하는 조문·표만 보냅니다.
- 입력의 조문·표마다 짧은 참조 번호(N1, C3, M2, L1, X1, T1 …)를 붙여 보내고, AI는 이 번호와
  원문 인용으로 근거를 답합니다. 인용문이 해당 원문에 실제로 있는지 프로그램이 대조합니다.
- API 키는 서버 측 환경변수(ANTHROPIC_API_KEY)로만 읽습니다.
"""
from __future__ import annotations

import json
import os
import re

from . import pipeline
from .extract import norm_text

MODEL = os.environ.get("TERMS_AI_MODEL", "claude-opus-5-5")


def available():
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def call_json(system_blocks, user_text, schema, effort="high", max_tokens=32000):
    """구조화 출력(JSON 스키마)으로 Claude를 한 번 호출합니다. 긴 응답에 대비해 스트리밍을 씁니다.
    시험에서는 이 함수를 가짜로 바꿉니다."""
    import anthropic
    client = anthropic.Anthropic()
    kwargs = dict(model=MODEL, max_tokens=max_tokens,
                  output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
                  system=system_blocks, messages=[{"role": "user", "content": user_text}])
    try:
        # 거절(refusal) 시 서버 측 대체 모델로 이어서 처리하도록 요청합니다.
        with client.beta.messages.stream(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs) as stream:
            resp = stream.get_final_message()
    except anthropic.BadRequestError:
        # 계정·지역에 따라 대체 모델 옵션이 거부되면 옵션 없이 한 번 다시 호출합니다.
        with client.messages.stream(**kwargs) as stream:
            resp = stream.get_final_message()
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude가 요청을 거절했습니다(refusal).")
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("응답이 길이 제한(max_tokens)에 걸려 끝까지 받지 못했습니다.")
    text = next(b.text for b in resp.content if b.type == "text")
    usage = getattr(resp, "usage", None)
    meta = {"model": getattr(resp, "model", MODEL),
            "input_tokens": getattr(usage, "input_tokens", None),
            "output_tokens": getattr(usage, "output_tokens", None),
            "cache_read_tokens": getattr(usage, "cache_read_input_tokens", None)}
    return json.loads(text), meta


def join_lines(text):
    """PDF 줄바꿈으로 끊긴 한글 낱말은 붙이고, 나머지 줄바꿈은 띄어쓰기로 바꿉니다(대조는 공백을 무시)."""
    return re.sub(r"\s*\n\s*", " ", re.sub(r"(?<=[가-힣])\n(?=[가-힣])", "", text))


def full_text(nodes, nid):
    n = nodes[nid]
    parts = []
    if n["kind"] in ("article", "annex", "law"):
        parts.append(f"{n['key']}【{n.get('title', '')}】" if n["kind"] == "article" else f"{n['key']} {n.get('title', '')}")
    if n["text"]:
        lead = {"item": n["key"] + ". ", "sub": n["key"] + ". ", "para": n["key"] + " ", "subsub": n["key"] + " "}.get(n["kind"], "")
        parts.append(lead + n["text"])
    for c in n["children"]:
        parts.append(full_text(nodes, c))
    return "\n".join(p for p in parts if p)


def table_text(t):
    rows = []
    for r in t["grid"]:
        rows.append(" | ".join("〃" if v is None else (v or "").replace("\n", " ") for v in r))
    return "\n".join(rows)


def verify_quote(quote, source):
    """인용문이 원문에 실제로 있는지 공백·줄바꿈·가운뎃점 차이를 무시하고 대조합니다."""
    q = norm_text(quote)
    return len(q) >= 4 and q in norm_text(source)


class Bundle:
    """담보 하나의 분석 입력(매칭 규칙 6)과 참조 번호 ↔ 원본 ID 대응표."""

    def __init__(self, doc_id, cid):
        self.doc_id, self.cid = doc_id, cid
        cmap = pipeline.read_json(doc_id, "coverage_map.json")
        terms = pipeline.read_json(doc_id, "terms.json")
        self.tables = {t["id"]: t for t in pipeline.read_json(doc_id, "tables.json")["tables"]}
        self.nodes = terms["nodes"]
        self.orders = terms["orders"]
        self.covs = {c["cid"]: c for c in cmap["coverages"]}
        self.cov = self.covs[cid]
        self.refs = {}       # 참조 번호 → {"kind": "node"/"table", "id": 원본 ID}
        self.by_id = {}
        inp = self.cov["inputs"]
        self.common_cid = next((w["cid"] for w in inp["whole"] if w["kind"] == "공통 전체"), None)
        self.main_whole = next((w["cid"] for w in inp["whole"] if w["kind"] == "주계약 준용"), None)

    def _handle(self, prefix, kind, oid):
        if oid in self.by_id:
            return self.by_id[oid]
        n = sum(1 for h in self.refs if h.startswith(prefix) and h[len(prefix):].isdigit()) + 1
        h = f"{prefix}{n}"
        self.refs[h] = {"kind": kind, "id": oid}
        self.by_id[oid] = h
        return h

    def _emit_node(self, prefix, nid, out):
        n = self.nodes[nid]
        h = self._handle(prefix, "node", nid)
        label = {"article": f"{n['key']}【{n.get('title', '')}】", "annex": f"{n['key']} {n.get('title', '')}",
                 "para": n["key"], "item": n["key"] + ".", "sub": n["key"] + ".", "subsub": n["key"],
                 "box": n.get("title") or "설명", "part": f"{n['key']} {n.get('title', '')}",
                 "chap": f"{n['key']} {n.get('title', '')}", "preface": "머리말", "law": n["key"]}.get(n["kind"], n["key"])
        text = join_lines(n["text"] or "")
        out.append(f"[{h}] ({n['page_start']}쪽) {label} {text}".rstrip())
        for c in n["children"]:
            self._emit_node(prefix, c, out)

    def _emit_tables(self, owner_ids, out):
        for t in self.tables.values():
            if t["owner"] in owner_ids:
                h = self._handle("T", "table", t["id"])
                cap = f" 제목줄: {t['caption']}" if t.get("caption") else ""
                flag = "" if t["complete"] else " (표 추출 불완전 — 원본 쪽 확인 필요)"
                out.append(f"[{h}] 표 {t['id']} ({t['page']}쪽, 소속 {self.nodes[t['owner']]['key'] if t['owner'] in self.nodes else ''}){cap}{flag}\n{table_text(t)}")

    def common_block(self):
        """특약 공통 조항(문서 안에서 공통 → 프롬프트 캐시 대상). 공통 전체 적용이면 조문 전부, 아니면 참조 조문만."""
        out = []
        if self.common_cid:
            ids = [i for i in self.orders.get(self.common_cid, []) if self.nodes[i]["parent"] is None
                   and self.nodes[i]["kind"] == "article"]
        else:
            ids = [i for i in self.cov["inputs"]["common_refs"] if i in self.nodes]
            ids = [i if self.nodes[i]["parent"] is None else _top(self.nodes, i) for i in ids]
        for nid in dict.fromkeys(ids):
            self._emit_node("C", nid, out)
        return "\n".join(out)

    def own_block(self):
        out = []
        tops = [i for i in self.orders.get(self.cid, []) if self.nodes[i]["parent"] is None]
        for nid in tops:
            self._emit_node("N", nid, out)
        self._emit_tables(set(tops), out)
        return "\n".join(out)

    def extra_block(self):
        inp = self.cov["inputs"]
        out = []
        mains = list(dict.fromkeys(_top(self.nodes, i) for i in inp["main_refs"] if i in self.nodes))
        if mains:
            out.append("## 참조하는 보통약관 조문")
            for nid in mains:
                self._emit_node("M", nid, out)
        if self.main_whole:
            out.append(f"## 주계약 약관 준용 표시: 이 담보는 '{self.covs[self.main_whole]['name']}' 약관을 준용한다고 정합니다"
                       "(준용 대상 조문 전체는 입력에 없으며, 위에 실은 조문만 근거로 쓸 수 있습니다).")
        annexes = list(dict.fromkeys(i for i in inp["annex_refs"] if i in self.nodes))
        if annexes:
            out.append("## 참조하는 다른 구간의 별표")
            for nid in annexes:
                self._emit_node("X", nid, out)
            self._emit_tables(set(annexes), out)
        laws = list(dict.fromkeys(i for i in inp["law_refs"] if i in self.nodes))
        if laws:
            out.append("## 참조하는 인용조문(법령)")
            for nid in laws:
                self._emit_node("L", nid, out)
        return "\n".join(out)

    def build(self):
        common = self.common_block()
        own = self.own_block()
        extra = self.extra_block()
        user = (f"# 분석할 담보: {self.cov['name']} ({self.cid}, {self.cov['start']}~{self.cov['end']}쪽, 유형 {self.cov['type']})\n\n"
                f"## 이 담보 구간 전체\n{own}\n\n{extra}")
        return common, user

    def source_of(self, handle):
        """참조 번호의 원문(인용 대조용)과 원본 ID, 쪽."""
        r = self.refs.get(handle)
        if not r:
            return None, None, None
        if r["kind"] == "table":
            t = self.tables[r["id"]]
            return table_text(t), r["id"], t["page"]
        n = self.nodes[r["id"]]
        return full_text(self.nodes, r["id"]), r["id"], n["page_start"]

    def check_evidence(self, evidence):
        """근거 목록을 대조해 원본 ID·쪽을 붙입니다. 모두 확인되면 True."""
        out, ok = [], bool(evidence)
        for e in evidence or []:
            src, oid, page = self.source_of(e.get("ref", ""))
            good = bool(src) and verify_quote(e.get("quote", ""), src)
            ok = ok and good
            out.append({"ref": e.get("ref"), "id": oid, "page": page, "quote": e.get("quote", ""), "verified": good,
                        "kind": (self.refs.get(e.get("ref", "")) or {}).get("kind")})
        return out, ok


def _top(nodes, nid):
    while nodes[nid]["parent"]:
        nid = nodes[nid]["parent"]
    return nid


EVIDENCE_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {"ref": {"type": "string"}, "quote": {"type": "string"}},
        "required": ["ref", "quote"],
        "additionalProperties": False,
    },
}

COMMON_RULES = """공통 규칙(반드시 지킵니다):
- 근거는 입력에 실린 원문만 씁니다. 입력에 없는 내용은 추정하지 않고 "약관에 명시 없음"으로 답합니다.
- 모든 근거(evidence)는 ref에 입력의 참조 번호(예: N12, C3, M2, L1, X1, T2)를, quote에 그 원문에서 글자 그대로 복사한 한두 문장을 적습니다. 요약·바꿔쓰기·생략 부호를 넣지 않습니다.
- 표(T번호)의 수치와 지급률은 풀어 쓰지 않고 "T2 표 참조"처럼 표 번호로 가리킵니다.
- 해석이 갈릴 수 있으면 하나로 단정하지 않고 가능한 해석을 모두 적습니다.
- 한국어로, 실무자가 읽기 쉬운 완결된 문장으로 씁니다."""
