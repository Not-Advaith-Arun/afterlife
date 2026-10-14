"""Strict, deterministic compilation. No source execution and no network access."""

from __future__ import annotations

import base64
import hashlib
import html
import json
import os
from pathlib import Path
import re
import stat

MAX_BYTES = 10 * 1024 * 1024
MAX_RECORDS = 10_000
MAX_TEXT = 10_000
SAFE_INTEGER = 9_007_199_254_740_991
IDENTIFIER = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")
RESERVED = {"id", "__proto__", "prototype", "constructor"}
CAPABILITIES = {"crud", "search", "json-import-export", "local-persistence"}
TYPES = {"text", "multiline", "select", "boolean", "integer"}


class CompileError(ValueError):
    """A source requests unsupported behavior or contains invalid data."""


def _object(value, context, allowed, required=()):
    if not isinstance(value, dict):
        raise CompileError(f"{context} must be an object")
    extra, missing = set(value) - set(allowed), set(required) - set(value)
    if extra:
        raise CompileError(f"{context}: unsupported keys: {', '.join(sorted(extra))}")
    if missing:
        raise CompileError(f"{context}: missing keys: {', '.join(sorted(missing))}")


def _text(value, context, maximum=MAX_TEXT, nonempty=False):
    if not isinstance(value, str) or len(value) > maximum:
        raise CompileError(f"{context} must be text of at most {maximum} characters")
    if nonempty and not value.strip():
        raise CompileError(f"{context} cannot be empty")
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise CompileError(f"{context} contains an invalid Unicode surrogate")


def _identifier(value, context):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value) or value in RESERVED:
        raise CompileError(f"{context} must be a non-reserved lowercase identifier (1–64 characters)")


def validate_spec(spec):
    """Validate a v1 presentation contract, never a database definition."""
    _object(spec, "app", {"format", "app_id", "title", "description", "record_label", "fields", "required_capabilities"},
            {"format", "app_id", "title", "fields"})
    if spec["format"] != "afterlife/v1":
        raise CompileError("app.format must be afterlife/v1")
    _identifier(spec["app_id"], "app.app_id")
    _text(spec["title"], "app.title", 120, True)
    _text(spec.get("description", ""), "app.description", 1000)
    _text(spec.get("record_label", "record"), "app.record_label", 40, True)
    capabilities = spec.get("required_capabilities", [])
    if not isinstance(capabilities, list) or any(not isinstance(item, str) for item in capabilities):
        raise CompileError("app.required_capabilities must be an array of strings")
    unsupported = set(capabilities) - CAPABILITIES
    if unsupported:
        raise CompileError("Cannot preserve required capabilities: " + ", ".join(sorted(unsupported)) +
                           ". This compiler supports local records only; no server behavior is silently removed.")
    fields = spec["fields"]
    if not isinstance(fields, list) or not 1 <= len(fields) <= 32:
        raise CompileError("app.fields must contain 1–32 fields")
    names = set()
    for index, field in enumerate(fields):
        context = f"app.fields[{index}]"
        _object(field, context, {"name", "label", "type", "required", "options", "default"}, {"name", "label", "type"})
        _identifier(field["name"], f"{context}.name")
        if field["name"] in names:
            raise CompileError(f"Duplicate field: {field['name']}")
        names.add(field["name"])
        _text(field["label"], f"{context}.label", 100, True)
        if not isinstance(field["type"], str) or field["type"] not in TYPES:
            raise CompileError(f"{context}.type must be one of {', '.join(sorted(TYPES))}")
        if "required" in field and not isinstance(field["required"], bool):
            raise CompileError(f"{context}.required must be boolean")
        if field["type"] == "boolean" and field.get("required"):
            raise CompileError(f"{context}: boolean fields always have a value; omit required")
        if field["type"] == "select":
            options = field.get("options")
            if not isinstance(options, list) or not 1 <= len(options) <= 100:
                raise CompileError(f"{context}.options must contain 1–100 choices")
            for option in options:
                _text(option, f"{context}.options", 200, True)
            if len(set(options)) != len(options):
                raise CompileError(f"{context}.options contains duplicates")
        elif "options" in field:
            raise CompileError(f"{context}.options is only supported on select fields")
        if "default" in field:
            _validate_value(field, field["default"], f"{context}.default")
    return spec


def _default(field):
    return field.get("default", False if field["type"] == "boolean" else None if field["type"] == "integer" else "")


def _validate_value(field, value, context):
    kind = field["type"]
    if kind == "boolean":
        if not isinstance(value, bool):
            raise CompileError(f"{context} must be boolean")
    elif kind == "integer":
        if value is not None:
            if type(value) not in {int, float} or abs(value) > SAFE_INTEGER or (type(value) is float and not value.is_integer()):
                raise CompileError(f"{context} must be a JavaScript-safe integer or null")
            value = int(value)
        if field.get("required") and value is None:
            raise CompileError(f"{context} is required")
    else:
        _text(value, context)
        if field.get("required") and not value.strip():
            raise CompileError(f"{context} is required")
        if kind == "select" and value != "" and value not in field["options"]:
            raise CompileError(f"{context} is not an allowed choice")
    return value


