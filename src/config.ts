import { z } from 'zod';

/**
 * All runtime configuration is parsed once, validated with zod, and frozen.
 * Misconfiguration fails at boot, not on the first request at 3am.
 */
const ConfigSchema = z.object({
  LLM_PROVIDER: z.enum(['fake', 'anthropic']).default('fake'),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL_PRIMARY: z.string().default('claude-sonnet-4-20250514'),
  LLM_MODEL_FAST: z.string().default('claude-3-5-haiku-20241022'),

  COST_MAX_PER_REQUEST_USD: z.coerce.number().positive().default(0.25),
  COST_DAILY_BUDGET_USD: z.coerce.number().positive().default(50),

  AGENT_MAX_TURNS: z.coerce.number().int().min(1).max(20).default(6),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(50).default(8),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),

  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.LLM_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) {
    throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }
  return Object.freeze(cfg);
}
