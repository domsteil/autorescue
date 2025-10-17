# About the project — **AutoRescue: Agentic Post‑Purchase Rescue**

> **One‑liner:** When a shipment is delayed or a payment fails, an autonomous agent detects it in real time, contacts the customer by SMS/voice with compliant options (reship, credit, refund), then executes the decision end‑to‑end (update order, label, credit/refund, ticket notes) — no human in the loop.

---

## 🔦 What inspired us

* **WISMO overload** (“Where Is My Order?”) and delay‑related tickets dominate CX queues. We wanted an agent that **acts before** customers reach out.
* Teams love LLMs for answers, but **business value lives in actions**: issuing credits, reshipping, editing orders, and logging outcomes safely.
* We believed that combining **deterministic workflows** with **LLM policy reasoning** could create a dependable, production‑scented agent that judges would see as real‑world ready.

---

## 🛠 How we built it

We combined **StateSet** components with common sponsor APIs to create an event‑driven, autonomous loop:

1. **Event ingestion**

   * Carrier webhook posts `status=delayed` (sandbox tracking) into `POST /v1/Webhook/{tenantId}/{webhookId}`.
   * A tiny webhook service validates and forwards the event.

2. **Orchestration (deterministic core)**

   * **`stateset-temporal`** starts a workflow:
     `DetectDelay → FetchContext → Decide → Outreach → ApplyAction → Confirm → Log`.
   * We expose the same workflow through `/v2/PipelineExecution/{pipelineId}` with stream controls from `/v2/PipelineExecution/ResumeStream/{executionId}` and `/v2/PipelineExecution/StopStream`.

3. **Policy-aware decisioning**

   * **`stateset-responsecx`** (agent builder) loads order context + policy (JSON).
   * The agent returns a **typed tool call**: `create_reshipment | create_coupon | create_refund | create_exchange` with parameters and a policy proof (thresholds, eligibility).

4. **Customer outreach (choice UX)**

   * SMS via **Twilio** from the **stateset-phone-server** flow, backed by `/v1/ChatSpaces/CreateSpace` and `/v1/TextToSpeech` for consistent transcripts and voice prompts.
   * Optional voice IVR: `/v1/VoiceChat/sessions` spins up the room, live transcription captures intent, and the same action path resumes.

5. **Side-effects (the value)**

   * **Shopify**: new fulfillment for reship, exchange, or partial refund.
   * **Stripe**: create coupon/credit or issue a refund.
   * **Shipping API**: generate/void labels when needed.
   * **Ticketing (optional)**: log transcript + resolution in Gorgias/Zendesk.
   * Connectors stay healthy through `/v1/CloudConnectors` and tool smoke tests via `/v1/Tools/testConnection`.

6. **Observability & safety**

   * Temporal run history, idempotency keys, retries, and compensations.
   * ResponseCX logs: prompt/version lineage, PII-redacted traces, decision audit.
   * `/v1/PipelineExecutionMetrics/model/usage`, `/v1/AuditLog/entries`, and `/v1/Alert/HasUnread` feed the ops console with live telemetry.

**Architecture at a glance**

```
Carrier Webhook → [Webhook API] → Temporal Workflow
                                   ├─ Fetch Order/Policy (Shopify + policy.json)
                                   ├─ Decide (responsecx → typed tool call)
                                   ├─ Outreach (Twilio SMS/voice via phone-server)
                                   ├─ Apply Action (Shopify/Stripe/Ship API)
                                   └─ Confirm & Log (dashboard + ticket note)
```

---

## 🗺️ API surface map

`airia-web-apis.json` mirrors how AutoRescue runs in production. These are the slices we rely on most:

### Build and publish rescue agents

- `GET /v1/AgentCard` and `POST /v1/AgentCard` manage reusable policy-backed agent definitions.
- `POST /v1/AgentTrigger` stores delay and payout rules that emit incidents into orchestration.
- `POST /v1/Deployments` ships versioned runbooks, while `/v1/Deployments/ApiKey/{agentId}` issues scoped keys for downstream systems.

### Run the incident loop

- `POST /v1/Webhook/{tenantId}/{webhookId}` ingests carrier and payment events without a custom gateway.
- `POST /v1/JobOrchestration` queues long-running rescues; `/v1/JobOrchestration/{id}/retry` and `/v1/JobOrchestration/{id}/resume` handle repair flows.
- `/v2/PipelineExecution/{pipelineId}` executes the typed workflow with SSE controls from `/v2/PipelineExecution/ResumeStream/{executionId}` and `/v2/PipelineExecution/StopStream`.

### Connect data and tools

