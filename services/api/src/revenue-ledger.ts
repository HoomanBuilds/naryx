import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  assetRef,
  packageReceipt,
  packageReceiptHash,
  parseProtocolJson,
  protocolId,
  stringifyProtocolJson,
  toHex,
  type AssetRef,
  type PackageReceiptInput,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";

export const REVENUE_CLAIM_CATEGORY = Object.freeze({
  PROTOCOL_FEE: 1,
  SOLVER_FEE: 2,
  BUILDER_FEE: 3,
  BUILDER_REBATE: 4,
  RECOVERY_REFUND: 5,
  MINIMUM_TOP_UP: 6,
  PARTNER_SHARE: 7,
} as const);
export type RevenueClaimCategory = keyof typeof REVENUE_CLAIM_CATEGORY;

export const REVENUE_SETTLEMENT_CHANNEL = Object.freeze({
  ONCHAIN_TRANSFER: 1,
  BUILDER_INSTRUCTION: 2,
  INVOICE_PAYMENT: 3,
  OFFCHAIN_PAYMENT: 4,
  REFUND: 5,
} as const);
export type RevenueSettlementChannel = keyof typeof REVENUE_SETTLEMENT_CHANNEL;

export class RevenueLedgerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RevenueLedgerError";
    this.code = code;
  }
}

export interface RevenueClaim {
  readonly claimId: string;
  readonly sourceType: "PACKAGE_RECEIPT" | "MONTHLY_MINIMUM" | "PARTNER_SHARE";
  readonly sourceId: string;
  readonly category: RevenueClaimCategory;
  readonly debtorId: string;
  readonly creditorId: string;
  readonly asset: AssetRef;
  readonly atoms: bigint;
  readonly occurredAtMs: number;
  readonly parentClaimId?: string;
}

export interface RevenueSettlementInput {
  readonly settlementId: string;
  readonly claimId: string;
  readonly channel: RevenueSettlementChannel;
  readonly atoms: bigint;
  readonly occurredAtMs: number;
  readonly externalReference: string;
}

export interface RevenueSettlement extends RevenueSettlementInput {
  readonly asset: AssetRef;
}

export interface RevenueClaimView extends RevenueClaim {
  readonly settledAtoms: bigint;
  readonly outstandingAtoms: bigint;
}

