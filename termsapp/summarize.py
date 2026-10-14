"""3단계: 담보별 요약(결과 카드). Claude API로 해석하고, 모든 근거 인용문을 원문과 문자열 대조합니다.

원칙
 - 승인된 1단계 결과만 입력으로 씁니다. 약관 전체를 보내지 않습니다.
 - 담보 하나씩: 그 담보의 조문 범위 + 그 범위가 참조하는 조문·표 + 용어 정의 조문만 보냅니다.
 - 출력은 정해진 JSON 스키마로만 받고, 모든 항목에 근거 조문 ID와 원문 인용문을 붙입니다.
 - 인용문이 그 조문 원문(하위 항·호·표 포함)에 실제로 없으면 '근거 불일치'로 격리합니다.
 - API 키는 서버의 환경변수 ANTHROPIC_API_KEY로만 읽습니다.
"""
import hashlib
import json
import os
import re

MODEL = "claude-opus-5-5"
EFFORT = "high"

A_FIELDS = [
    ("pay_reason", "지급사유"),
    ("amount", "지급금액과 산식"),
    ("limits", "지급횟수와 한도(1회·연간·통산)"),
    ("coverage_start", "보장개시일"),
    ("exemption_period", "면책기간"),
    ("reduction", "감액기간과 감액비율"),
    ("term_renewal", "보험기간과 갱신 여부"),
    ("exclusions", "지급하지 않는 사유"),
    ("definitions", "요건의 세부 정의(진단확정·입원일수 등)"),
    ("after_payment", "지급 후 계약 소멸·납입면제·가입금액 감액 여부"),
]
B_CATEGORIES = ["별표 참조", "산출에 영향을 주는 용어 정의", "단서·예외에 따른 조건 분기", "다른 담보와의 중복지급·택일",
                "경과기간·연령·성별별 지급률 차이", "기준일 판단", "기타"]

_EVIDENCE = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "node_id": {"type": "string", "description": "입력에 [ID]로 표시된 조문 ID를 그대로"},
            "quote": {"type": "string", "description": "그 조문 원문에서 그대로 옮긴 한두 문장(고치거나 줄이지 말 것)"},
        },
        "required": ["node_id", "quote"],
        "additionalProperties": False,
    },
}
_FIELD = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["명시", "약관에 명시 없음", "해석 확인 필요"]},
        "value": {"type": "string", "description": "약관 내용을 근거로 한 요약. 명시 없음이면 빈 문자열"},
        "interpretations": {"type": "array", "items": {"type": "string"},
                            "description": "해석 확인 필요일 때 가능한 해석들"},
        "evidence": _EVIDENCE,
    },
    "required": ["status", "value", "interpretations", "evidence"],
    "additionalProperties": False,
}
SCHEMA = {
    "type": "object",
    "properties": {
        "A": {"type": "object", "properties": {k: _FIELD for k, _ in A_FIELDS},
              "required": [k for k, _ in A_FIELDS], "additionalProperties": False},
        "B": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "category": {"type": "string", "enum": B_CATEGORIES},
                "content": {"type": "string"},
                "needs_confirmation": {"type": "boolean"},
                "interpretations": {"type": "array", "items": {"type": "string"}},
                "evidence": _EVIDENCE,
            },
            "required": ["category", "content", "needs_confirmation", "interpretations", "evidence"],
            "additionalProperties": False,
        }},
        "tables_referenced": {"type": "array", "items": {"type": "string"},
                              "description": "산출에 필요한 별표·표의 ID(예: S023|별표2-1 또는 T0121)"},
    },
    "required": ["A", "B", "tables_referenced"],
    "additionalProperties": False,
}

