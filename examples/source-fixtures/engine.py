"""Independent fixture application engine. No Afterlife imports or specifications.

Dataclasses supply constructors/defaults; this application supplies explicit type
validation and portable-record bounds. This is a controlled source corpus, not a
general application framework or a security boundary for untrusted Python models.
"""

from dataclasses import asdict, fields, replace
import json
from pathlib import Path
import sys
from typing import get_type_hints


class Store:
    def __init__(self, model, records):
        self.model = model
        self.types = get_type_hints(model)
        self.names = {field.name for field in fields(model)}
        self.items = []
        for record in records:
            self.apply({"op": "create", "record": record})

    def _check(self, item):
        for name, kind in self.types.items():
            value = getattr(item, name)
            if kind == int | None and value is None:
                continue
            expected = int if kind == int | None else kind
            if expected is int and type(value) is float and value.is_integer():
                value = int(value)
                setattr(item, name, value)
            if type(value) is not expected:
                raise ValueError(f"Invalid type for {name}")
            if expected is int and not -(2**53 - 1) <= value <= 2**53 - 1:
                raise ValueError("Integer outside portable range")
            if expected is str:
                if len(value) > (100 if name == "id" else 10000):
                    raise ValueError("Text is too long")
                value.encode("utf-8")  # Lone surrogates are invalid input.
        if not item.id.strip():
            raise ValueError("Record ID cannot be blank")
        return item

    def snapshot(self):
        return [asdict(item) for item in self.items]

    def apply(self, operation):
        if type(operation) is not dict:
            raise ValueError("Operation must be an object")
        name = operation.get("op")
        shapes = {"create": {"op", "record"}, "edit": {"op", "id", "changes"}, "delete": {"op", "id"}}
        if type(name) is not str or name not in shapes or set(operation) != shapes[name]:
            raise ValueError("Unsupported operation")
        if name == "create":
            record = operation["record"]
            if type(record) is not dict or set(record) - self.names:
                raise ValueError("Invalid record fields")
            item = self._check(self.model(**record))
            if len(self.items) >= 10000 or any(existing.id == item.id for existing in self.items):
                raise ValueError("Duplicate ID or collection limit")
            self.items.append(item)
            return
        position = next((i for i, item in enumerate(self.items) if item.id == operation["id"]), None)
        if position is None:
            raise ValueError("Record does not exist")
        if name == "delete":
            self.items.pop(position)
            return
        changes = operation["changes"]
        if type(changes) is not dict or "id" in changes or set(changes) - self.names:
            raise ValueError("Invalid edit fields")
        item = self._check(replace(self.items[position], **changes))
        self.items[position] = item


def run(model, directory):
    directory = Path(directory)
    trace_path = Path(sys.argv[1]) if len(sys.argv) > 1 else directory / "trace.json"
    trace = json.loads(trace_path.read_text(encoding="utf-8"))
    if set(trace) != {"format", "operations"} or trace["format"] != "afterlife-trace/v1" or not isinstance(trace["operations"], list):
        raise ValueError("Expected an afterlife-trace/v1 operation trace")
    store = Store(model, json.loads((directory / "records.json").read_text(encoding="utf-8"))["records"])
    initial = store.snapshot()
    outcomes = []
    for operation in trace["operations"]:
        try:
            store.apply(operation)
            accepted = True
        except (ValueError, TypeError, UnicodeError):
            accepted = False
        outcomes.append({"ok": accepted, "records": store.snapshot()})
    print(json.dumps({"initial": initial, "outcomes": outcomes}, ensure_ascii=True))
