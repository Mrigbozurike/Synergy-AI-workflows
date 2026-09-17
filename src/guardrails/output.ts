import { z } from 'zod';

/**
 * Output guardrails: the model's final answer must be
 *  1. well-formed (a JSON object matching AnswerSchema),
 *  2. grounded: every number and every hotkey it states must appear in the
 *     tool results it actually received, and every finding must cite a real
 *     tool call,
 *  3. honest: an "insufficient_data" status must come with low confidence.
 *
 * A violation is a GUARDRAIL_OUTPUT_REJECTED failure, surfaced to the caller
 * as such. We do not "fix up" the answer: a corrected hallucination is still
 * a hallucination, and hiding it would hide the signal we alert on.
 */
export const AnswerSchema = z.object({
  status: z.enum(['ok', 'insufficient_data']),
  answer: z.string().min(1).max(4_000),
  findings: z
    .array(
      z.object({
        claim: z.string().min(1).max(500),
        evidence: z.string().min(1), // tool_use id
      }),
    )
    .max(20),
  confidence: z.enum(['high', 'medium', 'low']),
  caveats: z.array(z.string().max(300)).max(10).default([]),
});

export type Answer = z.infer<typeof AnswerSchema>;

export type OutputVerdict = { ok: true; answer: Answer } | { ok: false; rule: OutputRule; reason: string };

export type OutputRule = 'not_json' | 'schema' | 'ungrounded_number' | 'ungrounded_hotkey' | 'bad_citation' | 'overconfident';

export type Evidence = { toolUseIds: string[]; toolResultText: string };

export function parseAnswerText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object found');
  return JSON.parse(candidate.slice(start, end + 1));
}

const NUMBER_RE = /-?\d[\d,_]*(?:\.\d+)?/g;
const HOTKEY_RE = /\b5[1-9A-HJ-NP-Za-km-z]{46,48}\b/g;

function normaliseNumber(s: string): number {
  return Number(s.replace(/[,_]/g, ''));
}

/**
 * Builds the set of numbers the answer is allowed to state, including values
 * derived by common presentation transforms (fraction→percent, rounding).
 */
export function groundedNumbers(toolResultText: string): Set<number> {
  const allowed = new Set<number>();
  for (const m of toolResultText.match(NUMBER_RE) ?? []) {
    const n = normaliseNumber(m);
    if (!Number.isFinite(n)) continue;
    allowed.add(n);
    // percent forms: 0.061 → 6.1, 6.10
    const pct = Math.round(n * 100 * 100) / 100;
    allowed.add(pct);
    allowed.add(Math.round(pct * 10) / 10);
    allowed.add(Math.round(pct));
    // rounding forms: 1284500 → 1284500, 1.28M-ish
    allowed.add(Math.round(n));
    allowed.add(Math.round(n * 10) / 10);
    allowed.add(Math.round(n * 100) / 100);
    allowed.add(Math.round(n / 1000) / 1); // thousands
    allowed.add(Math.round(n / 100_000) / 10); // 1.3 (M)
    allowed.add(Math.round(n / 10_000) / 100); // 1.28 (M)
  }
  return allowed;
}

export function checkOutput(
  rawText: string,
  evidence: Evidence,
  opts: { smallIntegerAllowance?: number } = {},
): OutputVerdict {
  let parsed: unknown;
  try {
    parsed = parseAnswerText(rawText);
  } catch (err) {
    return { ok: false, rule: 'not_json', reason: err instanceof Error ? err.message : 'unparseable' };
  }
  const result = AnswerSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, rule: 'schema', reason: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  const answer = result.data;

  if (answer.status === 'insufficient_data' && answer.confidence !== 'low') {
    return { ok: false, rule: 'overconfident', reason: 'insufficient_data answers must have low confidence' };
  }

  const validIds = new Set(evidence.toolUseIds);
  for (const f of answer.findings) {
    if (!validIds.has(f.evidence)) {
      return { ok: false, rule: 'bad_citation', reason: `finding cites unknown tool call "${f.evidence}"` };
    }
  }

  const prose = [answer.answer, ...answer.findings.map((f) => f.claim), ...answer.caveats].join('\n');

  const allowedHotkeys = new Set(evidence.toolResultText.match(HOTKEY_RE) ?? []);
  for (const hk of prose.match(HOTKEY_RE) ?? []) {
    if (!allowedHotkeys.has(hk)) return { ok: false, rule: 'ungrounded_hotkey', reason: `hotkey ${hk} not present in tool results` };
  }

  const allowance = opts.smallIntegerAllowance ?? 100;
  const allowed = groundedNumbers(evidence.toolResultText);
  for (const m of prose.match(NUMBER_RE) ?? []) {
    const n = normaliseNumber(m);
    if (!Number.isFinite(n)) continue;
    if (Number.isInteger(n) && Math.abs(n) <= allowance) continue; // counts, ordinals, netuids
    if (!allowed.has(n)) {
      return { ok: false, rule: 'ungrounded_number', reason: `number ${m} does not appear in tool results` };
    }
  }

  return { ok: true, answer };
}
