import { z } from 'zod';
import type { ChainClient, ValidatorRecord } from '../chain/types.js';
import { ToolRegistry } from './registry.js';

/**
 * The tool surface exposed to the model for on-chain investigation.
 * Descriptions are written for the model: they say when to use the tool and
 * what it returns, because that text is the model's only documentation.
 */
export function buildChainTools(chain: ChainClient): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: 'get_subnet',
    description:
      'Fetch a single subnet by netuid: name, purpose, emission share, registration cost, active validator/miner counts. Use when the user asks about a specific subnet.',
    input: z.object({ netuid: z.number().int().min(0).max(4096) }),
    jsonSchema: {
      type: 'object',
      properties: { netuid: { type: 'integer', description: 'Subnet id (netuid)' } },
      required: ['netuid'],
    },
    handler: async ({ netuid }) => {
      const s = await chain.getSubnet(netuid);
      if (!s) return { found: false, netuid, message: `No subnet with netuid ${netuid}` };
      return { found: true, subnet: s };
    },
  });

  registry.register({
    name: 'list_subnets',
    description:
      'List all subnets with emission share and activity counts, sorted by emission share descending. Use for ranking or discovery questions ("which subnets have the most emission?").',
    input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    jsonSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max rows, default 20' } },
    },
    handler: async ({ limit }) => {
      const all = await chain.listSubnets();
      return {
        subnets: all
          .sort((a, b) => b.emissionShare - a.emissionShare)
          .slice(0, limit)
          .map((s) => ({
            netuid: s.netuid,
            name: s.name,
            emissionShare: s.emissionShare,
            activeValidators: s.activeValidators,
            activeMiners: s.activeMiners,
          })),
      };
    },
  });

  registry.register({
    name: 'get_validator',
    description:
      'Fetch a validator by hotkey or display name: take rate, total stake, 30-day uptime, and per-subnet stake/vtrust/dividends/weight-setting staleness.',
    input: z.object({ identifier: z.string().min(2).max(64) }),
    jsonSchema: {
      type: 'object',
      properties: { identifier: { type: 'string', description: 'Validator hotkey (ss58) or display name' } },
      required: ['identifier'],
    },
    handler: async ({ identifier }) => {
      const v = await chain.getValidator(identifier);
      if (!v) return { found: false, identifier, message: `No validator matching "${identifier}"` };
      return { found: true, validator: v };
    },
  });

  registry.register({
    name: 'compare_validators',
    description:
      'Side-by-side comparison of 2-5 validators. Optionally scope to one subnet (netuid) to compare per-subnet stake, vtrust and dividends. Use for "X vs Y" questions.',
    input: z.object({
      identifiers: z.array(z.string().min(2).max(64)).min(2).max(5),
      netuid: z.number().int().min(0).optional(),
    }),
    jsonSchema: {
      type: 'object',
      properties: {
        identifiers: { type: 'array', items: { type: 'string' }, description: '2-5 hotkeys or names' },
        netuid: { type: 'integer', description: 'Optional subnet to scope the comparison to' },
      },
      required: ['identifiers'],
    },
    handler: async ({ identifiers, netuid }) => {
      const rows = await Promise.all(identifiers.map((id) => chain.getValidator(id)));
      const missing = identifiers.filter((_, i) => rows[i] === null);
      const found = rows.filter((r): r is ValidatorRecord => r !== null);
      return {
        netuid: netuid ?? null,
        missing,
        validators: found.map((v) => summarise(v, netuid)),
      };
    },
  });

  registry.register({
    name: 'get_subnet_validators',
    description:
      'Top validators on a subnet ranked by stake on that subnet, with vtrust and weight-setting staleness. Use to answer "who validates subnet N" or to flag inactive validators.',
    input: z.object({ netuid: z.number().int().min(0), limit: z.number().int().min(1).max(50).default(10) }),
    jsonSchema: {
      type: 'object',
      properties: {
        netuid: { type: 'integer' },
        limit: { type: 'integer', description: 'Max rows, default 10' },
      },
      required: ['netuid'],
    },
    handler: async ({ netuid, limit }) => {
      const vs = await chain.getSubnetValidators(netuid, limit);
      return { netuid, validators: vs.map((v) => summarise(v, netuid)) };
    },
  });

  return registry;
}

function summarise(v: ValidatorRecord, netuid?: number) {
  const base = {
    hotkey: v.hotkey,
    name: v.name,
    takeRate: v.takeRate,
    totalStakeTao: v.totalStakeTao,
    uptime30d: v.uptime30d,
    subnetCount: v.subnets.length,
  };
  if (netuid === undefined) return base;
  const s = v.subnets.find((x) => x.netuid === netuid);
  return { ...base, onSubnet: s ?? null };
}
