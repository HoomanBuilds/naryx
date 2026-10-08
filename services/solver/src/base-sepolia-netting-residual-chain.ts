import { NARYX_TEST_PERP_MARKET_ABI, type EvmTestPerpNettingResidualPlan } from '@naryx/adapter-evm';
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import type { EvmNettingResidualChainPort } from './evm-netting-residual-runtime.js';

const BASE_SEPOLIA_CHAIN_ID = 84_532;

export interface BaseSepoliaResidualReceipt {
  readonly status: 'success' | 'reverted';
  readonly transactionHash: Hex;
  readonly blockHash: Hex;
  readonly blockNumber: bigint;
  readonly transactionIndex: number;
  readonly logs: readonly Readonly<{
    address: Address;
    data: Hex;
    topics: readonly Hex[];
    logIndex: number;
  }>[];
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireRpcUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Base Sepolia residual RPC URL is invalid');
  }
  requireCondition((parsed.protocol === 'https:' || parsed.protocol === 'http:')
    && parsed.username === '' && parsed.password === '',
  'Base Sepolia residual RPC URL must be credential-free HTTP or HTTPS');
  return parsed.toString();
}

function boundedTradeEvents(receipt: BaseSepoliaResidualReceipt, market: Address) {
  const events: Readonly<{
    executionId: Hex;
    trader: Address;
    sizeDeltaWad: bigint;
    fillPriceWad: bigint;
    notionalWad: bigint;
    feeWad: bigint;
    logIndex: number;
  }>[] = [];
  const collected = [...events];
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== market) continue;
    if (log.topics.length === 0) continue;
    try {
      const decoded = decodeEventLog({
        abi: NARYX_TEST_PERP_MARKET_ABI,
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
        strict: true,
      });
      if (decoded.eventName !== 'BoundedTradeExecuted') continue;
      const args = decoded.args as Readonly<{
        executionId: Hex;
        trader: Address;
        sizeDelta: bigint;
        fillPriceWad: bigint;
        notionalWad: bigint;
        feeWad: bigint;
      }>;
      collected.push(Object.freeze({
        executionId: args.executionId,
        trader: getAddress(args.trader),
        sizeDeltaWad: args.sizeDelta,
        fillPriceWad: args.fillPriceWad,
        notionalWad: args.notionalWad,
        feeWad: args.feeWad,
        logIndex: log.logIndex,
      }));
    } catch {
      continue;
    }
  }
  return Object.freeze(collected);
}

function revertedEvidenceHash(receipt: BaseSepoliaResidualReceipt, plan: EvmTestPerpNettingResidualPlan): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'bytes32' },
      { type: 'bool' },
    ],
    [
      receipt.transactionHash,
      receipt.blockHash,
      receipt.blockNumber,
      BigInt(receipt.transactionIndex),
      plan.executionId,
      false,
    ],
  ));
}

function fillEvidenceHash(
  receipt: BaseSepoliaResidualReceipt,
  event: ReturnType<typeof boundedTradeEvents>[number],
): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'bytes32' },
      { type: 'address' },
      { type: 'int128' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'bool' },
    ],
    [
      receipt.transactionHash,
      receipt.blockHash,
      receipt.blockNumber,
      BigInt(receipt.transactionIndex),
      BigInt(event.logIndex),
      event.executionId,
      event.trader,
      event.sizeDeltaWad,
      event.fillPriceWad,
      event.notionalWad,
      event.feeWad,
      true,
    ],
  ));
}

export function observeBaseSepoliaResidualReceipt(input: Readonly<{
  plan: EvmTestPerpNettingResidualPlan;
  receipt: BaseSepoliaResidualReceipt;
  submittedAtSeconds: bigint;
  observedAtSeconds: bigint;
}>) {
  const { plan, receipt } = input;
  requireCondition(receipt.transactionHash.length === 66 && receipt.blockHash.length === 66,
    'Base residual receipt hashes are malformed');
  requireCondition(receipt.blockNumber >= 0n && Number.isSafeInteger(receipt.transactionIndex)
    && receipt.transactionIndex >= 0, 'Base residual receipt location is invalid');
  requireCondition(input.submittedAtSeconds > 0n && input.observedAtSeconds >= input.submittedAtSeconds,
    'Base residual receipt timestamps are invalid');
  if (receipt.status === 'reverted') {
    return Object.freeze({
      executionId: plan.executionId,
      trader: plan.executionAccount,
      terminalStatus: 'REVERTED' as const,
      sizeDeltaWad: 0n,
      notionalWad: 0n,
      feeWad: 0n,
      submittedAtSeconds: input.submittedAtSeconds,
      observedAtSeconds: input.observedAtSeconds,
      executionReferenceHash: receipt.transactionHash,
      authoritativeEvidenceHash: revertedEvidenceHash(receipt, plan),
    });
  }
  const events = boundedTradeEvents(receipt, getAddress(plan.transaction.to));
  requireCondition(events.length === 1, 'successful Base residual must emit exactly one bounded trade event');
  const event = events[0]!;
  requireCondition(event.executionId.toLowerCase() === plan.executionId.toLowerCase()
    && event.trader === getAddress(plan.executionAccount),
  'Base residual bounded trade event differs from the execution binding');
  requireCondition(event.sizeDeltaWad === plan.sizeDeltaWad
    && event.notionalWad >= plan.minimumNotionalWad
    && event.notionalWad <= plan.maximumNotionalWad
    && event.feeWad <= plan.maximumFeeWad,
  'Base residual bounded trade event violates the compiled limits');
  return Object.freeze({
    executionId: event.executionId,
    trader: event.trader,
    terminalStatus: 'SUCCEEDED' as const,
    sizeDeltaWad: event.sizeDeltaWad,
    notionalWad: event.notionalWad,
    feeWad: event.feeWad,
    submittedAtSeconds: input.submittedAtSeconds,
    observedAtSeconds: input.observedAtSeconds,
    executionReferenceHash: receipt.transactionHash,
    authoritativeEvidenceHash: fillEvidenceHash(receipt, event),
  });
}

