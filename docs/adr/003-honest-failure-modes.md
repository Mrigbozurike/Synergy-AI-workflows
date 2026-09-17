# ADR 003: Honest failure modes over best-effort answers

**Status:** accepted

## Context
Operators make staking and validator decisions from these answers. A confident wrong answer
is worse than no answer. "Something went wrong" gives operators and on-call nothing to act on.

## Decision
- Every failure is an `AIFailure` with a named code, HTTP status, `retryable` flag and details. No generic errors cross the API boundary.
- "I cannot answer this from data" is a first-class **result** (`status: insufficient_data`, `confidence: low`), returned with 200, distinguishable in metrics, and required by evals for unknown entities and data-source outages.
- Output guardrail violations are rejected, not repaired (see ADR 005).
- Degraded routing is flagged in the response.

## Consequences
- UIs can render each state appropriately (retry button vs. "no data" vs. "try rephrasing").
- Dashboards and runbooks key on codes.
- Some requests that a best-effort system would answer are refused. That is the intended trade.
