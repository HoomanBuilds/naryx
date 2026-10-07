import {
  assetAmount,
  bytesEqual,
  strategyPackageQuoteHash,
  strategyPackageReceipt,
  toHex,
  type Hash32,
  type StrategyPackageReceipt,
} from '@naryx/protocol-types';
import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import type { StrategyPackageProvider } from './http-strategy-package-provider.js';
import type { StrategyPreparationService } from './strategy-preparation-service.js';

const TEST_CHAIN_IDS = new Set([84_532, 421_614, 31_337, 31_338]);
const ACCOUNT_ABI = parseAbi([
  'event StrategyExecuted(bytes32 indexed receiptHash,bytes32 indexed packageId,uint8 indexed operation,address solver,bytes32 evidenceRoot,bytes32 nextStateHash)',
  'event AdapterLegExecuted(bytes32 indexed receiptHash,bytes32 indexed packageId,uint256 indexed callIndex,bytes32 adapterSubjectId,uint8 stage,bytes32 evidenceHash)',
  'event StrategyFeesCollected(bytes32 indexed receiptHash,address indexed token,address indexed protocolRecipient,address solverRecipient,uint256 protocolFeeAtoms,uint256 solverFeeAtoms)',
  'function receipt(bytes32 receiptHash) view returns ((bytes32 packageId,bytes32 orderHash,bytes32 graphHash,bytes32 quoteHash,bytes32 routeHash,uint8 operation,bytes32 previousStateHash,bytes32 nextStateHash,bytes32 callsHash,bytes32 evidenceRoot,(uint32 policyVersion,bytes32 policyManifestHash,address token,uint256 protocolFeeAtoms,uint256 solverFeeAtoms) fees,uint256 nonce,address solver))',
]);

interface ObservedLog {
  readonly address: Address;
  readonly data: Hex;
  readonly topics: readonly Hex[];
}

interface ObservedTransactionReceipt {
  readonly status: 'success' | 'reverted';
  readonly blockNumber: bigint;
  readonly logs: readonly ObservedLog[];
}

export interface EvmStrategyObservationReadPort {
  chainId(): Promise<number>;
  transactionReceipt(transactionHash: Hex): Promise<ObservedTransactionReceipt | undefined>;
  finalizedBlockNumber(): Promise<bigint>;
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
  accountReceipt(account: Address, receiptHash: Hex, blockNumber: bigint): Promise<unknown>;
}

export interface EvmOptionSpreadObservationLane {
  readonly chainId: number;
  readonly chain: EvmStrategyObservationReadPort;
}

export type EvmStrategyExecutionObservation = Readonly<
  | { version: 1; status: 'PENDING' | 'PENDING_FINALITY'; transactionHash: Hex }
  | {
      version: 1;
      status: 'FINALIZED';
      transactionHash: Hex;
      onchainReceiptHash: Hex;
      receipt: StrategyPackageReceipt;
    }
>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM option execution observation refused: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  requireCondition(typeof value === 'object' && value !== null && !Array.isArray(value), `${context} is invalid`);
  return value as Record<string, unknown>;
}

function hex(value: Uint8Array): Hex {
  return `0x${Buffer.from(value).toString('hex')}`;
}

function sameHex(left: unknown, right: Hex): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

function signedQuantity(side: 'BUY' | 'SELL' | 'NONE', atoms: bigint): bigint {
  requireCondition(side !== 'NONE', 'an executable option leg cannot have side NONE');
  return side === 'BUY' ? atoms : -atoms;
}

function serviceCharge(
  charges: readonly Readonly<{ category: string; amount: Readonly<{ atoms: bigint }> }>[],
  category: 'PROTOCOL' | 'SOLVER',
): bigint {
  const matching = charges.filter((charge) => charge.category === category);
  requireCondition(matching.length <= 1, `${category.toLowerCase()} fee appears more than once`);
  return matching[0]?.amount.atoms ?? 0n;
}

