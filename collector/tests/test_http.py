from __future__ import annotations

from tests.test_custom_remote import FakeResponse
from utils.http import get_with_retry


def test_http_429_honors_retry_after_and_retries(monkeypatch):
    sleeps = []
    monkeypatch.setattr("utils.http.time.sleep", sleeps.append)
    first = FakeResponse(status_code=429)
    first.headers["Retry-After"] = "0"
    session = type(
        "Session",
        (),
        {"get": lambda self, *args, **kwargs: responses.pop(0)},
    )()
    responses = [first, FakeResponse()]
    result = get_with_retry(
        "https://feed.example",
        timeout=1,
        max_retries=2,
        backoff_base=1,
        backoff_max=3,
        session=session,
    )
    assert result.status_code == 200
    assert sleeps == [0.0]


def test_http_403_is_not_retried():
    calls = []

    class Forbidden(FakeResponse):
        def raise_for_status(self):
            raise RuntimeError("403 forbidden")

    session = type(
        "Session",
        (),
        {"get": lambda self, *args, **kwargs: calls.append(args[0]) or Forbidden(status_code=403)},
    )()
    try:
        get_with_retry(
            "https://feed.example",
            timeout=1,
            max_retries=5,
            backoff_base=1,
            backoff_max=3,
            session=session,
        )
    except RuntimeError as exc:
        assert "403" in str(exc)
    else:
        raise AssertionError("403 should have raised")
    assert len(calls) == 1