export interface RevenuePartyBalance {
  readonly asset: AssetRef;
  readonly dueToPartyAtoms: bigint;
  readonly owedByPartyAtoms: bigint;
  readonly settledToPartyAtoms: bigint;
  readonly settledByPartyAtoms: bigint;
  readonly outstandingToPartyAtoms: bigint;
  readonly outstandingByPartyAtoms: bigint;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS revenue_claims (
  claim_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  category TEXT NOT NULL,
  debtor_id TEXT NOT NULL,
  creditor_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_json TEXT NOT NULL,
  atoms TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  parent_claim_id TEXT REFERENCES revenue_claims(claim_id),
  claim_json TEXT NOT NULL,
  UNIQUE (source_type, source_id, category, debtor_id, creditor_id, asset_id)
) STRICT;
CREATE INDEX IF NOT EXISTS revenue_claims_by_debtor ON revenue_claims(debtor_id, occurred_at_ms);
CREATE INDEX IF NOT EXISTS revenue_claims_by_creditor ON revenue_claims(creditor_id, occurred_at_ms);
CREATE TABLE IF NOT EXISTS revenue_settlements (
  settlement_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES revenue_claims(claim_id),
  channel TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  atoms TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  external_reference TEXT NOT NULL,
  settlement_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS revenue_settlements_by_claim ON revenue_settlements(claim_id, occurred_at_ms);
CREATE TRIGGER IF NOT EXISTS reject_revenue_claim_change BEFORE UPDATE ON revenue_claims BEGIN SELECT RAISE(ABORT, 'revenue claims are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_revenue_claim_delete BEFORE DELETE ON revenue_claims BEGIN SELECT RAISE(ABORT, 'revenue claims are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_revenue_settlement_change BEFORE UPDATE ON revenue_settlements BEGIN SELECT RAISE(ABORT, 'revenue settlements are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_revenue_settlement_delete BEFORE DELETE ON revenue_settlements BEGIN SELECT RAISE(ABORT, 'revenue settlements are append-only'); END;
`;

function nonempty(value: string, field: string, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !/^[\x21-\x7e]+$/.test(value)) {
    throw new RevenueLedgerError("INVALID_INPUT", `${field} must be nonempty printable ASCII without spaces.`);
  }
  return value;
}

function atoms(value: bigint, field: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value >= 1n << 128n) {
    throw new RevenueLedgerError("INVALID_INPUT", `${field} must be a positive u128 amount.`);
  }
  return value;
}

function timestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RevenueLedgerError("INVALID_INPUT", `${field} must be a nonnegative millisecond timestamp.`);
  return value;
}

function category(value: RevenueClaimCategory): RevenueClaimCategory {
  if (!Object.hasOwn(REVENUE_CLAIM_CATEGORY, value)) throw new RevenueLedgerError("INVALID_INPUT", "Revenue claim category is unknown.");
  return value;
}

function channel(value: RevenueSettlementChannel): RevenueSettlementChannel {
  if (!Object.hasOwn(REVENUE_SETTLEMENT_CHANNEL, value)) throw new RevenueLedgerError("INVALID_INPUT", "Revenue settlement channel is unknown.");
  return value;
}

function checkedAsset(value: AssetRef, field: string): AssetRef {
  try {
    return assetRef(value.assetId, value.assetManifestHash, value.decimals, field);
  } catch (error) {
    throw new RevenueLedgerError("INVALID_INPUT", `${field} is invalid: ${(error as Error).message}`);
  }
}

function claimId(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

function sameClaim(left: RevenueClaim, right: RevenueClaim): boolean {
  return stringifyProtocolJson(left) === stringifyProtocolJson(right);
}

function sameSettlement(left: RevenueSettlement, right: RevenueSettlement): boolean {
  return stringifyProtocolJson(left) === stringifyProtocolJson(right);
}

function parseClaim(json: string): RevenueClaim {
  return parseProtocolJson(json) as unknown as RevenueClaim;
}

function parseSettlement(json: string): RevenueSettlement {
  return parseProtocolJson(json) as unknown as RevenueSettlement;
}

export class SqliteRevenueLedger {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new RevenueLedgerError(code, message));
  }

  close(): void {
    this.db.close();
  }

  private checkedClaim(input: RevenueClaim): RevenueClaim {
    const checked: RevenueClaim = Object.freeze({
      claimId: nonempty(input.claimId, "claimId", 64),
      sourceType: input.sourceType,
      sourceId: nonempty(input.sourceId, "sourceId"),
      category: category(input.category),
      debtorId: protocolId(input.debtorId, "debtorId"),
      creditorId: protocolId(input.creditorId, "creditorId"),
      asset: checkedAsset(input.asset, "asset"),
      atoms: atoms(input.atoms, "atoms"),
      occurredAtMs: timestamp(input.occurredAtMs, "occurredAtMs"),
      ...(input.parentClaimId === undefined ? {} : { parentClaimId: nonempty(input.parentClaimId, "parentClaimId", 64) }),
    });
    if (!["PACKAGE_RECEIPT", "MONTHLY_MINIMUM", "PARTNER_SHARE"].includes(checked.sourceType)) {
      throw new RevenueLedgerError("INVALID_INPUT", "Revenue claim source type is unknown.");
    }
    if (checked.debtorId === checked.creditorId) throw new RevenueLedgerError("INVALID_INPUT", "A party cannot owe itself.");
    return checked;
  }

  private insertClaim(input: RevenueClaim): { readonly claim: RevenueClaim; readonly replayed: boolean } {
    const claim = this.checkedClaim(input);
    const existing = this.db.prepare("SELECT claim_json FROM revenue_claims WHERE claim_id = ?").get(claim.claimId) as { claim_json: string } | undefined;
    if (existing !== undefined) {
      const known = parseClaim(existing.claim_json);
      if (!sameClaim(known, claim)) throw new RevenueLedgerError("CLAIM_CONFLICT", "This claim id already names different economics.");
      return { claim: known, replayed: true };
    }
    try {
      this.db.prepare(
        `INSERT INTO revenue_claims
          (claim_id, source_type, source_id, category, debtor_id, creditor_id, asset_id, asset_json, atoms, occurred_at_ms, parent_claim_id, claim_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        claim.claimId,
        claim.sourceType,
        claim.sourceId,
        claim.category,
        claim.debtorId,
        claim.creditorId,
        claim.asset.assetId,
        stringifyProtocolJson(claim.asset),
        claim.atoms.toString(),
        claim.occurredAtMs,
        claim.parentClaimId ?? null,
        stringifyProtocolJson(claim),
      );
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new RevenueLedgerError("DUPLICATE_CHANNEL", "The same source, category, parties, and asset were already claimed through another id.");
      }
      throw error;
    }
    return { claim, replayed: false };
  }

