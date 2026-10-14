"""4단계: ECS "약관분석 데이터 관리" 화면의 룰 입력 항목 초안.

- 필드 순서와 이름은 ECS 화면(상품·청구 / 계산식 / 상세계산식·처리)과 같게 둡니다.
- 각 필드는 "수정 전 / 수정 후" 두 칸입니다. 단일 약관 모드에서는 "수정 후"만 채우고,
  5단계 비교에서 구약관 값을 "수정 전"에 채웁니다.
- 코드와 명칭은 쌍으로 다룹니다. 코드마스터가 있으면 그 안의 값만 코드로 제안하고,
  없으면 코드는 비우고 명칭만 적은 뒤 "코드 확인 필요"로 표시합니다.
- 입력은 3단계에서 근거가 확인된 카드 항목과 같은 분석 입력 묶음(ai.Bundle)입니다.
- 근거 인용이 원문과 맞지 않는 값은 "근거 불일치"로 격리하고 칸을 비웁니다.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import os

from openpyxl import Workbook, load_workbook

from . import ai, cards, pipeline
from .extract import norm_text


def _f(key, label, group, kind="code"):
    return {"key": key, "label": label, "group": group, "kind": kind}


# kind: code(코드+명칭), value(값 하나), user(사용자 직접 입력)
FIELDS = (
    [_f("상품코드", "상품코드", "상품·청구", "user"), _f("상품명", "상품명", "상품·청구", "user"),
     _f("판매개시일자", "판매개시일자", "상품·청구", "user"),
     _f("청구사유", "청구사유", "상품·청구"), _f("사고유형", "사고유형", "상품·청구"),
     _f("구보장급부", "구보장급부", "상품·청구"), _f("사고자유형", "사고자유형", "상품·청구"),
     _f("사인그룹", "사인그룹", "상품·청구")]
    + [_f(f"급부결정조건{i}", f"급부결정조건{i}", "상품·청구") for i in range(1, 7)]
    + [_f("위험급부", "위험급부", "상품·청구")]
    + [_f(f"계산식결정조건{i}", f"계산식결정조건{i}", "계산식") for i in range(1, 7)]
    + [_f("계산구분", "계산구분", "계산식"), _f("계산대상", "계산대상", "계산식"),
       _f("대상테이블", "대상테이블", "계산식", "value"), _f("1구좌기준금액", "1구좌기준금액", "계산식", "value"),
       _f("분자", "분자", "계산식", "value"), _f("분모", "분모", "계산식", "value"),
       _f("적용배수", "적용배수", "계산식", "value"), _f("계산식", "계산식", "계산식", "value")]
    + [_f(f"금액유형{i}", f"금액유형{i}", "계산식") for i in range(1, 6)]
    + [_f(f"상세계산식{i}", f"상세계산식{i}", "상세계산식·처리") for i in range(1, 6)]
    + [_f("계약상태처리", "계약상태처리", "상세계산식·처리"), _f("납면처리", "납면처리", "상세계산식·처리"),
       _f("갱신가능불가", "갱신가능불가", "상세계산식·처리"), _f("장래연금구분", "장래연금구분", "상세계산식·처리"),
       _f("보험투자요소", "보험투자요소", "상세계산식·처리")]
)
FIELD_KEYS = [f["key"] for f in FIELDS]
AI_KEYS = [f["key"] for f in FIELDS if f["kind"] != "user"]
STATUSES = ["값", "약관에 명시 없음", "사용자 입력 필요", "해석 확인 필요"]

# 사용자가 제공한 ECS 화면 예시에서 읽은 행 분리 방식(코드값은 코드마스터가 아니므로 제안에 쓰지 않음)
ROW_SPLIT_EXAMPLE = """기존 ECS 룰 예시(행 분리 기준, 다른 상품의 화면에서 옮김):
- 같은 담보라도 청구사유(사망·장해·진단·수술 등) × 사고유형(일반(질병)·일반재해·교통재해 등)마다 행을 나눕니다.
  예) 재해사망보험금: [사망·일반재해] 행과 [사망·교통재해] 행이 따로 있고, 급부결정조건1이 각각 '사인그룹|일반재해', '사인그룹|교통재해'입니다.
  예) 기타사망보험금: [사망·일반] 행, 급부결정조건1 '사인그룹|질병(암포함)', 급부결정조건2 '기타|주피사망시'.
