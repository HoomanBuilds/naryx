import { createHash } from "node:crypto";
import {
  assetRef,
  BOND_FAULT,
  disputeBondClaim,
  fileBondClaim,
  openPerformanceBond,
  releasePerformanceBond,
  settleBondClaim,
  toHex,
  type BondClaimState,
  type BondFault,
  type PerformanceBondLedger,
} from "@naryx/protocol-types";
import { EVIDENCE_GRADE, type EvidenceGrade, type Finality } from "./package-record.js";

/** keccak256("BondOpened(bytes32,address,address,uint256,uint8,uint256,uint64,uint64)") */
export const BOND_OPENED_TOPIC = "0xd83325ddf6daf22e8aee23d38f8c1bd39c857c531c1c48d3b8a5fdec6e8fbb3a";
/** keccak256("ClaimFiled(bytes32,bytes32,uint8,uint256,address)") */
export const CLAIM_FILED_TOPIC = "0xb3e5f1728b0352602e9ac673d0cc840bfefae8d24482c25166086a27986aa703";
/** keccak256("ClaimDisputed(bytes32,bytes32)") */
export const CLAIM_DISPUTED_TOPIC = "0x04470c22207528df9ed0cf1643851939581563dc13e003d41914a052c52f55f1";
/** keccak256("ClaimResolved(bytes32,bytes32,bool)") */
export const CLAIM_RESOLVED_TOPIC = "0x01774ad384b2c36083abc97d4ee505148bdb0fa271a8e78576c2662bc6f5f459";
/** keccak256("ClaimPaid(bytes32,bytes32,address,uint256)") */
export const CLAIM_PAID_TOPIC = "0x92794310b3d8169569d8698cc56272d17fba1251c19ae0aed19363741a3bd3f8";
/** keccak256("BondReleased(bytes32,address,uint256)") */
export const BOND_RELEASED_TOPIC = "0x9623c6ff501754597055f382769436c3175bd84a326e54017b43b355dcdffcbc";

export const BOND_VAULT_TOPICS = Object.freeze([
  BOND_OPENED_TOPIC,
  CLAIM_FILED_TOPIC,
  CLAIM_DISPUTED_TOPIC,
  CLAIM_RESOLVED_TOPIC,
  CLAIM_PAID_TOPIC,
  BOND_RELEASED_TOPIC,
]);

export type BondEventType = "BOND_OPENED" | "CLAIM_FILED" | "CLAIM_DISPUTED" | "CLAIM_RESOLVED" | "CLAIM_PAID" | "BOND_RELEASED";

/** One decoded vault log. Amounts are decimal strings; `atValue` is the block timestamp. */
export interface ObservedBondEvent {
  readonly locator: string;
  readonly vault: string;
  readonly bondIdHex: string;
  readonly type: BondEventType;
  readonly atValue: string;
  readonly evidenceGrade: EvidenceGrade;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SPECS: Readonly<Record<string, { type: BondEventType; topics: number; words: number }>> = {
  [BOND_OPENED_TOPIC]: { type: "BOND_OPENED", topics: 4, words: 5 },
  [CLAIM_FILED_TOPIC]: { type: "CLAIM_FILED", topics: 3, words: 3 },
  [CLAIM_DISPUTED_TOPIC]: { type: "CLAIM_DISPUTED", topics: 3, words: 0 },
  [CLAIM_RESOLVED_TOPIC]: { type: "CLAIM_RESOLVED", topics: 3, words: 1 },
  [CLAIM_PAID_TOPIC]: { type: "CLAIM_PAID", topics: 4, words: 1 },
  [BOND_RELEASED_TOPIC]: { type: "BOND_RELEASED", topics: 3, words: 1 },
};

function uint(word: string, bits: number, context: string): bigint {
  const value = BigInt(`0x${word}`);
  if (value >= 1n << BigInt(bits)) throw new Error(`${context} is not a uint${bits}`);
  return value;
}

function address(word: string, context: string): string {
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) throw new Error(`${context} is not an address`);
  return `0x${word.slice(24)}`;
}