  /**
   * Materializes economic claims from one successful receipt. A receipt establishes obligations;
   * it does not prove that any transfer, builder instruction, or invoice payment was collected.
   */
  recordReceipt(input: {
    readonly receipt: PackageReceiptInput;
    readonly protocolRecipientId: string;
    readonly builderRecipientId?: string;
    readonly recoveryRefundDebtorId?: string;
    readonly occurredAtMs: number;
  }): readonly RevenueClaim[] {
    const receipt = packageReceipt(input.receipt);
    const receiptHashHex = toHex(packageReceiptHash(receipt));
    const protocolRecipientId = protocolId(input.protocolRecipientId, "protocolRecipientId");
    const occurredAtMs = timestamp(input.occurredAtMs, "occurredAtMs");
    const builderRecipientId = input.builderRecipientId === undefined ? undefined : protocolId(input.builderRecipientId, "builderRecipientId");
    const recoveryRefundDebtorId = protocolId(input.recoveryRefundDebtorId ?? receipt.solver, "recoveryRefundDebtorId");
    const claims: RevenueClaim[] = [];
    const add = (categoryValue: RevenueClaimCategory, debtorId: string, creditorId: string, asset: AssetRef, amount: bigint, suffix: string) => {
      if (amount === 0n) return;
      claims.push({
        claimId: claimId(["PACKAGE_RECEIPT", receiptHashHex, categoryValue, suffix]),
        sourceType: "PACKAGE_RECEIPT",
        sourceId: receiptHashHex,
        category: categoryValue,
        debtorId,
        creditorId,
        asset,
        atoms: amount,
        occurredAtMs,
      });
    };
    add("PROTOCOL_FEE", receipt.owner, protocolRecipientId, receipt.protocolFee.asset, receipt.protocolFee.atoms, "protocol");
    add("SOLVER_FEE", receipt.owner, receipt.solver, receipt.solverFee.asset, receipt.solverFee.atoms, "solver");
    for (const [index, fee] of receipt.builderFeesByAsset.entries()) {
      if (fee.atoms !== 0n && builderRecipientId === undefined) {
        throw new RevenueLedgerError("BUILDER_RECIPIENT_REQUIRED", "A nonzero builder fee or rebate needs its attributed builder recipient.");
      }
      if (fee.atoms > 0n) add("BUILDER_FEE", receipt.owner, builderRecipientId as string, fee.asset, fee.atoms, `builder:${index}`);
      if (fee.atoms < 0n) add("BUILDER_REBATE", builderRecipientId as string, receipt.owner, fee.asset, -fee.atoms, `builder:${index}`);
    }
    for (const [index, refund] of receipt.recoveryRefundByAsset.entries()) {
      add("RECOVERY_REFUND", recoveryRefundDebtorId, receipt.owner, refund.asset, refund.atoms, `recovery:${index}`);
    }
    return this.db.transaction(() => Object.freeze(claims.map((claim) => this.insertClaim(claim).claim))).immediate();
  }

