"""Private selection documents replace inline IDs without changing sharing semantics."""
import copy
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProjectionSelectionFileJourney(unittest.TestCase):
    def cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, '-m', 'afterlife', *map(str, arguments)], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        if not result.stdout:
            return result.stderr
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            return result.stdout

    def test_private_selection_documents_match_inline_exports_and_reselection_and_refuse_ambiguous_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); spec = ROOT / 'examples/task-tracker/app.json'
            rows = [{'id': 'PRIVATE-ID-α', 'title': 'PRIVATE_DROPPED_TITLE', 'status': 'Planned', 'notes': 'e\u0301', 'hours': None, 'important': True},
                    {'id': 'PRIVATE-ID-β', 'title': 'PRIVATE_DROPPED_TITLE', 'status': 'Done', 'notes': '', 'hours': -9007199254740991, 'important': False}]
            records, app = root / 'records.json', root / 'app.html'
            records.write_text(json.dumps({'records': rows})); self.cli(spec, records, '-o', app)
            data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', app.read_text(), re.S)[1])
            backup = root / 'backup.json'; backup.write_text(json.dumps({'format': 'afterlife-data/v1', 'app_id': data['spec']['app_id'],
                                                                       'spec_fingerprint': data['spec_fingerprint'], 'records': rows}))
            selected = {'format': 'afterlife-projection-selection/v1', 'fields': ['important', 'hours', 'notes'],
                        'record_ids': ['PRIVATE-ID-β', 'PRIVATE-ID-α']}
            selection = root / 'selection.json'; selection.write_text(json.dumps(selected))
            inline, output = root / 'inline.json', root / 'selected.json'
            choices = ['--field', 'important', '--field', 'hours', '--field', 'notes', '--record-id', 'PRIVATE-ID-β', '--record-id', 'PRIVATE-ID-α']
            self.cli('export-projection', spec, backup, *choices, '-o', inline)
            receipt = self.cli('export-projection', spec, backup, '--selection', selection, '-o', output)
            self.assertEqual(output.read_bytes(), inline.read_bytes())
            self.assertNotIn('PRIVATE-ID', json.dumps(receipt)); self.assertNotIn('PRIVATE_DROPPED_TITLE', output.read_text())
            # A recipient needs only the initial partial copy and a second private selection file.
            reduced = root / 'reduced.json'; expected = root / 'expected.json'
            narrower = {**selected, 'fields': ['notes', 'hours'], 'record_ids': ['PRIVATE-ID-β']}
            selection.write_text(json.dumps(narrower))
            self.cli('reselect-projection', output, '--field', 'hours', '--field', 'notes', '--record-id', 'PRIVATE-ID-β', '-o', expected)
            receipt = self.cli('reselect-projection', output, '--selection', selection, '-o', reduced)
            self.assertEqual(reduced.read_bytes(), expected.read_bytes())
            self.assertEqual(json.loads(reduced.read_text())['records'], [{'id': 'PRIVATE-ID-β', 'notes': '', 'hours': -9007199254740991}])
            self.assertNotIn('PRIVATE-ID', json.dumps(receipt)); self.assertEqual(reduced.stat().st_mode & 0o777, 0o600)
            protected = {p: p.read_bytes() for p in (spec, backup, records, app, selection, output, reduced)}
            operations = [('export-projection', spec, backup), ('reselect-projection', output)]
            bad = [ {**narrower, 'format': 'other'}, {**narrower, 'extra': 'not allowed'},
                    {**narrower, 'fields': []}, {**narrower, 'fields': ['notes', 'notes']},
                    {**narrower, 'record_ids': ['PRIVATE-ID-β', 'PRIVATE-ID-β']},
                    {**narrower, 'record_ids': ['PRIVATE-ID-β', 'unknown']},
                    {**narrower, 'record_ids': [True]}, {**narrower, 'fields': 'notes'} ]
            for operation in operations:
                for value in bad:
                    selection.write_text(json.dumps(value))
                    self.cli(*operation, '--selection', selection, '-o', reduced, '--force', expected=2)
                    self.assertEqual(reduced.read_bytes(), protected[reduced])
                for raw in [b'{"format":"afterlife-projection-selection/v1","fields":["notes"],"record_ids":[],"record_ids":["PRIVATE-ID-\\u03b2"]}', b' ' * (4 * 1024 * 1024 + 1)]:
                    selection.write_bytes(raw)
                    self.cli(*operation, '--selection', selection, '-o', reduced, '--force', expected=2)
                    self.assertEqual(reduced.read_bytes(), protected[reduced])
                selection.write_bytes(protected[selection])
                self.cli(*operation, '--selection', selection, '--field', 'notes', '-o', reduced, '--force', expected=2)
                self.cli(*operation, '--selection', selection, '-o', selection, '--force', expected=2)
                link = root / 'linked-selection.json'; link.hardlink_to(selection)
                self.cli(*operation, '--selection', selection, '-o', link, '--force', expected=2); link.unlink()
                self.cli(*operation, '--field', 'notes', '-o', reduced, '--force', expected=2)
            self.assertEqual({p: p.read_bytes() for p in protected}, protected)
