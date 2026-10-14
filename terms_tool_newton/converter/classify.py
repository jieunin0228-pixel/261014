"""2단계: 담보 분류 트리(대·중·소).

- 입력은 변환 승인(approval)이 된 1단계 결과만 씁니다. 승인되지 않은 문서에는 실행하지 않습니다.
- 대분류는 사망·장해·진단·입원·치료·기타로 고정합니다.
- 중분류·소분류는 담보명과 지급사유 조문을 보고 자동 구성합니다.
  · 규칙 분류: 담보명·지급사유 조문의 낱말로 정하며 AI를 쓰지 않습니다(기본).
  · AI 분류 제안: Claude API(선택). 담보명·지급사유 조문·지급기준표 급부명만 보냅니다.
    모든 제안에는 근거 조문 ID와 원문 인용이 있어야 하며, 인용이 해당 조문 원문에 실제로 있는지
    문자열 대조로 확인합니다. 맞지 않으면 "근거 불일치"로 표시하고 적용 대상에서 뺍니다.
- 이전 약관에서 사람이 정한 분류는 data/_memory/classification_memory.json에 기억해 두고 먼저 적용합니다.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re

from . import pipeline
from .extract import norm_text

MAJORS = ["사망", "장해", "진단", "입원", "치료", "기타"]
CLASSIFY_TYPES = {"보통약관", "개별특약", "납입면제류", "서비스·인수·전환류", "미분류"}
MEMORY_FILE = "classification_memory.json"


def now():
    return dt.datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------- 입력 구성

def short_name(name):
    """'R(무)일반암진단특약(갱신형)(간편심사형)' → '일반암진단' 처럼 상품 공통 꼬리표를 뗍니다."""
    s = re.sub(r"\s+", "", name)
    s = re.sub(r"^R?\(무\)", "", s)
    s = re.sub(r"\((갱신형|비갱신형|간편심사형|간편고지형|일반심사형|무해지환급형|해약환급금미지급형)\)", "", s)
    s = re.sub(r"특약", "", s)
    s = re.sub(r"보장$", "", s) if s.endswith("보장") and len(s) > 4 else s
    return s or name


def memory_key(name):
    return norm_text(short_name(name))


def build_items(doc_id):
    """분류 대상 담보와 근거 원문(지급사유 조문, 지급기준표 급부명)을 모읍니다."""
    cmap = pipeline.read_json(doc_id, "coverage_map.json")
    terms = pipeline.read_json(doc_id, "terms.json")
    tables = {t["id"]: t for t in pipeline.read_json(doc_id, "tables.json")["tables"]}
    nodes = terms["nodes"]
    items = []
    for c in cmap["coverages"]:
        if c["type"] not in CLASSIFY_TYPES:
            continue
        pid = c["key"]["payout"]
        ptxt = full_text(nodes, pid) if pid else ""
        benefits = []
        bt = c["key"].get("benefit_table")
        for tid in c["tables"]:
            t = tables.get(tid)
            if not t or t["owner"] != bt or not t["grid"]:
                continue
            head = [norm_text(x or "") for x in t["grid"][0]]
            col = next((j for j, h in enumerate(head) if "급부명" in h), None)
            if col is None:
                continue
            for r in t["grid"][1:]:
                v = r[col] if col < len(r) else None
                if v:
                    v = re.sub(r"\s*\n\s*", " ", v).strip()
                    v = re.sub(r"\s*\(제[\d\-]+조(의\d+)?\)$", "", v)
                    if v and v not in benefits:
                        benefits.append(v)
        items.append({"cid": c["cid"], "name": c["name"], "short": short_name(c["name"]), "type": c["type"],
                      "payout_id": pid, "payout_key": nodes[pid]["key"] if pid else None,
                      "payout_page": nodes[pid]["page_start"] if pid else None,
                      "payout_text": ptxt, "benefits": benefits, "start": c["start"]})
    return items


def full_text(nodes, nid):
    n = nodes[nid]
    parts = []
    if n["kind"] in ("article", "annex"):
        parts.append(f"{n['key']}【{n.get('title', '')}】")
    if n["text"]:
        lead = {"item": n["key"] + ". ", "sub": n["key"] + ". ", "para": n["key"] + " ", "subsub": n["key"] + " "}.get(n["kind"], "")
        parts.append(lead + n["text"])
    for c in n["children"]:
        parts.append(full_text(nodes, c))
    return "\n".join(p for p in parts if p)


# ---------------------------------------------------------------- 규칙 분류

MID_RULES = [  # (중분류, 담보명 정규식) — 위에서부터 먼저 맞는 것
    ("납입면제", r"납입면제"),
    ("서비스·인수·전환", r"(서비스|인수|전환)$|지정대리"),
    ("특정질병", r"양성신생물"),
    ("뇌·심장", r"뇌.*심장|심장.*뇌|순환계"),
    ("암", r"암|신생물|종양|항암"),
    ("뇌혈관", r"뇌졸중|뇌출혈|뇌경색|뇌혈관"),
    ("심장", r"심장|심근|부정맥|관상동맥|대동맥|판막|허혈"),
    ("재해", r"재해|골절"),
    ("특정질병", r"간경변|대상포진|통풍|갑상선기능|뇌전증|6대질병|조혈모|장기이식"),
    ("질병", r"질병"),
]

MINOR_RULES = {
    "사망": [("재해사망", r"재해사망"), ("일반사망", r".")],
    "장해": [("3~100% 장해", r"3~100"), ("50% 이상 장해", r"50%이상|50%"), ("80% 이상 장해", r"80%")],
    "진단": [("산정특례", r"산정특례"), ("전이암", r"전이"), ("고액암", r"고액"), ("소액암", r"소액"),
             ("3대·주요암", r"3대|주요암"), ("남녀특정암", r"남녀"), ("일반암", r"일반암"),
             ("뇌졸중", r"뇌졸중"), ("뇌출혈", r"뇌출혈"), ("뇌혈관질환", r"뇌혈관"),
             ("급성심근경색증", r"급성심근경색"), ("허혈성심장질환", r"허혈"), ("부정맥", r"부정맥")],
    "입원": [("중환자실", r"중환자실"), ("상급종합병원", r"상급종합"), ("종합병원", r"종합병원"),
             ("요양병원", r"요양병원(?!제외)"), ("간병·간호", r"간병|간호"), ("일반 입원", r".")],
    "치료": [("로봇수술", r"다빈치|로봇"), ("방사선치료", r"방사선|양성자|중입자"),
             ("약물치료", r"약물|호르몬|면역항암|표적항암"), ("주요치료", r"주요치료"),
             ("통원", r"통원"), ("검사", r"검사|생검|촬영|조영술|MRI|PET"),
             ("혈전용해치료", r"혈전용해"), ("응급실", r"응급실"), ("골절·깁스", r"골절|깁스"),
             ("이식수술", r"이식"), ("수술", r"수술"), ("기타 치료", r".")],
    "기타": [("납입면제", r"납입면제"), ("서비스·인수·전환", r"(서비스|인수|전환)$|지정대리"), ("기타", r".")],
}


def _sentence_with(text, word):
    """조문 원문에서 낱말이 들어 있는 문장 하나를 그대로 돌려줍니다(인용 근거용)."""
    flat = text.replace("\n", "")
    i = flat.find(word)
    if i < 0:
        return None
    s = max(flat.rfind(".", 0, i), flat.rfind("】", 0, i)) + 1
    e = flat.find(".", i)
    e = len(flat) if e < 0 else e + 1
    return flat[s:e].strip()[:200]


def rule_classify(it):
    nm = norm_text(it["short"])
    ptxt = it["payout_text"] or ""
    ev = None
    if it["type"] == "서비스·인수·전환류" or re.search(r"납입면제|(서비스|인수|전환)$|지정대리", nm):
        major, why = "기타", "납입면제·서비스·인수·전환 성격의 특약"
    elif "사망" in nm:
        major, why = "사망", "담보명에 '사망'"
    elif "장해" in nm:
        major, why = "장해", "담보명에 '장해'"
    elif re.search(r"입원|간병|간호", nm):
        major, why = "입원", "담보명에 '입원·간병·간호'"
    elif re.search(r"검사|생검|촬영|조영술", nm):
        major, why = "치료", "담보명에 '검사·생검·촬영·조영술'(영상진단 검사지원 포함)"
    elif re.search(r"진단|산정특례", nm):
        major, why = "진단", "담보명에 '진단' 또는 '산정특례'"
    elif re.search(r"수술|치료|통원|검사|응급실|깁스|이식|혈전|약물|방사선|생검|촬영|조영술", nm):
        major, why = "치료", "담보명에 치료 관련 낱말(수술·치료·통원·검사 등)"
    else:
        # 담보명으로 정하지 못하면 지급사유 조문의 표현을 봅니다.
        major, why = "기타", "담보명과 지급사유 조문에서 대분류 낱말을 찾지 못함"
        for maj, word in (("사망", "사망"), ("장해", "장해"), ("진단", "진단확정"), ("입원", "입원"),
                          ("치료", "수술"), ("치료", "치료")):
            q = _sentence_with(ptxt, word)
            if q:
                major, why = maj, f"지급사유 조문({it['payout_key']})의 '{word}' 표현"
                ev = {"node": it["payout_id"], "quote": q}
                break
    mid = next((m for m, rx in MID_RULES if re.search(rx, nm)), None)
    if mid is None:
        mid = "질병·재해 공통" if major != "기타" else "기타"
    if major == "기타" and mid in ("납입면제", "서비스·인수·전환"):
        minor = re.sub(r"납입면제$", "", short_name(it["name"])) or short_name(it["name"])
    else:
        minor = next((m for m, rx in MINOR_RULES[major] if re.search(rx, nm)), short_name(it["name"]))
    reason = f"{why} → {major}; 중분류 '{mid}', 소분류 '{minor}' (담보명 '{it['short']}' 기준)"
    if major == "기타":
        reason = "기타로 분류: " + reason
    return {"major": major, "mid": mid, "minor": minor, "reason": reason, "evidence": ev, "source": "규칙"}


# ---------------------------------------------------------------- 저장·기억

def memory_path():
    d = os.path.join(pipeline.ROOT, "_memory")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, MEMORY_FILE)


def load_memory():
    p = memory_path()
    if not os.path.exists(p):
        return {}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def remember(doc_id, item, user=""):
    mem = load_memory()
    mem[memory_key(item["name"])] = {"major": item["major"], "mid": item["mid"], "minor": item["minor"],
                                     "display_name": item.get("display_name"), "name": item["name"],
                                     "doc": doc_id, "at": now(), "user": user}
    tmp = memory_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(mem, f, ensure_ascii=False, indent=1)
    os.replace(tmp, memory_path())


def load(doc_id):
    return pipeline.read_json(doc_id, "classification.json")


def save(doc_id, data):
    pipeline.write_json(doc_id, "classification.json", data)


def _history(doc_id, what, data, user):
    pipeline._history(doc_id, "분류: " + what, data, user)


class NotApproved(Exception):
    pass


def require_approved(doc_id):
    if not pipeline.is_approved(doc_id):
        raise NotApproved("1단계 변환이 승인되지 않았습니다. 검증 후 [변환 승인]을 먼저 누르세요.")


def generate(doc_id, user="", reset=False):
    """규칙(+기억)으로 분류를 구성합니다. 사용자가 직접 정한 항목은 reset이 아니면 유지합니다."""
    require_approved(doc_id)
    items = build_items(doc_id)
    old = (load(doc_id) or {}).get("items", {}) if not reset else {}
    mem = load_memory()
    out = {}
    for it in items:
        prev = old.get(it["cid"])
        if prev and prev.get("source") in ("사용자", "AI(적용)"):
            out[it["cid"]] = {**prev, "name": it["name"], "short": it["short"]}
            continue
        m = mem.get(memory_key(it["name"]))
        if m and m.get("major") in MAJORS:
            r = {"major": m["major"], "mid": m["mid"], "minor": m["minor"], "evidence": None, "source": "기억",
                 "reason": f"이전 약관의 분류 기억 적용({m.get('at', '')}, {m.get('name', '')})"}
            if m.get("display_name"):
                r["display_name"] = m["display_name"]
        else:
            r = rule_classify(it)
        out[it["cid"]] = {"cid": it["cid"], "name": it["name"], "short": it["short"], "type": it["type"],
                          "payout_id": it["payout_id"], "payout_page": it["payout_page"], "benefits": it["benefits"],
                          "start": it["start"], "review": (prev or {}).get("review", "미검토"),
                          "ai": (prev or {}).get("ai"), **r}
    data = {"generated_at": now(), "approval_at": (pipeline.read_json(doc_id, "approval.json") or {}).get("at"),
            "items": out, "selected": [c for c in ((load(doc_id) or {}).get("selected") or []) if c in out]}
    save(doc_id, data)
    _history(doc_id, "자동 구성" + ("(초기화)" if reset else ""), {"count": len(out)}, user)
    return data


def view(doc_id):
    """화면용: 분류 결과 + 승인 상태(승인 해제 시 경고)."""
    data = load(doc_id)
    appr = pipeline.read_json(doc_id, "approval.json", {}) or {}
    stale = bool(data) and (not appr.get("approved") or appr.get("at") != data.get("approval_at"))
    return {"data": data, "approved": bool(appr.get("approved")), "stale": stale, "majors": MAJORS,
            "ai_available": ai_available()}


def _get(doc_id):
    data = load(doc_id)
    if not data:
        raise KeyError("분류가 아직 없습니다. [자동 구성]을 먼저 누르세요.")
    return data


def move(doc_id, cid, major, mid, minor, user=""):
    if major not in MAJORS:
        raise ValueError("대분류는 사망·장해·진단·입원·치료·기타 중 하나입니다.")
    data = _get(doc_id)
    it = data["items"][cid]
    before = {k: it[k] for k in ("major", "mid", "minor")}
    it.update({"major": major, "mid": mid.strip() or "기타", "minor": minor.strip() or it["short"],
               "source": "사용자", "reason": f"사용자가 분류함({user or '이름 없음'}, {now()}) · 이전: "
               f"{before['major']}/{before['mid']}/{before['minor']}", "review": "미검토"})
    save(doc_id, data)
    remember(doc_id, it, user)
    _history(doc_id, "담보 이동", {"cid": cid, "before": before, "after": {"major": major, "mid": mid, "minor": minor}}, user)
    return data


def rename_item(doc_id, cid, display_name, user=""):
    data = _get(doc_id)
    it = data["items"][cid]
    before = it.get("display_name")
    it["display_name"] = display_name.strip() or None
    save(doc_id, data)
    remember(doc_id, it, user)
    _history(doc_id, "표시 이름 변경", {"cid": cid, "before": before, "after": it["display_name"]}, user)
    return data


def rename_group(doc_id, major, mid, minor, new_name, user=""):
    """중분류(minor 없음) 또는 소분류 이름을 바꿉니다. 그 그룹의 모든 담보에 적용됩니다."""
    new_name = new_name.strip()
    if not new_name:
        raise ValueError("새 이름을 넣으세요.")
    data = _get(doc_id)
    n = 0
    for it in data["items"].values():
        if it["major"] != major or it["mid"] != mid:
            continue
        if minor is None:
            it["mid"] = new_name
        elif it["minor"] == minor:
            it["minor"] = new_name
        else:
            continue
        it["source"] = "사용자"
        it["reason"] = f"사용자가 그룹 이름을 바꿈({user or '이름 없음'}, {now()})"
        remember(doc_id, it, user)
        n += 1
    save(doc_id, data)
    _history(doc_id, "그룹 이름 변경", {"major": major, "mid": mid, "minor": minor, "new": new_name, "count": n}, user)
    return data


def set_selected(doc_id, cids, user=""):
    data = _get(doc_id)
    data["selected"] = [c for c in cids if c in data["items"]]
    save(doc_id, data)
    return data


def set_review(doc_id, cid, status, user=""):
    if status not in ("미검토", "검토완료"):
        raise ValueError(status)
    data = _get(doc_id)
    it = data["items"][cid]
    it["review"] = status
    it["review_at"], it["review_user"] = now(), user
    save(doc_id, data)
    if status == "검토완료":
        remember(doc_id, it, user)
    _history(doc_id, "검토 상태", {"cid": cid, "status": status}, user)
    return data


# ---------------------------------------------------------------- AI 분류 제안 (Claude API)

AI_MODEL = os.environ.get("TERMS_AI_MODEL", "claude-opus-5-5")
AI_BATCH = 20

SYSTEM_PROMPT = """당신은 생명보험 보험금 심사팀의 약관 분류 보조자입니다.
주어진 담보(특약)마다 대분류·중분류·소분류를 제안합니다.

