"""변환 결과 문서의 메모리 보관, 사용자 수정, 수정 이력, 변환 승인."""
import json
import os
import shutil
import threading

from . import coverage as coverage_mod
from . import summarize as summarize_mod
from . import pipeline, structure
from .pipeline import now, read_json, write_json

EDIT_OPS = ("edit_text", "edit_meta", "split", "merge_prev", "line_to_prev", "line_to_next")


class EditError(Exception):
    pass


class CoverageLocked(Exception):
    """1단계 변환이 승인되지 않아 2단계를 열 수 없습니다."""


class CoverageMixin:
    """2단계: 담보 분류 트리(coverage.json)와 수정 이력(coverage_edits.json)"""

    COV_OPS = ("move", "rename", "select")

    def _require_approved(self):
        st = self.status()
        if not st.get("approved"):
            raise CoverageLocked("1단계 변환 승인 전에는 담보 분류를 열 수 없습니다. 원본 대조 후 [변환 승인]을 눌러 주십시오.")
        return st

    def coverage(self):
        st = self._require_approved()
        cov = read_json(self.path("coverage.json"))
        if cov is None:
            cov = self.build_coverage(st)
        # 담보 분류를 만든 뒤 1단계가 수정·재승인되었으면 다시 만들기를 권합니다.
        bf = cov.get("built_from", {})
        cov["stale"] = bf.get("edits") != len(self.edits())
        return cov

    def build_coverage(self, st=None, keep_user=True):
        st = st or self._require_approved()
        with self.lock:
            old = read_json(self.path("coverage.json"))
            cov = coverage_mod.build_coverage(self.terms, self.tables)
            if old and keep_user:
                prev = {coverage_mod.item_key(i): i for i in old["items"]}
                for it in cov["items"]:
                    o = prev.get(coverage_mod.item_key(it))
                    if o:
                        for k in ("name", "major", "middle", "minor", "selected", "moved", "renamed"):
                            it[k] = o[k]
            cov["built_from"] = {"approved_at": st.get("approved_at"), "built_at": now(),
                                 "edits": len(self.edits())}
            write_json(self.path("coverage.json"), cov)
            return cov

    def coverage_edit(self, op, args, user=""):
        with self.lock:
            cov = self.coverage()
            if op not in self.COV_OPS:
                raise EditError(f"알 수 없는 작업: {op}")
            ids = set(args.get("ids") or ([args["id"]] if args.get("id") else []))
            items = [i for i in cov["items"] if i["id"] in ids]
            if not items:
                raise EditError("담보를 찾지 못했습니다")
            entry = {"ts": now(), "user": user, "op": op, "ids": sorted(ids)}
            if op == "move":
                major = args.get("major")
                if major not in coverage_mod.MAJORS:
                    raise EditError("대분류는 사망·장해·진단·입원·치료·기타 중 하나여야 합니다")
                middle = (args.get("middle") or "").strip() or "기타"
                entry["before"] = [{k: i[k] for k in ("id", "major", "middle", "minor")} for i in items]
                for i in items:
                    i["major"], i["middle"] = major, middle
                    if (args.get("minor") or "").strip():
                        i["minor"] = args["minor"].strip()
                    i["moved"] = True
                entry["after"] = {"major": major, "middle": middle, "minor": args.get("minor", "")}
            elif op == "rename":
                name = (args.get("name") or "").strip()
                if not name or len(items) != 1:
                    raise EditError("이름을 바꿀 담보 하나와 새 이름이 필요합니다")
                entry["before"], entry["after"] = items[0]["name"], name
                items[0]["name"], items[0]["renamed"] = name, name != items[0]["auto_name"]
            elif op == "select":
                for i in items:
                    i["selected"] = bool(args.get("selected"))
                entry["after"] = bool(args.get("selected"))
            write_json(self.path("coverage.json"), cov)
            if op != "select":  # 선택 상태는 이력에 남기지 않습니다(너무 잦음).
                hist = read_json(self.path("coverage_edits.json"), [])
                hist.append(entry)
                write_json(self.path("coverage_edits.json"), hist)
            return cov

    def coverage_edits(self):
        return read_json(self.path("coverage_edits.json"), [])


