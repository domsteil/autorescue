## Purpose
- translates carrier status or policy endpoints into AutoRescue-ready delay incidents
- fuses deterministic selectors/JSON paths with keyword heuristics for resilient monitoring
- preserves snippets, metadata, and delay math required by the delay rescue workflow

## Input configuration
1. Define one or more `sources` with `orderId` and `url`. Add `carrier`, `region`, or custom `metadata` for downstream routing.
2. (Optional) Provide `statusSelectors` / `statusPaths`, `etaSelectors` / `etaPaths`, and `promisedSelectors` / `promisedPaths` so the actor can read structured values deterministically.
3. (Optional) Override pattern lists per source (`delayPatterns`, `ignorePatterns`) or globally (`defaultDelayHours`, `minDelayHours`, `defaultCarrierStatusCode`). Supply patterns as JSON arrays or newline-separated strings.
4. Adjust platform knobs like `concurrency`, `requestTimeoutSeconds`, `snapshotChars`, and `requestHeaders` to match carrier SLAs.

Full schema lives in `.actor/input_schema.json` and mirrors these options.

### Example payload
```json
{
  "defaultDelayHours": 48,
  "sources": [
    {
      "orderId": "ORD-1001",
      "carrier": "MockExpress",
      "region": "us",
      "url": "https://status.example.com/orders/ORD-1001",
      "statusSelectors": ["#status-banner"],
      "etaSelectors": ["[data-testid=eta]"],
      "promisedDeliveryDate": "2024-03-19T20:00:00Z"
    }
  ]
}
```

## Dataset output
- emits one row per detected delay with the fields expected by `mapDatasetItemToIncident`
- includes computed `delayHours`, normalized iso timestamps, carrier codes, and snippets for observability

```json
{
  "incidentId": "APIFY-ORD-1001-5B91A3F2",
  "orderId": "ORD-1001",
  "delayHours": 48,
  "promisedDeliveryDate": "2024-03-19T20:00:00Z",
  "estimatedDelivery": "2024-03-21T16:00:00Z",
  "carrierStatusCode": "IN_TRANSIT_DELAYED",
  "carrierStatusDescription": "Weather exception at hub",
  "detectedAt": "2024-03-18T15:32:10Z",
  "source": "apify-actor#carrier-delay-scan",
  "carrier": "MockExpress",
  "region": "us",
  "rawSnapshot": "Weather exception at hub has delayed packages departing Louisville..."
}
```

The worker layer forwards these dataset items to the `carrier-events` topic and kicks off the AutoRescue delay workflow.

## Local development
1. Install dependencies and run locally
   ```bash
   pip install -r requirements.txt
   apify run
   ```
2. Provide input via the Apify Console run form or by editing `storage/key_value_stores/default/INPUT.json`.
3. Inspect results under `storage/datasets/default/` or forward them with `python/apify_signal_runner.py`.

## Integration notes
- configure an Apify webhook to `apps/server/index.js` so finished runs publish directly to Redpanda
- pair scheduled runs with the `python/apify_signal_runner.py` helper when you need CLI automation
- before committing schema tweaks, run `jq . actor/source-code/.actor/input_schema.json` to double-check formatting
