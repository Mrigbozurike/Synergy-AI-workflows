/**
 * Input guardrails: cheap, deterministic checks that run before any tokens are
 * spent. Each rule returns a named verdict so metrics can count which rules
 * fire and the false-positive runbook can target the right one.
 *
 * These are heuristics, and they are documented as such. They are a first
 * line, not the only line: output guardrails and evals catch what slips past.
 */
export type InputVerdict =
  | { ok: true; sanitized: string }
  | { ok: false; rule: InputRule; reason: string };

export type InputRule = 'empty' | 'too_long' | 'prompt_injection' | 'secret_material' | 'off_topic';

export type InputGuardOptions = {
  maxChars?: number;
  strictScope?: boolean;
};

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all|any|the|your)? ?(previous|prior|above) (instructions|prompts?|rules)/i,
  /disregard (the|your) (system|previous) (prompt|instructions)/i,
  /you are now (an?|the) /i,
  /reveal (your|the) (system prompt|instructions|hidden)/i,
  /\bDAN\b|do anything now/i,
  /<\/?(system|assistant|instructions?)>/i,
  /\[\s*(system|inst)\s*\]/i,
];

const DOMAIN_TERMS = [
  'subnet',
  'netuid',
  'validator',
  'miner',
  'hotkey',
  'coldkey',
  'stake',
  'staking',
  'emission',
  'tao',
  'alpha',
  'vtrust',
  'trust',
  'dividend',
  'incentive',
  'registration',
  'tempo',
  'weights',
  'bittensor',
  'metagraph',
  'neuron',
  'uid',
  'take rate',
  'delegate',
  'chain',
  'block',
];

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'what', 'how', 'who', 'are', 'you', 'can']);

export function looksLikeMnemonic(text: string): boolean {
  // 12/24-word BIP39 phrases are runs of short lowercase words with no stopwords.
  const tokens = text.split(/\s+/);
  let run = 0;
  for (const t of tokens) {
    if (/^[a-z]{3,8}$/.test(t) && !STOPWORDS.has(t)) {
      run += 1;
      if (run >= 12) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

export function checkInput(raw: string, opts: InputGuardOptions = {}): InputVerdict {
  const maxChars = opts.maxChars ?? 2_000;
  const text = raw.replace(/\s+/g, ' ').trim();

  if (!text) return { ok: false, rule: 'empty', reason: 'Question is empty' };
  if (text.length > maxChars) {
    return { ok: false, rule: 'too_long', reason: `Question exceeds ${maxChars} characters` };
  }
  for (const p of INJECTION_PATTERNS) {
    if (p.test(text)) {
      return { ok: false, rule: 'prompt_injection', reason: 'Question contains instruction-override patterns' };
    }
  }
  if (looksLikeMnemonic(text) || /\b(seed phrase|mnemonic|private key)\b/i.test(text)) {
    return {
      ok: false,
      rule: 'secret_material',
      reason: 'Question appears to contain wallet secret material; it was not processed or logged',
    };
  }
  if (opts.strictScope ?? true) {
    const lower = text.toLowerCase();
    if (!DOMAIN_TERMS.some((t) => lower.includes(t))) {
      return { ok: false, rule: 'off_topic', reason: 'Question is outside on-chain investigation scope' };
    }
  }
  return { ok: true, sanitized: text };
}
