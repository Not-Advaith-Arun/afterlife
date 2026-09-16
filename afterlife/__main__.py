"""Run with python3 -m afterlife."""

import argparse
import json
from pathlib import Path
import sys

from .compiler import CompileError, compile_app, load_json


def _same_file(first, second):
    if first.resolve() == second.resolve():
        return True
    return first.exists() and second.exists() and first.samefile(second)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Compile a declarative record app into one offline HTML file.")
    parser.add_argument("spec", type=Path, help="afterlife/v1 app specification")
    parser.add_argument("data", type=Path, help="JSON object containing records")
    parser.add_argument("-o", "--output", type=Path, required=True, help="new HTML artifact")
    parser.add_argument("--manifest", type=Path, help="optional compilation audit JSON")
    parser.add_argument("--force", action="store_true", help="replace existing output files")
    args = parser.parse_args(argv)
    try:
        targets = [args.output] + ([args.manifest] if args.manifest else [])
        inputs = [args.spec, args.data]
        if any(_same_file(first, second) for index, first in enumerate(targets) for second in targets[index + 1:]):
            raise CompileError("HTML output and manifest must use different paths")
        if any(_same_file(target, source) for target in targets for source in inputs):
            raise CompileError("Output paths must not overwrite source inputs")
        for target in targets:
            if target.exists() and not args.force:
                raise CompileError(f"{target} already exists; choose another path or pass --force")
            if not target.parent.is_dir():
                raise CompileError(f"Output directory does not exist: {target.parent}")
        document, manifest = compile_app(load_json(args.spec), load_json(args.data))
        # Exclusive creation by default avoids overwriting files created after preflight.
        mode = "w" if args.force else "x"
        with args.output.open(mode, encoding="utf-8", newline="\n") as stream:
            stream.write(document)
        if args.manifest:
            with args.manifest.open(mode, encoding="utf-8", newline="\n") as stream:
                json.dump(manifest, stream, indent=2)
                stream.write("\n")
        print(f"Compiled {manifest['record_count']} records → {args.output}")
        print(f"SHA-256 {manifest['artifact_sha256']}")
        return 0
    except (CompileError, OSError) as error:
        print(f"afterlife: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
