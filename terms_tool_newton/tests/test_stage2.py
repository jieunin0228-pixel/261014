"""2단계(담보 분류) 시험. AI 호출은 가짜 응답으로 바꿔 시험합니다(실제 Claude 응답 품질은 시험하지 않음)."""
import os
import shutil
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
TMP = tempfile.mkdtemp(prefix="terms_test2_")
os.environ["TERMS_DATA_DIR"] = os.path.join(TMP, "data")

from converter import classify, export, pipeline  # noqa: E402
from tests import make_fixture  # noqa: E402

pipeline.ROOT = os.environ["TERMS_DATA_DIR"]


def convert(path):
    up = os.path.join(TMP, "u.pdf")
    shutil.copy(path, up)
    job = pipeline.start_conversion(up, "fixture.pdf")
    while not job["done"]:
        time.sleep(0.2)
    assert not job["error"], job["error"]
    return job["doc_id"]


class Stage2(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = convert(make_fixture.build(os.path.join(TMP, "f.pdf")))
        rider = next(c for c in pipeline.read_json(cls.doc, "coverage_map.json")["coverages"] if "암진단" in c["name"])
        cls.rider = rider["cid"]
        pipeline.add_edit(cls.doc, {"action": "coverage_range", "cid": rider["cid"], "start": 6, "end": 8})

    def setUp(self):
        pipeline.set_approval(self.doc, True, "시험")

    def test_requires_approval(self):
        pipeline.set_approval(self.doc, False, "시험")
        with self.assertRaises(classify.NotApproved):
            classify.generate(self.doc)
        os.environ["ANTHROPIC_API_KEY"] = "test"
        try:
            with self.assertRaises(classify.NotApproved):
                classify.ai_suggest(self.doc)
        finally:
            del os.environ["ANTHROPIC_API_KEY"]

    def test_rule_tree(self):
        data = classify.generate(self.doc, reset=True)
        items = data["items"]
        self.assertEqual(set(items), {c["cid"] for c in pipeline.read_json(self.doc, "coverage_map.json")["coverages"]
                                      if c["type"] in classify.CLASSIFY_TYPES})
        r = items[self.rider]
        self.assertEqual((r["major"], r["mid"]), ("진단", "암"))
        self.assertEqual(r["benefits"], ["암진단자금"])
        main = next(v for v in items.values() if v["type"] == "보통약관")
        self.assertEqual(main["major"], "사망")   # 담보명에 낱말이 없어 지급사유 조문으로 판단
        self.assertTrue(classify.verify_quote(main["evidence"]["quote"],
                                              classify.build_items(self.doc)[0]["payout_text"]))

    def test_move_rename_memory(self):
        classify.generate(self.doc, reset=True)
        classify.move(self.doc, self.rider, "치료", "암", "시험소분류", "시험")
        classify.rename_group(self.doc, "치료", "암", "시험소분류", "바뀐소분류", "시험")
        classify.rename_item(self.doc, self.rider, "암진단(표시)", "시험")
        data = classify.generate(self.doc)  # 사용자 분류는 유지
        it = data["items"][self.rider]
        self.assertEqual((it["major"], it["minor"], it["source"]), ("치료", "바뀐소분류", "사용자"))
        mem = classify.load_memory()
        self.assertEqual(mem[classify.memory_key(it["name"])]["minor"], "바뀐소분류")
        data = classify.generate(self.doc, reset=True)  # 초기화해도 기억이 먼저 적용
        self.assertEqual(data["items"][self.rider]["source"], "기억")
        self.assertEqual(data["items"][self.rider]["display_name"], "암진단(표시)")
        os.remove(classify.memory_path())

    def test_selection_review_export(self):
        classify.generate(self.doc, reset=True)
        classify.set_selected(self.doc, [self.rider, "없는ID"])
        classify.set_review(self.doc, self.rider, "검토완료")
        data = classify.load(self.doc)
        self.assertEqual(data["selected"], [self.rider])
        self.assertEqual(data["items"][self.rider]["review"], "검토완료")
        self.assertGreater(len(export.excel(self.doc, [self.rider])), 5000)

    def test_ai_quote_verification(self):
        classify.generate(self.doc, reset=True)
        items = classify.build_items(self.doc)
        rider = next(i for i in items if i["cid"] == self.rider)
        main = next(i for i in items if i["type"] == "보통약관")
        calls = []

        def fake(system, text):
            calls.append(text)
            return {"results": [
                {"cid": rider["cid"], "major": "진단", "mid": "암", "minor": "일반암", "reason": "진단확정 시 지급",
                 "evidence_node": rider["payout_id"], "quote": "암으로 진단확정되었을 때 암진단자금"},
                {"cid": main["cid"], "major": "사망", "mid": "질병·재해 공통", "minor": "일반사망", "reason": "사망 시 지급",
                 "evidence_node": main["payout_id"], "quote": "피보험자가 사망하면 무조건 지급합니다"},
            ]}
        orig = classify._call_claude
        classify._call_claude = fake
        os.environ["ANTHROPIC_API_KEY"] = "test"
        try:
            data = classify.ai_suggest(self.doc)
        finally:
            classify._call_claude = orig
            del os.environ["ANTHROPIC_API_KEY"]
        self.assertEqual(len(calls), 1)
        self.assertNotIn("별표2-1 보험금 지급기준표\n", calls[0])  # 약관 전체가 아니라 필요한 부분만 보냄
        self.assertTrue(data["items"][rider["cid"]]["ai"]["verified"])
        self.assertEqual(data["items"][main["cid"]]["ai"]["status"], "근거 불일치")
        data, applied, skipped = classify.apply_ai(self.doc, [rider["cid"], main["cid"]])
        self.assertEqual(applied, [rider["cid"]])
        self.assertEqual(skipped, [main["cid"]])
        self.assertEqual(data["items"][rider["cid"]]["minor"], "일반암")
        self.assertNotEqual(data["items"][main["cid"]]["source"], "AI(적용)")


if __name__ == "__main__":
    unittest.main()
