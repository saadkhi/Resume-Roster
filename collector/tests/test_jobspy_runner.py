from __future__ import annotations

import logging
import sys
import types
from dataclasses import replace

import pandas as pd
import pytest

from scrapers.jobspy_runner import JobSpySource


def test_remote_search_skips_country_required_sites(settings, monkeypatch):
    calls = []
    module = types.ModuleType("jobspy")

    def scrape_jobs(**kwargs):
        calls.append(kwargs)
        return pd.DataFrame(
            [
                {
                    "site": "linkedin",
                    "title": "Engineer",
                    "company": "Acme",
                    "job_url": "https://jobs.example/1",
                }
            ]
        )

    module.scrape_jobs = scrape_jobs
    monkeypatch.setitem(sys.modules, "jobspy", module)
    adapter = JobSpySource(settings, "linkedin")
    result = adapter.fetch("Engineer", "Remote / Worldwide")
    assert calls[0]["site_name"] == "linkedin"
    assert calls[0]["is_remote"] is True
    assert "country_indeed" not in calls[0]
    assert len(result.jobs) == 1
    assert not result.errors


def test_country_mapping_passes_correct_indeed_country(settings, monkeypatch):
    calls = []
    module = types.ModuleType("jobspy")
    module.scrape_jobs = lambda **kwargs: calls.append(kwargs) or pd.DataFrame()
    monkeypatch.setitem(sys.modules, "jobspy", module)
    adapter = JobSpySource(settings, "indeed")
    adapter.fetch("Engineer", "Pakistan")
    assert calls[0]["country_indeed"] == "Pakistan"


def test_jobspy_failure_is_returned_as_source_error(settings, monkeypatch):
    module = types.ModuleType("jobspy")

    def fail(**kwargs):
        raise RuntimeError("upstream refused the request")

    module.scrape_jobs = fail
    monkeypatch.setitem(sys.modules, "jobspy", module)
    result = JobSpySource(settings, "indeed").fetch("Engineer", "Pakistan")
    assert result.status == "failed"
    assert "upstream refused" in result.errors[0]


def test_failed_board_does_not_discard_success_from_another_board(settings, monkeypatch):
    def scrape_jobs(**kwargs):
        if kwargs["site_name"] == "indeed":
            raise RuntimeError("board unavailable")
        return pd.DataFrame(
            [
                {
                    "site": "linkedin",
                    "title": "Engineer",
                    "company": "Acme",
                    "job_url": "https://jobs.example/1",
                }
            ]
        )

    module = types.ModuleType("jobspy")
    module.scrape_jobs = scrape_jobs
    monkeypatch.setitem(sys.modules, "jobspy", module)
    indeed = JobSpySource(settings, "indeed").fetch("Engineer", "Pakistan")
    linkedin = JobSpySource(settings, "linkedin").fetch("Engineer", "Pakistan")
    assert indeed.status == "failed"
    assert "indeed: RuntimeError: board unavailable" in indeed.errors
    assert linkedin.status == "success"
    assert len(linkedin.jobs) == 1


def test_country_required_board_is_skipped_without_fabricating_failure(settings, monkeypatch):
    module = types.ModuleType("jobspy")
    module.scrape_jobs = lambda **kwargs: (_ for _ in ()).throw(
        AssertionError("unsupported location must not call JobSpy")
    )
    monkeypatch.setitem(sys.modules, "jobspy", module)
    result = JobSpySource(settings, "indeed").fetch("Engineer", "Remote / Worldwide")
    assert result.status == "skipped"
    assert result.errors == []