function knownBroadcastError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = (current as Error & { cause?: unknown }).cause) {
    if (/already known|known transaction|nonce too low|replacement transaction underpriced/i.test(current.message)) return true;
  }
  return false;
}

export function createViemBaseSepoliaResidualChain(input: Readonly<{
  rpcUrl: string;
  account: LocalAccount;
  minimumConfirmations?: number;
}>): EvmNettingResidualChainPort {
  const rpcUrl = requireRpcUrl(input.rpcUrl);
  const confirmations = input.minimumConfirmations ?? 2;
  requireCondition(Number.isSafeInteger(confirmations) && confirmations > 0,
    'Base residual minimum confirmations must be a positive safe integer');
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: input.account, chain: baseSepolia, transport: http(rpcUrl) });
  const port: EvmNettingResidualChainPort = {
    account: getAddress(input.account.address),
    chainId: () => publicClient.getChainId(),
    currentTimeSeconds: async () => (await publicClient.getBlock({ blockTag: 'latest' })).timestamp,
    sign: async ({ plan }) => {
      requireCondition(plan.transaction.chainId === BASE_SEPOLIA_CHAIN_ID
        && getAddress(plan.executionAccount) === getAddress(input.account.address),
      'Base residual plan is not bound to this Base Sepolia signer');
      const request = await walletClient.prepareTransactionRequest({
        account: input.account,
        chain: baseSepolia,
        to: plan.transaction.to,
        data: plan.transaction.data,
        value: plan.transaction.value,
      });
      requireCondition(request.chainId === BASE_SEPOLIA_CHAIN_ID && request.nonce !== undefined,
        'prepared Base residual transaction has invalid chain identity or nonce');
      const rawTransaction = await walletClient.signTransaction(request);
      const block = await publicClient.getBlock({ blockTag: 'latest' });
      return Object.freeze({
        rawTransaction,
        transactionHash: keccak256(rawTransaction),
        transactionNonce: BigInt(request.nonce),
        signedAtSeconds: block.timestamp,
      });
    },
    broadcast: async (rawTransaction, expectedTransactionHash) => {
      requireCondition(keccak256(rawTransaction).toLowerCase() === expectedTransactionHash.toLowerCase(),
        'Base residual raw transaction hash differs from durable state');
      try {
        const hash = await publicClient.sendRawTransaction({ serializedTransaction: rawTransaction });
        requireCondition(hash.toLowerCase() === expectedTransactionHash.toLowerCase(),
          'Base RPC returned another residual transaction hash');
        return hash;
      } catch (error) {
        if (!knownBroadcastError(error)) throw error;
        try {
          const transaction = await publicClient.getTransaction({ hash: expectedTransactionHash });
          requireCondition(transaction.hash.toLowerCase() === expectedTransactionHash.toLowerCase(),
            'Base RPC found another transaction after ambiguous broadcast');
          return expectedTransactionHash;
        } catch (lookupError) {
          if (!(lookupError instanceof TransactionNotFoundError)) throw lookupError;
          try {
            const receipt = await publicClient.getTransactionReceipt({ hash: expectedTransactionHash });
            requireCondition(receipt.transactionHash.toLowerCase() === expectedTransactionHash.toLowerCase(),
              'Base RPC found another receipt after ambiguous broadcast');
            return expectedTransactionHash;
          } catch (receiptError) {
            if (receiptError instanceof TransactionReceiptNotFoundError) throw error;
            throw receiptError;
          }
        }
      }
    },
    observe: async ({ plan, transactionHash, submittedAtSeconds }) => {
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: transactionHash });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
      requireCondition(receipt.transactionHash.toLowerCase() === transactionHash.toLowerCase(),
        'Base residual receipt cites another transaction');
      const latestBlockNumber = await publicClient.getBlockNumber();
      const confirmationCount = latestBlockNumber >= receipt.blockNumber
        ? latestBlockNumber - receipt.blockNumber + 1n
        : 0n;
      if (confirmationCount < BigInt(confirmations)) return null;
      const block = await publicClient.getBlock({ blockHash: receipt.blockHash });
      const normalizedReceipt: BaseSepoliaResidualReceipt = Object.freeze({
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber,
        transactionIndex: receipt.transactionIndex,
        logs: Object.freeze(receipt.logs.map((log) => {
          requireCondition(log.logIndex !== null, 'Base residual receipt log has no index');
          return Object.freeze({
            address: getAddress(log.address),
            data: log.data,
            topics: log.topics,
            logIndex: log.logIndex,
          });
        })),
      });
      return observeBaseSepoliaResidualReceipt({
        plan,
        receipt: normalizedReceipt,
        submittedAtSeconds,
        observedAtSeconds: block.timestamp,
      });
    },
  };
  return Object.freeze(port);
}
