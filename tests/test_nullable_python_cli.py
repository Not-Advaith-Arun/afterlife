"""Actual Python dataclass defaults versus non-executing CLI extraction and rebuild."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class NullablePythonAcceptance(unittest.TestCase):
    def cli(self, *args, expected=0):
        result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, args)], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_nullable_spellings_match_python_defaults_and_refuse_dynamic_or_shadowed_types(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, records, artifact, manifest, extracted = [root / name for name in
                ("model.py", "records.json", "app.html", "manifest.json", "spec.json")]
            rows = [{"id": "default"}, {"id": "negative", "quantity": -2, "notes": "λ\r\nline"},
                    {"id": "null", "quantity": None}]
            records.write_text(json.dumps({"records": rows}))
            template = "from __future__ import annotations\nfrom dataclasses import dataclass\n{imports}\n@dataclass\nclass Metric:\n    id: str\n    quantity: {annotation} = None\n    notes: str = ''\n"
            spellings = [("", "int | None"), ("", "None | int"),
                         ("from typing import Optional", "Optional[int]"), ("import typing", "typing.Optional[int]")]
            baseline = None
            for imports, annotation in spellings:
                model.write_text(template.format(imports=imports, annotation=annotation))
                source_bytes = model.read_bytes()
                self.cli("from-python", model, records, "-o", artifact, "--manifest", manifest,
                         "--extracted-spec", extracted, "--force")
                data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', artifact.read_text(), re.S)[1])
                # Independent constructor behavior uses only this known owned fixture, outside the extractor.
                native = subprocess.run([sys.executable, "-c",
                    "import dataclasses,json,runpy,sys; model=runpy.run_path(sys.argv[1])['Metric']; "
                    "print(json.dumps([dataclasses.asdict(model(**r)) for r in json.load(open(sys.argv[2]))['records']]))",
                    str(model), str(records)], capture_output=True, text=True, check=True, timeout=10)
                self.assertEqual(data["records"], json.loads(native.stdout))
                observed = (data["spec"], data["records"])
                if baseline is None:
                    baseline = observed
                self.assertEqual(observed, baseline)
                self.assertFalse(json.loads(manifest.read_text())["extraction"]["source_executed"])
                self.assertEqual(json.loads(extracted.read_text())["fields"][0]["type"], "integer")
                audit = json.loads(self.cli("audit-python", model).stdout)
                self.assertEqual(audit["model"]["status"], "supported")
                self.assertEqual(model.read_bytes(), source_bytes)
            envelope = {"format": "afterlife-data/v1", "app_id": data["spec"]["app_id"],
                        "spec_fingerprint": data["spec_fingerprint"], "records": data["records"]}
            backup = root / "backup.json"; backup.write_text(json.dumps(envelope))
            rebuilt = root / "rebuilt.html"
            self.cli("from-export", extracted, backup, "-o", rebuilt)
            restored = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', rebuilt.read_text(), re.S)[1])
            self.assertEqual(restored["records"], baseline[1])
            protected = {p: p.read_bytes() for p in (records, artifact, manifest, extracted, rebuilt)}
            sentinel = root / "source-executed"
            unsafe = [
                template.format(imports="", annotation="Optional[int]"),
                template.format(imports="from typing import Optional", annotation="Optional[str]"),
                template.format(imports="from typing import Optional as O", annotation="O[int]"),
                template.format(imports="import typing as t", annotation="t.Optional[int]"),
                template.format(imports="from typing import Optional", annotation="Optional[int]") + "    Optional: str = ''\n",
                template.format(imports="import typing", annotation="typing.Optional[int]") + "    typing: str = ''\n",
                template.format(imports="from typing import Optional", annotation=f"Optional[__import__('pathlib').Path({str(sentinel)!r}).touch()]"),
                template.format(imports="from typing import Optional", annotation="Optional[int]") + f"\nopen({str(sentinel)!r}, 'w').write('executed')\n",
            ]
            for source in unsafe:
                model.write_text(source)
                self.cli("from-python", model, records, "-o", artifact, "--manifest", manifest,
                         "--extracted-spec", extracted, "--force", expected=2)
                self.assertEqual({p: p.read_bytes() for p in protected}, protected)
                self.assertEqual(model.read_text(), source)
                self.assertFalse(sentinel.exists())
