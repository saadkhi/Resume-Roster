from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import db
from api import create_app


def _job(n: int, **extra):
    base = {
        "site": "Remote OK",
        "title": f"Python Engineer {n}",
        "company": f"Acme {n}",
        "location": "Pakistan" if n % 2 else "Germany",
        "job_url": f"https://example.com/jobs/{n}",
        "description": "Build APIs",
        "date_posted": datetime.now(timezone.utc) - timedelta(hours=n * 10),
        "is_remote": bool(n % 2),
        "tags": "python; backend",
    }
    base.update(extra)
    return base


@pytest.fixture
def client(settings):
    app = create_app()
    db.bulk_insert_jobs([_job(i) for i in range(1, 6)] + [_job(9, site="Indeed", title="Chef")])
    return TestClient(app)


def test_health_and_listing(client):
    assert client.get("/health").json() == {"status": "ok", "jobs": 6}
    body = client.get("/jobs", params={"limit": 2}).json()
    assert body["total"] == 6 and len(body["items"]) == 2
    first = body["items"][0]
    assert first["tags"] == ["python", "backend"]
    assert "description" not in first
    assert body["items"][0]["date_posted"] >= body["items"][1]["date_posted"]


def test_filters(client):
    assert client.get("/jobs", params={"q": "chef"}).json()["total"] == 1
    assert client.get("/jobs", params={"source": "indeed"}).json()["total"] == 1
    assert client.get("/jobs", params={"location": "pakistan"}).json()["total"] == 4
    assert client.get("/jobs", params={"remote": "true"}).json()["total"] == 4
    assert client.get("/jobs", params={"posted_within_hours": 25}).json()["total"] == 2
    assert client.get("/jobs", params={"q": "%"}).json()["total"] == 0


def test_detail_sources_and_validation(client):
    item = client.get("/jobs", params={"include_description": "true"}).json()["items"][0]
    assert item["description"] == "Build APIs"
    assert client.get(f"/jobs/{item['id']}").json()["id"] == item["id"]
    assert client.get("/jobs/nope").status_code == 404
    assert {s["source"] for s in client.get("/sources").json()} == {"Remote OK", "Indeed"}
    assert client.get("/jobs", params={"limit": 1000}).status_code == 422


def test_api_key_enforced_when_configured(client, monkeypatch):
    monkeypatch.setenv("API_KEY", "secret")
    assert client.get("/jobs").status_code == 401
    assert client.get("/jobs", headers={"X-API-Key": "wrong"}).status_code == 401
    assert client.get("/jobs", headers={"X-API-Key": "secret"}).status_code == 200
    assert client.get("/health").status_code == 200
