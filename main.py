"""Command-line entry point and resilient job collection pipeline."""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
import time
import uuid
from collections.abc import Iterator
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import pandas as pd

import db
from config import Settings, load_config
from scrapers.base import SourceResult
from scrapers.custom_remote import (
    HackerNewsHiringSource,
    RemoteOKSource,
    WeWorkRemotelySource,
)
from scrapers.jobspy_runner import JobSpySource
from utils.exports import export_jobs
from utils.logging_config import configure_logging
from utils.normalization import normalize_job

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class SourceStats:
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: datetime | None = None
    fetched: int = 0
    rejected: int = 0
    inserted: int = 0
    updated: int = 0
    duplicates: int = 0
    errors: list[str] = field(default_factory=list)
    records: list[dict[str, Any]] = field(default_factory=list)

    @property
    def status(self) -> str:
        if self.errors and self.records:
            return "partial"
        if self.errors:
            return "failed"
        return "success"


@dataclass(frozen=True, slots=True)
class FetchTask:
    source_name: str
    adapter: Any
    query: str | None = None
    location: str | None = None


def _default_adapters(settings: Settings) -> dict[str, Any]:
    adapters: dict[str, Any] = {}
    if settings.jobspy_sites:
        adapters["jobspy"] = JobSpySource(settings)
    factories = {
        "remote_ok": RemoteOKSource,
        "we_work_remotely": WeWorkRemotelySource,
        "hacker_news": HackerNewsHiringSource,
    }
    for name in settings.enabled_sources:
        adapters[name] = factories[name](settings)
    return adapters


def _tasks(settings: Settings, adapters: dict[str, Any]) -> Iterator[FetchTask]:
    jobspy = adapters.get("jobspy")
    if jobspy is not None:
        for query in settings.queries:
            for location in settings.locations:
                yield FetchTask("jobspy", jobspy, query, location)
    for source_name, adapter in adapters.items():
        if source_name != "jobspy":
            yield FetchTask(source_name, adapter)


def _execute_task(task: FetchTask, settings: Settings) -> SourceResult:
    if settings.random_delay_max_seconds:
        time.sleep(
            random.uniform(
                settings.random_delay_min_seconds,
                settings.random_delay_max_seconds,
            )
        )
    return task.adapter.fetch(task.query, task.location)


def _collect(settings: Settings, adapters: dict[str, Any], stats: dict[str, SourceStats]) -> None:
    tasks = iter(_tasks(settings, adapters))
    started = time.monotonic()
    deadline = started + settings.max_execution_seconds
    max_pending = settings.max_concurrent_requests * 2
    with ThreadPoolExecutor(max_workers=settings.max_concurrent_requests) as executor:
        pending: dict[Future[SourceResult], FetchTask] = {}

        def submit_available() -> None:
            while len(pending) < max_pending and time.monotonic() < deadline:
                try:
                    task = next(tasks)
                except StopIteration:
                    return
                pending[executor.submit(_execute_task, task, settings)] = task

        submit_available()
        while pending:
            remaining = max(0.0, deadline - time.monotonic())
            completed, _ = wait(pending, timeout=remaining, return_when=FIRST_COMPLETED)
            if not completed:
                break
            for future in completed:
                task = pending.pop(future)
                source_stats = stats[task.source_name]
                try:
                    result = future.result()
                    source_stats.fetched += len(result.jobs)
                    source_stats.errors.extend(result.errors)
                    if result.jobs:
                        source_stats.records.extend(result.jobs)
                except Exception as exc:
                    logger.exception(
                        "Source worker failed",
                        extra={"source": task.source_name, "query": task.query},
                    )
                    source_stats.errors.append(f"{type(exc).__name__}: {exc}")
            submit_available()
        if pending:
            for future, task in pending.items():
                future.cancel()
                stats[task.source_name].errors.append(
                    f"Execution deadline exceeded ({settings.max_execution_seconds}s)"
                )
        for source_stats in stats.values():
            source_stats.finished_at = datetime.now(timezone.utc)


