"""Retained HTML and manifest handoff verification through the actual CLI."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ArtifactVerificationAcceptance(unittest.TestCase):
    def cli(self, *args, expected=0):
        result = subprocess.run([sys.executable,"-m","afterlife",*map(str,args)],cwd=ROOT,
                                capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,expected,result.stdout+result.stderr)
        return result

    def test_retained_pair_detects_drift_without_execution_and_declares_untrusted_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact, manifest = root/"app.html", root/"manifest.json"
            self.cli(ROOT/"examples/task-tracker/app.json",ROOT/"examples/task-tracker/records.json",
                     "-o",artifact,"--manifest",manifest)
            original = {p:p.read_bytes() for p in (artifact,manifest)}
            args = ("verify-artifact",artifact,"--manifest",manifest)
            checked = json.loads(self.cli(*args).stdout)
            self.assertTrue(checked["matched"])
            self.assertEqual(checked["artifact_bytes"],len(original[artifact]))
            self.assertEqual(checked["actual_sha256"],json.loads(original[manifest])["artifact_sha256"])
            self.assertEqual({p:p.read_bytes() for p in original},original)
            artifact.write_bytes(original[artifact]+b'\n<script>throw new Error("must not execute")</script>')
            drifted = artifact.read_bytes()
            mismatch = json.loads(self.cli(*args,expected=1).stdout)
            self.assertFalse(mismatch["matched"])
            self.assertEqual(artifact.read_bytes(),drifted)
            self.assertEqual(manifest.read_bytes(),original[manifest])
            forged = json.loads(original[manifest])
            forged["artifact_sha256"] = hashlib.sha256(drifted).hexdigest()
            manifest.write_text(json.dumps(forged))
            # A changed pair can match: this command must explicitly limit its
            # claim rather than present attacker-controlled hashes as trust.
            untrusted = json.loads(self.cli(*args).stdout)
            self.assertTrue(untrusted["matched"])
            self.assertIn("does not establish authenticity",untrusted["scope"])
            for value in ["{}",json.dumps({**forged,"artifact_sha256":"bad"}),
                          json.dumps(forged).replace('"artifact_sha256":','"artifact_sha256":"shadow", "artifact_sha256":')]:
                manifest.write_text(value)
                before = manifest.read_bytes()
                self.cli(*args,expected=2)
                self.assertEqual(manifest.read_bytes(),before)
                self.assertEqual(artifact.read_bytes(),drifted)
            manifest.write_bytes(original[manifest])
            fifo = root/"unavailable.html";os.mkfifo(fifo)
            self.cli("verify-artifact",fifo,"--manifest",manifest,expected=2)
            self.assertEqual(artifact.read_bytes(),drifted)