/** Decodes one PerformanceBondVault log, checking every word against its declared width. */
export function decodeBondVaultLog(
  log: { readonly address: string; readonly topics: readonly string[]; readonly data: string; readonly transactionHash: string; readonly logIndex: string },
  atValue: number,
  evidenceGrade: EvidenceGrade,
): ObservedBondEvent {
  const topics = log.topics.map((topic) => topic.toLowerCase());
  const data = log.data.toLowerCase();
  const spec = SPECS[topics[0] ?? ""];
  if (spec === undefined) throw new Error("not a bond vault log");
  if (topics.length !== spec.topics || !topics.every((topic) => HEX32.test(topic))) throw new Error(`${spec.type} carries ${spec.topics} topics`);
  if (!/^0x([0-9a-f]{64})*$/.test(data) || (data.length - 2) / 64 !== spec.words) throw new Error(`${spec.type} data has the wrong length`);
  const vault = log.address.toLowerCase();
  const transactionHash = log.transactionHash.toLowerCase();
  if (!ADDRESS.test(vault) || !HEX32.test(transactionHash) || !/^0x(0|[1-9a-f][0-9a-f]*)$/.test(log.logIndex)) throw new Error("log identity is malformed");
  if (!Number.isSafeInteger(atValue) || atValue < 0) throw new Error("block timestamp is invalid");
  const word = (index: number) => data.slice(2 + index * 64, 2 + (index + 1) * 64);
  const topic = (index: number) => (topics[index] as string).slice(2);
  let fields: Record<string, string | number | boolean>;
  switch (spec.type) {
    case "BOND_OPENED":
      fields = {
        solver: address(topic(2), "solver"),
        asset: address(topic(3), "asset"),
        bondAtoms: uint(word(0), 256, "bondAtoms").toString(),
        coveredFaults: Number(uint(word(1), 8, "coveredFaults")),
        maximumPayoutPerClaim: uint(word(2), 256, "maximumPayoutPerClaim").toString(),
        disputeWindow: uint(word(3), 64, "disputeWindow").toString(),
        expiresAt: uint(word(4), 64, "expiresAt").toString(),
      };
      break;
    case "CLAIM_FILED":
      fields = {
        faultEvidenceHash: topic(2),
        fault: Number(uint(word(0), 8, "fault")),
        payoutAtoms: uint(word(1), 256, "payoutAtoms").toString(),
        beneficiary: address(word(2), "beneficiary"),
      };
      break;
    case "CLAIM_DISPUTED":
      fields = { faultEvidenceHash: topic(2) };
      break;
    case "CLAIM_RESOLVED":
      fields = { faultEvidenceHash: topic(2), disputeUpheld: uint(word(0), 1, "disputeUpheld") === 1n };
      break;
    case "CLAIM_PAID":
      fields = { faultEvidenceHash: topic(2), beneficiary: address(topic(3), "beneficiary"), payoutAtoms: uint(word(0), 256, "payoutAtoms").toString() };
      break;
    case "BOND_RELEASED":
      fields = { solver: address(topic(2), "solver"), returnedAtoms: uint(word(0), 256, "returnedAtoms").toString() };
      break;
  }
  return Object.freeze({
    locator: `${transactionHash}:${Number.parseInt(log.logIndex.slice(2), 16)}`,
    vault,
    bondIdHex: topic(1),
    type: spec.type,
    atValue: String(atValue),
    evidenceGrade,
    fields: Object.freeze(fields),
  });
}

export interface ObservedBondClaim {
  readonly faultEvidenceHash: string;
  readonly fault: BondFault;
  readonly payoutAtoms: string;
  readonly beneficiary: string;
  readonly filedAtValue: string;
  readonly state: BondClaimState;
}

/**
 * A bond as its vault's canonical logs show it, replayed through the kernel's bond rules. Every
 * transition the kernel would refuse, and every emitted amount that differs from the kernel's, is
 * a violation; a bond with any violation is INCONSISTENT and its figures are not to be relied on.
 */
