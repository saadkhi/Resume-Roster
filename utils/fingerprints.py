"""Stable identity hashes for normalized job vacancies."""

from __future__ import annotations

import hashlib
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit

TRACKING_PARAMS = frozenset(
    {
        "fbclid",
        "gclid",
        "mc_cid",
        "mc_eid",
        "ref",
        "source",
        "utm_campaign",
        "utm_medium",
        "utm_source",
        "utm_term",
    }
)


def canonicalize_url(url: str | None) -> str:
    if not url:
        return ""
    value = url.strip()
    parts = urlsplit(value if "://" in value else f"https://{value}")
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    try:
        parsed_port = parts.port
    except ValueError:
        return ""
    port = f":{parsed_port}" if parsed_port and parsed_port not in {80, 443} else ""
    path = re.sub(r"/{2,}", "/", parts.path).rstrip("/")
    query = sorted(
        (key, item)
        for key, item in parse_qsl(parts.query, keep_blank_values=True)
        if key.lower() not in TRACKING_PARAMS
    )
    query_string = urlencode(query)
    return f"{host}{port}{path}" + (f"?{query_string}" if query_string else "")


def _clean(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).strip().casefold().split())


def generate_unique_hash(job: dict[str, Any]) -> str:
    """Hash stable identifying fields; mutable text/salary never affect identity."""
    components = (
        _clean(job.get("site") or job.get("source")),
        _clean(job.get("company")),
        _clean(job.get("title")),
        canonicalize_url(job.get("job_url") or job.get("url")),
    )
    payload = "\x1f".join(components).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()