class SummaryMixin:
    """3단계: 담보별 요약(summaries/<담보ID>.json)과 실행 작업"""

    def _summary_path(self, item_id):
        if not item_id.isalnum():
            raise EditError("담보 ID가 올바르지 않습니다")
        return self.path(os.path.join("summaries", f"{item_id}.json"))

    def summary_of(self, item_id):
        return read_json(self._summary_path(item_id))

    def summary_status(self):
        cov = self.coverage()
        job = getattr(self, "job", None)
        items = {}
        for it in cov["items"]:
            s = self.summary_of(it["id"])
            if s:
                items[it["id"]] = {"state": "완료", "mismatch": len(s["card"]["mismatch"]), "at": s.get("at", ""),
                                   "stale": s.get("terms_edits") != len(self.edits())}
        errors = (job or {}).get("errors", {})
        for k, v in errors.items():
            items.setdefault(k, {"state": "오류", "error": v})
        return {"api_key": summarize_mod.api_key_present(), "model": summarize_mod.MODEL,
                "job": {k: v for k, v in (job or {}).items() if k != "stop"}, "items": items}

    def start_summaries(self, ids, force=False, caller=None):
        cov = self.coverage()
        if getattr(self, "job", None) and not self.job.get("finished", True):
            raise EditError("이미 요약을 실행하고 있습니다")
        if caller is None and not summarize_mod.api_key_present():
            raise EditError("서버에 ANTHROPIC_API_KEY 환경변수가 없습니다. README의 'API 키 설정'을 따라 설정한 뒤 앱을 다시 실행하십시오.")
        by_id = {i["id"]: i for i in cov["items"]}
        todo = [by_id[i] for i in ids if i in by_id]
        if not force:
            todo = [i for i in todo if not self.summary_of(i["id"])]
        job = {"total": len(todo), "done": 0, "current": "", "errors": {}, "finished": False, "stop": False,
               "started_at": now()}
        self.job = job
        os.makedirs(self.path("summaries"), exist_ok=True)

        def run():
            try:
                for it in todo:
                    if job["stop"]:
                        break
                    job["current"] = it["name"]
                    try:
                        res = summarize_mod.summarize_item(it, self.terms, self.tables, self.pages,
                                                           cov.get("common_sections", []),
                                                           **({"caller": caller} if caller else {}))
                        res.update({"at": now(), "terms_edits": len(self.edits())})
                        write_json(self._summary_path(it["id"]), res)
                    except Exception as e:  # 담보 하나의 실패가 나머지를 막지 않게 합니다.
                        job["errors"][it["id"]] = str(e)
                    job["done"] += 1
            finally:
                job["finished"] = True
                job["current"] = ""

        t = threading.Thread(target=run, daemon=True)
        t.start()
        return job, t

    def stop_summaries(self):
        if getattr(self, "job", None):
            self.job["stop"] = True


