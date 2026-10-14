"""1단계(변환·검증) 자동 테스트: python -m unittest discover tests"""
import json
import os
import shutil
import tempfile
import unittest

from termsapp import pipeline, structure
from termsapp.store import Doc, EditError

HERE = os.path.dirname(__file__)
FIXTURE = os.path.join(HERE, "fixtures", "sample_terms.pdf")


class ConvertTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.report = pipeline.convert(FIXTURE, cls.dir, "sample_terms.pdf")
        load = lambda n: pipeline.read_json(os.path.join(cls.dir, n))
        cls.terms, cls.pages, cls.tables = load("terms.json"), load("pages.json"), load("tables.json")
        cls.nodes = {n["cid"]: n for n in cls.terms["nodes"]}
        cls.groups = {g["key"]: g for g in cls.report["groups"]}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_sections_from_toc(self):
        secs = [(s["title"], s["kind"], s["page_start"], s["page_end"]) for s in self.terms["sections"]]
        self.assertEqual(secs, [("표지·목차", "reference", 1, 1), ("가상건강보험 주계약", "terms", 2, 3),
                                ("가상암진단특약", "terms", 4, 5), ("약관내 인용조문", "reference", 6, 6)])

    def test_printed_page_mapping_and_header_footer(self):
        self.assertEqual([p["printed_page"] for p in self.pages], [None, 1, 2, 3, 4, 5])
        self.assertIn("가상건강보험 약관", self.pages[1]["header_footer"])

    def test_spaces_rebuilt_from_glyph_gaps(self):
        self.assertIn("이 계약은 피보험자에게 보험금을 지급하는 것을 목적으로 합니다.", self.nodes["S002|제1조"]["text"])

    def test_article_paragraph_item_ids(self):
        for cid in ("S002|제3조", "S002|제3조-①", "S002|제3조-①-1", "S002|제3조-①-2", "S002|제3조-②",
                    "S002|제2조-가", "S002|제2조-나", "S003|제1조", "S003|별표1"):
            self.assertIn(cid, self.nodes)
        n = self.nodes["S002|제3조-①-2"]
        self.assertEqual((n["page_start"], n["page_end"]), (2, 2))
        self.assertEqual(n["path"], "제1관 목적 및 용어의 정의 > 제3조 보험금의 지급사유 > ① > 2.")

    def test_note_box_is_not_a_paragraph(self):
        note = self.nodes["S002|제3조-해설1"]
        self.assertTrue(note["text"].startswith("【설명】"))
        self.assertIn("S002|제3조-③", self.nodes)
        self.assertNotIn("이 줄은 해설", self.nodes["S002|제3조-②"]["text"])

    def test_two_column_reading_order(self):
        self.assertTrue(self.pages[2]["two_column"])
        order = [n["cid"] for n in self.terms["nodes"] if n["section"] == "S002" and n["kind"] == "article"]
        self.assertEqual(order, ["S002|제1조", "S002|제2조", "S002|제3조", "S002|제4조", "S002|제6조", "S002|제7조"])
        self.assertEqual(self.nodes["S002|제4조-①"]["text"], "보험수익자는 다음의\n서류를 제출합니다.")

    def test_missing_article_number_reported(self):
        msgs = [i["message"] for i in self.groups["article_gaps"]["items"]]
        self.assertTrue(any("제4조 다음에 제6조" in m for m in msgs), msgs)

    def test_references(self):
        refs = {(r["from"], r["text"]): r for r in self.terms["refs"]}
        self.assertEqual(refs[("S002|제3조-①", "다음 각 호")]["target"], ["S002|제3조-①-1", "S002|제3조-①-2"])
        self.assertEqual(refs[("S002|제3조-②", "제1항 제2호")]["target"], ["S002|제3조-①-2"])
        self.assertEqual(refs[("S002|제3조-②", "앞 항")]["target"], ["S002|제3조-①"])
        self.assertEqual(refs[("S002|제6조-②", "제4조")]["target"], ["S002|제4조"])
        self.assertEqual(refs[("S003|제1조", "제3조")]["target"], ["S002|제3조"])  # 주계약 제3조
        self.assertEqual(refs[("S003|제1조", "별표1")]["target"], ["S003|별표1"])
        self.assertEqual(refs[("S002|제3조-③", "제9조")]["status"], "미해결")
        self.assertFalse(any(r["from"] == "S002|제3조" for r in self.terms["refs"]), "제목 줄은 참조가 아님")

    def test_table_json(self):
        self.assertEqual(len(self.tables), 1)
        t = self.tables[0]
        self.assertEqual(t["rows"][0], ["급부명", "지급사유", "지급금액"])
        self.assertEqual(t["rows"][2], ["소액암진단자금", "소액암으로 진단확정", "200만원"])
        self.assertEqual(t["node"], "S003|별표1")
        self.assertIn("[표 T0001]", self.nodes["S003|별표1"]["text"])

    def test_scanned_page_flagged(self):
        p = self.pages[4]
        self.assertGreater(p["image_ratio"], 0.5)
        self.assertTrue(p["ocr"])
        self.assertTrue(any(i["page"] == 5 for i in self.groups["low_text"]["items"]))

    def test_cache_flag(self):
        self.assertTrue(pipeline.is_cached(self.dir))


class EditTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        pipeline.convert(FIXTURE, self.dir, "sample_terms.pdf")
        self.doc = Doc(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def uid(self, cid):
        return self.doc.by_cid[cid]["uid"]

    def test_edit_text_and_history_and_unapprove(self):
        self.doc.set_approval(True, "검토자")
        self.doc.apply("edit_text", {"uid": self.uid("S002|제1조"), "text": "제1조【목적】\n수정된 본문"}, "검토자")
        self.assertEqual(self.doc.by_cid["S002|제1조"]["text"], "제1조【목적】\n수정된 본문")
        e = self.doc.edits()[-1]
        self.assertEqual((e["op"], e["user"], e["cid"]), ("edit_text", "검토자", "S002|제1조"))
        self.assertIn("목적으로 합니다", e["before"])
        self.assertFalse(self.doc.status()["approved"])
        saved = pipeline.read_json(os.path.join(self.dir, "terms.json"))
        self.assertTrue(any(n["text"] == "제1조【목적】\n수정된 본문" for n in saved["nodes"]))

    def test_split_creates_new_paragraph_and_relinks(self):
        uid = self.uid("S002|제4조-①")
        self.doc.apply("split", {"uid": uid, "at_line": 1, "kind": "paragraph", "num": "2"})
        self.assertEqual(self.doc.by_cid["S002|제4조-①"]["text"], "보험수익자는 다음의")
        self.assertIn("S002|제4조-②", self.doc.by_cid)
        # 원래 ①의 1·2호는 이제 새 ② 아래로 들어갑니다(문서 순서대로 계층 재계산).
        self.assertIn("S002|제4조-②-1", self.doc.by_cid)
        msgs = [i["message"] for g in self.doc.report["groups"] if g["key"] == "sub_gaps" for i in g["items"]]
        self.assertTrue(any("중복" in m for m in msgs), msgs)

    def test_merge_and_line_moves(self):
        self.doc.apply("merge_prev", {"uid": self.uid("S002|제4조-②")})
        self.assertNotIn("S002|제4조-②", self.doc.by_cid)
        self.assertTrue(self.doc.by_cid["S002|제4조-①-2"]["text"].endswith("원본이어야 합니다."))
        self.doc.apply("line_to_next", {"uid": self.uid("S002|제6조-①")})
        self.assertEqual(self.doc.by_cid["S002|제6조-②"]["text"].split("\n")[0], "경우 계약은 소멸합니다.")
        self.doc.apply("line_to_prev", {"uid": self.uid("S002|제6조-②")})
        self.assertEqual(self.doc.by_cid["S002|제6조-①"]["text"], "피보험자가 사망한\n경우 계약은 소멸합니다.")

    def test_edit_meta_changes_id(self):
        self.doc.apply("edit_meta", {"uid": self.uid("S002|제6조"), "kind": "article", "num": "5", "title": "계약의 소멸"})
        self.assertIn("S002|제5조-①", self.doc.by_cid)
        self.assertEqual(sum(g["count"] for g in self.doc.report["groups"] if g["key"] == "article_gaps"), 1)

    def test_reset_restores_original(self):
        self.doc.apply("merge_prev", {"uid": self.uid("S002|제7조")})
        self.doc.reset("검토자")
        self.assertIn("S002|제7조", self.doc.by_cid)
        self.assertEqual(self.doc.edits()[-1]["op"], "reset")

    def test_bad_split_rejected(self):
        with self.assertRaises(EditError):
            self.doc.apply("split", {"uid": self.uid("S002|제4조-①-1"), "at_line": 1})


class RegexTest(unittest.TestCase):
    def test_toc_parsing(self):
        lines = [{"text": t} for t in ["0011 가나다 순 특약 색인", "제1조【목적】 0 47", "R(무)암진단특약", "  P 654"]]
        self.assertEqual(structure.parse_toc_lines(lines), [(11, "가나다 순 특약 색인"), (47, "제1조【목적】")])

    def test_article_heading_variants(self):
        m = structure.RE_ART_BRACKET.match("제2-1조의3【‘암’ 등의 정의 및 진단확정】")
        self.assertEqual((m.group(1), m.group(2), m.group(3)), ("2-1", "3", "‘암’ 등의 정의 및 진단확정"))
        self.assertIsNotNone(structure.RE_ART_BRACKET.match("제1-15 조【보험료의 납입을 연체하여 해지된 특약의 부활】"))
        self.assertEqual(structure.art_label("2-1의3"), "제2-1조의3")
        self.assertIsNone(structure.RE_ART_PAREN.match("제3조(보험금의 지급사유)에서 정한 보험금"))


if __name__ == "__main__":
    unittest.main()
