"""The conversion boundary is reported through the CLI without replacing inputs."""
import csv
import io
import re
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class EndToEndTests(unittest.TestCase):
    def test_audit_and_compile_protect_sources_and_existing_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "app.html"
            model = ROOT / "examples/python-loans/model.py"
            application = ROOT / "examples/python-loans/app.py"
            def cli(*args, expected=0, timeout=15):
                result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, args)],
                                        cwd=ROOT, capture_output=True, text=True, timeout=timeout)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                return result
            report = json.loads(cli("audit-python", model, "--application-source", application,
                                    expected=2).stdout)
            self.assertTrue(report["findings"])
            cli("examples/task-tracker/app.json", "examples/task-tracker/records.json", "-o", output)
            before = output.read_bytes()
            fifo = Path(directory) / "input.json"
            os.mkfifo(fifo)
            for arguments in ((fifo, "examples/task-tracker/records.json", "-o", output, "--force"),
                              ("from-python", fifo, "examples/task-tracker/records.json", "-o", output, "--force"),
                              ("audit-python", model, "--application-source", fifo)):
                cli(*arguments, expected=2, timeout=3)
                self.assertEqual(output.read_bytes(), before)
            cli("examples/task-tracker/app.json", "examples/task-tracker/records.json", "-o", output,
                expected=2)
            self.assertEqual(output.read_bytes(), before)
            manifest = Path(directory) / "manifest.json"
            original_report = Path(directory) / "report.json"
            original_report.write_text("preserve report")
            manifest.symlink_to(original_report)
            for invalid in (manifest, Path(directory)):
                cli("examples/task-tracker/app.json", "examples/task-tracker/records.json", "-o", output,
                    "--manifest", invalid, "--force", expected=2)
                self.assertEqual(output.read_bytes(), before)
                self.assertEqual(original_report.read_text(), "preserve report")
            manifest.unlink()
            cli("examples/task-tracker/app.json", "examples/task-tracker/records.json", "-o", output,
                "--manifest", manifest, "--force")
            self.assertEqual(json.loads(manifest.read_text())["record_count"], 3)
            payload = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', output.read_text(), re.S)[1])
            payload["records"][0]["title"] = '=1+1,"quoted"\nnext line'
            csv_result = subprocess.run(["node", "-e", "const fs=require('node:fs'); const {exportCSV}=require('./afterlife/runtime.js'); const p=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(exportCSV(p.spec,p.records));"],
                                        input=json.dumps(payload), cwd=ROOT, text=True, capture_output=True, check=True)
            table = list(csv.reader(io.StringIO(csv_result.stdout)))
            title_column = table[0].index("title")
            self.assertEqual(table[1][title_column], "'=1+1,\"quoted\"\nnext line")
            self.assertEqual(len(table), 4)
            self.assertEqual(len(table[0]), len(table[1]))
            source_before = model.read_bytes()
            cli("audit-python", model, "-o", model, "--force", expected=2)
            self.assertEqual(model.read_bytes(), source_before)
