/**
 * Minimal on-chain data model for the investigation workflows. Field names
 * follow Bittensor conventions loosely (netuid, hotkey, vtrust, tempo) but the
 * data source is abstracted behind ChainClient so the AI layer never depends on
 * a specific RPC/indexer.
 */
export type SubnetRecord = {
  netuid: number;
  name: string;
  description: string;
  emissionShare: number; // fraction of total network emission, 0..1
  registrationCostTao: number;
  activeValidators: number;
  activeMiners: number;
  maxNeurons: number;
  tempo: number; // blocks per epoch
  ownerHotkey: string;
  tags: string[];
  updatedBlock: number;
};

export type ValidatorSubnetStats = {
  netuid: number;
  stakeTao: number;
  vtrust: number; // 0..1
  dividendsPerDayTao: number;
  lastSetWeightsBlocksAgo: number; // staleness indicator
};

export type ValidatorRecord = {
  hotkey: string;
  name: string;
  takeRate: number; // 0..1
  totalStakeTao: number;
  uptime30d: number; // 0..1
  subnets: ValidatorSubnetStats[];
  updatedBlock: number;
};

export interface ChainClient {
  getSubnet(netuid: number): Promise<SubnetRecord | null>;
  listSubnets(): Promise<SubnetRecord[]>;
  getValidator(identifier: string): Promise<ValidatorRecord | null>;
  getSubnetValidators(netuid: number, limit: number): Promise<ValidatorRecord[]>;
}
