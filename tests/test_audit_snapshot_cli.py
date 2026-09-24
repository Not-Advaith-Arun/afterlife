"""CLI acceptance of a model source changing during static capability audit."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AuditSnapshotAcceptance(unittest.TestCase):
    def test_external_model_edit_between_inventory_and_extraction_fails_closed(self):
        # A deterministic rendezvous reaches a rare two-read source identity race
        # through the actual CLI, without importing or executing supplied models.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model,ready,release = root / "model.py",root / "ready",root / "release"
            original = b"from dataclasses import dataclass\n@dataclass\nclass Note:\n    id: str\n    title: str = 'Original literal'\n"
            replacement = original.replace(b"Original literal",b"Replacement literal")
            model.write_bytes(original)
            code = ("import sys,time; from pathlib import Path; from unittest.mock import patch; "
                    "from afterlife import audit; from afterlife.__main__ import main\n"
                    "ready,release=map(Path,sys.argv[1:3]); original=audit.extract_python_model\n"
                    "def paused(*args,**kwargs):\n"
                    " ready.write_text('inventory captured'); deadline=time.monotonic()+8\n"
                    " while not release.exists():\n"
                    "  if time.monotonic()>deadline: raise RuntimeError('audit rendezvous expired')\n"
                    "  time.sleep(0.01)\n"
                    " return original(*args,**kwargs)\n"
                    "with patch.object(audit,'extract_python_model',paused): raise SystemExit(main(sys.argv[3:]))\n")
            process = subprocess.Popen([sys.executable,"-c",code,str(ready),str(release),"audit-python",str(model)],cwd=ROOT,
                stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                deadline=time.monotonic()+8
                while not ready.exists() and process.poll() is None and time.monotonic()<deadline: time.sleep(0.01)
                self.assertTrue(ready.exists(),"Audit did not reach actual source inventory rendezvous")
                model.write_bytes(replacement)
                release.touch()
                out,err=process.communicate(timeout=10)
                self.assertEqual(process.returncode,2,out+err)
                report=json.loads(out)
            finally:
                release.touch()
                if process.poll() is None: process.kill();process.communicate()
            self.assertFalse(report["source_executed"])
            self.assertEqual(report["model"]["status"],"unsupported")
            self.assertEqual(report["files"][0]["sha256"],hashlib.sha256(original).hexdigest())
            self.assertTrue(any("changed while being inspected" in row["detail"] for row in report["findings"]))
            self.assertEqual(model.read_bytes(),replacement)
            model.write_bytes(original)
            fresh=subprocess.run([sys.executable,"-m","afterlife","audit-python",str(model)],cwd=ROOT,
                                 capture_output=True,text=True,timeout=10)
            self.assertEqual(fresh.returncode,0,fresh.stdout+fresh.stderr)
            stable=json.loads(fresh.stdout)
            self.assertEqual(stable["model"]["status"],"supported")
            self.assertEqual(stable["findings"],[])
            self.assertFalse(stable["source_executed"])
            self.assertEqual(model.read_bytes(),original)
