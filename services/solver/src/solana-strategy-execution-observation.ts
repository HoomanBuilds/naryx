import bs58 from 'bs58';
import {
  assetAmount,
  bytesEqual,
  strategyPackageReceipt,
  type StrategyPackageReceipt,
  type DomainRef,
  type Hash32,
} from '@naryx/protocol-types';
import {
  decodeSolanaMultiStrategyReceipt,
  decodeSolanaStrategyAdapterLegEvent,
  solanaMultiStrategyEvidenceRoot,
  solanaMultiStrategyReceiptHash,
} from '@naryx/adapter-solana';
import type { StoredStrategyPackageDocuments, StrategyPackageProvider } from './http-strategy-package-provider.js';
import type { SolanaTreasuryHedgeExecutionLane } from './solana-treasury-hedge-config.js';
import { requireSolanaDevnet } from './solana-devnet-rpc.js';
import {
  solanaStrategyExecutionEnvelope,
} from './solana-strategy-execution-authorization.js';
import type { StrategyPreparationService } from './strategy-preparation-service.js';

export type SolanaStrategyExecutionObservation = Readonly<
  | { version: 1; status: 'PENDING' | 'FAILED'; signature: string }
  | {
      version: 1;
      status: 'FINALIZED';
      signature: string;
      domain: DomainRef;
      slot: bigint;
      strategyAccount: string;
      position: string;
      receiptAccount: string;
      packageId: string;
      orderHash: string;
      graphHash: string;
      quoteHash: string;
      routeHash: string;
      operation: string;
      previousStateHash: string;
      nextStateHash: string;
      callsHash: string;
      evidenceRoot: string;
      onchainReceiptHash: string;
      solver: string;
      nonce: bigint;
      receipt: StrategyPackageReceipt;
    }