  recordMinimumTopUp(input: {
    readonly invoiceId: string;
    readonly customerId: string;
    readonly protocolRecipientId: string;
    readonly asset: AssetRef;
    readonly atoms: bigint;
    readonly occurredAtMs: number;
  }): { readonly claim: RevenueClaim; readonly replayed: boolean } {
    const invoiceId = nonempty(input.invoiceId, "invoiceId");
    return this.db.transaction(() => this.insertClaim({
      claimId: claimId(["MONTHLY_MINIMUM", invoiceId]),
      sourceType: "MONTHLY_MINIMUM",
      sourceId: invoiceId,
      category: "MINIMUM_TOP_UP",
      debtorId: input.customerId,
      creditorId: input.protocolRecipientId,
      asset: input.asset,
      atoms: input.atoms,
      occurredAtMs: input.occurredAtMs,
    })).immediate();
  }

  recordPartnerShare(input: {
    readonly shareId: string;
    readonly protocolClaimId: string;
    readonly protocolRecipientId: string;
    readonly partnerId: string;
    readonly atoms: bigint;
    readonly occurredAtMs: number;
  }): { readonly claim: RevenueClaim; readonly replayed: boolean } {
    const parent = this.claim(input.protocolClaimId);
    if (parent === undefined || (parent.category !== "PROTOCOL_FEE" && parent.category !== "MINIMUM_TOP_UP")) {
      throw new RevenueLedgerError("PARENT_NOT_FOUND", "A partner share must name a protocol fee or minimum top-up claim.");
    }
    const protocolRecipientId = protocolId(input.protocolRecipientId, "protocolRecipientId");
    if (parent.creditorId !== protocolRecipientId) throw new RevenueLedgerError("PARENT_MISMATCH", "The protocol recipient does not own the parent claim.");
    const shareId = nonempty(input.shareId, "shareId");
    const amount = atoms(input.atoms, "atoms");
    return this.db.transaction(() => {
      const existingShares = this.db.prepare("SELECT atoms FROM revenue_claims WHERE parent_claim_id = ?").all(parent.claimId) as { atoms: string }[];
      const allocated = existingShares.reduce((sum, row) => sum + BigInt(row.atoms), 0n);
      const id = claimId(["PARTNER_SHARE", shareId]);
      const existing = this.claim(id);
      if (existing === undefined && allocated + amount > parent.atoms) {
        throw new RevenueLedgerError("SHARE_EXCEEDS_PARENT", "Partner shares exceed the protocol claim.");
      }
      return this.insertClaim({
        claimId: id,
        sourceType: "PARTNER_SHARE",
        sourceId: shareId,
        category: "PARTNER_SHARE",
        debtorId: protocolRecipientId,
        creditorId: input.partnerId,
        asset: parent.asset,
        atoms: amount,
        occurredAtMs: input.occurredAtMs,
        parentClaimId: parent.claimId,
      });
    }).immediate();
  }

