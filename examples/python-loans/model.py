"""The record shape is supported; the adjacent application rules are not."""

from dataclasses import dataclass


@dataclass
class Loan:
    id: str
    borrower: str = ""
    returned: bool = False
    days: int = 7
