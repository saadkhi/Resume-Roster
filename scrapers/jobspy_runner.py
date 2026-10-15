"""Optional JobSpy adapter for explicitly advertised JobSpy board identifiers."""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any

import pandas as pd

from config import Settings
from scrapers.base import SourceResult

logger = logging.getLogger(__name__)


class _LinkedInRateLimitHandler(logging.Handler):
    def __init__(self, rate_limited: threading.Event):
        super().__init__(logging.ERROR)
        self.rate_limited = rate_limited

    def emit(self, record: logging.LogRecord) -> None:
        if "429" in record.getMessage():
            self.rate_limited.set()


INDEED_COUNTRIES = {
    "united states": "USA",
    "usa": "USA",
    "united kingdom": "UK",
    "uk": "UK",
    "canada": "Canada",
    "germany": "Germany",
    "netherlands": "Netherlands",
    "italy": "Italy",
    "pakistan": "Pakistan",
    "united arab emirates": "United Arab Emirates",
    "saudi arabia": "Saudi Arabia",
}


def _jobspy_country(location: str | None) -> str | None:
    if not location or location.casefold().startswith("remote"):
        return None
    return INDEED_COUNTRIES.get(location.strip().casefold())


def _to_records(data: Any) -> list[dict[str, Any]]:
    if data is None:
        return []
    if isinstance(data, pd.DataFrame):
        return data.where(pd.notna(data), None).to_dict(orient="records")
    if isinstance(data, list):
        return [dict(row) for row in data if isinstance(row, dict)]
    raise TypeError(f"JobSpy returned unsupported result type: {type(data).__name__}")


class JobSpySource:
    def __init__(self, settings: Settings, site_name: str):
        self.settings = settings
        self.site_name = site_name
        self._linkedin_lock = threading.Lock()
        self._linkedin_rate_limited = threading.Event()
        self._last_linkedin_call: float | None = None

    @property
    def name(self) -> str:
        return f"jobspy:{self.site_name}"

    def fetch(self, query: str | None = None, location: str | None = None) -> SourceResult:
        result = SourceResult(source_name=self.name)
        if not query or not location:
            result.errors.append("JobSpy searches require both query and location")
            result.status = "failed"
            result.finish()
            return result
        if self.site_name == "linkedin" and self._linkedin_rate_limited.is_set():
            result.status = "skipped"
            result.finish()
            result.status = "skipped"
            return result
        try:
            from jobspy import scrape_jobs

            country = _jobspy_country(location)
            if self.site_name in {"indeed", "glassdoor"} and country is None:
                result.status = "skipped"
                result.finish()
                result.status = "skipped"
                return result

            kwargs: dict[str, Any] = {
                "site_name": self.site_name,
                "search_term": query,
                "location": "Remote" if location.casefold().startswith("remote") else location,
                "results_wanted": self.settings.max_results_per_query,
                "hours_old": self.settings.job_max_age_hours,
                "verbose": 0,
                "fetch_description": False,
            }
            if location.casefold().startswith("remote"):
                kwargs["is_remote"] = True
            if country and self.site_name in {"indeed", "glassdoor"}:
                kwargs["country_indeed"] = country
            if self.settings.proxy_url:
                kwargs["proxies"] = [self.settings.proxy_url]
            try:
                if self.site_name == "linkedin":
                    raw_result, skipped = self._scrape_linkedin(scrape_jobs, kwargs)
                    if skipped:
                        result.status = "skipped"
                        result.finish()
                        result.status = "skipped"
                        return result
                    if self._linkedin_rate_limited.is_set():
                        result.errors.append(
                            "LinkedIn returned HTTP 429; remaining LinkedIn searches "
                            "are paused for this run."
                        )
                else:
                    raw_result = scrape_jobs(**kwargs)
                raw_jobs = _to_records(raw_result)
                result.jobs.extend(raw_jobs)
            except Exception as exc:
                if self.site_name == "linkedin" and "429" in str(exc):
                    self._linkedin_rate_limited.set()
                logger.exception(
                    "JobSpy site search failed",
                    extra={"query": query, "location": location, "source": self.site_name},
                )
                if self.site_name == "linkedin" and self._linkedin_rate_limited.is_set():
                    result.errors.append(
                        "LinkedIn returned HTTP 429; remaining LinkedIn searches "
                        "are paused for this run."
                    )
                else:
                    result.errors.append(f"{self.site_name}: {type(exc).__name__}: {exc}")
        except ImportError as exc:
            logger.exception("JobSpy dependency unavailable")
            result.errors.append(f"JobSpy dependency unavailable: {exc}")
        except Exception as exc:
            logger.exception(
                "JobSpy search failed",
                extra={"query": query, "location": location, "source": self.name},
            )
            result.errors.append(f"{type(exc).__name__}: {exc}")
        result.finish()
        if result.finished_at is None:
            result.finished_at = datetime.now(timezone.utc)
        return result

    def _scrape_linkedin(
        self, scrape_jobs: Any, kwargs: dict[str, Any]
    ) -> tuple[Any, bool]:
        with self._linkedin_lock:
            if self._linkedin_rate_limited.is_set():
                return None, True
            if self._last_linkedin_call is not None:
                elapsed = time.monotonic() - self._last_linkedin_call
                delay = self.settings.linkedin_min_interval_seconds - elapsed
                if delay > 0:
                    time.sleep(delay)
            self._last_linkedin_call = time.monotonic()
            linkedin_logger = logging.getLogger("JobSpy:LinkedIn")
            handler = _LinkedInRateLimitHandler(self._linkedin_rate_limited)
            linkedin_logger.addHandler(handler)
            try:
                return scrape_jobs(**kwargs), False
            except Exception as exc:
                if "429" in str(exc):
                    self._linkedin_rate_limited.set()
                raise
            finally:
                linkedin_logger.removeHandler(handler)
