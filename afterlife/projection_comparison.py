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
