# ADR 001: Provider-agnostic LLM interface with a deterministic fake

**Status:** accepted

## Context
The agent loop needs cross-cutting behaviour (budgets, tracing, guardrails, timeouts) that must
apply identically regardless of model vendor. Tests and CI need to run without an API key,
without nondeterminism, and in seconds.

## Decision
Define a minimal `LLMProvider` interface over a neutral message model (`text`, `tool_use`,
`tool_result`). The Anthropic adapter only translates shapes, maps errors and retries. A
`FakeProvider` implements the same interface with rule-based planning/composition and fault
injection.

## Consequences
- The agent loop is tested end to end in CI with zero external dependencies.
- Failure modes (429, 5xx, hallucination, malformed output, loops) each have a reproducible test.
- Adding a vendor is one adapter file. Adding a replay/recording provider for live-eval caching is the same.
- The fake is not a model; it cannot catch prompt-quality regressions. Live evals exist for that.