class Doc(CoverageMixin, SummaryMixin):
    def __init__(self, folder):
        self.folder = folder
        self.lock = threading.RLock()
        self.terms = read_json(self.path("terms.json"))
        self.pages = read_json(self.path("pages.json"))
        self.tables = read_json(self.path("tables.json"))
        self.report = read_json(self.path("report.json"))
        self.meta = read_json(self.path("meta.json"), {})
        self.pagelines = None
        self._index()

    def path(self, name):
        return os.path.join(self.folder, name)

    def _index(self):
        self.by_uid = {n["uid"]: n for n in self.terms["nodes"]}
        self.by_cid = {n["cid"]: n for n in self.terms["nodes"]}
        self.page_nodes = {}
        for n in self.terms["nodes"]:
            for p in {l["p"] for l in n["lines"]}:
                self.page_nodes.setdefault(p, []).append(n)

    # ------------------------------------------------------------ 읽기
    def status(self):
        return read_json(self.path("status.json"), {"approved": False, "history": []})

    def edits(self):
        return read_json(self.path("edits.json"), [])

    def summary(self):
        st = self.status()
        return {"id": os.path.basename(self.folder), "meta": self.meta, "status": st,
                "stats": self.report["stats"],
                "counts": {g["key"]: g["count"] for g in self.report["groups"]},
                "toc_source": self.terms.get("toc_source"), "article_style": self.terms.get("article_style"),
                "sections": [{k: s.get(k) for k in ("id", "title", "kind", "page_start", "page_end", "toc_pages")}
                             for s in self.terms["sections"]],
                "edits": len(self.edits())}

    def page_view(self, pn):
        page = self.pages[pn - 1]
        nodes = []
        for n in self.page_nodes.get(pn, []):
            nodes.append({k: n.get(k) for k in ("uid", "cid", "kind", "num", "title", "label", "text", "path",
                                                 "page_start", "page_end", "parent", "dup", "edited")}
                         | {"boxes": [l["bbox"] for l in n["lines"] if l["p"] == pn],
                            "lines_total": len(n["lines"]),
                            "kind_name": structure.KIND_NAMES.get(n["kind"], n["kind"])})
        order = {n["uid"]: i for i, n in enumerate(self.terms["nodes"])}
        nodes.sort(key=lambda x: order[x["uid"]])
        uids = {n["uid"] for n in nodes}
        refs = [r for r in self.terms["refs"] if r["from_uid"] in uids]
        tables = [t for t in self.tables if t["page"] == pn]
        sec = next((s for s in self.terms["sections"] if s["id"] == page.get("section")), None)
        return {"page": page, "section": sec, "nodes": nodes, "refs": refs, "tables": tables}

    def locate(self, cid):
        n = self.by_cid.get(cid)
        if not n:
            return None
        return {"cid": cid, "uid": n["uid"], "page": n["own_page_start"] or n["page_start"]}

    # ------------------------------------------------------------ 수정
    def _section_neighbors(self, uid):
        nodes = self.terms["nodes"]
        i = next((k for k, n in enumerate(nodes) if n["uid"] == uid), None)
        if i is None:
            raise EditError("조각을 찾지 못했습니다")
        return nodes, i

    def _new_uid(self, base):
        k = 1
        while f"{base}e{k}" in self.by_uid:
            k += 1
        return f"{base}e{k}"

    def apply(self, op, args, user=""):
        with self.lock:
            if op not in EDIT_OPS:
                raise EditError(f"알 수 없는 작업: {op}")
            nodes, i = self._section_neighbors(args.get("uid", ""))
            n = nodes[i]
            before_cid = n["cid"]
            entry = {"ts": now(), "user": user, "op": op, "uid": n["uid"], "cid": before_cid,
                     "page": n["own_page_start"]}
            if op == "edit_text":
                entry["before"] = n["text"]
                n["text"] = args["text"]
                entry["after"] = n["text"]
                n["edited"] = True
            elif op == "edit_meta":
                entry["before"] = {k: n[k] for k in ("kind", "num", "title")}
                kind = args.get("kind", n["kind"])
                if kind not in structure.KIND_NAMES:
                    raise EditError("조각 종류가 올바르지 않습니다")
                n["kind"] = kind
                n["num"] = str(args.get("num", n["num"])).strip()
                n["title"] = str(args.get("title", n["title"])).strip()
                n["label"] = structure.make_label(kind, n["num"])
                entry["after"] = {k: n[k] for k in ("kind", "num", "title")}
                n["edited"] = True
            elif op == "split":
                at = int(args["at_line"])
                tl = n["text"].split("\n")
                if not 0 < at < len(tl):
                    raise EditError("나눌 줄 번호가 올바르지 않습니다(둘째 줄부터 마지막 줄 사이)")
                kind = args.get("kind") or n["kind"]
                num = str(args.get("num", "")).strip()
                gl = n["lines"]
                cut = at if len(gl) == len(tl) else max(1, round(len(gl) * at / len(tl)))
                new = {"uid": self._new_uid(n["uid"]), "section": n["section"], "kind": kind, "parent": None,
                       "num": num, "title": str(args.get("title", "")).strip(),
                       "label": structure.make_label(kind, num), "text": "\n".join(tl[at:]),
                       "lines": gl[cut:] or gl[-1:], "edited": True}
                n["text"] = "\n".join(tl[:at])
                n["lines"] = gl[:cut] or gl[:1]
                nodes.insert(i + 1, new)
                entry["after"] = {"new_uid": new["uid"], "kind": kind, "num": num, "at_line": at}
            elif op == "merge_prev":
                if i == 0 or nodes[i - 1]["section"] != n["section"]:
                    raise EditError("같은 구간 안에 앞 조각이 없습니다")
                prev = nodes[i - 1]
                prev["text"] = (prev["text"] + "\n" + n["text"]).strip("\n")
                prev["lines"] = prev["lines"] + n["lines"]
                prev["edited"] = True
                del nodes[i]
                entry["after"] = {"merged_into": prev["uid"], "merged_cid": prev["cid"]}
            elif op == "line_to_prev":
                if i == 0 or nodes[i - 1]["section"] != n["section"]:
                    raise EditError("같은 구간 안에 앞 조각이 없습니다")
                prev = nodes[i - 1]
                tl = n["text"].split("\n")
                moved = tl.pop(0)
                prev["text"] = (prev["text"] + "\n" + moved).strip("\n")
                if n["lines"]:
                    prev["lines"].append(n["lines"].pop(0))
                n["text"] = "\n".join(tl)
                prev["edited"] = n["edited"] = True
                entry["after"] = {"moved_line": moved, "to": prev["uid"]}
                if not n["text"].strip():
                    prev["lines"] += n["lines"]
                    del nodes[i]
                    entry["after"]["removed_empty"] = True
            elif op == "line_to_next":
                if i + 1 >= len(nodes) or nodes[i + 1]["section"] != n["section"]:
                    raise EditError("같은 구간 안에 다음 조각이 없습니다")
                nxt = nodes[i + 1]
                tl = n["text"].split("\n")
                moved = tl.pop()
                nxt["text"] = (moved + "\n" + nxt["text"]).strip("\n")
                if n["lines"]:
                    nxt["lines"].insert(0, n["lines"].pop())
                n["text"] = "\n".join(tl)
                nxt["edited"] = n["edited"] = True
                entry["after"] = {"moved_line": moved, "to": nxt["uid"]}
                if not n["text"].strip():
                    nxt["lines"] = n["lines"] + nxt["lines"]
                    del nodes[i]
                    entry["after"]["removed_empty"] = True
            self._recompute()
            after = self.by_uid.get(n["uid"])
            entry["cid_after"] = after["cid"] if after else ""
            edits = self.edits()
            edits.append(entry)
            write_json(self.path("edits.json"), edits)
            st = self.status()
            if st.get("approved"):
                st["approved"] = False
                st["history"].append({"ts": now(), "user": user, "action": "승인 해제",
                                      "note": "승인 후 수정이 있어 승인이 해제되었습니다"})
                write_json(self.path("status.json"), st)
            return entry

    def _recompute(self):
        self.report = pipeline.finalize(self.terms, self.pages, self.tables)
        write_json(self.path("terms.json"), self.terms)
        write_json(self.path("tables.json"), self.tables)
        write_json(self.path("report.json"), self.report)
        self._index()

    def reset(self, user=""):
        with self.lock:
            shutil.copyfile(self.path("terms.orig.json"), self.path("terms.json"))
            self.terms = read_json(self.path("terms.json"))
            self._recompute()
            edits = self.edits()
            edits.append({"ts": now(), "user": user, "op": "reset", "uid": "", "cid": "",
                          "after": "모든 수정을 버리고 변환 직후 상태로 되돌림"})
            write_json(self.path("edits.json"), edits)
            self.set_approval(False, user, "원본으로 되돌려 승인 해제")

    def set_approval(self, approved, user="", note=""):
        with self.lock:
            st = self.status()
            st["approved"] = bool(approved)
            if approved:
                st["approved_at"] = now()
                st["approved_by"] = user
                st["approved_report"] = {g["key"]: g["count"] for g in self.report["groups"]}
            st["history"].append({"ts": now(), "user": user, "action": "변환 승인" if approved else "승인 해제",
                                  "note": note})
            write_json(self.path("status.json"), st)
            return st


