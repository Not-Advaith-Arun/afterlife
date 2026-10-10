"""Literal included-cell comparisons never infer deletion or hidden values."""
from .compiler import CompileError
from .projection_view import validate_projection


def compare_projections(left, right, *, include_values=False, offset=0, limit=25):
    left, right = validate_projection(left), validate_projection(right)
    if (type(include_values) is not bool or type(offset) is not int or type(limit) is not int
            or not 0 <= offset <= 640000 or not 1 <= limit <= 100):
        raise CompileError('Use a boolean private-detail choice, offset0..640000 and limit1..100')
    if ((left['app_id'], left['spec_fingerprint']) != (right['app_id'], right['spec_fingerprint'])
            or len(left['fields']) + left['omitted_field_count'] != len(right['fields']) + right['omitted_field_count']):
        raise CompileError('Partial copies must claim the same app/contract and consistent total field count')
    old_fields = {row['name']: row['type'] for row in left['fields']}
    new_fields = {row['name']: row['type'] for row in right['fields']}
    shared_fields = old_fields.keys() & new_fields.keys()
    if any(old_fields[name] != new_fields[name] for name in shared_fields):
        raise CompileError('Included field types contradict the claimed common contract')
    old = {row['id']: row for row in left['records']}
    new = {row['id']: row for row in right['records']}
    shared_ids = old.keys() & new.keys()
    counts = {'left_records': len(old), 'right_records': len(new), 'shared_records': len(shared_ids),
              'left_only_records': len(old.keys() - new.keys()), 'right_only_records': len(new.keys() - old.keys()),
              'left_fields': len(old_fields), 'right_fields': len(new_fields), 'shared_fields': len(shared_fields),
              'left_only_fields': len(old_fields.keys() - new_fields.keys()), 'right_only_fields': len(new_fields.keys() - old_fields.keys()),
              'shared_cells': 0, 'changed_shared_cells': 0, 'unchanged_shared_cells': 0,
              'left_only_cells': 0, 'right_only_cells': 0}
    details, differences = [], 0
    for identity in sorted(old.keys() | new.keys()):
        before, after = old.get(identity, {}), new.get(identity, {})
        for name in sorted((set(before) | set(after)) - {'id'}):
            one, two = name in before, name in after
            if one and two:
                counts['shared_cells'] += 1
                if before[name] == after[name]:
                    counts['unchanged_shared_cells'] += 1
                    continue
                counts['changed_shared_cells'] += 1
                kind = 'shared-value-changed'
            else:
                kind = 'left-only-included' if one else 'right-only-included'
                counts['left_only_cells' if one else 'right_only_cells'] += 1
            if include_values and offset <= differences < offset + limit:
                details.append({'record_id': identity, 'field': name, 'kind': kind,
                                'before_present': one, 'after_present': two,
                                **({'before': before[name]} if one else {}), **({'after': after[name]} if two else {})})
            differences += 1
    return {'format': 'afterlife-projection-comparison/v1', 'claimed_contract_markers_match': True, 'counts': counts,
            'shared_values_equal': counts['changed_shared_cells'] == 0 if counts['shared_cells'] else None,
            'private_detail': ({'offset': offset, 'limit': limit, 'total_differing_or_one_sided_cells': differences,
                               'next_offset': offset + limit if offset + limit < differences else None,
                               'cells': details} if include_values else None),
            'scope': 'Two separately read retained partial copies, not a common or current snapshot. Claimed app/contract markers match, not authenticated source identity or full-contract validation. '
                     'Only literal included values are compared; no semantic/Unicode normalization or hidden defaults. Left/right-only cells and rows describe inclusion only, never deletion/addition of source data. '
                     'Shared equality is null when no cells overlap and otherwise concerns that overlap only, never full collection parity. No merge, import, save or recovery authorization. '
                     'Private cell details are bounded and ordered by literal record ID then field name; default metadata omits IDs, field names and values.'}


def render_comparison(result):
    """Render only an internally computed comparison, never an imported report."""
    import json
    from html import escape

    def literal(value):
        return escape(json.dumps(value, ensure_ascii=False, allow_nan=False))

    counts, detail = result['counts'], result['private_detail']
    page = ['<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<meta name="referrer" content="no-referrer">'
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
            '<title>Partial copy comparison</title><style>'
            '*{box-sizing:border-box}body{margin:0;background:#151917;color:#edf3ee;font:17px/1.6 system-ui,sans-serif}'
            'main{max-width:900px;margin:auto;padding:24px 18px}section,article{background:#222b26;border:1px solid #44574a;border-radius:14px;padding:18px;margin:16px 0}'
            'h1{font-size:1.9rem}h2{font-size:1.2rem}h1,h2,pre,dd{overflow-wrap:anywhere}pre{white-space:pre-wrap;font:inherit;margin:6px 0}'
            'dt{font-weight:600}dd{margin:0 0 14px}summary{cursor:pointer}summary:focus-visible{outline:2px solid currentColor;outline-offset:4px}'
            '</style></head><body><main><h1>Partial copy comparison</h1><section><h2>Included overlap only</h2>']
    equality = result['shared_values_equal']
    page.append('<p id="overlap-verdict">' + ('No cells overlap; equality is unknown.' if equality is None else
                'Included overlapping values match.' if equality else 'Some included overlapping values differ.') + '</p>')
    page.append('<p>Left/right-only means included on just that side. It does not establish a source deletion or addition. Neither copy is a complete or current recovery snapshot.</p><dl id="counts">')
    for key, value in counts.items():
        page.append('<dt>' + escape(key.replace('_', ' ')) + '</dt><dd>' + str(value) + '</dd>')
    page.append('</dl><details><summary>Comparison scope and limits</summary><p>' + escape(result['scope']) + '</p></details></section>')
    if detail is None:
        page.append('<section><h2>Metadata only</h2><p>Record IDs, field names and values are omitted. Private cells require an explicit include-values request when generating a separate private report.</p></section>')
    else:
        page.append('<section><h2>Bounded private detail page</h2><p id="page-scope">Offset ' + str(detail['offset']) +
                    '; shown ' + str(len(detail['cells'])) + '; total differing or one-sided cells ' + str(detail['total_differing_or_one_sided_cells']) +
                    '. Unchanged overlapping cells are not listed.</p><p id="next-page">' +
                    ('Next offset: ' + str(detail['next_offset']) + '. Generate that page separately from the retained inputs.' if detail['next_offset'] is not None else
                     'No later detail page. Earlier cells may be omitted when offset is above zero.') + '</p></section>')
        for cell in detail['cells']:
            page.append('<article><h2>' + escape(cell['kind']) + '</h2><dl><dt>Record ID (text)</dt><dd><pre>' + literal(cell['record_id']) +
                        '</pre></dd><dt>Field (text)</dt><dd><pre>' + literal(cell['field']) + '</pre></dd>')
            for side, label in (('before', 'Left'), ('after', 'Right')):
                page.append('<dt>' + label + '</dt><dd>' + ('<pre>' + literal(cell[side]) + '</pre>' if cell[side + '_present'] else
                            '<p>Not included on this side (unknown source value).</p>') + '</dd>')
            page.append('</dl></article>')
    page.append('<footer>Static read-only review. No editing, merge, import, recovery or network access. Claimed contract markers are not authenticated provenance.</footer></main></body></html>')
    text = ''.join(page)
    if len(text.encode('utf-8')) > 32 * 1024 * 1024:
        raise CompileError('Comparison page exceeds32 MiB')
    return text
