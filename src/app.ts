import { Investigator } from './agent/investigator.js';
import { FixtureChainClient } from './chain/fixtureClient.js';
import type { ChainClient } from './chain/types.js';
import { loadConfig, type Config } from './config.js';
import { CostLedger } from './cost/ledger.js';
import { createProvider } from './llm/index.js';
import type { LLMProvider } from './llm/types.js';
import { Logger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { InMemoryTraceStore } from './observability/tracer.js';
import { buildChainTools } from './tools/chainTools.js';

/**
 * Composition root. Everything is injectable so tests and evals can swap the
 * provider, chain client, clock or logger without touching the wiring.
 */
export type App = {
  config: Config;
  investigator: Investigator;
  ledger: CostLedger;
  metrics: Metrics;
  traces: InMemoryTraceStore;
  logger: Logger;
  provider: LLMProvider;
};

export function createApp(
  overrides: {
    config?: Partial<Config>;
    provider?: LLMProvider;
    chain?: ChainClient;
    logger?: Logger;
    now?: () => number;
  } = {},
): App {
  const config: Config = Object.freeze({ ...loadConfig(), ...overrides.config });
  const logger = overrides.logger ?? new Logger(config.LOG_LEVEL, { service: 'synergy-ai' });
  const provider = overrides.provider ?? createProvider(config);
  const chain = overrides.chain ?? new FixtureChainClient();
  const tools = buildChainTools(chain);
  const ledger = new CostLedger(
    { maxPerRequestUsd: config.COST_MAX_PER_REQUEST_USD, dailyBudgetUsd: config.COST_DAILY_BUDGET_USD },
    overrides.now,
  );
  const metrics = new Metrics();
  const traces = new InMemoryTraceStore();
  metrics.budgetRemaining.set(ledger.remainingTodayUsd());

  const investigator = new Investigator({ provider, tools, ledger, metrics, logger, exporter: traces.exporter, config });

  return { config, investigator, ledger, metrics, traces, logger, provider };
}
