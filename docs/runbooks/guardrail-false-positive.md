# Runbook: guardrail false positives

**Signals:** `ai_guardrail_events_total{stage="input",rule!="pass"}` above ~10 % of requests; user reports of "it refused a normal question"; `GUARDRAIL_OUTPUT_REJECTED` on answers that look right.

Guardrails are heuristics by design (cheap, deterministic, before tokens are spent). They will
sometimes be wrong. The response tells you which rule fired (`details.rule`); tune that rule.

## Input rules
| Rule | Likely false positive | Fix |
|---|---|---|
| `off_topic` | Domain question using vocabulary not in `DOMAIN_TERMS` | Add the term; or set `strictScope: false` and rely on the model's own scope handling + output guard |
| `prompt_injection` | Question quoting the phrase "ignore previous instructions" legitimately | Tighten the regex; consider requiring imperative position |
| `secret_material` | Long lowercase lists (e.g. 12+ subnet names) | Raise the run length; check against a BIP39 wordlist instead of the shape heuristic |
| `too_long` | Pasted validator lists | Raise `maxChars` for authenticated callers |

Never log the rejected text for `secret_material` cases, even while debugging.

## Output rules
| Rule | Likely false positive | Fix |
|---|---|---|
| `ungrounded_number` | Model computed a derived figure (a sum, a difference, a ratio) | Either add the derivation to `groundedNumbers` if it is a common presentation form, or add a tool that returns the computed value so it is grounded by construction. Do not raise `smallIntegerAllowance` casually |
| `ungrounded_hotkey` | Model repeated a hotkey from the *question* | Include question text in the evidence set (deliberately not done today: the user could plant a hotkey) |
| `not_json` | Model wrapped JSON in prose | Prompt tweak; the parser already strips code fences |
| `bad_citation` | Model invented `toolu_` ids | Prompt tweak; consider passing ids back explicitly in a reminder turn |

## Process
1. Reproduce with a unit test in `tests/guardrails.test.ts` that asserts the *desired* verdict.
2. Change the rule; run `npm run check` — the guardrails eval suite must still catch every injected fault.
3. Add the offending input as an eval case so it stays fixed.
