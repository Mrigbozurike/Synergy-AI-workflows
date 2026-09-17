# Architecture

## Design goals

1. **Measurable quality.** Every behaviour that matters has an eval or a test that fails when it regresses.
2. **Honest failure modes.** The system never guesses. It says `insufficient_data`, or it fails with a named code.
3. **Bounded cost and latency.** There is no path through the code that can spend unboundedly.
4. **Replayable.** Any request can be reconstructed from its trace: inputs, tool calls, model outputs, cost.
5. **Provider independence.** Swapping the model vendor, or the data source, touches one adapter.

## Components

```
                ┌──────────────────────────────────────────────────────────────┐
  HTTP          │ Investigator (src/agent/investigator.ts)                     │
  server ─────▶ │  input guard ▶ router ▶ [ budget ▶ model ▶ tools ]* ▶ output guard │
                └──────┬───────────┬────────────┬──────────┬───────────────────┘
                       │           │            │          │
                LLMProvider   ToolRegistry  CostLedger   Trace/Metrics/Logger
                 ├ Anthropic    └ chain tools    └ price table   └ in-memory stores,
                 └ Fake            └ ChainClient                    pluggable exporters
                                      ├ Fixture
                                      └ (indexer / RPC)
```

### LLM layer (`src/llm`)
A neutral message model (`text`, `tool_use`, `tool_result` blocks) and an `LLMProvider`
interface with one method. The Anthropic adapter translates shapes, maps HTTP errors to typed
failures and owns the retry policy (SDK retries disabled so there is exactly one). The
`FakeProvider` is a rule-based stand-in that plans a tool call from the question and composes
a grounded answer from results; its `faults` option injects hallucinations, malformed output,
overconfidence, bad citations, infinite loops, outages and latency.

### Tools (`src/tools`)
`ToolRegistry.invoke` validates input with zod, applies a timeout, JSON-encodes the result and
caps its size. Invalid input and handler errors become `tool_result` blocks with `isError`,
which the model can recover from (typically by answering `insufficient_data`). The registry
never throws into the agent loop for data problems; only infrastructure problems surface as
`TOOL_ERROR`.

### Agent loop (`src/agent`)
One place for all cross-cutting concerns. Per turn: assert budget with a conservative
projection, call the model, record usage/cost/latency, then either run tools or validate the
final answer. Hard caps: turns, tool calls, wall-clock (AbortController threads through to the
provider). The prompt is a versioned constant; the version travels in every trace, response
and eval report.

Routing: primary model by default; when the daily budget is below 10 % remaining, the fast
model is used and the response is flagged `degraded: true`. When the budget is gone, requests
fail `BUDGET_EXCEEDED`. Degradation has a floor.

### Guardrails (`src/guardrails`)
Input: empty/oversize, instruction-override patterns, seed phrases (rejected without being
logged or echoed), scope. All deterministic and free.
Output: strict schema; every number in the prose must appear in tool results (with derived
forms: fraction→percent, rounding, thousands/millions); every ss58 hotkey must appear in tool
results; every finding must cite a real `tool_use` id; `insufficient_data` must be
`confidence: low`. Violations are rejected, not repaired — see ADR 005.

### Cost (`src/cost`)
Price table in code (unknown models are billed at the most expensive rate). The ledger keeps
per-request and rolling-UTC-day totals and throws `BUDGET_EXCEEDED` with details.

### Observability (`src/observability`)
- **Logs**: JSON lines with `requestId`, `traceId`, `promptVersion`; secret-shaped keys redacted.
- **Traces**: spans `investigate` → `guardrail.input`, `model.call`, `tool.call`, `guardrail.output`
  with attributes (model, tokens, cost, tool input, result size, guardrail rule). Ring-buffer
  store exposed at `/traces`; the exporter is a function, so OTLP is a one-file swap.
- **Metrics**: Prometheus text at `/metrics`. Suggested alerts in `docs/runbooks/`.

### Errors (`src/errors.ts`)
`AIFailure` carries `code`, `httpStatus`, `retryable`, `details`. The HTTP layer serialises it
verbatim. Metrics label by code. Runbooks key on code.

## Data flow of one request

1. `POST /v1/investigate` → concurrency gate (`MAX_IN_FLIGHT`), body size limit, request id.
2. Input guardrail. Reject → 400, zero tokens spent, metric `ai_guardrail_events_total{stage="input",rule=...}`.
3. Router picks model; degraded routing logs a warning.
4. Loop: budget projection → model call → record → tools or final.
5. Output guardrail. Reject → 502 with the rule; metric increments; trace span marked error.
6. Response includes `traceId`, `costUsd`, `toolCalls`, `promptVersion`, `degraded`.

## What would change for production

- `ChainClient`: implement over the indexer with caching and per-call timeouts; keep the fixture client for tests.
- Exporters: OTLP for traces, Prometheus scrape (already text format), log shipper for stdout.
- Ledger store: Redis with atomic increments so budgets hold across replicas.
- Auth on `/traces` and `/budget`; rate limiting per caller.
- Prompt registry: the version constant becomes a lookup so rollback is a config change.
