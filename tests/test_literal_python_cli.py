"""Explicit source choices survive extraction, native validation, runtime edits and rebuild."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class LiteralPythonAcceptance(unittest.TestCase):
    def cli(self, *args, expected=0):
        result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, args)], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_explicit_string_choices_roundtrip_and_computed_choices_never_execute(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, records, artifact, manifest, spec_path = [root / name for name in
                ("model.py", "records.json", "app.html", "manifest.json", "spec.json")]
            rows = [{"id": "default"}, {"id": "second", "status": "Done", "quantity": 2}]
            records.write_text(json.dumps({"records": rows}))
            template = "from __future__ import annotations\nfrom dataclasses import dataclass\n{imports}\n@dataclass\nclass Ticket:\n    id: str\n    status: {choice} = {default}\n    quantity: {nullable} = None\n"
            variants = [("from typing import Literal, Optional", "Literal", "Optional[int]"),
                        ("import typing", "typing.Literal", "typing.Optional[int]")]
            baseline = None
            for imports, literal, nullable in variants:
                model.write_text(template.format(imports=imports, choice=literal + "['Queued', 'Done', 'λ <tag>']",
                                                 default="'Queued'", nullable=nullable))
                self.cli("from-python", model, records, "-o", artifact, "--manifest", manifest,
                         "--extracted-spec", spec_path, "--force")
                data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', artifact.read_text(), re.S)[1])
                choice = data["spec"]["fields"][0]
                self.assertEqual((choice["type"], choice["options"], choice["default"], choice["required"]),
                                 ("select", ["Queued", "Done", "λ <tag>"], "Queued", True))
                expected = [{"id": "default", "status": "Queued", "quantity": None},
                            {"id": "second", "status": "Done", "quantity": 2}]
                self.assertEqual(data["records"], expected)
                observed = (data["spec"], data["records"])
                if baseline is None:
                    baseline = observed
                self.assertEqual(observed, baseline)
                self.assertFalse(json.loads(manifest.read_text())["extraction"]["source_executed"])
                native = subprocess.run([sys.executable, "-c",
                    "import dataclasses,json,runpy,sys,typing; loaded=runpy.run_path(sys.argv[1]); cls=loaded['Ticket']; "
                    "print(json.dumps({'options':typing.get_args(typing.get_type_hints(cls,globalns=loaded)['status']),"
                    "'records':[dataclasses.asdict(cls(**r)) for r in json.load(open(sys.argv[2]))['records']]}))",
                    str(model), str(records)], text=True, capture_output=True, check=True, timeout=10)
                self.assertEqual(json.loads(native.stdout), {"options": choice["options"], "records": expected})
            runtime = subprocess.run(["node", "-e", "const fs=require('node:fs'),r=require('./afterlife/runtime.js');"
                "const p=JSON.parse(fs.readFileSync(0,'utf8'));let out=r.applyOperation(p.spec,p.records,{op:'edit',id:'default',changes:{status:'λ <tag>'}});"
                "let refused=0;for(const value of ['',null,'Unknown',3]){try{r.applyOperation(p.spec,out,{op:'edit',id:'default',changes:{status:value}})}catch(e){refused++}}"
                "process.stdout.write(JSON.stringify({records:out,refused}));"], cwd=ROOT, input=json.dumps(data),
                text=True, capture_output=True, check=True, timeout=10)
            changed = json.loads(runtime.stdout)
            self.assertEqual(changed["refused"], 4)
            self.assertEqual(changed["records"], [{"id": "default", "status": "λ <tag>", "quantity": None}, expected[1]])
            backup = root / "backup.json"
            backup.write_text(json.dumps({"format": "afterlife-data/v1", "app_id": data["spec"]["app_id"],
                "spec_fingerprint": data["spec_fingerprint"], "records": changed["records"]}))
            rebuilt = root / "rebuilt.html"
            self.cli("from-export", spec_path, backup, "-o", rebuilt)
            restored = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', rebuilt.read_text(), re.S)[1])
            self.assertEqual(restored["records"], changed["records"])
            protected = {p: p.read_bytes() for p in (records, artifact, manifest, spec_path, rebuilt)}
            sentinel = root / "computed-choice"
            invalid = [("from typing import Literal", "Literal['Queued', 'Queued']", "'Queued'"),
                       ("from typing import Literal", "Literal['Queued', 3]", "'Queued'"),
                       ("from typing import Literal", "Literal['Queued', 'Done']", "'Unknown'"),
                       ("from typing import Literal", "Literal['']", "''"),
                       ("from typing import Literal", "Literal[()]", "'Queued'"),
                       ("from typing import Literal as L", "L['Queued']", "'Queued'"),
                       ("", "Literal['Queued']", "'Queued'"),
                       ("from typing import Literal", f"Literal[__import__('pathlib').Path({str(sentinel)!r}).touch()]", "'Queued'"),
                       ("from typing import Literal", "Literal[" + ",".join(repr(str(i)) for i in range(101)) + "]", "'0'")]
            for imports, choice, default in invalid:
                source = template.format(imports=imports, choice=choice, default=default, nullable="int | None")
                model.write_text(source)
                self.cli("from-python", model, records, "-o", artifact, "--manifest", manifest,
                         "--extracted-spec", spec_path, "--force", expected=2)
                self.assertEqual({p: p.read_bytes() for p in protected}, protected)
                self.assertEqual(model.read_text(), source)
                self.assertFalse(sentinel.exists())