def _normalized_records(spec, records):
    """Yield validated records so compilation can stop at its byte budget."""
    if not isinstance(records, list) or len(records) > MAX_RECORDS:
        raise CompileError(f"records must be an array of at most {MAX_RECORDS} records")
    fields = spec["fields"]
    names = {field["name"] for field in fields}
    seen = set()
    for index, record in enumerate(records):
        context = f"records[{index}]"
        _object(record, context, names | {"id"}, {"id"})
        _text(record["id"], f"{context}.id", 100, True)
        if record["id"] in seen:
            raise CompileError(f"Duplicate record id: {record['id']}")
        seen.add(record["id"])
        normalized = {"id": record["id"]}
        for field in fields:
            name = field["name"]
            value = record.get(name, _default(field))
            normalized[name] = _validate_value(field, value, f"{context}.{name}")
        yield normalized


def validate_records(spec, records):
    """Return complete normalized records, rejecting lossy or ambiguous inputs."""
    return list(_normalized_records(spec, records))


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise CompileError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read_file(path, maximum):
    """Bound reads to regular files; opening a FIFO must not wait for a writer."""
    path = Path(path)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise CompileError(f"{path}: input must be a regular file")
        raw = stream.read(maximum + 1)
    if len(raw) > maximum:
        raise CompileError(f"{path}: file exceeds {maximum} bytes")
    return raw


def load_json(path):
    raw = read_file(path, MAX_BYTES)
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                          parse_constant=lambda value: (_ for _ in ()).throw(CompileError(f"Invalid JSON number: {value}")))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise CompileError(f"{path}: {error}") from error


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def safe_script_json(value):
    """HTML parsers recognize closing script tags even inside JSON strings."""
    return _canonical(value).replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def compile_app(spec, data):
    """Return (HTML, manifest). The same validated input produces identical bytes."""
    validate_spec(spec)
    _object(data, "data", {"records"}, {"records"})
    spec_hash = _hash(_canonical(spec))
    # Both hashes contain exactly 64 ASCII hex characters. With empty records,
    # this has the final payload's exact fixed size, including its array brackets.
    sizing_payload = {"spec": spec, "records": [], "spec_fingerprint": spec_hash,
                      "storage_key": "afterlife:v1:" + "0" * 64}
    size = len(safe_script_json(sizing_payload).encode("utf-8"))
    if size > MAX_BYTES:
        raise CompileError("Combined application data exceeds 10 MiB")
    records = []
    for record in _normalized_records(spec, data["records"]):
        # Each record has at most 32 bounded primitive fields. Count its exact
        # HTML-safe representation before retaining it or visiting the next row.
        size += len(safe_script_json(record).encode("utf-8")) + bool(records)
        if size > MAX_BYTES:
            raise CompileError("Combined application data exceeds 10 MiB")
        records.append(record)
    source_hash = _hash(_canonical({"spec": spec, "records": records}))
    payload = {"spec": spec, "records": records, "spec_fingerprint": spec_hash,
               "storage_key": f"afterlife:v1:{source_hash}"}
    serialized = safe_script_json(payload)
    if len(serialized.encode("utf-8")) > MAX_BYTES:
        raise CompileError("Combined application data exceeds 10 MiB")
    base = Path(__file__).parent
    javascript = (base / "runtime.js").read_text(encoding="utf-8")
    css = (base / "style.css").read_text(encoding="utf-8")
    def csp_hash(text):
        return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode()).digest()).decode() + "'"
    policy = f"default-src 'none'; script-src {csp_hash(javascript)}; style-src {csp_hash(css)}; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
    document = "\n".join([
        "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        f'<meta http-equiv="Content-Security-Policy" content="{html.escape(policy, quote=True)}">',
        f"<title>{html.escape(spec['title'])} — Afterlife</title>",
        f"<style>{css}</style>", "</head>", "<body>",
        '<main id="app"></main><noscript>This offline app needs JavaScript enabled in your browser.</noscript>',
        f'<script type="application/json" id="afterlife-data">{serialized}</script>',
        f"<script>{javascript}</script>", "</body>", "</html>", "",
    ])
    manifest = {"format": "afterlife-manifest/v1", "app_id": spec["app_id"],
                "spec_fingerprint": spec_hash, "source_fingerprint": source_hash,
                "artifact_sha256": _hash(document), "record_count": len(records),
                "supported_capabilities": sorted(CAPABILITIES), "network_required": False,
                "limitations": ["Declarative v1 apps only; no arbitrary source conversion",
                                "Single user; no authentication, synchronization, or server jobs",
                                "Browser storage is best effort; export HTML or JSON for durable copies"]}
    return document, manifest
