import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from './app.js';
import { AIFailure, toAIFailure } from './errors.js';

/**
 * HTTP surface. Plain node:http keeps the dependency footprint tiny; the
 * handlers are thin because all behaviour lives in the Investigator.
 *
 *  POST /v1/investigate   { "question": "..." }
 *  GET  /healthz           liveness
 *  GET  /readyz            readiness (provider configured, budget not exhausted)
 *  GET  /metrics           Prometheus text format
 *  GET  /budget            cost ledger snapshot
 *  GET  /traces            last N traces (debugging; put behind auth in prod)
 *  GET  /traces/:traceId   one trace
 */
const MAX_IN_FLIGHT = 8;
const MAX_BODY_BYTES = 16 * 1024;

export function buildHandler(app: App) {
  let inFlight = 0;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    res.setHeader('x-request-id', requestId);

    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/readyz') {
        const ready = app.ledger.remainingTodayUsd() > 0;
        return json(res, ready ? 200 : 503, { ready, budget: app.ledger.snapshot() });
      }
      if (req.method === 'GET' && url.pathname === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(app.metrics.render());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/budget') return json(res, 200, app.ledger.snapshot());
      if (req.method === 'GET' && url.pathname === '/traces') {
        const limit = Number(url.searchParams.get('limit') ?? 20);
        return json(res, 200, { traces: app.traces.recent(Math.min(100, Math.max(1, limit))) });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/traces/')) {
        const spans = app.traces.get(url.pathname.slice('/traces/'.length));
        return spans ? json(res, 200, { spans }) : json(res, 404, { error: 'NOT_FOUND' });
      }

      if (req.method === 'POST' && url.pathname === '/v1/investigate') {
        if (inFlight >= MAX_IN_FLIGHT) {
          res.setHeader('retry-after', '2');
          return json(res, 503, { error: 'OVERLOADED', message: 'Too many in-flight investigations', retryable: true });
        }
        inFlight += 1;
        try {
          const body = await readJson(req);
          const question = typeof body?.['question'] === 'string' ? body['question'] : '';
          const result = await app.investigator.investigate(question, { requestId });
          return json(res, 200, result);
        } finally {
          inFlight -= 1;
        }
      }

      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      const failure = toAIFailure(err);
      if (failure.code === 'INTERNAL') app.logger.error('unhandled error', { requestId, message: failure.message });
      if (failure.retryable) res.setHeader('retry-after', '5');
      return json(res, failure.httpStatus, { ...failure.toJSON(), requestId });
    }
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new AIFailure('GUARDRAIL_INPUT_REJECTED', 'Request body too large', { details: { rule: 'too_long' } });
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AIFailure('GUARDRAIL_INPUT_REJECTED', 'Request body is not valid JSON', { details: { rule: 'malformed' } });
  }
}

export function startServer(app: App = createApp()) {
  const server = createServer(buildHandler(app));
  server.listen(app.config.PORT, () => {
    app.logger.info('listening', { port: app.config.PORT, provider: app.provider.name, model: app.config.LLM_MODEL_PRIMARY });
  });
  const shutdown = () => {
    app.logger.info('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

const isMain = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (isMain) startServer();
