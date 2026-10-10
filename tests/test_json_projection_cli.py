"""Native/browser exact-type partial sharing parity and deliberate import refusal."""
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


class JSONProjectionAcceptance(unittest.TestCase):
    def cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, "-m", "afterlife", *map(str, arguments)], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_exact_selected_json_sharing_omits_hidden_values_and_cannot_replace_a_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = ROOT / "examples/task-tracker/app.json"
            records, html = root / "records.json", root / "app.html"
            rows = [{"id": "row-" + str(i), "title": "Job " + str(i), "status": "Planned",
                     "notes": "PRIVATE_SECRET_猫 " + str(i), "hours": None if i == 204 else 9007199254740991 if i == 103 else i,
                     "important": i % 2 == 0} for i in range(205)]
            records.write_text(json.dumps({"records": rows}))
            self.cli(spec, records, "-o", html)
            data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', html.read_text(), re.S)[1])
            envelope = {"format": "afterlife-data/v1", "app_id": data["spec"]["app_id"],
                        "spec_fingerprint": data["spec_fingerprint"], "records": rows}
            backup, output = root / "backup.json", root / "sharing.json"
            backup.write_text(json.dumps(envelope))
            arguments = ["export-projection", spec, backup, "-o", output]
            for name in ("important", "hours", "status", "title"):
                arguments += ["--field", name]
            for identity in ("row-204", "row-103", "row-0"):
                arguments += ["--record-id", identity]
            receipt = json.loads(self.cli(*arguments).stdout)
            projected = json.loads(output.read_text())
            expected = [{key: value for key, value in rows[i].items() if key != "notes"} for i in (0, 103, 204)]
            self.assertEqual(projected["records"], expected)
            self.assertEqual([field["name"] for field in projected["fields"]], ["title", "status", "hours", "important"])
            self.assertEqual((receipt["records"], receipt["fields"], receipt["omitted_fields"], receipt["omitted_records"]), (3, 4, 1, 202))
            self.assertNotIn("PRIVATE_SECRET", output.read_text())
            self.assertNotIn("row-", json.dumps(receipt))
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            protected = {path: path.read_bytes() for path in (spec, records, html, backup, output)}
            self.cli("from-export", spec, output, "-o", html, "--force", expected=2)
            if os.environ.get("AFTERLIFE_BROWSER_TESTS") == "1":
                from playwright.sync_api import sync_playwright
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    context = browser.new_context(accept_downloads=True, viewport={"width": 390, "height": 844})
                    page = context.new_page()
                    page.goto(html.as_uri())
                    page.locator('.chosen-records summary').click()
                    page.get_by_role('checkbox', name='Choose individual records', exact=True).check()
                    for i in (0, 103, 204):
                        page.get_by_role('searchbox').fill('Job ' + str(i))
                        page.get_by_role('checkbox', name='Choose record row-' + str(i), exact=True).check()
                    page.get_by_role('searchbox').fill('no matches')
                    page.get_by_text('Table columns', exact=True).click()
                    page.get_by_role('checkbox', name='Show Notes column', exact=True).uncheck()
                    with page.expect_download() as event:
                        page.get_by_role('button', name='Download chosen visible-field JSON', exact=True).click()
                    downloaded = json.loads(Path(event.value.path()).read_text())
                    for key in ('format', 'app_id', 'spec_fingerprint', 'fields', 'omitted_field_count', 'records'):
                        self.assertEqual(downloaded[key], projected[key])
                    self.assertEqual(page.evaluate('localStorage.length'), 0)
                    page.locator('#import-file').set_input_files(output)
                    page.wait_for_function("document.getElementById('message').textContent.match(/Import failed|Import refused|unsupported|format|different/)")
                    self.assertEqual(page.evaluate('localStorage.length'), 0)
                    with page.expect_download() as event:
                        page.get_by_role('button', name='Export JSON', exact=True).click()
                    self.assertEqual(json.loads(Path(event.value.path()).read_text())["records"], rows)
                    self.assertTrue(page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
                    browser.close()
            for extra in (("--field", "title"), ("--field", "id"), ("--record-id", "missing"), ("--record-id", "row-0")):
                self.cli(*arguments, *extra, "--force", expected=2)
                self.assertEqual({path: path.read_bytes() for path in protected}, protected)
            malformed = copy.deepcopy(envelope)
            malformed["records"][1]["hours"] = "invalid unselected integer"
            backup.write_text(json.dumps(malformed))
            self.cli(*arguments, "--force", expected=2)
            self.assertEqual(output.read_bytes(), protected[output])
            backup.write_bytes(protected[backup])
            self.cli("export-projection", spec, backup, "--field", "title", "--record-id", "row-0", "-o", backup, "--force", expected=2)
            self.assertEqual({path: path.read_bytes() for path in protected}, protected)
