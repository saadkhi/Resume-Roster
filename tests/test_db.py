from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
from sqlalchemy import inspect

from db import (
    bulk_insert_jobs,
    get_job_count,
    get_latest_jobs,
    get_session,
    is_duplicate,
    record_source_run,
)
from utils.normalization import normalize_job


def _job():
    return normalize_job(
        {
            "site": "Test board",
            "title": "Python Engineer",
            "company": "Acme",
            "job_url": "https://jobs.example/acme-python",
            "description": "Original description",
        }
    )


def test_database_initialization_creates_required_tables(settings, database):
    session = get_session()
    try:
        table_names = set(inspect(session.get_bind()).get_table_names())
    finally:
        session.close()
    assert {"jobs", "source_runs"} <= table_names


def test_insert_duplicate_updates_seen_fields_without_changing_first_seen(database):
    first = _job()
    first["first_seen_at"] = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert bulk_insert_jobs(pd.DataFrame([first]))["inserted"] == 1
    assert is_duplicate(first["unique_hash"])

    repeated = dict(first)
    repeated["description"] = "Updated description"
    repeated["last_seen_at"] = datetime(2026, 1, 2, tzinfo=timezone.utc)
    counts = bulk_insert_jobs(pd.DataFrame([repeated]))
    assert counts == {"inserted": 0, "updated": 1, "duplicate": 1, "rejected": 0}
    assert get_job_count() == 1
    saved = get_latest_jobs(limit=1)[0]
    assert saved.first_seen_at == datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert saved.last_seen_at == datetime(2026, 1, 2, tzinfo=timezone.utc)
    assert saved.description == "Updated description"


def test_source_runs_are_persisted(database):
    now = datetime.now(timezone.utc)
    record_source_run(
        run_id="test-run",
        source_name="test-source",
        started_at=now,
        finished_at=now,
        status="success",
        fetched_count=2,
    )
    from db import get_source_runs

    runs = get_source_runs()
    assert runs[0].run_id == "test-run"
    assert runs[0].fetched_count == 2
