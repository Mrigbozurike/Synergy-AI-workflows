import { AIFailure } from '../errors.js';
import type { CompletionRequest, CompletionResponse, ContentBlock, LLMProvider, Message, ToolUseBlock } from './types.js';

/**
 * Deterministic, offline stand-in for a real model.
 *
 * It behaves like a competent tool-using model for the investigation domain:
 * it reads the question, picks a tool, then writes a grounded JSON answer from
 * the tool results. It is intentionally simple (regexes, not intelligence).
 *
 * Why it exists:
 *  - unit tests and the CI eval gate run in seconds, with no API key and no
 *    nondeterminism, so a red build means the *system* regressed, not the model
 *  - `faults` inject the failure modes we must handle: rate limits, outages,
 *    hallucinated numbers, malformed output, overconfidence. Each guardrail and
 *    retry path has a test that proves it fires.
 *
 * Live evals (npm run eval:live) exercise the real model on the same datasets.
 */
export type FakeFaults = {
  /** Add a number to the answer that never appeared in any tool result. */
  hallucinate?: boolean;
  /** Return prose instead of the JSON contract. */
  badJson?: boolean;
  /** Mark insufficient_data answers as high confidence. */
  overconfident?: boolean;
  /** Cite a tool_use id that does not exist. */
  badCitation?: boolean;
  /** Keep calling tools forever (tests the turn / tool-call caps). */
  loopForever?: boolean;
  /** Throw a transient failure for the first N calls. */
  failFirstN?: number;
  failWith?: 'rate_limit' | 'unavailable';
  /** Simulated latency per call. */
  latencyMs?: number;
};

export class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  calls = 0;
  private counter = 0;

  constructor(private readonly faults: FakeFaults = {}) {}

  async complete(req: CompletionRequest, opts: { signal?: AbortSignal } = {}): Promise<CompletionResponse> {
    this.calls += 1;
    if (this.faults.latencyMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.faults.latencyMs);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new AIFailure('TIMEOUT', 'aborted', { retryable: false }));
        });
      });
    }
    if (opts.signal?.aborted) throw new AIFailure('TIMEOUT', 'aborted', { retryable: false });
    if (this.faults.failFirstN && this.calls <= this.faults.failFirstN) {
      throw this.faults.failWith === 'unavailable'
        ? new AIFailure('PROVIDER_UNAVAILABLE', 'simulated outage')
        : new AIFailure('PROVIDER_RATE_LIMITED', 'simulated 429');
    }

    const question = firstUserText(req.messages);
    const history = collectToolHistory(req.messages);
    const inputTokens = Math.ceil((req.system.length + JSON.stringify(req.messages).length) / 4);

    let content: ContentBlock[];
    let stopReason: CompletionResponse['stopReason'];

    if (history.length === 0 || this.faults.loopForever) {
      const plan = this.faults.loopForever ? { name: 'list_subnets', input: { limit: 5 } } : planToolCall(question);
      if (plan) {
        content = [{ type: 'tool_use', id: `toolu_fake_${++this.counter}`, name: plan.name, input: plan.input }];
        stopReason = 'tool_use';
      } else {
        content = [{ type: 'text', text: this.render(insufficient('The question does not identify a subnet or validator I can look up.'), []) }];
        stopReason = 'end_turn';
      }
    } else {
      content = [{ type: 'text', text: this.render(compose(history), history) }];
      stopReason = 'end_turn';
    }

    const outputTokens = Math.ceil(JSON.stringify(content).length / 4);
    return { model: req.model, content, stopReason, usage: { inputTokens, outputTokens } };
  }

  private render(answer: AnswerDraft, history: ToolHistory[]): string {
    const a = { ...answer, findings: [...answer.findings] };
    if (this.faults.hallucinate) a.answer += ' Historical peak stake on this subnet was 987654 TAO.';
    if (this.faults.overconfident && a.status === 'insufficient_data') a.confidence = 'high';
    if (this.faults.badCitation && history.length > 0) a.findings.push({ claim: 'Extra claim.', evidence: 'toolu_does_not_exist' });
    if (this.faults.badJson) return `Sure! Here is what I found: ${a.answer}`;
    return JSON.stringify(a);
  }
}

// ---------------------------------------------------------------- planning

type Plan = { name: string; input: Record<string, unknown> };

