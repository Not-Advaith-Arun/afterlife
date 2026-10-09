"""Conservative, non-executing inventory of behavior outside an extracted model.

This is a conversion boundary report, not a Python program verifier. Every
non-docstring application statement is outside the current adapter's scope.
Specific findings explain what needs review; a clean inventory never proves
whole-application equivalence or discovers dependencies in unlisted files.
"""

import ast
import hashlib
from pathlib import Path

from .compiler import CAPABILITIES, CompileError
from .source import MAX_SOURCE_BYTES, extract_python_model


def _finding(path, node, code, detail):
    return {"source": str(path), "line": getattr(node, "lineno", 1),
            "code": code, "status": "unsupported", "detail": detail}


def audit_python_application(model_path, application_paths=()):
    """Report supported extraction and all explicitly supplied application files.

    Sources are parsed, never imported. Imports are recorded but not followed.
    Finding order is deterministic, with locations and source hashes for review.
    """
    model_path = Path(model_path)
    application_paths = [Path(path) for path in application_paths]
    if len(application_paths) > 64:
        raise CompileError("A capability audit accepts at most 64 application files")
    paths = [model_path] + application_paths
    if len({path.resolve() for path in paths}) != len(paths):
        raise CompileError("Audit source paths must be distinct")
    report = {
        "format": "afterlife-capability-report/v1",
        "source_executed": False,
        "whole_application_equivalence": "not-established",
        "supported_capabilities": sorted(CAPABILITIES),
        "scope": "Only the named files were inspected. Imports and other files were not followed. Application statements are not converted.",
        "files": [], "findings": [],
    }
    for index, path in enumerate(paths):
        with path.open("rb") as stream:
            raw = stream.read(MAX_SOURCE_BYTES + 1)
        if len(raw) > MAX_SOURCE_BYTES:
            raise CompileError(f"{path}: source exceeds {MAX_SOURCE_BYTES} bytes")
        report["files"].append({"source": str(path), "sha256": hashlib.sha256(raw).hexdigest(),
                                "role": "model" if index == 0 else "application"})
        if index == 0:
            try:
                spec, evidence = extract_python_model(path)
                # Record the same bytes that extraction actually used.
                if evidence["source_sha256"] != report["files"][-1]["sha256"]:
                    raise CompileError("Model changed while being inspected; retry with a stable source file")
                report["model"] = {"status": "supported", "name": evidence["model"],
                                   "app_id": spec["app_id"], "profile": evidence["profile"]}
            except CompileError as error:
                report["model"] = {"status": "unsupported"}
                report["findings"].append(_finding(path, None, "unsupported-model", str(error)))
            continue
        try:
            tree = ast.parse(raw.decode("utf-8"), filename=str(path))
        except (SyntaxError, UnicodeDecodeError, ValueError, RecursionError) as error:
            report["findings"].append(_finding(path, None, "unreadable-python", str(error)))
            continue
        body = tree.body
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
            body = body[1:]
        for node in body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                code, detail = "dependency", "Imported behavior is not converted or recursively analyzed."
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                code, detail = "application-function", f"Function {node.name!r}, including its rules and decorators, is not converted."
            elif isinstance(node, ast.ClassDef):
                code, detail = "application-class", f"Class {node.name!r} outside the extracted model is not converted."
            else:
                code, detail = "application-statement", f"{type(node).__name__} statement outside the extracted model is not converted."
            report["findings"].append(_finding(path, node, code, detail))
            # Keep nested business rules and effects visible, without pretending
            # to determine what a call does through aliases or dynamic dispatch.
            for nested in ast.walk(node):
                if isinstance(nested, (ast.If, ast.Assert, ast.Raise)):
                    report["findings"].append(_finding(path, nested, "business-rule-or-control-flow",
                        f"{type(nested).__name__} behavior has no equivalent in the generated record editor."))
                elif isinstance(nested, ast.Call):
                    report["findings"].append(_finding(path, nested, "call-or-side-effect",
                        "This call is not executed, converted, or proven free of side effects."))
    report["conversion_status"] = "unsupported-application" if report["findings"] else "model-only"
    report["findings"].sort(key=lambda item: (paths.index(Path(item["source"])), item["line"], item["code"]))
    return report
