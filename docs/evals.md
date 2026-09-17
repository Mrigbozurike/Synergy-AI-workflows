# Evals

## Philosophy

An AI feature without evals is a demo. The eval suite here is the definition of "working":
it encodes what a correct answer looks like, what an honest non-answer looks like, and what
must be refused. It runs on every PR and blocks merges.

## Structure

```
evals/
  datasets/*.jsonl      one case per line, grouped by suite
  scorers/index.ts      deterministic scorers
  scorers/judge.ts      optional LLM-as-judge (live only, informational)
  baseline.json         gate thresholds per mode
  run.ts                runner; writes evals/reports/latest.json
```

### Suites

| Suite | Cases | Tests |
|---|---|---|
| `subnet_investigation` | 6 | Right tool chosen, key facts present, confidence appropriate, within tool/cost budget |
| `validator_comparison` | 5 | Comparison and profile questions, hotkey lookup, partial results lower confidence |
| `honest_failures` | 4 | Unknown entities, no entity, data source down → `insufficient_data` + `low` |
| `guardrails` | 8 | Injection, secrets, off-topic, empty → rejected at input; hallucination, malformed output, runaway loop → caught |

### Case format

```json
{"id":"subnet-64-overview",
 "question":"What is subnet 64 and how active is it?",
 "faults":{"hallucinate":true},          // optional, FakeProvider only (skipped live)
 "chainFailEvery":1,                      // optional, makes the data source fail
 "expect":{
   "status":"ok" | "insufficient_data",   // or "failure":"<CODE>" (+ "rule")
   "tools":["get_subnet"],                // must all have been called
   "contains":["Chutes","8.3%"],          // substrings in answer+findings+caveats (case-insensitive)
   "notContains":[...],
   "confidence":"low" | "minConfidence":"medium" | "maxConfidence":"medium",
   "maxToolCalls":2, "maxCostUsd":0.05, "maxLatencyMs":5000
 }}
```

### Scorers

`outcome`, `tools`, `tool_budget`, `facts`, `confidence`, `citations`, `cost`, `latency`.
A case passes only if every applicable scorer passes; the report says which one failed and why.
`judge` (1–5 rubric via the fast model) is recorded but never gates.

### Gate

`baseline.json` holds minimum pass rates per suite and overall, plus max total cost and p95
latency, separately for `offline` and `live`. Offline thresholds are 100 %: the provider is
deterministic, so any drop is a real regression in the system. Live thresholds tolerate model
variance.

`npm run eval:update-baseline` rewrites thresholds from the current run (rounded down to 5 %,
cost/latency ×1.5). It is meant to be run deliberately and reviewed in a PR diff, never in CI.

## Adding a case

1. Add a line to the right `datasets/*.jsonl`.
2. Run `npm run eval -- --suite <name> --verbose`.
3. If the case needs a new fixture, add it in `src/chain/fixtures.ts` and keep unit tests green.
4. If the case reveals a real bug, fix the bug; do not loosen the case.

## Reading a failure

```
✗ subnet_investigation/subnet-1-inactive  [ok] 12ms $0.0056
    FAIL facts: missing: RoundTable21
```
Facts missing → the prompt or tool changed what's surfaced. Tools missing → planning
regressed. Confidence failing → calibration regressed. Cost failing → the loop is doing more
work than before. `outcome` failing with a guardrail code → a guardrail is over-triggering
(see the false-positive runbook) or a new fault is uncaught.