export interface ObservedBond {
  readonly vault: string;
  readonly bondIdHex: string;
  readonly status: "OPEN" | "RELEASED" | "INCONSISTENT";
  readonly solver: string;
  readonly asset: string;
  readonly bondAtoms: string;
  readonly coveredFaults: readonly BondFault[];
  readonly maximumPayoutPerClaim: string;
  readonly disputeWindow: string;
  readonly expiresAt: string;
  readonly paidAtoms: string;
  /** Paid plus still-contestable claims: what the bond can no longer promise again. */
  readonly encumberedAtoms: string;
  readonly returnedAtoms: string | null;
  readonly claims: readonly ObservedBondClaim[];
  readonly lastHeight: number;
  readonly finality: Finality;
  readonly evidenceGrade: EvidenceGrade;
  readonly violations: readonly string[];
}

const FAULT_BY_BIT = new Map<number, BondFault>(Object.entries(BOND_FAULT).map(([name, bit]) => [bit, name as BondFault]));

/**
 * Replays one bond's canonical events, in chain order, through the kernel ledger. The kernel needs
 * an asset reference only to hash the bond, which is never reported here, so the vault's token
 * address stands in for it.
 */
export function replayBondEvents(
  events: readonly (ObservedBondEvent & { readonly height: number })[],
  finality: Finality,
): ObservedBond | undefined {
  const opened = events[0];
  if (opened === undefined) return undefined;
  const violations: string[] = [];
  const beneficiaries = new Map<string, string>();
  let ledger: PerformanceBondLedger | undefined;
  let returnedAtoms: bigint | null = null;
  const terms = opened.type === "BOND_OPENED" ? opened.fields : undefined;
  if (terms === undefined) violations.push(`the first event is ${opened.type}, not BOND_OPENED`);
  else {
    const mask = terms.coveredFaults as number;
    const faults = [...FAULT_BY_BIT.entries()].filter(([bit]) => (mask & (1 << bit)) !== 0).map(([, fault]) => fault);
    if (faults.length === 0 || (mask & ~[...FAULT_BY_BIT.keys()].reduce((sum, bit) => sum | (1 << bit), 0)) !== 0) violations.push("covered faults name no known fault");
    try {
      ledger = openPerformanceBond({
        version: 1,
        bondId: opened.bondIdHex,
        solverId: `evm:${terms.solver as string}`,
        asset: assetRef(`evm:${terms.asset as string}`, createHash("sha256").update(terms.asset as string).digest(), 0),
        bondAtoms: BigInt(terms.bondAtoms as string),
        coveredFaults: faults,
        maximumPayoutPerClaimAtoms: BigInt(terms.maximumPayoutPerClaim as string),
        disputeWindowValue: BigInt(terms.disputeWindow as string),
        expiresAtValue: BigInt(terms.expiresAt as string),
      });
    } catch (error) {
      violations.push(`the bond terms fail the kernel: ${(error as Error).message}`);
    }
  }
  // A dispute resolved against the solver pays in the same transaction, and ClaimPaid confirms it.
  const resolvedUnpaid = new Set<string>();
  for (const event of events.slice(1)) {
    if (ledger === undefined) break;
    const at = BigInt(event.atValue);
    const evidence = event.fields.faultEvidenceHash as string | undefined;
    try {
      switch (event.type) {
        case "BOND_OPENED":
          throw new Error("the bond was opened twice");
        case "CLAIM_FILED": {
          const fault = FAULT_BY_BIT.get(event.fields.fault as number);
          if (fault === undefined) throw new Error(`fault ${String(event.fields.fault)} is unknown`);
          ledger = fileBondClaim(ledger, { faultEvidenceHash: evidence as string, fault, payoutAtoms: BigInt(event.fields.payoutAtoms as string), atValue: at });
          beneficiaries.set(evidence as string, event.fields.beneficiary as string);
          break;
        }
        case "CLAIM_DISPUTED":
          ledger = disputeBondClaim(ledger, evidence as string, at);
          break;
        case "CLAIM_RESOLVED":
          ledger = settleBondClaim(ledger, evidence as string, at, event.fields.disputeUpheld as boolean);
          if (event.fields.disputeUpheld === false) resolvedUnpaid.add(evidence as string);
          break;
        case "CLAIM_PAID": {
          const claim = ledger.claims.find((entry) => toHex(entry.faultEvidenceHash) === evidence);
          if (resolvedUnpaid.delete(evidence as string)) {
            if (claim?.state !== "PAID") throw new Error("a resolved claim was paid without being payable");
          } else {
            ledger = settleBondClaim(ledger, evidence as string, at);
          }
          const paid = ledger.claims.find((entry) => toHex(entry.faultEvidenceHash) === evidence);
          if (paid === undefined || paid.payoutAtoms.toString() !== event.fields.payoutAtoms) throw new Error("the paid amount differs from the filed claim");
          if (beneficiaries.get(evidence as string) !== event.fields.beneficiary) throw new Error("the payment went to another beneficiary than the claim named");
          break;
        }
        case "BOND_RELEASED": {
          const released = releasePerformanceBond(ledger, at);
          ledger = released.ledger;
          returnedAtoms = released.returnedAtoms;
          if (released.returnedAtoms.toString() !== event.fields.returnedAtoms) throw new Error("the returned amount differs from the unpaid remainder");
          if (terms !== undefined && event.fields.solver !== terms.solver) throw new Error("the remainder went to another address than the bonded solver");
          break;
        }
      }
    } catch (error) {
      violations.push(`${event.type} at ${event.locator}: ${(error as Error).message}`);
    }
  }
  for (const evidence of resolvedUnpaid) violations.push(`the resolved claim ${evidence} was never paid`);
  const claims = (ledger?.claims ?? []).map((claim) => {
    const evidence = toHex(claim.faultEvidenceHash);
    return Object.freeze({
      faultEvidenceHash: evidence,
      fault: claim.fault,
      payoutAtoms: claim.payoutAtoms.toString(),
      beneficiary: beneficiaries.get(evidence) ?? "",
      filedAtValue: claim.filedAtValue.toString(),
      state: claim.state,
    });
  });
  const sum = (states: readonly BondClaimState[]) => (ledger?.claims ?? []).filter((claim) => states.includes(claim.state)).reduce((total, claim) => total + claim.payoutAtoms, 0n);
  const last = events[events.length - 1] as ObservedBondEvent & { height: number };
  return Object.freeze({
    vault: opened.vault,
    bondIdHex: opened.bondIdHex,
    status: violations.length > 0 ? "INCONSISTENT" : ledger?.released === true ? "RELEASED" : "OPEN",
    solver: String(terms?.solver ?? ""),
    asset: String(terms?.asset ?? ""),
    bondAtoms: String(terms?.bondAtoms ?? "0"),
    coveredFaults: ledger?.bond.coveredFaults ?? [],
    maximumPayoutPerClaim: String(terms?.maximumPayoutPerClaim ?? "0"),
    disputeWindow: String(terms?.disputeWindow ?? "0"),
    expiresAt: String(terms?.expiresAt ?? "0"),
    paidAtoms: sum(["PAID"]).toString(),
    encumberedAtoms: sum(["PENDING", "DISPUTED", "PAID"]).toString(),
    returnedAtoms: returnedAtoms === null ? null : returnedAtoms.toString(),
    claims: Object.freeze(claims),
    lastHeight: last.height,
    finality,
    // A bond is only as well evidenced as its weakest event.
    evidenceGrade: events.reduce<EvidenceGrade>((weakest, event) => (EVIDENCE_GRADE[event.evidenceGrade] < EVIDENCE_GRADE[weakest] ? event.evidenceGrade : weakest), "CONSENSUS_VERIFIED"),
    violations: Object.freeze(violations),
  });
}
