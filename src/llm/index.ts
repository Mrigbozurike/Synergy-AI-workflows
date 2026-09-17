import type { Config } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { FakeProvider } from './fake.js';
import type { LLMProvider } from './types.js';

export function createProvider(config: Config): LLMProvider {
  switch (config.LLM_PROVIDER) {
    case 'anthropic':
      return new AnthropicProvider(config.ANTHROPIC_API_KEY!);
    case 'fake':
      return new FakeProvider();
  }
}

export type { LLMProvider } from './types.js';
