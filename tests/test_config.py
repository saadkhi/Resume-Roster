from __future__ import annotations

import pytest

from config import DEFAULT_LOCATIONS, DEFAULT_QUERIES, load_config


def test_defaults_are_loaded(settings):
    assert settings.queries == ("Python Developer",)
    assert settings.locations == ("Pakistan",)
    assert settings.max_results_per_query == 30
    assert settings.job_max_age_hours == 1
    assert "Pakistan" in DEFAULT_LOCATIONS
    assert "Python Engineer" in DEFAULT_QUERIES


def test_empty_action_variable_uses_search_defaults(settings, monkeypatch):
    monkeypatch.setenv("SEARCH_QUERIES", "")
    monkeypatch.setenv("SEARCH_LOCATIONS", "")
    config = load_config()
    assert config.queries == DEFAULT_QUERIES
    assert config.locations == DEFAULT_LOCATIONS


def test_unknown_jobspy_site_fails_actionably(settings, monkeypatch):
    monkeypatch.setenv("JOBSPY_SITES", "google")
    with pytest.raises(ValueError, match="Google Jobs is currently unavailable"):
        load_config()


def test_invalid_retry_count_fails(settings, monkeypatch):
    monkeypatch.setenv("MAX_RETRIES", "-1")
    with pytest.raises(ValueError, match="MAX_RETRIES must be at least 0"):
        load_config()


def test_multiple_proxies_are_not_rotated(settings, monkeypatch):
    monkeypatch.setenv("PROXIES_LIST", "https://proxy-one.invalid,https://proxy-two.invalid")
    with pytest.raises(ValueError, match="at most one authorized proxy"):
        load_config()
