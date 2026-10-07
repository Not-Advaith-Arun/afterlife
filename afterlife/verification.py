"""Read-only byte identity checks against an explicitly supplied manifest."""
import hashlib
import re

from .compiler import CompileError, load_json, read_file


def verify_artifact(artifact, manifest_path):
    manifest = load_json(manifest_path)
    if not isinstance(manifest, dict) or manifest.get("format") != "afterlife-manifest/v1":
        raise CompileError("Expected an afterlife-manifest/v1 manifest")
    expected = manifest.get("artifact_sha256")
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise CompileError("Manifest artifact_sha256 must be a lowercase SHA-256 digest")
    raw = read_file(artifact, 32 * 1024 * 1024)
    actual = hashlib.sha256(raw).hexdigest()
    return {"format":"afterlife-artifact-verification/v1", "matched":actual == expected,
            "artifact_bytes":len(raw), "actual_sha256":actual, "expected_sha256":expected,
            "scope":"Byte identity against the supplied manifest only. HTML is never executed or modified. A matching hash does not establish authenticity, security, offline behavior, or correctness of other manifest claims; changing both files can still produce a match."}


def verify_build(spec_path, data_path, artifact):
    """Compare retained bytes with this installed compiler and supplied inputs."""
    from .compiler import compile_app
    document, manifest = compile_app(load_json(spec_path), load_json(data_path))
    expected = document.encode("utf-8")
    raw = read_file(artifact, 32 * 1024 * 1024)
    return {"format": "afterlife-build-verification/v1", "matched": raw == expected,
            "actual_sha256": hashlib.sha256(raw).hexdigest(), "expected_sha256": manifest["artifact_sha256"],
            "artifact_bytes": len(raw), "expected_bytes": len(expected),
            "spec_fingerprint": manifest["spec_fingerprint"], "source_fingerprint": manifest["source_fingerprint"],
            "scope": "Exact byte reproducibility using supplied declarative spec/data and this installed compiler/runtime. No manifest trust, HTML execution, output writes or network access. Mismatch can reflect different inputs, compiler/runtime versions or a browser-downloaded snapshot; it does not by itself establish tampering. Match does not establish authenticity, security or source-application equivalence."}


def verify_python_build(model, data_path, artifact, *, manifest_path=None, app_id=None, title=None, record_label=None):
    """Rebuild from a non-executed model, checking extraction metadata when supplied."""
    from .compiler import _canonical, compile_app
    from .source import extract_python_model
    spec, evidence = extract_python_model(model, app_id=app_id, title=title, record_label=record_label)
    document, expected_manifest = compile_app(spec, load_json(data_path))
    expected_manifest["extraction"] = evidence
    expected_manifest["limitations"][0] = "One dataclass record model under flat-records/v1; source application behavior is not statically verified"
    raw = read_file(artifact, 32 * 1024 * 1024)
    artifact_matched = raw == document.encode("utf-8")
    manifest_matched = None
    if manifest_path is not None:
        manifest = load_json(manifest_path)
        if not isinstance(manifest, dict) or manifest.get("format") != "afterlife-manifest/v1":
            raise CompileError("Expected an afterlife-manifest/v1 manifest")
        manifest_matched = _canonical(manifest) == _canonical(expected_manifest)
    return {"format": "afterlife-python-build-verification/v1",
            "matched": artifact_matched and manifest_matched is not False,
            "artifact_matched": artifact_matched, "manifest_matched": manifest_matched,
            "actual_sha256": hashlib.sha256(raw).hexdigest(), "expected_sha256": expected_manifest["artifact_sha256"],
            "source_sha256": evidence["source_sha256"], "source_executed": False,
            "spec_fingerprint": expected_manifest["spec_fingerprint"],
            "source_fingerprint": expected_manifest["source_fingerprint"],
            "scope": "Read-only exact rebuild using the supplied supported Python model, records, explicit naming overrides and installed compiler/runtime. Model and HTML are never executed. "
                     "Optional manifest comparison binds complete current extraction evidence including supplied source bytes/name, not historical authenticity. "
                     "Without a manifest, source comments or equivalent annotation spellings can change without changing HTML. "
                     "Mismatch can reflect inputs, naming, compiler/runtime versions or a browser-downloaded snapshot; it does not establish tampering. "
                     "No writes, network, source-application equivalence, security or offline-runtime guarantee. Report omits source text and record values."}
