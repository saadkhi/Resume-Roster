"""Public-feed adapters for Remote OK, We Work Remotely, and Hacker News."""

from __future__ import annotations

import html
import logging
import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any

import requests
from bs4 import BeautifulSoup

from config import Settings
from scrapers.base import SourceResult
from utils.http import get_with_retry

logger = logging.getLogger(__name__)
REMOTE_OK_URL = "https://remoteok.com/api"
WWR_RSS_URL = "https://weworkremotely.com/remote-jobs.rss"
HN_BASE_URL = "https://hacker-news.firebaseio.com/v0"


def _proxies(settings: Settings) -> dict[str, str] | None:
    if not settings.proxy_url:
        return None
    return {"http": settings.proxy_url, "https": settings.proxy_url}


def _get(
    url: str,
    settings: Settings,
    *,
    session: Any = requests,
) -> requests.Response:
    return get_with_retry(
        url,
        timeout=settings.request_timeout_seconds,
        max_retries=settings.max_retries,
        backoff_base=settings.backoff_base_seconds,
        backoff_max=settings.backoff_max_seconds,
        proxies=_proxies(settings),
        session=session,
    )


def _plain_text(value: Any) -> str | None:
    if value is None:
        return None
    clean = BeautifulSoup(html.unescape(str(value)), "html.parser").get_text(" ", strip=True)
    return re.sub(r"\s+", " ", clean).strip() or None


class RemoteOKSource:
    """Remote OK's public JSON feed; preserves the feed's original job URL."""

    name = "remote_ok"

    def __init__(self, settings: Settings, session: Any = requests):
        self.settings = settings
        self.session = session

    def fetch(self, query: str | None = None, location: str | None = None) -> SourceResult:
        del query, location
        result = SourceResult(source_name=self.name)
        try:
            response = _get(REMOTE_OK_URL, self.settings, session=self.session)
            payload = response.json()
            if not isinstance(payload, list):
                raise ValueError("Remote OK response must be a JSON array")
            for item in payload:
                if not isinstance(item, dict) or not item.get("position"):
                    continue
                job_url = item.get("url")
                if not isinstance(job_url, str) or not job_url.startswith("https://"):
                    continue
                result.jobs.append(
                    {
                        "site": "Remote OK",
                        "job_id": item.get("id"),
                        "title": item.get("position"),
                        "company": item.get("company"),
                        "location": item.get("location") or "Remote",
                        "job_url": job_url,
                        "description": _plain_text(item.get("description")),
                        "tags": ", ".join(item.get("tags", []))
                        if isinstance(item.get("tags"), list)
                        else None,
                        "date_posted": item.get("date"),
                        "min_amount": item.get("salary_min"),
                        "max_amount": item.get("salary_max"),
                        "currency": item.get("salary_currency"),
                        "is_remote": True,
                        "workplace_type": "remote",
                    }
                )
        except Exception as exc:
            logger.exception("Remote OK fetch failed", extra={"source": self.name})
            result.errors.append(f"{type(exc).__name__}: {exc}")
        result.finish()
        return result


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].casefold()


def _xml_child(element: ET.Element, name: str) -> str | None:
    for child in element.iter():
        if child is not element and _local_name(child.tag) == name.casefold():
            return child.text.strip() if child.text and child.text.strip() else None
    return None


def _company_and_title(title: str, author: str | None) -> tuple[str | None, str | None]:
    # The public feed commonly formats titles as "Company: Role". Do not guess
    # a company name when neither this format nor a feed author is present.
    if ":" in title:
        company, role = title.split(":", 1)
        if company.strip() and role.strip():
            return company.strip(), role.strip()
    if author and title.strip():
        return author.strip(), title.strip()
    return None, None


class WeWorkRemotelySource:
    """Public We Work Remotely RSS feed; attribution remains in each record."""

    name = "we_work_remotely"

    def __init__(self, settings: Settings, session: Any = requests):
        self.settings = settings
        self.session = session

    def fetch(self, query: str | None = None, location: str | None = None) -> SourceResult:
        del query, location
        result = SourceResult(source_name=self.name)
        try:
            response = _get(WWR_RSS_URL, self.settings, session=self.session)
            try:
                root = ET.fromstring(response.content)
            except ET.ParseError as exc:
                raise ValueError(f"We Work Remotely returned invalid XML: {exc}") from exc
            for item in root.iter():
                if _local_name(item.tag) != "item":
                    continue
                title = _xml_child(item, "title")
                link = _xml_child(item, "link")
                if not title or not link:
                    continue
                company, role = _company_and_title(
                    title, _xml_child(item, "creator") or _xml_child(item, "author")
                )
                if not company or not role:
                    continue
                result.jobs.append(
                    {
                        "site": "We Work Remotely",
                        "job_id": link,
                        "title": role,
                        "company": company,
                        "location": _xml_child(item, "location"),
                        "job_url": link,
                        "description": _plain_text(_xml_child(item, "description")),
                        "tags": _xml_child(item, "category"),
                        "date_posted": _xml_child(item, "pubdate"),
                        "is_remote": True,
                        "workplace_type": "remote",
                    }
                )
        except Exception as exc:
            logger.exception("We Work Remotely fetch failed", extra={"source": self.name})
            result.errors.append(f"{type(exc).__name__}: {exc}")
        result.finish()
        return result


