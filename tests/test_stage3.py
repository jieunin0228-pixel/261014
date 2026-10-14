"""3단계(담보별 요약) 자동 테스트. 실제 API 대신 가짜 응답을 씁니다."""
import os
import shutil
import tempfile
import unittest

from termsapp import pipeline, summarize
from termsapp.store import Doc, EditError

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "sample_terms.pdf")


def field(status="약관에 명시 없음", value="", ev=()):
    return {"status": status, "value": value, "interpretations": [], "evidence": [dict(node_id=n, quote=q) for n, q in ev]}


def fake_result():
    a = {k: field() for k, _ in summarize.A_FIELDS}
    a["pay_reason"] = field("명시", "암 진단확정 시 지급합니다.",
                            [("S003|제1조", "회사는 암으로 진단확정된 때 별표1의 금액을 지급합니다.")])
    a["amount"] = field("명시", "별표1 보험금 지급기준표에 따릅니다.", [("S003|별표1", "1,000만원")])  # 표 칸 인용
    a["definitions"] = field("명시", "진단확정은 전문의가 합니다.",
                             [("S002|제2조-나", "진단확정: 병리 전문의가 내린 진단으로 합니다.")])  # 꾸며낸 문장
    a["coverage_start"] = field("명시", "계약일부터 보장합니다.")  # 근거 없음
    a["exclusions"] = field("해석 확인 필요", "주계약 제3조 준용 범위가 불분명합니다.",
                            [("S003|제1조", "주계약 제3조를 준용합니다.")])
    a["exclusions"]["interpretations"] = ["지급사유만 준용", "지급사유와 지급률 모두 준용"]
    b = [
        {"category": "별표 참조", "content": "지급금액은 별표1 표를 그대로 씁니다.", "needs_confirmation": False,
         "interpretations": [], "evidence": [{"node_id": "S003|제1조", "quote": "별표1의 금액을 지급합니다."}]},
        {"category": "기준일 판단", "content": "준거법을 따릅니다.", "needs_confirmation": False, "interpretations": [],
         "evidence": [{"node_id": "S002|제7조", "quote": "이 계약은 국내법을 따릅니다."}]},  # 입력에 없는 조문
    ]
    return {"A": a, "B": b, "tables_referenced": ["S003|별표1"]}


class Stage3Test(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        pipeline.convert(FIXTURE, self.dir, "sample_terms.pdf")
        self.doc = Doc(self.dir)
        self.doc.set_approval(True, "검토자")
        self.cov = self.doc.coverage()
        self.item = next(i for i in self.cov["items"] if i["name"] == "암진단자금")
        self.calls = []

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def fake(self, common, block, client):
        self.calls.append((common, block))
        return fake_result(), {"model": "fake", "usage": {}, "request_id": ""}

    def test_input_is_scoped(self):
        common, block, cids = summarize.build_input(self.item, self.doc.terms, self.doc.tables, self.cov["common_sections"])
        self.assertIn("[S003|제1조]", block)
        self.assertIn("1,000만원", block)              # 별표 표는 행·열 그대로 들어감
        self.assertIn("[S002|제3조]", block)           # 참조한 주계약 조문
        self.assertNotIn("[S002|제7조]", block)        # 참조하지 않은 조문은 보내지 않음
        self.assertNotIn("S002|제7조", cids)

    def test_verification_isolates_mismatches(self):
        job, t = self.doc.start_summaries([self.item["id"]], caller=self.fake)
        t.join(10)
        self.assertEqual(job["errors"], {})
        s = self.doc.summary_of(self.item["id"])
        card = {f["key"]: f for f in s["card"]["A"]}
        self.assertEqual(card["pay_reason"]["status"], "명시")
        ev = card["pay_reason"]["evidence"][0]
        self.assertTrue(ev["matched"])
        self.assertEqual((ev["page"], ev["printed_page"]), (4, 3))
        self.assertTrue(ev["boxes"])
        self.assertTrue(card["amount"]["evidence"][0]["matched"])           # 표 칸 인용도 대조됨
        self.assertEqual(card["definitions"]["status"], "근거 불일치")       # 꾸며낸 인용 → 격리
        self.assertEqual(card["coverage_start"]["status"], "근거 불일치")    # 근거 없는 '명시' → 격리
        self.assertEqual(card["exclusions"]["interpretations"], ["지급사유만 준용", "지급사유와 지급률 모두 준용"])
        self.assertEqual(card["term_renewal"]["status"], "약관에 명시 없음")
        mism = {(m["section"], m.get("key", m.get("category"))): m for m in s["card"]["mismatch"]}
        self.assertIn(("A", "definitions"), mism)
        self.assertIn(("B", "기준일 판단"), mism)
        self.assertEqual(mism[("B", "기준일 판단")]["evidence"][0]["reason"], "이 담보의 입력에 포함되지 않은 조문")
        self.assertEqual([b["category"] for b in s["card"]["B"]], ["별표 참조"])
        self.assertEqual(s["card"]["tables"][0]["table_ids"], ["T0001"])
        st = self.doc.summary_status()
        self.assertEqual(st["items"][self.item["id"]]["mismatch"], 3)

    def test_skip_done_unless_forced_and_requires_key(self):
        _, t = self.doc.start_summaries([self.item["id"]], caller=self.fake)
        t.join(10)
        _, t = self.doc.start_summaries([self.item["id"]], caller=self.fake)
        t.join(10)
        self.assertEqual(len(self.calls), 1)
        _, t = self.doc.start_summaries([self.item["id"]], force=True, caller=self.fake)
        t.join(10)
        self.assertEqual(len(self.calls), 2)
        old = os.environ.pop("ANTHROPIC_API_KEY", None)
        try:
            with self.assertRaises(EditError):
                self.doc.start_summaries([self.item["id"]], force=True)
        finally:
            if old:
                os.environ["ANTHROPIC_API_KEY"] = old

    def test_schema_is_strict(self):
        def walk(s):
            if s.get("type") == "object":
                self.assertFalse(s["additionalProperties"])
                self.assertEqual(set(s["required"]), set(s["properties"]))
                for v in s["properties"].values():
                    walk(v)
            if s.get("type") == "array":
                walk(s["items"])
        walk(summarize.SCHEMA)


if __name__ == "__main__":
    unittest.main()