- `POST /v1/CloudConnectors` and `/v1/CloudConnectors/{id}/test` register Shopify, Stripe, and carrier credentials with heartbeat checks.
- `POST /v1/Store/UploadFile` and `/v1/Store/{storeId}/graph/cypher` load and query order knowledge inside the agent sandbox.
- `/v1/Tools/testConnection` and `/v1/DataVectorSearch/search/{dataStoreId}` verify the toolchain and surface the right memories for each incident.

### Evaluate and guard decisions

- `GET /v1/AgentEvaluation/Results` plus `/v1/AgentEvaluation/AggregatedResults/{evaluationJobId}` provide pass/fail telemetry across policy regressions.
- `POST /v1/AgentEvaluationDataset/validate` enforces schema integrity before a run hits production.
- `/v1/SmartScan` and `/v1/RedTeamingEvaluation/{id}/vulnerabilities` harden prompts, while `/v1/PipelineExecutionMetrics/model/usage` tracks token and model spend.

### Customer touchpoints and feedback

- `POST /v1/ChatSpaces/CreateSpace` creates the SMS/DM thread that Twilio and internal chat widgets reuse.
- `POST /v1/VoiceChat/sessions` and `POST /v1/TextToSpeech` handle IVR sessions and confirmations.
- `POST /v1/AgentFeedback` captures outcome ratings that loop back into evaluations.

### Governance and integrations

- `/v2/OAuth/initiate` bootstraps partner connections, and `/v1/TenantPermissions` plus `/v1/Roles/{id}/policies` keep access scoped.
- `GET /v1/AuditLog/entries` and `/v1/Alert/HasUnread` feed the operations console.
- Marketplace endpoints such as `/marketplace/v1/Library/agents` and `/marketplace/v1/Library/tools` seed AutoRescue with curated playbooks and connectors.

---

## 📚 What we learned

* **Agents must prove compliance, not just “sound smart.”** Typed tool calls + policy proofs (e.g., “max credit 20%”) earn trust.
* **Deterministic + probabilistic is the winning combo.** Use workflows for state, retries, and idempotency; let the LLM choose *which* action under guardrails.
* **Observability is a feature.** Token/cost caps, audit logs, and replayable traces make demos calmer and production closer.
* **Customer choice boosts acceptance.** Offering 2–3 options (reship/credit/refund) increased action completion versus a single “we decided for you” path.
* **Small prompts, strong schemas.** We got better stability with compact policies + strict JSON schemas than with long, narrative instructions.
* **Real‑time ≠ real‑nice by default.** Webhooks, retries, and idempotent updates matter even in a hackathon — or you double‑issue refunds.

---

## ⚠️ Challenges we faced

* **Bridging LLMs to safe actions.** Early outputs were chatty; enforcing a **single tool call** with a JSON schema and rejecting anything else fixed it.
* **Policy edge cases.** Returnless refunds on low‑AOV items vs. high‑risk SKUs required explicit rules and deny‑lists.
* **Async race conditions.** Customer replies could arrive while reshipment was processing; we added a *“decision lock”* per incident.
* **Integration friction.** Mapping carrier events to a single order (multi‑package) and normalizing addresses took longer than expected.
* **Voice timing.** IVR barge‑in and transcription delays needed tighter timeouts and short, confirmatory prompts.
* **Demo reliability.** We built a **simulate‑delay** endpoint and a minimal “run timeline” UI to survive Wi‑Fi jitters.

---

## 🧮 Impact, in quick math (LaTeX)

We track **containment**, **saves**, and **ROI**:

* **Containment rate**
  [
  C ;=; \frac{\text{autonomous resolutions}}{\text{total incidents}}
  ]

* **Expected value of a credit offer** vs. refund
  [
  E_{\text{credit}} ;=; p_{\text{accept}}\cdot(\text{AOV}\cdot m - \text{credit})
  ]
  where (m) is gross margin. Choose credit if (E_{\text{credit}} > E_{\text{refund}}).

* **ROI (per period)**
  [
  \text{ROI} ;=;\frac{(\Delta \text{tickets})\cdot c_{\text{ticket}} + (\text{saves})\cdot \text{AOV}\cdot m - \text{cloud+LLM cost}}{\text{cloud+LLM cost}}
  ]

* **Deflection cost per resolution**
  [
  \text{CPR} ;=; \frac{\text{LLM tokens cost} + \text{voice/SMS cost} + \text{workflow compute}}{\text{autonomous resolutions}}
  ]

These formulas let us show judges a live counter for **$ saved**, **minutes deflected**, and **CPR**, tied to actual actions taken.

---

### Closing thought

AutoRescue showed us that the shortest path from **LLM** to **business value** is paved with **policies, typed actions, and deterministic workflows**. The result feels like software you could ship — and that’s exactly what we aimed to demonstrate.
