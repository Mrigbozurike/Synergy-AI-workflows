# ADR 004: Hard budgets with explicit, bounded degradation

**Status:** accepted

## Context
Agent loops can spend unboundedly: more turns, bigger tool results, retries. Cloud LLM bills
arrive after the fact.

## Decision
- Price table in code; unknown models billed at the most expensive rate.
- Per-request and per-UTC-day USD budgets enforced *before* each model call using a conservative projection; violations fail with `BUDGET_EXCEEDED` (429).
- When daily headroom drops below 10 %, route to the fast model and flag `degraded: true`. Below 0 %, fail. Degradation has a floor.
- Turn, tool-call and wall-clock caps as independent limits.

## Consequences
- Worst-case daily spend is known in advance.
- Cost problems surface as visible behaviour (degraded flags, then 429s) rather than invoices.
- Budgets are per-process in this implementation; multi-replica deployments need a shared store (Redis) behind the same `CostLedger` interface.