class Store:
    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)
        self.docs = {}
        self.jobs = {}
        self.lock = threading.Lock()

    def folder(self, doc_id):
        if not doc_id.isalnum():
            raise KeyError(doc_id)
        return os.path.join(self.root, doc_id)

    def list(self):
        out = []
        for d in sorted(os.listdir(self.root)):
            f = os.path.join(self.root, d)
            meta = read_json(os.path.join(f, "meta.json"))
            if meta:
                st = read_json(os.path.join(f, "status.json"), {})
                out.append({"id": d, "filename": meta.get("filename"), "pages": meta.get("pages"),
                            "converted_at": meta.get("converted_at"), "approved": st.get("approved", False),
                            "current": pipeline.is_cached(f)})
            elif d in self.jobs:
                out.append({"id": d, "filename": self.jobs[d].get("filename"), "pages": None,
                            "converted_at": None, "approved": False, "current": False, "converting": True})
        return out

    def get(self, doc_id):
        with self.lock:
            if doc_id not in self.docs:
                f = self.folder(doc_id)
                if not pipeline.is_cached(f):
                    raise KeyError(doc_id)
                self.docs[doc_id] = Doc(f)
            return self.docs[doc_id]

    def start_convert(self, tmp_pdf, filename, force=False):
        doc_id = pipeline.sha256_file(tmp_pdf)[:24]
        f = self.folder(doc_id)
        os.makedirs(f, exist_ok=True)
        src = os.path.join(f, "source.pdf")
        if not os.path.exists(src):
            shutil.move(tmp_pdf, src)
        else:
            os.remove(tmp_pdf)
        if pipeline.is_cached(f) and not force:
            return doc_id, True
        with self.lock:
            if doc_id in self.jobs and not self.jobs[doc_id].get("finished"):
                return doc_id, False
            self.docs.pop(doc_id, None)
            job = {"stage": "대기", "done": 0, "total": 1, "filename": filename, "finished": False, "error": ""}
            self.jobs[doc_id] = job

        def progress(**k):
            job.update(k)

        def run():
            try:
                pipeline.convert(src, f, filename, progress)
            except Exception as e:  # 실패 내용을 화면에 보여 줍니다.
                job["error"] = f"{type(e).__name__}: {e}"
            finally:
                job["finished"] = True

        threading.Thread(target=run, daemon=True).start()
        return doc_id, False

    def progress(self, doc_id):
        job = self.jobs.get(doc_id)
        if job:
            return job
        if pipeline.is_cached(self.folder(doc_id)):
            return {"stage": "완료", "done": 1, "total": 1, "finished": True, "error": ""}
        return {"stage": "없음", "done": 0, "total": 1, "finished": True, "error": "변환 기록이 없습니다"}
