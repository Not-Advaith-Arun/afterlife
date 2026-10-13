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
    def test_audit_and_extraction_never_execute_supplied_python_or_follow_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, records, output, marker = [root / name for name in ("model.py", "records.json", "app.html", "executed")]
            records.write_text(json.dumps({"records": [{"id": "one"}]}))
            output.write_text("preserve existing application")
            effect = "__import__('pathlib').Path(" + repr(str(marker)) + ").write_text('executed')"
            valid = "from dataclasses import dataclass\n@dataclass\nclass Note:\n    id: str\n    title: str = 'Literal default'\n"
            malicious = [valid.replace("'Literal default'", effect),
                         valid.replace("@dataclass", "@" + effect), valid + effect + "\n"]
            def cli(*args, expected):
                result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, args)],
                                        cwd=ROOT, capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                self.assertFalse(marker.exists(), "untrusted source or imported dependency executed")
                return result
            for source in malicious:
                model.write_text(source)
                originals = {p: p.read_bytes() for p in (model, records, output)}
                report = json.loads(cli("audit-python", model, expected=2).stdout)
                self.assertFalse(report["source_executed"])
                self.assertEqual(report["model"]["status"], "unsupported")
                cli("from-python", model, records, "-o", output, "--force", expected=2)
                self.assertEqual({p: p.read_bytes() for p in originals}, originals)
            model.write_text(valid)
            dependency = root / "imported.py"
            dependency.write_text(effect + "\n")
            application = root / "application.py"
            application.write_text("import imported\n" + effect + "\nwhile True: pass\n")
            saved = {p: p.read_bytes() for p in (model, dependency, application, records)}
            report = json.loads(cli("audit-python", model, "--application-source", application, expected=2).stdout)
            self.assertFalse(report["source_executed"])
            self.assertEqual(report["model"]["status"], "supported")
            self.assertEqual([row["source"] for row in report["files"]], [str(model), str(application)])
            self.assertIn("dependency", [row["code"] for row in report["findings"]])
            self.assertIn("call-or-side-effect", [row["code"] for row in report["findings"]])
            cli("from-python", model, records, "-o", output, "--force", expected=0)
            self.assertIn("Literal default", output.read_text())
            self.assertEqual({p: p.read_bytes() for p in saved}, saved)

    def test_actual_output_sync_and_replace_failures_preserve_prior_html(self):
        # Drive the real CLI with filesystem failure injection: an exception
        # before publication must not truncate the user's existing application.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output, alias = root / "app.html", root / "retained.html"
            prior = b"Original independently retained application bytes"
            output.write_bytes(prior); os.link(output,alias)
            spec = ROOT / "examples/task-tracker/app.json"
            data = ROOT / "examples/task-tracker/records.json"
            inputs = {p:p.read_bytes() for p in (spec,data)}
            code = ("import sys; from unittest.mock import patch; from afterlife.__main__ import main\n"
                    "target=sys.argv.pop(1)\n"
                    "with patch(target,side_effect=OSError('controlled publication failure')):\n"
                    " raise SystemExit(main(sys.argv[1:]))\n")
            for target in ("afterlife.output.os.fsync","afterlife.output.os.replace"):
                failed = subprocess.run([sys.executable,"-c",code,target,str(spec),str(data),"-o",str(output),"--force"],
                    cwd=ROOT,capture_output=True,text=True,timeout=10)
                self.assertEqual(failed.returncode,2,failed.stdout+failed.stderr)
                self.assertIn("controlled publication failure",failed.stderr)
                self.assertEqual(output.read_bytes(),prior)
                self.assertEqual(alias.read_bytes(),prior)
                self.assertEqual(list(root.glob("*.pending")),[])
                self.assertEqual(list(root.glob(".*.pending")),[])
            success = subprocess.run([sys.executable,"-m","afterlife",str(spec),str(data),"-o",str(output),"--force"],
                cwd=ROOT,capture_output=True,text=True,timeout=10)
            self.assertEqual(success.returncode,0,success.stdout+success.stderr)
            self.assertIn("afterlife-data",output.read_text())
            self.assertEqual(alias.read_bytes(),prior)
            self.assertEqual({p:p.read_bytes() for p in inputs},inputs)

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


    def test_saved_backup_review_drives_guarded_restore_and_preserves_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def cli(*args, expected=0):
                result = subprocess.run([sys.executable, "-m", "afterlife", *map(str,args)], cwd=ROOT,
                    text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                return result
            spec = ROOT / "examples/task-tracker/app.json"
            app, current, incoming, review, restored = [root / name for name in ("app.html", "current.json", "incoming.json", "review.json", "restored.html")]
            cli(spec, ROOT / "examples/task-tracker/records.json", "-o", app)
            payload = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', app.read_text(), re.S)[1])
            envelope = {"format":"afterlife-data/v1", "app_id":payload["spec"]["app_id"],
                        "spec_fingerprint":payload["spec_fingerprint"], "records":payload["records"]}
            current.write_text(json.dumps(envelope))
            envelope["records"][0]["title"] = "Private reviewed change"
            incoming.write_text(json.dumps(envelope))
            originals = {p:p.read_bytes() for p in (spec,current,incoming)}
            args = ("review-export", spec, incoming, "--against", current)
            stdout = cli(*args, "--check", expected=1).stdout
            cli(*args, "--check", "-o", review, expected=1)
            self.assertEqual(review.read_text(), stdout)
            self.assertNotIn("Private reviewed change", stdout)
            saved = review.read_bytes()
            cli(*args, "-o", review, expected=2)
            alias = root / "alias.json"; os.link(current,alias)
            symbolic = root / "symbolic.json"; symbolic.symlink_to(review)
            for destination in (current,alias,symbolic):
                cli(*args, "-o", destination, "--force", expected=2)
            cli("from-export", spec, incoming, "--against", current, "--review", review, "-o", restored)
            self.assertIn("Private reviewed change", restored.read_text())
            incoming.write_text('{"records":[]}')
            cli(*args, "-o", review, "--force", expected=2)
            self.assertEqual(review.read_bytes(), saved)
            incoming.write_bytes(originals[incoming])
            self.assertEqual({p:p.read_bytes() for p in originals}, originals)

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
            review_file, restored = root / "review.json", root / "guarded.html"
            review_file.write_text(checked.stdout)
            cli("from-export", spec, incoming, "--review", review_file, "--against", current, "-o", restored)
            saved_restored = restored.read_bytes()
            restored_data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', restored.read_text(), re.S)[1])
            self.assertEqual(restored_data["records"], rows)
            manifest = root / "existing-manifest.json"
            manifest.write_text('{"previous":"preserve this review"}')
            protected = {p: p.read_bytes() for p in (original, current, incoming, spec, review_file, restored, manifest)}
            for source in (current, review_file):
                for link_kind in ("hard", "symbolic"):
                    alias = root / "input-alias"
                    if link_kind == "hard":
                        alias.hardlink_to(source)
                    else:
                        alias.symlink_to(source)
                    try:
                        for destination in ("html", "manifest"):
                            cli("from-export", spec, incoming, "--review", review_file, "--against", current,
                                "-o", alias if destination == "html" else restored,
                                "--manifest", alias if destination == "manifest" else manifest,
                                "--force", expected=2)
                            self.assertEqual({p: p.read_bytes() for p in protected}, protected)
                            self.assertEqual(alias.read_bytes(), protected[source])
                            self.assertEqual(alias.is_symlink(), link_kind == "symbolic")
                    finally:
                        alias.unlink()
            changed = json.loads(incoming.read_text())
            changed["records"][0]["title"] = "Changed after human review"
            incoming.write_text(json.dumps(changed))
            cli("from-export", spec, incoming, "--review", review_file, "--against", current, "-o", restored, "--force", expected=2)
            self.assertEqual(restored.read_bytes(), saved_restored)
            incoming.write_bytes(originals[incoming])
            current.write_text(json.dumps({**envelope, "records": list(reversed(payload["records"]))}))
            cli("from-export", spec, incoming, "--review", review_file, "--against", current, "-o", restored, "--force", expected=2)
            current.write_bytes(originals[current])
            review_file.write_text(json.dumps({**reviewed, "counts": {}}))
            cli("from-export", spec, incoming, "--review", review_file, "--against", current, "-o", restored, "--force", expected=2)
            changed_types = json.loads(checked.stdout)
            changed_types["counts"]["unchanged"] = True  # True must not compare as integer 1 in an exact review.
            review_file.write_text(json.dumps(changed_types))
            cli("from-export", spec, incoming, "--review", review_file, "--against", current, "-o", restored, "--force", expected=2)
            review_file.write_text(checked.stdout)
            cli("from-export", spec, incoming, "--review", review_file, "--against", current, "-o", current, "--force", expected=2)
            cli("from-export", spec, incoming, "--review", review_file, "-o", restored, "--force", expected=2)
            self.assertEqual(current.read_bytes(), originals[current])
            self.assertEqual(restored.read_bytes(), saved_restored)
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

    def test_backup_check_distinguishes_normalized_equality_order_edits_and_invalid_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def cli(*args, expected=0):
                result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, args)],
                    cwd=ROOT, text=True, capture_output=True, timeout=15)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                return result
            spec = ROOT / "examples/task-tracker/app.json"
            artifact, current, incoming = [root / name for name in ("app.html", "current.json", "incoming.json")]
            cli(spec, ROOT / "examples/task-tracker/records.json", "-o", artifact)
            payload = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', artifact.read_text(), re.S)[1])
            envelope = {"format": "afterlife-data/v1", "app_id": payload["spec"]["app_id"],
                "spec_fingerprint": payload["spec_fingerprint"], "records": payload["records"]}
            current.write_text(json.dumps(envelope))
            incoming.write_text(json.dumps(envelope, indent=4))
            args = ("review-export", spec, incoming, "--against", current)
            same = json.loads(cli(*args, "--check").stdout)
            self.assertEqual(same["current_records_sha256"], same["incoming_records_sha256"])
            reordered = {**envelope, "records": list(reversed(payload["records"]))}
            incoming.write_text(json.dumps(reordered))
            order = json.loads(cli(*args, "--check", expected=1).stdout)
            self.assertEqual(order["changed"], [])
            self.assertNotEqual(order["current_records_sha256"], order["incoming_records_sha256"])
            self.assertEqual(json.loads(cli(*args).stdout), order)
            changed = json.loads(json.dumps(envelope))
            changed["records"][0]["title"] = "Private changed backup value"
            incoming.write_text(json.dumps(changed))
            saved = {p: p.read_bytes() for p in (artifact, current, incoming)}
            report = cli(*args, "--check", expected=1)
            self.assertEqual(json.loads(report.stdout)["counts"]["changed"], 1)
            self.assertNotIn("Private changed backup value", report.stdout)
            self.assertEqual({p: p.read_bytes() for p in saved}, saved)
            incoming.write_text(json.dumps({**envelope, "app_id": "foreign"}))
            invalid = incoming.read_bytes()
            cli(*args, "--check", expected=2)
            self.assertEqual(incoming.read_bytes(), invalid)
            self.assertEqual(artifact.read_bytes(), saved[artifact])
            self.assertEqual(current.read_bytes(), saved[current])

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
