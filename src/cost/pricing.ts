import type { Usage } from '../llm/types.js';

/**
 * USD per million tokens. Kept in code (not env) so a price change is a
 * reviewed PR with a diff, and so evals can assert cost budgets deterministically.
 * Unknown models fall back to the most expensive known price: we would rather
 * over-count and trip a budget than silently under-count.
 */
export type Price = { inputPerMTok: number; outputPerMTok: number };

export const PRICES: Record<string, Price> = {
  'claude-opus-4-20250514': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4-20250514': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-5-haiku-20241022': { inputPerMTok: 0.8, outputPerMTok: 4 },
  'fake-primary': { inputPerMTok: 3, outputPerMTok: 15 },
  'fake-fast': { inputPerMTok: 0.8, outputPerMTok: 4 },
};

const FALLBACK: Price = { inputPerMTok: 15, outputPerMTok: 75 };

export function priceFor(model: string): { price: Price; known: boolean } {
  const exact = PRICES[model];
  if (exact) return { price: exact, known: true };
  // tolerate dated aliases e.g. "claude-sonnet-4" → any key starting with it
  const prefix = Object.keys(PRICES).find((k) => model.startsWith(k) || k.startsWith(model));
  if (prefix) return { price: PRICES[prefix]!, known: true };
  return { price: FALLBACK, known: false };
}

export function estimateCostUsd(model: string, usage: Usage): number {
  const { price } = priceFor(model);
  return (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
}
