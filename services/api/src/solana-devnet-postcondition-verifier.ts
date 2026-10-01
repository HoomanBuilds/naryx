import { createHash } from "node:crypto";
import {
  decodeCashCarryExecutionReceipt,
  decodeOpenCashCarryPackage,
} from "@naryx/adapter-solana";
import type {
  DecodedCashCarryExecutionReceipt,
  DecodedOpenCashCarryPackage,
} from "@naryx/adapter-solana";
import type {
  PreparedSolanaDevnetRecord,
  SolanaDevnetPostconditionProof,
  SolanaDevnetPostconditionVerifier,
  SolanaReadOnlyAccountSnapshot,
} from "./solana-devnet-runtime-ports.js";
import { SOLANA_DEVNET_GENESIS_HASH } from "./terminal-execution.js";
import { decodeTestPerpPosition } from "./solana-devnet-test-perp.js";

type SolanaCoreIdl = Parameters<typeof decodeCashCarryExecutionReceipt>[0];

export interface SolanaDevnetPostconditionRpc {
  getGenesisHash(): Promise<string>;
  getMultipleAccounts(addresses: readonly string[], minContextSlot: number): Promise<SolanaReadOnlyAccountSnapshot>;
}

export type SolanaDevnetPostconditionVerifierOptions = Readonly<{
  rpc: SolanaDevnetPostconditionRpc;
  coreIdl: SolanaCoreIdl;
}>;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireEqual(actual: string | bigint | number | boolean, expected: string | bigint | number | boolean, name: string): void {
  if (actual !== expected) throw new Error(`Solana postcondition ${name} mismatch.`);
}

function requireNonzero(value: Uint8Array, name: string): void {
  if (value.length !== 32 || value.every((byte) => byte === 0)) throw new Error(`Solana postcondition ${name} is invalid.`);
}

function verifyDomain(record: PreparedSolanaDevnetRecord, receipt: DecodedCashCarryExecutionReceipt): void {
  const expected = record.lifecycleBinding.domain;
  requireEqual(receipt.domain.domainId, expected.domainId, "domain id");
  requireEqual(receipt.domain.domainManifestVersion, expected.domainManifestVersion, "domain version");
  requireEqual(hex(receipt.domain.domainManifestHash), hex(expected.domainManifestHash), "domain hash");
}

function verifyReceipt(record: PreparedSolanaDevnetRecord, receipt: DecodedCashCarryExecutionReceipt, finalizedSlot: number): void {
  const expected = record.postconditionBinding;
  if (expected === undefined) throw new Error("Solana postcondition binding is missing.");
  verifyDomain(record, receipt);
  requireEqual(hex(receipt.orderHash), expected.orderHashHex, "order hash");
  requireEqual(hex(receipt.quoteHash), expected.quoteHashHex, "quote hash");
  requireEqual(hex(receipt.routeHash), expected.routeHashHex, "route hash");
  requireEqual(receipt.trader, expected.trader, "trader");
  requireEqual(receipt.solver, expected.solver, "solver");
  requireEqual(receipt.nonce, expected.nonce, "nonce");
  requireEqual(receipt.spotQuantityAtoms, expected.spotQuantityAtoms, "spot quantity");
  requireEqual(receipt.perpQuantityAtoms, expected.perpQuantityAtoms, "perp quantity");
  requireEqual(hex(receipt.resourceAdmissionCommitment), expected.resourceAdmissionCommitmentHex, "resource admission commitment");
  requireEqual(hex(receipt.packageFillCommitment), expected.packageFillCommitmentHex, "package fill commitment");
  requireEqual(receipt.entryReceipt, expected.entryReceiptAccount, "entry receipt");
  requireEqual(receipt.recovery, expected.recovery, "recovery flag");
  requireEqual(receipt.action, record.lifecycleBinding.action === "ENTRY" ? 1 : 2, "action");
  requireNonzero(receipt.executionDigest, "execution digest");
  if (receipt.executionSlot > BigInt(finalizedSlot)) throw new Error("Solana postcondition execution slot exceeds the finalized slot.");
}

