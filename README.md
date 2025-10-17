# AutoRescue workflows

AutoRescue stitches Airia orchestration, Apify automations, and sponsor APIs into a post-purchase rescue loop that detects delay/payment incidents and resolves them via policy-backed agents. Start with `OVERVIEW.md` for the narrative and `auto-rescue-usecase.md` for the detailed journey log.

## Repository overview
- `src` holds the workflow entrypoint (`index.js`), shared utilities, and orchestration helpers.
- `apps/` contains the demo server, worker, and dashboard shells used in live walkthroughs.
- `scripts/` bundles operational helpers (Kafka checks, decision reports, manual replays).
- `data/` stores sample events, outbox payloads, and replay fixtures for demos.
- `airia-web-apis.json` is the OpenAPI 3.1 contract; lint it before committing changes.
- `auto-rescue-usecase.md` and `docs/` capture the scenario narrative, policy notes, and outreach playbooks.
- `AGENTS.md` lists shipped agents, triggers, and evaluation datasets.

## Getting started
1. Install Node.js 18+ and `npm install` dependencies from the repo root.
2. Copy the redacted `.env` template to `.env.local`, populate sandbox tokens (Shopify, Twilio, Airia), and keep production secrets outside the repo.
3. Run `npm run workflow:simulate` to replay the sample delay event; use `SIMULATE_AIRIA=1` to mock Airia calls when offline.

## Development commands
- `npm run workflow:run` executes the Temporal-style orchestration against live connectors.
- `npm run workflow:apify` invokes the Apify actor bridge for marketplace-driven rescues.
- `npm run airia:setup` provisions agents, triggers, and datasets defined in `AGENTS.md`.
- `npm run server:start` and `npm run worker:start` launch the demo API surface and background worker.
- `npm run demo:e2e` walks through the scripted end-to-end rescue used in demos.
- `npm run dashboard:start` serves the lightweight dashboard for timeline visualisations.

## API contract workflow
1. Update `airia-web-apis.json`, keeping properties alphabetised and descriptions clear on enum values.
2. Run `jq . airia-web-apis.json` for a structural sanity check.
3. Run `npx @redocly/cli lint airia-web-apis.json` (install once with `npm i -g @redocly/cli`).
4. Add or refresh a sample request in the relevant Markdown section; for example:
   ```bash
   curl --request POST \
     --url https://sandbox.airia.ai/v1/Webhook/demo-tenant/delay-alert \
     --header 'Authorization: Bearer <api-key>' \
     --header 'Content-Type: application/json' \
     --data @data/events/sample-delay-event.json
   ```

## Documentation map
- `auto-rescue-usecase.md` tracks the scenario narrative, linked test tables, and a changelog.
- `docs/orchestration-runbook.md` details Temporal workflows, retries, and incident states.
- `docs/demo-playbook.md` covers live demo callouts, voice IVR prompts, and fallback notes.
- Link new reference material back into the main narrative and store it under `docs/` using lowercase kebab-case filenames.

## Testing and verification
- Record manual test cases in Markdown tables (input, expected outcome, side-effects) and link them from the relevant section of `auto-rescue-usecase.md`.
- Run `npx markdownlint-cli2 auto-rescue-usecase.md AGENTS.md` to keep long-form docs consistent.
- Log sandbox integrations exercised (Shopify, Twilio, Airia) along with redacted tokens in `.env.local`.

## Contributing
- Follow Conventional Commits (for example `feat: add webhook retry guard`) and keep subjects under 72 characters.
- Request reviews from teammates covering the touched surface area (API, orchestration narrative, outreach playbooks).
- Capture verification steps (linting, `jq`, manual callouts) in pull request summaries so others can reproduce them quickly.
