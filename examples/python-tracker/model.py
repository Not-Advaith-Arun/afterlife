"""Model used by the independent task-tracker application."""

from dataclasses import dataclass


@dataclass
class Task:
    id: str
    title: str = "Untitled task"
    done: bool = False
    priority: int = 2
    estimate: int | None = None
