"""Afterlife: compile supported record apps into offline HTML."""

from .compiler import CompileError, compile_app, load_json, validate_records, validate_spec

__all__ = ["CompileError", "compile_app", "load_json", "validate_records", "validate_spec"]
__version__ = "0.1.0"
