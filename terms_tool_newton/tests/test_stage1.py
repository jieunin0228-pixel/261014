"""1단계 변환 시험.

    python -m unittest discover -s tests -v

샘플 약관(1,492쪽) 통합 시험은 시간이 걸리므로 SAMPLE_PDF 환경변수로 경로를 줄 때만 돕니다.
"""
import os
import shutil
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
TMP = tempfile.mkdtemp(prefix="terms_test_")
os.environ["TERMS_DATA_DIR"] = os.path.join(TMP, "data")

from converter import export, extract, pipeline  # noqa: E402
from tests import make_fixture  # noqa: E402


def convert(path, name):
    up = os.path.join(TMP, name + ".upload")
    shutil.copy(path, up)
    job = pipeline.start_conversion(up, name)
    while not job["done"]:
        time.sleep(0.2)
    if job["error"]:
        raise AssertionError(job["error"] + "\n" + job.get("trace", ""))
    return job["doc_id"]


class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf = make_fixture.build(os.path.join(TMP, "fixture.pdf"))
        cls.doc = convert(cls.pdf, "fixture.pdf")

    def load(self, name):
        return pipeline.read_json(self.doc, name)

    def cov(self, name_part):
        return next(c for c in self.load("coverage_map.json")["coverages"] if name_part in c["name"])

    def test_toc_and_offset(self):
        rep = self.load("report.json")
        self.assertEqual(rep["toc"]["pages"], [2])
        self.assertEqual(rep["toc_count"], 4)
        self.assertEqual(rep["offset"]["offset"], 0)

    def test_header_mismatch_reported(self):
        rep = self.load("report.json")
        pages = [m["p"] for m in rep["mismatch_pages"]]
        self.assertIn(8, pages)
        main = self.cov("테스트건강보험")
        self.assertIn([5, 7], main["gaps"])  # 머리글 기준으로 8쪽이 주계약에 붙어 쪽이 끊김

    def test_articles_and_types(self):
        cm = self.load("coverage_map.json")
        types = {c["name"]: c["type"] for c in cm["coverages"]}
        self.assertEqual(types["(무)테스트건강보험"], "보통약관")
        self.assertEqual(types["특약일반사항"], "특약공통")
        self.assertEqual(types["R(무)테스트암진단특약(갱신형)"], "개별특약")
        self.assertEqual(types["약관내 인용조문"], "인용조문")
        nodes = self.load("terms.json")["nodes"]
        rider = self.cov("암진단")
        self.assertEqual(rider["key"]["payout"], "R(무)테스트암진단특약(갱신형)/제2-2조")
        main = "(무)테스트건강보험/제2조"
        self.assertIn(main + "/①", nodes)
        self.assertIn(main + "/②/2", nodes)
        self.assertEqual(nodes[main + "/②/2"]["text"], "재난으로 사망한 것으로 통보된 경우")
        self.assertEqual(self.cov("테스트건강보험")["key"]["exclusion"], "(무)테스트건강보험/제3조")

    def test_refs(self):
        refs = self.load("terms.json")["refs"]
        rider = [r for r in refs if r["cid"] == self.cov("암진단")["cid"]]
        by_raw = {r["raw"]: r for r in rider}
        self.assertEqual(by_raw["제1-2조(용어의 정의)"]["target"], "특약일반사항/제1-2조")
        self.assertEqual(by_raw["「의료법」 제3조"]["target"], "약관내 인용조문/「의료법」/제3조")
        self.assertEqual(by_raw["제9조"]["status"], "미해결")
        kinds = {r["kind"] for r in rider if r["status"] == "연결"}
        self.assertIn("공통 전체", kinds)
        self.assertIn("주계약 준용", kinds)
        inputs = self.cov("암진단")["inputs"]
        self.assertIn("특약일반사항/제1-2조", inputs["common_refs"])
        self.assertIn("약관내 인용조문/「의료법」/제3조", inputs["law_refs"])

    def test_table_grid(self):
        tables = self.load("tables.json")["tables"]
        t = next(t for t in tables if t["page"] == 4)
        self.assertTrue(t["complete"], t["problems"])
        self.assertEqual(t["grid"][0], ["급부명", "지급사유", "지급금액"])
        self.assertEqual(t["grid"][1][2], "보험가입금액의\n100%")
        self.assertEqual(t["owner"], "(무)테스트건강보험/별표1")

    @unittest.skipUnless(extract.ocr_available(), "Tesseract 한국어 미설치")
    def test_ocr_page(self):
        raw = self.load("raw_pages.json")["pages"]
        pg = raw[9]
        self.assertTrue(pg["scanned"])
        self.assertTrue(pg["ocr"]["done"])
        text = " ".join(l["t"] for l in pg["lines"])
        self.assertIn("상법", text.replace(" ", ""))

    def test_edits_review_approval(self):
        d = self.doc
        rider = self.cov("암진단")
        pipeline.set_review(d, rider["cid"], "검토완료", "시험")
        pipeline.set_approval(d, True, "시험")
        self.assertTrue(pipeline.is_approved(d))
        # 1) 쪽 범위 수정으로 8쪽을 특약에 붙이면 별표2-1 참조가 연결됩니다.
        pipeline.add_edit(d, {"action": "coverage_range", "cid": rider["cid"], "start": 6, "end": 8}, "시험")
        self.assertFalse(pipeline.is_approved(d))
        self.assertEqual(pipeline.read_json(d, "reviews.json")[rider["cid"]]["status"], "미검토")
        refs = self.load("terms.json")["refs"]
        anx = [r for r in refs if r["cid"] == rider["cid"] and r["raw"].replace(" ", "") == "별표2-1"]
        self.assertTrue(anx and all(r["status"] == "연결" for r in anx))
        # 2) 머리 해제(합치기) → 되살리기(split) → 되돌리기
        nodes = self.load("terms.json")["nodes"]
        n = nodes["R(무)테스트암진단특약(갱신형)/제2-3조"]
        page, line = n["lines"][0]
        pipeline.add_edit(d, {"action": "merge", "cid": rider["cid"], "page": page, "line": line})
        self.assertNotIn("R(무)테스트암진단특약(갱신형)/제2-3조", self.load("terms.json")["nodes"])
        eid = pipeline.read_json(d, "edits.json")[-1]["eid"]
        pipeline.undo_edit(d, eid)
        self.assertIn("R(무)테스트암진단특약(갱신형)/제2-3조", self.load("terms.json")["nodes"])
        pipeline.add_edit(d, {"action": "rename", "cid": rider["cid"], "page": page, "line": line,
                              "key": "제2-3조", "title": "세부규정(수정)", "kind": "article"})
        self.assertEqual(self.load("terms.json")["nodes"]["R(무)테스트암진단특약(갱신형)/제2-3조"]["title"], "세부규정(수정)")
        # 3) 유형 수정
        pipeline.add_edit(d, {"action": "coverage_type", "cid": rider["cid"], "type": "미분류"})
        self.assertEqual(self.cov("암진단")["type"], "미분류")
        hist = pipeline.read_json(d, "history.json")
        self.assertTrue(any(h["what"] == "승인 자동 해제" for h in hist))
        for e in pipeline.read_json(d, "edits.json"):
            if e.get("active"):
                pipeline.undo_edit(d, e["eid"])

    def test_exports(self):
        x = export.excel(self.doc)
        self.assertGreater(len(x), 5000)
        z = export.json_zip(self.doc, [self.cov("암진단")["cid"]])
        import io
        import json
        import zipfile
        zf = zipfile.ZipFile(io.BytesIO(z))
        self.assertEqual(sorted(zf.namelist()), ["coverage_map.json", "pages.json", "report.json", "tables.json", "terms.json"])
        cm = json.loads(zf.read("coverage_map.json"))
        self.assertEqual(len(cm["coverages"]), 1)

    def test_cache(self):
        up = os.path.join(TMP, "again.upload")
        shutil.copy(self.pdf, up)
        job = pipeline.start_conversion(up, "fixture.pdf")
        self.assertTrue(job["cached"])


