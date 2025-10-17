# Contributing

Thanks for helping improve AutoRescue. This guide captures the workflow, quality checks, and review expectations to keep changes consistent.

## Before you start
- Familiarize yourself with `README.md`, `OVERVIEW.md`, and `auto-rescue-usecase.md` to understand the scenario narrative.
- Align proposed work with the existing agents, flows, and docs structure; add new long-form references under `docs/` using lowercase kebab-case filenames.
- Keep secrets and customer data out of the repository; store temporary tokens in `.env.local`, which is gitignored.

## Development flow
1. Install Node.js 18+ and run `npm install`.
2. Copy the redacted environment template to `.env.local` and populate sandbox credentials.
3. Use the scripts in `README.md` to reproduce the scenario you are changing; log any manual integrations exercised.
4. Run relevant verification commands before opening a pull request:
   ```bash
   jq . airia-web-apis.json
   npx @redocly/cli lint airia-web-apis.json
   npx markdownlint-cli2 auto-rescue-usecase.md AGENTS.md
   ```
5. Capture additional linters or test scripts you run in the pull request summary so reviewers can follow along.

## Documentation updates
- Record test cases in Markdown tables (input, expected outcome, side-effects) and link them from `auto-rescue-usecase.md`.
- Update the changelog near the top of `auto-rescue-usecase.md` whenever you modify the scenario narrative.
- When adjusting the OpenAPI contract (`airia-web-apis.json`), add or refresh sample `curl` or SDK snippets proving the revised contract.

## Coding standards
- Stick to the existing coding style; add succinct comments only when the intent is not obvious.
- Keep JSON two-space indented with alphabetized properties inside schema objects and clear explanations for enum values.
- Name new agents, flows, and endpoint docs with lowercase kebab-case filenames.

## Commit and review
- Follow Conventional Commits (for example `feat: add webhook retry guard`) with subjects under 72 characters written in the imperative mood.
- Group related changes into logical commits and request review from teammates covering the affected surface area (API, orchestration narrative, outreach playbooks).
- In pull request descriptions, note the business incident or ticket addressed, attach screenshots for diagram updates, and list verification steps (including `jq`, `redocly`, and manual callouts).
