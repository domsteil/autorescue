#!/usr/bin/env python3
"""
Utility for running Apify actors and translating dataset items into AutoRescue delay incidents.

Endpoints used:
- POST /v2/acts/{actorId}/runs            — start an actor run
- GET  /v2/actor-runs/{runId}             — poll run status (waitForFinish)
- GET  /v2/datasets/{datasetId}/items     — retrieve structured results
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional
from urllib import error, parse, request

APIFY_BASE_URL = os.environ.get("APIFY_BASE_URL", "https://api.apify.com")


def _default_headers(token: str) -> Dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }


class ApifyClient:
    def __init__(self, token: str, base_url: str = APIFY_BASE_URL):
        if not token:
            raise ValueError("APIFY_TOKEN is required.")
        self.token = token
        self.base_url = base_url.rstrip("/")

    def _build_url(self, path: str, params: Optional[Dict[str, Any]] = None) -> str:
        url = f"{self.base_url}{path}"
        if params:
            query = parse.urlencode(params)
            url = f"{url}?{query}"
        return url

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        payload: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        url = self._build_url(path, params)
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")

        req = request.Request(
            url,
            data=data,
            headers={**_default_headers(self.token), **(headers or {})},
            method=method,
        )
        try:
            with request.urlopen(req) as resp:
                content_type = resp.headers.get("Content-Type", "")
                body = resp.read()
                if "application/json" in content_type:
                    return json.loads(body.decode("utf-8") or "null")
                return body
        except error.HTTPError as exc:
            response_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Apify request {method} {path} failed ({exc.code}): {response_body}"
            ) from exc

    def start_actor_run(
        self,
        actor_id: str,
        *,
        payload: Optional[Dict[str, Any]] = None,
        timeout: Optional[int] = None,
        memory: Optional[int] = None,
        build: Optional[str] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {}
        if timeout is not None:
            params["timeout"] = timeout
        if memory is not None:
            params["memory"] = memory
        if build:
            params["build"] = build
        result = self._request(
            "POST", f"/v2/acts/{actor_id}/runs", params=params, payload=payload or {}
        )
        run = result.get("data") if isinstance(result, dict) else result
        if isinstance(run, dict):
            return run
        return result

    def get_run(self, run_id: str, wait_for_finish: Optional[int] = None) -> Dict[str, Any]:
        params = {"waitForFinish": wait_for_finish} if wait_for_finish else None
        return self._request("GET", f"/v2/actor-runs/{run_id}", params=params)

    def get_dataset_items(
        self,
        dataset_id: str,
        *,
        limit: Optional[int] = None,
        clean: bool = True,
    ) -> Iterable[Dict[str, Any]]:
        params: Dict[str, Any] = {"format": "json"}
        if limit is not None:
            params["limit"] = limit
        if clean:
            params["clean"] = "1"
        result = self._request("GET", f"/v2/datasets/{dataset_id}/items", params=params)
        if isinstance(result, list):
            return result
        if isinstance(result, str):
            try:
                return json.loads(result)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    f"Unable to parse dataset response for {dataset_id}: {result}"
                ) from exc
        raise RuntimeError(f"Unexpected dataset response for {dataset_id}: {result!r}")


@dataclass
class IncidentBuilderConfig:
    min_delay_hours: int = 24


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def item_to_incident(item: Dict[str, Any], config: IncidentBuilderConfig) -> Optional[Dict[str, Any]]:
    delay_hours = item.get("delayHours") or item.get("delay_hours")
    if delay_hours is None:
        return None
    try:
        delay_hours = float(delay_hours)
    except (TypeError, ValueError):
        return None
    if delay_hours < config.min_delay_hours:
        return None

    incident_id = item.get("incidentId") or item.get("id") or item.get("trackingNumber")
    order_id = item.get("orderId") or item.get("order_id")
    if not order_id:
        return None

    carrier_status = {
        "code": item.get("carrierStatusCode") or item.get("statusCode") or "DELAYED",
        "description": item.get("carrierStatusDescription")
        or item.get("statusDescription")
        or "Carrier reported delay.",
        "estimatedDelivery": item.get("estimatedDelivery")
        or item.get("eta")
        or item.get("estimated_delivery"),
    }

    incident = {
        "incidentId": f"APIFY-{incident_id}" if incident_id else f"APIFY-{order_id}",
        "type": "shipment_delay",
        "orderId": order_id,
        "detectedAt": item.get("detectedAt") or _iso_now(),
        "carrierStatus": carrier_status,
        "promisedDeliveryDate": item.get("promisedDeliveryDate")
        or item.get("promised_delivery"),
        "delayHours": delay_hours,
        "source": "apify-actor",
    }

    extra_fields = {
        key: value
        for key, value in item.items()
        if key not in {"delayHours", "orderId", "incidentId", "trackingNumber"}
    }
    incident["raw"] = extra_fields
    return incident


def load_json(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path: str, payload: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def parse_static_headers(raw_value: Optional[str]) -> Dict[str, str]:
    if not raw_value:
        return {}
    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"REDPANDA_STATIC_HEADERS is not valid JSON: {raw_value}"
        ) from exc
    if not isinstance(parsed, dict):
        raise ValueError("REDPANDA_STATIC_HEADERS must decode to an object.")
    return {str(key): str(value) for key, value in parsed.items()}


def produce_to_redpanda(topic: Optional[str], incident: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    base_url = os.environ.get("REDPANDA_HTTP_BASE_URL")
    if not base_url or not topic:
        return None

    api_key = os.environ.get("REDPANDA_API_KEY")
    header_name = os.environ.get("REDPANDA_AUTH_HEADER", "Authorization")
    scheme = os.environ.get("REDPANDA_AUTH_SCHEME", "Bearer")
    static_headers = parse_static_headers(os.environ.get("REDPANDA_STATIC_HEADERS"))

    url = f"{base_url.rstrip('/')}/topics/{parse.quote(topic, safe='')}"
    payload = {
        "records": [
            {
                "key": incident.get("orderId"),
                "value": {
                    "type": "shipment_delay",
                    "payload": incident,
                },
            }
        ]
    }
    headers = {
        "Accept": "application/vnd.kafka.v2+json",
        "Content-Type": "application/vnd.kafka.json.v2+json",
        **static_headers,
    }
    if api_key and header_name:
        headers[header_name] = f"{scheme} {api_key}" if scheme else api_key

    req = request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with request.urlopen(req) as resp:
        content_type = resp.headers.get("Content-Type", "")
        body_bytes = resp.read()
        body_text = body_bytes.decode("utf-8") if body_bytes else ""
        if "application/json" in content_type:
            return json.loads(body_text or "null")
        return {"status": resp.status, "body": body_text}


def run_actor_flow(args: argparse.Namespace) -> None:
    token = args.token or os.environ.get("APIFY_TOKEN")
    actor_id = args.actor_id or os.environ.get("APIFY_ACTOR_ID")
    if not token:
        raise SystemExit("APIFY_TOKEN is required (set env or --token).")
    if not actor_id and not args.dataset_id:
        raise SystemExit("Provide --actor-id or --dataset-id.")

    client = ApifyClient(token, base_url=args.base_url)

    dataset_id = args.dataset_id
    if not dataset_id:
        payload = load_json(args.input) if args.input else None
        if payload and 'sources' in payload and not payload.get('url'):
            first = payload['sources'][0] if payload['sources'] else None
            if first and first.get('url'):
                payload.setdefault('url', first.get('url'))
            if first and first.get('orderId'):
                payload.setdefault('orderId', first.get('orderId'))
        try:
            run_meta = client.start_actor_run(
                actor_id,
                payload=payload,
                timeout=args.timeout,
                memory=args.memory,
                build=args.build,
            )
        except RuntimeError as exc:
            raise RuntimeError(
                "Apify actor run failed. Ensure required fields (e.g., 'url') "
                "are present in the input. Use python/sample_apify_input.json "
                "as a template. Original error: "
                f"{exc}"
            ) from exc
        run_id = run_meta.get("id")
        if not run_id:
            raise RuntimeError(f"Actor run response missing id: {run_meta}")

        run = client.get_run(run_id, wait_for_finish=args.wait_for_finish)
        status = run.get("status")
        if status not in {"SUCCEEDED", "SUCCEEDED_WITHOUT_CUSTOMER_ERRORS"}:
            raise RuntimeError(f"Actor run {run_id} finished with status {status}")
        dataset_id = run.get("defaultDatasetId")
        if not dataset_id:
            raise RuntimeError(f"Actor run {run_id} did not publish a default dataset.")

    items = list(client.get_dataset_items(dataset_id, limit=args.limit))
    if args.dataset_dump:
        save_json(args.dataset_dump, items)

    builder_cfg = IncidentBuilderConfig(min_delay_hours=args.min_delay_hours)
    incident = None
    for item in items:
        incident = item_to_incident(item, builder_cfg)
        if incident:
            break

    if not incident:
        raise RuntimeError(
            f"No dataset items met criteria (limit={args.limit}, min_delay_hours={args.min_delay_hours})"
        )

    output_path = args.output or "../data/events/apify-generated-event.json"
    save_json(output_path, incident)
    redpanda_publication = None
    try:
        publish_response = produce_to_redpanda(
            os.environ.get("REDPANDA_EVENTS_TOPIC"), incident
        )
        if publish_response is not None:
            redpanda_publication = {
                "topic": os.environ.get("REDPANDA_EVENTS_TOPIC"),
                "status": "published",
                "response": publish_response,
            }
    except Exception as exc:  # noqa: BLE001
        redpanda_publication = {
            "topic": os.environ.get("REDPANDA_EVENTS_TOPIC"),
            "status": "failed",
            "error": str(exc),
        }

    print(
        json.dumps(
            {
                "output": output_path,
                "datasetId": dataset_id,
                "selectedIncidentId": incident["incidentId"],
                "orderId": incident["orderId"],
                "delayHours": incident["delayHours"],
                "redpanda": redpanda_publication,
            },
            indent=2,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run an Apify actor and emit AutoRescue-ready delay incidents."
    )
    parser.add_argument("--token", help="Apify API token (defaults to APIFY_TOKEN env).")
    parser.add_argument("--base-url", default=APIFY_BASE_URL, help="Apify base URL.")
    parser.add_argument("--actor-id", help="Actor id or username~actor.")
    parser.add_argument("--dataset-id", help="Skip run and read existing dataset.")
    parser.add_argument("--input", help="JSON payload to send as actor INPUT.")
    parser.add_argument("--output", help="Where to store the generated incident JSON.")
    parser.add_argument("--dataset-dump", help="Optional path to store raw dataset items.")
    parser.add_argument("--timeout", type=int, help="Run timeout in seconds.")
    parser.add_argument("--memory", type=int, help="Memory limit in MB.")
    parser.add_argument("--build", help="Specific actor build to run.")
    parser.add_argument(
        "--wait-for-finish",
        type=int,
        default=60,
        help="Seconds to wait for actor completion on each poll (default 60).",
    )
    parser.add_argument("--limit", type=int, default=20, help="Maximum dataset items to fetch.")
    parser.add_argument(
        "--min-delay-hours",
        type=int,
        default=24,
        help="Minimum delay (in hours) required for the incident to be surfaced.",
    )
    return parser


def main(argv: Optional[Iterable[str]] = None) -> None:
    parser = build_parser()
    parser.add_argument("--version", action="version", version="apify-signal-runner 0.1.0")
    args = parser.parse_args(argv)

    try:
        run_actor_flow(args)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
