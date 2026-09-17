import type { LLMProvider } from '../../src/llm/types.js';
import type { EvalCase, Outcome, ScoreDetail } from '../types.js';

/**
 * LLM-as-judge scorer for qualities regexes cannot measure: is the answer
 * useful to an operator, does it flag the right risks, is it concise?
 *
 * Opt-in (EVAL_JUDGE=1) and live-only: it costs tokens and is itself
 * non-deterministic, so it informs rather than gates. Its scores are recorded
 * in the report and trended over time; a sustained drop is investigated via
 * the eval-regression runbook, not auto-failed.
 */
const RUBRIC = `You grade answers produced by an on-chain investigation assistant for Bittensor operators.
Score 1-5:
5 = precise, grounded, flags relevant risks (inactivity, stale weights, high take), concise
4 = correct and useful, minor omissions
3 = correct but generic or verbose
2 = partially wrong or misses the question
1 = wrong, misleading, or answers a different question
Respond with ONLY JSON: {"score": <1-5>, "rationale": "<one sentence>"}`;

export async function judge(provider: LLMProvider, model: string, c: EvalCase, o: Outcome): Promise<ScoreDetail | null> {
  if (o.kind !== 'result' || o.result.answer.status !== 'ok') return null;
  const res = await provider.complete({
    model,
    system: RUBRIC,
    maxTokens: 200,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Question: ${c.question}\n\nAnswer JSON:\n${JSON.stringify(o.result.answer, null, 2)}\n\nTool results the answer was based on: ${o.result.toolCalls.map((t) => t.name).join(', ')}`,
          },
        ],
      },
    ],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { score: number; rationale: string };
    return { scorer: 'judge', pass: parsed.score >= 4, detail: `${parsed.score}/5 — ${parsed.rationale}` };
  } catch {
    return { scorer: 'judge', pass: false, detail: `judge returned unparseable output: ${text.slice(0, 80)}` };
  }
}
