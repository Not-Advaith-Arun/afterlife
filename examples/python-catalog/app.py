"""Original catalog app: explicit JSON state, trace operations and restart reload.

Single-process fixture, not a concurrent database or arbitrary-app converter.
No Afterlife imports; this original app is an independent behavioral reference.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

from model import CatalogItem

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "source-fixtures"))
from engine import Store


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--trace", type=Path, default=Path(__file__).with_name("trace.json"))
    args = parser.parse_args()
    directory = Path(__file__).parent
    protected = [Path(__file__), directory / "model.py", directory / "records.json", args.trace]
    if args.state.is_symlink() or any(args.state.resolve() == p.resolve() or
            (args.state.exists() and args.state.samefile(p)) for p in protected):
        raise ValueError("state must not overwrite source or trace inputs")
    if not args.state.parent.is_dir() or (args.state.exists() and not args.state.is_file()):
        raise ValueError("state requires a regular file in an existing directory")
    source = args.state if args.state.exists() else directory / "records.json"
    store = Store(CatalogItem, json.loads(source.read_text())["records"])
    trace = json.loads(args.trace.read_text())
    if set(trace) != {"format", "operations"} or trace["format"] != "afterlife-trace/v1" or not isinstance(trace["operations"], list):
        raise ValueError("expected afterlife-trace/v1 operations")
    initial, outcomes = store.snapshot(), []
    for operation in trace["operations"]:
        candidate = Store(CatalogItem, store.snapshot())
        try:
            candidate.apply(operation)
        except (ValueError, TypeError, UnicodeError):
            outcomes.append({"ok": False, "records": store.snapshot()})
            continue
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=args.state.parent, delete=False) as stream:
                temporary = Path(stream.name)
                json.dump({"records": candidate.snapshot()}, stream, ensure_ascii=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, args.state)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        store = candidate
        outcomes.append({"ok": True, "records": store.snapshot()})
    print(json.dumps({"initial": initial, "outcomes": outcomes}, ensure_ascii=True))


if __name__ == "__main__":
    main()