SYSTEM = """당신은 생명보험 보험금 심사 전산화(자동산출 룰 입력)를 돕는 약관 분석 보조자입니다.
입력으로 한 담보의 약관 조문, 그 조문이 참조하는 조문·표, 용어 정의 조문이 주어집니다. 조문마다 [ID]가 붙어 있습니다.

규칙
1. 입력된 조문만 근거로 씁니다. 일반 상식이나 다른 상품의 관행으로 채우지 않습니다.
2. 약관에서 찾지 못한 항목은 추정하지 말고 status를 "약관에 명시 없음"으로, value를 빈 문자열로, evidence를 빈 배열로 둡니다.
3. 근거가 있는 항목은 evidence에 node_id(입력의 [ID] 그대로)와 quote(그 조문 원문을 한 글자도 바꾸지 않고 옮긴 한두 문장)를 넣습니다. 인용문은 프로그램이 원문과 문자열로 대조하므로 요약·의역·생략 부호를 쓰지 않습니다. 표 안의 글자를 인용할 때는 표가 들어 있는 조문 ID를 씁니다.
4. 별표 안의 수치와 지급률은 풀어 쓰지 않습니다. value에는 "별표2-1 보험금 지급기준표에 따름"처럼 표 이름만 적고, tables_referenced에 그 별표·표 ID를 넣습니다.
5. 해석이 갈릴 수 있으면 status를 "해석 확인 필요"로 하고 interpretations에 가능한 해석을 모두 적습니다.
6. B에는 전산화(룰 입력) 때 주의할 점을 적습니다: 별표 참조와 표 이름, 산출에 영향을 주는 용어 정의, "다만" 단서와 예외의 예외로 생기는 조건 분기, 다른 담보와의 중복지급·택일, 경과기간·연령·성별별 지급률 차이, 기준일(사고일·진단일·입원개시일·수술일) 판단.
7. 한국어로, 완결된 문장으로 씁니다."""


class SummarizeError(Exception):
    pass


def norm(s):
    """대조용 정규화: 공백·줄바꿈을 모두 지웁니다(원문 글자는 바꾸지 않음)."""
    return re.sub(r"\s+", "", s or "")


# ---------------------------------------------------------------- 입력 구성

def _table_text(t):
    rows = [" | ".join(c.replace("\n", " ") for c in r) for r in t["rows"]]
    return f"[표 {t['id']} | {t['page']}쪽]\n" + "\n".join(rows)


def build_input(item, terms, tables, common_sections):
    """담보 하나의 입력(조문 블록 목록)을 만듭니다.

    돌려주는 값: (공통 블록 텍스트, 담보 블록 텍스트, 입력에 들어간 조각 cid 목록)
    """
    nodes = terms["nodes"]
    by_cid = {n["cid"]: n for n in nodes}
    by_uid = {n["uid"]: n for n in nodes}
    tables_by_id = {t["id"]: t for t in tables}
    children = {}
    for n in nodes:
        children.setdefault(n["parent"], []).append(n)

    def top_of(n):
        """참조 대상을 조문(또는 별표) 단위로 올립니다."""
        while n["parent"] and n["kind"] not in ("article", "appendix"):
            n = by_uid[n["parent"]]
        return n

    def subtree(n):
        out = [n]
        for c in children.get(n["uid"], []):
            out += subtree(c)
        return out

    sec = item["range"]["section"]
    own = [n for n in nodes if n["section"] == sec and n["kind"] not in ("part", "chapter", "section")]
    own_uids = {n["uid"] for n in own}
    referenced = []
    for r in terms["refs"]:
        if r["from_uid"] in own_uids and r["status"] == "연결":
            for t in r["target"]:
                tn = by_cid.get(t)
                if tn and tn["section"] != sec:
                    top = top_of(tn)
                    if top["uid"] not in {x["uid"] for x in referenced}:
                        referenced.append(top)
    common_ids = {c["section"] for c in common_sections}
    definitions = [n for n in nodes if n["kind"] == "article" and "정의" in n["title"]
                   and (n["section"] in common_ids or n["section"] == sec)]

    def render(group):
        lines, cids = [], []
        for top in group:
            for n in subtree(top):
                if n["uid"] in seen:
                    continue
                seen.add(n["uid"])
                cids.append(n["cid"])
                text = n["text"]
                for tid in re.findall(r"\[표 (T\d+)\]", text):
                    if tid in tables_by_id:
                        text = text.replace(f"[표 {tid}]", "\n" + _table_text(tables_by_id[tid]))
                head = f"[{n['cid']}] ({n['path']}, {n['own_page_start']}쪽)"
                if n["kind"] == "note":
                    head += " ※해설 상자"
                lines.append(head + "\n" + text)
        return "\n\n".join(lines), cids

    seen = set()
    common_defs = [d for d in definitions if d["section"] != sec]
    common_text, c1 = render(common_defs)
    own_tops = [n for n in own if n["parent"] is None or by_uid[n["parent"]]["kind"] in ("part", "chapter", "section")]
    own_text, c2 = render(own_tops)
    ref_text, c3 = render([r for r in referenced if r["section"] not in common_ids or r not in common_defs])
    item_text = (f"■ 담보: {item['name']} (특약: {item['section_title']}, 지급기준표 급부 그룹: {item['group']})\n"
                 f"■ 지급기준표의 지급사유 원문: {item['pay_reason'] or '없음'}\n"
                 f"■ 지급기준표의 지급금액 원문: {item['pay_amount'] or '없음'}\n\n"
                 f"=== 이 담보가 속한 특약의 조문 ===\n{own_text}\n\n"
                 f"=== 위 조문이 참조하는 다른 구간의 조문 ===\n{ref_text or '없음'}")
    common_block = f"=== 공통 용어 정의 조문 ===\n{common_text or '없음'}"
    return common_block, item_text, c1 + c2 + c3


