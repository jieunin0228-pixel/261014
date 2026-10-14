"""2단계(담보 분류 트리) 자동 테스트"""
import io
import os
import shutil
import tempfile
import unittest

from openpyxl import load_workbook

from termsapp import coverage, export, pipeline
from termsapp.store import CoverageLocked, Doc, EditError

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "sample_terms.pdf")


class TableReadingTest(unittest.TestCase):
    def test_fragmented_rows_with_sub_benefits(self):
        # 실제 약관(요양병원암입원특약)처럼 급부명이 글자 줄마다 행으로 쪼개진 표
        rows = [["급부명", "", "지급사유", "지급금액"],
                ["", "", "피보험자가 암보장개시일 이후에\n입원한 때", "1일당\n특약 보험가입금액의 100%"],
                ["", "요양병원 암", "", ""], ["", "입원비Ⅰ", "", ""],
                ["요양병원", "", "", ""], ["암입원비", "", "", ""], ["(제2-2조)", "", "", ""],
                ["", "", "피보험자가 보장개시일 이후에\n입원한 때", "1일당\n특약 보험가입금액의 50%"],
                ["", "요양병원 암", "", ""], ["", "입원비Ⅱ", "", ""]]
        got = coverage.benefits_from_table(rows)
        self.assertEqual([b["name"] for b in got], ["요양병원 암입원비Ⅰ", "요양병원 암입원비Ⅱ"])
        self.assertEqual(got[1]["amount"], "1일당 특약 보험가입금액의 50%")
        self.assertEqual(got[0]["group"], "요양병원 암입원비")

    def test_period_split_amounts_stay_in_one_benefit(self):
        rows = [["급부명", "지급사유", "지급금액", ""],
                ["", "피보험자가 ‘뇌혈관질환’으로 진단확정된 때", "최초계약의\n계약일로부터\n90일 이내", "보험가입금액의 10%"],
                ["", "", "1년 미만", "보험가입금액의 70%"], ["뇌혈관질환", "", "", ""], ["진단자금", "", "", ""],
                ["(제2-2조)", "", "", ""], ["", "", "1년 이상", "보험가입금액의 100%"]]
        got = coverage.benefits_from_table(rows)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["name"], "뇌혈관질환진단자금")
        self.assertIn("1년 이상 보험가입금액의 100%", got[0]["amount"])

    def test_major_rules(self):
        self.assertEqual(coverage.classify_major("재해사망보험금", "")[0], "사망")
        self.assertEqual(coverage.classify_major("암수술자금Ⅰ", "")[0], "치료")
        self.assertEqual(coverage.classify_major("뇌혈관질환입원비", "")[0], "입원")
        self.assertEqual(coverage.classify_major("3대주요암진단자금", "")[0], "진단")
        major, why = coverage.classify_major("지원금", "피보험자가 수술을 받은 때")
        self.assertEqual(major, "치료")
        self.assertIn("지급사유", why)
        self.assertEqual(coverage.classify_major("축하금", "피보험자가 생존한 때")[0], "기타")


class CoverageDocTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        pipeline.convert(FIXTURE, self.dir, "sample_terms.pdf")
        self.doc = Doc(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_locked_until_approved(self):
        with self.assertRaises(CoverageLocked):
            self.doc.coverage()

    def test_items_tree_and_ranges(self):
        self.doc.set_approval(True, "검토자")
        cov = self.doc.coverage()
        by_name = {i["name"]: i for i in cov["items"]}
        self.assertEqual(set(by_name), {"가상건강보험 주계약", "암진단자금", "소액암진단자금"})
        cancer = by_name["암진단자금"]
        self.assertEqual((cancer["major"], cancer["middle"], cancer["minor"]), ("진단", "암", "가상암진단특약"))
        self.assertEqual(cancer["pay_amount"], "1,000만원")
        self.assertEqual(cancer["range"]["first"], "S003|제1조")
        self.assertEqual(cancer["range"]["last"], "S003|별표1")
        self.assertEqual(cancer["source"]["table"], "T0001")
        main = by_name["가상건강보험 주계약"]
        self.assertEqual(main["major"], "기타")
        self.assertTrue(main["reason_note"])
        self.assertIn("S002|제3조", main["key_articles"])

    def test_move_rename_select_and_rebuild_keeps_user_changes(self):
        self.doc.set_approval(True, "검토자")
        cov = self.doc.coverage()
        cid = next(i["id"] for i in cov["items"] if i["name"] == "소액암진단자금")
        self.doc.coverage_edit("move", {"ids": [cid], "major": "기타", "middle": "소액암"}, "검토자")
        self.doc.coverage_edit("rename", {"id": cid, "name": "소액암 진단비"}, "검토자")
        self.doc.coverage_edit("select", {"ids": [cid], "selected": True}, "검토자")
        with self.assertRaises(EditError):
            self.doc.coverage_edit("move", {"ids": [cid], "major": "생존"})
        cov = self.doc.build_coverage()
        it = next(i for i in cov["items"] if i["id"] == cid)
        self.assertEqual((it["name"], it["major"], it["middle"], it["selected"]), ("소액암 진단비", "기타", "소액암", True))
        self.assertTrue(it["moved"] and it["renamed"])
        self.assertEqual([e["op"] for e in self.doc.coverage_edits()], ["move", "rename"])
        # 1단계를 수정해 승인이 바뀌면 '다시 만들기 권장'으로 표시합니다.
        self.doc.apply("edit_text", {"uid": self.doc.by_cid["S002|제1조"]["uid"], "text": "제1조【목적】"})
        self.doc.set_approval(True, "검토자")
        self.assertTrue(self.doc.coverage()["stale"])

    def test_export_selected_only(self):
        self.doc.set_approval(True, "검토자")
        cov = self.doc.coverage()
        cid = next(i["id"] for i in cov["items"] if i["name"] == "암진단자금")
        cov = self.doc.coverage_edit("select", {"ids": [cid], "selected": True})
        wb = load_workbook(io.BytesIO(export.coverage_xlsx(cov, selected_only=True)))
        rows = list(wb["담보 분류"].values)
        self.assertEqual(rows[0][:5], ("ID", "대분류", "중분류", "소분류(특약)", "담보명"))
        self.assertEqual([r[4] for r in rows[1:]], ["암진단자금"])


if __name__ == "__main__":
    unittest.main()
