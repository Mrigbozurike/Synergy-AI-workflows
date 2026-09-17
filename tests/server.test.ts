import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { FakeProvider } from '../src/llm/fake.js';
import { silentLogger } from '../src/observability/logger.js';
import { buildHandler } from '../src/server.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp({ provider: new FakeProvider(), logger: silentLogger, config: { COST_DAILY_BUDGET_USD: 1 } });
  server = createServer(buildHandler(app));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('HTTP API', () => {
  it('answers investigations and propagates request ids', async () => {
    const res = await fetch(`${base}/v1/investigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-123' },
      body: JSON.stringify({ question: 'Compare "Taostats" and "Yuma" on subnet 19' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('req-123');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.requestId).toBe('req-123');
    expect(body.answer.status).toBe('ok');
    expect(body.toolCalls[0].name).toBe('compare_validators');
  });

  it('maps typed failures to HTTP statuses with a machine-readable body', async () => {
    const res = await fetch(`${base}/v1/investigate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What is the weather?' }),
    });
    expect(res.status).toBe(400);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ error: 'GUARDRAIL_INPUT_REJECTED', retryable: false, details: { rule: 'off_topic' } });
  });

  it('rejects malformed bodies', async () => {
    const res = await fetch(`${base}/v1/investigate`, { method: 'POST', body: '{not json' });
    expect(res.status).toBe(400);
  });

  it('exposes health, budget, metrics and traces', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const budget = (await (await fetch(`${base}/budget`)).json()) as any;
    expect(budget.dailyBudgetUsd).toBe(1);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(/ai_requests_total\{failure_code="none",status="ok"\} 1/);
    expect(metrics).toMatch(/ai_request_duration_ms_bucket/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces = (await (await fetch(`${base}/traces?limit=5`)).json()) as any;
    expect(traces.traces.length).toBeGreaterThan(0);
    // most recent trace is the rejected off-topic request: only root + input guard, both errored
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rejected = (await (await fetch(`${base}/traces/${traces.traces[0].traceId}`)).json()) as any;
    expect(rejected.spans.map((s: { name: string }) => s.name)).toEqual(['guardrail.input', 'investigate']);
    // the earlier successful one has a tool call span
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = (await (await fetch(`${base}/traces/${traces.traces[1].traceId}`)).json()) as any;
    expect(ok.spans.some((s: { name: string }) => s.name === 'tool.call')).toBe(true);
  });
});