- 같은 청구사유·사고유형이라도 지급 조건(예: 장해지급률 80% 이상 여부)이 다르면 급부결정조건으로 구분해 행을 나눕니다.
  예) 고도장해보험금: [장해·일반재해] 행이 급부결정조건2 '기타|장해지급율80%이상' 등으로 두 행 이상입니다.
- 진단·수술처럼 사인그룹(질병군)이 정해지는 담보는 사인그룹 코드·명칭을 채우고, 사고유형은 '특정외상성뇌출혈'처럼 진단군으로 둡니다.
- 사고자유형은 보통 '주피'(주피보험자)입니다.
- 계산식 예: 계산구분 '단일식', 계산대상 '가입금액2', 분자 300000, 분모 1000, 계산식 'Math.max([가입금액]…)',
  금액유형1 '가입금액', 상세계산식1 '[가입금액] + [분자] / …', 계약상태처리 '소멸'."""

SCHEMA = {
    "type": "object",
    "properties": {"rows": {"type": "array", "items": {"type": "object", "properties": {
        "label": {"type": "string"},
        "split_reason": {"type": "string"},
        "split_evidence": ai.EVIDENCE_SCHEMA,
        "fields": {"type": "array", "items": {"type": "object", "properties": {
            "field": {"type": "string", "enum": AI_KEYS},
            "code": {"type": "string"},
            "name": {"type": "string"},
            "status": {"type": "string", "enum": STATUSES},
            "evidence": ai.EVIDENCE_SCHEMA,
            "note": {"type": "string"},
        }, "required": ["field", "code", "name", "status", "evidence", "note"], "additionalProperties": False}},
    }, "required": ["label", "split_reason", "split_evidence", "fields"], "additionalProperties": False}}},
    "required": ["rows"],
    "additionalProperties": False,
}

SYSTEM = f"""당신은 생명보험사 보험금심사팀의 ECS(보험금 자동산출 시스템) 룰 입력을 돕는 분석가입니다.
담보 하나의 약관 원문 묶음과, 같은 담보를 이미 분석해 근거가 확인된 결과 카드를 받아
ECS "약관분석 데이터 관리" 화면의 룰 행 초안을 만듭니다. 담당자가 이 초안을 보고 ECS에 직접 옮겨 입력합니다.

규칙:
- 필드는 다음 이름만 씁니다: {", ".join(AI_KEYS)}
- 코드와 명칭은 쌍입니다. 입력에 '코드마스터'가 있으면 그 필드의 코드마스터에 있는 코드만 code에 적고, 맞는 코드가 없으면 code는 빈 문자열로 둡니다.
  코드마스터가 없으면 code는 항상 빈 문자열로 두고 name만 적습니다.
- 값(대상테이블·1구좌기준금액·분자·분모·적용배수·계산식)은 name에 적고 code는 빈 문자열로 둡니다.
- 약관에서 판단할 수 없는 필드는 status를 "약관에 명시 없음"으로, 회사 내부 기준이라 담당자가 정해야 하는 필드는 "사용자 입력 필요"로 둡니다.
  이 두 경우 name과 evidence는 비워도 됩니다. 판단할 수 없는 필드는 아예 빼도 됩니다(자동으로 '약관에 명시 없음'이 됩니다).
- 해석이 갈리는 값은 status를 "해석 확인 필요"로 두고 note에 가능한 해석을 적습니다.
- status가 "값" 또는 "해석 확인 필요"인 필드는 근거(evidence)가 반드시 있어야 합니다.
- 조건 분기로 룰 행이 나뉘어야 하면 행을 나누고, split_reason과 split_evidence에 나눈 이유와 근거를 적습니다.
  label은 '급부명 · 청구사유 · 사고유형 · 조건' 형식의 짧은 이름입니다.

