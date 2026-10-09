"""Publish complete artifacts atomically, one file at a time."""

import os
from pathlib import Path
import tempfile

from .compiler import CompileError


def write_output(path, text, *, force=False):
    """Keep old bytes on write/flush failure and retain exclusive creation.

    Publication is atomic per file, not a transaction across HTML/manifest/spec
    outputs or a power-loss durability guarantee. Forced publication replaces the
    destination inode instead of mutating other hardlinks to an existing file.
    """
    path = Path(path)
    if path.is_symlink():
        raise CompileError("Output must not be a symbolic link")
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".pending", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        if force:
            if path.is_symlink():
                raise CompileError("Output must not be a symbolic link")
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
