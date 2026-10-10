"""Retained partial copies -> metadata/private pages without invented source changes."""
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


class ProjectionComparisonReviewJourney(unittest.TestCase):
    def cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, '-m', 'afterlife', *map(str, arguments)], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_partial_comparison_pages_keep_inclusion_unknown_and_private_cells_inert(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = ROOT / 'examples/task-tracker/app.json'
            rows = [{'id': 'private-row', 'title': 'PRIVATE_HIDDEN_MARKER', 'status': 'Planned', 'notes': 'e\u0301', 'hours': None, 'important': True}]
            records, app = root / 'records.json', root / 'app.html'
            records.write_text(json.dumps({'records': rows}))
            self.cli(spec, records, '-o', app)
            data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', app.read_text(), re.S)[1])
            backup, left, right = root / 'backup.json', root / 'left.json', root / 'right.json'
            source = {'format': 'afterlife-data/v1', 'app_id': data['spec']['app_id'],
                      'spec_fingerprint': data['spec_fingerprint'], 'records': rows}
            backup.write_text(json.dumps(source))
            self.cli('export-projection', spec, backup, '--field', 'notes', '--field', 'hours', '--record-id', 'private-row', '-o', left)
            hostile = '</pre><img src="https://example.invalid/leak" onerror="window.pwned=1"><script>window.pwned=2</script>λ'
            source['records'][0].update(notes=hostile, hours=0, important=False)
            backup.write_text(json.dumps(source))
            self.cli('export-projection', spec, backup, '--field', 'notes', '--field', 'hours', '--field', 'important',
                     '--record-id', 'private-row', '-o', right)
            protected = {path: path.read_bytes() for path in (spec, records, app, backup, left, right)}
            metadata, output = root / 'metadata.html', root / 'private.html'
            receipt = json.loads(self.cli('compare-projections', left, right, '--format', 'html', '-o', metadata).stdout)
            self.assertFalse(receipt['private_detail_saved'])
            self.assertNotIn('private-row', metadata.read_text())
            self.assertNotIn('notes', metadata.read_text())
            self.assertEqual(stat.S_IMODE(metadata.stat().st_mode), 0o600)
            self.cli('compare-projections', left, right, '--format', 'html', '--include-values', '--limit', '2', '-o', output)
            self.assertNotIn('<img', output.read_text())
            self.assertNotIn('PRIVATE_HIDDEN_MARKER', output.read_text())
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            if os.environ.get('AFTERLIFE_BROWSER_TESTS') == '1':
                from playwright.sync_api import sync_playwright
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    page = browser.new_page()
                    requests = []
                    page.on('request', lambda request: requests.append(request.url))
                    for width in (360, 1280):
                        page.set_viewport_size({'width': width, 'height': 900})
                        page.goto(metadata.as_uri())
                        self.assertIn('Some included overlapping values differ', page.locator('#overlap-verdict').inner_text())
                        self.assertEqual(page.locator('article').count(), 0)
                        page.goto(output.as_uri())
                        self.assertEqual(page.locator('article').count(), 2)
                        self.assertEqual(page.locator('article').nth(0).locator('pre').all_text_contents(), ['"private-row"', '"hours"', 'null', '0'])
                        self.assertEqual(page.locator('article').nth(1).locator('pre').all_text_contents(), ['"private-row"', '"important"', 'false'])
                        self.assertIn('unknown source value', page.locator('article').nth(1).inner_text())
                        self.assertIn('Next offset: 2', page.locator('#next-page').inner_text())
                        self.assertTrue(page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
                        self.assertEqual(page.locator('script,img,svg,a,input,form,button,iframe').count(), 0)
                        page.locator('summary').focus(); page.keyboard.press('Enter')
                        self.assertIsNotNone(page.locator('details').get_attribute('open'))
                    self.cli('compare-projections', left, right, '--format', 'html', '--include-values', '--offset', '2', '--limit', '2', '-o', output, '--force')
                    page.goto(output.as_uri())
                    self.assertEqual(page.locator('article pre').all_text_contents(), ['"private-row"', '"notes"', json.dumps('e\u0301', ensure_ascii=False), json.dumps(hostile, ensure_ascii=False)])
                    self.assertIn('Earlier cells may be omitted', page.locator('#next-page').inner_text())
                    self.assertIsNone(page.evaluate('window.pwned'))
                    self.assertTrue(all(url.startswith('file:') for url in requests))
                    browser.close()
            saved = output.read_bytes()
            for arguments in (('--format', 'html'), ('--format', 'html', '--include-values')):
                self.cli('compare-projections', left, right, *arguments, expected=2)
            self.cli('compare-projections', left, right, '--format', 'html', '-o', output, expected=2)
            self.cli('compare-projections', left, right, '--format', 'html', '-o', left, '--force', expected=2)
            linked = root / 'link.html'; linked.symlink_to(output)
            self.cli('compare-projections', left, right, '--format', 'html', '-o', linked, '--force', expected=2)
            bad = copy.deepcopy(json.loads(protected[right])); bad['records'][-1]['hours'] = True
            right.write_text(json.dumps(bad))
            self.cli('compare-projections', left, right, '--format', 'html', '-o', output, '--force', expected=2)
            self.assertEqual(saved, output.read_bytes())
            right.write_bytes(protected[right])
            # No included overlap cannot be rendered as collection equality.
            value = json.loads(protected[right]); value['records'][0]['id'] = 'different'
            right.write_text(json.dumps(value))
            self.cli('compare-projections', left, right, '--format', 'html', '-o', output, '--force')
            self.assertIn('No cells overlap; equality is unknown.', output.read_text())
            right.write_bytes(protected[right])
            self.assertEqual({path: path.read_bytes() for path in protected}, protected)
