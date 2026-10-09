"""Static field defaults agree with owned Python semantics without executing inputs."""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FieldDefaultsAcceptance(unittest.TestCase):
    def cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, arguments)], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_static_field_defaults_match_owned_python_and_reject_computed_behavior(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, records, html, manifest, spec = [root / name for name in
                                                  ("model.py", "records.json", "app.html", "manifest.json", "spec.json")]
            rows = [{"id": "default"}, {"id": "custom", "title": "λ\nline", "quantity": -3, "enabled": True}]
            records.write_text(json.dumps({"records": rows}))
            source = '''from dataclasses import dataclass, field
from typing import Literal
@dataclass
class Note:
    id: str
    title: str = field(default_factory=str)
    quantity: int = field(default_factory=int)
    enabled: bool = field(default_factory=bool)
    optional: int | None = field(default=None)
    status: Literal['Queued', 'Done'] = field(default='Queued')
'''
            model.write_text(source)
            self.cli("from-python", model, records, "-o", html, "--manifest", manifest, "--extracted-spec", spec)
            data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', html.read_text(), re.S)[1])
            native = subprocess.run([sys.executable, "-c",
                "import dataclasses,json,runpy,sys; cls=runpy.run_path(sys.argv[1])['Note']; "
                "print(json.dumps([dataclasses.asdict(cls(**r)) for r in json.load(open(sys.argv[2]))['records']]))",
                str(model), str(records)], text=True, capture_output=True, check=True, timeout=10)
            self.assertEqual(data["records"], json.loads(native.stdout))
            evidence = json.loads(manifest.read_text())["extraction"]
            self.assertFalse(evidence["source_executed"])
            self.assertEqual(evidence["fields"][1]["default_expression"], "field(default_factory=str)")
            self.cli("verify-python-build", model, records, html, "--manifest", manifest)
            runtime = subprocess.run(["node", "-e", "const fs=require('node:fs'),r=require('./afterlife/runtime.js');"
                "const p=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(r.applyOperation(p.spec,p.records,"
                "{op:'edit',id:'default',changes:{title:'Updated',quantity:8,enabled:true,status:'Done'}})));"],
                cwd=ROOT, input=json.dumps(data), text=True, capture_output=True, check=True, timeout=10)
            changed = json.loads(runtime.stdout)
            self.assertEqual(changed[0]["quantity"], 8)
            backup = root / "backup.json"
            backup.write_text(json.dumps({"format": "afterlife-data/v1", "app_id": data["spec"]["app_id"],
                                          "spec_fingerprint": data["spec_fingerprint"], "records": changed}))
            rebuilt = root / "rebuilt.html"
            self.cli("from-export", spec, backup, "-o", rebuilt)
            self.assertEqual(json.loads(re.search(r'id="afterlife-data">(.*?)</script>', rebuilt.read_text(), re.S)[1])["records"], changed)
            protected = {path: path.read_bytes() for path in (records, html, manifest, spec, backup, rebuilt)}
            sentinel = root / "executed"
            hostile = "__import__('pathlib').Path(" + repr(str(sentinel)) + ").touch()"
            for expression in ("field(default_factory=lambda: " + hostile + ")", "field(default_factory=" + hostile + ")",
                               "field(default_factory=str())", "field(default_factory=list)", "field(default='x', init=False)",
                               "field(default='x', default_factory=str)", "field('x')", "field(default_factory=int)"):
                # The final case is a type mismatch, not an unknown factory.
                model.write_text(source.replace("field(default_factory=str)", expression))
                self.cli("from-python", model, records, "-o", html, "--manifest", manifest,
                         "--extracted-spec", spec, "--force", expected=2)
                self.assertFalse(sentinel.exists())
                self.assertEqual({path: path.read_bytes() for path in protected}, protected)
            for invalid in (source.replace("dataclass, field", "dataclass, field as f"),
                            source.replace("    enabled: bool", "    field: bool"),
                            source.replace("dataclass, field", "dataclass")):
                model.write_text(invalid)
                self.cli("from-python", model, records, "-o", html, "--force", expected=2)
                self.assertEqual(html.read_bytes(), protected[html])
