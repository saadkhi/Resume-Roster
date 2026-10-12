"""Deterministic conversion of source records into the common job schema."""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

import pandas as pd

from utils.fingerprints import generate_unique_hash

JOB_TYPES = {
    "fulltime": "full-time",
    "full-time": "full-time",
    "full_time": "full-time",
    "parttime": "part-time",
    "part-time": "part-time",
    "part_time": "part-time",
    "contract": "contract",
    "contractor": "contract",
    "internship": "internship",
    "temporary": "temporary",
    "temp": "temporary",
}
PERIODS = {
    "year": "annual",
    "yearly": "annual",
    "annual": "annual",
    "month": "monthly",
    "monthly": "monthly",
    "week": "weekly",
    "weekly": "weekly",
    "day": "daily",
    "daily": "daily",
    "hour": "hourly",
    "hourly": "hourly",
}


def _value(*values: Any) -> Any:
    for item in values:
        if item is not None and not (isinstance(item, float) and math.isnan(item)):
            if str(item).strip() not in {"", "nan", "NaT", "None"}:
                return item
    return None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _boolean(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    normalized = str(value).strip().casefold()
    if normalized in {"true", "yes", "1", "remote"}:
        return True
    if normalized in {"false", "no", "0", "on-site", "onsite"}:
        return False
    return None


def _timestamp(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            result = datetime.fromtimestamp(value, tz=timezone.utc)
        else:
            result = pd.to_datetime(value, utc=True, errors="coerce")
            if pd.isna(result):
                return None
            result = result.to_pydatetime()
        return result.astimezone(timezone.utc)
    except (OverflowError, OSError, TypeError, ValueError):
        return None


def normalize_job(
    raw: dict[str, Any],
    *,
    site: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Normalize a source mapping; reject records without title, company, and URL."""
    title = _text(_value(raw.get("title"), raw.get("job_title")))
    company = _text(_value(raw.get("company"), raw.get("company_name")))
    job_url = _text(_value(raw.get("job_url"), raw.get("url"), raw.get("job_url_direct")))
    if not title or not company or not job_url:
        return None
    parsed = urlsplit(job_url if "://" in job_url else f"https://{job_url}")
    if not parsed.hostname:
        return None

    source = _text(site or _value(raw.get("site"), raw.get("source"))) or "unknown"
    job_type_raw = _text(raw.get("job_type"))
    job_type = JOB_TYPES.get(job_type_raw.casefold(), "unknown") if job_type_raw else "unknown"
    is_remote = _boolean(_value(raw.get("is_remote"), raw.get("remote")))
    workplace = _text(raw.get("workplace_type"))
    if workplace:
        workplace = workplace.casefold().replace("on site", "on-site")
        workplace = workplace if workplace in {"remote", "hybrid", "on-site"} else "unknown"
    elif is_remote is True:
        workplace = "remote"
    else:
        workplace = "unknown"
    min_amount = _number(_value(raw.get("min_amount"), raw.get("salary_min")))
    max_amount = _number(_value(raw.get("max_amount"), raw.get("salary_max")))
    interval = _text(_value(raw.get("salary_period"), raw.get("interval")))
    salary_period = PERIODS.get(interval.casefold(), "unknown") if interval else "unknown"
    observed = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    normalized = {
        "unique_hash": "",
        "job_id": _text(_value(raw.get("job_id"), raw.get("id"))),
        "site": source,
        "title": title,
        "company": company,
        "location": _text(raw.get("location")),
        "job_type": job_type,
        "is_remote": is_remote,
        "workplace_type": workplace,
        "job_url": job_url,
        "description": _text(raw.get("description")),
        "min_amount": min_amount,
        "max_amount": max_amount,
        "currency": _text(raw.get("currency")),
        "salary_period": salary_period,
        "date_posted": _timestamp(_value(raw.get("date_posted"), raw.get("published"))),
        "first_seen_at": observed,
        "last_seen_at": observed,
        "created_at": observed,
        "updated_at": observed,
        "tags": _text(raw.get("tags")),
    }
    normalized["unique_hash"] = generate_unique_hash(normalized)
    return normalized


def normalize_jobs(records: list[dict[str, Any]], *, site: str | None = None) -> pd.DataFrame:
    columns = [
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
    ]
    jobs = [normalized for row in records if (normalized := normalize_job(row, site=site))]
    return pd.DataFrame(jobs, columns=columns)
