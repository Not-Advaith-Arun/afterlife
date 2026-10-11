"""Recipient-only data minimization keeps exact included types and no recovery authority."""
import copy
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProjectionReselectionJourney(unittest.TestCase):
    def cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, '-m', 'afterlife', *map(str, arguments)], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_recipient_reselection_preserves_exact_values_and_drops_publisher_prose_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); spec = ROOT / 'examples/task-tracker/app.json'
            records, app = root / 'records.json', root / 'app.html'
            rows = [{'id': 'first', 'title': 'PRIVATE_DROPPED_TITLE', 'status': 'Planned', 'notes': 'e\u0301', 'hours': None, 'important': True},
                    {'id': 'second', 'title': 'PRIVATE_DROPPED_TITLE', 'status': 'Done', 'notes': 'é', 'hours': -9007199254740991, 'important': False},
                    {'id': 'third', 'title': 'PRIVATE_DROPPED_TITLE', 'status': 'Planned', 'notes': 'PRIVATE_DROPPED_ROW', 'hours': 0, 'important': False}]
            records.write_text(json.dumps({'records': rows})); self.cli(spec, records, '-o', app)
            data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', app.read_text(), re.S)[1])
            backup = root / 'backup.json'; backup.write_text(json.dumps({'format': 'afterlife-data/v1', 'app_id': data['spec']['app_id'],
                                                                       'spec_fingerprint': data['spec_fingerprint'], 'records': rows}))
            projection, output = root / 'initial.json', root / 'selected.json'
            arguments = ['--field', 'title', '--field', 'notes', '--field', 'hours', '--field', 'important']
            self.cli('export-projection', spec, backup, *arguments, '--record-id', 'third', '--record-id', 'second', '--record-id', 'first', '-o', projection)
            value = json.loads(projection.read_text()); value['scope'] = 'PRIVATE_DROPPED_TITLE and original publisher prose'
            projection.write_text(json.dumps(value)); protected = {p: p.read_bytes() for p in (spec, records, app, backup, projection)}
            choices = ['--field', 'important', '--field', 'hours', '--field', 'notes', '--record-id', 'second', '--record-id', 'first']
            receipt = json.loads(self.cli('reselect-projection', projection, *choices, '-o', output).stdout)
            self.assertFalse(receipt['publisher_scope_copied'])
            self.assertEqual((receipt['records'], receipt['fields'], receipt['claimed_omitted_fields'], receipt['dropped_included_records']), (2, 3, 2, 1))
            derived = json.loads(output.read_text())
            self.assertEqual(derived['records'], [{key: row[key] for key in ('id', 'notes', 'hours', 'important')} for row in rows[:2]])
            self.assertEqual([f['name'] for f in derived['fields']], ['notes', 'hours', 'important'])
            self.assertEqual(derived['app_id'], value['app_id']); self.assertEqual(derived['spec_fingerprint'], value['spec_fingerprint'])
            self.assertNotIn('PRIVATE_DROPPED_TITLE', output.read_text()); self.assertNotIn('PRIVATE_DROPPED_ROW', output.read_text())
            self.assertNotIn('first', json.dumps(receipt)); self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            comparison = json.loads(self.cli('compare-projections', projection, output).stdout)
            self.assertTrue(comparison['shared_values_equal']); self.assertEqual(comparison['counts']['changed_shared_cells'], 0)
            explicit = root / 'publisher.json'
            self.cli('reselect-projection', projection, *choices, '--keep-publisher-scope', '-o', explicit)
            self.assertEqual(json.loads(explicit.read_text())['scope'], value['scope'])
            # Re-selecting a derived copy cannot recover its missing title or hidden third record.
            self.cli('reselect-projection', output, '--field', 'title', '--record-id', 'first', '-o', explicit, '--force', expected=2)
            self.cli('reselect-projection', output, '--field', 'notes', '--record-id', 'third', '-o', explicit, '--force', expected=2)
            self.cli('from-export', spec, output, '-o', root / 'recovery.html', expected=2)
            if os.environ.get('AFTERLIFE_BROWSER_TESTS') == '1':
                from playwright.sync_api import sync_playwright
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True); page = browser.new_page()
                    page.goto(app.as_uri())
                    self.assertEqual(page.evaluate('localStorage.length'), 0)
                    page.locator('#import-file').set_input_files(output)
                    page.wait_for_function("document.getElementById('message').textContent.match(/Import failed|Import refused|unsupported|format|different/)")
                    self.assertEqual(page.evaluate('localStorage.length'), 0)
                    with page.expect_download() as event:
                        page.get_by_role('button', name='Export JSON', exact=True).click()
                    self.assertEqual(json.loads(Path(event.value.path()).read_text())['records'], rows)
                    browser.close()
            saved = output.read_bytes()
            self.cli('reselect-projection', projection, *choices, '-o', output, expected=2)
            self.cli('reselect-projection', projection, *choices, '-o', projection, '--force', expected=2)
            link = root / 'linked.json'; link.hardlink_to(projection)
            self.cli('reselect-projection', projection, *choices, '-o', link, '--force', expected=2)
            link.unlink(); link.symlink_to(output)
            self.cli('reselect-projection', projection, *choices, '-o', link, '--force', expected=2)
            for extra in [ ['--field', 'notes'], ['--record-id', 'first'], ['--field', 'unknown'], ['--record-id', 'unknown'] ]:
                self.cli('reselect-projection', projection, *choices, *extra, '-o', output, '--force', expected=2)
            invalid = copy.deepcopy(value); invalid['records'][-1]['hours'] = True; projection.write_text(json.dumps(invalid))
            self.cli('reselect-projection', projection, *choices, '-o', output, '--force', expected=2)
            self.assertEqual(output.read_bytes(), saved)
            projection.write_bytes(b' ' * (10 * 1024 * 1024 + 1))
            self.cli('reselect-projection', projection, *choices, '-o', output, '--force', expected=2)
            self.assertEqual(output.read_bytes(), saved)
            projection.write_bytes(protected[projection]); self.assertEqual({p: p.read_bytes() for p in protected}, protected)
