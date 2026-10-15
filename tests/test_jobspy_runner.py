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