def _normalize_and_filter(stats: dict[str, SourceStats], settings: Settings) -> None:
    now = datetime.now(timezone.utc)
    oldest_allowed = now - timedelta(hours=settings.job_max_age_hours)
    for source_name, source_stats in stats.items():
        normalized: list[dict[str, Any]] = []
        for raw in source_stats.records:
            job = normalize_job(raw)
            if job is None:
                source_stats.rejected += 1
                continue
            posted = job["date_posted"]
            if posted is None:
                logger.info(
                    "Job has no verifiable posting time; retaining without freshness claim",
                    extra={"source": source_name},
                )
            elif posted < oldest_allowed:
                source_stats.rejected += 1
                continue
            normalized.append(job)
        source_stats.records = normalized


def run_pipeline(
    settings: Settings | None = None,
    *,
    adapters: dict[str, Any] | None = None,
    run_id: str | None = None,
) -> int:
    """Run collection and persistence; return 0 on success, nonzero on systemic error."""
    settings = settings or load_config()
    run_id = run_id or str(uuid.uuid4())
    configure_logging(settings.log_level, settings.output_dir)
    started_at = datetime.now(timezone.utc)
    stats: dict[str, SourceStats] = {}
    try:
        db.init_db(settings.database_url)
        selected_adapters = _default_adapters(settings) if adapters is None else adapters
        stats = {name: SourceStats() for name in selected_adapters}
        logger.info(
            "Collection run started",
            extra={"run_id": run_id, "source": "pipeline"},
        )
        if not selected_adapters:
            raise ValueError("No source adapters are configured")

        _collect(settings, selected_adapters, stats)
        _normalize_and_filter(stats, settings)

        # The pipeline persists in a single controlled stage after all workers finish.
        for source_stats in stats.values():
            if not source_stats.records:
                continue
            counts = db.bulk_insert_jobs(pd.DataFrame(source_stats.records))
            source_stats.inserted = counts["inserted"]
            source_stats.updated = counts["updated"]
            source_stats.duplicates = counts["duplicate"]
            source_stats.rejected += counts["rejected"]

        run_finished_at = datetime.now(timezone.utc)
        for source_name, source_stats in stats.items():
            db.record_source_run(
                run_id=run_id,
                source_name=source_name,
                started_at=source_stats.started_at,
                finished_at=source_stats.finished_at or run_finished_at,
                status=source_stats.status,
                fetched_count=source_stats.fetched,
                inserted_count=source_stats.inserted,
                duplicate_count=source_stats.duplicates,
                rejected_count=source_stats.rejected,
                error_count=len(source_stats.errors),
                error_summary="; ".join(source_stats.errors[:5]) or None,
            )

        formats = tuple(
            format_name
            for format_name in settings.export_formats
            if (format_name == "csv" and settings.enable_csv_export)
            or (format_name == "json" and settings.enable_json_export)
        )
        written = export_jobs(settings.output_dir, formats)
        all_errors = sum(len(item.errors) for item in stats.values())
        successful_sources = sum(item.status in {"success", "partial"} for item in stats.values())
        summary = {
            "run_id": run_id,
            "sources_configured": len(stats),
            "sources_successful_or_partial": successful_sources,
            "sources_failed": sum(item.status == "failed" for item in stats.values()),
            "raw_listings_fetched": sum(item.fetched for item in stats.values()),
            "valid_listings": sum(len(item.records) for item in stats.values()),
            "new_jobs_saved": sum(item.inserted for item in stats.values()),
            "existing_jobs_updated": sum(item.updated for item in stats.values()),
            "duplicates_skipped": sum(item.duplicates for item in stats.values()),
            "rejected_records": sum(item.rejected for item in stats.values()),
            "source_errors": all_errors,
            "exports": [str(path) for path in written],
            "duration_seconds": round((run_finished_at - started_at).total_seconds(), 2),
        }
        logger.info("Collection run completed", extra={"run_id": run_id})
        print(json.dumps(summary, indent=2, sort_keys=True))
        if successful_sources == 0:
            return 1
        return 0
    except Exception:
        logger.exception("Systemic collection failure", extra={"run_id": run_id})
        return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Collect and normalize job listings.")
    parser.add_argument(
        "--init-db",
        action="store_true",
        help="initialize the configured database without contacting job sources",
    )
    args = parser.parse_args(argv)
    try:
        settings = load_config()
        if args.init_db:
            db.init_db(settings.database_url)
            print("Database initialized.")
            return 0
        return run_pipeline(settings)
    except ValueError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
