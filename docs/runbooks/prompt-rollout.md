# Runbook: prompt or model change rollout

Prompts are code. They ship with a version bump, evals, a canary and a rollback path.

## Before merge
1. Bump `PROMPT_VERSION` in `src/agent/prompt.ts` (e.g. `investigator.v3` → `investigator.v4`). The version is stamped on every trace, response and eval report — this is what makes rollback attributable.
2. `npm run check` — offline gate must be green with no dataset loosening.
3. `EVAL_JUDGE=1 npm run eval:live` — compare pass rate, judge mean, cost per case and p95 latency to the previous report. Paste both summaries in the PR.
4. If the change targets a known weakness, add an eval case that fails on the old prompt and passes on the new one.

## Rollout
1. Deploy to a canary slice (one replica / a percentage of traffic).
2. Watch for 30 min: `ai_guardrail_events_total{stage="output",rule!="pass"}` (hallucination/format regressions show here first), `ai_cost_usd_total` per request, p95 latency, `insufficient_data` share.
3. Sample 10 traces from `/traces` and read the answers.
4. Promote.

## Rollback
`git revert` the prompt commit and redeploy; or, if a prompt registry is in place, point the config back to the previous version. Confirm `promptVersion` in fresh responses. Rollback should take minutes; do it first and investigate after.

## Model id changes
Treat like a prompt change: same evals, same canary. Always pin dated ids (`claude-sonnet-4-20250514`), never floating aliases, so a vendor update cannot change behaviour without a PR. Update `src/cost/pricing.ts` in the same PR.
