"""Read-only three-way comparison of explicit matching record backups."""
from .compiler import CompileError, MAX_BYTES, _canonical, _hash
from .transfers import backup_records


def review_three_way(spec, base, current, incoming):
    snapshots = [backup_records(spec, item) for item in (base, current, incoming)]
    old, local, remote = [{row["id"]: row for row in rows} for rows in snapshots]
    groups = {key: [] for key in ("current_only", "incoming_only", "converged", "compatible_edits", "conflicts")}
    unchanged = 0

    def fields(before, after):
        return sorted(key for key in (before or after) if key != "id"
                      and (before is None or after is None or before[key] != after[key]))

    def change(before, after):
        return {"action": "added" if before is None else "removed" if after is None else "edited",
                "fields": fields(before, after)}

    for key in sorted(old.keys() | local.keys() | remote.keys()):
        original, ours, theirs = old.get(key), local.get(key), remote.get(key)
        if original == ours == theirs:
            unchanged += 1
        elif ours == theirs:
            groups["converged"].append({"id": key, **change(original, ours)})
        elif ours == original:
            groups["incoming_only"].append({"id": key, **change(original, theirs)})
        elif theirs == original:
            groups["current_only"].append({"id": key, **change(original, ours)})
        elif original is None:
            groups["conflicts"].append({"id": key, "kind": "different_additions", "fields": fields(ours, theirs)})
        elif ours is None or theirs is None:
            groups["conflicts"].append({"id": key, "kind": "deletion_vs_edit", "fields": fields(original, ours or theirs)})
        else:
            local_fields, remote_fields = fields(original, ours), fields(original, theirs)
            conflicting = sorted(name for name in set(local_fields) & set(remote_fields) if ours[name] != theirs[name])
            entry = {"id": key, "current_fields": local_fields, "incoming_fields": remote_fields}
            if conflicting:
                groups["conflicts"].append({**entry, "kind": "overlapping_edits", "fields": conflicting})
            else:
                groups["compatible_edits"].append(entry)

    return {"format": "afterlife-three-way-review/v1", "app_id": base["app_id"],
            "spec_fingerprint": base["spec_fingerprint"],
            **{name + "_records_sha256": _hash(_canonical(rows))
               for name, rows in zip(("base", "current", "incoming"), snapshots)},
            "counts": {"base": len(old), "current": len(local), "incoming": len(remote),
                       "unchanged": unchanged, **{name: len(rows) for name, rows in groups.items()}},
            "order_only_changes": {"current": old == local and snapshots[0] != snapshots[1],
                                   "incoming": old == remote and snapshots[0] != snapshots[2]},
            **groups,
            "scope": "All three complete matching backups validated; supplied base identity is not historical authentication. "
                     "Record IDs and changed field names only; record values omitted. Fields are compared by exact normalized equality, not semantic intent. "
                     "Compatible edits means no divergent overlapping field values; it does not resolve record ordering, deletions, application invariants or merge safety. "
                     "No merging, restoration, browser writes or input mutation. This complete report can guard propose-three-way, but is not a review-export/from-export/propose-export guard. "
                     "Snapshot hashes bind normalized array order; no lock on later inputs. IDs, field names, app identity and hashes may be sensitive."}


def three_way_summary(report):
    return {"format": "afterlife-three-way-summary/v1",
            **{key: report[key] for key in ("app_id", "spec_fingerprint", "base_records_sha256",
                                           "current_records_sha256", "incoming_records_sha256", "counts", "order_only_changes")},
            "scope": "Complete three-way comparison performed. IDs, field names and values omitted; app identity and hashes may be sensitive. "
                     "No merge, restoration or later-input lock; this summary is not a restore/proposal guard. Zero conflicts does not establish order or application merge safety."}


def propose_three_way(spec, base, current, incoming, guard, record_ids):
    report = review_three_way(spec, base, current, incoming)
    if _canonical(guard) != _canonical(report):
        raise CompileError("Stale or modified three-way review; compare all three complete backups again")
    selected = set(record_ids)
    if not 1 <= len(record_ids) <= 1000 or len(selected) != len(record_ids):
        raise CompileError("Choose 1..1000 distinct existing records with nonconflicting incoming edits")
    snapshots = [backup_records(spec, item) for item in (base, current, incoming)]
    old, local, remote = [{row["id"]: row for row in rows} for rows in snapshots]
    conflicts = {entry["id"] for entry in report["conflicts"]}
    if not selected <= old.keys() & local.keys() & remote.keys() or selected & conflicts:
        raise CompileError("Selected records must exist in all three backups and have no reported conflict; additions/deletions refuse")
    replacements = {}
    for key in selected:
        incoming_fields = [name for name in old[key] if name != "id" and old[key][name] != remote[key][name]]
        row = {**local[key], **{name: remote[key][name] for name in incoming_fields}}
        if row == local[key]:
            raise CompileError("Every selected record must have an incoming edit that changes current values")
        replacements[key] = row
    proposal = {key: current[key] for key in ("format", "app_id", "spec_fingerprint")}
    proposal["records"] = [replacements.get(row["id"], row) for row in snapshots[1]]
    proposal["records"] = backup_records(spec, proposal)
    if len(_canonical(proposal).encode("utf-8")) + 1 > MAX_BYTES:
        raise CompileError("Normalized proposed backup exceeds 10 MiB")
    return proposal, {"format": "afterlife-three-way-proposal/v1", "app_id": report["app_id"],
                      "spec_fingerprint": report["spec_fingerprint"],
                      **{name + "_records_sha256": report[name + "_records_sha256"] for name in ("base", "current", "incoming")},
                      "proposed_records_sha256": _hash(_canonical(proposal["records"])),
                      "selected_existing_records": len(selected), "unselected_conflict_records": len(conflicts),
                      "scope": "Exact complete three-way review validated. Only selected nonconflicting incoming field edits are proposed; other current fields, current order and unselected records stay. "
                               "No additions/deletions/conflict resolution/input mutation. Private output contains values; receipt omits IDs/field names/values. "
                               "Supplied base is not authenticated; exact field compatibility does not prove application intent. Separately review the proposal against current before guarded from-export. No later-input lock."}
