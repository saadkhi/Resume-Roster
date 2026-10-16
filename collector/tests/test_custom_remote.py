from __future__ import annotations

from datetime import datetime, timezone

from scrapers.custom_remote import (
    HackerNewsHiringSource,
    RemoteOKSource,
    WeWorkRemotelySource,
)


class FakeResponse:
    def __init__(self, payload=None, content: bytes = b"", status_code: int = 200):
        self.payload = payload
        self.content = content
        self.status_code = status_code
        self.headers: dict[str, str] = {}

    def json(self):
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeSession:
    def __init__(self, routes):
        self.routes = routes

    def get(self, url, **kwargs):
        response = self.routes[url]
        if isinstance(response, list):
            response = response.pop(0)
        return response


def test_remote_ok_maps_feed_fields_and_skips_metadata(settings):
    session = FakeSession(
        {
            "https://remoteok.com/api": FakeResponse(
                [
                    {"legal": "feed attribution"},
                    {
                        "id": "100",
                        "position": "Python Engineer",
                        "company": "Acme",
                        "location": "Worldwide",
                        "url": "https://remoteOK.com/remote-jobs/python-engineer-acme-100",
                        "date": "2026-10-12T08:00:00+00:00",
                        "tags": ["python", "backend"],
                        "salary_min": 100000,
                        "salary_max": 140000,
                        "description": "<p>Build Python systems</p>",
                    },
                ]
            )
        }
    )
    result = RemoteOKSource(settings, session).fetch()
    assert result.status == "success"
    assert len(result.jobs) == 1
    assert result.jobs[0]["title"] == "Python Engineer"
    assert result.jobs[0]["job_url"].startswith("https://remoteOK.com/")
    assert result.jobs[0]["tags"] == "python, backend"
    assert result.jobs[0]["is_remote"] is True


def test_remote_ok_malformed_json_is_reported(settings):
    session = FakeSession({"https://remoteok.com/api": FakeResponse(ValueError("bad JSON"))})
    result = RemoteOKSource(settings, session).fetch()
    assert result.status == "failed"
    assert "bad JSON" in result.errors[0]


def test_we_work_remotely_parses_rss_and_ignores_incomplete_items(settings):
    xml = b"""<?xml version="1.0"?>
    <rss><channel>
      <item>
        <title>Acme: Senior Python Engineer</title>
        <link>https://jobs.example/acme-python</link>
        <pubDate>Mon, 12 Oct 2026 08:00:00 GMT</pubDate>
        <category>Programming</category>
        <description><![CDATA[<p>Build reliable services</p>]]></description>
      </item>
      <item><title>Incomplete listing</title></item>
    </channel></rss>"""
    session = FakeSession({"https://weworkremotely.com/remote-jobs.rss": FakeResponse(content=xml)})
    result = WeWorkRemotelySource(settings, session).fetch()
    assert result.status == "success"
    assert len(result.jobs) == 1
    assert result.jobs[0]["title"] == "Senior Python Engineer"
    assert result.jobs[0]["company"] == "Acme"
    assert result.jobs[0]["tags"] == "Programming"


def test_we_work_remotely_invalid_xml_is_reported(settings):
    session = FakeSession(
        {"https://weworkremotely.com/remote-jobs.rss": FakeResponse(content=b"<rss><channel>")}
    )
    result = WeWorkRemotelySource(settings, session).fetch()
    assert result.status == "failed"
    assert "invalid XML" in result.errors[0]


def test_hacker_news_uses_official_api_and_accepts_only_explicit_vacancies(settings):
    now = datetime.now(timezone.utc)
    thread = {
        "id": 1,
        "title": f"Ask HN: Who is hiring? ({now:%B %Y})",
        "time": int(now.timestamp()),
        "kids": [2, 3],
    }
    routes = {
        "https://hacker-news.firebaseio.com/v0/user/whoishiring.json": FakeResponse(
            {"submitted": [1]}
        ),
        "https://hacker-news.firebaseio.com/v0/item/1.json": FakeResponse(thread),
        "https://hacker-news.firebaseio.com/v0/item/2.json": FakeResponse(
            {
                "id": 2,
                "time": int(now.timestamp()),
                "text": (
                    "<p>Company: Acme</p><p>Role: Python Engineer</p><p>Location: Pakistan</p>"
                ),
            }
        ),
        "https://hacker-news.firebaseio.com/v0/item/3.json": FakeResponse(
            {"id": 3, "text": "<p>Hiring engineers. Email us.</p>"}
        ),
    }
    result = HackerNewsHiringSource(settings, FakeSession(routes)).fetch()
    assert result.status == "success"
    assert len(result.jobs) == 1
    assert result.jobs[0]["title"] == "Python Engineer"
    assert result.jobs[0]["company"] == "Acme"
    assert result.jobs[0]["job_url"] == "https://news.ycombinator.com/item?id=2"
    assert "lower_confidence" in result.jobs[0]["tags"]


def test_hacker_news_pipe_header_format():
    from scrapers.custom_remote import _parse_hn_vacancy

    job = _parse_hn_vacancy(
        {"id": 9, "text": "Acme | Python Engineer | Remote | Full-time<p>We build things</p>"}, 1
    )
    assert job["company"] == "Acme"
    assert job["title"] == "Python Engineer"
    assert job["location"] == "Remote"
    assert _parse_hn_vacancy({"id": 10, "text": "Hiring engineers, email us"}, 1) is None
