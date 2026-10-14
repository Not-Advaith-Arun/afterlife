"""The conversion boundary is reported through the CLI without replacing inputs."""
import json
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
            def cli(*args, expected=0):
                result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, args)],
                                        cwd=ROOT, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                return result
            report = json.loads(cli("audit-python", model, "--application-source", application,
                                    expected=2).stdout)
            self.assertTrue(report["findings"])
            cli("examples/task-tracker/app.json", "examples/task-tracker/records.json", "-o", output)
            before = output.read_bytes()
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
            source_before = model.read_bytes()
            cli("audit-python", model, "-o", model, "--force", expected=2)
            self.assertEqual(model.read_bytes(), source_before)
