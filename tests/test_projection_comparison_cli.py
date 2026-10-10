"""Included-only comparisons distinguish null, absence and actual literal changes."""
import copy
import json
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ProjectionComparisonAcceptance(unittest.TestCase):
    def cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, '-m', 'afterlife', *map(str, arguments)], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return json.loads(result.stdout) if result.stdout.startswith('{') else result

    def test_partial_overlap_private_pages_and_disjoint_unknown_never_infer_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = ROOT / 'examples/task-tracker/app.json'
            rows = [{'id': 'row-' + str(i), 'title': 'PRIVATE_TITLE', 'status': 'Planned',
                     'notes': 'e\u0301' if i == 1 else 'PRIVATE_NOTES', 'hours': None if i < 2 else i,
                     'important': i % 2 == 0} for i in range(4)]
            records, html = root / 'records.json', root / 'app.html'
            records.write_text(json.dumps({'records': rows}))
            self.cli(spec, records, '-o', html)
            data = json.loads(re.search(r'id="afterlife-data">(.*?)</script>', html.read_text(), re.S)[1])
            envelope = {'format': 'afterlife-data/v1', 'app_id': data['spec']['app_id'],
                        'spec_fingerprint': data['spec_fingerprint'], 'records': rows}
            before, after = root / 'before.json', root / 'after.json'
            before.write_text(json.dumps(envelope))
            changed = copy.deepcopy(envelope)
            changed['records'][1].update(notes='é', hours=0, important=True)
            after.write_text(json.dumps(changed))
            left, right = root / 'left.json', root / 'right.json'
            def export(backup, output, fields, identities):
                arguments = ['export-projection', spec, backup, '-o', output]
                for field in fields: arguments += ['--field', field]
                for identity in identities: arguments += ['--record-id', identity]
                self.cli(*arguments)
            export(before, left, ['title', 'notes', 'hours', 'important'], ['row-2', 'row-0', 'row-1'])
            export(after, right, ['status', 'notes', 'hours', 'important'], ['row-3', 'row-2', 'row-1'])
            protected = {path: path.read_bytes() for path in (spec, records, html, before, after, left, right)}
            report = self.cli('compare-projections', left, right)
            self.assertFalse(report['shared_values_equal'])
            self.assertIsNone(report['private_detail'])
            self.assertEqual({key: report['counts'][key] for key in ('shared_records', 'left_only_records', 'right_only_records', 'shared_fields',
                'shared_cells', 'changed_shared_cells', 'unchanged_shared_cells', 'left_only_cells', 'right_only_cells')},
                {'shared_records': 2, 'left_only_records': 1, 'right_only_records': 1, 'shared_fields': 3,
                 'shared_cells': 6, 'changed_shared_cells': 3, 'unchanged_shared_cells': 3, 'left_only_cells': 6, 'right_only_cells': 6})
            self.assertNotIn('PRIVATE_', json.dumps(report))
            self.assertNotIn('row-', json.dumps(report))
            output = root / 'private-comparison.json'
            cells, offset = [], 0
            while offset is not None:
                receipt = self.cli('compare-projections', left, right, '--include-values', '--offset', str(offset), '--limit', '2',
                                   '-o', output, '--force')
                self.assertNotIn('row-', json.dumps(receipt))
                private = json.loads(output.read_text())['private_detail']
                self.assertLessEqual(len(private['cells']), 2)
                self.assertEqual(private['total_differing_or_one_sided_cells'], 15)
                cells += private['cells']
                offset = private['next_offset']
            self.assertEqual(len(cells), 15)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            null_to_zero = next(row for row in cells if row['record_id'] == 'row-1' and row['field'] == 'hours')
            self.assertEqual((null_to_zero['before'], null_to_zero['after']), (None, 0))
            self.assertTrue(null_to_zero['before_present'] and null_to_zero['after_present'])
            literal_unicode = next(row for row in cells if row['record_id'] == 'row-1' and row['field'] == 'notes')
            self.assertEqual((literal_unicode['before'], literal_unicode['after']), ('e\u0301', 'é'))
            one_sided_null = next(row for row in cells if row['record_id'] == 'row-0' and row['field'] == 'hours')
            self.assertIsNone(one_sided_null['before'])
            self.assertFalse(one_sided_null['after_present'])
            self.assertNotIn('after', one_sided_null)
            self.assertTrue(self.cli('compare-projections', left, left)['shared_values_equal'])
            disjoint_left, disjoint_right = root / 'one.json', root / 'two.json'
            export(before, disjoint_left, ['notes'], ['row-0'])
            export(after, disjoint_right, ['important'], ['row-3'])
            self.assertIsNone(self.cli('compare-projections', disjoint_left, disjoint_right)['shared_values_equal'])
            saved = output.read_bytes()
            for arguments in (('--include-values',), ('--limit', '0'), ('--offset', '-1')):
                self.cli('compare-projections', left, right, *arguments, expected=2)
            right_value = json.loads(protected[right])
            invalid = [{**right_value, 'app_id': 'different'}, {**right_value, 'spec_fingerprint': '0' * 64}]
            inconsistent = copy.deepcopy(right_value)
            next(field for field in inconsistent['fields'] if field['name'] == 'notes')['type'] = 'text'
            invalid.append(inconsistent)
            malformed = copy.deepcopy(right_value); malformed['records'][-1]['hours'] = True; invalid.append(malformed)
            for value in invalid:
                right.write_text(json.dumps(value))
                self.cli('compare-projections', left, right, '--include-values', '-o', output, '--force', expected=2)
                self.assertEqual(output.read_bytes(), saved)
            right.write_bytes(protected[right])
            self.cli('compare-projections', left, right, '--include-values', '-o', left, '--force', expected=2)
            # Two valid <=10MiB documents can produce >10MiB of explicit private
            # comparison detail after JSON escaping; retain the old output on refusal.
            for path, character in ((disjoint_left, '\x00'), (disjoint_right, '\x01')):
                value = {**right_value, 'fields': [{'name': 'notes', 'type': 'multiline'}], 'omitted_field_count': 4,
                         'records': [{'id': str(i), 'notes': character * 10000} for i in range(100)]}
                path.write_text(json.dumps(value))
            self.cli('compare-projections', disjoint_left, disjoint_right, '--include-values', '--limit', '100',
                     '-o', output, '--force', expected=2)
            self.assertEqual(output.read_bytes(), saved)
            self.assertEqual({path: path.read_bytes() for path in protected}, protected)
