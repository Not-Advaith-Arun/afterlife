"""Model used by the independent equipment-register application."""

from dataclasses import dataclass


@dataclass
class Equipment:
    id: str
    name: str = "Unlabeled equipment"
    available: bool = True
    quantity: int = 1
    notes: str = ""
