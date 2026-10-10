"""Explicit exact-type sharing projections, deliberately not recovery backups."""
from .compiler import CompileError, validate_spec
from .transfers import backup_records


def selected_projection(spec, backup, *, fields, record_ids):
    spec = validate_spec(spec)
    records = backup_records(spec, backup)
    for supplied, known in ((fields, {field['name'] for field in spec['fields']}),
                             (record_ids, {row['id'] for row in records})):
        if (not isinstance(supplied, list) or not supplied
                or any(not isinstance(value, str) or value not in known for value in supplied)
                or len(set(supplied)) != len(supplied)):
            raise CompileError('Projection choices must be nonempty, distinct existing fields/record IDs')
    chosen_fields = [field for field in spec['fields'] if field['name'] in fields]
    chosen_ids = set(record_ids)
    names = ['id', *[field['name'] for field in chosen_fields]]
    return {'format': 'afterlife-record-projection/v1', 'app_id': spec['app_id'],
            'spec_fingerprint': backup['spec_fingerprint'],
            'fields': [{'name': field['name'], 'type': field['type']} for field in chosen_fields],
            'omitted_field_count': len(spec['fields']) - len(chosen_fields),
            'records': [{name: row[name] for name in names} for row in records if row['id'] in chosen_ids],
            'scope': 'Deliberate partial sharing copy: explicit stored records in collection order, only selected contract fields plus private Record IDs. '
                     'Exact JSON types/literal values retained; omitted fields are not deleted from the source. '
                     'Retained backup values only; no browser/editor state read. Not a full backup or native import envelope; use full export for recovery. '
                     'No save, merge, deletion, freshness or source-authenticity claim; complete source backup was validated before selection.'}
