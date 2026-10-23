"""CLI publication and HTML embedding boundaries for the offline showcase."""
import importlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1].name


class ShowcaseWorkflow(unittest.TestCase):
    def test_cli_generates_actual_sample_and_preserves_existing_destinations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'sample.html'
            def run(*extra):
                return subprocess.run([sys.executable, '-m', PROJECT, 'showcase', '-o', str(output), *extra], capture_output=True, text=True)
            generated = run()
            self.assertEqual(generated.returncode, 0, generated.stderr)
            original = output.read_bytes()
            config = json.loads(re.search(r'<script id="showcase-data" type="application/json">(.*?)</script>', original.decode(), re.S).group(1))
            self.assertEqual(config['slug'], PROJECT)
            self.assertTrue(config['states'][0]['output'])
            self.assertEqual(run().returncode, 2)
            self.assertEqual(output.read_bytes(), original)
            target = root / 'kept.html'
            target.write_text('existing user content')
            output.unlink()
            output.symlink_to(target)
            self.assertEqual(run('--force').returncode, 2)
            self.assertEqual(target.read_text(), 'existing user content')
            output.unlink()
            result = run('--overview', '--collection-links')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Project collection', output.read_text())
            self.assertEqual(sorted(p.name for p in root.iterdir()), ['kept.html', 'sample.html'])

    def test_sample_strings_cannot_escape_the_document_data_element(self):
        showcase = importlib.import_module(PROJECT + '.showcase')
        hostile = '</script><img src=x onerror="window.injected=true"> & __SCRIPT__'
        rendered = showcase.render({'name': hostile, 'payload': hostile})
        payload = re.search(r'<script id="showcase-data" type="application/json">(.*?)</script>', rendered, re.S).group(1)
        self.assertEqual(json.loads(payload)['payload'], hostile)
        self.assertNotIn('<img src=x', rendered)
        self.assertIn('&lt;/script&gt;', rendered)


if __name__ == '__main__':
    unittest.main()
