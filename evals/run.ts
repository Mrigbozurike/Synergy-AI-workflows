import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPT_VERSION } from '../src/agent/prompt.js';
import { createApp } from '../src/app.js';
import { FixtureChainClient } from '../src/chain/fixtureClient.js';
import { loadConfig } from '../src/config.js';
import { AIFailure } from '../src/errors.js';
import { FakeProvider, type FakeFaults } from '../src/llm/fake.js';
import { createProvider } from '../src/llm/index.js';
import { silentLogger } from '../src/observability/logger.js';
import { judge } from './scorers/judge.js';
import { score } from './scorers/index.js';
import { EvalCaseSchema, type CaseReport, type EvalCase, type EvalReport, type Outcome, type SuiteReport } from './types.js';

/**
 * Eval runner.
 *
 *   npm run eval                 offline: deterministic provider, hard gate, runs in CI on every PR
 *   npm run eval:live            live: real model, softer thresholds, scheduled / on demand
 *   npm run eval -- --suite guardrails --verbose
 *   npm run eval:update-baseline (writes new thresholds from this run; review the diff!)
 *
 * Output: a table on stdout and evals/reports/latest.json. Exit code 1 when
 * the gate fails so CI blocks the merge.
 */
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfig();
const mode: 'offline' | 'live' = config.LLM_PROVIDER === 'fake' ? 'offline' : 'live';
const onlySuite = opt('suite');
const verbose = flag('verbose');
const useJudge = process.env['EVAL_JUDGE'] === '1' && mode === 'live';

function loadCases(): EvalCase[] {
  const dir = join(here, 'datasets');
  const cases: EvalCase[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const suite = file.replace(/\.jsonl$/, '');
    if (onlySuite && suite !== onlySuite) continue;
    const lines = readFileSync(join(dir, file), 'utf8').split('\n').filter((l) => l.trim());
    lines.forEach((line, i) => {
      const parsed = EvalCaseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`${file}:${i + 1} invalid case: ${parsed.error.message}`);
      cases.push({ ...parsed.data, suite });
    });
  }
  return cases;
}