export function createViemEvmStrategyObservationReadPort(rpcUrl: string): EvmStrategyObservationReadPort {
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error('EVM observation RPC URL must be HTTP or HTTPS');
  const client = createPublicClient({ transport: http(rpcUrl) });
  return Object.freeze({
    chainId: () => client.getChainId(),
    transactionReceipt: async (transactionHash: Hex) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash: transactionHash });
        return Object.freeze({
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          logs: Object.freeze(receipt.logs.map((log) => Object.freeze({
            address: log.address,
            data: log.data,
            topics: log.topics,
          }))),
        });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return undefined;
        throw error;
      }
    },
    finalizedBlockNumber: async () => {
      const block = await client.getBlock({ blockTag: 'finalized' });
      requireCondition(block.number !== null, 'finalized block has no number');
      return block.number;
    },
    blockTimestamp: async (blockNumber: bigint) => (await client.getBlock({ blockNumber })).timestamp,
    accountReceipt: (account: Address, receiptHash: Hex, blockNumber: bigint) => client.readContract({
      address: account,
      abi: ACCOUNT_ABI,
      functionName: 'receipt',
      args: [receiptHash],
      blockNumber,
    }),
  });
}

export class EvmOptionSpreadExecutionObservationService {
  readonly #packages: StrategyPackageProvider;
  readonly #preparations: StrategyPreparationService;
  readonly #lanes: readonly EvmOptionSpreadObservationLane[];

  constructor(input: Readonly<{
    packages: StrategyPackageProvider;
    preparations: StrategyPreparationService;
    lanes: readonly EvmOptionSpreadObservationLane[];
  }>) {
    this.#packages = input.packages;
    this.#preparations = input.preparations;
    this.#lanes = input.lanes;
  }

