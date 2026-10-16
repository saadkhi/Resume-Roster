"""Read-only HTTP API exposing collected jobs (used by Resume-Roster).

Run with: uvicorn api:create_app --factory --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import hmac
import os
import re
from datetime import datetime
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

import db
from config import load_config

MAX_PAGE_SIZE = 200


def _serialize(job: db.Job, *, include_description: bool) -> dict[str, Any]:
    def iso(value: datetime | None) -> str | None:
        return value.isoformat() if value else None

    data: dict[str, Any] = {
        "id": job.unique_hash,
        "source_job_id": job.job_id,
        "source": job.site,
        "title": job.title,
        "company": job.company,
        "location": job.location,
        "job_type": job.job_type,
        "is_remote": job.is_remote,
        "workplace_type": job.workplace_type,
        "url": job.job_url,
        "salary_min": job.min_amount,
        "salary_max": job.max_amount,
        "currency": job.currency,
        "salary_period": job.salary_period,
        "date_posted": iso(job.date_posted),
        "first_seen_at": iso(job.first_seen_at),
        "last_seen_at": iso(job.last_seen_at),
        "tags": [tag.strip() for tag in re.split(r"[;,]", job.tags or "") if tag.strip()],
    }
    if include_description:
        data["description"] = job.description
    return data


def require_api_key(x_api_key: Annotated[str | None, Header()] = None) -> None:
    """Enforce X-API-Key only when the API_KEY environment variable is set."""
    expected = os.getenv("API_KEY")
    if expected and not hmac.compare_digest(x_api_key or "", expected):
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


def create_app() -> FastAPI:
    settings = load_config()
    db.init_db(settings.database_url)
    app = FastAPI(title="Scrabeee Jobs API", version="1.0.0")
    origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=origins, allow_methods=["GET"], allow_headers=["*"]
        )
    guard = [Depends(require_api_key)]

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "jobs": db.get_job_count()}

    @app.get("/jobs", dependencies=guard)
    def list_jobs(
        q: Annotated[str | None, Query(max_length=200, description="Search text")] = None,
        location: Annotated[str | None, Query(max_length=200)] = None,
        source: Annotated[str | None, Query(max_length=100)] = None,
        job_type: Annotated[str | None, Query(max_length=50)] = None,
        workplace_type: Annotated[str | None, Query(max_length=50)] = None,
        remote: bool | None = None,
        posted_within_hours: Annotated[int | None, Query(ge=1, le=24 * 365)] = None,
        limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
        include_description: bool = False,
    ) -> dict[str, Any]:
        total, jobs = db.query_jobs(
            q=q,
            location=location,
            site=source,
            job_type=job_type,
            workplace_type=workplace_type,
            is_remote=remote,
            posted_within_hours=posted_within_hours,
            limit=limit,
            offset=offset,
        )
        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "items": [_serialize(j, include_description=include_description) for j in jobs],
        }

    @app.get("/jobs/{job_id}", dependencies=guard)
    def get_job(job_id: str) -> dict[str, Any]:
        job = db.get_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return _serialize(job, include_description=True)

    @app.get("/sources", dependencies=guard)
    def sources() -> list[dict[str, Any]]:
        return [{"source": name, "jobs": count} for name, count in db.get_site_counts()]

    return app
