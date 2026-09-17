/**
 * Tiny Prometheus-compatible metrics registry: counters, gauges and
 * histograms with labels, rendered in the text exposition format at /metrics.
 *
 * What we measure (the "golden signals" for an AI feature):
 *  - ai_requests_total{status,failure_code}     traffic + error rate by typed failure
 *  - ai_request_duration_ms                      latency (histogram)
 *  - ai_model_calls_total{model,provider}        model call volume
 *  - ai_tokens_total{model,direction}            token throughput
 *  - ai_cost_usd_total{model}                    spend
 *  - ai_tool_calls_total{tool,outcome}           tool health
 *  - ai_guardrail_events_total{stage,rule}       how often guardrails fire
 *  - ai_budget_remaining_usd                     headroom (gauge)
 */
type Labels = Record<string, string>;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`)
    .join(',');
}

class Counter {
  readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    const cur = this.values.get(k) ?? { labels, value: 0 };
    cur.value += by;
    this.values.set(k, cur);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels))?.value ?? 0;
  }
}

class Gauge extends Counter {
  set(value: number, labels: Labels = {}) {
    this.values.set(key(labels), { labels, value });
  }
}

class Histogram {
  readonly buckets: number[];
  readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[],
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }
  observe(value: number, labels: Labels = {}) {
    const k = key(labels);
    const s = this.series.get(k) ?? { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((b, i) => {
      if (value <= b) s.counts[i]! += 1;
    });
    s.sum += value;
    s.count += 1;
    this.series.set(k, s);
  }
  percentile(p: number, labels: Labels = {}): number | null {
    // approximate from buckets (upper bound of the bucket containing the percentile)
    const s = this.series.get(key(labels));
    if (!s || s.count === 0) return null;
    const target = Math.ceil(s.count * p);
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (s.counts[i]! >= target) return this.buckets[i]!;
    }
    return Infinity;
  }
}

export class Metrics {
  readonly requests = new Counter('ai_requests_total', 'AI requests by outcome');
  readonly requestDuration = new Histogram(
    'ai_request_duration_ms',
    'End-to-end AI request latency',
    [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000],
  );
  readonly modelCalls = new Counter('ai_model_calls_total', 'Model API calls');
  readonly modelCallDuration = new Histogram('ai_model_call_duration_ms', 'Model call latency', [100, 250, 500, 1000, 2000, 5000, 15000]);
  readonly tokens = new Counter('ai_tokens_total', 'Tokens by model and direction');
  readonly costUsd = new Counter('ai_cost_usd_total', 'Estimated spend in USD');
  readonly toolCalls = new Counter('ai_tool_calls_total', 'Tool invocations by outcome');
  readonly guardrailEvents = new Counter('ai_guardrail_events_total', 'Guardrail decisions');
  readonly budgetRemaining = new Gauge('ai_budget_remaining_usd', 'Remaining daily budget');

  render(): string {
    const out: string[] = [];
    const counters: Counter[] = [
      this.requests,
      this.modelCalls,
      this.tokens,
      this.costUsd,
      this.toolCalls,
      this.guardrailEvents,
      this.budgetRemaining,
    ];
    for (const c of counters) {
      out.push(`# HELP ${c.name} ${c.help}`);
      out.push(`# TYPE ${c.name} ${c instanceof Gauge ? 'gauge' : 'counter'}`);
      for (const { labels, value } of c.values.values()) {
        const l = key(labels);
        out.push(`${c.name}${l ? `{${l}}` : ''} ${value}`);
      }
    }
    for (const h of [this.requestDuration, this.modelCallDuration]) {
      out.push(`# HELP ${h.name} ${h.help}`);
      out.push(`# TYPE ${h.name} histogram`);
      for (const s of h.series.values()) {
        const base = key(s.labels);
        h.buckets.forEach((b, i) => {
          out.push(`${h.name}_bucket{${base ? base + ',' : ''}le="${b}"} ${s.counts[i]}`);
        });
        out.push(`${h.name}_bucket{${base ? base + ',' : ''}le="+Inf"} ${s.count}`);
        out.push(`${h.name}_sum${base ? `{${base}}` : ''} ${s.sum}`);
        out.push(`${h.name}_count${base ? `{${base}}` : ''} ${s.count}`);
      }
    }
    return out.join('\n') + '\n';
  }
}
