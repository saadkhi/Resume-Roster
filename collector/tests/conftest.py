from __future__ import annotations

import pytest

from config import load_config
from db import init_db


@pytest.fixture
def settings(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv("LOG_LEVEL", "CRITICAL")
    monkeypatch.setenv("SEARCH_QUERIES", "Python Developer")
    monkeypatch.setenv("SEARCH_LOCATIONS", "Pakistan")
    monkeypatch.setenv("JOBSPY_SITES", "indeed,linkedin")
    monkeypatch.setenv("ENABLED_SOURCES", "remote_ok,we_work_remotely,hacker_news")
    monkeypatch.setenv("MAX_RETRIES", "0")
    return load_config()


@pytest.fixture
def database(settings):
    init_db(settings.database_url)
    yield