# ---------------------------------------------------------------- 인용 대조

def verification_text(n, children, tables_by_id):
    """조문 원문(하위 항·호·목·해설과 표 칸 포함)"""
    parts = [n["text"]]
    for tid in re.findall(r"\[표 (T\d+)\]", n["text"]):
        if tid in tables_by_id:
            parts.append(" ".join(c for r in tables_by_id[tid]["rows"] for c in r))
    for c in children.get(n["uid"], []):
        parts.append(verification_text(c, children, tables_by_id))
    return "\n".join(parts)


def locate_quote(n, quote, pages, tables_by_id=None):
    """인용문이 시작·끝나는 줄을 찾아 쪽·좌표를 돌려줍니다(원본 강조용). 표 칸 인용이면 표 영역을 돌려줍니다."""
    lines = n["text"].split("\n")
    geo = n["lines"]
    q = norm(quote)
    for tid in re.findall(r"\[표 (T\d+)\]", n["text"]):
        t = (tables_by_id or {}).get(tid)
        if t and q and q in norm(" ".join(c for r in t["rows"] for c in r)) and q not in norm(n["text"]):
            return {"page": t["page"], "printed_page": pages[t["page"] - 1].get("printed_page"),
                    "boxes": [{"p": t["page"], "bbox": t["bbox"]}], "table": tid}
    flat, owners = "", []
    for i, l in enumerate(lines):
        s = norm(l)
        flat += s
        owners += [i] * len(s)
    k = flat.find(q[: max(8, min(len(q), 30))]) if q else -1
    if k < 0 or len(geo) != len(lines):
        p = n["own_page_start"]
        return {"page": p, "printed_page": pages[p - 1].get("printed_page") if p else None, "boxes": []}
    a, b = owners[k], owners[min(len(owners) - 1, k + len(q) - 1)]
    hit = geo[a:b + 1]
    p = hit[0]["p"]
    return {"page": p, "printed_page": pages[p - 1].get("printed_page"),
            "boxes": [{"p": g["p"], "bbox": g["bbox"]} for g in hit]}


