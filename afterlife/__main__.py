"""Run with python3 -m afterlife."""

import argparse
import json
from pathlib import Path
import sys

from .compiler import CompileError, compile_app, load_json
from .audit import audit_python_application
from .source import extract_python_model
from .output import write_output


def _same_file(first, second):
    if first.resolve() == second.resolve():
        return True
    return first.exists() and second.exists() and first.samefile(second)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "audit-python":
        return audit_main(argv[1:])
    from_python = bool(argv and argv[0] == "from-python")
    if from_python:
        argv.pop(0)
    parser = argparse.ArgumentParser(description="Compile a record app into one offline HTML file. Use 'from-python' first to extract a supported dataclass model, or 'audit-python' to report unsupported application behavior.")
    parser.add_argument("spec", type=Path, help="Python model module" if from_python else "afterlife/v1 app specification")
    parser.add_argument("data", type=Path, help="JSON object containing records")
    parser.add_argument("-o", "--output", type=Path, required=True, help="new HTML artifact")
    parser.add_argument("--manifest", type=Path, help="optional compilation audit JSON")
    parser.add_argument("--force", action="store_true", help="replace existing output files")
    if from_python:
        parser.add_argument("--app-id", help="app identifier (default: kebab-case class name)")
        parser.add_argument("--title", help="artifact title")
        parser.add_argument("--record-label", help="singular display label")
        parser.add_argument("--extracted-spec", type=Path, help="optional extracted afterlife/v1 JSON")
    args = parser.parse_args(argv)
    try:
        extracted_spec = getattr(args, "extracted_spec", None)
        targets = [args.output] + ([args.manifest] if args.manifest else []) + ([extracted_spec] if extracted_spec else [])
        inputs = [args.spec, args.data]
        if any(_same_file(first, second) for index, first in enumerate(targets) for second in targets[index + 1:]):
            raise CompileError("HTML output, manifest, and extracted specification must use different paths")
        if any(_same_file(target, source) for target in targets for source in inputs):
            raise CompileError("Output paths must not overwrite source inputs")
        for target in targets:
            if target.exists() and not args.force:
                raise CompileError(f"{target} already exists; choose another path or pass --force")
            if not target.parent.is_dir():
                raise CompileError(f"Output directory does not exist: {target.parent}")
        evidence = None
        if from_python:
            spec, evidence = extract_python_model(args.spec, app_id=args.app_id, title=args.title, record_label=args.record_label)
        else:
            spec = load_json(args.spec)
        document, manifest = compile_app(spec, load_json(args.data))
        if evidence is not None:
            manifest["extraction"] = evidence
            manifest["limitations"][0] = "One dataclass record model under flat-records/v1; source application behavior is not statically verified"
        write_output(args.output, document, force=args.force)
        if args.manifest:
            write_output(args.manifest, json.dumps(manifest, indent=2) + "\n", force=args.force)
        if extracted_spec:
            write_output(extracted_spec, json.dumps(spec, indent=2) + "\n", force=args.force)
        print(f"Compiled {manifest['record_count']} records → {args.output}")
        print(f"SHA-256 {manifest['artifact_sha256']}")
        if evidence is not None:
            print(f"Extracted {evidence['model']} without executing source. Only the model module was analyzed; see docs/SOURCE_ADAPTER.md for behavior assumptions.")
        return 0
    except (CompileError, OSError) as error:
        print(f"afterlife: {error}", file=sys.stderr)
        return 2


def audit_main(argv):
    parser = argparse.ArgumentParser(prog="afterlife audit-python", description="Report unsupported Python application behavior without executing source or generating an app.")
    parser.add_argument("model", type=Path, help="the model module to extract")
    parser.add_argument("--application-source", action="append", default=[], type=Path,
                        help="application file to inspect; repeat for each file (imports are not followed)")
    parser.add_argument("-o", "--output", type=Path, help="report JSON (default: stdout)")
    parser.add_argument("--force", action="store_true", help="replace an existing report")
    args = parser.parse_args(argv)
    try:
        if args.output:
            if any(_same_file(args.output, source) for source in [args.model] + args.application_source):
                raise CompileError("Report output must not overwrite source inputs")
            if args.output.exists() and not args.force:
                raise CompileError(f"{args.output} already exists; choose another path or pass --force")
        report = audit_python_application(args.model, args.application_source)
        serialized = json.dumps(report, indent=2, ensure_ascii=True) + "\n"
        if args.output:
            write_output(args.output, serialized, force=args.force)
        else:
            print(serialized, end="")
        return 2 if report["findings"] else 0
    except (CompileError, OSError) as error:
        print(f"afterlife: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
