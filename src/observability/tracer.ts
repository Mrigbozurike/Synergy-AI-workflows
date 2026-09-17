import { randomUUID } from 'node:crypto';

/**
 * Minimal span tracer. Every model call, tool call and guardrail check becomes
 * a span with attributes, so a single request can be replayed after the fact:
 * what the model saw, what it called, what came back, what it cost.
 *
 * Spans are exported through a pluggable exporter; the default keeps them in
 * memory (tests, evals) and the server exposes the last N traces at /traces.
 * Swapping in an OpenTelemetry exporter is a one-file change.
 */
export type Span = {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;
  startMs: number;
  endMs?: number;
  status: 'ok' | 'error';
  attributes: Record<string, unknown>;
};

export type SpanExporter = (span: Span) => void;

export class Trace {
  readonly traceId: string;
  readonly spans: Span[] = [];

  constructor(
    private readonly exporter: SpanExporter,
    traceId: string = randomUUID(),
  ) {
    this.traceId = traceId;
  }

  start(name: string, attributes: Record<string, unknown> = {}, parentId?: string): SpanHandle {
    const span: Span = {
      traceId: this.traceId,
      spanId: randomUUID().slice(0, 8),
      name,
      startMs: Date.now(),
      status: 'ok',
      attributes,
    };
    if (parentId !== undefined) span.parentId = parentId;
    this.spans.push(span);
    return new SpanHandle(span, this.exporter);
  }

  async withSpan<T>(name: string, attributes: Record<string, unknown>, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    const span = this.start(name, attributes);
    try {
      const r = await fn(span);
      span.end();
      return r;
    } catch (err) {
      span.fail(err);
      throw err;
    }
  }

  durationMs(): number {
    const root = this.spans[0];
    if (!root) return 0;
    return (root.endMs ?? Date.now()) - root.startMs;
  }
}

export class SpanHandle {
  constructor(
    readonly span: Span,
    private readonly exporter: SpanExporter,
  ) {}

  get id() {
    return this.span.spanId;
  }

  set(attrs: Record<string, unknown>): this {
    Object.assign(this.span.attributes, attrs);
    return this;
  }

  end(): void {
    if (this.span.endMs !== undefined) return;
    this.span.endMs = Date.now();
    this.exporter(this.span);
  }

  fail(err: unknown): void {
    this.span.status = 'error';
    this.span.attributes['error'] = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this.end();
  }
}

/** Ring-buffer exporter used by the server's /traces endpoint and by tests. */
export class InMemoryTraceStore {
  private readonly byTrace = new Map<string, Span[]>();
  private readonly order: string[] = [];

  constructor(private readonly capacity = 200) {}

  exporter: SpanExporter = (span) => {
    if (!this.byTrace.has(span.traceId)) {
      this.byTrace.set(span.traceId, []);
      this.order.push(span.traceId);
      while (this.order.length > this.capacity) {
        const evicted = this.order.shift();
        if (evicted) this.byTrace.delete(evicted);
      }
    }
    this.byTrace.get(span.traceId)!.push(span);
  };

  get(traceId: string): Span[] | undefined {
    return this.byTrace.get(traceId);
  }

  recent(n = 20): { traceId: string; spans: Span[] }[] {
    return this.order
      .slice(-n)
      .reverse()
      .map((id) => ({ traceId: id, spans: this.byTrace.get(id) ?? [] }));
  }
}
