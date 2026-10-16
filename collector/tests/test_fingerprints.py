from __future__ import annotations

from utils.fingerprints import canonicalize_url, generate_unique_hash


def test_fingerprint_is_stable_for_url_tracking_variants():
    first = {
        "site": "Remote OK",
        "company": " Acme  Labs ",
        "title": "Python Engineer",
        "job_url": "https://www.remoteok.com/jobs/abc?utm_source=mail&id=123#details",
    }
    second = {
        "site": "remote ok",
        "company": "acme labs",
        "title": " python engineer ",
        "job_url": "https://remoteok.com/jobs/abc?id=123",
        "description": "mutable data does not participate",
    }
    assert generate_unique_hash(first) == generate_unique_hash(second)


def test_meaningful_job_identifier_is_preserved_in_url():
    canonical = canonicalize_url("https://jobs.example/role?id=one&utm_source=x")
    other_job = canonicalize_url("https://jobs.example/role?id=two")
    assert canonical == "jobs.example/role?id=one"
    assert canonical != other_job
