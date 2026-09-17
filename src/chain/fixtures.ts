import type { SubnetRecord, ValidatorRecord } from './types.js';

/**
 * Deterministic fixture data. Numbers are illustrative, not live chain state.
 * Evals and unit tests depend on these exact values; change them deliberately
 * and update evals/baseline.json alongside.
 */
export const SUBNETS: SubnetRecord[] = [
  {
    netuid: 1,
    name: 'Apex',
    description: 'Text prompting and conversational agents.',
    emissionShare: 0.061,
    registrationCostTao: 1.84,
    activeValidators: 42,
    activeMiners: 981,
    maxNeurons: 1024,
    tempo: 360,
    ownerHotkey: '5F3sa2TJ…owner1',
    tags: ['llm', 'text'],
    updatedBlock: 4_812_300,
  },
  {
    netuid: 8,
    name: 'Proprietary Trading Network',
    description: 'Financial time-series signal generation.',
    emissionShare: 0.044,
    registrationCostTao: 3.12,
    activeValidators: 19,
    activeMiners: 237,
    maxNeurons: 256,
    tempo: 360,
    ownerHotkey: '5GrwvaEF…owner8',
    tags: ['finance', 'signals'],
    updatedBlock: 4_812_300,
  },
  {
    netuid: 19,
    name: 'Nineteen',
    description: 'Decentralised inference for open-weight models.',
    emissionShare: 0.052,
    registrationCostTao: 0.97,
    activeValidators: 31,
    activeMiners: 224,
    maxNeurons: 256,
    tempo: 360,
    ownerHotkey: '5DAAnrj7…owner19',
    tags: ['inference', 'llm'],
    updatedBlock: 4_812_300,
  },
  {
    netuid: 64,
    name: 'Chutes',
    description: 'Serverless model deployment and compute marketplace.',
    emissionShare: 0.083,
    registrationCostTao: 5.41,
    activeValidators: 27,
    activeMiners: 189,
    maxNeurons: 256,
    tempo: 360,
    ownerHotkey: '5HGjWAeF…owner64',
    tags: ['compute', 'inference'],
    updatedBlock: 4_812_300,
  },
];

export const VALIDATORS: ValidatorRecord[] = [
  {
    hotkey: '5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3',
    name: 'Opentensor Foundation',
    takeRate: 0.18,
    totalStakeTao: 1_284_500,
    uptime30d: 0.998,
    subnets: [
      { netuid: 1, stakeTao: 412_000, vtrust: 0.97, dividendsPerDayTao: 61.2, lastSetWeightsBlocksAgo: 120 },
      { netuid: 8, stakeTao: 198_400, vtrust: 0.94, dividendsPerDayTao: 22.8, lastSetWeightsBlocksAgo: 240 },
      { netuid: 19, stakeTao: 301_100, vtrust: 0.99, dividendsPerDayTao: 44.9, lastSetWeightsBlocksAgo: 95 },
      { netuid: 64, stakeTao: 373_000, vtrust: 0.96, dividendsPerDayTao: 79.1, lastSetWeightsBlocksAgo: 180 },
    ],
    updatedBlock: 4_812_300,
  },
  {
    hotkey: '5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN',
    name: 'Taostats',
    takeRate: 0.09,
    totalStakeTao: 642_900,
    uptime30d: 0.995,
    subnets: [
      { netuid: 1, stakeTao: 210_300, vtrust: 0.95, dividendsPerDayTao: 30.4, lastSetWeightsBlocksAgo: 300 },
      { netuid: 19, stakeTao: 181_600, vtrust: 0.98, dividendsPerDayTao: 27.7, lastSetWeightsBlocksAgo: 110 },
      { netuid: 64, stakeTao: 251_000, vtrust: 0.91, dividendsPerDayTao: 51.3, lastSetWeightsBlocksAgo: 2_900 },
    ],
    updatedBlock: 4_812_300,
  },
  {
    hotkey: '5CXRfP2ekFhe62r7q3vppRajJmGhTi7vwvb2yr79jveZ282w',
    name: 'RoundTable21',
    takeRate: 0.0,
    totalStakeTao: 388_200,
    uptime30d: 0.981,
    subnets: [
      { netuid: 1, stakeTao: 120_000, vtrust: 0.88, dividendsPerDayTao: 16.9, lastSetWeightsBlocksAgo: 4_100 },
      { netuid: 8, stakeTao: 95_500, vtrust: 0.92, dividendsPerDayTao: 10.7, lastSetWeightsBlocksAgo: 210 },
      { netuid: 64, stakeTao: 172_700, vtrust: 0.93, dividendsPerDayTao: 34.0, lastSetWeightsBlocksAgo: 160 },
    ],
    updatedBlock: 4_812_300,
  },
  {
    hotkey: '5EhvL1FVkQPpMjZX4MAADcW42i3xPSF1KiCpuaxXYVGbFYs4',
    name: 'Yuma',
    takeRate: 0.11,
    totalStakeTao: 251_700,
    uptime30d: 0.962,
    subnets: [
      { netuid: 8, stakeTao: 140_200, vtrust: 0.79, dividendsPerDayTao: 13.1, lastSetWeightsBlocksAgo: 7_800 },
      { netuid: 19, stakeTao: 111_500, vtrust: 0.97, dividendsPerDayTao: 16.4, lastSetWeightsBlocksAgo: 130 },
    ],
    updatedBlock: 4_812_300,
  },
];
