import type { ChainClient, SubnetRecord, ValidatorRecord } from './types.js';
import { SUBNETS, VALIDATORS } from './fixtures.js';

/**
 * In-memory ChainClient over fixture data. Production would wrap an indexer or
 * subtensor RPC behind the same interface; the AI layer is unchanged.
 *
 * `latencyMs` and `failEvery` let tests exercise slow / flaky data sources.
 */
export class FixtureChainClient implements ChainClient {
  private calls = 0;

  constructor(
    private readonly opts: { latencyMs?: number; failEvery?: number } = {},
    private readonly subnets: SubnetRecord[] = SUBNETS,
    private readonly validators: ValidatorRecord[] = VALIDATORS,
  ) {}

  private async tick(): Promise<void> {
    this.calls += 1;
    if (this.opts.failEvery && this.calls % this.opts.failEvery === 0) {
      throw new Error('upstream indexer unavailable');
    }
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
  }

  async getSubnet(netuid: number): Promise<SubnetRecord | null> {
    await this.tick();
    return this.subnets.find((s) => s.netuid === netuid) ?? null;
  }

  async listSubnets(): Promise<SubnetRecord[]> {
    await this.tick();
    return [...this.subnets];
  }

  async getValidator(identifier: string): Promise<ValidatorRecord | null> {
    await this.tick();
    const needle = identifier.trim().toLowerCase();
    return (
      this.validators.find((v) => v.hotkey.toLowerCase() === needle || v.name.toLowerCase() === needle) ??
      this.validators.find((v) => v.name.toLowerCase().includes(needle)) ??
      null
    );
  }

  async getSubnetValidators(netuid: number, limit: number): Promise<ValidatorRecord[]> {
    await this.tick();
    return this.validators
      .filter((v) => v.subnets.some((s) => s.netuid === netuid))
      .sort((a, b) => stakeOn(b, netuid) - stakeOn(a, netuid))
      .slice(0, Math.max(1, limit));
  }
}

function stakeOn(v: ValidatorRecord, netuid: number): number {
  return v.subnets.find((s) => s.netuid === netuid)?.stakeTao ?? 0;
}
