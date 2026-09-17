import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { AIFailure, toAIFailure } from '../errors.js';
import type { CostLedger } from '../cost/ledger.js';
import { estimateCostUsd } from '../cost/pricing.js';
import { checkInput } from '../guardrails/input.js';
import { checkOutput, type Answer } from '../guardrails/output.js';
import type { ContentBlock, LLMProvider, Message, ToolUseBlock } from '../llm/types.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { Trace, type SpanExporter } from '../observability/tracer.js';
import type { ToolRegistry } from '../tools/registry.js';
import { INVESTIGATOR_SYSTEM_PROMPT, PROMPT_VERSION } from './prompt.js';
import { chooseModel } from './router.js';

export type InvestigateDeps = {
  provider: LLMProvider;
  tools: ToolRegistry;
  ledger: CostLedger;
  metrics: Metrics;
  logger: Logger;
  exporter: SpanExporter;
  config: Config;
};

export type ToolCallRecord = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  durationMs: number;
};

export type InvestigateResult = {
  requestId: string;
  traceId: string;
  promptVersion: string;
  model: string;
  degraded: boolean;
  answer: Answer;
  toolCalls: ToolCallRecord[];
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  durationMs: number;
  turns: number;
};

/**
 * The agent loop. Everything cross-cutting lives here, once:
 * budget checks, timeouts, tracing, metrics, guardrails, typed failures.
 * The provider and tools are plain dependencies, so the same loop runs
 * against the real model in production and the deterministic fake in CI.
 */
export class Investigator {
  constructor(private readonly deps: InvestigateDeps) {}

