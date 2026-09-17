import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FixtureChainClient } from '../src/chain/fixtureClient.js';
import { buildChainTools } from '../src/tools/chainTools.js';
import { ToolRegistry } from '../src/tools/registry.js';

describe('tool registry', () => {
  it('validates inputs and returns model-recoverable errors instead of throwing', async () => {
    const tools = buildChainTools(new FixtureChainClient());
    const bad = await tools.invoke('get_subnet', { netuid: 'one' });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content).issues[0]).toMatch(/netuid/);

    const unknown = await tools.invoke('nope', {});
    expect(unknown.isError).toBe(true);
  });

  it('wraps handler failures and timeouts', async () => {
    const reg = new ToolRegistry()
      .register({
        name: 'boom',
        description: '',
        input: z.object({}),
        jsonSchema: { type: 'object' },
        handler: async () => {
          throw new Error('kaboom');
        },
      })
      .register({
        name: 'slow',
        description: '',
        input: z.object({}),
        jsonSchema: { type: 'object' },
        timeoutMs: 20,
        handler: () => new Promise((r) => setTimeout(() => r('late'), 200)),
      });
    expect(JSON.parse((await reg.invoke('boom', {})).content).error).toBe('kaboom');
    const slow = await reg.invoke('slow', {});
    expect(slow.isError).toBe(true);
    expect(slow.content).toMatch(/timed out/);
  });

  it('caps result size', async () => {
    const reg = new ToolRegistry().register({
      name: 'big',
      description: '',
      input: z.object({}),
      jsonSchema: { type: 'object' },
      maxResultChars: 50,
      handler: async () => ({ blob: 'x'.repeat(10_000) }),
    });
    const r = await reg.invoke('big', {});
    expect(r.content.length).toBeLessThan(80);
    expect(r.content).toMatch(/truncated/);
  });
});

describe('chain tools', () => {
  const tools = buildChainTools(new FixtureChainClient());

  it('get_subnet returns found=false for unknown netuid (not an error)', async () => {
    const r = await tools.invoke('get_subnet', { netuid: 999 });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content)).toMatchObject({ found: false, netuid: 999 });
  });

  it('compare_validators scopes to a subnet and reports missing identifiers', async () => {
    const r = JSON.parse((await tools.invoke('compare_validators', { identifiers: ['Taostats', 'Nobody'], netuid: 64 })).content);
    expect(r.missing).toEqual(['Nobody']);
    expect(r.validators[0].onSubnet.stakeTao).toBe(251_000);
  });

  it('get_subnet_validators ranks by stake on that subnet', async () => {
    const r = JSON.parse((await tools.invoke('get_subnet_validators', { netuid: 8, limit: 5 })).content);
    const stakes = r.validators.map((v: { onSubnet: { stakeTao: number } }) => v.onSubnet.stakeTao);
    expect(stakes).toEqual([...stakes].sort((a: number, b: number) => b - a));
  });

  it('surfaces upstream data-source failures as tool errors', async () => {
    const flaky = buildChainTools(new FixtureChainClient({ failEvery: 1 }));
    const r = await flaky.invoke('get_subnet', { netuid: 1 });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/indexer unavailable/);
  });
});
