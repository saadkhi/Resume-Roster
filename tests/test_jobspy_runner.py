from __future__ import annotations

import sys
import types

import pandas as pd

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
    adapter = JobSpySource(settings)
    result = adapter.fetch("Engineer", "Remote / Worldwide")
    assert calls[0]["site_name"] == "linkedin"
    assert calls[0]["is_remote"] is True
    assert "country_indeed" not in calls[0]
    assert len(result.jobs) == 1
    assert result.errors


def test_country_mapping_passes_correct_indeed_country(settings, monkeypatch):
    calls = []
    module = types.ModuleType("jobspy")
    module.scrape_jobs = lambda **kwargs: calls.append(kwargs) or pd.DataFrame()
    monkeypatch.setitem(sys.modules, "jobspy", module)
    adapter = JobSpySource(settings)
    adapter.fetch("Engineer", "Pakistan")
    assert calls[0]["country_indeed"] == "Pakistan"


def test_jobspy_failure_is_returned_as_source_error(settings, monkeypatch):
    module = types.ModuleType("jobspy")

    def fail(**kwargs):
        raise RuntimeError("upstream refused the request")

    module.scrape_jobs = fail
    monkeypatch.setitem(sys.modules, "jobspy", module)
    result = JobSpySource(settings).fetch("Engineer", "Pakistan")
    assert result.status == "failed"
    assert "upstream refused" in result.errors[0]


def test_failed_board_does_not_discard_success_from_another_board(
    settings, monkeypatch
):
    module = types.ModuleType("jobspy")

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

    module.scrape_jobs = scrape_jobs
    monkeypatch.setitem(sys.modules, "jobspy", module)
    result = JobSpySource(settings).fetch("Engineer", "Pakistan")
    assert len(result.jobs) == 1
    assert result.status == "partial"
    assert "indeed: RuntimeError: board unavailable" in result.errors
