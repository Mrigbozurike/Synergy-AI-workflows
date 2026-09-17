import Anthropic from '@anthropic-ai/sdk';
import type { CompletionRequest, CompletionResponse, ContentBlock, LLMProvider } from './types.js';
import { AIFailure } from '../errors.js';

/**
 * Anthropic adapter. Responsibilities:
 *  - translate the neutral message model to/from the vendor shape
 *  - map vendor errors to our typed failure modes
 *  - bounded retries with jittered backoff for transient failures only
 *
 * It does NOT decide budgets, log, or trace: those are cross-cutting concerns
 * handled by the agent loop so they apply to every provider identically.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(
    apiKey: string,
    private readonly opts: { maxRetries?: number; baseDelayMs?: number } = {},
  ) {
    // SDK retries are disabled so our retry policy is the only one in play.
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async complete(req: CompletionRequest, opts: { signal?: AbortSignal } = {}): Promise<CompletionResponse> {
    const maxRetries = this.opts.maxRetries ?? 2;
    const baseDelay = this.opts.baseDelayMs ?? 400;
    let attempt = 0;
    for (;;) {
      try {
        return await this.once(req, opts.signal);
      } catch (err) {
        const failure = mapError(err);
        if (!failure.retryable || attempt >= maxRetries) throw failure;
        attempt += 1;
        const delay = baseDelay * 2 ** (attempt - 1) * (0.5 + Math.random());
        await sleep(delay, opts.signal);
      }
    }
  }

  private async once(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const res = await this.client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        temperature: req.temperature ?? 0,
        messages: req.messages.map((m) => ({
          role: m.role,
          content: m.content.map(toVendorBlock),
        })),
        tools: (req.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
        })),
      },
      { signal: signal ?? null },
    );

    return {
      model: res.model,
      content: res.content.map(fromVendorBlock).filter((b): b is ContentBlock => b !== null),
      stopReason: res.stop_reason === 'tool_use' ? 'tool_use' : res.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn',
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }
}

function toVendorBlock(b: ContentBlock): Anthropic.ContentBlockParam {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false };
  }
}

function fromVendorBlock(b: Anthropic.ContentBlock): ContentBlock | null {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> };
  return null; // thinking / other block types are not part of our model
}

function mapError(err: unknown): AIFailure {
  if (err instanceof AIFailure) return err;
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 429) return new AIFailure('PROVIDER_RATE_LIMITED', 'Model provider rate limited the request', { cause: err });
    if (status === 529 || status >= 500)
      return new AIFailure('PROVIDER_UNAVAILABLE', `Model provider unavailable (HTTP ${status})`, { cause: err });
    return new AIFailure('INTERNAL', `Model provider error (HTTP ${status}): ${err.message}`, { cause: err, retryable: false });
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new AIFailure('TIMEOUT', 'Model call aborted by timeout', { cause: err, retryable: false });
  }
  return new AIFailure('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err, retryable: false });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AIFailure('TIMEOUT', 'Aborted while backing off', { retryable: false }));
      },
      { once: true },
    );
  });
}
