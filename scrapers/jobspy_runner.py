"""Optional JobSpy adapter for explicitly advertised JobSpy board identifiers."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import pandas as pd

from config import Settings
from scrapers.base import SourceResult

logger = logging.getLogger(__name__)

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
    name = "jobspy"

    def __init__(self, settings: Settings):
        self.settings = settings

    def fetch(self, query: str | None = None, location: str | None = None) -> SourceResult:
        result = SourceResult(source_name=self.name)
        if not query or not location:
            result.errors.append("JobSpy searches require both query and location")
            result.status = "failed"
            result.finish()
            return result
        try:
            from jobspy import scrape_jobs

            country = _jobspy_country(location)
            sites = list(self.settings.jobspy_sites)
            if country is None:
                sites = [site for site in sites if site not in {"indeed", "glassdoor"}]
                if set(self.settings.jobspy_sites) & {"indeed", "glassdoor"}:
                    result.errors.append(
                        "Indeed/Glassdoor skipped for this location because JobSpy "
                        "requires an explicit country_indeed value."
                    )
            if not sites:
                result.status = "failed"
                result.finish()
                return result

            for site in sites:
                kwargs: dict[str, Any] = {
                    "site_name": site,
                    "search_term": query,
                    "location": (
                        "Remote" if location.casefold().startswith("remote") else location
                    ),
                    "results_wanted": self.settings.max_results_per_query,
                    "hours_old": self.settings.job_max_age_hours,
                    "verbose": 0,
                    "fetch_description": False,
                }
                if location.casefold().startswith("remote"):
                    kwargs["is_remote"] = True
                if country and site in {"indeed", "glassdoor"}:
                    kwargs["country_indeed"] = country
                if self.settings.proxy_url:
                    kwargs["proxies"] = [self.settings.proxy_url]
                try:
                    raw_jobs = _to_records(scrape_jobs(**kwargs))
                    result.jobs.extend(raw_jobs)
                except Exception as exc:
                    logger.exception(
                        "JobSpy site search failed",
                        extra={"query": query, "location": location, "source": site},
                    )
                    result.errors.append(f"{site}: {type(exc).__name__}: {exc}")
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
