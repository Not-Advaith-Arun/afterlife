"""Fail-closed extraction of a flat Python dataclass model, without importing it.

This extracts a record model, not arbitrary application behavior. The caller must
check that its source application follows the documented flat-records/v1 profile.
"""

from __future__ import annotations

import ast
import hashlib
from pathlib import Path
import re

from .compiler import CompileError, read_file, validate_spec

MAX_SOURCE_BYTES = 128 * 1024
PROFILE = "afterlife-flat-records/v1"


def _fail(node, message):
    raise CompileError(f"Python source line {getattr(node, 'lineno', 1)}: {message}")


def _body_without_docstring(body):
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        return body[1:]
    return body


def _kind(annotation):
    if isinstance(annotation, ast.Name) and annotation.id in {"str", "bool", "int"}:
        return {"str": "text", "bool": "boolean", "int": "integer"}[annotation.id], False
    if (isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr)
            and isinstance(annotation.left, ast.Name) and annotation.left.id == "int"
            and isinstance(annotation.right, ast.Constant) and annotation.right.value is None):
        return "integer", True
    _fail(annotation, "supported annotations are str, bool, int, and int | None; no inferred or computed types")


def _literal(node):
    if isinstance(node, ast.Constant) and (node.value is None or type(node.value) in {str, bool, int}):
        return node.value
    if (isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd))
            and isinstance(node.operand, ast.Constant) and type(node.operand.value) is int):
        return -node.operand.value if isinstance(node.op, ast.USub) else node.operand.value
    _fail(node, "defaults must be literal text, boolean, integer, or None; calls and expressions are unsupported")


def extract_python_model(path, *, app_id=None, title=None, record_label=None):
    """Return (validated app specification, extraction evidence), never execute source.

    Only one plain @dataclass with id: str first and literal-default primitive
    fields is supported. Every other statement, import, decorator and method is
    rejected. This deliberately does not scan or claim to preserve other files.
    """
    path = Path(path)
    raw = read_file(path, MAX_SOURCE_BYTES)
    try:
        tree = ast.parse(raw.decode("utf-8"), filename=str(path))
    except (SyntaxError, UnicodeDecodeError, ValueError, RecursionError) as error:
        raise CompileError(f"Invalid Python model: {error}") from error
    model = None
    seen_import = False
    seen_future = False
    for node in _body_without_docstring(tree.body):
        if isinstance(node, ast.ImportFrom) and not node.level:
            names = [(item.name, item.asname) for item in node.names]
            if node.module == "__future__" and names == [("annotations", None)] and not seen_future and not seen_import and model is None:
                seen_future = True
                continue
            if node.module == "dataclasses" and names == [("dataclass", None)] and not seen_import and model is None:
                seen_import = True
                continue
            _fail(node, "only 'from dataclasses import dataclass' and optional future annotations are supported")
        if isinstance(node, ast.ClassDef) and model is None and seen_import:
            model = node
            continue
        _fail(node, "model module must contain only one dataclass; executable statements and extra definitions are unsupported")
    if model is None:
        raise CompileError("Python model must declare one @dataclass after importing dataclass")
    if model.name in {"str", "int", "bool", "dataclass"}:
        _fail(model, "model name cannot shadow a supported type or dataclass")
    if (model.bases or model.keywords or getattr(model, "type_params", [])
            or len(model.decorator_list) != 1 or not isinstance(model.decorator_list[0], ast.Name)
            or model.decorator_list[0].id != "dataclass"):
        _fail(model, "only plain @dataclass is supported; no inheritance, decorator arguments, or generics")
    body = _body_without_docstring(model.body)
    fields, evidence_fields = [], []
    names = set()
    for index, node in enumerate(body):
        if not isinstance(node, ast.AnnAssign) or not isinstance(node.target, ast.Name) or not node.simple:
            _fail(node, "only annotated fields are supported; methods, validators, properties, and executable statements cannot be preserved")
        name = node.target.id
        if name in {"str", "int", "bool", "dataclass"}:
            _fail(node, "field name cannot shadow a supported type or dataclass")
        if name in names:
            _fail(node, f"duplicate field {name!r}")
        names.add(name)
        kind, nullable = _kind(node.annotation)
        if index == 0:
            if name != "id" or kind != "text" or node.value is not None:
                _fail(node, "first field must be exactly id: str without a default")
            evidence_fields.append({"name": name, "line": node.lineno, "type": "id", "default": "caller-supplied"})
            continue
        if node.value is None:
            _fail(node, f"field {name!r} needs an explicit literal default; required constructor arguments are unsupported")
        # Python strings can contain line breaks; single-line HTML inputs erase
        # them even when the user only opens and saves an unrelated field.
        field = {"name": name, "label": name.replace("_", " ").capitalize(),
                 "type": "multiline" if kind == "text" else kind,
                 "default": _literal(node.value)}
        if kind == "integer" and not nullable:
            field["required"] = True
        fields.append(field)
        evidence_fields.append({"name": name, "line": node.lineno, "type": ast.unparse(node.annotation),
                                "default": field["default"]})
    if not body:
        _fail(model, "model needs id: str and at least one record field")
    name = re.sub(r"(?<!^)(?=[A-Z])", "-", model.name).lower()
    spec = {"format": "afterlife/v1", "app_id": name if app_id is None else app_id,
            "title": model.name + " records" if title is None else title,
            "record_label": name if record_label is None else record_label,
            "required_capabilities": ["crud", "search", "json-import-export", "local-persistence"],
            "fields": fields}
    validate_spec(spec)
    evidence = {"format": "afterlife-extraction/v1", "adapter": "python-dataclass/v1", "profile": PROFILE,
                "source_name": path.name, "source_sha256": hashlib.sha256(raw).hexdigest(),
                "model": model.name, "model_line": model.lineno, "fields": evidence_fields,
                "source_executed": False,
                "scope": "Only this model module was analyzed; application routes, side effects, and other files were not analyzed.",
                "assumptions": ["Source application enforces the documented flat-records/v1 validation and mutation profile.",
                                "No additional validation, authorization, side effects, relationships, or computed behavior."]}
    return spec, evidence
