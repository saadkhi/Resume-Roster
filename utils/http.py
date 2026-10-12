"""Bounded GET retries for retryable transport and server errors."""

from __future__ import annotations

import email.utils
import logging
import random
import time
from datetime import datetime, timezone
from typing import Any

import requests

logger = logging.getLogger(__name__)
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            parsed = email.utils.parsedate_to_datetime(value)
            return max(0.0, (parsed - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


def get_with_retry(
    url: str,
    *,
    timeout: int,
    max_retries: int,
    backoff_base: float,
    backoff_max: float,
    proxies: dict[str, str] | None = None,
    session: requests.Session | Any = requests,
) -> requests.Response:
    """GET with bounded exponential backoff; 403 and other 4xx never retry."""
    for attempt in range(max_retries + 1):
        try:
            response = session.get(url, timeout=timeout, proxies=proxies)
        except requests.RequestException:
            if attempt >= max_retries:
                raise
            delay = min(backoff_max, backoff_base * (2**attempt))
            delay += random.uniform(0, min(0.25, delay))
            logger.warning("HTTP request failed; retrying", extra={"attempt": attempt + 1})
            time.sleep(delay)
            continue
        if response.status_code not in RETRYABLE_STATUS or attempt >= max_retries:
            response.raise_for_status()
            return response
        delay = _retry_after(response.headers.get("Retry-After"))
        if delay is None:
            delay = min(backoff_max, backoff_base * (2**attempt))
            delay += random.uniform(0, min(0.25, delay))
        logger.warning(
            "Retryable HTTP status; retrying",
            extra={"attempt": attempt + 1, "status_code": response.status_code},
        )
        time.sleep(min(backoff_max, delay))
    raise RuntimeError("HTTP retry loop ended unexpectedly")
