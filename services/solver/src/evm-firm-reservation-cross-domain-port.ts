import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { arbitrumSepolia, baseSepolia } from 'viem/chains';
import { NARYX_MULTI_STRATEGY_ACCOUNT_STATE_ABI } from '@naryx/adapter-evm';
import type {
  EvmAtomicPackageReceipt,
  EvmAtomicPackageState,
  EvmFirmReservationCrossDomainPort,
  EvmFirmReservationRecord,
  EvmFirmReservationState,
} from './evm-firm-reservation-cross-domain-lane.js';
import { EvmCrossDomainSubmissionJournal } from './evm-cross-domain-submission-journal.js';
import type { EvmRecoverableCrossDomainPort } from './evm-cross-domain-recovery-port.js';
import type { EvmRecoveryAdapterPolicy } from './evm-full-reversal-policy.js';

const RESERVATION_BOOK_ABI = parseAbi([
  'function reservation(bytes32 reservationId) view returns (((bytes32 domainIdHash,uint32 manifestVersion,bytes32 manifestHash) domain,string solverId,address solver,address reclaimOwner,address strategyAccount,uint256 packageNonce,bytes32 orderHash,uint256 reservationNonce,bytes32 quoteHash,bytes32 routeHash,uint256 baseAtoms,uint256 quoteAtoms,uint64 expiry,address consumer,bytes32 consumerCodeHash,uint8 state))',
  'function liveReservation(bytes32 solverStrategyKey) view returns (bytes32)',
]);
const STRATEGY_ACCOUNT_ABI = [...NARYX_MULTI_STRATEGY_ACCOUNT_STATE_ABI, ...parseAbi([
  'function nextNonce() view returns (uint256)',
  'function owner() view returns (address)',
])];
const OCCUPANCY_KEY_PARAMETERS = parseAbiParameters('address solver,address strategyAccount');
const EXECUTION_EVENT_ABI = parseAbi([
  'event StrategyExecuted(bytes32 indexed receiptHash,bytes32 indexed packageId,uint8 indexed operation,address solver,bytes32 evidenceRoot,bytes32 nextStateHash)',
]);
const TRANSFER_EVENT_ABI = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const RECOVERY_ADAPTER_ABI = parseAbi([
  'function adapterMetadata() view returns (address,bytes32,uint32,address,address)',
  'function packageId() view returns (bytes32)',
  'function assertDeployment() view',
]);
const DERIVATIVE_RECOVERY_ABI = parseAbi([
  'function generation() view returns (uint64)',
  'function entryPayloadHash() view returns (bytes32)',
  'function entrySizeWad() view returns (int128)',
  'function position() view returns ((int128 balance,int128 size,uint128 entryNotional,uint128 entrySocialLossIndex,int128 entryFundingIndex))',
  'function marginGate() view returns (address)',
]);
const RECOVERY_RESERVE_ABI = parseAbi(['function reserveOf(address account) view returns (uint256)']);
const RESERVATION_STATES: readonly EvmFirmReservationState[] = Object.freeze([
  'NONE', 'FUNDED', 'LIVE', 'CONSUMED', 'RELEASED',
]);

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM firm reservation port refused: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  requireCondition(typeof value === 'object' && value !== null && !Array.isArray(value), `${context} is invalid`);
  return value as Record<string, unknown>;
}

function bytes32(value: unknown, context: string): Hex {
  requireCondition(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), `${context} is not bytes32`);
  return value.toLowerCase() as Hex;
}

function unsigned(value: unknown, context: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n, `${context} is not an unsigned integer`);
  return value;
}

function unsignedNumber(value: unknown, context: string): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    `${context} is not an unsigned integer`);
  return value;
}

