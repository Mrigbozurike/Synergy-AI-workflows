# Runbook: model provider outage or rate limiting

**Signals:** `ai_requests_total{failure_code="PROVIDER_UNAVAILABLE"|"PROVIDER_RATE_LIMITED"|"TIMEOUT"}` rising;
`ai_model_call_duration_ms` p95 climbing; users see 503/429/504 with `retryable: true`.

## 1. Confirm
- `curl -s $HOST/metrics | grep -E 'ai_requests_total|ai_model_call_duration'` — is it all models or one?
- Check the provider status page. Check `GET /traces?limit=20` for `model.call` spans with `error` attributes.
- Rule out us: `ai_tool_calls_total{outcome="error"}` flat? `ai_budget_remaining_usd` > 0? (Budget exhaustion is `BUDGET_EXCEEDED`, a different runbook.)

## 2. Mitigate
The adapter already does bounded jittered retries (2 retries, 400 ms base). Do **not** raise retries during an outage — it amplifies load on a struggling upstream and our own latency.

Options, in order:
1. **Switch models.** Set `LLM_MODEL_PRIMARY` to the fast model (or another available one) and restart. Responses will not be flagged `degraded` for this path; announce it in the incident channel.
2. **Reduce concurrency.** Lower `MAX_IN_FLIGHT` (constant in `src/server.ts`; make it env if this happens twice) so we shed load with 503 + `retry-after` instead of piling up timeouts.
3. **Disable the feature.** If the outage is prolonged, have the UI hide the AI panel; the API keeps returning typed 503s that the UI already handles.

## 3. Verify
Error rate back under 1 % for 10 min; p95 latency normal; `npm run eval:live -- --suite subnet_investigation` passes against the model you are now using.

## 4. Follow-up
- Postmortem: time to detect, time to mitigate, user impact (count `ai_requests_total{status="error"}` over the window).
- If the fallback model was used for > 1 h, run full live evals on it and record results.
- Consider a circuit breaker in `AnthropicProvider` if retries were a significant share of load.
