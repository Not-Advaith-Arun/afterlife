import copy
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import unittest

from afterlife.compiler import CompileError, compile_app, load_json, validate_records, validate_spec
from afterlife.source import MAX_SOURCE_BYTES, extract_python_model

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'from dataclasses import dataclass\n@dataclass\nclass Item:\n    id: str\n    name: str = "Untitled"\n    count: int = -2\n    active: bool = True\n    estimate: int | None = None\n'


class SourceTests(unittest.TestCase):
    def extract(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.py"
            path.write_text(text, encoding="utf-8")
            return extract_python_model(path)

    def test_extracts_model_defaults_types_and_provenance(self):
        spec, evidence = self.extract(MODEL)
        self.assertEqual(spec["app_id"], "item")
        self.assertEqual(evidence["source_sha256"], hashlib.sha256(MODEL.encode()).hexdigest())
        self.assertFalse(evidence["source_executed"])
        self.assertEqual(evidence["model"], "Item")
        self.assertEqual(evidence["fields"][1]["line"], 5)
        self.assertEqual(validate_records(spec, [{"id": "one"}]),
                         [{"id": "one", "name": "Untitled", "count": -2, "active": True, "estimate": None}])
        self.assertEqual(compile_app(spec, {"records": [{"id": "one"}]}),
                         compile_app(copy.deepcopy(spec), {"records": [{"id": "one"}]}))

    def test_docstrings_future_annotations_and_metadata_overrides(self):
        spec, _ = self.extract('"""Module docs."""\nfrom __future__ import annotations\n' + MODEL.replace('    id: str', '    """Class docs."""\n    id: str'))
        self.assertEqual(spec["fields"][0]["default"], "Untitled")
        spec, _ = extract_python_model(ROOT / "examples/python-tracker/model.py", app_id="my-tasks", title="My tasks", record_label="task")
        self.assertEqual((spec["app_id"], spec["title"], spec["record_label"]), ("my-tasks", "My tasks", "task"))

    def test_string_model_fields_preserve_multiline_defaults(self):
        source = MODEL.replace('name: str = "Untitled"', 'name: str = "first\\r\\nsecond\\rthird\\nfourth"')
        spec, _ = self.extract(source)
        field = spec["fields"][0]
        self.assertEqual(field["type"], "multiline")
        self.assertEqual(field["default"], "first\r\nsecond\rthird\nfourth")
        self.assertEqual(validate_records(spec, [{"id": "one"}])[0]["name"], field["default"])

    def test_rejects_every_unmodeled_behavior(self):
        cases = [
            MODEL + "print('side effect')\n", "import os\n" + MODEL,
            MODEL + "\nclass Other:\n    pass\n",
            MODEL + "    def __post_init__(self):\n        self.count *= 2\n",
            MODEL + "    @property\n    def computed(self):\n        return 1\n",
            MODEL.replace("@dataclass", "@dataclass(frozen=True)"),
            MODEL.replace("@dataclass", "@other\n@dataclass"),
            MODEL.replace("class Item:", "class Item(Base):"),
            MODEL.replace("class Item:", "class Item(metaclass=Meta):"),
            MODEL.replace("class Item:", "class int:"),
            MODEL.replace("name: str", "int: str"),
            MODEL.replace("count: int = -2", "count: int = 1 + 2"),
            MODEL.replace("count: int = -2", "count: int = int('2')"),
            MODEL.replace("count: int = -2", "count: float = 1.5"),
            MODEL.replace("count: int = -2", "count: int = None"),
            MODEL.replace("active: bool = True", "active: bool = 1"),
            MODEL.replace("name: str = \"Untitled\"", "name: str"),
            MODEL.replace("name: str = \"Untitled\"", "name: list[str] = []"),
            MODEL.replace("    id: str\n", "    id: str = 'one'\n"),
            MODEL.replace("    id: str\n", ""),
            MODEL + "    name: str = 'duplicate'\n",
            MODEL.replace("from dataclasses import dataclass", "from dataclasses import dataclass as dc"),
            MODEL.replace("    name: str", "    (name): str"),
            MODEL.replace("name: str", "name: 'str'"),
            "from dataclasses import dataclass\n@dataclass\nclass Empty:\n    pass\n",
            "from dataclasses import dataclass\n@dataclass\nclass Empty:\n    id: str\n",
        ]
        for source in cases:
            with self.subTest(source=source), self.assertRaises(CompileError):
                self.extract(source)

    def test_extraction_never_executes_input(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "executed"
            source = MODEL + f"open({str(marker)!r}, 'w').write('unsafe')\n"
            with self.assertRaises(CompileError):
                self.extract(source)
            self.assertFalse(marker.exists())

    def test_rejects_oversize_bad_encoding_and_syntax(self):
        for source in ["#" * (MAX_SOURCE_BYTES + 1), "class ???"]:
            with self.subTest(source=source[:20]), self.assertRaises(CompileError):
                self.extract(source)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.py"
            path.write_bytes(b"\xff")
            with self.assertRaises(CompileError):
                extract_python_model(path)

    def test_compiler_checks_explicit_defaults_and_whole_numbers(self):
        spec, _ = self.extract(MODEL)
        for field, value in [("name", None), ("active", 1), ("count", None), ("count", 1.5), ("estimate", True), ("name", "\ud800")]:
            modified = copy.deepcopy(spec)
            next(item for item in modified["fields"] if item["name"] == field)["default"] = value
            with self.subTest(field=field, value=value), self.assertRaises(CompileError):
                validate_spec(modified)
        value = validate_records(spec, [{"id": "one", "count": 2.0}])[0]["count"]
        self.assertEqual(value, 2)
        self.assertIs(type(value), int)

    def test_cli_source_compilation_and_output_guards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "model.py"
            model.write_text(MODEL)
            data = root / "records.json"
            data.write_text('{"records": [{"id": "one"}]}')
            output, manifest, extracted = root / "app.html", root / "manifest.json", root / "spec.json"
            args = [sys.executable, "-m", "afterlife", "from-python", str(model), str(data), "-o", str(output),
                    "--manifest", str(manifest), "--extracted-spec", str(extracted)]
            result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            evidence = load_json(manifest)["extraction"]
            self.assertEqual(evidence["model"], "Item")
            self.assertEqual(load_json(extracted)["fields"][0]["default"], "Untitled")
            self.assertEqual(subprocess.run(args, cwd=ROOT, capture_output=True).returncode, 2)
            for target in [model, data, output, manifest]:
                bad = args[:-1] + [str(target), "--force"]
                self.assertEqual(subprocess.run(bad, cwd=ROOT, capture_output=True).returncode, 2)
            alias = root / "alias.json"
            os.link(model, alias)
            self.assertEqual(subprocess.run(args[:-1] + [str(alias), "--force"], cwd=ROOT, capture_output=True).returncode, 2)
            self.assertEqual(model.read_text(), MODEL)

    def test_rejected_source_leaves_no_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, output = root / "bad.py", root / "app.html"
            model.write_text(MODEL + "print('surprise')\n")
            result = subprocess.run([sys.executable, "-m", "afterlife", "from-python", str(model),
                                     str(ROOT / "examples/python-tracker/records.json"), "-o", str(output)], cwd=ROOT, capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(output.exists())


@unittest.skipUnless(shutil.which("node"), "Node is needed for independent Python/JS differential checks")
class DifferentialTests(unittest.TestCase):
    def compare(self, fixture, operations):
        base = ROOT / "examples" / fixture
        spec, _ = extract_python_model(base / "model.py")
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / "trace.json"
            trace.write_text(json.dumps({"format": "afterlife-trace/v1", "operations": operations}))
            source = subprocess.run([sys.executable, str(base / "app.py"), str(trace)], check=True, capture_output=True, text=True)
        runtime = subprocess.run(["node", str(ROOT / "tests/trace_runtime.cjs")], input=json.dumps({
            "spec": spec, "records": load_json(base / "records.json")["records"], "operations": operations}),
            check=True, capture_output=True, text=True)
        source_result, runtime_result = json.loads(source.stdout), json.loads(runtime.stdout)
        self.assertEqual(source_result["initial"], runtime_result["initial"])
        for index, (expected, actual) in enumerate(zip(source_result["outcomes"], runtime_result["outcomes"])):
            self.assertEqual(actual, expected, f"{fixture} operation {index}: {operations[index]!r}")
        self.assertEqual(len(source_result["outcomes"]), len(runtime_result["outcomes"]))
        return source_result

    def test_two_original_apps_and_curated_operation_traces(self):
        for fixture in ["python-tracker", "python-equipment"]:
            with self.subTest(fixture=fixture):
                operations = load_json(ROOT / "examples" / fixture / "trace.json")["operations"]
                result = self.compare(fixture, operations)
                # Independent known outcomes prevent two accidentally permissive implementations passing.
                self.assertTrue(result["outcomes"][0]["ok"])
                self.assertFalse(result["outcomes"][2]["ok"])
                first = result["outcomes"][0]["records"][-1]
                self.assertEqual(first["priority"] if fixture == "python-tracker" else first["quantity"], 2 if fixture == "python-tracker" else 1)

    def test_deterministic_boundary_trace_corpus(self):
        for fixture, text_field, number_field, boolean_field in [
            ("python-tracker", "title", "priority", "done"), ("python-equipment", "name", "quantity", "available")]:
            randomizer = random.Random(1845)
            operations = []
            for index in range(120):
                record_id = f"generated-{randomizer.randrange(12)}"
                variant = index % 6
                if variant == 0:
                    operations.append({"op": "create", "record": {"id": record_id}})
                elif variant == 1:
                    value = randomizer.choice([None, True, 0, 1.0, -4, 1.5, 2**53 - 1, 2**53, "2"])
                    operations.append({"op": "edit", "id": record_id, "changes": {number_field: value}})
                elif variant == 2:
                    value = randomizer.choice(["", " ", "😀", "\ud800", "x" * 10001, "</script>", None, 9])
                    operations.append({"op": "create", "record": {"id": record_id, text_field: value}})
                elif variant == 3:
                    operations.append({"op": "edit", "id": record_id, "changes": {boolean_field: randomizer.choice([True, False, 1, "false", None])}})
                elif variant == 4:
                    operations.append({"op": "delete", "id": record_id})
                else:
                    operations.append(randomizer.choice([{"op": "unknown"}, {"op": "create", "record": {"id": "\u001c"}},
                        {"op": "edit", "id": record_id, "changes": {"id": "renamed"}}, {"op": "delete", "id": record_id, "extra": 1}]))
            with self.subTest(fixture=fixture):
                self.compare(fixture, operations)


if __name__ == "__main__":
    unittest.main()