def _parse_hn_vacancy(comment: dict[str, Any], thread_id: int) -> dict[str, Any] | None:
    """Accept only explicit Company:/Role: comments; leave ambiguous posts alone."""
    raw_text = comment.get("text")
    if not isinstance(raw_text, str):
        return None
    soup = BeautifulSoup(html.unescape(raw_text), "html.parser")
    text = soup.get_text("\n", strip=True)
    company_match = re.search(r"(?im)^\s*(?:company|employer)\s*:\s*(.+?)\s*$", text)
    role_match = re.search(r"(?im)^\s*(?:role|position|job title)\s*:\s*(.+?)\s*$", text)
    if not company_match or not role_match:
        return None
    company = company_match.group(1).strip()
    title = role_match.group(1).strip()
    if not company or not title:
        return None
    location_match = re.search(r"(?im)^\s*location\s*:\s*(.+?)\s*$", text)
    comment_id = comment.get("id")
    if not isinstance(comment_id, int):
        return None
    timestamp = comment.get("time")
    date_posted = (
        datetime.fromtimestamp(timestamp, timezone.utc)
        if isinstance(timestamp, (int, float))
        else None
    )
    return {
        "site": "Hacker News (community thread)",
        "job_id": str(comment_id),
        "title": title,
        "company": company,
        "location": location_match.group(1).strip() if location_match else None,
        "job_url": f"https://news.ycombinator.com/item?id={comment_id}",
        "description": text,
        "date_posted": date_posted,
        "tags": f"monthly_hiring_thread; lower_confidence; thread_id={thread_id}",
    }


class HackerNewsHiringSource:
    """Find the current month's hiring thread through the official HN Firebase API."""

    name = "hacker_news"

    def __init__(self, settings: Settings, session: Any = requests):
        self.settings = settings
        self.session = session

    def _json(self, path: str) -> Any:
        response = _get(
            f"{HN_BASE_URL}/{path}",
            self.settings,
            session=self.session,
        )
        return response.json()

    def fetch(self, query: str | None = None, location: str | None = None) -> SourceResult:
        del query, location
        result = SourceResult(source_name=self.name)
        try:
            story_ids = self._json("askstories.json")
            if not isinstance(story_ids, list):
                raise ValueError("Hacker News askstories response must be an array")
            now = datetime.now(timezone.utc)
            thread: dict[str, Any] | None = None
            scan_ids = story_ids[: self.settings.hn_story_scan_limit]
            # Check small batches so discovery is faster without fanning out an
            # unbounded number of requests to the public API.
            for start in range(0, len(scan_ids), 4):
                batch = scan_ids[start : start + 4]
                with ThreadPoolExecutor(max_workers=4) as executor:
                    futures = {
                        executor.submit(self._json, f"item/{story_id}.json"): story_id
                        for story_id in batch
                    }
                    for future in as_completed(futures):
                        try:
                            story = future.result()
                        except Exception as exc:
                            logger.warning(
                                "Hacker News story lookup failed",
                                extra={"source": self.name},
                                exc_info=True,
                            )
                            result.errors.append(f"story request: {type(exc).__name__}: {exc}")
                            continue
                        if not isinstance(story, dict):
                            continue
                        created = story.get("time")
                        if not isinstance(created, (int, float)):
                            continue
                        posted = datetime.fromtimestamp(created, timezone.utc)
                        title = _plain_text(story.get("title")) or ""
                        if (posted.year, posted.month) == (
                            now.year,
                            now.month,
                        ) and "who is hiring" in title.casefold():
                            thread = story
                            break
                if thread:
                    break
            if thread is None:
                result.errors.append(
                    "Current-month 'Who is hiring?' thread was not found in the "
                    f"latest {self.settings.hn_story_scan_limit} Ask HN stories."
                )
                result.finish()
                return result

            thread_id = thread.get("id")
            comment_ids = thread.get("kids", [])
            if not isinstance(thread_id, int) or not isinstance(comment_ids, list):
                raise ValueError("Hacker News hiring thread has malformed identifiers")
            candidate_ids = comment_ids[: self.settings.hn_max_comments]

            def fetch_comment(comment_id: int) -> dict[str, Any] | None:
                comment = self._json(f"item/{comment_id}.json")
                if (
                    isinstance(comment, dict)
                    and not comment.get("deleted")
                    and not comment.get("dead")
                ):
                    return comment
                return None

            with ThreadPoolExecutor(max_workers=self.settings.max_concurrent_requests) as executor:
                futures = [executor.submit(fetch_comment, item_id) for item_id in candidate_ids]
                for future in as_completed(futures):
                    try:
                        comment = future.result()
                        if comment:
                            job = _parse_hn_vacancy(comment, thread_id)
                            if job:
                                result.jobs.append(job)
                    except Exception as exc:
                        logger.warning(
                            "Hacker News comment fetch failed",
                            extra={"source": self.name},
                            exc_info=True,
                        )
                        result.errors.append(f"comment request: {type(exc).__name__}: {exc}")
        except Exception as exc:
            logger.exception("Hacker News fetch failed", extra={"source": self.name})
            result.errors.append(f"{type(exc).__name__}: {exc}")
        result.finish()
        return result
