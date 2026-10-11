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


def reselected_projection(projection, *, fields, record_ids, keep_publisher_scope=False):
    """Derive a smaller partial copy; never reconstruct its missing contract/data."""
    from .projection_view import validate_projection
    projection = validate_projection(projection)
    if type(keep_publisher_scope) is not bool:
        raise CompileError('Publisher scope retention must be an explicit boolean')
    for supplied, known in ((fields, {field['name'] for field in projection['fields']}),
                             (record_ids, {row['id'] for row in projection['records']})):
        if (not isinstance(supplied, list) or not supplied
                or any(not isinstance(value, str) or value not in known for value in supplied)
                or len(set(supplied)) != len(supplied)):
            raise CompileError('Reselection needs distinct nonempty included fields/record IDs; hidden values cannot be recovered')
    chosen = [dict(field) for field in projection['fields'] if field['name'] in fields]
    identities = set(record_ids)
    names = ['id', *[field['name'] for field in chosen]]
    return {'format': projection['format'], 'app_id': projection['app_id'],
            'spec_fingerprint': projection['spec_fingerprint'], 'fields': chosen,
            'omitted_field_count': projection['omitted_field_count'] + len(projection['fields']) - len(chosen),
            'records': [{name: row[name] for name in names} for row in projection['records'] if row['id'] in identities],
            'scope': (projection['scope'] if keep_publisher_scope else
                      'Derived partial copy: explicit included fields and record IDs reselected from a retained partial document, in that document’s order. '
                      'Original publisher scope prose omitted because it may contain private values or describe the earlier copy. '
                      'Claimed app/full-contract fingerprint and omitted-field count are retained claims, not authenticated provenance or full-contract validation. '
                      'Exact included JSON values only; no hidden defaults, source edits, import or recovery authorization.')}