  recordSettlement(input: RevenueSettlementInput): { readonly settlement: RevenueSettlement; readonly replayed: boolean } {
    const settlementId = nonempty(input.settlementId, "settlementId");
    const claim = this.claim(nonempty(input.claimId, "claimId", 64));
    if (claim === undefined) throw new RevenueLedgerError("CLAIM_NOT_FOUND", "The settlement names no revenue claim.");
    const settlement: RevenueSettlement = Object.freeze({
      settlementId,
      claimId: claim.claimId,
      channel: channel(input.channel),
      atoms: atoms(input.atoms, "atoms"),
      occurredAtMs: timestamp(input.occurredAtMs, "occurredAtMs"),
      externalReference: nonempty(input.externalReference, "externalReference"),
      asset: claim.asset,
    });
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT settlement_json FROM revenue_settlements WHERE settlement_id = ?").get(settlementId) as { settlement_json: string } | undefined;
      if (existing !== undefined) {
        const known = parseSettlement(existing.settlement_json);
        if (!sameSettlement(known, settlement)) throw new RevenueLedgerError("SETTLEMENT_CONFLICT", "This settlement id already names another payment.");
        return { settlement: known, replayed: true };
      }
      const settled = this.settledAtoms(claim.claimId);
      if (settled + settlement.atoms > claim.atoms) throw new RevenueLedgerError("OVERSETTLEMENT", "The claim is already settled up to a smaller remaining amount.");
      this.db.prepare(
        `INSERT INTO revenue_settlements
          (settlement_id, claim_id, channel, asset_id, atoms, occurred_at_ms, external_reference, settlement_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        settlement.settlementId,
        settlement.claimId,
        settlement.channel,
        settlement.asset.assetId,
        settlement.atoms.toString(),
        settlement.occurredAtMs,
        settlement.externalReference,
        stringifyProtocolJson(settlement),
      );
      return { settlement, replayed: false };
    }).immediate();
  }

  claim(id: string): RevenueClaim | undefined {
    const row = this.db.prepare("SELECT claim_json FROM revenue_claims WHERE claim_id = ?").get(id) as { claim_json: string } | undefined;
    return row === undefined ? undefined : parseClaim(row.claim_json);
  }

  private settledAtoms(id: string): bigint {
    const rows = this.db.prepare("SELECT atoms FROM revenue_settlements WHERE claim_id = ?").all(id) as { atoms: string }[];
    return rows.reduce((sum, row) => sum + BigInt(row.atoms), 0n);
  }

  claimView(id: string): RevenueClaimView | undefined {
    const claim = this.claim(id);
    if (claim === undefined) return undefined;
    const settledAtoms = this.settledAtoms(id);
    return Object.freeze({ ...claim, settledAtoms, outstandingAtoms: claim.atoms - settledAtoms });
  }

  partyBalances(partyIdInput: string): readonly RevenuePartyBalance[] {
    const partyId = protocolId(partyIdInput, "partyId");
    const rows = this.db.prepare("SELECT claim_json FROM revenue_claims WHERE debtor_id = ? OR creditor_id = ? ORDER BY occurred_at_ms, claim_id").all(partyId, partyId) as { claim_json: string }[];
    const totals = new Map<string, RevenuePartyBalance>();
    for (const row of rows) {
      const claim = parseClaim(row.claim_json);
      const settled = this.settledAtoms(claim.claimId);
      const key = `${claim.asset.assetId}:${toHex(claim.asset.assetManifestHash)}`;
      const current = totals.get(key) ?? {
        asset: claim.asset,
        dueToPartyAtoms: 0n,
        owedByPartyAtoms: 0n,
        settledToPartyAtoms: 0n,
        settledByPartyAtoms: 0n,
        outstandingToPartyAtoms: 0n,
        outstandingByPartyAtoms: 0n,
      };
      totals.set(key, claim.creditorId === partyId
        ? {
            ...current,
            dueToPartyAtoms: current.dueToPartyAtoms + claim.atoms,
            settledToPartyAtoms: current.settledToPartyAtoms + settled,
            outstandingToPartyAtoms: current.outstandingToPartyAtoms + claim.atoms - settled,
          }
        : {
            ...current,
            owedByPartyAtoms: current.owedByPartyAtoms + claim.atoms,
            settledByPartyAtoms: current.settledByPartyAtoms + settled,
            outstandingByPartyAtoms: current.outstandingByPartyAtoms + claim.atoms - settled,
          });
    }
    return Object.freeze([...totals.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, value]) => Object.freeze(value)));
  }
}
