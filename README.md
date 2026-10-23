# Afterlife

**Keep a small record app usable after its server disappears.**

Compile supported Python dataclass models or an explicit JSON record specification into a single editable HTML file. Open it offline: create and edit records, search, import/export JSON, undo supported changes, and download an updated standalone copy.

## Try the interactive showcase

Python 3.10+; no runtime dependencies, account, API key, or server required.

```sh
git clone https://github.com/Not-Advaith-Arun/afterlife.git
cd afterlife
python3 -m afterlife showcase -o /tmp/afterlife-showcase.html
```

Open `/tmp/afterlife-showcase.html` in a browser. The showcase uses fictional inputs and includes a working generated application.

## Compile a Python model

```sh
python3 -m afterlife from-python examples/python-equipment/model.py \
  examples/python-equipment/records.json -o /tmp/equipment.html \
  --manifest /tmp/equipment.manifest.json
```

The compiler parses source without executing it. Its manifest records source identity and conversion scope. The browser runtime provides validation, pagination, offline editing, explicit persistence warnings, and protection against cooperating tabs overwriting unseen changes.

## Scope

A working research prototype for a narrow record-model subset. It does **not** convert arbitrary routes, authentication, business logic, methods, or side effects into an equivalent application. Unsupported source constructs are rejected; `audit-python` reports capability gaps. Browser edits do not rewrite the original HTML file—download an updated app to retain a portable copy.

## Validation

```sh
python3 -m unittest discover -s tests -v
```

The repository includes independent Python fixture applications, differential operation checks, compiler/runtime acceptance checks, and browser workflows. See `python3 -m afterlife --help` for the CLI.
