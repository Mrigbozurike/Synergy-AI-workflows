import { AIFailure } from '../errors.js';
import type { Usage } from '../llm/types.js';
import { estimateCostUsd } from './pricing.js';

/**
 * Cost ledger + budget enforcement.
 *
 * Two limits, both hard:
 *  - per request: a single runaway agent loop cannot spend more than X
 *  - per day (rolling UTC day): the whole service cannot spend more than Y
 *
 * When a limit is hit we fail loudly with BUDGET_EXCEEDED rather than silently
 * degrading to a cheaper model: operators must know the feature is capped.
 * Model downgrades are an explicit routing decision (see agent/router.ts).
 *
 * The store is in-memory here; the interface is small enough to back with Redis.
 */
export type LedgerEntry = {
  at: number;
  requestId: string;
  model: string;
  usage: Usage;
  costUsd: number;
};

export class CostLedger {
  private entries: LedgerEntry[] = [];
  private perRequest = new Map<string, number>();

  constructor(
    private readonly limits: { maxPerRequestUsd: number; dailyBudgetUsd: number },
    private readonly now: () => number = Date.now,
  ) {}

  /** Call before a model call with an upper-bound estimate to avoid overspend. */
  assertCanSpend(requestId: string, projectedUsd: number): void {
    const spentToday = this.spentTodayUsd();
    if (spentToday + projectedUsd > this.limits.dailyBudgetUsd) {
      throw new AIFailure('BUDGET_EXCEEDED', 'Daily AI budget exhausted', {
        details: { spentTodayUsd: round(spentToday), dailyBudgetUsd: this.limits.dailyBudgetUsd },
      });
    }
    const spentRequest = this.perRequest.get(requestId) ?? 0;
    if (spentRequest + projectedUsd > this.limits.maxPerRequestUsd) {
      throw new AIFailure('BUDGET_EXCEEDED', 'Per-request AI budget exhausted', {
        details: { spentRequestUsd: round(spentRequest), maxPerRequestUsd: this.limits.maxPerRequestUsd },
      });
    }
  }

  record(requestId: string, model: string, usage: Usage): LedgerEntry {
    const costUsd = estimateCostUsd(model, usage);
    const entry: LedgerEntry = { at: this.now(), requestId, model, usage, costUsd };
    this.entries.push(entry);
    this.perRequest.set(requestId, (this.perRequest.get(requestId) ?? 0) + costUsd);
    return entry;
  }

  requestTotalUsd(requestId: string): number {
    return this.perRequest.get(requestId) ?? 0;
  }

  spentTodayUsd(): number {
    const dayStart = startOfUtcDay(this.now());
    // prune older than today to bound memory
    this.entries = this.entries.filter((e) => e.at >= dayStart);
    return this.entries.reduce((sum, e) => sum + e.costUsd, 0);
  }

  remainingTodayUsd(): number {
    return Math.max(0, this.limits.dailyBudgetUsd - this.spentTodayUsd());
  }

  snapshot() {
    return {
      spentTodayUsd: round(this.spentTodayUsd()),
      remainingTodayUsd: round(this.remainingTodayUsd()),
      dailyBudgetUsd: this.limits.dailyBudgetUsd,
      maxPerRequestUsd: this.limits.maxPerRequestUsd,
      entriesToday: this.entries.length,
    };
  }
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
