"""Native backup -> explicit typed CSV -> native restore matches the existing runtime exporter."""
import copy
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CSVExportAcceptance(unittest.TestCase):
    def cli(self, *args, expected=0):
        result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, args)], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return json.loads(result.stdout) if result.stdout.startswith("{") else result

    def test_typed_csv_export_roundtrips_exact_values_and_preserves_inputs_and_prior_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = ROOT / "examples/task-tracker/app.json"
            app, backup, exported, restored, rebuilt = [root / name for name in
                ("app.html", "backup.json", "records.csv", "restored.json", "rebuilt.html")]
            self.cli(spec, ROOT / "examples/task-tracker/records.json", "-o", app)
            data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', app.read_text(), re.S)[1])
            original = data["records"][0]
            rows = [{**original, "id": "001", "title": "00123", "notes": '=SUM(1,2)\r\nλ "quoted"', "hours": None},
                    {**original, "id": "'already", "title": "'literal", "notes": "", "hours": 9007199254740991, "important": False},
                    {**original, "id": "last", "notes": "line\nnext", "hours": 0}]
            envelope = {"format": "afterlife-data/v1", "app_id": data["spec"]["app_id"],
                        "spec_fingerprint": data["spec_fingerprint"], "records": rows}
            backup.write_text(json.dumps(envelope))
            protected = {p: p.read_bytes() for p in (spec, backup, app)}
            runtime = subprocess.run(["node", "-e", "const fs=require('node:fs'),r=require('./afterlife/runtime.js');"
                "const p=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(r.exportCSV(p.spec,p.records));"],
                cwd=ROOT, input=json.dumps({"spec": data["spec"], "records": rows}).encode(),
                capture_output=True, check=True, timeout=10)
            for policy in ("afterlife", "literal"):
                receipt = self.cli("export-csv", spec, backup, "--text-policy", policy, "-o", exported, "--force")
                self.assertEqual(receipt["records"], 3)
                self.assertEqual(receipt["csv_bytes"], len(exported.read_bytes()))
                self.assertNotIn("00123", json.dumps(receipt))
                self.assertEqual(exported.stat().st_mode & 0o777, 0o600)
                if policy == "afterlife":
                    self.assertEqual(exported.read_bytes(), runtime.stdout)
                self.cli("import-csv", spec, exported, "--text-policy", policy, "-o", restored, "--force")
                self.assertEqual(json.loads(restored.read_text()), envelope)
                self.cli("review-export", spec, restored, "--against", backup, "--check")
                self.cli("from-export", spec, restored, "-o", rebuilt, "--force")
                embedded = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', rebuilt.read_text(), re.S)[1])
                self.assertEqual(embedded["records"], rows)
            previous = exported.read_bytes()
            self.cli("export-csv", spec, backup, "--text-policy", "afterlife", "-o", exported, expected=2)
            self.cli("export-csv", spec, backup, "-o", exported, "--force", expected=2)
            self.assertEqual(exported.read_bytes(), previous)
            invalid = copy.deepcopy(envelope); invalid["records"][-1]["hours"] = 9007199254740992
            backup.write_text(json.dumps(invalid))
            self.cli("export-csv", spec, backup, "--text-policy", "afterlife", "-o", exported, "--force", expected=2)
            self.assertEqual(exported.read_bytes(), previous)
            backup.write_bytes(protected[backup])
            for source in (spec, backup):
                self.cli("export-csv", spec, backup, "--text-policy", "afterlife", "-o", source, "--force", expected=2)
            self.assertEqual({p: p.read_bytes() for p in protected}, protected)
