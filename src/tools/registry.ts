import type { ZodTypeAny, z } from 'zod';
import type { ToolSpec } from '../llm/types.js';
import { AIFailure } from '../errors.js';

/**
 * A tool is a validated, timeout-bounded function the model may call.
 *
 * Invariants enforced here, once, for every tool:
 *  - inputs are validated with zod before the handler runs (bad model output
 *    becomes a tool_result error the model can recover from, not a crash)
 *  - handlers are wrapped in a timeout
 *  - results are JSON strings, size-capped so a large payload can't blow the
 *    context window and the token budget
 */
export type ToolDefinition<S extends ZodTypeAny = ZodTypeAny> = {
  name: string;
  description: string;
  input: S;
  /** JSON Schema for the model; kept explicit rather than generated to avoid a dependency. */
  jsonSchema: Record<string, unknown>;
  handler: (input: z.infer<S>) => Promise<unknown>;
  timeoutMs?: number;
  maxResultChars?: number;
};

export type ToolOutcome = {
  content: string;
  isError: boolean;
  durationMs: number;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<S extends ZodTypeAny>(def: ToolDefinition<S>): this {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
    this.tools.set(def.name, def as unknown as ToolDefinition);
    return this;
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema,
    }));
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  async invoke(name: string, rawInput: unknown): Promise<ToolOutcome> {
    const started = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: JSON.stringify({ error: `unknown tool "${name}"` }), isError: true, durationMs: 0 };
    }
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      return {
        content: JSON.stringify({ error: 'invalid tool input', issues }),
        isError: true,
        durationMs: Date.now() - started,
      };
    }
    try {
      const result = await withTimeout(tool.handler(parsed.data), tool.timeoutMs ?? 5_000, name);
      let content = JSON.stringify(result ?? null);
      const cap = tool.maxResultChars ?? 8_000;
      if (content.length > cap) content = content.slice(0, cap) + '…[truncated]';
      return { content, isError: false, durationMs: Date.now() - started };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: JSON.stringify({ error: message }), isError: true, durationMs: Date.now() - started };
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AIFailure('TOOL_ERROR', `tool "${label}" timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
