import { z } from 'zod';
import type { InvestigateResult } from '../src/agent/investigator.js';
import type { AIFailure } from '../src/errors.js';

const Confidence = z.enum(['low', 'medium', 'high']);

export const EvalCaseSchema = z.object({
  id: z.string(),
  question: z.string(),
  /** Fault injection for the fake provider; such cases are skipped in live mode. */
  faults: z.record(z.unknown()).optional(),
  /** Make the chain client fail every Nth call (works with any provider). */
  chainFailEvery: z.number().int().positive().optional(),
  expect: z.object({
    status: z.enum(['ok', 'insufficient_data']).optional(),
    failure: z.string().optional(),
    rule: z.string().optional(),
    tools: z.array(z.string()).optional(),
    contains: z.array(z.string()).optional(),
    notContains: z.array(z.string()).optional(),
    confidence: Confidence.optional(),
    minConfidence: Confidence.optional(),
    maxConfidence: Confidence.optional(),
    maxToolCalls: z.number().int().optional(),
    maxCostUsd: z.number().optional(),
    maxLatencyMs: z.number().optional(),
  }),
});

export type EvalCase = z.infer<typeof EvalCaseSchema> & { suite: string };

export type Outcome = { kind: 'result'; result: InvestigateResult } | { kind: 'failure'; failure: AIFailure };

export type ScoreDetail = { scorer: string; pass: boolean; detail: string };

export type CaseReport = {
  id: string;
  suite: string;
  question: string;
  pass: boolean;
  skipped?: string;
  scores: ScoreDetail[];
  costUsd: number;
  latencyMs: number;
  toolCalls: string[];
  outcome: string;
  answer?: string;
};

export type SuiteReport = { suite: string; total: number; passed: number; skipped: number; passRate: number; costUsd: number; p95LatencyMs: number };

export type EvalReport = {
  generatedAt: string;
  provider: string;
  model: string;
  promptVersion: string;
  mode: 'offline' | 'live';
  suites: SuiteReport[];
  cases: CaseReport[];
  totals: { total: number; passed: number; skipped: number; passRate: number; costUsd: number; p95LatencyMs: number };
  gate: { pass: boolean; reasons: string[] };
};
