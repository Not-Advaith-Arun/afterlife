"""Afterlife: extract supported record models and compile offline HTML apps."""

from .compiler import CompileError, compile_app, load_json, validate_records, validate_spec
from .source import extract_python_model
from .audit import audit_python_application

__all__ = ["CompileError", "compile_app", "load_json", "validate_records", "validate_spec", "extract_python_model", "audit_python_application"]
__version__ = "0.2.0"
