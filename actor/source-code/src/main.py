"""AutoRescue Apify actor entry point.

This actor scans carrier status or policy sources and emits structured delay
signals that the AutoRescue workflow can ingest. Each emitted dataset item
mirrors the incident shape consumed by the delay rescue workflow.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from apify import Actor
from bs4 import BeautifulSoup
from dateutil import parser as date_parser
from httpx import AsyncClient, HTTPStatusError, Limits, RequestError

DEFAULT_DELAY_PATTERNS = [
    r"\b(delay(ed)?|exception|service alert|operational issue)\b",
    r"\b(weather|storm|backlog)\b",
]
DEFAULT_IGNORE_PATTERNS = [
    r"\b(resolved|back to normal|cleared)\b",
    r"\b(delivered|delivery complete)\b",
]
DEFAULT_SOURCE_LABEL = "apify-actor#carrier-delay-scan"
DEFAULT_STATUS_CODE = "IN_TRANSIT_DELAYED"
DEFAULT_SNAPSHOT_CHARS = 420


@dataclass
class ActorSettings:
    default_delay_hours: float = 48.0
    min_delay_hours: float = 24.0
    snapshot_chars: int = DEFAULT_SNAPSHOT_CHARS
    source_label: str = DEFAULT_SOURCE_LABEL
    global_headers: Dict[str, str] = field(default_factory=dict)
    delay_patterns: Sequence[str] = field(default_factory=lambda: list(DEFAULT_DELAY_PATTERNS))
    ignore_patterns: Sequence[str] = field(default_factory=lambda: list(DEFAULT_IGNORE_PATTERNS))
    request_timeout: float = 12.0
    concurrency: int = 4
    carrier_status_code: str = DEFAULT_STATUS_CODE


@dataclass
class SourceConfig:
    url: str
    order_id: str
    carrier: Optional[str] = None
    region: Optional[str] = None
    incident_id: Optional[str] = None
    promised_delivery_date: Optional[str] = None
    expected_delay_hours: Optional[float] = None
    status_selectors: Sequence[str] = field(default_factory=list)
    eta_selectors: Sequence[str] = field(default_factory=list)
    promised_selectors: Sequence[str] = field(default_factory=list)
    status_paths: Sequence[str] = field(default_factory=list)
    eta_paths: Sequence[str] = field(default_factory=list)
    promised_paths: Sequence[str] = field(default_factory=list)
    delay_patterns: Sequence[str] = field(default_factory=list)
    ignore_patterns: Sequence[str] = field(default_factory=list)
    headers: Dict[str, str] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)
    min_delay_hours: Optional[float] = None
    content_mode: str = "auto"
    source_label: Optional[str] = None
    carrier_status_code: Optional[str] = None

    @classmethod
    def from_dict(cls, payload: Dict[str, Any], defaults: ActorSettings) -> "SourceConfig":
        if not isinstance(payload, dict):
            raise ValueError("Each source entry must be an object.")
        url = _clean_string(payload.get("url"))
        order_id = _clean_string(payload.get("orderId"))
        if not url or not order_id:
            raise ValueError('Each source requires "url" and "orderId".')

        def _patterns(value: Any, fallback: Sequence[str]) -> List[str]:
            items = _ensure_list(value)
            if items:
                return items
            return list(fallback)

        return cls(
            url=url,
            order_id=order_id,
            carrier=_clean_string(payload.get("carrier")),
            region=_clean_string(payload.get("region")),
            incident_id=_clean_string(payload.get("incidentId") or payload.get("incident_id")),
            promised_delivery_date=_clean_string(
                payload.get("promisedDeliveryDate") or payload.get("promised_delivery")
            ),
            expected_delay_hours=_to_float(payload.get("delayHours") or payload.get("expectedDelayHours")),
            status_selectors=_ensure_list(payload.get("statusSelectors")),
            eta_selectors=_ensure_list(payload.get("etaSelectors")),
            promised_selectors=_ensure_list(payload.get("promisedSelectors")),
            status_paths=_ensure_list(payload.get("statusPaths")),
            eta_paths=_ensure_list(payload.get("etaPaths")),
            promised_paths=_ensure_list(payload.get("promisedPaths")),
            delay_patterns=_patterns(payload.get("delayPatterns"), defaults.delay_patterns),
            ignore_patterns=_patterns(payload.get("ignorePatterns"), defaults.ignore_patterns),
            headers=_coerce_dict(payload.get("headers")),
            metadata=_coerce_dict(payload.get("metadata")),
            min_delay_hours=_to_float(payload.get("minDelayHours")),
            content_mode=(_clean_string(payload.get("mode")) or "auto").lower(),
            source_label=_clean_string(payload.get("sourceLabel")),
            carrier_status_code=_clean_string(payload.get("carrierStatusCode")),
        )


@dataclass
class PatternMatch:
    pattern: str
    text: str
    start: int
    end: int
    origin: str


async def main() -> None:
    async with Actor:
        input_payload = await Actor.get_input() or {}
        settings = _parse_settings(input_payload)
        sources = _parse_sources(input_payload, settings)
        if not sources:
            raise ValueError('Provide at least one entry in "sources".')

        limits = Limits(max_keepalive_connections=5, max_connections=max(2, settings.concurrency))
        async with AsyncClient(limits=limits, timeout=settings.request_timeout, follow_redirects=True) as client:
            semaphore = asyncio.Semaphore(settings.concurrency)

            async def _run_source(source: SourceConfig) -> Optional[Dict[str, Any]]:
                async with semaphore:
                    return await _evaluate_source(client, source, settings)

            results = await asyncio.gather(*[_run_source(source) for source in sources], return_exceptions=True)

        incidents: List[Dict[str, Any]] = []
        for idx, item in enumerate(results):
            if isinstance(item, Exception):
                Actor.log.error(f"Source #{idx}: {item}")
                continue
            if item:
                incidents.append(item)

        if not incidents:
            Actor.log.info("No delay incidents detected.")
            return

        await Actor.push_data(incidents)
        Actor.log.info(f"Pushed {len(incidents)} incident(s) to dataset.")


def _parse_settings(payload: Dict[str, Any]) -> ActorSettings:
    settings = ActorSettings()
    settings.default_delay_hours = _fallback_float(payload.get("defaultDelayHours"), settings.default_delay_hours)
    settings.min_delay_hours = _fallback_float(payload.get("minDelayHours"), settings.min_delay_hours)
    settings.snapshot_chars = int(payload.get("snapshotChars") or settings.snapshot_chars)
    settings.source_label = _clean_string(payload.get("sourceLabel")) or settings.source_label
    settings.global_headers = _coerce_dict(payload.get("requestHeaders"))
    settings.delay_patterns = _ensure_list(payload.get("delayPatterns")) or list(DEFAULT_DELAY_PATTERNS)
    settings.ignore_patterns = _ensure_list(payload.get("ignorePatterns")) or list(DEFAULT_IGNORE_PATTERNS)
    settings.request_timeout = _fallback_float(payload.get("requestTimeoutSeconds"), settings.request_timeout)
    settings.concurrency = max(1, min(int(payload.get("concurrency") or settings.concurrency), 10))
    status_code = _clean_string(payload.get("defaultCarrierStatusCode"))
    if status_code:
        settings.carrier_status_code = status_code
    return settings


def _parse_sources(payload: Dict[str, Any], settings: ActorSettings) -> List[SourceConfig]:
    try:
        normalized_sources = _coerce_sources_payload(payload.get("sources"))
    except ValueError as error:
        Actor.log.error(f"Invalid sources payload: {error}")
        normalized_sources = []

    if not normalized_sources and payload.get("url"):
        legacy_source = {
            "url": payload["url"],
            "orderId": payload.get("orderId") or "unknown-order",
            "promisedDeliveryDate": payload.get("promisedDeliveryDate"),
            "delayPatterns": payload.get("delayPatterns"),
        }
        normalized_sources = [legacy_source]

    sources: List[SourceConfig] = []
    for idx, entry in enumerate(normalized_sources or []):
        try:
            source = SourceConfig.from_dict(entry, settings)
        except ValueError as error:
            Actor.log.warning(f"Skipping source #{idx}: {error}")
            continue
        sources.append(source)
    return sources


async def _evaluate_source(client: AsyncClient, source: SourceConfig, settings: ActorSettings) -> Optional[Dict[str, Any]]:
    headers = {**settings.global_headers, **source.headers}
    try:
        response = await client.get(source.url, headers=headers)
        response.raise_for_status()
    except HTTPStatusError as error:
        Actor.log.error(f"{source.order_id}: HTTP {error.response.status_code} for {source.url}")
        return None
    except RequestError as error:
        Actor.log.error(f"{source.order_id}: request failure for {source.url}: {error}")
        return None

    content_type = response.headers.get("content-type", "").lower()
    body_text = response.text or ""

    status_text: Optional[str] = None
    estimated_raw: Optional[str] = None
    promised_raw: Optional[str] = source.promised_delivery_date
    page_text: str = _normalize_whitespace(body_text)

    is_json_mode = "application/json" in content_type or source.content_mode == "json"
    parsed_json: Any = None

    if is_json_mode:
        try:
            parsed_json = response.json()
        except json.JSONDecodeError as error:
            Actor.log.warning(f"{source.order_id}: unable to parse JSON body ({error})")
        else:
            status_text = _extract_from_json(parsed_json, source.status_paths)
            estimated_raw = _extract_from_json(parsed_json, source.eta_paths)
            promised_raw = promised_raw or _extract_from_json(parsed_json, source.promised_paths)
            page_text = _normalize_whitespace(json.dumps(parsed_json, default=str))
    else:
        soup = BeautifulSoup(body_text, "lxml")
        status_text = _extract_from_soup(soup, source.status_selectors)
        estimated_raw = _extract_from_soup(soup, source.eta_selectors)
        promised_raw = promised_raw or _extract_from_soup(soup, source.promised_selectors)
        page_text = _normalize_whitespace(soup.get_text(separator=" ", strip=True))

    if _matches_pattern(status_text, source.ignore_patterns) or _matches_pattern(page_text, source.ignore_patterns):
        Actor.log.info(f"{source.order_id}: ignore pattern matched; skipping.")
        return None

    match = _find_pattern(status_text, source.delay_patterns, origin="status")
    if not match:
        match = _find_pattern(page_text, source.delay_patterns, origin="body")
    if not match:
        Actor.log.info(f"{source.order_id}: no delay pattern matched.")
        return None

    context_snippet = _context_snippet(status_text if match.origin == "status" else page_text, match, settings.snapshot_chars)
    estimated_dt = _parse_datetime(estimated_raw or context_snippet)
    promised_dt = _parse_datetime(promised_raw)

    effective_min_delay = source.min_delay_hours or settings.min_delay_hours
    delay_hours = _determine_delay_hours(
        source.expected_delay_hours,
        promised_dt,
        estimated_dt,
        settings.default_delay_hours,
    )
    if delay_hours < effective_min_delay:
        Actor.log.info(f"{source.order_id}: detected delay ({delay_hours:.1f}h) below threshold ({effective_min_delay}h).")
        return None

    incident_id = _build_incident_id(source)
    status_description = status_text or match.text or "Carrier reported delay."
    estimated_iso = _to_iso(estimated_dt) or estimated_raw
    promised_iso = _to_iso(promised_dt) or promised_raw

    payload: Dict[str, Any] = {
        "incidentId": incident_id,
        "orderId": source.order_id,
        "delayHours": round(delay_hours, 2),
        "promisedDeliveryDate": promised_iso,
        "estimatedDelivery": estimated_iso,
        "carrierStatusCode": source.carrier_status_code or settings.carrier_status_code,
        "carrierStatusDescription": status_description,
        "detectedAt": _now_iso(),
        "source": source.source_label or settings.source_label,
        "carrier": source.carrier,
        "region": source.region,
        "rawStatusText": status_text,
        "rawEstimatedDelivery": estimated_raw,
        "rawPromisedDelivery": promised_raw,
        "rawSnapshot": context_snippet,
        "matchedPattern": match.pattern,
        "matchedText": match.text,
    }
    if source.metadata:
        payload["metadata"] = source.metadata

    return {key: value for key, value in payload.items() if value not in (None, "", [])}


def _extract_from_soup(soup: BeautifulSoup, selectors: Sequence[str]) -> Optional[str]:
    for selector in selectors or []:
        element = soup.select_one(selector)
        if element:
            text = _normalize_whitespace(element.get_text(separator=" ", strip=True))
            if text:
                return text
    return None


def _extract_from_json(payload: Any, paths: Sequence[str]) -> Optional[str]:
    for path in paths or []:
        value = _resolve_json_path(payload, path)
        if value is None:
            continue
        if isinstance(value, (str, int, float)):
            text = str(value)
        else:
            text = json.dumps(value, default=str)
        text = _normalize_whitespace(text)
        if text:
            return text
    return None


def _resolve_json_path(payload: Any, path: str) -> Any:
    if not isinstance(path, str):
        return None
    current: Any = payload
    tokens = [token for token in re.split(r"[.\[\]]", path) if token]
    for token in tokens:
        if isinstance(current, list):
            if token.isdigit():
                index = int(token)
                if 0 <= index < len(current):
                    current = current[index]
                else:
                    return None
            else:
                return None
        elif isinstance(current, dict):
            current = current.get(token)
        else:
            return None
    return current


def _find_pattern(text: Optional[str], patterns: Sequence[str], origin: str) -> Optional[PatternMatch]:
    if not text:
        return None
    for pattern in patterns or []:
        regex = pattern
        try:
            compiled = re.compile(regex, re.IGNORECASE)
        except re.error:
            compiled = re.compile(re.escape(regex), re.IGNORECASE)
        match = compiled.search(text)
        if match:
            return PatternMatch(pattern=pattern, text=match.group(0), start=match.start(), end=match.end(), origin=origin)
    return None


def _context_snippet(text: Optional[str], match: PatternMatch, size: int) -> Optional[str]:
    if not text:
        return None
    radius = max(size // 2, 80)
    start = max(match.start - radius, 0)
    end = min(match.end + radius, len(text))
    snippet = _normalize_whitespace(text[start:end])
    if len(snippet) > size:
        snippet = snippet[:size].rstrip()
    return snippet or None


def _determine_delay_hours(
    expected_delay_hours: Optional[float],
    promised: Optional[datetime],
    estimated: Optional[datetime],
    fallback: float,
) -> float:
    if expected_delay_hours and expected_delay_hours > 0:
        return expected_delay_hours
    if promised and estimated:
        delta = (estimated - promised).total_seconds() / 3600
        return max(delta, 0.0)
    return fallback


def _matches_pattern(text: Optional[str], patterns: Sequence[str]) -> bool:
    if not text:
        return False
    for pattern in patterns or []:
        try:
            compiled = re.compile(pattern, re.IGNORECASE)
        except re.error:
            compiled = re.compile(re.escape(pattern), re.IGNORECASE)
        if compiled.search(text):
            return True
    return False


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = date_parser.parse(value, fuzzy=True)
    except (ValueError, TypeError, OverflowError):
        return None
    if not dt.tzinfo:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt


def _to_iso(dt: Optional[datetime]) -> Optional[str]:
    if not dt:
        return None
    return dt.isoformat().replace("+00:00", "Z")


def _build_incident_id(source: SourceConfig) -> str:
    if source.incident_id:
        return source.incident_id
    base = f"{source.order_id}:{source.url}"
    digest = hashlib.md5(base.encode("utf-8"), usedforsecurity=False).hexdigest()[:8]
    return f"APIFY-{source.order_id}-{digest}".upper()


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _coerce_dict(value: Any) -> Dict[str, str]:
    if isinstance(value, dict):
        return {str(key): str(val) for key, val in value.items() if val is not None}
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            return {str(key): str(val) for key, val in parsed.items() if val is not None}
    return {}


def _ensure_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(item) for item in value if item not in (None, "")]
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            parts = [part.strip() for part in re.split(r"[\n,]+", stripped) if part.strip()]
            return parts or [stripped]
        else:
            if isinstance(parsed, (list, tuple, set)):
                return [str(item) for item in parsed if item not in (None, "")]
            if isinstance(parsed, str) and parsed.strip():
                return [parsed.strip()]
            return []
    return [str(value)]


def _clean_string(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _coerce_sources_payload(value: Any) -> List[Dict[str, Any]]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as error:
            raise ValueError(f"sources must be JSON; {error.msg}") from error
        value = parsed
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return list(value)
    raise ValueError("sources must be a JSON array of objects.")


def _to_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _fallback_float(value: Any, fallback: float) -> float:
    result = _to_float(value)
    if result is None:
        return fallback
    return result
