# ADR 002: Evals gate CI; live evals are scheduled

**Status:** accepted

## Context
Prompt and tool changes silently alter behaviour. Manual spot checks do not scale and are
not reproducible. Live model calls in every PR are slow, costly and flaky.

## Decision
Two modes over one dataset. Offline evals (fake provider) run on every PR with 100 %
thresholds and block merges. Live evals run on a schedule and on demand with looser
thresholds and an optional LLM judge that informs but does not gate. Thresholds live in
`evals/baseline.json` and change only through a reviewed PR.

## Consequences
- A red PR always means a real system regression, not model noise.
- Model drift is detected by the scheduled job rather than by users.
- The dataset must be maintained as the product's definition of correct; adding a case is part of fixing a bug.
