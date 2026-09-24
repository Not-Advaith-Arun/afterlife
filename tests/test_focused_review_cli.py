"""A selected change review must never masquerade as a whole-backup guard."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FocusedReviewAcceptance(unittest.TestCase):
    def cli(self, *args, expected=0):
        result = subprocess.run([sys.executable, "-m", "afterlife", *map(str,args)],
                                cwd=ROOT, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, expected, result.stdout+result.stderr)
        return result

    def test_selected_changes_preserve_global_guard_and_refuse_partial_restoration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = ROOT / "examples/task-tracker/app.json"
            output, current, incoming, guard, partial = [root/name for name in
                ("app.html","current.json","incoming.json","guard.json","partial.json")]
            self.cli(spec, ROOT / "examples/task-tracker/records.json", "-o", output)
            data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>',output.read_text(),re.S)[1])
            row = data["records"][0]
            envelope = {"format":"afterlife-data/v1", "app_id":data["spec"]["app_id"],
                        "spec_fingerprint":data["spec_fingerprint"]}
            current.write_text(json.dumps({**envelope,"records":[{**row,"id":key} for key in ("edit","remove","same")]}))
            incoming.write_text(json.dumps({**envelope,"records":[{**row,"id":"edit","title":"Private replacement"},
                {**row,"id":"same"},{**row,"id":"add"}]}))
            saved = {p:p.read_bytes() for p in (spec,current,incoming)}
            args = ("review-export",spec,incoming,"--against",current)
            full = json.loads(self.cli(*args).stdout)
            selected = json.loads(self.cli(*args,"--record-id","edit","--record-id","add","--output",guard,"--check",expected=1).stdout)
            self.assertEqual(json.loads(guard.read_text()),full)
            self.assertEqual(selected["counts"],full["counts"])
            self.assertEqual(selected["current_records_sha256"],full["current_records_sha256"])
            self.assertEqual(selected["incoming_records_sha256"],full["incoming_records_sha256"])
            self.assertEqual(selected["selected_record_ids"],["add","edit"])
            self.assertEqual(selected["added"],["add"])
            self.assertEqual(selected["removed"],[])
            self.assertEqual(selected["changed"],[{"id":"edit","fields":["title"]}])
            self.assertEqual(selected["selected_counts"],{"added":1,"removed":0,"changed":1})
            self.assertEqual(selected["omitted_change_records"],1)
            self.assertNotIn("Private replacement",json.dumps(selected))
            partial.write_text(json.dumps(selected))
            original = output.read_bytes()
            self.cli("from-export",spec,incoming,"--against",current,"--review",partial,"-o",output,"--force",expected=2)
            self.assertEqual(output.read_bytes(),original)
            self.cli("from-export",spec,incoming,"--against",current,"--review",guard,"-o",output,"--force")
            self.assertIn("Private replacement",output.read_text())
            for selection in [("same",),("unknown",),("edit","edit")]:
                absent = root/"absent.json"
                flags = [part for key in selection for part in ("--record-id",key)]
                self.cli(*args,*flags,"--output",absent,expected=2)
                self.assertFalse(absent.exists())
            self.assertEqual({p:p.read_bytes() for p in saved},saved)
