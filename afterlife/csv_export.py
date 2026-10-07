"""Explicit typed CSV export from a complete retained native backup."""
import csv
import io

from .compiler import CompileError, MAX_BYTES, validate_spec
from .transfers import backup_records


def export_csv(spec, backup, *, text_policy):
    if text_policy not in ("literal", "afterlife"):
        raise CompileError("Choose explicit literal or afterlife CSV text policy")
    spec = validate_spec(spec)
    records = backup_records(spec, backup)
    columns = ["id", *[field["name"] for field in spec["fields"]]]
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
