"""Run the original tracker: python3 examples/python-tracker/app.py [trace.json]."""

from pathlib import Path
import sys

from model import Task

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "source-fixtures"))
from engine import run

if __name__ == "__main__":
    run(Task, Path(__file__).parent)
