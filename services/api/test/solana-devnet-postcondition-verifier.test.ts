import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import bs58 from "bs58";
import type { PreparedSolanaDevnetRecord } from "../src/solana-devnet-runtime-ports.js";
import { ReadOnlySolanaDevnetPostconditionVerifier } from "../src/solana-devnet-postcondition-verifier.js";
import { SOLANA_DEVNET_GENESIS_HASH } from "../src/terminal-execution.js";

const coreIdl = JSON.parse(readFileSync(new URL("../../../../deployments/solana/program/idl/naryx_core.json", import.meta.url), "utf8"));
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
const address = (value: number): string => bs58.encode(bytes(value));
const hash = (value: number): string => Buffer.from(bytes(value)).toString("hex");

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function i64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(value);
  return out;
}

function domain(): Buffer {
  const id = Buffer.from("svm:devnet", "ascii");
  return Buffer.concat([u32(id.length), id, u32(1), Buffer.from(bytes(1))]);
}

function riskBinding(): Buffer {
  return Buffer.concat([
    Buffer.from(bytes(41)),
    u32(1),
    Buffer.from(bytes(42)),
    Buffer.from(bytes(43)),
    u32(1),
    Buffer.from(bytes(44)),
  ]);
}

function discriminator(name: string): Buffer {
  const account = coreIdl.accounts.find((candidate: { name: string }) => candidate.name === name);
  if (account === undefined) throw new Error(`missing ${name} discriminator`);
  return Buffer.from(account.discriminator);
}

function receiptData(action: 1 | 2, recovery: boolean, receiptAddress: string): Uint8Array {
  return Buffer.concat([
    discriminator("CashCarryExecutionReceipt"),
    domain(),
    Buffer.from(bytes(action === 1 ? 2 : 12)),
    Buffer.from(bytes(action === 1 ? 3 : 13)),
    Buffer.from(bytes(action === 1 ? 4 : 14)),
    Buffer.from(bs58.decode(address(21))),
    Buffer.from(bs58.decode(recovery ? address(0) : address(22))),
    u64(action === 1 ? 7n : 8n),
    Buffer.from(bytes(5)),
    Buffer.from(action === 1 ? bytes(6) : bytes(0)),
    Buffer.from(action === 1 ? bytes(7) : bytes(0)),
    Buffer.from([action, recovery ? 1 : 0]),
    u64(10n), u64(11n), u64(12n),
    u64(13n), u64(14n), u64(15n), u64(16n),
    i64(-10n), i64(-11n), i64(17n), i64(18n),
    u64(action === 1 ? 90n : 190n),
    Buffer.from(bytes(action === 1 ? 8 : 18)),
    Buffer.from(bytes(9)),
    Buffer.from(bs58.decode(receiptAddress)),
    riskBinding(),
    Buffer.from([255]),
  ]);
}

function openPackageData(receiptAddress: string): Uint8Array {
  return Buffer.concat([
    discriminator("OpenCashCarryPackage"),
    Buffer.from([2]),
    domain(),
    Buffer.from(bs58.decode(address(21))),
    Buffer.from(bs58.decode(receiptAddress)),
    Buffer.from(bytes(4)),
    Buffer.from(bytes(6)),
    Buffer.from(bytes(7)),
    Buffer.from(bytes(8)),
    Buffer.from(bytes(9)),
    Buffer.from(bytes(10)),
    Buffer.from(bytes(11)),
    u64(10n),
    u64(11n),
    riskBinding(),
    Buffer.from([254]),
  ]);
}

function record(action: "ENTRY" | "EXIT"): PreparedSolanaDevnetRecord {
  const receiptAccount = action === "ENTRY" ? address(31) : address(32);
  return {
    lifecycleBinding: {
      attemptId: `solana-cash-carry-${hash(2)}`,
      packageId: `solana-cash-carry-${hash(2)}`,
      packageCommitmentHex: hash(2),
      action,
      domain: { domainId: "svm:devnet", domainManifestVersion: 1, domainManifestHash: bytes(1) },
      settlementClass: "ATOMIC_POSTCONDITION",
      evidenceSource: { subjectId: "svm:devnet", manifestVersion: 1, manifestHash: bytes(1) },
    },
    postconditionBinding: {
      coreProgram: address(30),
      receiptAccount,
      openPackageAccount: address(33),
      entryReceiptAccount: action === "ENTRY" ? receiptAccount : address(31),
      orderHashHex: hash(action === "ENTRY" ? 2 : 12),
      quoteHashHex: hash(action === "ENTRY" ? 3 : 13),
      routeHashHex: hash(action === "ENTRY" ? 4 : 14),
      trader: address(21),
      solver: action === "ENTRY" ? address(22) : address(0),
      nonce: action === "ENTRY" ? 7n : 8n,
      spotQuantityAtoms: 10n,
      perpQuantityAtoms: 11n,
      resourceAdmissionCommitmentHex: hash(action === "ENTRY" ? 8 : 18),
      packageFillCommitmentHex: hash(action === "ENTRY" ? 7 : 0),
      ...(action === "ENTRY" ? {
        expectedOpenPackage: {
          quoteIntentCommitmentHex: hash(6),
          routeAccountsCommitmentHex: hash(9),
          economicPackageCommitmentHex: hash(10),
          packageAccountsCommitmentHex: hash(11),
        },
      } : {}),
      recovery: action === "EXIT",
    },
  } as unknown as PreparedSolanaDevnetRecord;
}

