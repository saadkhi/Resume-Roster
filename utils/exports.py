"""CSV and JSON exports for normalized jobs and source run history."""

from __future__ import annotations

import csv
import json
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from db import get_latest_jobs, get_source_runs

JOB_COLUMNS = (
    "unique_hash",
    "job_id",
    "site",
    "title",
    "company",
    "location",
    "job_type",
    "is_remote",
    "workplace_type",
    "job_url",
    "description",
    "min_amount",
    "max_amount",
    "currency",
    "salary_period",
    "date_posted",
    "first_seen_at",
    "last_seen_at",
    "created_at",
    "updated_at",
    "tags",
)


def _serialize(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        if isinstance(value, datetime) and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return value


def _csv_safe(value: Any) -> Any:
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return value


def export_jobs(output_dir: Path, formats: tuple[str, ...]) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    jobs = get_latest_jobs(limit=None)
    records = [
        {column.name: _serialize(getattr(job, column.name)) for column in job.__table__.columns}
        for job in jobs
    ]
    written: list[Path] = []
    if "json" in formats:
        json_path = output_dir / "jobs.json"
        json_path.write_text(
            json.dumps(records, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        written.append(json_path)
    if "csv" in formats:
        csv_path = output_dir / "jobs.csv"
        fields = list(records[0].keys()) if records else list(JOB_COLUMNS)
        with csv_path.open("w", encoding="utf-8-sig", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(
                {key: _csv_safe(value) for key, value in row.items()} for row in records
            )
        written.append(csv_path)

    health = [
        {column.name: _serialize(getattr(run, column.name)) for column in run.__table__.columns}
        for run in get_source_runs()
    ]
    health_path = output_dir / "source_health.json"
    health_path.write_text(
        json.dumps(health, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    written.append(health_path)
    return written
