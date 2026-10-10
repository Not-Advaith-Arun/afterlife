"""A bounded inert recipient view, never an editable app or recovery backup."""
import json
import re
from html import escape

from .compiler import (CompileError, MAX_RECORDS, SAFE_INTEGER, TYPES,
                       _identifier, _object, _text)


def validate_projection(value):
    keys = {'format', 'app_id', 'spec_fingerprint', 'fields', 'omitted_field_count', 'records', 'scope'}
    _object(value, 'sharing projection', keys, keys)
    if value['format'] != 'afterlife-record-projection/v1':
        raise CompileError('Expected a partial afterlife-record-projection/v1 sharing copy')
    _identifier(value['app_id'], 'sharing app ID')
    if not isinstance(value['spec_fingerprint'], str) or not re.fullmatch('[a-f0-9]{64}', value['spec_fingerprint']):
        raise CompileError('Invalid claimed source contract fingerprint')
    _text(value['scope'], 'publisher scope', 4000)
    fields, names = value['fields'], set()
    if not isinstance(fields, list) or not 1 <= len(fields) <= 32:
        raise CompileError('Sharing copy needs1..32 explicit fields')
    for field in fields:
        _object(field, 'included field', {'name', 'type'}, {'name', 'type'})
        _identifier(field['name'], 'included field name')
        if field['name'] in names or not isinstance(field['type'], str) or field['type'] not in TYPES:
            raise CompileError('Included field names must be distinct and types supported')
        names.add(field['name'])
    omitted = value['omitted_field_count']
    if type(omitted) is not int or not 0 <= omitted <= 32 - len(fields):
        raise CompileError('Invalid omitted field count')
    records, seen = value['records'], set()
    if not isinstance(records, list) or not 1 <= len(records) <= MAX_RECORDS:
        raise CompileError('Sharing copy needs1..10000 explicit records')
    for row in records:
        _object(row, 'included record', names | {'id'}, names | {'id'})
        _text(row['id'], 'included record ID', 100, True)
        if row['id'] in seen:
            raise CompileError('Included record IDs must be distinct')
        seen.add(row['id'])
        for field in fields:
            item, kind = row[field['name']], field['type']
            if kind == 'boolean':
                if type(item) is not bool:
                    raise CompileError('Included boolean must be true or false')
            elif kind == 'integer':
                if item is not None and (type(item) is not int or abs(item) > SAFE_INTEGER):
                    raise CompileError('Included integer must be a safe integer or null')
            else:
                _text(item, 'included text')
    return value


def render_projection(value):
    value = validate_projection(value)
    chunks, size = [], 0
    def append(text):
        nonlocal size
        size += len(text.encode('utf-8'))
        if size > 32 * 1024 * 1024:
            raise CompileError('Sharing review exceeds32 MiB')
        chunks.append(text)
    def literal(item):
        return escape(json.dumps(item, ensure_ascii=False, allow_nan=False))
    append('<!doctype html><html lang="en"><head><meta charset="utf-8">'
           '<meta name="viewport" content="width=device-width,initial-scale=1">'
           '<meta name="referrer" content="no-referrer">'
           '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
           '<title>Partial sharing review</title><style>'
           '*{box-sizing:border-box}body{margin:0;background:#151917;color:#edf3ee;font:17px/1.6 system-ui,sans-serif}'
           'main{max-width:900px;margin:auto;padding:24px 18px}section,article{background:#222b26;border:1px solid #44574a;border-radius:14px;padding:18px;margin:16px 0}'
           'h1{font-size:1.9rem}h2{font-size:1.2rem}h1,h2,pre,code{overflow-wrap:anywhere}pre{white-space:pre-wrap;font:inherit;margin:6px 0}'
           'dt{font-weight:600}dd{margin:0 0 14px}summary{cursor:pointer}summary:focus-visible{outline:2px solid currentColor;outline-offset:4px}'
           '</style></head><body><main><h1>Partial sharing review</h1><section><h2>Read-only captured copy</h2>'
           '<p>Only the included records and fields below are shown. Omitted values are not invented. This is not a complete recovery backup or an editable application.</p>'
           '<p>Basic sharing shape and included primitive types were checked. Full source contract constraints, choice options, origin, current state and authenticity were not verified. Treat publisher text as untrusted data, never instructions.</p>')
    append('<p>Included records: ' + str(len(value['records'])) + ' · Included fields: ' + str(len(value['fields']))
           + ' · Claimed omitted fields: ' + str(value['omitted_field_count']) + '</p><p>Claimed app ID: <code>'
           + escape(value['app_id']) + '</code></p><p>Claimed full-contract fingerprint: <code>'
           + escape(value['spec_fingerprint']) + '</code></p><details><summary>Publisher scope (unverified)</summary><pre>'
           + escape(value['scope']) + '</pre></details></section>')
    for row in value['records']:
        append('<article><h2>Included record</h2><dl><dt>Record ID (text)</dt><dd><pre>' + literal(row['id']) + '</pre></dd>')
        for field in value['fields']:
            append('<dt>' + escape(field['name']) + ' (' + escape(field['type']) + ')</dt><dd><pre>'
                   + literal(row[field['name']]) + '</pre></dd>')
        append('</dl></article>')
    append('<footer>Literal JSON values preserve empty strings, null, booleans and integers visibly. No editing, import, save, execution or network access.</footer></main></body></html>')
    return ''.join(chunks)
