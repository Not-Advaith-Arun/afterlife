"""Native partial sharing -> inert recipient view; malformed input cannot replace it."""
import copy
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ProjectionReviewAcceptance(unittest.TestCase):
    def cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, '-m', 'afterlife', *map(str, arguments)], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_partial_recipient_review_preserves_literals_and_refuses_unsafe_late_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = ROOT / 'examples/task-tracker/app.json'
            records, app = root / 'records.json', root / 'app.html'
            hostile = '</pre><img src="https://example.invalid/private" onerror="window.pwned=1"><script>window.pwned=2</script>\r\nλ "quoted"'
            rows = [{'id': 'first', 'title': 'PRIVATE_HIDDEN_TITLE', 'status': 'Planned', 'notes': hostile, 'hours': None, 'important': True},
                    {'id': 'second', 'title': 'PRIVATE_HIDDEN_TITLE', 'status': 'Done', 'notes': '0', 'hours': -9007199254740991, 'important': False},
                    {'id': 'third', 'title': 'PRIVATE_HIDDEN_TITLE', 'status': 'Planned', 'notes': '', 'hours': 0, 'important': False}]
            records.write_text(json.dumps({'records': rows}))
            self.cli(spec, records, '-o', app)
            data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', app.read_text(), re.S)[1])
            backup = root / 'backup.json'
            backup.write_text(json.dumps({'format': 'afterlife-data/v1', 'app_id': data['spec']['app_id'],
                                         'spec_fingerprint': data['spec_fingerprint'], 'records': rows}))
            projection, output = root / 'sharing.json', root / 'review.html'
            self.cli('export-projection', spec, backup, '--field', 'notes', '--field', 'hours', '--field', 'important',
                     '--record-id', 'third', '--record-id', 'first', '--record-id', 'second', '-o', projection)
            receipt = json.loads(self.cli('review-projection', projection, '-o', output).stdout)
            self.assertEqual((receipt['records'], receipt['fields'], receipt['claimed_omitted_fields']), (3, 3, 2))
            self.assertNotIn('first', json.dumps(receipt))
            self.assertNotIn('PRIVATE_HIDDEN_TITLE', output.read_text())
            self.assertNotIn('<img', output.read_text())
            self.assertIn('&lt;img', output.read_text())
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            protected = {path: path.read_bytes() for path in (spec, records, app, backup, projection, output)}
            if os.environ.get('AFTERLIFE_BROWSER_TESTS') == '1':
                from playwright.sync_api import sync_playwright
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    page = browser.new_page()
                    requests = []
                    page.on('request', lambda request: requests.append(request.url))
                    for width in (360, 1280):
                        page.set_viewport_size({'width': width, 'height': 900})
                        page.goto(output.as_uri())
                        self.assertEqual(page.locator('h1').inner_text(), 'Partial sharing review')
                        self.assertEqual(page.locator('article').count(), 3)
                        first = page.locator('article').nth(0).locator('pre').all_text_contents()
                        self.assertEqual(first, [json.dumps('first', ensure_ascii=False), json.dumps(hostile, ensure_ascii=False), 'null', 'true'])
                        self.assertEqual(page.locator('article').nth(1).locator('pre').all_text_contents(), ['"second"', '"0"', '-9007199254740991', 'false'])
                        self.assertEqual(page.locator('article').nth(2).locator('pre').all_text_contents(), ['"third"', '""', '0', 'false'])
                        self.assertEqual(page.locator('script,img,svg,a,input,form,button,iframe').count(), 0)
                        self.assertIsNone(page.evaluate('window.pwned'))
                        self.assertTrue(page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
                        page.locator('summary').focus(); page.keyboard.press('Enter')
                        self.assertIsNotNone(page.locator('details').get_attribute('open'))
                    self.assertTrue(all(url.startswith('file:') for url in requests))
                    browser.close()
            self.cli('review-projection', projection, '-o', output, expected=2)
            self.cli('review-projection', projection, '-o', projection, '--force', expected=2)
            linked = root / 'linked.json'; linked.hardlink_to(projection)
            self.cli('review-projection', projection, '-o', linked, '--force', expected=2)
            linked.unlink()
            original = json.loads(protected[projection])
            invalid = []
            for key, value in (('scope', 5), ('extra', 'unknown'), ('omitted_field_count', True)):
                invalid.append({**original, key: value})
            for bad_value in (True, 1.5, 9007199254740992):
                bad = copy.deepcopy(original); bad['records'][-1]['hours'] = bad_value; invalid.append(bad)
            bad = copy.deepcopy(original); del bad['records'][-1]['important']; invalid.append(bad)
            bad = copy.deepcopy(original); bad['fields'][-1]['type'] = []; invalid.append(bad)
            bad = copy.deepcopy(original); bad['records'][-1]['id'] = 'first'; invalid.append(bad)
            for bad in invalid:
                projection.write_text(json.dumps(bad))
                self.cli('review-projection', projection, '-o', output, '--force', expected=2)
                self.assertEqual(output.read_bytes(), protected[output])
            projection.write_bytes(b' ' * (10 * 1024 * 1024 + 1))
            self.cli('review-projection', projection, '-o', output, '--force', expected=2)
            # Valid bounded JSON can expand on HTML escaping; reject the complete
            # derived page before publication instead of leaking a partial review.
            expanded = {**original, 'fields': [{'name': 'notes', 'type': 'multiline'}], 'omitted_field_count': 4,
                        'records': [{'id': str(i), 'notes': '&' * 10000} for i in range(700)]}
            projection.write_text(json.dumps(expanded))
            self.cli('review-projection', projection, '-o', output, '--force', expected=2)
            projection.write_bytes(protected[projection])
            self.assertEqual({path: path.read_bytes() for path in protected}, protected)
