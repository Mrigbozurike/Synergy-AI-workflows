# Runbook: cost spike / budget exhaustion

**Signals:** `ai_cost_usd_total` increasing faster than usual; `ai_budget_remaining_usd` dropping early in the UTC day;
responses carrying `degraded: true`; eventually `BUDGET_EXCEEDED` (429) errors.

The system is designed so a spike is *loud* (degraded flag, then hard 429s) rather than a surprise invoice.

## 1. Confirm and characterise
- `GET /budget` — spent vs remaining today.
- `ai_tokens_total{direction="input"}` vs `output`: input-heavy spikes usually mean bigger tool results or longer loops; output-heavy means verbose answers.
- `ai_model_calls_total` / `ai_requests_total`: calls per request rising → the loop is taking more turns.
- `ai_tool_calls_total` by tool: is one tool suddenly popular or returning huge payloads (`resultChars` attribute on `tool.call` spans)?
- Was there a prompt or model change today? (`promptVersion` in traces; `git log src/agent/prompt.ts`.)

## 2. Mitigate
1. If abuse/loop: lower `AGENT_MAX_TURNS` / `AGENT_MAX_TOOL_CALLS` and `COST_MAX_PER_REQUEST_USD`, restart.
2. If legitimate traffic growth: raise `COST_DAILY_BUDGET_USD` with sign-off; note that degraded routing kicks in at 10 % remaining.
3. If a tool result grew: lower that tool's `maxResultChars` or trim fields in the handler.
4. If a prompt change caused it: roll back per the prompt-rollout runbook.

## 3. Verify
Cost per request (`ai_cost_usd_total` / `ai_requests_total`) back to baseline; no `degraded` responses; evals pass.

## 4. Follow-up
- Add an eval case with `maxCostUsd` covering the pattern that spiked.
- If pricing changed upstream, update `src/cost/pricing.ts` in a reviewed PR.