{ROW_SPLIT_EXAMPLE}

{ai.COMMON_RULES}"""


def now():
    return dt.datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------- 코드마스터

def master_path():
    d = os.path.join(pipeline.ROOT, "_memory")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "code_master.json")


def load_master():
    p = master_path()
    if not os.path.exists(p):
        return {}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def master_template():
    wb = Workbook()
    ws = wb.active
    ws.title = "코드마스터"
    ws.append(["필드명", "코드", "명칭", "비고"])
    ws.append(["청구사유", "", "", "필드명은 아래 목록 중 하나로 적습니다. 한 행에 코드 하나입니다."])
    ws2 = wb.create_sheet("필드명 목록")
    ws2.append(["필드명(코드 필드)"])
    for k in FIELD_KEYS:
        f = next(x for x in FIELDS if x["key"] == k)
        if f["kind"] == "code":
            ws2.append([k])
    bio = io.BytesIO()
    wb.save(bio)
    return bio.getvalue()


def import_master(data: bytes):
    """코드마스터 엑셀(필드명·코드·명칭)을 읽어 저장합니다. 모든 시트를 읽으며 머리글 행으로 열을 찾습니다."""
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    master, bad = {}, []
    aliases = {norm_text(k): k for k in FIELD_KEYS}
    for ws in wb.worksheets:
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            continue
        head = [norm_text(str(c or "")) for c in rows[0]]
        try:
            fi = next(i for i, h in enumerate(head) if h in ("필드명", "필드", "항목"))
            ci = next(i for i, h in enumerate(head) if h == "코드")
            ni = next(i for i, h in enumerate(head) if h in ("명칭", "코드명", "이름"))
        except StopIteration:
            continue
        for r in rows[1:]:
            if r is None or len(r) <= max(fi, ci, ni):
                continue
            fld = norm_text(str(r[fi] or ""))
            code = str(r[ci] or "").strip()
            name = str(r[ni] or "").strip()
            if not fld or not code:
                continue
            key = aliases.get(fld) or aliases.get(fld.replace("코드", "")) or aliases.get(fld.replace("명", ""))
            if not key:
                bad.append(fld)
                continue
            master.setdefault(key, []).append({"code": code, "name": name})
    if not master:
        raise ValueError("코드마스터에서 '필드명·코드·명칭' 머리글이 있는 시트를 찾지 못했습니다. [양식]을 내려받아 맞춰 주세요.")
    with open(master_path(), "w", encoding="utf-8") as f:
        json.dump({"imported_at": now(), "fields": master, "unknown_fields": sorted(set(bad))}, f, ensure_ascii=False, indent=1)
    return {"fields": {k: len(v) for k, v in master.items()}, "unknown_fields": sorted(set(bad))}


# ---------------------------------------------------------------- 상품 정보(사용자 입력)

def product(doc_id):
    return pipeline.read_json(doc_id, "product.json", {}) or {}


def set_product(doc_id, info, user=""):
    p = {k: str(info.get(k, "")).strip() for k in ("상품코드", "상품명", "판매개시일자")}
    p["at"], p["user"] = now(), user
    pipeline.write_json(doc_id, "product.json", p)
    pipeline._history(doc_id, "4단계 상품 정보 입력", p, user)
    return p


# ---------------------------------------------------------------- 초안 생성

def load(doc_id):
    return pipeline.read_json(doc_id, "ecs.json", {}) or {}


def save(doc_id, data):
    pipeline.write_json(doc_id, "ecs.json", data)


def _card_text(card):
    lines = ["# 3단계 결과 카드(근거가 확인된 항목만)"]
    for it in card["items"]:
        ev = "; ".join(f"{e['ref']}:“{e['quote']}”" for e in it["evidence"])
        lines.append(f"- [{it['field']}] ({it['status']}) {it['content']} {('근거 ' + ev) if ev else ''}")
    for c in card["cautions"]:
        interp = (" / 가능한 해석: " + " | ".join(c["interpretations"])) if c["needs_interpretation"] else ""
        lines.append(f"- 주의[{c['topic']}] {c['content']}{interp}")
    return "\n".join(lines)


def _master_text(master):
    if not master.get("fields"):
        return "# 코드마스터: 없음 (모든 code는 빈 문자열로 둡니다)"
    out = ["# 코드마스터(이 안의 코드만 사용)"]
    for k, vs in master["fields"].items():
        out.append(f"- {k}: " + ", ".join(f"{v['code']}={v['name']}" for v in vs))
    return "\n".join(out)


def analyze(doc_id, cid):
    card = cards.load(doc_id).get(cid)
    if not card:
        raise RuntimeError(f"{cid}: 3단계 결과 카드가 없습니다. 결과 카드를 먼저 만드세요.")
    b = ai.Bundle(doc_id, cid)
    common, user = b.build()   # 카드와 같은 참조 번호 체계를 다시 만듭니다.
    master = load_master()
    system = [{"type": "text", "text": SYSTEM}]
    if common:
        system.append({"type": "text", "text": "# 특약 공통 조항(제1편 일반사항)\n" + common,
                       "cache_control": {"type": "ephemeral"}})
    text = user + "\n\n" + _card_text(card) + "\n\n" + _master_text(master)
    out, meta = ai.call_json(system, text, SCHEMA, effort="high")
    rows = [_post_row(b, master, r, k) for k, r in enumerate(out.get("rows", []))]
    approval = pipeline.read_json(doc_id, "approval.json", {}) or {}
    data = load(doc_id)
    data[cid] = {"cid": cid, "name": b.cov["name"], "generated_at": now(), "approval_at": approval.get("at"),
                 "meta": meta, "rows": rows, "master_used": bool(master.get("fields"))}
    save(doc_id, data)
    return data[cid]


def _post_row(b, master, r, k):
    split_ev, _ = b.check_evidence(r.get("split_evidence"))
    got = {}
    isolated = []
    for f in r.get("fields", []):
        if f["field"] not in AI_KEYS:
            continue
        ev, ok = b.check_evidence(f.get("evidence"))
        cell = {"code": f["code"].strip(), "name": f["name"].strip(), "status": f["status"], "evidence": ev,
                "note": f.get("note", ""), "flags": [], "review": "미검토"}
        if f["status"] in ("값", "해석 확인 필요") and not ok:
            isolated.append({"field": f["field"], **cell, "flags": ["근거 불일치"]})
            continue
        fdef = next(x for x in FIELDS if x["key"] == f["field"])
        if fdef["kind"] == "code" and cell["status"] in ("값", "해석 확인 필요"):
            opts = master.get("fields", {}).get(f["field"])
            if not opts:
                if cell["code"]:
                    cell["flags"].append(f"AI가 적은 코드 '{cell['code']}'는 코드마스터가 없어 비웠습니다")
                cell["code"] = ""
                cell["flags"].append("코드 확인 필요")
            else:
                hit = next((o for o in opts if o["code"] == cell["code"]), None)
                if not hit:
                    byname = [o for o in opts if norm_text(o["name"]) == norm_text(cell["name"])]
                    if len(byname) == 1:
                        cell["code"] = byname[0]["code"]
                        cell["flags"].append("명칭으로 코드 매칭")
                    else:
                        cell["code"] = ""
                        cell["flags"].append("코드 확인 필요(코드마스터에 맞는 코드 없음)")
                elif norm_text(hit["name"]) != norm_text(cell["name"]):
                    cell["flags"].append(f"코드마스터 명칭은 '{hit['name']}'")
        got[f["field"]] = cell
    fields = {}
    for fdef in FIELDS:
        k2 = fdef["key"]
        if fdef["kind"] == "user":
            fields[k2] = {"code": "", "name": "", "status": "사용자 입력 필요", "evidence": [], "note": "",
                          "flags": [], "review": "미검토"}
        elif k2 in got:
            fields[k2] = got[k2]
        else:
            fields[k2] = {"code": "", "name": "", "status": "약관에 명시 없음", "evidence": [], "note": "",
                          "flags": [], "review": "미검토"}
    return {"id": f"R{k + 1}", "label": r.get("label", ""), "split_reason": r.get("split_reason", ""),
            "split_evidence": split_ev, "fields": fields, "isolated": isolated}


def run(doc_id, cids, user="", progress=None):
    if not pipeline.is_approved(doc_id):
        raise PermissionError("1단계 변환이 승인되지 않아 AI 해석을 실행할 수 없습니다.")
    if not ai.available():
        raise RuntimeError("ANTHROPIC_API_KEY 환경변수가 없어 AI 해석을 실행할 수 없습니다.")
    errors = []
    for k, cid in enumerate(cids):
        if progress:
            progress("4단계 ECS 초안 생성", k / len(cids), f"{k + 1}/{len(cids)} {cid}")
        try:
            analyze(doc_id, cid)
        except Exception as e:
            errors.append(f"{cid}: {type(e).__name__}: {e}")
    pipeline._history(doc_id, "4단계 ECS 초안 생성", {"cids": cids, "errors": errors}, user)
    if errors and len(errors) == len(cids):
        raise RuntimeError("; ".join(errors[:3]))
    return errors


def edit_cell(doc_id, cid, row_id, field, code, name, user=""):
    """담당자가 수정 후 값을 고칩니다(근거 없음으로 표시하고 사용자 수정 이력 남김)."""
    data = load(doc_id)
    row = next(r for r in data[cid]["rows"] if r["id"] == row_id)
    cell = row["fields"][field]
    before = {"code": cell["code"], "name": cell["name"]}
    cell.update({"code": code.strip(), "name": name.strip(), "status": "값" if (code or name).strip() else cell["status"],
                 "edited": True, "edited_at": now(), "edited_by": user})
    cell["flags"] = [f for f in cell["flags"] if not f.startswith("코드 확인 필요")] + ["사용자 수정"]
    save(doc_id, data)
    pipeline._history(doc_id, "4단계 값 수정", {"cid": cid, "row": row_id, "field": field, "before": before,
                                              "after": {"code": code, "name": name}}, user)
    return data[cid]


def set_review(doc_id, cid, row_id, field, status, user=""):
    if status not in ("미검토", "검토완료"):
        raise ValueError(status)
    data = load(doc_id)
    row = next(r for r in data[cid]["rows"] if r["id"] == row_id)
    fields = [field] if field else list(row["fields"])
    for f in fields:
        row["fields"][f]["review"] = status
    save(doc_id, data)
    return data[cid]


def view_rows(doc_id, cid, before_rows=None):
    """화면·엑셀용: 상품 정보를 사용자 입력 필드에 채우고, 비교 모드면 수정 전 값을 붙입니다."""
    d = load(doc_id).get(cid)
    if not d:
        return None
    prod = product(doc_id)
    rows = json.loads(json.dumps(d["rows"]))
    for r in rows:
        for k in ("상품코드", "상품명", "판매개시일자"):
            if prod.get(k):
                r["fields"][k].update({"name": prod[k], "status": "값", "flags": ["사용자 입력"]})
        if before_rows is not None:
            br = _match_row(r, before_rows)
            r["before_label"] = br["label"] if br else None
            for k, cell in r["fields"].items():
                bc = br["fields"].get(k) if br else None
                cell["before"] = {"code": bc["code"], "name": bc["name"], "status": bc["status"]} if bc else None
    return {**d, "rows": rows}


def _match_row(r, cands):
    key = (r["fields"]["청구사유"]["name"], r["fields"]["사고유형"]["name"])
    same = [c for c in cands if (c["fields"]["청구사유"]["name"], c["fields"]["사고유형"]["name"]) == key]
    if same:
        return max(same, key=lambda c: _sim(c["label"], r["label"]))
    return max(cands, key=lambda c: _sim(c["label"], r["label"])) if cands and max(_sim(c["label"], r["label"]) for c in cands) > 0.6 else None


def _sim(a, b):
    import difflib
    return difflib.SequenceMatcher(None, norm_text(a), norm_text(b)).ratio()
