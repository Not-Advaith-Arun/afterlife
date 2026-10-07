"""Retained backup branches are classified through the real nonmutating CLI."""
import copy
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ThreeWayReviewAcceptance(unittest.TestCase):
    def cli(self, *args, expected=0):
        result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, args)], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_branches_report_real_conflicts_without_values_mutation_or_restore_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = ROOT / "examples/task-tracker/app.json"
            app, base, current, incoming, report_path = [root / name for name in
                ("app.html", "base.json", "current.json", "incoming.json", "report.json")]
            self.cli(spec, ROOT / "examples/task-tracker/records.json", "-o", app)
            data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', app.read_text(), re.S)[1])
            row = data["records"][0]
            envelope = {"format": "afterlife-data/v1", "app_id": data["spec"]["app_id"],
                        "spec_fingerprint": data["spec_fingerprint"]}
            keys = ["same", "local", "remote", "converge", "compatible", "overlap", "delete-edit",
                    "delete-both", "local-remove", "remote-remove"]
            original = {key: {**row, "id": key} for key in keys}
            ours, theirs = copy.deepcopy(original), copy.deepcopy(original)
            ours["local"]["notes"] = "Private local value"
            theirs["remote"]["hours"] = None
            for rows in (ours, theirs):
                rows["converge"]["title"] = "Private equal edit"
                rows["compatible"]["important"] = False
                del rows["delete-both"]
                rows["same-add"] = {**row, "id": "same-add"}
            ours["compatible"]["title"] = "Private local title"
            theirs["compatible"]["notes"] = "Private remote note"
            ours["overlap"]["notes"] = "Private ours"
            theirs["overlap"]["notes"] = "Private theirs"
            del ours["delete-edit"]; theirs["delete-edit"]["title"] = "Private surviving edit"
            del ours["local-remove"]; del theirs["remote-remove"]
            ours["different-add"] = {**row, "id": "different-add", "title": "Private ours"}
            theirs["different-add"] = {**row, "id": "different-add", "title": "Private theirs"}
            ours["local-add"] = {**row, "id": "local-add"}
            theirs["remote-add"] = {**row, "id": "remote-add"}
            for path, rows in ((base, original), (current, ours), (incoming, theirs)):
                path.write_text(json.dumps({**envelope, "records": list(rows.values())}))
            saved = {p: p.read_bytes() for p in (spec, base, current, incoming, app)}
            args = ("review-three-way", spec, base, current, incoming)
            report = json.loads(self.cli(*args, "--check", "--output", report_path, expected=1).stdout)
            self.assertEqual(json.loads(report_path.read_text()), report)
            self.assertEqual(report["counts"], {"base": 10, "current": 10, "incoming": 11, "unchanged": 1,
                "current_only": 3, "incoming_only": 3, "converged": 3, "compatible_edits": 1, "conflicts": 3})
            self.assertEqual({r["id"]: (r["kind"], r["fields"]) for r in report["conflicts"]}, {
                "delete-edit": ("deletion_vs_edit", ["title"]),
                "different-add": ("different_additions", ["title"]),
                "overlap": ("overlapping_edits", ["notes"])})
            self.assertEqual(report["compatible_edits"], [{"id": "compatible", "current_fields": ["important", "title"],
                                                           "incoming_fields": ["important", "notes"]}])
            self.assertNotIn("Private", json.dumps(report))
            summary = json.loads(self.cli(*args, "--summary", "--check", expected=1).stdout)
            self.assertEqual(summary["counts"], report["counts"])
            self.assertNotIn("delete-edit", json.dumps(summary))
            self.assertNotIn("notes", json.dumps(summary))
            proposal, proposal_review, rebuilt = [root / name for name in ("proposal.json", "proposal-review.json", "rebuilt.html")]
            proposal_args = ("propose-three-way", spec, base, current, incoming, "--review", report_path,
                             "--record-id", "compatible", "--record-id", "remote", "-o", proposal)
            receipt = json.loads(self.cli(*proposal_args).stdout)
            expected = copy.deepcopy(ours)
            expected["compatible"]["notes"] = theirs["compatible"]["notes"]
            expected["remote"]["hours"] = None
            self.assertEqual(json.loads(proposal.read_text()), {**envelope, "records": list(expected.values())})
            self.assertEqual(receipt["selected_existing_records"], 2)
            self.assertEqual(receipt["unselected_conflict_records"], 3)
            self.assertNotIn("compatible", json.dumps(receipt))
            self.assertEqual(proposal.stat().st_mode & 0o777, 0o600)
            self.cli("review-export", spec, proposal, "--against", current, "--output", proposal_review)
            self.cli("from-export", spec, proposal, "--against", current, "--review", proposal_review, "-o", rebuilt)
            rebuilt_data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', rebuilt.read_text(), re.S)[1])
            self.assertEqual(rebuilt_data["records"], list(expected.values()))
            saved_proposal = proposal.read_bytes()
            for source in (base, current, incoming):
                changed = json.loads(source.read_text())
                changed["records"][0]["notes"] += " later change"
                source.write_text(json.dumps(changed))
                self.cli(*proposal_args, "--force", expected=2)
                self.assertEqual(proposal.read_bytes(), saved_proposal)
                source.write_bytes(saved[source])
            summary_guard = root / "summary.json"
            summary_guard.write_text(json.dumps(summary))
            self.cli("propose-three-way", spec, base, current, incoming, "--review", summary_guard,
                     "--record-id", "compatible", "-o", proposal, "--force", expected=2)
            for ids in [("overlap",), ("delete-edit",), ("different-add",), ("same-add",), ("same",), ("unknown",),
                        ("compatible", "compatible")]:
                flags = [part for key in ids for part in ("--record-id", key)]
                self.cli("propose-three-way", spec, base, current, incoming, "--review", report_path,
                         *flags, "-o", proposal, "--force", expected=2)
                self.assertEqual(proposal.read_bytes(), saved_proposal)
            self.cli("from-export", spec, incoming, "--against", current, "--review", report_path,
                     "-o", app, "--force", expected=2)
            previous = report_path.read_bytes()
            invalid = json.loads(incoming.read_text()); invalid["records"][-1]["hours"] = 9007199254740992
            incoming.write_text(json.dumps(invalid))
            self.cli(*args, "--output", report_path, "--force", expected=2)
            self.cli(*proposal_args, "--force", expected=2)
            self.assertEqual(report_path.read_bytes(), previous)
            self.assertEqual(proposal.read_bytes(), saved_proposal)
            incoming.write_bytes(saved[incoming])
            for source in (spec, base, current, incoming):
                self.cli(*args, "--output", source, "--force", expected=2)
            for source in (spec, base, current, incoming, report_path):
                self.cli("propose-three-way", spec, base, current, incoming, "--review", report_path,
                         "--record-id", "compatible", "-o", source, "--force", expected=2)
            self.assertEqual({p: p.read_bytes() for p in saved}, saved)
            # Array order is kept in snapshot identity and never mistaken for field edits.
            current.write_text(json.dumps({**envelope, "records": list(reversed(list(original.values())))}))
            incoming.write_bytes(saved[base])
            ordered = json.loads(self.cli(*args, "--check").stdout)
            self.assertEqual(ordered["order_only_changes"], {"current": True, "incoming": False})
            self.assertEqual(ordered["counts"]["unchanged"], 10)
            self.assertEqual(ordered["counts"]["conflicts"], 0)
            self.assertNotEqual(ordered["base_records_sha256"], ordered["current_records_sha256"])
