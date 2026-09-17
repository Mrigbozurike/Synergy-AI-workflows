import type { CostLedger } from '../cost/ledger.js';

/**
 * Model routing is an explicit, observable decision.
 *
 * Normal operation uses the primary model. When the daily budget is nearly
 * exhausted we switch to the fast model so the feature stays available
 * (cheaper, slightly lower quality) instead of hard-failing; the response and
 * metrics carry `degraded: true` so nobody mistakes degraded answers for
 * normal ones. Once the budget is fully spent, the ledger fails the request
 * with BUDGET_EXCEEDED: degradation has a floor.
 */
export type RoutingDecision = { model: string; degraded: boolean; reason: string };

export function chooseModel(
  ledger: CostLedger,
  models: { primary: string; fast: string },
  opts: { degradeBelowFraction?: number } = {},
): RoutingDecision {
  const threshold = opts.degradeBelowFraction ?? 0.1;
  const snap = ledger.snapshot();
  const remainingFraction = snap.dailyBudgetUsd > 0 ? snap.remainingTodayUsd / snap.dailyBudgetUsd : 0;
  if (remainingFraction < threshold) {
    return { model: models.fast, degraded: true, reason: `daily budget below ${threshold * 100}%` };
  }
  return { model: models.primary, degraded: false, reason: 'normal' };
}
