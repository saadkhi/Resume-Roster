"""Validated application configuration loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

DEFAULT_QUERIES = (
    "Python Engineer",
    "Python Developer",
    "AI Engineer",
    "Machine Learning Engineer",
    "Generative AI Engineer",
    "LLM Engineer",
    "Data Scientist",
    "Data Engineer",
    "Backend Developer",
    "Full Stack Developer",
    "Software Engineer",
    "MLOps Engineer",
    "Computer Vision Engineer",
    "Automation Engineer",
)
DEFAULT_LOCATIONS = (
    "Remote / Worldwide",
    "Pakistan",
    "United Kingdom",
    "United States",
    "Canada",
    "Germany",
    "Netherlands",
    "Italy",
    "United Arab Emirates",
    "Saudi Arabia",
)

# These identifiers are advertised by JobSpy 1.3.0. Its README explicitly
# states that the google identifier is currently unavailable.
JOBSPY_SITES = frozenset(
    {
        "linkedin",
        "indeed",
        "glassdoor",
        "zip_recruiter",
        "bayt",
        "naukri",
        "bdjobs",
        "hellowork",
    }
)
SOURCE_NAMES = frozenset({"remote_ok", "we_work_remotely", "hacker_news"})


def _csv_values(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None or not value.strip():
        return default
    return tuple(part.strip() for part in value.split(",") if part.strip())


def _int_env(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name)
    try:
        value = default if raw is None else int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


def _float_env(name: str, default: float, minimum: float = 0.0) -> float:
    raw = os.getenv(name)
    try:
        value = default if raw is None else float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw!r}") from exc
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    queries: tuple[str, ...]
    locations: tuple[str, ...]
    jobspy_sites: tuple[str, ...]
    enabled_sources: tuple[str, ...]
    max_results_per_query: int
    job_max_age_hours: int
    request_timeout_seconds: int
    max_retries: int
    backoff_base_seconds: float
    backoff_max_seconds: float
    max_concurrent_requests: int
    linkedin_min_interval_seconds: float
    random_delay_min_seconds: float
    random_delay_max_seconds: float
    max_execution_seconds: int
    database_url: str
    log_level: str
    export_formats: tuple[str, ...]
    enable_csv_export: bool
    enable_json_export: bool
    output_dir: Path
    proxy_url: str | None
    hn_max_comments: int
    hn_story_scan_limit: int


def load_config() -> Settings:
    """Load and validate environment configuration; defaults need no secrets."""
    load_dotenv()
    queries = _csv_values(os.getenv("SEARCH_QUERIES"), DEFAULT_QUERIES)
    locations = _csv_values(os.getenv("SEARCH_LOCATIONS"), DEFAULT_LOCATIONS)
    sites = _csv_values(os.getenv("JOBSPY_SITES"), ("indeed", "linkedin"))
    sources = _csv_values(
        os.getenv("ENABLED_SOURCES"),
        ("remote_ok", "we_work_remotely", "hacker_news"),
    )
    formats = tuple(
        value.lower() for value in _csv_values(os.getenv("EXPORT_FORMATS"), ("csv", "json"))
    )
    if not queries:
        raise ValueError("SEARCH_QUERIES must contain at least one non-empty query")
    if not locations:
        raise ValueError("SEARCH_LOCATIONS must contain at least one non-empty location")
    unsupported_sites = sorted(set(sites) - JOBSPY_SITES)
    if unsupported_sites:
        raise ValueError(
            "Unsupported JobSpy site identifier(s): "
            + ", ".join(unsupported_sites)
            + ". Google Jobs is currently unavailable in JobSpy."
        )
    unknown_sources = sorted(set(sources) - SOURCE_NAMES)
    if unknown_sources:
        raise ValueError("Unknown ENABLED_SOURCES value(s): " + ", ".join(unknown_sources))
    if not formats or set(formats) - {"csv", "json"}:
        raise ValueError("EXPORT_FORMATS may contain only csv and json")

    minimum_delay = _float_env("RANDOM_DELAY_MIN_SECONDS", 0.0)
    maximum_delay = _float_env("RANDOM_DELAY_MAX_SECONDS", 0.0)
    if maximum_delay < minimum_delay:
        raise ValueError(
            "RANDOM_DELAY_MAX_SECONDS must be greater than or equal to RANDOM_DELAY_MIN_SECONDS"
        )

    proxies = _csv_values(os.getenv("PROXIES_LIST"), ())
    if len(proxies) > 1:
        raise ValueError(
            "Configure at most one authorized proxy in PROXIES_LIST; proxy rotation "
            "is intentionally unsupported."
        )
    proxy_url = proxies[0] if proxies else None
    if proxy_url:
        parsed_proxy = urlsplit(proxy_url)
        if parsed_proxy.scheme not in {"http", "https"} or not parsed_proxy.hostname:
            raise ValueError("PROXIES_LIST must contain a valid http:// or https:// proxy URL")

    log_level = os.getenv("LOG_LEVEL", "INFO").upper()
    if log_level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        raise ValueError("LOG_LEVEL must be DEBUG, INFO, WARNING, ERROR, or CRITICAL")

    backoff_base = _float_env("BACKOFF_BASE_SECONDS", 1.0)
    backoff_max = _float_env("BACKOFF_MAX_SECONDS", 30.0)
    if backoff_max < backoff_base:
        raise ValueError(
            "BACKOFF_MAX_SECONDS must be greater than or equal to BACKOFF_BASE_SECONDS"
        )

    return Settings(
        queries=queries,
        locations=locations,
        jobspy_sites=sites,
        enabled_sources=sources,
        max_results_per_query=_int_env("MAX_RESULTS_PER_QUERY", 30),
        job_max_age_hours=_int_env("JOB_MAX_AGE_HOURS", 1),
        request_timeout_seconds=_int_env("REQUEST_TIMEOUT_SECONDS", 20),
        max_retries=_int_env("MAX_RETRIES", 3, minimum=0),
        backoff_base_seconds=backoff_base,
        backoff_max_seconds=backoff_max,
        max_concurrent_requests=_int_env("MAX_CONCURRENT_REQUESTS", 4),
        linkedin_min_interval_seconds=_float_env("LINKEDIN_MIN_INTERVAL_SECONDS", 10.0),
        random_delay_min_seconds=minimum_delay,
        random_delay_max_seconds=maximum_delay,
        max_execution_seconds=_int_env("MAX_EXECUTION_SECONDS", 1800),
        database_url=os.getenv("DATABASE_URL", "sqlite:///jobs.db"),
        log_level=log_level,
        export_formats=formats,
        enable_csv_export=os.getenv("ENABLE_CSV_EXPORT", "true").lower() in {"1", "true", "yes"},
        enable_json_export=os.getenv("ENABLE_JSON_EXPORT", "true").lower() in {"1", "true", "yes"},
        output_dir=Path(os.getenv("OUTPUT_DIR", "output")),
        proxy_url=proxy_url,
        hn_max_comments=_int_env("HN_MAX_COMMENTS", 100),
        hn_story_scan_limit=_int_env("HN_STORY_SCAN_LIMIT", 200),
    )
