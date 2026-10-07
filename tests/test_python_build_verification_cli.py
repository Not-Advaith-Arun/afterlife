"""Retained Python-derived builds bind supplied source evidence without source execution."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PythonBuildVerificationAcceptance(unittest.TestCase):
    def cli(self, *args, expected=0):
        result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, args)], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return json.loads(result.stdout) if result.stdout.startswith("{") else result

    def test_real_python_build_and_source_manifest_reject_forgery_without_execution_or_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, data, artifact, manifest = [root / name for name in ("model.py", "records.json", "app.html", "manifest.json")]
            model.write_text("from dataclasses import dataclass\nfrom typing import Literal, Optional\n"
                             "@dataclass\nclass Task:\n    id: str\n    status: Literal['Open', 'Done'] = 'Open'\n    quantity: Optional[int] = None\n")
            data.write_text('{"records":[{"id":"private-record","quantity":2}]}')
            options = ("--app-id", "custom-app", "--title", "Private title", "--record-label", "entry")
            self.cli("from-python", model, data, "-o", artifact, "--manifest", manifest, *options)
            saved = {p: p.read_bytes() for p in (model, data, artifact, manifest)}
            args = ("verify-python-build", model, data, artifact, *options)
            report = self.cli(*args, "--manifest", manifest)
            self.assertTrue(report["matched"])
            self.assertTrue(report["artifact_matched"])
            self.assertTrue(report["manifest_matched"])
            self.assertFalse(report["source_executed"])
            self.assertNotIn("private-record", json.dumps(report))
            self.assertNotIn("Private title", json.dumps(report))
            self.assertIsNone(self.cli(*args)["manifest_matched"])
            # Equivalent derived HTML is not proof of identical source bytes.
            model.write_bytes(saved[model] + b"\n# a source-only change\n")
            self.assertTrue(self.cli(*args)["matched"])
            comment = self.cli(*args, "--manifest", manifest, expected=1)
            self.assertTrue(comment["artifact_matched"])
            self.assertFalse(comment["manifest_matched"])
            model.write_bytes(saved[model])
            self.cli("verify-python-build", model, data, artifact, "--manifest", manifest, expected=1)
            artifact.write_bytes(saved[artifact] + b"<script>throw new Error('never executed')</script>")
            forged = json.loads(saved[manifest]); forged["artifact_sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
            manifest.write_text(json.dumps(forged))
            self.assertTrue(self.cli("verify-artifact", artifact, "--manifest", manifest)["matched"])
            self.assertFalse(self.cli(*args, "--manifest", manifest, expected=1)["matched"])
            artifact.write_bytes(saved[artifact]); manifest.write_bytes(saved[manifest])
            data.write_text('{"records":[]}')
            self.cli(*args, "--manifest", manifest, expected=1)
            data.write_bytes(saved[data])
            sentinel = root / "executed"
            hostile = saved[model] + f"\nopen({str(sentinel)!r}, 'w').write('executed')\n".encode()
            model.write_bytes(hostile)
            self.cli(*args, "--manifest", manifest, expected=2)
            self.assertFalse(sentinel.exists())
            self.assertEqual(model.read_bytes(), hostile)
            model.write_bytes(saved[model])
            manifest.write_text('{"format":"wrong"}')
            self.cli(*args, "--manifest", manifest, expected=2)
            self.assertEqual(manifest.read_text(), '{"format":"wrong"}')
            manifest.write_bytes(saved[manifest])
            self.assertEqual({p: p.read_bytes() for p in saved}, saved)