def test_linkedin_429_pauses_remaining_searches_for_this_run(settings, monkeypatch):
    calls = []
    module = types.ModuleType("jobspy")

    def scrape_jobs(**kwargs):
        calls.append(kwargs)
        logging.getLogger("JobSpy:LinkedIn").error("LinkedIn response status code 429")
        return pd.DataFrame()

    module.scrape_jobs = scrape_jobs
    monkeypatch.setitem(sys.modules, "jobspy", module)
    adapter = JobSpySource(replace(settings, linkedin_min_interval_seconds=0), "linkedin")

    first = adapter.fetch("Engineer", "Pakistan")
    second = adapter.fetch("Developer", "United Kingdom")

    assert len(calls) == 1
    assert first.status == "failed"
    assert "HTTP 429" in first.errors[0]
    assert second.status == "skipped"


def test_linkedin_calls_use_configured_minimum_interval(settings, monkeypatch):
    delays = []
    module = types.ModuleType("jobspy")
    module.scrape_jobs = lambda **kwargs: pd.DataFrame()
    monkeypatch.setitem(sys.modules, "jobspy", module)
    monkeypatch.setattr("scrapers.jobspy_runner.time.sleep", delays.append)
    adapter = JobSpySource(replace(settings, linkedin_min_interval_seconds=10), "linkedin")

    adapter.fetch("Engineer", "Pakistan")
    adapter.fetch("Developer", "United Kingdom")

    assert len(delays) == 1
    assert delays[0] == pytest.approx(10, abs=0.2)


def _blocked_jobspy(monkeypatch, status=403, jobs_after=None):
    """Fake JobSpy that logs an HTTP error like the real ZipRecruiter scraper."""
    calls = []
    module = types.ModuleType("jobspy")

    def scrape_jobs(**kwargs):
        calls.append(kwargs)
        if jobs_after is not None and len(calls) > jobs_after:
            return pd.DataFrame(
                [
                    {
                        "site": "zip_recruiter",
                        "title": "Dev",
                        "company": "Acme",
                        "job_url": "https://x/1",
                    }
                ]
            )
        logging.getLogger("JobSpy:ZipRecruiter").error(
            "ZipRecruiter response status code %s", status
        )
        return pd.DataFrame()

    module.scrape_jobs = scrape_jobs
    monkeypatch.setitem(sys.modules, "jobspy", module)
    return calls


def test_blocked_board_is_reported_as_an_error_not_a_quiet_success(settings, monkeypatch):
    _blocked_jobspy(monkeypatch)
    adapter = JobSpySource(settings, "zip_recruiter")
    result = adapter.fetch("Engineer", "United States")
    assert result.status == "failed"
    assert "blocked by the provider (HTTP 403)" in result.errors[0]


def test_blocked_board_stops_after_a_few_requests(settings, monkeypatch):
    from scrapers.jobspy_runner import BLOCK_TRIP_THRESHOLD

    calls = _blocked_jobspy(monkeypatch)
    adapter = JobSpySource(settings, "zip_recruiter")
    results = [adapter.fetch("Engineer", f"United States {i}") for i in range(30)]
    assert len(calls) == BLOCK_TRIP_THRESHOLD  # no more requests once the block is clear
    skipped = [r for r in results if r.status == "skipped"]
    assert len(skipped) == 30 - BLOCK_TRIP_THRESHOLD
    notes = [e for r in skipped for e in r.errors]
    assert len(notes) == 1 and "remaining searches skipped" in notes[0]  # reported once


def test_board_that_returned_jobs_is_not_treated_as_blocked(settings, monkeypatch):
    calls = _blocked_jobspy(monkeypatch, status=429, jobs_after=0)  # returns jobs from the start
    adapter = JobSpySource(settings, "zip_recruiter")
    for i in range(10):
        assert adapter.fetch("Engineer", f"United States {i}").status == "success"
    assert len(calls) == 10 and not adapter.blocked


def test_normal_empty_search_is_still_a_success(settings, monkeypatch):
    module = types.ModuleType("jobspy")
    module.scrape_jobs = lambda **kwargs: pd.DataFrame()
    monkeypatch.setitem(sys.modules, "jobspy", module)
    result = JobSpySource(settings, "zip_recruiter").fetch("Engineer", "United States")
    assert result.status == "success" and not result.errors
