"""The conversion boundary is reported through the CLI without replacing inputs."""
import csv
import io
import re
import json
import os
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
            def cli(*args, expected=0, timeout=15):
                result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, args)],
                                        cwd=ROOT, capture_output=True, text=True, timeout=timeout)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                return result
            report = json.loads(cli("audit-python", model, "--application-source", application,
                                    expected=2).stdout)
            self.assertTrue(report["findings"])
            cli("examples/task-tracker/app.json", "examples/task-tracker/records.json", "-o", output)
            before = output.read_bytes()
            fifo = Path(directory) / "input.json"
            os.mkfifo(fifo)
            for arguments in ((fifo, "examples/task-tracker/records.json", "-o", output, "--force"),
                              ("from-python", fifo, "examples/task-tracker/records.json", "-o", output, "--force"),
                              ("audit-python", model, "--application-source", fifo)):
                cli(*arguments, expected=2, timeout=3)
                self.assertEqual(output.read_bytes(), before)
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
            payload = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', output.read_text(), re.S)[1])
            payload["records"][0]["title"] = '=1+1,"quoted"\nnext line'
            csv_result = subprocess.run(["node", "-e", "const fs=require('node:fs'); const {exportCSV}=require('./afterlife/runtime.js'); const p=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(exportCSV(p.spec,p.records));"],
                                        input=json.dumps(payload), cwd=ROOT, text=True, capture_output=True, check=True)
            table = list(csv.reader(io.StringIO(csv_result.stdout)))
            title_column = table[0].index("title")
            self.assertEqual(table[1][title_column], "'=1+1,\"quoted\"\nnext line")
            self.assertEqual(len(table), 4)
            self.assertEqual(len(table[0]), len(table[1]))
            import_comparison = subprocess.run(["node", "-e", "const fs=require('node:fs'); const {compareImport}=require('./afterlife/runtime.js'); const p=JSON.parse(fs.readFileSync(0,'utf8')); let incoming=JSON.parse(JSON.stringify(p.records)); incoming[0].title='Edited'; incoming.splice(1,1); incoming.push({...incoming[0],id:'new'}); process.stdout.write(JSON.stringify(compareImport(p.spec,p.records,incoming)));"],
                input=json.dumps(payload), cwd=ROOT, text=True, capture_output=True, check=True)
            differences = json.loads(import_comparison.stdout)
            self.assertEqual([len(differences[k]) for k in ("added", "removed", "changed", "unchanged")], [1,1,1,1])
            backup = Path(directory) / "export.json"
            backup_payload = {"format": "afterlife-data/v1", "app_id": payload["spec"]["app_id"], "spec_fingerprint": payload["spec_fingerprint"], "records": payload["records"]}
            backup.write_text(json.dumps(backup_payload))
            rebuilt = Path(directory) / "rebuilt.html"
            cli("from-export", "examples/task-tracker/app.json", backup, "-o", rebuilt)
            rebuilt_payload = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', rebuilt.read_text(), re.S)[1])
            self.assertEqual(rebuilt_payload["records"], payload["records"])
            rebuilt_bytes = rebuilt.read_bytes()
            backup_payload["spec_fingerprint"] = "wrong"
            backup.write_text(json.dumps(backup_payload))
            cli("from-export", "examples/task-tracker/app.json", backup, "-o", rebuilt, "--force", expected=2)
            self.assertEqual(rebuilt.read_bytes(), rebuilt_bytes)
            source_before = model.read_bytes()
            cli("audit-python", model, "-o", model, "--force", expected=2)
            self.assertEqual(model.read_bytes(), source_before)

    def test_persistent_catalog_restart_matches_converted_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "catalog.json"
            model = ROOT / "examples/python-catalog/model.py"
            app = model.with_name("app.py")
            spec = Path(directory) / "spec.json"
            html = Path(directory) / "catalog.html"
            before = {p: p.read_bytes() for p in model.parent.iterdir() if p.is_file()}
            subprocess.run([sys.executable, "-m", "afterlife", "from-python", str(model),
                            str(model.with_name("records.json")), "-o", str(html),
                            "--extracted-spec", str(spec)], cwd=ROOT, check=True, capture_output=True)
            last = None
            for name in ("trace.json", "restart-trace.json"):
                trace = model.with_name(name)
                original = json.loads(subprocess.check_output([sys.executable, str(app),
                    "--state", str(state), "--trace", str(trace)], cwd=ROOT, text=True))
                if last is not None:
                    self.assertEqual(original["initial"], last)
                converted = subprocess.run(["node", "tests/trace_runtime.cjs"], cwd=ROOT,
                    input=json.dumps({"spec": json.loads(spec.read_text()), "records": original["initial"],
                                      "operations": json.loads(trace.read_text())["operations"]}),
                    text=True, capture_output=True, check=True)
                self.assertEqual(json.loads(converted.stdout), original)
                last = original["outcomes"][-1]["records"]
                self.assertEqual(json.loads(state.read_text())["records"], last)
            self.assertEqual(len(last), 2)
            self.assertTrue(next(r for r in last if r["id"] == "item-3")["discontinued"])
            bad = subprocess.run([sys.executable, str(app), "--state", str(model)], capture_output=True)
            self.assertNotEqual(bad.returncode, 0)
            self.assertEqual({p: p.read_bytes() for p in before}, before)


    def test_backup_review_matches_runtime_without_exposing_values_or_writing_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original, current, incoming = root / "app.html", root / "current.json", root / "incoming.json"
            def cli(*args, expected=0):
                result = subprocess.run([sys.executable, "-m", "afterlife", *map(str,args)], cwd=ROOT, text=True, capture_output=True, timeout=15)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                return result
            spec = ROOT / "examples/task-tracker/app.json"
            cli(spec, ROOT / "examples/task-tracker/records.json", "-o", original)
            payload = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', original.read_text(), re.S)[1])
            envelope = {"format": "afterlife-data/v1", "app_id": payload["spec"]["app_id"],
                        "spec_fingerprint": payload["spec_fingerprint"], "records": payload["records"]}
            current.write_text(json.dumps(envelope))
            rows = json.loads(json.dumps(payload["records"]))
            rows[0]["title"] = "Private edited value never in review"
            removed_id = rows.pop(1)["id"]
            rows.append({**rows[0], "id": "new-record"})
            incoming.write_text(json.dumps({**envelope, "records": rows}))
            originals = {p: p.read_bytes() for p in (original, current, incoming, spec)}
            checked = cli("review-export", spec, incoming, "--against", current)
            reviewed = json.loads(checked.stdout)
            self.assertEqual(reviewed["counts"], {"current": 3, "incoming": 3, "added": 1, "removed": 1, "changed": 1, "unchanged": 1})
            self.assertEqual(reviewed["removed"], [removed_id])
            self.assertEqual(reviewed["changed"], [{"id": rows[0]["id"], "fields": ["title"]}])
            self.assertNotIn(rows[0]["title"], checked.stdout)
            actual = subprocess.run(["node", "-e", "const fs=require('node:fs');const {compareImport}=require('./afterlife/runtime.js');const p=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(compareImport(p.spec,p.before,p.after)));"], cwd=ROOT,
                input=json.dumps({"spec":payload["spec"], "before":payload["records"], "after":rows}), text=True, capture_output=True, check=True)
            self.assertEqual({k:len(v) for k,v in json.loads(actual.stdout).items()}, {k:reviewed["counts"][k] for k in ("added","removed","changed","unchanged")})
            self.assertEqual({p:p.read_bytes() for p in originals}, originals)
            reordered = {**envelope, "records": list(reversed(payload["records"]))}
            incoming.write_text(json.dumps(reordered))
            order = json.loads(cli("review-export", spec, incoming, "--against", current).stdout)
            self.assertEqual(order["changed"], [])
            self.assertNotEqual(order["current_records_sha256"], order["incoming_records_sha256"])
            for invalid in ({**envelope, "app_id":"foreign"}, {**envelope,"records":[rows[0],rows[0]]}):
                incoming.write_text(json.dumps(invalid))
                saved = incoming.read_bytes()
                cli("review-export", spec, incoming, "--against", current, expected=2)
                self.assertEqual(incoming.read_bytes(), saved)
            self.assertEqual(current.read_bytes(), originals[current])
            self.assertEqual(original.read_bytes(), originals[original])
            expanded = json.loads(spec.read_text())
            expanded["fields"] = [{"name": f"f{n}", "label": "Default", "type": "text", "default": "x" * 10000}
                                  for n in range(20)]
            large_spec, empty, compiled = root / "large-spec.json", root / "empty.json", root / "large.html"
            large_spec.write_text(json.dumps(expanded))
            empty.write_text('{"records":[]}')
            cli(large_spec, empty, "-o", compiled)
            large_payload = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', compiled.read_text(), re.S)[1])
            incoming.write_text(json.dumps({"format": "afterlife-data/v1", "app_id": expanded["app_id"],
                "spec_fingerprint": large_payload["spec_fingerprint"], "records": [{"id": str(n)} for n in range(100)]}))
            rejected = cli("review-export", large_spec, incoming, "--against", incoming, expected=2)
            self.assertIn("Normalized backup data exceeds 10 MiB", rejected.stderr)

    def test_real_runtime_backup_rebuild_and_foreign_envelopes_preserve_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            html, backup, rebuilt = root / "original.html", root / "backup.json", root / "rebuilt.html"
            def cli(*args, expected=0):
                result = subprocess.run([sys.executable, "-m", "afterlife", *map(str,args)], cwd=ROOT, text=True, capture_output=True, timeout=15)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                return result
            cli("examples/task-tracker/app.json", "examples/task-tracker/records.json", "-o", html)
            payload = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', html.read_text(), re.S)[1])
            payload["records"][0]["title"] = "Unicode \u03bb </script> =1+1"
            envelope = {"format": "afterlife-data/v1", "app_id": payload["spec"]["app_id"], "spec_fingerprint": payload["spec_fingerprint"], "records": payload["records"]}
            result = subprocess.run(["node", "-e", "const fs=require('node:fs'); const {exportDataJSON}=require('./afterlife/runtime.js'); process.stdout.write(exportDataJSON(JSON.parse(fs.readFileSync(0,'utf8'))));"], cwd=ROOT, input=json.dumps(envelope), capture_output=True, text=True, check=True)
            backup.write_text(result.stdout)
            backup_bytes = backup.read_bytes()
            cli("from-export", "examples/task-tracker/app.json", backup, "-o", rebuilt)
            restored = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', rebuilt.read_text(), re.S)[1])
            self.assertEqual(restored["records"], payload["records"])
            saved = rebuilt.read_bytes()
            for field in ("app_id", "spec_fingerprint", "format"):
                wrong = {**envelope, field: "foreign"}
                backup.write_text(json.dumps(wrong))
                rejected_bytes = backup.read_bytes()
                cli("from-export", "examples/task-tracker/app.json", backup, "-o", rebuilt, "--force", expected=2)
                self.assertEqual(rebuilt.read_bytes(), saved)
                self.assertEqual(backup.read_bytes(), rejected_bytes)
            backup.write_bytes(backup_bytes)
            cli("from-export", "examples/task-tracker/app.json", backup, "-o", backup, "--force", expected=2)
            self.assertEqual(backup.read_bytes(), backup_bytes)
