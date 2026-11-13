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


def propose_selected_export(spec, current, incoming, guard, record_ids):
    """Build a separate proposal for chosen existing edits, never merge into current inputs."""
    report = review_export(spec, current, incoming)
    if _canonical(guard) != _canonical(report):
        raise CompileError("Stale or modified backup review; compare both complete backups again before proposing changes")
    selected = set(record_ids)
    changed = {row["id"] for row in report["changed"]}
    if not 1 <= len(record_ids) <= 1000 or len(selected) != len(record_ids) or not selected <= changed:
        raise CompileError("Select 1..1000 distinct existing changed record IDs; additions, removals, unchanged and unknown IDs cannot be proposed")
    before, after = backup_records(spec, current), backup_records(spec, incoming)
    incoming_by_id = {row["id"]: row for row in after}
    # Retain current order, unchosen rows and omitted incoming records. Selection never adds/deletes.
    records = [incoming_by_id[row["id"]] if row["id"] in selected else row for row in before]
    proposal = {key: current[key] for key in ("format", "app_id", "spec_fingerprint")}
    proposal["records"] = records
    proposal["records"] = backup_records(spec, proposal)
    if len(_canonical(proposal).encode("utf-8")) + 1 > MAX_BYTES:
        raise CompileError("Normalized proposed backup exceeds 10 MiB")
    return proposal, {"format": "afterlife-selected-export-proposal/v1", "app_id": report["app_id"],
                      "spec_fingerprint": report["spec_fingerprint"],
                      "current_records_sha256": report["current_records_sha256"],
                      "incoming_records_sha256": report["incoming_records_sha256"],
                      "proposed_records_sha256": _hash(_canonical(proposal["records"])),
                      "selected_existing_records": len(selected), "retained_current_records": len(before) - len(selected),
                      "scope": "Complete backups and the exact full review validated. Only selected existing changed rows are replaced in a separate private backup; current order and unselected records stay. No additions, deletions, input mutation, browser save or HTML rebuild. Proposal output contains record values; this receipt omits IDs/field names/values. Hashes and app identity may be sensitive. Separately review the proposal against current before guarded from-export. No authentication, lock on later inputs or merge conflict resolution."}
