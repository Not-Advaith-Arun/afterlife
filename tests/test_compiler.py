import base64
import copy
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from afterlife import CompileError, compile_app, load_json, validate_records, validate_spec

ROOT = Path(__file__).resolve().parents[1]


class DocumentParser(HTMLParser):
    def __init__(self, document):
        super().__init__()
        self.scripts, self.styles, self.external, self.meta = [], [], [], {}
        self.current = None
        self.feed(document)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script":
            self.scripts.append([attrs, ""])
            self.current = self.scripts[-1]
        elif tag == "style":
            self.styles.append([attrs, ""])
            self.current = self.styles[-1]
        elif tag == "meta":
            self.meta.update({attrs.get("http-equiv"): attrs.get("content")})
        if "src" in attrs or "href" in attrs:
            self.external.append((tag, attrs))

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.current = None

    def handle_data(self, data):
        if self.current is not None:
            self.current[1] += data


class CompilerTests(unittest.TestCase):
    def setUp(self):
        self.spec = load_json(ROOT / "examples/task-tracker/app.json")
        self.data = load_json(ROOT / "examples/task-tracker/records.json")

    def test_deterministic_complete_artifact(self):
        document, manifest = compile_app(self.spec, self.data)
        self.assertEqual((document, manifest), compile_app(copy.deepcopy(self.spec), self.data))
        self.assertEqual(manifest["artifact_sha256"], hashlib.sha256(document.encode()).hexdigest())
        parsed = DocumentParser(document)
        self.assertEqual(len(parsed.scripts), 2)
        self.assertEqual(parsed.external, [])
        payload = json.loads(parsed.scripts[0][1])
        self.assertEqual(payload["records"], self.data["records"])
        for text in (parsed.scripts[1][1], parsed.styles[0][1]):
            digest = base64.b64encode(hashlib.sha256(text.encode()).digest()).decode()
            self.assertIn("'sha256-" + digest + "'", parsed.meta["Content-Security-Policy"])
        self.assertIn("connect-src 'none'", parsed.meta["Content-Security-Policy"])

    def test_untrusted_content_cannot_escape_script_or_title(self):
        attack = '</script><img src=x onerror="globalThis.pwned=true">\u2028&'
        self.spec["title"] = "</title><script>evil()</script>"
        self.spec["fields"][0]["label"] = attack
        self.data["records"][0]["title"] = attack
        document, _ = compile_app(self.spec, self.data)
        parsed = DocumentParser(document)
        self.assertEqual(len(parsed.scripts), 2)
        self.assertEqual(parsed.external, [])
        self.assertEqual(json.loads(parsed.scripts[0][1])["records"][0]["title"], attack)
        self.assertNotIn(attack, document)

    def test_rejects_server_requirements_without_partial_artifact(self):
        for capability in ["authentication", "payments", "remote-api", "background-jobs"]:
            with self.subTest(capability=capability):
                self.spec["required_capabilities"] = [capability]
                with self.assertRaisesRegex(CompileError, "Cannot preserve"):
                    compile_app(self.spec, self.data)

    def test_field_contract_validation(self):
        bad_fields = [
            {"name": "__proto__", "label": "x", "type": "text"},
            {"name": "constructor", "label": "x", "type": "text"},
            {"name": "id", "label": "x", "type": "text"},
            {"name": "x", "label": "x", "type": "html"},
            {"name": "x", "label": "x", "type": "text", "required": "yes"},
            {"name": "x", "label": "x", "type": "select", "options": ["A", "A"]},
            {"name": "x", "label": "x", "type": "boolean", "required": True},
            {"name": "x", "label": "x", "type": "text", "options": ["A"]},
        ]
        for field in bad_fields:
            with self.subTest(field=field), self.assertRaises(CompileError):
                validate_spec({**self.spec, "fields": [field]})

    def test_duplicate_fields_and_unknown_app_keys(self):
        with self.assertRaises(CompileError):
            validate_spec({**self.spec, "fields": self.spec["fields"] * 2})
        with self.assertRaises(CompileError):
            validate_spec({**self.spec, "server_url": "https://example.invalid"})

    def test_rejects_lossy_or_invalid_records(self):
        record = self.data["records"][0]
        cases = [{**record, "hours": 1.5}, {**record, "hours": True},
                 {**record, "hours": 2**53}, {**record, "important": 1},
                 {**record, "title": "  "}, {**record, "status": "Unknown"},
                 {**record, "extra": "silently dropping this would be bad"},
                 {**record, "notes": "\ud800"}, {**record, "title": "x" * 10001}]
        for candidate in cases:
            with self.subTest(record=candidate), self.assertRaises(CompileError):
                validate_records(self.spec, [candidate])
        with self.assertRaises(CompileError):
            validate_records(self.spec, [record, record])

    def test_optional_fields_are_normalized(self):
        records = validate_records(self.spec, [{"id": "one", "title": "Hello 😀", "status": "Planned"}])
        self.assertEqual(records[0], {"id": "one", "title": "Hello 😀", "status": "Planned", "notes": "", "hours": None, "important": False})

    def test_seed_changes_get_distinct_storage(self):
        first = json.loads(DocumentParser(compile_app(self.spec, self.data)[0]).scripts[0][1])
        self.data["records"][0]["title"] = "Updated seed"
        second = json.loads(DocumentParser(compile_app(self.spec, self.data)[0]).scripts[0][1])
        self.assertNotEqual(first["storage_key"], second["storage_key"])
        self.assertEqual(first["spec_fingerprint"], second["spec_fingerprint"])

    def test_strict_json_reader(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.json"
            for text in ['{"x": 1, "x": 2}', '{"x": NaN}', '{"x": Infinity}', "["]:
                path.write_text(text)
                with self.subTest(text=text), self.assertRaises(CompileError):
                    load_json(path)

    def test_cli_overwrite_and_input_protection(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "app.html"
            manifest = Path(directory) / "manifest.json"
            args = [sys.executable, "-m", "afterlife", str(ROOT / "examples/task-tracker/app.json"),
                    str(ROOT / "examples/task-tracker/records.json"), "-o", str(output), "--manifest", str(manifest)]
            first = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(json.loads(manifest.read_text())["record_count"], 3)
            second = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(second.returncode, 2)
            self.assertIn("already exists", second.stderr)
            same = args[:6] + [str(ROOT / "examples/task-tracker/app.json"), "--force"]
            protected = subprocess.run(same, cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(protected.returncode, 2)
            self.assertIn("overwrite source inputs", protected.stderr)

    def test_cli_rejects_hardlink_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "app.json"
            source.write_text(json.dumps(self.spec))
            alias = root / "alias.html"
            os.link(source, alias)
            args = [sys.executable, "-m", "afterlife", str(source),
                    str(ROOT / "examples/task-tracker/records.json"), "-o", str(alias), "--force"]
            rejected = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(rejected.returncode, 2)
            self.assertIn("overwrite source inputs", rejected.stderr)
            self.assertEqual(json.loads(source.read_text()), self.spec)
            alias.unlink()
            alias.write_text("keep this")
            manifest = root / "manifest.json"
            os.link(alias, manifest)
            rejected = subprocess.run(args + ["--manifest", str(manifest)], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(rejected.returncode, 2)
            self.assertIn("different paths", rejected.stderr)
            self.assertEqual(alias.read_text(), "keep this")


if __name__ == "__main__":
    unittest.main()
