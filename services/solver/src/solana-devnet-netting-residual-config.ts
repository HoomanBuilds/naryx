import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  ConnectionSolanaDeploymentIdentityReadPort,
  verifySolanaDevnetDeploymentIdentity,
  type SolanaTestPerpNettingResidualBinding,
} from '@naryx/adapter-solana';
import {
  bytesEqual,
  nettingPolicyManifest,
  parseProtocolJson,
  type DomainRef,
  type NettingExternalExecutionIntent,
  type NettingInstrumentPolicy,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';
import { createSolanaDevnetNettingResidualChain } from './solana-devnet-netting-residual-chain.js';
import {
  SolanaTestPerpNettingResidualRuntime,
  type SolanaNettingResidualRuntimeLane,
  type SolanaNettingResidualRuntimeLaneResolver,
} from './solana-netting-residual-runtime.js';
import { SolanaNettingResidualSqliteJournal } from './solana-netting-residual-sqlite-journal.js';
import { HttpSolanaDevnetSolverRpc, requireSolanaDevnet } from './solana-devnet-rpc.js';
import {
  loadSolanaDevnetSharedManifest,
  loadSolanaDevnetSolverConfig,
  loadSolanaDevnetSolverKey,
} from './solana-devnet-solver-config.js';
import { decodeTestPerpMarket, decodeTestPerpPosition } from './solana-devnet-wire.js';

export const SOLANA_DEVNET_NETTING_RESIDUAL_ENABLED_ENV =
  'NARYX_SOLANA_DEVNET_NETTING_RESIDUAL_ENABLED';
export const SOLANA_DEVNET_NETTING_RESIDUAL_CONFIG_VERSION = 1;

const MAX_CONFIG_BYTES = 1_048_576;
const SOLANA_DEVNET_DOMAIN_ID = 'svm:devnet';

export interface SolanaDevnetNettingResidualLoadedRuntime {
  readonly runtime: SolanaTestPerpNettingResidualRuntime;
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

function exactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  requireCondition(actual.length === expected.length
    && actual.every((key, index) => key === expected[index]), `${context} fields are invalid`);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  requireCondition(value !== undefined && value.length > 0,
    `${name} is required when Solana residual execution is enabled`);
  return value;
}

function enabled(environment: NodeJS.ProcessEnv): boolean {
  const value = environment[SOLANA_DEVNET_NETTING_RESIDUAL_ENABLED_ENV];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${SOLANA_DEVNET_NETTING_RESIDUAL_ENABLED_ENV} must be true or false`);
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

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function loadPolicy(path: string, expectedDomain: DomainRef): readonly NettingInstrumentPolicy[] {
  requireCondition(isAbsolute(path), 'Solana residual config path must be absolute');
  const resolved = resolve(path);
  requireCondition(statSync(resolved).size <= MAX_CONFIG_BYTES, 'Solana residual config is too large');
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(resolved, 'utf8'));
  } catch {
    throw new Error('Solana residual config is not valid protocol JSON');
  }
  const root = object(parsed, 'Solana residual config');
  exactKeys(root, ['version', 'environment', 'policy'], 'Solana residual config');
  requireCondition(root.version === SOLANA_DEVNET_NETTING_RESIDUAL_CONFIG_VERSION
    && root.environment === 'SOLANA_DEVNET',
  'Solana residual config must be a Solana Devnet version 1 config');
  const policy = nettingPolicyManifest(root.policy as NettingPolicyManifestInput);
  requireCondition(policy.environment === 'devnet'
    && policy.settlementClass === 'BATCHED_IOC_WITH_RECOVERY'
    && policy.externalExecutionMode === 'EXACT_NET_ONLY'
    && policy.instruments.length > 0
    && policy.instruments.every((instrument) => sameDomain(instrument.domain, expectedDomain)
      && instrument.domain.domainId === SOLANA_DEVNET_DOMAIN_ID
      && (instrument.legFamily === 'PERP_OPEN' || instrument.legFamily === 'PERP_CLOSE'
        || instrument.legFamily === 'PERP_INCREASE' || instrument.legFamily === 'PERP_DECREASE')),
  'Solana residual policy must contain only exact Devnet perpetual instruments');
  return policy.instruments;
}

export class SolanaDevnetNettingResidualLaneRegistry implements SolanaNettingResidualRuntimeLaneResolver {
  readonly #lanes: ReadonlyMap<string, SolanaNettingResidualRuntimeLane>;

  constructor(inputs: readonly Readonly<{
    instrument: NettingInstrumentPolicy;
    binding: SolanaTestPerpNettingResidualBinding;
  }>[]) {
    const lanes = new Map<string, SolanaNettingResidualRuntimeLane>();
    for (const input of inputs) {
      requireCondition(!lanes.has(input.instrument.instrumentId),
        'Solana residual instrument bindings must be unique');
      lanes.set(input.instrument.instrumentId, Object.freeze(input));
    }
    requireCondition(lanes.size > 0, 'Solana residual requires at least one lane');
    this.#lanes = lanes;
  }

  resolve(intent: NettingExternalExecutionIntent): SolanaNettingResidualRuntimeLane {
    const lane = this.#lanes.get(intent.instrumentId);
    requireCondition(lane !== undefined && bytesEqual(lane.instrument.instrumentHash, intent.instrumentHash),
      'residual intent is outside the configured Solana policy');
    return lane;
  }
}

export async function loadSolanaDevnetNettingResidualRuntime(
  environment: NodeJS.ProcessEnv,
): Promise<SolanaDevnetNettingResidualLoadedRuntime | undefined> {
  if (!enabled(environment)) return undefined;
  requireCondition(required(environment, 'NARYX_SOLANA_DEVNET_NETTING_RESIDUAL_ENVIRONMENT') === 'SOLANA_DEVNET',
    'Solana residual execution environment must be SOLANA_DEVNET');
  const solverConfig = loadSolanaDevnetSolverConfig(required(
    environment, 'NARYX_SOLANA_DEVNET_SOLVER_CONFIG',
  ));
  const manifest = loadSolanaDevnetSharedManifest(solverConfig.runtimeManifestPath);
  const key = loadSolanaDevnetSolverKey(required(
    environment, 'NARYX_SOLANA_DEVNET_SOLVER_KEYPAIR_PATH',
  ), solverConfig.solverId);
  const rpcUrl = required(environment, 'NARYX_SOLANA_DEVNET_RPC_URL');
  const rpc = new HttpSolanaDevnetSolverRpc(rpcUrl, { writesEnabled: false });
  await requireSolanaDevnet(rpc);
  await verifySolanaDevnetDeploymentIdentity(
    manifest.programs,
    new ConnectionSolanaDeploymentIdentityReadPort(rpcUrl),
  );
  const program = manifest.programs.find((item) => item.name === 'perp_venue');
  requireCondition(program !== undefined, 'Solana residual runtime manifest has no test perp program');
  const programId = new PublicKey(program.programId).toBase58();
  const marketAddress = new PublicKey(manifest.testPerp.market).toBase58();
  const positionAddress = PublicKey.findProgramAddressSync([
    Buffer.from('test-perp-position', 'ascii'),
    new PublicKey(marketAddress).toBuffer(),
    key.publicKey.toBuffer(),
  ], new PublicKey(programId))[0].toBase58();
  const slot = await rpc.getFinalizedSlot();
  const [marketAccount, positionAccount] = await rpc.getAccounts([marketAddress, positionAddress], slot);
  requireCondition(marketAccount !== undefined && marketAccount !== null && marketAccount.owner === programId,
    'Solana residual test perp market is absent or has the wrong owner');
  requireCondition(positionAccount !== undefined && positionAccount !== null && positionAccount.owner === programId,
    'Solana residual execution position is absent or has the wrong owner');
  const market = decodeTestPerpMarket(marketAccount.data);
  const position = decodeTestPerpPosition(positionAccount.data);
  requireCondition(market.oracle === manifest.testPerp.oracle
    && market.feedIdHex === manifest.testPerp.feedIdHex
    && position.market === marketAddress
    && (position.owner === solverConfig.solverId || position.delegate === solverConfig.solverId),
  'Solana residual live market or execution authority differs from reviewed configuration');
  const instruments = loadPolicy(required(
    environment, 'NARYX_SOLANA_DEVNET_NETTING_RESIDUAL_CONFIG',
  ), manifest.domain);
  const lanes = instruments.map((instrument) => {
    requireCondition(instrument.quantityAsset.decimals === market.baseDecimals
      && instrument.quoteAsset.assetId === market.collateralMint
      && instrument.quoteAsset.decimals === market.collateralDecimals
      && instrument.quantityIncrementAtoms === market.baseLotAtoms
      && instrument.priceTickQuoteAtoms === market.quoteTickAtomsPerBaseLot,
    `Solana residual instrument ${instrument.instrumentId} differs from live market units`);
    const binding: SolanaTestPerpNettingResidualBinding = Object.freeze({
      domain: instrument.domain,
      adapter: instrument.adapter,
      venue: instrument.venue,
      market: instrument.market,
      programId,
      marketAddress,
      positionAddress,
      oracleAddress: market.oracle,
      collateralVaultAddress: market.collateralVault,
      feeVaultAddress: market.feeVault,
      insuranceVaultAddress: market.insuranceVault,
      executionAccount: solverConfig.solverId,
      baseLotAtoms: market.baseLotAtoms,
      quoteAtomsPerTickPerBaseLot: market.quoteTickAtomsPerBaseLot,
    });
    return Object.freeze({ instrument, binding });
  });
  const journal = new SolanaNettingResidualSqliteJournal(required(
    environment, 'NARYX_SOLANA_DEVNET_NETTING_RESIDUAL_JOURNAL_DB',
  ));
  try {
    return Object.freeze({
      runtime: new SolanaTestPerpNettingResidualRuntime(
        new SolanaDevnetNettingResidualLaneRegistry(lanes),
        journal,
        createSolanaDevnetNettingResidualChain({ rpcUrl, signer: key.keypair }),
        positiveInteger(environment, 'NARYX_SOLANA_DEVNET_NETTING_RESIDUAL_MAX_ATTEMPTS', 3, 16),
      ),
      close: () => journal.close(),
    });
  } catch (error) {
    journal.close();
    throw error;
  }
}