test("verifies finalized entry accounts and fails closed on a binding mismatch", async () => {
  const prepared = record("ENTRY");
  const receipt = receiptData(1, false, prepared.postconditionBinding!.receiptAccount);
  const open = openPackageData(prepared.postconditionBinding!.receiptAccount);
  const verifier = new ReadOnlySolanaDevnetPostconditionVerifier({
    coreIdl,
    rpc: {
      getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
      getMultipleAccounts: async () => ({
        contextSlot: 101,
        accounts: [
          { owner: prepared.postconditionBinding!.coreProgram, data: receipt },
          { owner: prepared.postconditionBinding!.coreProgram, data: open },
        ],
      }),
    },
  });
  const proof = await verifier.verify(prepared, 100);
  assert.equal(proof.action, "ENTRY");
  assert.equal(proof.accountContextSlot, 101);
  const tampered = {
    ...prepared,
    postconditionBinding: { ...prepared.postconditionBinding!, trader: address(24) },
  } as PreparedSolanaDevnetRecord;
  await assert.rejects(verifier.verify(tampered, 100), /trader mismatch/);
});

test("verifies finalized exit receipt only after the open package is absent", async () => {
  const prepared = record("EXIT");
  const verifier = new ReadOnlySolanaDevnetPostconditionVerifier({
    coreIdl,
    rpc: {
      getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
      getMultipleAccounts: async () => ({
        contextSlot: 201,
        accounts: [
          { owner: prepared.postconditionBinding!.coreProgram, data: receiptData(2, true, prepared.postconditionBinding!.entryReceiptAccount) },
          null,
        ],
      }),
    },
  });
  const proof = await verifier.verify(prepared, 200);
  assert.equal(proof.action, "EXIT");
  assert.equal(proof.openPackageDataHashHex, null);
});

test("requires the trader's test perp position to hold the exact short after entry", async () => {
  const base = record("ENTRY");
  const venue = address(40);
  const prepared = {
    ...base,
    postconditionBinding: {
      ...base.postconditionBinding!,
      testPerpPosition: {
        venueProgram: venue,
        position: address(41),
        market: address(42),
        owner: address(21),
        delegate: address(43),
        expectedBaseLots: "-11",
      },
    },
  } as PreparedSolanaDevnetRecord;
  const position = (lots: bigint) => Buffer.concat([
    createHash("sha256").update("account:TestPerpPosition").digest().subarray(0, 8),
    Buffer.from(bs58.decode(address(42))),
    Buffer.from(bs58.decode(address(21))),
    Buffer.from(bs58.decode(address(43))),
    u64(500n),
    i64(lots),
    u64(0n),
    Buffer.alloc(17),
  ]);
  const verifierFor = (lots: bigint) => new ReadOnlySolanaDevnetPostconditionVerifier({
    coreIdl,
    rpc: {
      getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
      getMultipleAccounts: async (addresses) => {
        assert.deepEqual(addresses.at(-1), address(41));
        return {
          contextSlot: 101,
          accounts: [
            { owner: prepared.postconditionBinding!.coreProgram, data: receiptData(1, false, prepared.postconditionBinding!.receiptAccount) },
            { owner: prepared.postconditionBinding!.coreProgram, data: openPackageData(prepared.postconditionBinding!.receiptAccount) },
            { owner: venue, data: position(lots) },
          ],
        };
      },
    },
  });
  assert.equal((await verifierFor(-11n).verify(prepared, 100)).action, "ENTRY");
  await assert.rejects(verifierFor(-10n).verify(prepared, 100), /test perp position size mismatch/);
});