>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Solana strategy execution observation refused: ${message}`);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function sameAddresses(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalSignature(value: string): string {
  try {
    const decoded = bs58.decode(value);
    requireCondition(decoded.length === 64 && bs58.encode(decoded) === value, 'signature is invalid');
    return value;
  } catch {
    throw new Error('Solana strategy execution observation refused: signature is invalid');
  }
}

function signedQuantity(
  side: 'BUY' | 'SELL' | 'NONE',
  legFamily: string,
  lifecycleAction: string,
  atoms: bigint,
): bigint {
  if (side === 'BUY') return atoms;
  if (side === 'SELL') return -atoms;
  if (legFamily === 'WITHDRAW' || legFamily === 'MARGIN_RELEASE' || legFamily === 'REPAY') return -atoms;
  if (legFamily === 'INVENTORY_TRANSFER' || legFamily === 'COLLATERAL_TRANSFER') {
    return lifecycleAction === 'DECREASE' || lifecycleAction === 'EXIT' || lifecycleAction === 'EMERGENCY_UNWIND'
      ? -atoms
      : atoms;
  }
  return atoms;
}

function positionIdentity(legFamily: string, legId: string): Readonly<{
  positionLegId?: string;
  liabilityId?: string;
}> {
  if (legFamily === 'BORROW' || legFamily === 'REPAY') return Object.freeze({ liabilityId: legId });
  if (legFamily === 'MARGIN_DEPOSIT' || legFamily === 'MARGIN_RELEASE' || legFamily === 'COLLATERAL_TRANSFER') {
    return Object.freeze({});
  }
  return Object.freeze({ positionLegId: legId });
}

function programData(logs: readonly string[], programId: string): readonly Uint8Array[] {
  const stack: string[] = [];
  const values: Uint8Array[] = [];
  for (const message of logs) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)]$/.exec(message);
    if (invoke !== null) {
      const depth = Number(invoke[2]);
      requireCondition(Number.isSafeInteger(depth) && depth >= 1 && depth <= 64,
        'transaction program invocation depth is invalid');
      stack.length = depth - 1;
      stack.push(invoke[1]!);
      continue;
    }
    const completion = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed: .+)$/.exec(message);
    if (completion !== null) {
      requireCondition(stack.at(-1) === completion[1], 'transaction program log stack is inconsistent');
      stack.pop();
      continue;
    }
    if (!message.startsWith('Program data: ') || stack.at(-1) !== programId) continue;
    const encoded = message.slice('Program data: '.length);
    requireCondition(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'program event data is not base64');
    const decoded = Buffer.from(encoded, 'base64');
    requireCondition(decoded.toString('base64') === encoded, 'program event data is not canonical base64');
    values.push(Uint8Array.from(decoded));
  }
  requireCondition(stack.length === 0, 'transaction program log stack is incomplete');
  return Object.freeze(values);
}

function canonicalReceipt(
  documents: StoredStrategyPackageDocuments,
  legEvidence: ReadonlyMap<string, Uint8Array>,
  executedAtValue: bigint,
  receiptNonce: bigint,
): StrategyPackageReceipt {
  const zero = assetAmount(documents.order.quoteAsset, 0n);
  requireCondition(documents.quote.serviceCharges.every((charge) => charge.amount.atoms === 0n),
    'Solana execution receipt cannot report uncollected service charges');
  const legOutcomes = documents.graph.legs.map((leg) => {
    const evidenceHash = legEvidence.get(leg.legId);
    requireCondition(evidenceHash !== undefined, `missing onchain evidence for ${leg.legId}`);
    const economics = documents.quote.legEconomics.find((candidate) => candidate.legId === leg.legId);
    requireCondition(economics !== undefined, `quote economics are missing for ${leg.legId}`);
    return Object.freeze({
      legId: leg.legId,
      ...positionIdentity(leg.legFamily, leg.legId),
      domain: leg.domain,
      status: 'EXECUTED' as const,
      requestedQuantity: assetAmount(leg.quantityAsset, leg.quantityAtoms),
      settledQuantity: assetAmount(
        leg.quantityAsset,
        signedQuantity(leg.side, leg.legFamily, documents.order.lifecycleAction, leg.quantityAtoms),
      ),
      grossNotional: economics.grossNotional,
      venueFee: economics.venueFee,
      residualValue: zero,
      evidenceGrade: 'CONSENSUS_VERIFIED' as const,
      onchainEnforced: true,
      evidenceHash,
    });
  });
  return strategyPackageReceipt({
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
    serviceFee: zero,
    solverFee: zero,
    venueFees: assetAmount(documents.order.quoteAsset,
      legOutcomes.reduce((sum, leg) => sum + leg.venueFee.atoms, 0n)),
    networkCost: zero,
    recoveryCost: zero,
    terminalResidualValue: zero,
    finalityStatus: 'FINALIZED',
    executedAtValue,
    receiptNonce,
  });
}

export class SolanaStrategyExecutionObservationService {
  readonly #packages: StrategyPackageProvider;
  readonly #preparations: Pick<StrategyPreparationService, 'prepareByQuote'>;
  readonly #lanes: readonly SolanaTreasuryHedgeExecutionLane[];

  constructor(input: Readonly<{
    packages: StrategyPackageProvider;
    preparations: Pick<StrategyPreparationService, 'prepareByQuote'>;
    lanes: readonly SolanaTreasuryHedgeExecutionLane[];
  }>) {
    requireCondition(input.lanes.length > 0, 'at least one execution lane is required');
    this.#packages = input.packages;
    this.#preparations = input.preparations;
    this.#lanes = Object.freeze([...input.lanes]);
  }

  async observe(input: Readonly<{
    quoteHash: Hash32;
    signature: string;
  }>): Promise<SolanaStrategyExecutionObservation | undefined> {
    const signature = canonicalSignature(input.signature);
    const prepared = await this.#preparations.prepareByQuote(input.quoteHash);
    if (prepared === undefined) return undefined;
    const documents = await this.#packages.getByQuote(input.quoteHash);
    requireCondition(documents !== undefined, 'strategy package documents are unavailable');
    requireCondition(documents.quoteHashHex === hex(input.quoteHash)
      && documents.orderHashHex === hex(prepared.orderHash)
      && documents.graphHashHex === hex(prepared.graphHash)
      && documents.routeHashHex === hex(prepared.routeHash),
    'strategy package documents differ from the prepared execution');
    requireCondition(bytesEqual(prepared.quoteHash, input.quoteHash), 'preparation returned another quote');
    const compiled = solanaStrategyExecutionEnvelope(prepared);
    requireCondition(prepared.identity.nextStateHash !== undefined,
      'prepared strategy execution has no next state hash');
    const lanes = this.#lanes.filter((lane) => sameDomain(lane.domain, compiled.domain));
    requireCondition(lanes.length === 1, 'prepared domain does not resolve to exactly one execution lane');
    const lane = lanes[0]!;
    await requireSolanaDevnet(lane.reader);
    const transaction = await lane.reader.getTransactionObservation(signature);
    if (transaction.status !== 'FINALIZED') {
      return Object.freeze({ version: 1, status: transaction.status, signature });
    }
    const expectedInstruction = compiled.envelope.instruction;
    const expectedAccounts = expectedInstruction.keys.map((account) => account.pubkey.toBase58());
    const matches = transaction.instructions.filter((instruction) =>
      instruction.programId === expectedInstruction.programId.toBase58()
      && sameAddresses(instruction.accounts, expectedAccounts)
      && bytesEqual(instruction.data, expectedInstruction.data));
    requireCondition(matches.length === 1, 'transaction does not contain the exact prepared strategy instruction');
    const [account] = await lane.reader.getAccounts(
      [compiled.envelope.receipt.toBase58()],
      transaction.slot,
    );
    requireCondition(account !== null && account !== undefined, 'strategy receipt account is absent');
    requireCondition(account.owner === expectedInstruction.programId.toBase58(), 'strategy receipt owner is invalid');
    const receipt = decodeSolanaMultiStrategyReceipt(account.data);
    requireCondition(bytesEqual(receipt.packageId, prepared.identity.packageId)
      && bytesEqual(receipt.orderHash, prepared.orderHash)
      && bytesEqual(receipt.graphHash, prepared.graphHash)
      && bytesEqual(receipt.quoteHash, prepared.quoteHash)
      && bytesEqual(receipt.routeHash, prepared.routeHash)
      && receipt.operation === prepared.identity.operation
      && bytesEqual(receipt.nextStateHash, prepared.identity.nextStateHash)
      && bytesEqual(receipt.callsHash, compiled.envelope.callsHash)
      && receipt.solver.toBase58() === lane.solver,
    'stored receipt differs from the prepared strategy execution');
    requireCondition(receipt.executionSlot === transaction.slot, 'receipt execution slot differs from the transaction');
    const expectedReceiptHash = solanaMultiStrategyReceiptHash({
      executionHash: compiled.envelope.executionHash,
      callsHash: compiled.envelope.callsHash,
      evidenceRoot: receipt.evidenceRoot,
    });
    requireCondition(bytesEqual(receipt.receiptHash, expectedReceiptHash), 'stored receipt hash is invalid');
    requireCondition(compiled.legIds.length === documents.graph.legs.length,
      'prepared execution leg attribution is incomplete');
    const orderedEvidence: Array<Uint8Array | undefined> = Array(compiled.legIds.length).fill(undefined);
    for (const data of programData(transaction.logMessages, expectedInstruction.programId.toBase58())) {
      const event = decodeSolanaStrategyAdapterLegEvent(data);
      if (event === undefined) continue;
      requireCondition(event.receipt.equals(compiled.envelope.receipt),
        'adapter evidence names another receipt');
      requireCondition(event.callIndex < compiled.legIds.length,
        'adapter evidence call index is invalid');
      requireCondition(orderedEvidence[event.callIndex] === undefined,
        'adapter evidence call appears more than once');
      orderedEvidence[event.callIndex] = event.evidenceHash;
    }
    requireCondition(orderedEvidence.every((value) => value !== undefined),
      'adapter evidence sequence is incomplete');
    const completeEvidence = orderedEvidence.map((value) => value!);
    requireCondition(bytesEqual(solanaMultiStrategyEvidenceRoot(completeEvidence), receipt.evidenceRoot),
      'adapter evidence does not match the stored evidence root');
    const evidenceByLeg = new Map<string, Uint8Array>();
    for (const [index, evidenceHash] of completeEvidence.entries()) {
      const legId = compiled.legIds[index]!;
      requireCondition(!evidenceByLeg.has(legId), 'prepared execution leg appears more than once');
      evidenceByLeg.set(legId, evidenceHash);
    }
    const canonical = canonicalReceipt(
      documents,
      evidenceByLeg,
      await lane.reader.getBlockTime(transaction.slot),
      receipt.nonce + 1n,
    );
    return Object.freeze({
      version: 1,
      status: 'FINALIZED',
      signature,
      domain: compiled.domain,
      slot: transaction.slot,
      strategyAccount: compiled.envelope.strategyAccount.toBase58(),
      position: compiled.envelope.position.toBase58(),
      receiptAccount: compiled.envelope.receipt.toBase58(),
      packageId: hex(receipt.packageId),
      orderHash: hex(receipt.orderHash),
      graphHash: hex(receipt.graphHash),
      quoteHash: hex(receipt.quoteHash),
      routeHash: hex(receipt.routeHash),
      operation: receipt.operation,
      previousStateHash: hex(receipt.previousStateHash),
      nextStateHash: hex(receipt.nextStateHash),
      callsHash: hex(receipt.callsHash),
      evidenceRoot: hex(receipt.evidenceRoot),
      onchainReceiptHash: hex(receipt.receiptHash),
      solver: receipt.solver.toBase58(),
      nonce: receipt.nonce,
      receipt: canonical,
    });
  }
}
