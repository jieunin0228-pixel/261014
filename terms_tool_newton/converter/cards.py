"""3단계: 담보별 결과 카드(보장 세부조건 A, 전산화 주의사항 B, 근거 C).

담보 하나씩 분석 입력(ai.Bundle)만 Claude에 보내고 정해진 JSON 스키마로 받습니다.
근거 인용이 원문과 맞지 않는 항목은 "근거 불일치"로 격리하여 결과에 섞지 않습니다.
"""
from __future__ import annotations

import datetime as dt

from . import ai, pipeline

A_FIELDS = ["지급사유", "지급금액과 산식", "지급횟수와 한도", "보장개시일", "면책기간", "감액기간과 감액비율",
            "보험기간과 갱신 여부", "지급하지 않는 사유", "요건의 세부 정의", "지급 후 처리(특약 소멸·납입면제·가입금액 감액)"]
B_TOPICS = ["별표 참조와 표 이름", "산출에 영향을 주는 용어 정의", "단서·예외에 따른 분기", "다른 담보와의 중복지급·택일",
            "경과기간·연령·성별별 지급률 차이", "기준일 판단(사고일·진단일·입원개시일·수술일)", "기타 주의사항"]

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {"type": "array", "items": {"type": "object", "properties": {
            "field": {"type": "string", "enum": A_FIELDS},
            "content": {"type": "string"},
            "status": {"type": "string", "enum": ["명시", "약관에 명시 없음"]},
            "evidence": ai.EVIDENCE_SCHEMA,
        }, "required": ["field", "content", "status", "evidence"], "additionalProperties": False}},
        "cautions": {"type": "array", "items": {"type": "object", "properties": {
            "topic": {"type": "string", "enum": B_TOPICS},
            "content": {"type": "string"},
            "needs_interpretation": {"type": "boolean"},
            "interpretations": {"type": "array", "items": {"type": "string"}},
            "evidence": ai.EVIDENCE_SCHEMA,
        }, "required": ["topic", "content", "needs_interpretation", "interpretations", "evidence"],
            "additionalProperties": False}},
        "tables": {"type": "array", "items": {"type": "object", "properties": {
            "ref": {"type": "string"}, "use": {"type": "string"}},
            "required": ["ref", "use"], "additionalProperties": False}},
    },
    "required": ["items", "cautions", "tables"],
    "additionalProperties": False,
}

SYSTEM = f"""당신은 생명보험사 보험금심사팀에서 신약관의 보험금 자동산출 룰을 입력하는 담당자를 돕는 약관 분석가입니다.
입력으로 담보(특약) 하나의 약관 원문과, 그 담보가 참조하는 특약 공통 조항·보통약관 조문·별표·인용조문만 받습니다.
결과는 담당자가 ECS에 룰을 입력할 때 보는 참고자료이며, 사람이 원문과 대조해 검토합니다.

해야 할 일:
A. 보장 세부조건(items): 다음 항목을 각각 한 번 이상 답합니다. 담보에 급부가 여럿이면 급부별로 항목을 나누어도 됩니다.
   {", ".join(A_FIELDS)}
   - 지급금액은 산식(예: 보험가입금액의 100%)과 감액 조건을 함께 적습니다.
   - 지급횟수·한도는 1회·연간·통산 구분을 밝힙니다.
   - 진단확정·입원일수 등 요건의 세부 정의, 지급 후 특약 소멸·납입면제·가입금액 감액 여부를 적습니다.
   - 근거를 찾지 못한 항목은 status를 "약관에 명시 없음"으로, content에 무엇을 찾지 못했는지 적고 evidence는 빈 목록으로 둡니다.
B. 전산화 시 주의사항(cautions): {", ".join(B_TOPICS)}
   - "다만" 단서와 예외의 예외로 생기는 분기, 다른 담보와의 중복지급·택일, 경과기간(예: 계약일부터 1년 미만 50%)·연령·성별별 지급률 차이,
     기준일(사고일·진단일·입원개시일·수술일) 판단을 빠짐없이 봅니다.
   - 해석이 갈릴 수 있으면 needs_interpretation을 true로 하고 interpretations에 가능한 해석을 모두 적습니다.
C. tables: 산출에 쓰이는 표의 참조 번호(T번호)와 용도를 적습니다. 표 안의 수치는 옮겨 적지 않습니다.

{ai.COMMON_RULES}"""


def now():
    return dt.datetime.now().isoformat(timespec="seconds")


def load(doc_id):
    return pipeline.read_json(doc_id, "cards.json", {}) or {}


def save(doc_id, data):
    pipeline.write_json(doc_id, "cards.json", data)


