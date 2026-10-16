from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from utils.normalization import normalize_job, normalize_jobs


def test_missing_salary_and_date_are_nullable():
    job = normalize_job(
        {
            "site": "example",
            "title": "Data Engineer",
            "company": "Example Co",
            "url": "https://jobs.example/1",
            "is_remote": None,
        }
    )
    assert job is not None
    assert job["min_amount"] is None
    assert job["max_amount"] is None
    assert job["date_posted"] is None
    assert job["is_remote"] is None
    assert job["workplace_type"] == "unknown"


def test_date_is_converted_to_utc_and_labels_standardized():
    job = normalize_job(
        {
            "site": "example",
            "title": "Python Developer",
            "company": "Example Co",
            "job_url": "jobs.example/python",
            "date_posted": "2026-10-12T10:00:00+02:00",
            "job_type": "fulltime",
            "interval": "yearly",
        },
        now=datetime(2026, 10, 12, tzinfo=timezone.utc),
    )
    assert job is not None
    assert job["date_posted"] == datetime(2026, 10, 12, 8, tzinfo=timezone.utc)
    assert job["job_type"] == "full-time"
    assert job["salary_period"] == "annual"


def test_records_missing_identity_fields_are_rejected():
    assert normalize_job({"title": "Engineer", "company": "Example"}) is None


def test_dataframe_does_not_preserve_pandas_nan_values():
    frame = normalize_jobs(
        [
            {
                "site": "example",
                "title": "Engineer",
                "company": "Example",
                "job_url": "https://jobs.example/1",
                "min_amount": float("nan"),
            }
        ]
    )
    assert len(frame) == 1
    assert pd.isna(frame.iloc[0]["min_amount"])
