import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { EvmTestPerpNettingResidualBinding } from '@naryx/adapter-evm';
import {
  bytesEqual,
  nettingPolicyManifest,
  parseProtocolJson,
  type NettingExternalExecutionIntent,
  type NettingInstrumentPolicy,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import { getAddress, type Address } from 'viem';
import { createViemBaseSepoliaResidualChain } from './base-sepolia-netting-residual-chain.js';
import { loadBaseSepoliaSolverKey } from './base-sepolia-solver-authorization.js';
import { EvmTestPerpNettingResidualRuntime, type EvmNettingResidualRuntimeLane,
  type EvmNettingResidualRuntimeLaneResolver } from './evm-netting-residual-runtime.js';
import { EvmNettingResidualSqliteJournal } from './evm-netting-residual-sqlite-journal.js';

export const BASE_SEPOLIA_NETTING_RESIDUAL_ENABLED_ENV =
  'NARYX_BASE_SEPOLIA_NETTING_RESIDUAL_ENABLED';
export const BASE_SEPOLIA_NETTING_RESIDUAL_CONFIG_VERSION = 1;

const BASE_SEPOLIA_DOMAIN_ID = 'eip155:84532';
const MAX_CONFIG_BYTES = 1_048_576;
const BPS = 10_000n;
const UINT32_MAX = 0xffff_ffff;

type ConfiguredLane = Readonly<{
  instrument: NettingInstrumentPolicy;
  binding: EvmTestPerpNettingResidualBinding;
  marginBps: bigint;
  maximumMarginQuoteAtoms: bigint;
}>;

export interface BaseSepoliaNettingResidualLoadedRuntime {
  readonly runtime: EvmTestPerpNettingResidualRuntime;
  close(): void;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown, context: string): Record<string, unknown> {
  requireCondition(typeof value === 'object' && value !== null && !Array.isArray(value),
    `${context} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  requireCondition(actual.length === expected.length
    && actual.every((key, index) => key === expected[index]), `${context} fields are invalid`);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  requireCondition(value !== undefined && value.length > 0,
    `${name} is required when Base residual execution is enabled`);
  return value;
}

function enabled(environment: NodeJS.ProcessEnv): boolean {
  const value = environment[BASE_SEPOLIA_NETTING_RESIDUAL_ENABLED_ENV];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${BASE_SEPOLIA_NETTING_RESIDUAL_ENABLED_ENV} must be true or false`);
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  requireCondition(/^[1-9][0-9]*$/.test(value), `${name} must be a positive integer`);
  const parsed = Number(value);
  requireCondition(Number.isSafeInteger(parsed) && parsed <= maximum,
    `${name} must be no greater than ${maximum}`);
  return parsed;
}

function bigintField(value: unknown, name: string, positive: boolean): bigint {
  requireCondition(typeof value === 'bigint' && (positive ? value > 0n : value >= 0n),
    `${name} must be ${positive ? 'positive' : 'nonnegative'}`);
  return value;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : ((numerator - 1n) / denominator) + 1n;
}

export class BaseSepoliaNettingResidualLaneRegistry implements EvmNettingResidualRuntimeLaneResolver {
  readonly #lanes: ReadonlyMap<string, ConfiguredLane>;

  constructor(path: string, executionAccount: Address) {
    requireCondition(isAbsolute(path), 'Base residual config path must be absolute');
    const resolved = resolve(path);
    requireCondition(statSync(resolved).size <= MAX_CONFIG_BYTES, 'Base residual config is too large');
    let parsed: unknown;
    try {
      parsed = parseProtocolJson(readFileSync(resolved, 'utf8'));
    } catch {
      throw new Error('Base residual config is not valid protocol JSON');
    }
    const root = object(parsed, 'Base residual config');
    exactKeys(root, ['version', 'environment', 'policy', 'bindings'], 'Base residual config');
    requireCondition(root.version === BASE_SEPOLIA_NETTING_RESIDUAL_CONFIG_VERSION
      && root.environment === 'BASE_SEPOLIA'
      && Array.isArray(root.bindings) && root.bindings.length > 0,
    'Base residual config must be a nonempty Base Sepolia version 1 config');
    const policy = nettingPolicyManifest(root.policy as NettingPolicyManifestInput);
    requireCondition(policy.environment === 'testnet'
      && policy.settlementClass === 'BATCHED_IOC_WITH_RECOVERY'
      && policy.externalExecutionMode === 'EXACT_NET_ONLY'
      && policy.instruments.every((instrument) => instrument.domain.domainId === BASE_SEPOLIA_DOMAIN_ID),
    'Base residual policy is not an exact Base Sepolia netting policy');
    const lanes = new Map<string, ConfiguredLane>();
    for (const value of root.bindings) {
      const raw = object(value, 'Base residual binding');
      exactKeys(raw, [
        'instrumentId', 'marketAddress', 'expiry', 'marginBps', 'maximumMarginQuoteAtoms',
      ], 'Base residual binding');
      requireCondition(typeof raw.instrumentId === 'string', 'Base residual instrument id is invalid');
      const instrument = policy.instruments.find((entry) => entry.instrumentId === raw.instrumentId);
      requireCondition(instrument !== undefined && !lanes.has(instrument.instrumentId),
        'Base residual binding must name one unique policy instrument');
      requireCondition(instrument.legFamily === 'PERP_OPEN' || instrument.legFamily === 'PERP_CLOSE'
        || instrument.legFamily === 'PERP_INCREASE' || instrument.legFamily === 'PERP_DECREASE',
      'Base residual binding must name a perpetual instrument');
      requireCondition(Number.isSafeInteger(raw.expiry) && Number(raw.expiry) >= 0
        && Number(raw.expiry) <= UINT32_MAX, 'Base residual expiry is invalid');
      const marginBps = bigintField(raw.marginBps, 'Base residual margin bps', true);
      requireCondition(marginBps <= BPS, 'Base residual margin bps exceed 100 percent');
      const maximumMarginQuoteAtoms = bigintField(
        raw.maximumMarginQuoteAtoms, 'Base residual maximum margin', true,
      );
      let marketAddress: Address;
      try {
        marketAddress = getAddress(String(raw.marketAddress));
      } catch {
        throw new Error('Base residual market address is invalid');
      }
      const binding: EvmTestPerpNettingResidualBinding = Object.freeze({
        domain: instrument.domain,
        adapter: instrument.adapter,
        venue: instrument.venue,
        market: instrument.market,
        chainId: 84532,
        marketAddress,
        executionAccount: getAddress(executionAccount),
        expiry: Number(raw.expiry),
      });
      lanes.set(instrument.instrumentId, Object.freeze({
        instrument,
        binding,
        marginBps,
        maximumMarginQuoteAtoms,
      }));
    }
    requireCondition(lanes.size === policy.instruments.length,
      'Base residual bindings do not cover every policy instrument');
    this.#lanes = lanes;
  }

  resolve(intent: NettingExternalExecutionIntent): EvmNettingResidualRuntimeLane {
    const lane = this.#lanes.get(intent.instrumentId);
    requireCondition(lane !== undefined && bytesEqual(lane.instrument.instrumentHash, intent.instrumentHash),
    'residual intent is outside the configured Base policy');
    const riskIncreasing = lane.instrument.legFamily === 'PERP_OPEN'
      || lane.instrument.legFamily === 'PERP_INCREASE';
    if (!riskIncreasing) return Object.freeze({ instrument: lane.instrument, binding: lane.binding, marginQuoteAtoms: 0n });
    const limitQuoteAtoms = (intent.quantityAtoms / intent.quantityIncrementAtoms)
      * intent.limitPriceTicks * intent.priceTickQuoteAtoms;
    const marginQuoteAtoms = ceilDiv(limitQuoteAtoms * lane.marginBps, BPS);
    requireCondition(marginQuoteAtoms > 0n && marginQuoteAtoms <= lane.maximumMarginQuoteAtoms,
      'Base residual required margin exceeds the configured cap');
    return Object.freeze({ instrument: lane.instrument, binding: lane.binding, marginQuoteAtoms });
  }
}

export async function loadBaseSepoliaNettingResidualRuntime(
  environment: NodeJS.ProcessEnv,
): Promise<BaseSepoliaNettingResidualLoadedRuntime | undefined> {
  if (!enabled(environment)) return undefined;
  requireCondition(required(environment, 'NARYX_BASE_SEPOLIA_NETTING_RESIDUAL_ENVIRONMENT') === 'BASE_SEPOLIA',
    'Base residual execution environment must be BASE_SEPOLIA');
  const account = loadBaseSepoliaSolverKey(
    environment.NARYX_BASE_SEPOLIA_SOLVER_KEY_PATH,
    environment.NARYX_BASE_SEPOLIA_SOLVER_ADDRESS,
  );
  const journal = new EvmNettingResidualSqliteJournal(required(
    environment, 'NARYX_BASE_SEPOLIA_NETTING_RESIDUAL_JOURNAL_DB',
  ));
  try {
    const chain = createViemBaseSepoliaResidualChain({
      rpcUrl: required(environment, 'NARYX_BASE_SEPOLIA_RPC_URL'),
      account,
      minimumConfirmations: positiveInteger(
        environment, 'NARYX_BASE_SEPOLIA_NETTING_RESIDUAL_CONFIRMATIONS', 2, 100,
      ),
    });
    requireCondition(await chain.chainId() === 84_532, 'Base residual RPC is not Base Sepolia');
    const registry = new BaseSepoliaNettingResidualLaneRegistry(required(
      environment, 'NARYX_BASE_SEPOLIA_NETTING_RESIDUAL_CONFIG',
    ), getAddress(account.address));
    return Object.freeze({
      runtime: new EvmTestPerpNettingResidualRuntime(registry, journal, chain),
      close: () => journal.close(),
    });
  } catch (error) {
    journal.close();
    throw error;
  }
}
