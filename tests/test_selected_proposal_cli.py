"""Actual CLI proposal -> review -> guarded rebuild, with no mutation of retained inputs."""
import copy
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SelectedProposalAcceptance(unittest.TestCase):
    def cli(self, *args, expected=0):
        result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, args)], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def embedded(self, path):
        return json.loads(re.search(r'id="afterlife-data">(.*?)</script>', path.read_text(), re.S)[1])

    def test_selected_proposal_guarded_rebuild_preserves_unselected_records_and_refuses_stale_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = ROOT / "examples/task-tracker/app.json"
            app, current, incoming, guard, proposal, proposed_guard, restored = [root / name for name in
                ("app.html", "current.json", "incoming.json", "guard.json", "proposal.json", "proposed-review.json", "restored.html")]
            self.cli(spec, ROOT / "examples/task-tracker/records.json", "-o", app)
            data = self.embedded(app)
            envelope = {"format": "afterlife-data/v1", "app_id": data["spec"]["app_id"],
                        "spec_fingerprint": data["spec_fingerprint"]}
            before = [{**data["records"][0], "id": f"row-{i:03}", "notes": "Private kept note"} for i in range(205)]
            after = copy.deepcopy(before[:-1])
            after[2].update(title="Private chosen λ\r\nsecond line", hours=None)
            after[200].update(hours=9007199254740991, important=False)
            after[3]["notes"] = "Private unchosen replacement"
            after.append({**after[0], "id": "new-record"})
            after.reverse()
            current.write_text(json.dumps({**envelope, "records": before}))
            incoming.write_text(json.dumps({**envelope, "records": after}))
            self.cli("review-export", spec, incoming, "--against", current, "--output", guard)
            protected = {p: p.read_bytes() for p in (spec, current, incoming, guard, app)}
            args = ("propose-export", spec, incoming, "--against", current, "--review", guard,
                    "--record-id", "row-200", "--record-id", "row-002", "-o", proposal)
            receipt = json.loads(self.cli(*args).stdout)
            expected = copy.deepcopy(before)
            expected[2].update(title="Private chosen λ\r\nsecond line", hours=None)
            expected[200].update(hours=9007199254740991, important=False)
            self.assertEqual(json.loads(proposal.read_text()), {**envelope, "records": expected})
            self.assertEqual(receipt["selected_existing_records"], 2)
            self.assertEqual(receipt["retained_current_records"], 203)
            self.assertNotIn("row-002", json.dumps(receipt))
            self.assertNotIn("Private", json.dumps(receipt))
            self.assertEqual(proposal.stat().st_mode & 0o777, 0o600)
            self.cli("review-export", spec, proposal, "--against", current, "--output", proposed_guard)
            self.cli("from-export", spec, proposal, "--against", current, "--review", proposed_guard, "-o", restored)
            self.assertEqual(self.embedded(restored)["records"], expected)
            # The original incoming review is not a guard for the selected proposal.
            self.cli("from-export", spec, proposal, "--against", current, "--review", guard,
                     "-o", restored, "--force", expected=2)
            self.assertEqual(self.embedded(restored)["records"], expected)
            saved_proposal = proposal.read_bytes()
            self.cli(*args, expected=2)  # Existing output needs explicit force.
            self.assertEqual(proposal.read_bytes(), saved_proposal)
            for ids in [("new-record",), ("row-204",), ("row-000",), ("unknown",), ("row-002", "row-002")]:
                selection = [part for key in ids for part in ("--record-id", key)]
                self.cli("propose-export", spec, incoming, "--against", current, "--review", guard,
                         *selection, "-o", proposal, "--force", expected=2)
                self.assertEqual(proposal.read_bytes(), saved_proposal)
            # An unselected invalid tail must refuse before touching an existing proposal.
            invalid = copy.deepcopy(after); invalid[-1]["hours"] = 9007199254740992
            incoming.write_text(json.dumps({**envelope, "records": invalid}))
            self.cli(*args, "--force", expected=2)
            incoming.write_bytes(protected[incoming])
            stale = json.loads(current.read_text()); stale["records"][-1]["title"] = "Concurrent edit"
            current.write_text(json.dumps(stale))
            self.cli(*args, "--force", expected=2)
            current.write_bytes(protected[current])
            self.assertEqual(proposal.read_bytes(), saved_proposal)
            for source in (current, incoming, guard, spec):
                self.cli("propose-export", spec, incoming, "--against", current, "--review", guard,
                         "--record-id", "row-002", "-o", source, "--force", expected=2)
            self.assertEqual({p: p.read_bytes() for p in protected}, protected)
