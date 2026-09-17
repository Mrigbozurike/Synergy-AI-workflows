# Runbook: eval regression

**Signals:** CI job `check` fails at "Offline eval gate"; scheduled `live-evals` fails; the judge score trend drops.

## Offline gate red (PR blocked)
The offline provider is deterministic, so this is never model noise. Something in *our* system changed behaviour.

1. Read the failing scorer line: `FAIL facts: missing: …`, `FAIL tools: …`, `FAIL outcome: expected …`.
2. Map to cause:
   - `facts` missing → prompt, fixture, or answer-composition change.
   - `tools` missing / `tool_budget` → planning or tool description change.
   - `outcome` expected failure but got result → a guardrail stopped catching a fault. **Treat as a security regression.**
   - `outcome` got a guardrail failure unexpectedly → a guardrail over-triggers; see the false-positive runbook.
   - `cost` → more turns/tokens; check `AGENT_MAX_*` and result sizes.
3. Fix the cause. Only change the dataset if the *expected behaviour* changed on purpose — say so in the PR.
4. Never edit `baseline.json` to make a PR green.

## Live evals red
Model variance is real, so first check magnitude:
1. Re-run once: `npm run eval:live`. Two consecutive failures = real.
2. Diff the two `evals/reports/latest.json` files: which cases flip? Flaky cases hover; regressions cluster.
3. Check whether the model id changed (vendor alias moved) — `model` field in the report.
4. If the prompt changed recently, A/B: run live evals on the previous `PROMPT_VERSION` (git checkout of `src/agent/prompt.ts`) and compare pass rate and judge scores.
5. If the vendor model drifted: pin an exact dated model id, open a ticket, and consider adding cases that capture the new failure mode.

## Follow-up
- Every regression that reached live should get an offline case if a deterministic one can express it.
- Record pass rate and judge mean in the eval dashboard; a slow decline over weeks is a drift signal.
