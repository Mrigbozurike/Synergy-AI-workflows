# ADR 005: Reject ungrounded output rather than repair it

**Status:** accepted

## Context
The most damaging LLM failure in a data product is a fabricated number or address that looks
plausible. Prompting alone does not prevent it.

## Decision
The final answer is a strict JSON contract. The output guardrail rejects the response if any
number or ss58 hotkey in the prose is absent from the tool results the model actually received
(allowing common derived forms), if any finding cites a tool call that did not happen, or if
an `insufficient_data` answer is not low-confidence. Rejections are `GUARDRAIL_OUTPUT_REJECTED`
(502) with the rule named; they are counted and alertable.

We deliberately do not strip or correct the offending content: a corrected hallucination is
still evidence the model hallucinated, and hiding it hides the signal.

## Consequences
- Fabricated figures cannot reach operators via this path.
- Some legitimate derived values (sums, ratios) will be rejected; the fix is a tool that computes them, so they become grounded by construction, not a looser check.
- The output guardrail is itself a regression target: the guardrails eval suite injects each fault and asserts it is caught.
