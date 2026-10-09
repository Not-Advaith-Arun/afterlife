"""A notebook model with literal defaults and no application dependencies."""

from dataclasses import dataclass


@dataclass
class Note:
    id: str
    title: str = "Untitled note"
    archived: bool = False
    pages: int = 0
    rating: int | None = None
    body: str = "First line\nSecond line"
