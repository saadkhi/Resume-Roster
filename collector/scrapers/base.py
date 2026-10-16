"""Shared source adapter contract and result metadata."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol


@dataclass(slots=True)
class SourceResult:
    source_name: str
    jobs: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: datetime | None = None
    status: str = "success"

    def finish(self) -> None:
        self.finished_at = datetime.now(timezone.utc)
        if self.errors and self.jobs:
            self.status = "partial"
        elif self.errors and not self.jobs:
            self.status = "failed"


class SourceAdapter(Protocol):
    name: str

    def fetch(self, query: str | None = None, location: str | None = None) -> SourceResult: ...