  async observe(input: Readonly<{ quoteHash: Hash32; transactionHash: Hex }>): Promise<EvmStrategyExecutionObservation | undefined> {
    requireCondition(/^0x[0-9a-f]{64}$/.test(input.transactionHash), 'transaction hash must be lowercase bytes32');
    const documents = await this.#packages.getByQuote(input.quoteHash);
    if (documents === undefined) return undefined;
    requireCondition(bytesEqual(strategyPackageQuoteHash(documents.quote), input.quoteHash), 'quote provider returned another package');
    requireCondition(documents.order.templateId === 'option-spread-v1', 'package is not an option spread');
    const prepared = await this.#preparations.prepareDocuments(documents);
    requireCondition(prepared.settlementClass === 'ATOMIC_POSTCONDITION'
      && prepared.coordination === 'SINGLE_DOMAIN_ATOMIC'
      && prepared.domains.length === 1, 'package is not one atomic EVM execution');
    const domain = prepared.domains[0]!;
    requireCondition(domain.kind === 'EVM_MULTI_STRATEGY_ACCOUNT', 'prepared package is not an EVM strategy account execution');
    const envelope = domain.envelope;
    const chainId = envelope.ownerTypedData.domain.chainId;
    requireCondition(TEST_CHAIN_IDS.has(chainId), 'execution chain is not an allowed test chain');
    const matches = this.#lanes.filter((lane) => lane.chainId === chainId);
    requireCondition(matches.length === 1, 'execution must resolve to exactly one observation lane');
    const chain = matches[0]!.chain;
    requireCondition(await chain.chainId() === chainId, 'observation RPC serves another chain');
    const transaction = await chain.transactionReceipt(input.transactionHash);
    if (transaction === undefined) return Object.freeze({ version: 1, status: 'PENDING', transactionHash: input.transactionHash });
    requireCondition(transaction.status === 'success', 'transaction reverted');
    const finalized = await chain.finalizedBlockNumber();
    if (transaction.blockNumber > finalized) {
      return Object.freeze({ version: 1, status: 'PENDING_FINALITY', transactionHash: input.transactionHash });
    }

    const account = getAddress(envelope.account);
    const decoded = transaction.logs
      .filter((log) => getAddress(log.address) === account)
      .map((log) => decodeEventLog({
        abi: ACCOUNT_ABI,
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
        strict: true,
      }));
    const strategyEvents = decoded.filter((event) => event.eventName === 'StrategyExecuted');
    const legEvents = decoded.filter((event) => event.eventName === 'AdapterLegExecuted');
    const feeEvents = decoded.filter((event) => event.eventName === 'StrategyFeesCollected');
    requireCondition(strategyEvents.length === 1, 'transaction must emit exactly one strategy receipt');
    requireCondition(legEvents.length === envelope.calls.length, 'transaction must emit one evidence event per adapter call');
    const strategyArgs = record(strategyEvents[0]!.args, 'strategy event');
    const receiptHash = String(strategyArgs.receiptHash).toLowerCase() as Hex;
    requireCondition(/^0x[0-9a-f]{64}$/.test(receiptHash), 'onchain receipt hash is invalid');
    requireCondition(sameHex(strategyArgs.packageId, envelope.execution.packageId)
      && strategyArgs.operation === envelope.execution.operation
      && getAddress(String(strategyArgs.solver)) === getAddress(envelope.execution.solver)
      && sameHex(strategyArgs.nextStateHash, envelope.execution.nextStateHash),
    'strategy event differs from the prepared execution');

    const orderedEvidence: Hex[] = [];
    const evidenceBySubject = new Map<Hex, Hex>();
    for (const event of legEvents) {
      const args = record(event.args, 'adapter evidence event');
      const index = args.callIndex;
      requireCondition(typeof index === 'bigint' && index >= 0n && index < BigInt(envelope.calls.length), 'adapter call index is invalid');
      const call = envelope.calls[Number(index)]!;
      requireCondition(sameHex(args.receiptHash, receiptHash)
        && sameHex(args.packageId, envelope.execution.packageId)
        && sameHex(args.adapterSubjectId, call.adapter.subjectId)
        && args.stage === call.stage
        && typeof args.evidenceHash === 'string' && /^0x[0-9a-f]{64}$/.test(args.evidenceHash),
      'adapter evidence event differs from the prepared call');
      requireCondition(orderedEvidence[Number(index)] === undefined, 'adapter call evidence appears twice');
      const evidenceHash = args.evidenceHash as Hex;
      orderedEvidence[Number(index)] = evidenceHash;
      requireCondition(!evidenceBySubject.has(call.adapter.subjectId), 'adapter subjects must be unique for option receipt attribution');
      evidenceBySubject.set(call.adapter.subjectId, evidenceHash);
    }
    requireCondition(orderedEvidence.length === envelope.calls.length && orderedEvidence.every(Boolean), 'adapter evidence sequence is incomplete');
    const evidenceRoot = keccak256(encodeAbiParameters([{ type: 'bytes32[]' }], [orderedEvidence]));
    requireCondition(sameHex(strategyArgs.evidenceRoot, evidenceRoot), 'strategy evidence root does not match its leg events');

    const expectsFees = envelope.execution.fees.protocolFeeAtoms !== 0n || envelope.execution.fees.solverFeeAtoms !== 0n;
    requireCondition(feeEvents.length === (expectsFees ? 1 : 0), 'fee event count is invalid');
    if (expectsFees) {
      const args = record(feeEvents[0]!.args, 'fee event');
      requireCondition(sameHex(args.receiptHash, receiptHash)
        && getAddress(String(args.token)) === getAddress(envelope.execution.fees.token)
        && getAddress(String(args.solverRecipient)) === getAddress(envelope.execution.solver)
        && args.protocolFeeAtoms === envelope.execution.fees.protocolFeeAtoms
        && args.solverFeeAtoms === envelope.execution.fees.solverFeeAtoms,
      'fee event differs from the prepared execution');
    }

    const stored = record(await chain.accountReceipt(account, receiptHash, transaction.blockNumber), 'stored account receipt');
    const storedFees = record(stored.fees, 'stored account receipt fees');
    requireCondition(sameHex(stored.packageId, envelope.execution.packageId)
      && sameHex(stored.orderHash, envelope.execution.orderHash)
      && sameHex(stored.graphHash, envelope.execution.graphHash)
      && sameHex(stored.quoteHash, envelope.execution.quoteHash)
      && sameHex(stored.routeHash, envelope.execution.routeHash)
      && stored.operation === envelope.execution.operation
      && sameHex(stored.previousStateHash, envelope.execution.previousStateHash)
      && sameHex(stored.nextStateHash, envelope.execution.nextStateHash)
      && sameHex(stored.callsHash, envelope.callsHash)
      && sameHex(stored.evidenceRoot, evidenceRoot)
      && stored.nonce === envelope.execution.nonce
      && getAddress(String(stored.solver)) === getAddress(envelope.execution.solver)
      && storedFees.policyVersion === envelope.execution.fees.policyVersion
      && sameHex(storedFees.policyManifestHash, envelope.execution.fees.policyManifestHash)
      && getAddress(String(storedFees.token)) === getAddress(envelope.execution.fees.token)
      && storedFees.protocolFeeAtoms === envelope.execution.fees.protocolFeeAtoms
      && storedFees.solverFeeAtoms === envelope.execution.fees.solverFeeAtoms,
    'stored account receipt differs from the prepared execution');

    const legOutcomes = documents.graph.legs.map((leg) => {
      const subject = keccak256(stringToHex(leg.adapter.adapterId));
      const evidenceHash = evidenceBySubject.get(subject);
      requireCondition(evidenceHash !== undefined, `missing onchain evidence for ${leg.legId}`);
      const economics = documents.quote.legEconomics.find((candidate) => candidate.legId === leg.legId);
      requireCondition(economics !== undefined, `quote economics are missing for ${leg.legId}`);
      return Object.freeze({
        legId: leg.legId,
        positionLegId: leg.legId,
        domain: leg.domain,
        status: 'EXECUTED' as const,
        requestedQuantity: assetAmount(leg.quantityAsset, leg.quantityAtoms),
        settledQuantity: assetAmount(leg.quantityAsset, signedQuantity(leg.side, leg.quantityAtoms)),
        grossNotional: economics.grossNotional,
        venueFee: economics.venueFee,
        residualValue: assetAmount(documents.order.quoteAsset, 0n),
        evidenceGrade: 'CONSENSUS_VERIFIED' as const,
        onchainEnforced: true,
        evidenceHash,
      });
    });
    const protocolFee = serviceCharge(documents.quote.serviceCharges, 'PROTOCOL');
    const solverFee = serviceCharge(documents.quote.serviceCharges, 'SOLVER');
    requireCondition(protocolFee === envelope.execution.fees.protocolFeeAtoms
      && solverFee === envelope.execution.fees.solverFeeAtoms, 'quoted fees differ from the enforced execution');
    const zero = assetAmount(documents.order.quoteAsset, 0n);
    const receipt = strategyPackageReceipt({
      version: 1,
      environment: documents.order.environment,
      domains: documents.route.domainPlans.map((plan) => plan.domain),
      orderHash: documents.orderHashHex,
      graphHash: documents.graphHashHex,
      quoteHash: documents.quoteHashHex,
      routeHash: documents.routeHashHex,
      templateId: documents.order.templateId,
      templateVersion: documents.order.templateVersion,
      packageTemplateManifestHash: documents.order.packageTemplateManifestHash,
      seriesId: documents.order.seriesId,
      seriesVersion: documents.order.seriesVersion,
      seriesManifestHash: documents.order.seriesManifestHash,
      executionClassId: documents.order.executionClassId,
      executionClassVersion: documents.order.executionClassVersion,
      executionClassManifestHash: documents.order.executionClassManifestHash,
      lifecycleAction: documents.order.lifecycleAction,
      owner: documents.order.owner,
      solverId: documents.quote.solverId,
      settlementClass: documents.order.settlementClass,
      terminalState: 'FINALIZED_COMPLETE',
      quoteAsset: documents.order.quoteAsset,
      legOutcomes,
      serviceFee: assetAmount(documents.order.quoteAsset, protocolFee),
      solverFee: assetAmount(documents.order.quoteAsset, solverFee),
      venueFees: assetAmount(documents.order.quoteAsset, legOutcomes.reduce((sum, leg) => sum + leg.venueFee.atoms, 0n)),
      networkCost: zero,
      recoveryCost: zero,
      terminalResidualValue: zero,
      finalityStatus: 'FINALIZED',
      executedAtValue: await chain.blockTimestamp(transaction.blockNumber),
      receiptNonce: envelope.execution.nonce + 1n,
    });
    requireCondition(toHex(receipt.quoteHash) === documents.quoteHashHex, 'canonical receipt quote binding changed');
    return Object.freeze({
      version: 1,
      status: 'FINALIZED',
      transactionHash: input.transactionHash,
      onchainReceiptHash: receiptHash,
      receipt,
    });
  }
}