async function runCase(c: EvalCase): Promise<CaseReport> {
  if (mode === 'live' && c.faults) {
    return { id: c.id, suite: c.suite, question: c.question, pass: true, skipped: 'fault injection is offline-only', scores: [], costUsd: 0, latencyMs: 0, toolCalls: [], outcome: 'skipped' };
  }
  const provider = mode === 'offline' ? new FakeProvider((c.faults ?? {}) as FakeFaults) : createProvider(config);
  const chain = c.chainFailEvery ? new FixtureChainClient({ failEvery: c.chainFailEvery }) : new FixtureChainClient();
  const app = createApp({ provider, chain, logger: silentLogger, config: { AGENT_MAX_TURNS: 4, AGENT_MAX_TOOL_CALLS: 4 } });

  const started = Date.now();
  let outcome: Outcome;
  try {
    outcome = { kind: 'result', result: await app.investigator.investigate(c.question, { requestId: `eval-${c.id}` }) };
  } catch (err) {
    if (!(err instanceof AIFailure)) throw err;
    outcome = { kind: 'failure', failure: err };
  }
  const latencyMs = Date.now() - started;

  const scores = score(c, outcome);
  if (useJudge) {
    const j = await judge(app.provider, config.LLM_MODEL_FAST, c, outcome);
    if (j) scores.push(j);
  }
  // The judge informs; it does not gate (see scorers/judge.ts).
  const pass = scores.filter((s) => s.scorer !== 'judge').every((s) => s.pass);

  return {
    id: c.id,
    suite: c.suite,
    question: c.question,
    pass,
    scores,
    costUsd: app.ledger.spentTodayUsd(),
    latencyMs,
    toolCalls: outcome.kind === 'result' ? outcome.result.toolCalls.map((t) => t.name) : [],
    outcome: outcome.kind === 'result' ? outcome.result.answer.status : outcome.failure.code,
    ...(outcome.kind === 'result' ? { answer: outcome.result.answer.answer } : {}),
  };
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function summarise(cases: CaseReport[]): { suites: SuiteReport[]; totals: EvalReport['totals'] } {
  const bySuite = new Map<string, CaseReport[]>();
  for (const c of cases) bySuite.set(c.suite, [...(bySuite.get(c.suite) ?? []), c]);
  const suites: SuiteReport[] = [...bySuite.entries()].map(([suite, cs]) => {
    const active = cs.filter((c) => !c.skipped);
    const passed = active.filter((c) => c.pass).length;
    return {
      suite,
      total: active.length,
      passed,
      skipped: cs.length - active.length,
      passRate: active.length ? passed / active.length : 1,
      costUsd: cs.reduce((s, c) => s + c.costUsd, 0),
      p95LatencyMs: p95(active.map((c) => c.latencyMs)),
    };
  });
  const active = cases.filter((c) => !c.skipped);
  const passed = active.filter((c) => c.pass).length;
  return {
    suites,
    totals: {
      total: active.length,
      passed,
      skipped: cases.length - active.length,
      passRate: active.length ? passed / active.length : 1,
      costUsd: cases.reduce((s, c) => s + c.costUsd, 0),
      p95LatencyMs: p95(active.map((c) => c.latencyMs)),
    },
  };
}

type Baseline = Record<'offline' | 'live', { minPassRate: Record<string, number>; maxTotalCostUsd: number; maxP95LatencyMs: number }>;

function gate(report: Omit<EvalReport, 'gate'>, baseline: Baseline): EvalReport['gate'] {
  const b = baseline[report.mode];
  const reasons: string[] = [];
  const overall = b.minPassRate['overall'] ?? 1;
  if (report.totals.passRate < overall) reasons.push(`overall pass rate ${pct(report.totals.passRate)} < ${pct(overall)}`);
  for (const s of report.suites) {
    const min = b.minPassRate[s.suite];
    if (min !== undefined && s.passRate < min) reasons.push(`${s.suite} pass rate ${pct(s.passRate)} < ${pct(min)}`);
  }
  if (report.totals.costUsd > b.maxTotalCostUsd) reasons.push(`total cost $${report.totals.costUsd.toFixed(4)} > $${b.maxTotalCostUsd}`);
  if (report.totals.p95LatencyMs > b.maxP95LatencyMs) reasons.push(`p95 latency ${report.totals.p95LatencyMs}ms > ${b.maxP95LatencyMs}ms`);
  return { pass: reasons.length === 0, reasons };
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

async function main() {
  const cases = loadCases();
  console.log(`Running ${cases.length} eval cases [mode=${mode} provider=${config.LLM_PROVIDER} model=${config.LLM_MODEL_PRIMARY} prompt=${PROMPT_VERSION}${useJudge ? ' judge=on' : ''}]\n`);

  const results: CaseReport[] = [];
  // Offline: parallel is fine. Live: serial to respect rate limits and keep cost predictable.
  if (mode === 'offline') {
    results.push(...(await Promise.all(cases.map(runCase))));
  } else {
    for (const c of cases) results.push(await runCase(c));
  }

  for (const r of results) {
    const mark = r.skipped ? '–' : r.pass ? '✓' : '✗';
    console.log(`${mark} ${r.suite}/${r.id}  [${r.outcome}] ${r.latencyMs}ms $${r.costUsd.toFixed(4)}${r.skipped ? `  (skipped: ${r.skipped})` : ''}`);
    for (const s of r.scores) {
      if (!s.pass || verbose) console.log(`    ${s.pass ? 'ok ' : 'FAIL'} ${s.scorer}: ${s.detail}`);
    }
  }

  const { suites, totals } = summarise(results);
  const baseline = JSON.parse(readFileSync(join(here, 'baseline.json'), 'utf8')) as Baseline;
  const partial = { generatedAt: new Date().toISOString(), provider: config.LLM_PROVIDER, model: config.LLM_MODEL_PRIMARY, promptVersion: PROMPT_VERSION, mode, suites, cases: results, totals };
  const report: EvalReport = { ...partial, gate: gate(partial, baseline) };

  console.log('\nSuite summary');
  for (const s of suites) console.log(`  ${s.suite.padEnd(24)} ${String(s.passed).padStart(2)}/${s.total}  ${pct(s.passRate).padStart(4)}  p95 ${s.p95LatencyMs}ms  $${s.costUsd.toFixed(4)}`);
  console.log(`  ${'overall'.padEnd(24)} ${String(totals.passed).padStart(2)}/${totals.total}  ${pct(totals.passRate).padStart(4)}  p95 ${totals.p95LatencyMs}ms  $${totals.costUsd.toFixed(4)}`);

  mkdirSync(join(here, 'reports'), { recursive: true });
  writeFileSync(join(here, 'reports', 'latest.json'), JSON.stringify(report, null, 2));

  if (flag('update-baseline')) {
    const b = baseline[mode];
    b.minPassRate['overall'] = Math.floor(totals.passRate * 20) / 20; // round down to 5%
    for (const s of suites) b.minPassRate[s.suite] = Math.floor(s.passRate * 20) / 20;
    b.maxTotalCostUsd = Math.ceil(totals.costUsd * 1.5 * 100) / 100;
    b.maxP95LatencyMs = Math.ceil((totals.p95LatencyMs * 1.5) / 100) * 100;
    writeFileSync(join(here, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n');
    console.log(`\nBaseline (${mode}) updated — review the diff before committing.`);
  }

  if (report.gate.pass) {
    console.log('\nGATE PASSED');
  } else {
    console.log('\nGATE FAILED');
    for (const r of report.gate.reasons) console.log(`  - ${r}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