function verifyOpenPackage(record: PreparedSolanaDevnetRecord, receipt: DecodedCashCarryExecutionReceipt, open: DecodedOpenCashCarryPackage): void {
  const expected = record.postconditionBinding;
  if (expected === undefined) throw new Error("Solana postcondition binding is missing.");
  requireEqual(open.version, 2, "open package version");
  requireEqual(open.domain.domainId, receipt.domain.domainId, "open package domain id");
  requireEqual(open.domain.domainManifestVersion, receipt.domain.domainManifestVersion, "open package domain version");
  requireEqual(hex(open.domain.domainManifestHash), hex(receipt.domain.domainManifestHash), "open package domain hash");
  requireEqual(open.trader, expected.trader, "open package trader");
  requireEqual(open.entryReceipt, expected.receiptAccount, "open package entry receipt");
  requireEqual(hex(open.entryRouteHash), expected.routeHashHex, "open package route hash");
  requireEqual(hex(open.quoteIntentCommitment), hex(receipt.quoteIntentCommitment), "open package quote intent");
  requireEqual(hex(open.packageFillCommitment), hex(receipt.packageFillCommitment), "open package fill commitment");
  requireEqual(hex(open.entryResourceAdmissionCommitment), hex(receipt.resourceAdmissionCommitment), "open package resource admission");
  requireEqual(hex(open.entryRouteAccountsCommitment), hex(receipt.routeAccountsCommitment), "open package route accounts");
  requireEqual(open.spotQuantityAtoms, expected.spotQuantityAtoms, "open package spot quantity");
  requireEqual(open.perpQuantityAtoms, expected.perpQuantityAtoms, "open package perp quantity");
  requireNonzero(open.economicPackageCommitment, "economic package commitment");
  requireNonzero(open.packageAccountsCommitment, "package accounts commitment");
  const committed = expected.expectedOpenPackage;
  if (committed !== undefined) {
    requireEqual(hex(open.quoteIntentCommitment), committed.quoteIntentCommitmentHex, "expected quote intent commitment");
    requireEqual(hex(open.entryRouteAccountsCommitment), committed.routeAccountsCommitmentHex, "expected route accounts commitment");
    requireEqual(hex(open.economicPackageCommitment), committed.economicPackageCommitmentHex, "expected economic package commitment");
    requireEqual(hex(open.packageAccountsCommitment), committed.packageAccountsCommitmentHex, "expected package accounts commitment");
  }
}

/** The trader's own test perp position: exact market, owner, strategy delegate, and resulting short. */
function verifyTestPerpPosition(record: PreparedSolanaDevnetRecord, account: { owner: string; data: Uint8Array } | null | undefined): string | null {
  const expected = record.postconditionBinding?.testPerpPosition;
  if (expected === undefined) return null;
  if (account === null || account === undefined || account.owner !== expected.venueProgram) {
    throw new Error("Solana postcondition test perp position is absent or has wrong owner.");
  }
  const position = decodeTestPerpPosition(account.data);
  requireEqual(position.market, expected.market, "test perp market");
  requireEqual(position.owner, expected.owner, "test perp position owner");
  requireEqual(position.delegate, expected.delegate, "test perp position delegate");
  requireEqual(position.baseLots, BigInt(expected.expectedBaseLots), "test perp position size");
  return hash(account.data);
}

export class ReadOnlySolanaDevnetPostconditionVerifier implements SolanaDevnetPostconditionVerifier {
  readonly #rpc: SolanaDevnetPostconditionRpc;
  readonly #coreIdl: SolanaCoreIdl;

  constructor(options: SolanaDevnetPostconditionVerifierOptions) {
    if (typeof options.rpc?.getGenesisHash !== "function" || typeof options.rpc?.getMultipleAccounts !== "function") {
      throw new Error("Solana postcondition verifier requires read-only RPC methods.");
    }
    this.#rpc = options.rpc;
    this.#coreIdl = options.coreIdl;
  }

  async verify(record: PreparedSolanaDevnetRecord, finalizedSlot: number): Promise<SolanaDevnetPostconditionProof> {
    if (!Number.isSafeInteger(finalizedSlot) || finalizedSlot < 0) throw new Error("Solana postcondition finalized slot is invalid.");
    if (await this.#rpc.getGenesisHash() !== SOLANA_DEVNET_GENESIS_HASH) throw new Error("Solana postcondition RPC is not Devnet.");
    const expected = record.postconditionBinding;
    if (expected === undefined) throw new Error("Solana postcondition binding is missing.");
    const addresses = [expected.receiptAccount, expected.openPackageAccount];
    if (expected.testPerpPosition !== undefined) addresses.push(expected.testPerpPosition.position);
    const snapshot = await this.#rpc.getMultipleAccounts(addresses, finalizedSlot);
    const receiptAccount = snapshot.accounts[0];
    const openAccount = snapshot.accounts[1];
    if (receiptAccount === null || receiptAccount === undefined || receiptAccount.owner !== expected.coreProgram) {
      throw new Error("Solana postcondition receipt account is absent or has wrong owner.");
    }
    const receipt = decodeCashCarryExecutionReceipt(this.#coreIdl, receiptAccount.data);
    verifyReceipt(record, receipt, finalizedSlot);
    if (record.lifecycleBinding.action === "ENTRY") {
      if (openAccount === null || openAccount === undefined || openAccount.owner !== expected.coreProgram) {
        throw new Error("Solana entry postcondition open package is absent or has wrong owner.");
      }
      verifyOpenPackage(record, receipt, decodeOpenCashCarryPackage(this.#coreIdl, openAccount.data));
    } else if (openAccount !== null) {
      throw new Error("Solana exit postcondition open package still exists.");
    }
    verifyTestPerpPosition(record, snapshot.accounts[2]);
    return Object.freeze({
      action: record.lifecycleBinding.action,
      finalizedSlot,
      accountContextSlot: snapshot.contextSlot,
      receiptDataHashHex: hash(receiptAccount.data),
      openPackageDataHashHex: openAccount === null ? null : hash(openAccount.data),
    });
  }
}
