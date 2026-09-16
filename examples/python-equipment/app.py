"""Run the original register: python3 examples/python-equipment/app.py [trace.json]."""

from pathlib import Path
import sys

from model import Equipment

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "source-fixtures"))
from engine import run

if __name__ == "__main__":
    run(Equipment, Path(__file__).parent)
