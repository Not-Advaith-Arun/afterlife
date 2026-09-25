"""Retained releases are checked against explicit inputs, not supplied hash claims."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]


class BuildVerificationAcceptance(unittest.TestCase):
    def test_actual_build_matches_and_forged_pair_or_changed_inputs_do_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); html=root/'app.html'; manifest=root/'manifest.json'; data=root/'data.json'
            spec=ROOT/'examples/task-tracker/app.json'
            data.write_bytes((ROOT/'examples/task-tracker/records.json').read_bytes())
            def cli(*args,expected=0):
                r=subprocess.run([sys.executable,'-m','afterlife',*map(str,args)],cwd=ROOT,
                                 capture_output=True,text=True,timeout=5)
                self.assertEqual(r.returncode,expected,r.stdout+r.stderr)
                return json.loads(r.stdout) if r.stdout.startswith('{') else r
            cli(spec,data,'-o',html,'--manifest',manifest)
            originals={p:p.read_bytes() for p in (spec,data,html,manifest)}
            args=('verify-build',spec,data,html)
            result=cli(*args)
            self.assertTrue(result['matched'])
            self.assertEqual(result['expected_sha256'],json.loads(originals[manifest])['artifact_sha256'])
            self.assertEqual({p:p.read_bytes() for p in originals},originals)
            html.write_bytes(originals[html]+b'<script>throw new Error("not executed")</script>')
            forged=json.loads(originals[manifest]);forged['artifact_sha256']=hashlib.sha256(html.read_bytes()).hexdigest()
            manifest.write_text(json.dumps(forged))
            self.assertTrue(cli('verify-artifact',html,'--manifest',manifest)['matched'])
            self.assertFalse(cli(*args,expected=1)['matched'])
            self.assertIn('does not by itself establish tampering',cli(*args,expected=1)['scope'])
            html.write_bytes(originals[html]);data.write_text('{"records":[]}')
            self.assertFalse(cli(*args,expected=1)['matched'])
            invalid=data.read_bytes();data.write_text('{}');cli(*args,expected=2)
            self.assertEqual(data.read_text(),'{}');data.write_bytes(invalid)
            fifo=root/'unavailable.html';os.mkfifo(fifo)
            cli('verify-build',spec,data,fifo,expected=2)
            self.assertEqual(html.read_bytes(),originals[html])
            self.assertEqual(spec.read_bytes(),originals[spec])
            self.assertEqual(json.loads(manifest.read_bytes()),forged)
