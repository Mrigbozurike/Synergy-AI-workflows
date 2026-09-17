import type { EvalCase, Outcome, ScoreDetail } from '../types.js';

/**
 * Deterministic scorers. Each looks at one aspect of the outcome and returns a
 * pass/fail with a human-readable reason. A case passes only if every
 * applicable scorer passes, so a report line tells you exactly *what* broke:
 * the wrong tool, a missing fact, an overconfident answer, or a blown budget.
 */
const RANK = { low: 0, medium: 1, high: 2 } as const;

type Scorer = (c: EvalCase, o: Outcome) => ScoreDetail | null;

const outcomeKind: Scorer = (c, o) => {
  const e = c.expect;
  if (e.failure) {
    if (o.kind !== 'failure') return { scorer: 'outcome', pass: false, detail: `expected failure ${e.failure}, got a result (${o.result.answer.status})` };
    if (o.failure.code !== e.failure) return { scorer: 'outcome', pass: false, detail: `expected ${e.failure}, got ${o.failure.code}` };
    if (e.rule && o.failure.details['rule'] !== e.rule) return { scorer: 'outcome', pass: false, detail: `expected rule ${e.rule}, got ${String(o.failure.details['rule'])}` };
    return { scorer: 'outcome', pass: true, detail: `${o.failure.code}${e.rule ? `/${e.rule}` : ''}` };
  }
  if (o.kind === 'failure') return { scorer: 'outcome', pass: false, detail: `unexpected failure ${o.failure.code}: ${o.failure.message}` };
  if (e.status && o.result.answer.status !== e.status) return { scorer: 'outcome', pass: false, detail: `expected status ${e.status}, got ${o.result.answer.status}` };
  return { scorer: 'outcome', pass: true, detail: o.result.answer.status };
};

const toolsUsed: Scorer = (c, o) => {
  if (!c.expect.tools) return null;
  const used = o.kind === 'result' ? o.result.toolCalls.map((t) => t.name) : [];
  const missing = c.expect.tools.filter((t) => !used.includes(t));
  return missing.length
    ? { scorer: 'tools', pass: false, detail: `missing tool(s) ${missing.join(', ')}; used [${used.join(', ')}]` }
    : { scorer: 'tools', pass: true, detail: used.join(', ') || '(none)' };
};

const toolBudget: Scorer = (c, o) => {
  if (c.expect.maxToolCalls === undefined || o.kind !== 'result') return null;
  const n = o.result.toolCalls.length;
  return { scorer: 'tool_budget', pass: n <= c.expect.maxToolCalls, detail: `${n} calls (max ${c.expect.maxToolCalls})` };
};

function prose(o: Outcome): string {
  if (o.kind !== 'result') return '';
  const a = o.result.answer;
  return [a.answer, ...a.findings.map((f) => f.claim), ...a.caveats].join('\n');
}

const contains: Scorer = (c, o) => {
  if (!c.expect.contains && !c.expect.notContains) return null;
  const text = prose(o).toLowerCase();
  const missing = (c.expect.contains ?? []).filter((s) => !text.includes(s.toLowerCase()));
  const present = (c.expect.notContains ?? []).filter((s) => text.includes(s.toLowerCase()));
  if (missing.length || present.length) {
    return { scorer: 'facts', pass: false, detail: [missing.length && `missing: ${missing.join(', ')}`, present.length && `forbidden: ${present.join(', ')}`].filter(Boolean).join('; ') };
  }
  return { scorer: 'facts', pass: true, detail: `${(c.expect.contains ?? []).length} expected facts present` };
};

const confidence: Scorer = (c, o) => {
  const e = c.expect;
  if (o.kind !== 'result' || (!e.confidence && !e.minConfidence && !e.maxConfidence)) return null;
  const got = o.result.answer.confidence;
  if (e.confidence && got !== e.confidence) return { scorer: 'confidence', pass: false, detail: `expected ${e.confidence}, got ${got}` };
  if (e.minConfidence && RANK[got] < RANK[e.minConfidence]) return { scorer: 'confidence', pass: false, detail: `expected ≥${e.minConfidence}, got ${got}` };
  if (e.maxConfidence && RANK[got] > RANK[e.maxConfidence]) return { scorer: 'confidence', pass: false, detail: `expected ≤${e.maxConfidence}, got ${got} (overconfident)` };
  return { scorer: 'confidence', pass: true, detail: got };
};

const citations: Scorer = (_c, o) => {
  if (o.kind !== 'result' || o.result.answer.status !== 'ok') return null;
  const n = o.result.answer.findings.length;
  return { scorer: 'citations', pass: n > 0, detail: n > 0 ? `${n} cited findings` : 'ok answer with no cited findings' };
};

const cost: Scorer = (c, o) => {
  if (c.expect.maxCostUsd === undefined) return null;
  const spent = o.kind === 'result' ? o.result.costUsd : 0;
  return { scorer: 'cost', pass: spent <= c.expect.maxCostUsd, detail: `$${spent.toFixed(5)} (max $${c.expect.maxCostUsd})` };
};

const latency: Scorer = (c, o) => {
  if (c.expect.maxLatencyMs === undefined || o.kind !== 'result') return null;
  return { scorer: 'latency', pass: o.result.durationMs <= c.expect.maxLatencyMs, detail: `${o.result.durationMs}ms (max ${c.expect.maxLatencyMs})` };
};

export const SCORERS: Scorer[] = [outcomeKind, toolsUsed, toolBudget, contains, confidence, citations, cost, latency];

export function score(c: EvalCase, o: Outcome): ScoreDetail[] {
  return SCORERS.map((s) => s(c, o)).filter((x): x is ScoreDetail => x !== null);
}
