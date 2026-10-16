from __future__ import annotations

import sys
import types
from dataclasses import replace
from datetime import datetime, timezone

import pandas as pd

from db import get_job_count, get_source_runs
from main import _default_adapters, run_pipeline
from scrapers.base import SourceResult


class StaticSource:
    name = "remote_ok"

    def __init__(self, jobs):
        self.jobs = jobs

    def fetch(self, query=None, location=None):
        del query, location
        return SourceResult(source_name=self.name, jobs=self.jobs)


class FailedSource:
    name = "hacker_news"

    def fetch(self, query=None, location=None):
        del query, location
        result = SourceResult(source_name=self.name, errors=["403 access denied"])
        result.finish()
        return result


def _job():
    return {
        "site": "Remote OK",
        "job_id": "1",
        "title": "Python Engineer",
        "company": "Acme",
        "location": "Worldwide",
        "job_url": "https://remoteok.com/remote-jobs/python-engineer-acme-1",
        "date_posted": datetime.now(timezone.utc).isoformat(),
        "is_remote": True,
    }


def _small_settings(settings):
    return replace(
        settings,
        queries=("Python Engineer",),
        locations=("Pakistan",),
        jobspy_sites=(),
        output_dir=settings.output_dir,
    )


def test_pipeline_persists_exports_and_deduplicates_repeated_runs(settings, capsys):
    selected = _small_settings(settings)
    source = StaticSource([_job()])
    assert run_pipeline(selected, adapters={"remote_ok": source}, run_id="first") == 0
    assert get_job_count() == 1
    assert (selected.output_dir / "jobs.csv").exists()
    assert (selected.output_dir / "jobs.json").exists()
    assert (selected.output_dir / "source_health.json").exists()

    assert run_pipeline(selected, adapters={"remote_ok": source}, run_id="second") == 0
    assert get_job_count() == 1
    assert len(get_source_runs()) == 2
    assert '"duplicates_skipped": 1' in capsys.readouterr().out


def test_source_failure_does_not_discard_successful_source(settings):
    selected = _small_settings(settings)
    code = run_pipeline(
        selected,
        adapters={
            "remote_ok": StaticSource([_job()]),
            "hacker_news": FailedSource(),
        },
        run_id="partial",
    )
    assert code == 0
    assert get_job_count() == 1
    runs = {row.source_name: row for row in get_source_runs()}
    assert runs["remote_ok"].status == "success"
    assert runs["hacker_news"].status == "failed"
    assert "403 access denied" in runs["hacker_news"].error_summary


def test_jobspy_boards_have_independent_run_health(settings, monkeypatch):
    selected = replace(
        _small_settings(settings),
        jobspy_sites=("indeed", "linkedin"),
        enabled_sources=(),
    )

    def scrape_jobs(**kwargs):
        if kwargs["site_name"] == "indeed":
            raise RuntimeError("board unavailable")
        return pd.DataFrame(
            [
                {
                    "site": "linkedin",
                    "title": "Python Engineer",
                    "company": "Acme",
                    "job_url": "https://jobs.example/1",
                    "date_posted": datetime.now(timezone.utc),
                }
            ]
        )

    module = types.ModuleType("jobspy")
    module.scrape_jobs = scrape_jobs
    monkeypatch.setitem(sys.modules, "jobspy", module)
    adapters = _default_adapters(selected)
    assert run_pipeline(selected, adapters=adapters, run_id="board-health") == 0
    runs = {row.source_name: row for row in get_source_runs()}
    assert runs["jobspy:indeed"].status == "failed"
    assert "board unavailable" in runs["jobspy:indeed"].error_summary
    assert runs["jobspy:linkedin"].status == "success"


def test_database_failure_is_a_systemic_error(settings, monkeypatch):
    selected = _small_settings(settings)
    monkeypatch.setattr(
        "main.db.bulk_insert_jobs",
        lambda records: (_ for _ in ()).throw(RuntimeError("disk unavailable")),
    )
    assert (
        run_pipeline(
            selected,
            adapters={"remote_ok": StaticSource([_job()])},
            run_id="db-failure",
        )
        == 2
    )
