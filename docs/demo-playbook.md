# Demo Playbook

## Prerequisites
- Sync `apify-actor/` directory to your Apify actor (package.json + src/main.js) so the sources array drives live carrier scraping.
- `.env.local` populated (Airia, Redpanda, Apify, Sentry credentials)
- Servers running: `npm run server:start`, `npm run worker:start`
- Ensure `DECISION_LOG_PATH` and `OUTBOX_DIR` are set for audit and replay

## Quick System Check
1. List deployments and agent cards: `npm run airia:check`
2. Verify Redpanda connectivity: `npm run kafka:check`
3. Provision project/agent (if needed): `npm run airia:bootstrap "Demo Project" "Demo Agent"`
4. Seed Apify incident: `npm run apify:run` (uses python/sample_apify_input.json, writes to outbox if Redpanda unreachable)
5. (Optional) Simulate ingestion: `SIMULATE_REDPANDA=1 npm run publish:test-event -- carrier-events`

## Hackathon end-to-end demo
1. Offline pitch: `npm run demo:e2e` uses the sample incident, Airia simulation, and Redpanda outbox so it runs without external services. Add `-- --demo` if you want to force this mode when live env vars are present.
2. Live pipeline: `npm run demo:e2e -- --live --apify` calls Apify (dataset or actor), Airia, Redpanda, and Sentry. Ensure `.env.local` includes `APIFY_TOKEN`, `APIFY_DATASET_ID` (or `APIFY_ACTOR_ID`), `AIRIA_API_KEY`, `AIRIA_DEPLOYMENT_ID`, Redpanda credentials, and `SENTRY_TOKEN`. When running an actor without a custom payload, the script auto-loads `python/sample_apify_input.json`.
3. Narrate the console summary (incident context, tool call, tasks, next steps) while showing the `Services` section to confirm which integrations executed.
4. Open `outbox/carrier-events.jsonl` and `outbox/autorescue-actions.jsonl` after the offline run, or share Sentry/Redpanda dashboards for the live run.
5. Add `-- --raw` to either command if judges want the full JSON payload.

## Live Incident Walkthrough
1. Trigger Apify actor run (Console or schedule)
2. Webhook logs dataset ingestion (Apps/server logs / Sentry breadcrumb)
3. Worker consumes event, enforces policy guard, hits Airia, outputs action (dry run available via `npm run airia:test`).
4. Sentry spans show AutoRescue decision, release + deploy entries
5. Present action plan / decision summary via `npm run decision:report`

## Recovery & Replay
- If Redpanda is unavailable during the demo, events/actions fall into `outbox/`
- Replay after connectivity returns with `npm run outbox:replay`
- Run `npm run publish:test-event` to prove the pipeline post-fix

## Metrics to Share
- `npm run decision:report $DECISION_LOG_PATH`
- Sentry: releases per incident, deploy confirmations
- Optional dashboard: load worker logs or outbox counts in real time