function reservationRecord(value: unknown): EvmFirmReservationRecord {
  const reservation = record(value, 'reservation');
  const domain = record(reservation.domain, 'reservation domain');
  const stateIndex = unsignedNumber(reservation.state, 'reservation state');
  const state = RESERVATION_STATES[stateIndex];
  requireCondition(state !== undefined, 'reservation state is unknown');
  return Object.freeze({
    domainIdHash: bytes32(domain.domainIdHash, 'reservation domain ID hash'),
    domainManifestVersion: unsignedNumber(domain.manifestVersion, 'reservation domain manifest version'),
    domainManifestHash: bytes32(domain.manifestHash, 'reservation domain manifest hash'),
    solver: getAddress(String(reservation.solver)),
    strategyAccount: getAddress(String(reservation.strategyAccount)),
    packageNonce: unsigned(reservation.packageNonce, 'reservation package nonce'),
    orderHash: bytes32(reservation.orderHash, 'reservation order hash'),
    quoteHash: bytes32(reservation.quoteHash, 'reservation quote hash'),
    routeHash: bytes32(reservation.routeHash, 'reservation route hash'),
    baseAtoms: unsigned(reservation.baseAtoms, 'reservation base atoms'),
    quoteAtoms: unsigned(reservation.quoteAtoms, 'reservation quote atoms'),
    expiry: unsigned(reservation.expiry, 'reservation expiry'),
    state,
  });
}

function packageStateRecord(value: unknown): EvmAtomicPackageState {
  const state = record(value, 'package state');
  requireCondition(typeof state.active === 'boolean', 'package active flag is invalid');
  return Object.freeze({
    stateHash: bytes32(state.stateHash, 'package state hash'),
    lastReceiptHash: bytes32(state.lastReceiptHash, 'package receipt hash'),
    active: state.active,
  });
}

function packageReceiptRecord(value: unknown): EvmAtomicPackageReceipt {
  const receipt = record(value, 'package receipt');
  return Object.freeze({
    packageId: bytes32(receipt.packageId, 'receipt package ID'),
    orderHash: bytes32(receipt.orderHash, 'receipt order hash'),
    quoteHash: bytes32(receipt.quoteHash, 'receipt quote hash'),
    routeHash: bytes32(receipt.routeHash, 'receipt route hash'),
    nextStateHash: bytes32(receipt.nextStateHash, 'receipt next state hash'),
    nonce: unsigned(receipt.nonce, 'receipt nonce'),
    solver: getAddress(String(receipt.solver)),
  });
}

