import { describe, expect, it } from 'vitest';
import { CostLedger } from '../src/cost/ledger.js';
import { estimateCostUsd, priceFor } from '../src/cost/pricing.js';
import { chooseModel } from '../src/agent/router.js';
import { AIFailure } from '../src/errors.js';

describe('pricing', () => {
  it('computes cost from the price table', () => {
    expect(estimateCostUsd('claude-sonnet-4-20250514', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(3);
    expect(estimateCostUsd('claude-sonnet-4-20250514', { inputTokens: 0, outputTokens: 1_000_000 })).toBe(15);
  });

  it('falls back to the most expensive price for unknown models', () => {
    const { known, price } = priceFor('some-new-model');
    expect(known).toBe(false);
    expect(price.outputPerMTok).toBe(75);
  });
});

describe('cost ledger', () => {
  const model = 'claude-sonnet-4-20250514';

  it('enforces per-request and daily budgets', () => {
    let now = Date.UTC(2026, 0, 1, 12);
    const ledger = new CostLedger({ maxPerRequestUsd: 0.05, dailyBudgetUsd: 0.12 }, () => now);

    ledger.record('r1', model, { inputTokens: 10_000, outputTokens: 1_000 }); // $0.045
    expect(() => ledger.assertCanSpend('r1', 0.01)).toThrowError(AIFailure);
    expect(() => ledger.assertCanSpend('r1', 0.01)).toThrow(/Per-request/);
    expect(() => ledger.assertCanSpend('r2', 0.01)).not.toThrow();

    ledger.record('r2', model, { inputTokens: 10_000, outputTokens: 1_000 }); // total $0.09
    expect(() => ledger.assertCanSpend('r3', 0.04)).toThrow(/Daily/);
    expect(ledger.snapshot().entriesToday).toBe(2);

    now += 24 * 3600 * 1000; // next UTC day → budget resets, old entries pruned
    expect(ledger.spentTodayUsd()).toBe(0);
    expect(() => ledger.assertCanSpend('r3', 0.04)).not.toThrow();
  });

  it('reports typed BUDGET_EXCEEDED with details', () => {
    const ledger = new CostLedger({ maxPerRequestUsd: 1, dailyBudgetUsd: 0.001 });
    try {
      ledger.assertCanSpend('x', 0.01);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AIFailure);
      const f = err as AIFailure;
      expect(f.code).toBe('BUDGET_EXCEEDED');
      expect(f.httpStatus).toBe(429);
      expect(f.details['dailyBudgetUsd']).toBe(0.001);
    }
  });
});

describe('model router', () => {
  const models = { primary: 'primary', fast: 'fast' };
  it('uses the primary model normally', () => {
    const ledger = new CostLedger({ maxPerRequestUsd: 1, dailyBudgetUsd: 10 });
    expect(chooseModel(ledger, models)).toMatchObject({ model: 'primary', degraded: false });
  });
  it('degrades to the fast model when budget is nearly gone', () => {
    const ledger = new CostLedger({ maxPerRequestUsd: 10, dailyBudgetUsd: 1 });
    ledger.record('r', 'claude-sonnet-4-20250514', { inputTokens: 0, outputTokens: 62_000 }); // $0.93
    expect(chooseModel(ledger, models)).toMatchObject({ model: 'fast', degraded: true });
  });
});
