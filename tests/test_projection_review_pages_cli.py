"""A valid large sharing copy can be reviewed without lifting the HTML bound."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProjectionReviewPagesJourney(unittest.TestCase):
    def cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, '-m', 'afterlife', *map(str, arguments)], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return json.loads(result.stdout) if result.stdout else result.stderr

    def test_large_included_collection_has_bounded_pages_and_unshown_invalid_rows_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source, output = root / 'large.json', root / 'review.html'
            value = {'format': 'afterlife-record-projection/v1', 'app_id': 'fixture', 'spec_fingerprint': '0' * 64,
                     'fields': [{'name': 'notes', 'type': 'multiline'}], 'omitted_field_count': 4,
                     'scope': 'Unverified publisher prose may describe the original full sharing copy.',
                     'records': [{'id': 'row-' + str(i), 'notes': '&' * 10000} for i in range(700)]}
            source.write_text(json.dumps(value)); original = source.read_bytes()
            self.cli('review-projection', source, '-o', output, expected=2)
            self.assertFalse(output.exists())
            first = self.cli('review-projection', source, '--offset', '0', '--limit', '1', '-o', output)
            self.assertEqual(first['records'], 700)
            self.assertEqual(first['display_window'], {'offset': 0, 'limit': 1, 'shown_records': 1, 'earlier_records': 0, 'later_records': 699, 'next_offset': 1})
            last = self.cli('review-projection', source, '--offset', '698', '--limit', '100', '-o', output, '--force')
            self.assertEqual(last['display_window'], {'offset': 698, 'limit': 100, 'shown_records': 2, 'earlier_records': 698, 'later_records': 0, 'next_offset': None})
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertLess(output.stat().st_size, 32 * 1024 * 1024)
            if os.environ.get('AFTERLIFE_BROWSER_TESTS') == '1':
                from playwright.sync_api import sync_playwright
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True); page = browser.new_page(); requests = []
                    page.on('request', lambda request: requests.append(request.url))
                    for width in (360, 1280):
                        page.set_viewport_size({'width': width, 'height': 900}); page.goto(output.as_uri())
                        self.assertEqual(page.locator('article').count(), 2)
                        self.assertEqual(page.locator('article').nth(0).locator('pre').all_text_contents(), ['"row-698"', json.dumps('&' * 10000)])
                        self.assertEqual(page.locator('article').nth(1).locator('pre').all_text_contents(), ['"row-699"', json.dumps('&' * 10000)])
                        self.assertIn('Showing 2 of 700 included records', page.locator('#page-scope').inner_text())
                        self.assertIn('Earlier included records not shown: 698', page.locator('#page-scope').inner_text())
                        self.assertIn('not a newly redacted sharing copy', page.locator('body').inner_text())
                        self.assertIn('may describe or disclose unshown records', page.locator('body').inner_text())
                        self.assertTrue(page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
                        self.assertEqual(page.locator('script,img,svg,a,input,form,button,iframe').count(), 0)
                    self.assertTrue(all(url.startswith('file:') for url in requests)); browser.close()
            saved = output.read_bytes()
            for arguments in [('--offset', '-1', '--limit', '1'), ('--offset', '700', '--limit', '1'),
                              ('--offset', '1'), ('--limit', '0'), ('--limit', '101')]:
                self.cli('review-projection', source, *arguments, '-o', output, '--force', expected=2)
                self.assertEqual(output.read_bytes(), saved)
            invalid = copy.deepcopy(value); invalid['records'][-1]['notes'] = False
            source.write_text(json.dumps(invalid))
            self.cli('review-projection', source, '--offset', '0', '--limit', '1', '-o', output, '--force', expected=2)
            self.assertEqual(output.read_bytes(), saved)
            source.write_bytes(original)
            self.cli('review-projection', source, '--limit', '1', '-o', source, '--force', expected=2)
            self.cli('review-projection', source, '-o', output, '--force', expected=2)
            self.assertEqual(output.read_bytes(), saved); self.assertEqual(source.read_bytes(), original)