  async investigate(question: string, opts: { requestId?: string } = {}): Promise<InvestigateResult> {
    const { config, metrics, ledger, provider } = this.deps;
    const requestId = opts.requestId ?? randomUUID();
    const trace = new Trace(this.deps.exporter);
    const log = this.deps.logger.child({ requestId, traceId: trace.traceId, promptVersion: PROMPT_VERSION });
    const root = trace.start('investigate', { requestId, promptVersion: PROMPT_VERSION, provider: provider.name });
    const started = Date.now();

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), config.AGENT_TIMEOUT_MS);

    try {
      const result = await this.run(question, { requestId, trace, log, root: root.id, signal: abort.signal });
      root.set({ status: result.answer.status, costUsd: result.costUsd, turns: result.turns, model: result.model }).end();
      metrics.requests.inc({ status: 'ok', failure_code: 'none' });
      metrics.requestDuration.observe(Date.now() - started);
      metrics.budgetRemaining.set(ledger.remainingTodayUsd());
      log.info('investigation complete', {
        status: result.answer.status,
        confidence: result.answer.confidence,
        toolCalls: result.toolCalls.length,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      });
      return { ...result, requestId, traceId: trace.traceId };
    } catch (err) {
      const failure =
        abort.signal.aborted && !(err instanceof AIFailure && err.code === 'BUDGET_EXCEEDED')
          ? new AIFailure('TIMEOUT', `Investigation exceeded ${config.AGENT_TIMEOUT_MS}ms`, { cause: err })
          : toAIFailure(err);
      root.fail(failure);
      metrics.requests.inc({ status: 'error', failure_code: failure.code });
      metrics.requestDuration.observe(Date.now() - started);
      metrics.budgetRemaining.set(ledger.remainingTodayUsd());
      log.warn('investigation failed', { code: failure.code, message: failure.message, retryable: failure.retryable });
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(
    question: string,
    ctx: { requestId: string; trace: Trace; log: Logger; root: string; signal: AbortSignal },
  ): Promise<Omit<InvestigateResult, 'requestId' | 'traceId'>> {
    const { config, metrics, ledger, provider, tools } = this.deps;
    const started = Date.now();

    // 1. Input guardrail (free; runs before any tokens are spent)
    const inputSpan = ctx.trace.start('guardrail.input', {}, ctx.root);
    const verdict = checkInput(question);
    if (!verdict.ok) {
      metrics.guardrailEvents.inc({ stage: 'input', rule: verdict.rule });
      inputSpan.set({ rule: verdict.rule }).fail(verdict.reason);
      throw new AIFailure('GUARDRAIL_INPUT_REJECTED', verdict.reason, { details: { rule: verdict.rule } });
    }
    metrics.guardrailEvents.inc({ stage: 'input', rule: 'pass' });
    inputSpan.end();

    // 2. Routing
    const route = chooseModel(ledger, { primary: config.LLM_MODEL_PRIMARY, fast: config.LLM_MODEL_FAST });
    if (route.degraded) ctx.log.warn('degraded routing', { model: route.model, reason: route.reason });

    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: verdict.sanitized }] }];
    const toolCalls: ToolCallRecord[] = [];
    const toolResultTexts: string[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const maxTokens = 1_200;

    for (let turn = 1; turn <= config.AGENT_MAX_TURNS; turn += 1) {
      if (ctx.signal.aborted) throw new AIFailure('TIMEOUT', 'aborted');

      // 3. Budget check with a conservative projection before spending
      const projected = estimateCostUsd(route.model, {
        inputTokens: Math.ceil(JSON.stringify(messages).length / 3) + 800,
        outputTokens: maxTokens,
      });
      ledger.assertCanSpend(ctx.requestId, projected);

      // 4. Model call
      const callSpan = ctx.trace.start('model.call', { model: route.model, turn, provider: provider.name }, ctx.root);
      const callStarted = Date.now();
      const res = await provider.complete(
        {
          model: route.model,
          system: INVESTIGATOR_SYSTEM_PROMPT,
          messages,
          tools: tools.specs(),
          maxTokens,
          temperature: 0,
        },
        { signal: ctx.signal },
      );
      const entry = ledger.record(ctx.requestId, res.model, res.usage);
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      metrics.modelCalls.inc({ model: res.model, provider: provider.name });
      metrics.modelCallDuration.observe(Date.now() - callStarted, { model: res.model });
      metrics.tokens.inc({ model: res.model, direction: 'input' }, res.usage.inputTokens);
      metrics.tokens.inc({ model: res.model, direction: 'output' }, res.usage.outputTokens);
      metrics.costUsd.inc({ model: res.model }, entry.costUsd);
      callSpan
        .set({ stopReason: res.stopReason, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: entry.costUsd })
        .end();

      if (res.stopReason === 'max_tokens') {
        throw new AIFailure('AGENT_LIMIT_REACHED', 'Model output truncated at max_tokens', { details: { turn } });
      }

      messages.push({ role: 'assistant', content: res.content });
      const toolUses = res.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

      // 5. Final answer → output guardrail
      if (res.stopReason !== 'tool_use' || toolUses.length === 0) {
        const text = res.content
          .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        const outSpan = ctx.trace.start('guardrail.output', {}, ctx.root);
        const out = checkOutput(text, { toolUseIds: toolCalls.map((t) => t.id), toolResultText: toolResultTexts.join('\n') });
        if (!out.ok) {
          metrics.guardrailEvents.inc({ stage: 'output', rule: out.rule });
          outSpan.set({ rule: out.rule }).fail(out.reason);
          throw new AIFailure('GUARDRAIL_OUTPUT_REJECTED', out.reason, { details: { rule: out.rule, turn } });
        }
        metrics.guardrailEvents.inc({ stage: 'output', rule: 'pass' });
        outSpan.end();

        if (out.answer.status === 'insufficient_data') {
          // An honest "I can't answer this" is a success of the system and a
          // distinct outcome for the caller. It is returned, not thrown, so the
          // UI can render it; metrics label it separately via the status field.
          ctx.log.info('insufficient data', { caveats: out.answer.caveats });
        }

        return {
          promptVersion: PROMPT_VERSION,
          model: route.model,
          degraded: route.degraded,
          answer: out.answer,
          toolCalls,
          usage,
          costUsd: ledger.requestTotalUsd(ctx.requestId),
          durationMs: Date.now() - started,
          turns: turn,
        };
      }

      // 6. Tool calls
      if (toolCalls.length + toolUses.length > config.AGENT_MAX_TOOL_CALLS) {
        throw new AIFailure('AGENT_LIMIT_REACHED', `Exceeded ${config.AGENT_MAX_TOOL_CALLS} tool calls`, {
          details: { attempted: toolCalls.length + toolUses.length },
        });
      }
      const results: ContentBlock[] = [];
      for (const tu of toolUses) {
        const span = ctx.trace.start('tool.call', { tool: tu.name, toolUseId: tu.id, input: tu.input }, ctx.root);
        const outcome = await tools.invoke(tu.name, tu.input);
        metrics.toolCalls.inc({ tool: tu.name, outcome: outcome.isError ? 'error' : 'ok' });
        toolCalls.push({ id: tu.id, name: tu.name, input: tu.input, isError: outcome.isError, durationMs: outcome.durationMs });
        toolResultTexts.push(outcome.content);
        span.set({ isError: outcome.isError, durationMs: outcome.durationMs, resultChars: outcome.content.length });
        if (outcome.isError) span.fail(outcome.content);
        else span.end();
        results.push({ type: 'tool_result', toolUseId: tu.id, content: outcome.content, isError: outcome.isError });
      }
      messages.push({ role: 'user', content: results });
    }

    throw new AIFailure('AGENT_LIMIT_REACHED', `No final answer after ${config.AGENT_MAX_TURNS} turns`, {
      details: { toolCalls: toolCalls.length },
    });
  }
}
