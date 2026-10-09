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


def _literal_choices(annotation, *, literal_imported=False, typing_imported=False):
    if not isinstance(annotation, ast.Subscript):
        return None
    value = annotation.value
    recognized = (literal_imported and isinstance(value, ast.Name) and value.id == "Literal"
                  or typing_imported and isinstance(value, ast.Attribute) and value.attr == "Literal"
                  and isinstance(value.value, ast.Name) and value.value.id == "typing")
    if not recognized:
        return None
    nodes = annotation.slice.elts if isinstance(annotation.slice, ast.Tuple) else [annotation.slice]
    if not nodes or not all(isinstance(node, ast.Constant) and type(node.value) is str for node in nodes):
        _fail(annotation, "Literal choices must be explicit plain strings; no expressions, aliases, nested or non-string choices")
    return [node.value for node in nodes]


def _kind(annotation, *, optional_imported=False, typing_imported=False, literal_imported=False):
    if isinstance(annotation, ast.Name) and annotation.id in {"str", "bool", "int"}:
        return {"str": "text", "bool": "boolean", "int": "integer"}[annotation.id], False
    if _literal_choices(annotation, literal_imported=literal_imported, typing_imported=typing_imported) is not None:
        return "select", False
    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        for integer, null in ((annotation.left, annotation.right), (annotation.right, annotation.left)):
            if isinstance(integer, ast.Name) and integer.id == "int" and isinstance(null, ast.Constant) and null.value is None:
                return "integer", True
    if isinstance(annotation, ast.Subscript) and isinstance(annotation.slice, ast.Name) and annotation.slice.id == "int":
        value = annotation.value
        if (optional_imported and isinstance(value, ast.Name) and value.id == "Optional"
                or typing_imported and isinstance(value, ast.Attribute) and value.attr == "Optional"
                and isinstance(value.value, ast.Name) and value.value.id == "typing"):
            return "integer", True
    _fail(annotation, "supported annotations are str, bool, int, nullable integer spellings, and explicitly imported Literal string choices; no inferred or computed types")


def _literal(node):
    if isinstance(node, ast.Constant) and (node.value is None or type(node.value) in {str, bool, int}):
        return node.value
    if (isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd))
            and isinstance(node.operand, ast.Constant) and type(node.operand.value) is int):
        return -node.operand.value if isinstance(node.op, ast.USub) else node.operand.value
    _fail(node, "defaults must be literal text, boolean, integer, or None; calls and expressions are unsupported")


def _default(node, *, field_imported=False):
    if not (field_imported and isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "field"):
        return _literal(node)
    if node.args or len(node.keywords) != 1 or node.keywords[0].arg not in {"default", "default_factory"}:
        _fail(node, "field supports exactly one default or primitive default_factory keyword; no other behavior")
    keyword = node.keywords[0]
    if keyword.arg == "default":
        return _literal(keyword.value)
    if isinstance(keyword.value, ast.Name) and keyword.value.id in {"str", "int", "bool"}:
        return {"str": "", "int": 0, "bool": False}[keyword.value.id]
    _fail(node, "default_factory supports only bare unshadowed str, int or bool; factories are never executed")


def extract_python_model(path, *, app_id=None, title=None, record_label=None):
    """Return (validated app specification, extraction evidence), never execute source.

    Only one plain @dataclass with id: str first, literal defaults or explicitly supported field defaults, and supported
    primitive/string-choice annotations is supported. Other statements, imports, decorators and methods are
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
    seen_optional = False
    seen_typing = False
    seen_literal = False
    seen_field = False
    for node in _body_without_docstring(tree.body):
        if isinstance(node, ast.ImportFrom) and not node.level:
            names = [(item.name, item.asname) for item in node.names]
            if node.module == "__future__" and names == [("annotations", None)] and not any((seen_future, seen_import, seen_optional, seen_typing, seen_literal, seen_field)) and model is None:
                seen_future = True
                continue
            if node.module == "dataclasses" and model is None:
                imported = {name for name, alias in names if alias is None}
                if (len(imported) == len(names) and imported and imported <= {"dataclass", "field"}
                        and not (seen_import and "dataclass" in imported or seen_field and "field" in imported)):
                    seen_import = seen_import or "dataclass" in imported
                    seen_field = seen_field or "field" in imported
                    continue
            if node.module == "typing" and model is None:
                imported = {name for name, alias in names if alias is None}
                if (len(imported) == len(names) and imported and imported <= {"Optional", "Literal"}
                        and not (seen_optional and "Optional" in imported or seen_literal and "Literal" in imported)):
                    seen_optional = seen_optional or "Optional" in imported
                    seen_literal = seen_literal or "Literal" in imported
                    continue
            _fail(node, "only dataclass/field, optional future annotations, and explicit unaliased typing/Optional/Literal imports are supported")
        if (isinstance(node, ast.Import) and [(item.name, item.asname) for item in node.names] == [("typing", None)]
                and not seen_typing and model is None):
            seen_typing = True
            continue
        if isinstance(node, ast.ClassDef) and model is None and seen_import:
            model = node
            continue
        _fail(node, "model module must contain only one dataclass; executable statements and extra definitions are unsupported")
    if model is None:
        raise CompileError("Python model must declare one @dataclass after importing dataclass")
    reserved = ({"str", "int", "bool", "dataclass"} | ({"Optional"} if seen_optional else set())
                | ({"typing"} if seen_typing else set()) | ({"Literal"} if seen_literal else set()) | ({"field"} if seen_field else set()))
    if model.name in reserved:
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
        if name in reserved:
            _fail(node, "field name cannot shadow a supported type or dataclass")
        if name in names:
            _fail(node, f"duplicate field {name!r}")
        names.add(name)
        kind, nullable = _kind(node.annotation, optional_imported=seen_optional, typing_imported=seen_typing, literal_imported=seen_literal)
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
                 "default": _default(node.value, field_imported=seen_field)}
        if kind == "integer" and not nullable:
            field["required"] = True
        if kind == "select":
            field["required"] = True
            field["options"] = _literal_choices(node.annotation, literal_imported=seen_literal, typing_imported=seen_typing)
        fields.append(field)
        evidence_fields.append({"name": name, "line": node.lineno, "type": ast.unparse(node.annotation),
                                "default": field["default"],
                                **({"default_expression": ast.unparse(node.value)} if isinstance(node.value, ast.Call) else {})})
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
