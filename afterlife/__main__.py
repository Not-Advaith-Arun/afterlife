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
    if argv and argv[0] == "verify-build":
        return verify_build_main(argv[1:])
    if argv and argv[0] == "verify-artifact":
        return verify_artifact_main(argv[1:])
    if argv and argv[0] == "audit-python":
        return audit_main(argv[1:])
    if argv and argv[0] == "review-export":
        return review_export_main(argv[1:])
    from_export = bool(argv and argv[0] == "from-export")
    if from_export:
        argv.pop(0)
    from_python = bool(argv and argv[0] == "from-python")
    if from_python:
        argv.pop(0)
    parser = argparse.ArgumentParser(description="Compile a record app into one offline HTML file. Use 'from-export' to rebuild a matching JSON backup, 'from-python' to extract a supported dataclass model, 'audit-python' to report unsupported application behavior, or 'verify-artifact' to check retained HTML against a manifest.")
    parser.add_argument("spec", type=Path, help="Python model module" if from_python else "afterlife/v1 app specification")
    parser.add_argument("data", type=Path, help="JSON object containing records")
    parser.add_argument("-o", "--output", type=Path, required=True, help="new HTML artifact")
    parser.add_argument("--manifest", type=Path, help="optional compilation audit JSON")
    parser.add_argument("--force", action="store_true", help="replace existing output files")
    if from_export:
        parser.add_argument("--review", type=Path, help="Exact saved review-export report; requires --against")
        parser.add_argument("--against", type=Path, help="Current backup used by review-export; requires --review")
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
        if from_export:
            if bool(args.review) != bool(args.against):
                raise CompileError("Guarded restoration requires both --review and --against")
            inputs += [path for path in (args.review, args.against) if path]
        if any(_same_file(first, second) for index, first in enumerate(targets) for second in targets[index + 1:]):
            raise CompileError("HTML output, manifest, and extracted specification must use different paths")
        if any(_same_file(target, source) for target in targets for source in inputs):
            raise CompileError("Output paths must not overwrite source inputs")
        for target in targets:
            if target.is_symlink():
                raise CompileError(f"Output must not be a symbolic link: {target}")
            if target.exists() and not target.is_file():
                raise CompileError(f"Output must be a regular file: {target}")
            if target.exists() and not args.force:
                raise CompileError(f"{target} already exists; choose another path or pass --force")
            if not target.parent.is_dir():
                raise CompileError(f"Output directory does not exist: {target.parent}")
        evidence = None
        if from_python:
            spec, evidence = extract_python_model(args.spec, app_id=args.app_id, title=args.title, record_label=args.record_label)
        else:
            spec = load_json(args.spec)
        data = load_json(args.data)
        if from_export:
            from .transfers import backup_records
            if args.review:
                from .transfers import review_export
                from .compiler import _canonical
                expected = review_export(spec, load_json(args.against), data)
                if _canonical(load_json(args.review)) != _canonical(expected):
                    raise CompileError("Stale or modified backup review; compare the current backups again before restoring")
            data = {"records": backup_records(spec, data)}
        document, manifest = compile_app(spec, data)
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


def verify_artifact_main(argv):
    parser = argparse.ArgumentParser(prog="afterlife verify-artifact", description="Check retained HTML bytes against a supplied manifest without executing HTML; this is not authentication")
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        from .verification import verify_artifact
        result = verify_artifact(args.artifact, args.manifest)
        print(json.dumps(result, indent=2, ensure_ascii=True))
        return 0 if result["matched"] else 1
    except (CompileError, OSError) as error:
        print(f"afterlife: {error}", file=sys.stderr)
        return 2


def review_export_main(argv):
    parser = argparse.ArgumentParser(prog="afterlife review-export", description="Compare matching JSON backups without restoring or printing record values")
    parser.add_argument("spec", type=Path)
    parser.add_argument("backup", type=Path)
    parser.add_argument("--against", type=Path, required=True, help="Current matching JSON backup")
    view = parser.add_mutually_exclusive_group()
    view.add_argument("--summary", action="store_true", help="Show counts/hashes without record IDs or field names; --output still saves the complete restore guard")
    view.add_argument("--record-id", action="append", help="Focus on an added, removed or changed record ID; repeat for multiple IDs. --output still saves the complete restore guard")
    parser.add_argument("-o", "--output", type=Path, help="Atomically save the complete review for from-export --review")
    parser.add_argument("--force", action="store_true", help="Replace an existing saved review")
    parser.add_argument("--check", action="store_true", help="Exit 1 when normalized records or their array order differ; 2 for invalid input")
    args = parser.parse_args(argv)
    try:
        if args.output:
            if any(_same_file(args.output, source) for source in (args.spec, args.backup, args.against)):
                raise CompileError("Review output must not overwrite source inputs")
            if args.output.is_symlink() or (args.output.exists() and not args.output.is_file()):
                raise CompileError("Review output must be a non-symlink regular file")
            if args.output.exists() and not args.force:
                raise CompileError("Review output already exists; choose another path or pass --force")
            if not args.output.parent.is_dir():
                raise CompileError("Review output directory does not exist")
        from .transfers import review_export
        result = review_export(load_json(args.spec), load_json(args.against), load_json(args.backup))
        displayed = None
        if args.record_id:
            from .transfers import select_review_changes
            displayed = select_review_changes(result, args.record_id)
        serialized = json.dumps(result, indent=2, ensure_ascii=True) + "\n"
        if args.output:
            write_output(args.output, serialized, force=args.force)
        if displayed is not None:
            print(json.dumps(displayed, indent=2, ensure_ascii=True))
        elif args.summary:
            from .transfers import review_summary
            print(json.dumps(review_summary(result), indent=2, ensure_ascii=True))
        elif args.output:
            print(f"Saved backup review → {args.output}")
        else:
            print(serialized, end="")
        return int(args.check and result["current_records_sha256"] != result["incoming_records_sha256"])
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


def verify_build_main(argv):
    parser = argparse.ArgumentParser(description="Verify retained HTML against a rebuild from supplied declarative inputs with the installed compiler; no files written")
    parser.add_argument("spec", type=Path)
    parser.add_argument("data", type=Path)
    parser.add_argument("artifact", type=Path)
    args = parser.parse_args(argv)
    try:
        from .verification import verify_build
        result = verify_build(args.spec, args.data, args.artifact)
        print(json.dumps(result, indent=2))
        return 0 if result["matched"] else 1
    except (CompileError, OSError, ValueError, UnicodeError, RecursionError) as error:
        print(f"afterlife: {error}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
