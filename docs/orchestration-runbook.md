# Orchestration Runbook

## Environment Bootstrap
- Store credentials in `.env.local` (already provided).
- Before running commands, execute `set -a; source .env.local` to export vars in the current shell.
- Override or add temporary values on the command line as needed for testing.

## Prepare Airia Agent Assets
- `npm run airia:bootstrap` handles required fields (empty arrays for models, api keys, prompts, memories, pipelines, data sources).
- Create/check project + agent via `npm run airia:bootstrap [projectName] [agentName]`.
- Verify your deployment and agent card anytime with `npm run airia:check`; the script lists available deployments/cards and confirms `AIRIA_DEPLOYMENT_ID` resolves.
- Review `config/airia-agent.json` and replace the placeholder `projectId`, `pipelineId`, and descriptive copy with real values from your tenant.
- Export `AIRIA_API_KEY`, `AIRIA_PROJECT_ID`, and optionally `AIRIA_CORRELATION_ID`, then run `npm run airia:setup` (optionally pass an alternative config path as the first argument).
- The script reads the OpenAPI-backed `/v1/AgentCard` and `/v1/Deployments` endpoints to ensure your agent card exists and to locate a matching deployment. When found, it prints the resolved `AIRIA_DEPLOYMENT_ID` for reuse in subsequent runs.
- If no deployment is returned, the output highlights which identifiers still need to be created in Airia’s UI or builder.

