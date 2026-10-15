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