규칙:
- 대분류는 반드시 사망, 장해, 진단, 입원, 치료, 기타 중 하나입니다. 어디에도 맞지 않으면 기타입니다.
- 중분류는 질환군·사고군(예: 암, 뇌혈관, 심장, 뇌·심장, 재해, 질병, 특정질병, 질병·재해 공통, 납입면제)으로,
  소분류는 같은 중분류 안에서 보장 형태를 구분하는 짧은 이름(예: 수술, 로봇수술, 방사선치료, 약물치료,
  통원, 검사, 상급종합병원, 중환자실, 일반암, 고액암)으로 정합니다. 기존 분류 예시가 있으면 그 이름을 그대로 씁니다.
- 판단은 제공된 담보명, 지급사유 조문 원문, 지급기준표 급부명만 근거로 합니다. 제공되지 않은 내용은 추정하지 않습니다.
- evidence_node에는 근거로 쓴 조문 ID(제공된 payout_id)를, 담보명만으로 판단했다면 "담보명"을 적습니다.
- quote에는 근거 원문을 한 문장 이내로, 제공된 원문에서 글자 그대로 복사해 적습니다. 바꾸어 쓰거나 줄이지 않습니다.
- reason은 분류 근거를 한국어 한 문장으로 적습니다."""

SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "cid": {"type": "string"},
                    "major": {"type": "string", "enum": MAJORS},
                    "mid": {"type": "string"},
                    "minor": {"type": "string"},
                    "reason": {"type": "string"},
                    "evidence_node": {"type": "string"},
                    "quote": {"type": "string"},
                },
                "required": ["cid", "major", "mid", "minor", "reason", "evidence_node", "quote"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["results"],
    "additionalProperties": False,
}


def ai_available():
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def _call_claude(system, user_text):
    """Claude API 한 번 호출. 시험에서는 이 함수를 가짜로 바꿉니다."""
    from . import ai
    out, _ = ai.call_json([{"type": "text", "text": system}], user_text, SCHEMA, effort="low", max_tokens=16000)
    return out


def verify_quote(quote, source_text):
    """인용문이 원문에 실제로 들어 있는지 공백·줄바꿈을 무시하고 대조합니다."""
    q = norm_text(quote)
    return bool(q) and q in norm_text(source_text)


def ai_suggest(doc_id, user="", progress=None, cids=None):
    require_approved(doc_id)
    if not ai_available():
        raise RuntimeError("ANTHROPIC_API_KEY 환경변수가 없어 AI 분류를 실행할 수 없습니다.")
    data = _get(doc_id)
    items = [it for it in build_items(doc_id) if not cids or it["cid"] in cids]
    examples = sorted({(v["major"], v["mid"], v["minor"]) for v in load_memory().values()})[:200]
    by_cid = {it["cid"]: it for it in items}
    done = 0
    for k in range(0, len(items), AI_BATCH):
        batch = items[k:k + AI_BATCH]
        payload = [{"cid": it["cid"], "담보명": it["name"], "payout_id": it["payout_id"] or "",
                    "지급사유_조문": it["payout_text"] or "(지급사유 조문 없음)", "지급기준표_급부명": it["benefits"]}
                   for it in batch]
        user_text = ("기존 분류 예시(대/중/소):\n" + json.dumps(examples, ensure_ascii=False) + "\n\n"
                     "분류할 담보:\n" + json.dumps(payload, ensure_ascii=False, indent=1))
        out = _call_claude(SYSTEM_PROMPT, user_text)
        for r in out.get("results", []):
            it = by_cid.get(r.get("cid"))
            if not it:
                continue
            src = it["name"] if r["evidence_node"] == "담보명" else (it["payout_text"] if r["evidence_node"] == it["payout_id"] else "")
            ok = verify_quote(r["quote"], src)
            data["items"][it["cid"]]["ai"] = {
                "major": r["major"], "mid": r["mid"], "minor": r["minor"], "reason": r["reason"],
                "evidence": {"node": r["evidence_node"], "quote": r["quote"]},
                "verified": ok, "status": "근거 확인" if ok else "근거 불일치", "at": now(), "model": AI_MODEL}
        done += len(batch)
        if progress:
            progress("AI 분류 제안", done / len(items), f"{done}/{len(items)}개 담보")
        save(doc_id, data)
    _history(doc_id, "AI 분류 제안", {"count": len(items), "model": AI_MODEL}, user)
    return data


def apply_ai(doc_id, cids, user=""):
    """근거가 확인된 AI 제안만 적용합니다. 근거 불일치 제안은 적용하지 않습니다."""
    data = _get(doc_id)
    applied, skipped = [], []
    for cid in cids:
        it = data["items"].get(cid)
        ai = (it or {}).get("ai")
        if not ai or not ai.get("verified"):
            skipped.append(cid)
            continue
        it.update({"major": ai["major"], "mid": ai["mid"], "minor": ai["minor"], "reason": "AI 제안 적용: " + ai["reason"],
                   "evidence": ai["evidence"] if ai["evidence"]["node"] != "담보명" else None,
                   "source": "AI(적용)", "review": "미검토"})
        applied.append(cid)
    save(doc_id, data)
    _history(doc_id, "AI 제안 적용", {"applied": applied, "skipped(근거 불일치)": skipped}, user)
    return data, applied, skipped