export function createViemEvmFirmReservationCrossDomainPort(input: Readonly<{
  rpcUrl: string;
  chainReference: 84_532n | 421_614n;
  account: LocalAccount;
  submissionJournalPath: string;
  maximumGasBudgetWei: bigint;
  alreadySpentWei: bigint;
}>): EvmRecoverableCrossDomainPort & { close(): void } {
  requireCondition(input.chainReference === 84_532n || input.chainReference === 421_614n,
    'only Base Sepolia and Arbitrum Sepolia are allowed');
  requireCondition(/^https?:\/\//.test(input.rpcUrl), 'RPC URL must be HTTP or HTTPS');
  const chain = input.chainReference === 84_532n ? baseSepolia : arbitrumSepolia;
  const publicClient = createPublicClient({ chain, transport: http(input.rpcUrl) });
  const walletClient = createWalletClient({ account: input.account, chain, transport: http(input.rpcUrl) });
  const submissions = new EvmCrossDomainSubmissionJournal({
    path: input.submissionJournalPath, chainId: chain.id, signer: input.account.address,
    maximumGasBudgetWei: input.maximumGasBudgetWei, alreadySpentWei: input.alreadySpentWei,
    port: {
      chainId: () => publicClient.getChainId(),
      pendingNonce: () => publicClient.getTransactionCount({ address: input.account.address, blockTag: 'pending' }),
      sign: request => walletClient.signTransaction({ account: input.account, chain, type: 'eip1559',
        chainId: chain.id, nonce: request.nonce, to: getAddress(request.to), data: request.data,
        value: 0n, gas: request.gas, maxFeePerGas: request.maximumFeePerGasWei,
        maxPriorityFeePerGas: request.maximumFeePerGasWei }),
      broadcast: async raw => {
        const hash = keccak256(raw);
        try { return await publicClient.sendRawTransaction({ serializedTransaction: raw }); }
        catch (error) {
          try {
            const found = await publicClient.getTransaction({ hash });
            requireCondition(found.hash === hash, 'RPC found another transaction');
            return hash;
          } catch (lookupError) {
            if (!(lookupError instanceof TransactionNotFoundError)) throw lookupError;
            throw error;
          }
        }
      },
      finalized: async hash => {
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash });
          const head = await publicClient.getBlock({ blockTag: 'finalized' });
          if (head.number < receipt.blockNumber) return undefined;
          const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
          requireCondition(block.hash === receipt.blockHash && receipt.transactionHash === hash,
            'transaction receipt is not canonical');
          return receipt.status === 'success' ? 'SUCCESS' : 'REVERTED';
        } catch (error) {
          if (error instanceof TransactionReceiptNotFoundError) return undefined;
          throw error;
        }
      },
    },
  });
  const finalizedRead = (request: Readonly<{
    address: Address;
    abi: typeof RESERVATION_BOOK_ABI | typeof STRATEGY_ACCOUNT_ABI;
    functionName: string;
    args?: readonly unknown[];
  }>) => publicClient.readContract({
    address: request.address,
    abi: request.abi,
    functionName: request.functionName,
    ...(request.args === undefined ? {} : { args: request.args }),
    blockTag: 'finalized',
  } as never);

  return Object.freeze({
    close: () => submissions.close(),
    chainId: async () => BigInt(await publicClient.getChainId()),
    accountOwner: async (account: Address) => getAddress(await finalizedRead({ address: account, abi: STRATEGY_ACCOUNT_ABI, functionName: 'owner' }) as Address),
    currentTime: async () => (await publicClient.getBlock({ blockTag: 'latest' })).timestamp,
    finalizedTime: async () => (await publicClient.getBlock({ blockTag: 'finalized' })).timestamp,
    recoveryAdapterState: async (policy: EvmRecoveryAdapterPolicy) => {
      const head = await publicClient.getBlock({ blockTag: 'finalized' });
      const query = { address: policy.address, abi: RECOVERY_ADAPTER_ABI, blockNumber: head.number };
      const [metadata, packageId, code] = await Promise.all([
        publicClient.readContract({ ...query, functionName: 'adapterMetadata' }),
        publicClient.readContract({ ...query, functionName: 'packageId' }),
        publicClient.getCode({ address: policy.address, blockNumber: head.number }),
        publicClient.readContract({ ...query, functionName: 'assertDeployment' }),
      ]);
      requireCondition(code !== undefined && code !== '0x', 'recovery adapter has no code');
      const deployment = { codeHash: keccak256(code), account: getAddress(metadata[0]), classId: metadata[1],
        classVersion: metadata[2], baseToken: getAddress(metadata[3]), quoteToken: getAddress(metadata[4]), packageId };
      let derivative;
      if (policy.kind === 'RECOVERABLE_PERP' || policy.kind === 'RECOVERABLE_FUTURE') {
        const request = { address: policy.address, abi: DERIVATIVE_RECOVERY_ABI, blockNumber: head.number };
        const [generation, entryPayloadHash, entrySizeWad, position, gate] = await Promise.all([
          publicClient.readContract({ ...request, functionName: 'generation' }),
          publicClient.readContract({ ...request, functionName: 'entryPayloadHash' }),
          publicClient.readContract({ ...request, functionName: 'entrySizeWad' }),
          publicClient.readContract({ ...request, functionName: 'position' }),
          publicClient.readContract({ ...request, functionName: 'marginGate' }),
        ]);
        const reserveAtoms = await publicClient.readContract({ address: gate, abi: RECOVERY_RESERVE_ABI,
          functionName: 'reserveOf', args: [policy.address], blockNumber: head.number });
        derivative = { generation, entryPayloadHash, entrySizeWad, sizeWad: position.size, balanceWad: position.balance,
          entryNotionalWad: position.entryNotional, reserveAtoms };
      }
      requireCondition((await publicClient.getBlock({ blockNumber: head.number })).hash === head.hash, 'recovery state block changed');
      return { ...deployment, ...(derivative === undefined ? {} : { derivative }) };
    },
    observeSubmission: async (operationId: string, account: Address) => {
      const observed = await submissions.observe(operationId);
      if (observed === undefined) return { status: 'ABSENT' as const };
      if (observed.status === 'PENDING' || observed.hash === null) return { status: 'PENDING' as const };
      if (observed.status === 'REVERTED') return { status: 'REVERTED' as const, transactionHash: observed.hash };
      const [transaction, transactionReceipt] = await Promise.all([
        publicClient.getTransaction({ hash: observed.hash }), publicClient.getTransactionReceipt({ hash: observed.hash }),
      ]);
      const [head, block] = await Promise.all([
        publicClient.getBlock({ blockTag: 'finalized' }),
        publicClient.getBlock({ blockNumber: transactionReceipt.blockNumber }),
      ]);
      requireCondition(head.number >= transactionReceipt.blockNumber && block.hash === transactionReceipt.blockHash
        && transactionReceipt.transactionHash === observed.hash && transactionReceipt.status === 'success',
      'execution receipt no longer matches finalized chain data');
      requireCondition(transaction.to !== null && getAddress(transaction.to) === getAddress(account),
        'successful execution targeted another account');
      const executions = transactionReceipt.logs.filter(log => getAddress(log.address) === getAddress(account)).flatMap(log => {
        try { return [decodeEventLog({ abi: EXECUTION_EVENT_ABI, data: log.data, topics: log.topics })]; }
        catch { return []; }
      });
      requireCondition(executions.length === 1, 'execution must emit exactly one account receipt');
      const receipt = record(await finalizedRead({ address: account, abi: STRATEGY_ACCOUNT_ABI,
        functionName: 'receipt', args: [executions[0]!.args.receiptHash] }), 'execution receipt');
      const tokenDeltas = new Map<Address, bigint>();
      for (const log of transactionReceipt.logs) {
        let transfer;
        try { transfer = decodeEventLog({ abi: TRANSFER_EVENT_ABI, data: log.data, topics: log.topics }); }
        catch { continue; }
        const { from, to, value } = transfer.args;
        const delta = (getAddress(to) === getAddress(account) ? value : 0n)
          - (getAddress(from) === getAddress(account) ? value : 0n);
        if (getAddress(to) === getAddress(account) || getAddress(from) === getAddress(account)) {
          const token = getAddress(log.address);
          tokenDeltas.set(token, (tokenDeltas.get(token) ?? 0n) + delta);
        }
      }
      return { status: 'SUCCESS' as const, transactionHash: observed.hash, to: getAddress(account), data: transaction.input,
        tokenDeltas,
        receipt: { ...packageReceiptRecord(receipt), operation: unsignedNumber(receipt.operation, 'operation'),
          previousStateHash: bytes32(receipt.previousStateHash, 'previous state'), callsHash: bytes32(receipt.callsHash, 'calls hash') } };
    },
    codeHash: async (address: Address) => {
      const code = await publicClient.getCode({ address, blockTag: 'finalized' });
      return code === undefined || code === '0x' ? null : keccak256(code);
    },
    reservation: async (book: Address, reservationId: Hex) => reservationRecord(await finalizedRead({
      address: getAddress(book),
      abi: RESERVATION_BOOK_ABI,
      functionName: 'reservation',
      args: [reservationId],
    })),
    liveReservationId: async (book: Address, solver: Address, strategyAccount: Address) => bytes32(
      await finalizedRead({
        address: getAddress(book),
        abi: RESERVATION_BOOK_ABI,
        functionName: 'liveReservation',
        args: [keccak256(encodeAbiParameters(OCCUPANCY_KEY_PARAMETERS, [
          getAddress(solver), getAddress(strategyAccount),
        ]))],
      }),
      'live reservation ID',
    ),
    accountNextNonce: async (account: Address) => unsigned(await finalizedRead({
      address: getAddress(account),
      abi: STRATEGY_ACCOUNT_ABI,
      functionName: 'nextNonce',
    }), 'account nonce'),
    packageState: async (account: Address, packageId: Hex) => packageStateRecord(await finalizedRead({
      address: getAddress(account),
      abi: STRATEGY_ACCOUNT_ABI,
      functionName: 'packageState',
      args: [packageId],
    })),
    packageReceipt: async (account: Address, receiptHash: Hex) => packageReceiptRecord(await finalizedRead({
      address: getAddress(account),
      abi: STRATEGY_ACCOUNT_ABI,
      functionName: 'receipt',
      args: [receiptHash],
    })),
    submit: (request: Parameters<EvmFirmReservationCrossDomainPort['submit']>[0]) => submissions.submit(request),
  });
}
