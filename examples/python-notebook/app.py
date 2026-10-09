"""Independent notebook CLI: python3 app.py [trace.json].

This application has its own validation and mutation implementation. It does not
import Afterlife or the shared engine used by the other two source fixtures.
"""

from dataclasses import asdict
import json
from pathlib import Path
import sys

from model import Note


def checked(record):
    note = Note(**record)
    for name in ("id", "title", "body"):
        value = getattr(note, name)
        if type(value) is not str or len(value) > (100 if name == "id" else 10000):
            raise ValueError("Invalid text")
        value.encode("utf-8")
    if not note.id.strip() or type(note.archived) is not bool:
        raise ValueError("Invalid ID or archived flag")
    for name in ("pages", "rating"):
        value = getattr(note, name)
        if name == "rating" and value is None:
            continue
        if type(value) not in (int, float) or not -(2**53 - 1) <= value <= 2**53 - 1 or int(value) != value:
            raise ValueError("Expected a portable integer")
        setattr(note, name, int(value))
    return asdict(note)


def apply(records, operation):
    if type(operation) is not dict:
        raise ValueError("Expected an operation object")
    action = operation.get("op")
    if action == "create" and set(operation) == {"op", "record"}:
        record = checked(operation["record"])
        if len(records) == 10000 or any(item["id"] == record["id"] for item in records):
            raise ValueError("Duplicate ID or full notebook")
        return records + [record]
    if action not in ("edit", "delete"):
        raise ValueError("Unknown operation")
    expected = {"op", "id", "changes"} if action == "edit" else {"op", "id"}
    if set(operation) != expected:
        raise ValueError("Invalid operation fields")
    if not any(item["id"] == operation["id"] for item in records):
        raise ValueError("Missing note")
    if action == "delete":
        return [item for item in records if item["id"] != operation["id"]]
    changes = operation["changes"]
    if type(changes) is not dict or "id" in changes:
        raise ValueError("Cannot replace identity")
    return [checked({**item, **changes}) if item["id"] == operation["id"] else item for item in records]


def main():
    directory = Path(__file__).parent
    trace = json.loads(Path(sys.argv[1] if len(sys.argv) > 1 else directory / "trace.json").read_text())
    if set(trace) != {"format", "operations"} or trace["format"] != "afterlife-trace/v1" or type(trace["operations"]) is not list:
        raise ValueError("Expected an afterlife-trace/v1 trace")
    records = []
    for record in json.loads((directory / "records.json").read_text())["records"]:
        records = apply(records, {"op": "create", "record": record})
    initial = records
    outcomes = []
    for operation in trace["operations"]:
        try:
            records = apply(records, operation)
            ok = True
        except (TypeError, ValueError, UnicodeError):
            ok = False
        outcomes.append({"ok": ok, "records": records})
    print(json.dumps({"initial": initial, "outcomes": outcomes}, ensure_ascii=True))


if __name__ == "__main__":
    main()