## Generate Carrier Delay Signals (Apify)
- Apify Actor source lives in `apify-actor/src/main.js` (sync with Apify console). It accepts `sources` array with `{ url, orderId, carrier?, region? }` entries and pushes matched incidents.
- Export an Apify token: `export APIFY_TOKEN=...`. For the standalone helper call `python python/apify_signal_runner.py --actor-id username~carrier-delay --output ../data/events/apify-generated-event.json`.
- Prefer the Node workflow for an integrated path: `npm run workflow:apify -- --summary` runs `POST /v2/acts/{actorId}/runs`, polls `GET /v2/actor-runs/{runId}` with `waitForFinish`, and fetches dataset items through `GET /v2/datasets/{datasetId}/items`. Provide `APIFY_ACTOR_ID`, `APIFY_DATASET_ID`, or pass `--apify-dataset DATASET_ID` as needed. For a quick smoke test use `npm run apify:run`, which loads `python/sample_apify_input.json` and streams the results into the pipeline.
- Optional: craft a custom input payload (JSON) and pass it via `--apify-input` (see `python/sample_apify_input.json` which satisfies the actor's required `url` field).
- Both runners emit a normalized AutoRescue incident only when `delayHours >= APIFY_MIN_DELAY_HOURS` (default 24), ensuring downstream flows work with policy-relevant cases.

## Webhook Ingestion Service (Apify → Redpanda)
- Optional: set `SERVER_HOST`/`SERVER_PORT` (defaults 127.0.0.1:3000). If the port is unavailable, the service now falls back to an ephemeral port and logs the binding.
- To persist every ingest, set `INCIDENT_LOG_PATH` (coming soon) — decisions are logged by the worker via `DECISION_LOG_PATH`.

- Run `npm install` (Node >= 18 recommended for Sentry SDK).
- Start the webhook server with `npm run server:start` (sources `.env.local` if you `set -a; source .env.local`).. It verifies `APIFY_HOOK_SECRET`, fetches dataset items via `GET /v2/datasets/{datasetId}/items`, normalizes incidents, and publishes them to `REDPANDA_EVENTS_TOPIC`.
- Configure your Apify Actor webhook to `POST https://<your_host>/webhook/apify` with the shared secret.
- Logs and Sentry breadcrumbs capture dataset ids, incident counts, and publish outcomes.

## Decision Worker (Redpanda → Airia → Sentry)
- Optional: `AUTO_CREATE_TOPICS=1` makes the worker attempt to create `REDPANDA_EVENTS_TOPIC`/`REDPANDA_ACTIONS_TOPIC` on startup (requires admin privileges).

- Ensure `AIRIA_DEPLOYMENT_ID`, `AIRIA_API_KEY`, and Redpanda credentials are exported.
- Launch the worker with `npm run worker:start` (after exporting credentials, e.g., `set -a; source .env.local`).. It consumes `REDPANDA_EVENTS_TOPIC`, invokes Airia via `POST /v1/JobOrchestration`, validates results, and publishes enriched actions to `REDPANDA_ACTIONS_TOPIC`.
- The worker reuses `config/policy.json` and records Sentry releases/deploys referenced in the workflow output.

## Run AutoRescue Decision Workflow (Airia)
- Quick test: `npm run airia:test [eventPath]` executes the workflow against Airia (or simulation mode) and prints the decision JSON. Use this to confirm agent behavior before running the full pipeline.
- Provide Airia credentials: `export AIRIA_API_KEY=...`, `export AIRIA_PROJECT_ID=...`, and the active deployment id with `export AIRIA_DEPLOYMENT_ID=...`.
- To operate against the live API run `node src/index.js --event ../data/events/apify-generated-event.json --summary` (or reuse `--apify`). Add `--output artifacts/run.json` to persist the full response. The workflow enqueues an `AgentExecution` job through `POST /v1/JobOrchestration` and polls `GET /v1/JobOrchestration/{id}` plus `/result` for the decision payload.
- For offline demonstrations set `SIMULATE_AIRIA=1` and the workflow will fall back to `data/simulations/airia-decision.json`.
- Inspect the structured plan emitted on stdout; downstream workers can iterate through `actionPlan.tasks` to invoke Shopify, Stripe, Twilio, or other sponsor APIs for end-to-end execution.

## Stream Incidents and Actions (Redpanda)
- Local dry-run: set `SIMULATE_REDPANDA=1` to skip live brokers and write all events/actions to the Outbox instead (replay later with `npm run outbox:replay`).

- Use `npm run outbox:replay [outboxDir] [topicOverride]` to flush offline events/actions once connectivity is restored.

- If Redpanda is unreachable, set `OUTBOX_DIR=outbox` (default) to capture events/actions as JSONL files for replay once connectivity returns.

- Export Redpanda HTTP proxy details: `export REDPANDA_HTTP_BASE_URL=https://<cluster>.http.proxy.serverless.redpanda.cloud`, `export REDPANDA_API_KEY=...`, and optionally `export REDPANDA_AUTH_HEADER=Authorization`, `export REDPANDA_AUTH_SCHEME=Bearer`.
- Choose the topics: `export REDPANDA_EVENTS_TOPIC=carrier-events` for inbound incidents and `export REDPANDA_ACTIONS_TOPIC=agent-actions` for downstream decisions. Additional static headers can be supplied via `REDPANDA_STATIC_HEADERS='{"X-Custom":"value"}'`.
- When the Python Apify runner finishes, it posts the generated incident to `/topics/{REDPANDA_EVENTS_TOPIC}` using the HTTP proxy.
- For direct Kafka access (lower latency, no HTTP proxy), provide `export REDPANDA_CLUSTER_ID=...` plus SASL credentials (`export REDPANDA_USERNAME=...`, `export REDPANDA_PASSWORD=...`, `export REDPANDA_MECHANISM=SCRAM-SHA-256`) or override the broker list with `REDPANDA_BROKERS=broker1:9092,broker2:9092`. Set `REDPANDA_REGION` if your cluster hostnames include a region segment (for example, `us-west-2`).
- The Node workflow publishes both the original incident envelope and the resulting `actionPlan` to every configured Redpanda client, enabling follow-on workers (analytics, replay, alerting) to consume the streams immediately after each run.

## Observability Notes (Sentry)
- Provide `export SENTRY_TOKEN=...` along with `export SENTRY_ORG_SLUG=...` and `export SENTRY_PROJECT_SLUG=...` (omit the latter two to auto-select the first accessible org/project). Override the API host with `SENTRY_BASE_URL` when targeting self-hosted instances.
- Each run creates or reuses a Sentry release whose version is `autorescue-{incidentId}` via `POST /api/0/organizations/{org}/releases/` and records a deploy through `POST /api/0/organizations/{org}/releases/{version}/deploys/`, embedding the policy proof.
- The workflow also looks up recent issues using `GET /api/0/organizations/{org}/issues/?query={orderId}` and surfaces matching items alongside the action plan for instant triage context.

## Simulation Run
- To dry-run the workflow without hitting Airia, execute `npm run workflow:simulate`.
- The command reads `data/events/sample-delay-event.json`, forces `SIMULATE_AIRIA=1`, and prints a run summary so you can verify Redpanda/Sentry wiring before touching production credentials.

## Analytics
- Aggregate outcome stats with `npm run decision:report <DECISION_LOG_PATH>` to summarise actions taken and policy overrides.

- Validate broker connectivity anytime with `npm run kafka:check`; outputs topic list if credentials are correct.

- Push a smoke-test incident into the pipeline with `npm run publish:test-event [topic] [eventFile]` (defaults to REDPANDA_EVENTS_TOPIC and `data/events/sample-delay-event.json`).

## End-to-End Orchestration
1. Start services: `npm run server:start` and `npm run worker:start`.
2. Trigger an incident via Apify (scheduled run or `python python/apify_signal_runner.py ...`).
3. Watch worker logs / Sentry trace for Airia decisions and action tasks.
4. Summarise results with `npm run decision:report <DECISION_LOG_PATH>` and share metrics in the demo.
5. If Redpanda is unreachable mid-demo, events fall into `outbox/`; replay later with `npm run outbox:replay`.

## Demo Highlight Prompts
- Decision summary: `npm run decision:report $DECISION_LOG_PATH`
- Incident replay: `npm run outbox:replay`
- Quick smoke test: `npm run publish:test-event -- $REDPANDA_EVENTS_TOPIC`
- Agent verification: `npm run airia:check`
