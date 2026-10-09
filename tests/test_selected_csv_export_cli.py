"""Selected native sharing agrees with browser exporter and typed partial patching."""
import copy
import csv
import io
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class SelectedCSVExportAcceptance(unittest.TestCase):
    def cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, arguments)], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_selected_sharing_omits_hidden_values_and_patches_without_losing_unselected_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = ROOT / "examples/task-tracker/app.json"
            html = root / "app.html"
            self.cli(spec, ROOT / "examples/task-tracker/records.json", "-o", html)
            data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', html.read_text(), re.S)[1])
            baseline = data["records"][0]
            rows = [{**baseline, "id": "001", "title": '=formula\r\nλ "quoted"', "notes": "hidden-sensitive-value"},
                    {**baseline, "id": "unselected", "title": "hidden-unselected-title"},
                    {**baseline, "id": "last", "title": "'literal", "important": False}]
            backup = root / "backup.json"
            envelope = {"format": "afterlife-data/v1", "app_id": data["spec"]["app_id"],
                        "spec_fingerprint": data["spec_fingerprint"], "records": rows}
            backup.write_text(json.dumps(envelope))
            output = root / "selected.csv"
            args = ["export-csv", spec, backup, "--text-policy", "afterlife", "--field", "important", "--field", "title",
                    "--record-id", "last", "--record-id", "001", "-o", output]
            receipt = json.loads(self.cli(*args).stdout)
            self.assertTrue(receipt["partial"])
            self.assertEqual((receipt["records"], receipt["fields"], receipt["omitted_fields"], receipt["omitted_records"]), (2, 2, 3, 1))
            runtime = subprocess.run(["node", "-e", "const fs=require('node:fs'),r=require('./afterlife/runtime.js');"
                "const p=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(r.exportCSV(p.spec,p.records,new Set(['important','title'])));"],
                cwd=ROOT, input=json.dumps({"spec": data["spec"], "records": [rows[0], rows[2]]}).encode(),
                capture_output=True, check=True, timeout=10)
            self.assertEqual(output.read_bytes(), runtime.stdout)
            self.assertNotIn("hidden-", output.read_text())
            self.assertNotIn("001", json.dumps(receipt))
            reader = csv.DictReader(io.StringIO(output.read_bytes().decode(), newline=""))
            selected = list(reader)
            self.assertEqual(reader.fieldnames, ["id", "title", "important"])
            selected[0]["title"] = "'Updated selected title"
            stream = io.StringIO(newline="")
            writer = csv.DictWriter(stream, fieldnames=reader.fieldnames, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(selected)
            output.write_bytes(stream.getvalue().encode())
            proposed, review = root / "proposal.json", root / "review.json"
            self.cli("patch-csv", spec, backup, output, "--text-policy", "afterlife", "-o", proposed, "--review", review)
            changed = json.loads(proposed.read_text())["records"]
            expected = copy.deepcopy(rows)
            expected[0]["title"] = "Updated selected title"
            self.assertEqual(changed, expected)
            restored = root / "restored.html"
            self.cli("from-export", spec, proposed, "--against", backup, "--review", review, "-o", restored)
            self.assertEqual(json.loads(re.search(r'id="afterlife-data">(.*?)</script>', restored.read_text(), re.S)[1])["records"], expected)
            protected = {path: path.read_bytes() for path in (backup, output, proposed, review, html, restored)}
            base = ["export-csv", spec, backup, "--text-policy", "afterlife", "-o", output, "--force"]
            for selection in (("--field", "notes", "--field", "notes"), ("--field", "absent"),
                              ("--field", "id"), ("--record-id", "001", "--record-id", "001"),
                              ("--record-id", "absent")):
                self.cli(*base, *selection, expected=2)
                self.assertEqual({path: path.read_bytes() for path in protected}, protected)
            broken = copy.deepcopy(envelope)
            broken["records"][1]["hours"] = "invalid unselected integer"
            backup.write_text(json.dumps(broken))
            self.cli(*args, "--force", expected=2)
            self.assertEqual(output.read_bytes(), protected[output])
            backup.write_bytes(protected[backup])