@unittest.skipUnless(os.environ.get("SAMPLE_PDF"), "SAMPLE_PDF 미지정")
class Sample(unittest.TestCase):
    """샘플 약관에서 확인한 구조를 회귀 시험합니다."""

    @classmethod
    def setUpClass(cls):
        cls.doc = convert(os.environ["SAMPLE_PDF"], "sample.pdf")

    def test_counts(self):
        rep = pipeline.read_json(self.doc, "report.json")
        self.assertEqual(rep["page_count"], 1492)
        self.assertEqual(rep["toc"]["pages"], [7, 8, 9, 10])
        self.assertEqual(rep["toc_count"], 115)
        self.assertEqual(rep["header_coverages"], 111)
        self.assertEqual(rep["offset"]["offset"], 0)
        self.assertEqual(rep["mismatch_pages"], [])
        self.assertEqual(rep["numbering"], [])

    def test_benefit_tables(self):
        cm = pipeline.read_json(self.doc, "coverage_map.json")["coverages"]
        tables = {t["id"]: t for t in pipeline.read_json(self.doc, "tables.json")["tables"]}
        n = 0
        for c in cm:
            bt = c["key"]["benefit_table"]
            if not bt:
                continue
            ts = [tables[t] for t in c["tables"] if tables[t]["owner"] == bt]
            self.assertTrue(ts, c["name"])
            for t in ts:
                self.assertTrue(t["complete"], t["id"])
                self.assertTrue(all(x != "" for r in t["grid"][1:] for x in r if x is not None), t["id"])
            n += 1
        self.assertEqual(n, 100)


if __name__ == "__main__":
    unittest.main()
