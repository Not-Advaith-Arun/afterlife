"""Validate and compare explicit backups without exposing record values."""

from .compiler import CompileError, MAX_BYTES, _canonical, _hash, _normalized_records, safe_script_json, validate_spec


def backup_records(spec, envelope):
    spec = validate_spec(spec)
    if (not isinstance(envelope, dict) or set(envelope) != {"format", "app_id", "spec_fingerprint", "records"}
            or envelope["format"] != "afterlife-data/v1" or envelope["app_id"] != spec["app_id"]
            or envelope["spec_fingerprint"] != _hash(_canonical(spec))):
        raise CompileError("JSON export must match this exact app specification")
    records, size = [], 2
    for row in _normalized_records(spec, envelope["records"]):
        size += len(safe_script_json(row).encode("utf-8")) + bool(records)
        if size > MAX_BYTES:
            raise CompileError("Normalized backup data exceeds 10 MiB")
        records.append(row)
    return records


def review_export(spec, current, incoming):
    before, after = backup_records(spec, current), backup_records(spec, incoming)
    old, new = ({row["id"]: row for row in records} for records in (before, after))
    changed = [{"id": key, "fields": sorted(name for name in old[key] if old[key][name] != new[key][name])}
               for key in sorted(old.keys() & new.keys()) if old[key] != new[key]]
    added, removed = sorted(new.keys() - old.keys()), sorted(old.keys() - new.keys())
    return {"format": "afterlife-export-review/v1", "app_id": spec["app_id"],
            "spec_fingerprint": incoming["spec_fingerprint"],
            "current_records_sha256": _hash(_canonical(before)), "incoming_records_sha256": _hash(_canonical(after)),
            "added": added, "removed": removed, "changed": changed,
            "counts": {"current": len(before), "incoming": len(after), "added": len(added),
                       "removed": len(removed), "changed": len(changed),
                       "unchanged": len(old.keys() & new.keys()) - len(changed)},
            "scope": "Read-only normalized backup comparison. IDs and changed field names only; record values excluded. "
                     "Order-only differences are not record edits. Snapshot hashes bind exact normalized array order. "
                     "No restoration, generated HTML or lock on a later rebuild; inspect stable backups before from-export."}


def review_summary(report):
    """Compact triage view; deliberately not a guarded-restore review document."""
    return {"format": "afterlife-export-review-summary/v1",
            **{key:report[key] for key in ("app_id","spec_fingerprint","current_records_sha256","incoming_records_sha256","counts")},
            "identical_normalized_records": report["current_records_sha256"] == report["incoming_records_sha256"],
            "scope": "Full normalized comparison performed; compact counts and snapshot hashes only. Record IDs, changed field names and values omitted; app ID and hashes may still be sensitive. Array order affects identity. This summary is not a from-export --review guard: use --output to retain the complete review for restoration. No authenticity or later-source lock established."}


def select_review_changes(report, record_ids):
    """Inspect a chosen change set while retaining whole-backup identity."""
    selected = set(record_ids)
    changed = {row["id"] for row in report["changed"]}
    known = set(report["added"]) | set(report["removed"]) | changed
    if not 1 <= len(record_ids) <= 1000 or len(selected) != len(record_ids) or not selected <= known:
        raise CompileError("Select 1..1000 distinct record IDs with an added, removed or changed entry in this comparison")
    added = [key for key in report["added"] if key in selected]
    removed = [key for key in report["removed"] if key in selected]
    edits = [row for row in report["changed"] if row["id"] in selected]
    return {"format":"afterlife-export-review-selection/v1",
            **{key:report[key] for key in ("app_id","spec_fingerprint","current_records_sha256","incoming_records_sha256","counts")},
            "selected_record_ids":sorted(selected), "added":added, "removed":removed, "changed":edits,
            "selected_counts":{"added":len(added),"removed":len(removed),"changed":len(edits)},
            "omitted_change_records":len(known)-len(selected),
            "scope":"Selected change entries only; unchanged or unknown IDs cannot be selected. Counts and snapshot hashes still cover both complete normalized backups. Record values excluded. Full comparison cost remains. This selection is not a from-export --review guard; use --output to save the complete restoration review."}
