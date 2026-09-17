# Runbooks

Each runbook keys on a signal you can see on the dashboard or in an alert, names the
failure code(s) involved, and walks from detection to mitigation to follow-up.

| Runbook | Trigger |
|---|---|
| [model-outage.md](model-outage.md) | `PROVIDER_UNAVAILABLE` / `PROVIDER_RATE_LIMITED` / `TIMEOUT` error rate > 5 % for 5 min |
| [cost-spike.md](cost-spike.md) | `ai_cost_usd_total` slope > 2× 7-day average, or `ai_budget_remaining_usd` < 20 % before 12:00 UTC |
| [eval-regression.md](eval-regression.md) | CI eval gate red, or live eval pass rate below baseline |
| [prompt-rollout.md](prompt-rollout.md) | Any change to `src/agent/prompt.ts` or the model id |
| [guardrail-false-positive.md](guardrail-false-positive.md) | `GUARDRAIL_INPUT_REJECTED` rate > 10 % of traffic, or a user report |

## Suggested alert rules (Prometheus)

```yaml
- alert: AIProviderErrors
  expr: sum(rate(ai_requests_total{failure_code=~"PROVIDER_.*|TIMEOUT"}[5m])) / sum(rate(ai_requests_total[5m])) > 0.05
  for: 5m
- alert: AIOutputGuardrailSpike
  expr: sum(rate(ai_guardrail_events_total{stage="output",rule!="pass"}[15m])) / sum(rate(ai_guardrail_events_total{stage="output"}[15m])) > 0.02
  for: 15m
- alert: AIBudgetLow
  expr: ai_budget_remaining_usd < 0.2 * 50 and hour() < 12
- alert: AILatencyP95
  expr: histogram_quantile(0.95, sum(rate(ai_request_duration_ms_bucket[10m])) by (le)) > 15000
  for: 10m
- alert: AIToolErrors
  expr: sum(rate(ai_tool_calls_total{outcome="error"}[10m])) by (tool) / sum(rate(ai_tool_calls_total[10m])) by (tool) > 0.1
  for: 10m
```