def analyze(doc_id, cid):
    """담보 하나를 분석해 카드를 만듭니다(승인 확인은 호출하는 쪽에서)."""
    b = ai.Bundle(doc_id, cid)
    common, user = b.build()
    system = [{"type": "text", "text": SYSTEM}]
    if common:
        # 특약 공통 조항은 같은 문서의 모든 특약에서 같으므로 캐시합니다.
        system.append({"type": "text", "text": "# 특약 공통 조항(제1편 일반사항)\n" + common,
                       "cache_control": {"type": "ephemeral"}})
    out, meta = ai.call_json(system, user, SCHEMA, effort="high")
    items, isolated = [], []
    for k, it in enumerate(out.get("items", [])):
        ev, ok = b.check_evidence(it.get("evidence"))
        rec = {"id": f"A{k + 1}", "field": it["field"], "content": it["content"], "status": it["status"], "evidence": ev,
               "review": "미검토"}
        if it["status"] == "약관에 명시 없음":
            rec["check"] = "약관에 명시 없음"
            items.append(rec)
        elif ok:
            rec["check"] = "근거 확인"
            items.append(rec)
        else:
            rec["check"] = "근거 불일치"
            isolated.append(rec)
    answered = {i["field"] for i in items}
    iso_fields = {i.get("field") for i in isolated}
    for f in A_FIELDS:
        if f not in answered:
            if f in iso_fields:
                content, check = "AI 답의 근거 인용이 원문과 맞지 않아 격리했습니다. 원본을 직접 확인하세요.", "근거 불일치로 격리"
            else:
                content, check = "AI 응답에 이 항목이 없습니다.", "AI 미응답"
            items.append({"id": f"A{len(items) + len(isolated) + 1}", "field": f, "content": content,
                          "status": "약관에 명시 없음", "evidence": [], "check": check, "review": "미검토"})
    cautions = []
    for k, c in enumerate(out.get("cautions", [])):
        ev, ok = b.check_evidence(c.get("evidence"))
        rec = {"id": f"B{k + 1}", "topic": c["topic"], "content": c["content"],
               "needs_interpretation": c["needs_interpretation"], "interpretations": c.get("interpretations") or [],
               "evidence": ev, "review": "미검토", "check": "근거 확인" if ok else "근거 불일치"}
        (cautions if ok else isolated).append(rec)
    tables = []
    for t in out.get("tables", []):
        r = b.refs.get(t.get("ref", ""))
        if r and r["kind"] == "table":
            tables.append({"table": r["id"], "use": t.get("use", "")})
    # 지급기준표는 AI가 빠뜨려도 항상 보여 줍니다.
    bt = b.cov["key"].get("benefit_table")
    for tid in b.cov["tables"]:
        if b.tables[tid]["owner"] == bt and all(x["table"] != tid for x in tables):
            tables.append({"table": tid, "use": "보험금 지급기준표(자동 첨부)"})
    approval = pipeline.read_json(doc_id, "approval.json", {}) or {}
    card = {"cid": cid, "name": b.cov["name"], "generated_at": now(), "approval_at": approval.get("at"), "meta": meta,
            "items": items, "cautions": cautions, "isolated": isolated, "tables": tables,
            "input": {"refs": len(b.refs), "common_whole": bool(b.common_cid), "main_whole": bool(b.main_whole)}}
    data = load(doc_id)
    data[cid] = card
    save(doc_id, data)
    return card


def run(doc_id, cids, user="", progress=None):
    if not pipeline.is_approved(doc_id):
        raise PermissionError("1단계 변환이 승인되지 않아 AI 해석을 실행할 수 없습니다.")
    if not ai.available():
        raise RuntimeError("ANTHROPIC_API_KEY 환경변수가 없어 AI 해석을 실행할 수 없습니다.")
    errors = []
    for k, cid in enumerate(cids):
        if progress:
            progress("3단계 결과 카드 생성", k / len(cids), f"{k + 1}/{len(cids)} {cid}")
        try:
            analyze(doc_id, cid)
        except Exception as e:  # 한 담보가 실패해도 나머지는 계속합니다.
            errors.append(f"{cid}: {type(e).__name__}: {e}")
    pipeline._history(doc_id, "3단계 결과 카드 생성", {"cids": cids, "errors": errors}, user)
    if errors and len(errors) == len(cids):
        raise RuntimeError("; ".join(errors[:3]))
    return errors


def set_review(doc_id, cid, item_id, status, user=""):
    if status not in ("미검토", "검토완료"):
        raise ValueError(status)
    data = load(doc_id)
    card = data[cid]
    for sec in ("items", "cautions"):
        for it in card[sec]:
            if it["id"] == item_id:
                it["review"], it["review_at"], it["review_user"] = status, now(), user
    save(doc_id, data)
    return card
