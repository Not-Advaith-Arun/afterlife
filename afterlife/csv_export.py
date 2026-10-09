"""Explicit typed CSV export from a complete retained native backup."""
import csv
import io

from .compiler import CompileError, MAX_BYTES, validate_spec
from .transfers import backup_records


def export_csv(spec, backup, *, text_policy, selected_fields=None, record_ids=None):
    if text_policy not in ("literal", "afterlife"):
        raise CompileError("Choose explicit literal or afterlife CSV text policy")
    spec = validate_spec(spec)
    records = backup_records(spec, backup)
    names = [field["name"] for field in spec["fields"]]
    for supplied, known, label in ((selected_fields, set(names), "field"),
                                    (record_ids, {row["id"] for row in records}, "record ID")):
        if supplied is not None and (not isinstance(supplied, list) or not supplied
                or any(not isinstance(value, str) or value not in known for value in supplied)
                or len(set(supplied)) != len(supplied)):
            raise CompileError(f"Selected {label} values must be nonempty, distinct and present in the complete backup contract")
    columns = ["id", *[name for name in names if selected_fields is None or name in selected_fields]]
    if record_ids is not None:
        chosen = set(record_ids)
        records = [row for row in records if row["id"] in chosen]
    output = io.StringIO(newline="")
    row_buffer = io.StringIO(newline="")
    writer = csv.writer(row_buffer, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
    byte_count = 0

    def write_row(values):
        nonlocal byte_count
        row_buffer.seek(0); row_buffer.truncate(0)
        writer.writerow(values)
        row = row_buffer.getvalue()
        byte_count += len(row.encode("utf-8"))
        if byte_count > MAX_BYTES:
            raise CompileError("CSV exceeds 10 MiB; use JSON or split the collection")
        output.write(row)

    def cell(value):
        if value is None:
            return ""
        if type(value) is bool:
            return "true" if value else "false"
        if isinstance(value, str) and value and text_policy == "afterlife":
            return "'" + value
        return str(value)

    write_row(columns)
    for record in records:
        write_row([cell(record[name]) for name in columns])
    return output.getvalue(), len(records)