export function planToolCall(question: string): Plan | null {
  const q = question.trim();
  const hotkeys = q.match(/\b5[1-9A-HJ-NP-Za-km-z]{46,48}\b/g) ?? [];
  const quoted = [...q.matchAll(/["“']([^"”']{2,40})["”']/g)].map((m) => m[1]!.trim());
  const subnetMatch = q.match(/\b(?:subnet|netuid|sn)\s*#?(\d{1,4})\b/i);
  const netuid = subnetMatch ? Number(subnetMatch[1]) : undefined;

  const compare = /\b(compare|vs\.?|versus|against|side[- ]by[- ]side)\b/i.test(q);
  const names = [...hotkeys, ...quoted];
  if (compare && names.length >= 2) {
    return { name: 'compare_validators', input: netuid !== undefined ? { identifiers: names.slice(0, 5), netuid } : { identifiers: names.slice(0, 5) } };
  }
  if (netuid !== undefined && /\b(validators?|who validates|inactive|stale|top)\b/i.test(q)) {
    return { name: 'get_subnet_validators', input: { netuid, limit: 10 } };
  }
  if (netuid !== undefined) return { name: 'get_subnet', input: { netuid } };
  if (names.length >= 1) return { name: 'get_validator', input: { identifier: names[0] } };
  if (/\b(which|rank|list|all|most|highest|largest)\b.*\bsubnets?\b/i.test(q)) return { name: 'list_subnets', input: { limit: 10 } };
  return null;
}

// ---------------------------------------------------------------- composing

type AnswerDraft = {
  status: 'ok' | 'insufficient_data';
  answer: string;
  findings: { claim: string; evidence: string }[];
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
};

type ToolHistory = { id: string; name: string; input: Record<string, unknown>; result: unknown; isError: boolean };

function insufficient(why: string): AnswerDraft {
  return { status: 'insufficient_data', answer: `I could not answer this from on-chain data: ${why}`, findings: [], confidence: 'low', caveats: [why] };
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function compose(history: ToolHistory[]): AnswerDraft {
  const last = history[history.length - 1]!;
  if (last.isError) return insufficient(`the ${last.name} tool failed (${String((last.result as { error?: string })?.error ?? 'error')}).`);
  const r = last.result as Record<string, unknown>;

  switch (last.name) {
    case 'get_subnet': {
      if (!r['found']) return insufficient(String(r['message'] ?? 'subnet not found'));
      const s = r['subnet'] as Record<string, number | string>;
      return {
        status: 'ok',
        answer: `Subnet ${s['netuid']} (${s['name']}) — ${s['description']} It receives ${pct(Number(s['emissionShare']))} of network emission, registration costs ${s['registrationCostTao']} TAO, and it currently has ${s['activeValidators']} active validators and ${s['activeMiners']} active miners.`,
        findings: [
          { claim: `Emission share is ${pct(Number(s['emissionShare']))}.`, evidence: last.id },
          { claim: `Registration cost is ${s['registrationCostTao']} TAO.`, evidence: last.id },
          { claim: `${s['activeValidators']} active validators, ${s['activeMiners']} active miners.`, evidence: last.id },
        ],
        confidence: 'high',
        caveats: [`Data as of block ${s['updatedBlock']}.`],
      };
    }
    case 'get_validator': {
      if (!r['found']) return insufficient(String(r['message'] ?? 'validator not found'));
      const v = r['validator'] as Record<string, unknown>;
      const subnets = v['subnets'] as Record<string, number>[];
      const stale = subnets.filter((s) => s['vtrust']! < 0.85 || s['lastSetWeightsBlocksAgo']! > 3600);
      const findings = [
        { claim: `Take rate is ${pct(Number(v['takeRate']))} with total stake ${v['totalStakeTao']} TAO.`, evidence: last.id },
        { claim: `30-day uptime is ${pct(Number(v['uptime30d']))}.`, evidence: last.id },
        ...stale.map((s) => ({
          claim: `On subnet ${s['netuid']}, vtrust is ${s['vtrust']} and weights were last set ${s['lastSetWeightsBlocksAgo']} blocks ago — possible inactivity.`,
          evidence: last.id,
        })),
      ];
      return {
        status: 'ok',
        answer: `${v['name']} validates ${subnets.length} subnets with ${v['totalStakeTao']} TAO total stake, a ${pct(Number(v['takeRate']))} take rate and ${pct(Number(v['uptime30d']))} uptime over 30 days.${stale.length ? ` ${stale.length} subnet(s) show signs of inactivity.` : ' No inactivity flags.'}`,
        findings,
        confidence: stale.length ? 'medium' : 'high',
        caveats: [`Data as of block ${v['updatedBlock']}.`],
      };
    }
    case 'compare_validators': {
      const missing = (r['missing'] as string[]) ?? [];
      const vs = (r['validators'] as Record<string, unknown>[]) ?? [];
      if (vs.length < 2) return insufficient(`could not resolve ${missing.join(', ') || 'the validators'}.`);
      const netuid = r['netuid'] as number | null;
      const rows = vs.map((v) => {
        const on = v['onSubnet'] as Record<string, number> | null | undefined;
        return { name: String(v['name']), take: Number(v['takeRate']), stake: Number(v['totalStakeTao']), uptime: Number(v['uptime30d']), on };
      });
      const findings = rows.map((row) => ({
        claim:
          netuid !== null && row.on
            ? `${row.name}: ${row.on['stakeTao']} TAO on subnet ${netuid}, vtrust ${row.on['vtrust']}, ${row.on['dividendsPerDayTao']} TAO/day dividends, take ${pct(row.take)}.`
            : `${row.name}: ${row.stake} TAO total stake, take ${pct(row.take)}, uptime ${pct(row.uptime)}.`,
        evidence: last.id,
      }));
      const byStake = [...rows].sort((a, b) => (netuid !== null ? (b.on?.['stakeTao'] ?? 0) - (a.on?.['stakeTao'] ?? 0) : b.stake - a.stake));
      const lowestTake = [...rows].sort((a, b) => a.take - b.take)[0]!;
      const caveats = missing.length ? [`Not found: ${missing.join(', ')}.`] : [];
      return {
        status: 'ok',
        answer: `${byStake[0]!.name} has the most stake${netuid !== null ? ` on subnet ${netuid}` : ''}; ${lowestTake.name} has the lowest take rate at ${pct(lowestTake.take)}. See findings for the side-by-side.`,
        findings,
        confidence: missing.length ? 'medium' : 'high',
        caveats,
      };
    }
    case 'get_subnet_validators': {
      const vs = (r['validators'] as Record<string, unknown>[]) ?? [];
      const netuid = r['netuid'] as number;
      if (vs.length === 0) return insufficient(`no validators found on subnet ${netuid}.`);
      const findings = vs.map((v) => {
        const on = v['onSubnet'] as Record<string, number>;
        const flag = on['vtrust']! < 0.85 || on['lastSetWeightsBlocksAgo']! > 3600 ? ' (possible inactivity)' : '';
        return { claim: `${v['name']}: ${on['stakeTao']} TAO, vtrust ${on['vtrust']}, weights set ${on['lastSetWeightsBlocksAgo']} blocks ago${flag}.`, evidence: last.id };
      });
      const flagged = findings.filter((f) => f.claim.includes('inactivity')).length;
      return {
        status: 'ok',
        answer: `Subnet ${netuid} has ${vs.length} validators in the top set, led by ${String(vs[0]!['name'])}. ${flagged} validator(s) show possible inactivity.`,
        findings,
        confidence: 'high',
        caveats: [],
      };
    }
    case 'list_subnets': {
      const subs = (r['subnets'] as Record<string, unknown>[]) ?? [];
      if (subs.length === 0) return insufficient('no subnets returned.');
      return {
        status: 'ok',
        answer: `Top subnets by emission share: ${subs.map((s) => `${s['name']} (netuid ${s['netuid']}, ${pct(Number(s['emissionShare']))})`).join(', ')}.`,
        findings: subs.map((s) => ({ claim: `Subnet ${s['netuid']} ${s['name']} has ${pct(Number(s['emissionShare']))} emission share.`, evidence: last.id })),
        confidence: 'high',
        caveats: [],
      };
    }
    default:
      return insufficient(`unexpected tool ${last.name}.`);
  }
}

// ---------------------------------------------------------------- helpers

function firstUserText(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const t = m.content.find((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text');
    if (t) return t.text;
  }
  return '';
}

function collectToolHistory(messages: Message[]): ToolHistory[] {
  const uses = new Map<string, ToolUseBlock>();
  const out: ToolHistory[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') uses.set(b.id, b);
      if (b.type === 'tool_result') {
        const u = uses.get(b.toolUseId);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(b.content);
        } catch {
          parsed = { error: b.content };
        }
        out.push({ id: b.toolUseId, name: u?.name ?? 'unknown', input: u?.input ?? {}, result: parsed, isError: b.isError ?? false });
      }
    }
  }
  return out;
}