def verify(result, terms, tables, pages, input_cids):
    """모든 인용문을 원문과 대조합니다. 하나라도 어긋난 항목은 '근거 불일치'로 격리합니다."""
    nodes = terms["nodes"]
    by_cid = {n["cid"]: n for n in nodes}
    children = {}
    for n in nodes:
        children.setdefault(n["parent"], []).append(n)
    tables_by_id = {t["id"]: t for t in tables}
    allowed = set(input_cids)
    cache = {}

    def check(evs):
        out, ok = [], True
        for e in evs:
            n = by_cid.get(e["node_id"])
            reason = ""
            if n is None:
                reason = "입력에 없는 조문 ID"
            elif e["node_id"] not in allowed:
                reason = "이 담보의 입력에 포함되지 않은 조문"
            else:
                if n["uid"] not in cache:
                    cache[n["uid"]] = norm(verification_text(n, children, tables_by_id))
                if not norm(e["quote"]) or norm(e["quote"]) not in cache[n["uid"]]:
                    reason = "인용문이 조문 원문에 없음"
            item = dict(e, matched=not reason, reason=reason)
            if n is not None:
                item.update({"path": n["path"]} | locate_quote(n, e["quote"], pages, tables_by_id))
            ok = ok and not reason
            out.append(item)
        return out, ok

    card = {"A": [], "B": [], "mismatch": [], "tables": []}
    for key, label in A_FIELDS:
        f = result["A"][key]
        evs, ok = check(f["evidence"])
        entry = {"key": key, "label": label, "status": f["status"], "value": f["value"],
                 "interpretations": f["interpretations"], "evidence": evs}
        if f["status"] != "약관에 명시 없음" and not evs:
            ok = False
            entry["mismatch_reason"] = "근거 인용이 없음"
        if ok:
            card["A"].append(entry)
        else:
            entry.setdefault("mismatch_reason", "근거 인용문이 원문과 일치하지 않음")
            card["A"].append({"key": key, "label": label, "status": "근거 불일치", "value": "", "interpretations": [],
                              "evidence": []})
            card["mismatch"].append(dict(entry, section="A"))
    for b in result["B"]:
        evs, ok = check(b["evidence"])
        entry = dict(b, evidence=evs)
        if not evs:
            ok = False
            entry["mismatch_reason"] = "근거 인용이 없음"
        if ok:
            card["B"].append(entry)
        else:
            entry.setdefault("mismatch_reason", "근거 인용문이 원문과 일치하지 않음")
            card["mismatch"].append(dict(entry, section="B", label=b["category"]))
    for ref in result["tables_referenced"]:
        ref = ref.strip()
        tids = []
        if re.fullmatch(r"T\d+", ref):
            tids = [ref]
        elif ref in by_cid:
            tids = re.findall(r"\[표 (T\d+)\]", verification_text(by_cid[ref], children, {}))
        card["tables"].append({"ref": ref, "known": bool(tids) or ref in by_cid, "table_ids": tids})
    return card


# ---------------------------------------------------------------- 호출

def api_key_present():
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def call_claude(common_block, item_block, client=None):
    """Claude를 한 번 호출해 스키마에 맞는 JSON을 돌려받습니다."""
    import anthropic

    client = client or anthropic.Anthropic()
    try:
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=64000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": SCHEMA}},
            system=SYSTEM,
            messages=[{"role": "user", "content": [
                # 공통 용어 정의는 담보마다 같으므로 캐시합니다.
                {"type": "text", "text": common_block, "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": item_block + "\n\n위 조문만 근거로 이 담보의 결과 카드를 스키마에 맞춰 작성하십시오."},
            ]}],
        ) as stream:
            msg = stream.get_final_message()
    except anthropic.AuthenticationError:
        raise SummarizeError("API 키가 올바르지 않습니다(ANTHROPIC_API_KEY 확인).")
    except anthropic.RateLimitError:
        raise SummarizeError("API 사용 한도에 걸렸습니다. 잠시 후 다시 실행하십시오.")
    except anthropic.APIStatusError as e:
        raise SummarizeError(f"API 오류 {e.status_code}: {e.message}")
    except anthropic.APIConnectionError:
        raise SummarizeError("api.anthropic.com에 연결하지 못했습니다(외부망 연결 확인).")
    if msg.stop_reason == "refusal":
        raise SummarizeError("모델이 응답을 거절했습니다.")
    if msg.stop_reason == "max_tokens":
        raise SummarizeError("응답이 길이 한도에서 잘렸습니다.")
    text = next((b.text for b in msg.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        raise SummarizeError("응답이 정해진 JSON 형식이 아닙니다.")
    usage = {"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens,
             "cache_read_input_tokens": getattr(msg.usage, "cache_read_input_tokens", 0) or 0}
    return data, {"model": msg.model, "usage": usage, "request_id": getattr(msg, "_request_id", "")}


def summarize_item(item, terms, tables, pages, common_sections, client=None, caller=call_claude):
    common_block, item_block, cids = build_input(item, terms, tables, common_sections)
    data, meta = caller(common_block, item_block, client)
    card = verify(data, terms, tables, pages, cids)
    digest = hashlib.sha256((common_block + item_block).encode("utf-8")).hexdigest()[:16]
    return {"item_id": item["id"], "item_name": item["name"], "input_digest": digest,
            "input_chars": len(common_block) + len(item_block), "input_ids": cids, "raw": data,
            "card": card, "meta": meta}
