import assert from "node:assert/strict";
import test from "node:test";
import { encodeEventTopics, keccak256, parseAbi, type Address, type Hex } from "viem";
import { domainManifest, domainRefFromManifest, packageOrder, packageOrderHash, strategyStateHash, toHex, type StrategyState } from "@naryx/protocol-types";
import type { EvmDeploymentIdentity } from "@naryx/adapter-evm";
import { createBaseStrategyTransferContext, createBaseStrategyTransferVerifier } from "../src/base-strategy-transfer-verifier.js";
import { hash, receipt, signedOrder } from "./evidence-fixtures.js";
import type { BaseAccountReceipt } from "../src/base-account-receipt.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const owner = address(1), buyer = address(2), account = address(3), factory = address(4), verifier = address(5), base = address(6), perp = address(7);
const code = "0x60016000" as Hex;
const codeHash = keccak256(code);
const txHash = `0x${"ab".repeat(32)}` as Hex;
const blockHash = `0x${"cd".repeat(32)}` as Hex;
const TRANSFER = parseAbi(["event OwnerTransferred(address indexed previousOwner,address indexed newOwner)"]);

function fixture() {
  const manifest = domainManifest({ manifestVersion: 1, environment: "testnet", domainId: "eip155:84532",
    runtimeClassId: "naryx-evm", runtimeClassVersion: 1, chainNamespace: "eip155", chainReference: "84532",
    executionVerifierId: "package-verifier-v1", executionVerifierCodeHash: hash(1), clockModelId: "evm-unix-seconds",
    finalityPolicyHash: hash(2), addressCodecId: "evm-address-20", supportedSettlementClasses: ["ATOMIC_POSTCONDITION"] });
  const deployment = { domainManifest: manifest, strategyAccountFactory: { address: factory, expectedCodeHash: codeHash },
    strategyAccountCodeHash: codeHash, packageVerifier: { address: verifier, expectedCodeHash: codeHash },
    baseAsset: { address: base }, perpetual: { market: { address: perp } } } as EvmDeploymentIdentity;
  const order = packageOrder({ ...signedOrder().order, owner, settlementAccount: account, domain: domainRefFromManifest(manifest) });
  const origin: BaseAccountReceipt = { ...receipt(packageOrderHash(order), { owner, domain: domainRefFromManifest(manifest), netSpotDelta: 1_000_000_000n }),
    kind: "BASE_ACCOUNT_RECEIPT_V1", orderHash: packageOrderHash(order), packageTemplateManifestHash: hash(4),
    receiptHashHex: txHash.slice(2), entryReceiptHashHex: "00".repeat(32), strategyAccount: account,
    transactionHash: txHash, blockNumber: 90n, blockHash };
  const state: StrategyState = { version: 1, strategyId: "owned-carry", ownerId: owner, subaccountId: owner,
    seriesId: "cash-carry", executionClassId: origin.packageMarketId, open: true, stateVersion: 1n,
    liabilities: [], delegations: [], venuePositionsTransferable: true, legalTransferRestricted: false,
    legs: [
      { legId: "spot", underlyingId: "base", instrumentId: "spot", venueId: origin.spotVenue,
        signedQuantityAtoms: origin.netSpotDelta!, lotAtoms: 1n, ratioNumerator: 1n, ratioDenominator: 1n },
      { legId: "perp", underlyingId: "base", instrumentId: "perp", venueId: origin.perpVenue,
        signedQuantityAtoms: origin.perpPositionDelta, lotAtoms: 1n, ratioNumerator: -1n, ratioDenominator: 1n },
    ] };
  let finalized = 100n, currentOwner = buyer, chain = 84532, balance = origin.netSpotDelta!, positionSize = origin.perpPositionDelta;
  let canonical = true, deployedCode: Hex = code, entryOrder = `0x${toHex(packageOrderHash(order))}`, entryHash = txHash;
  const reads = {
    getChainId: async () => chain,
    getCode: async ({ blockNumber }: { blockNumber?: bigint }) => { assert.equal(blockNumber, finalized); return deployedCode; },
    getBlock: async ({ blockTag }: { blockTag?: string }) => ({ number: finalized, timestamp: 1_000n, hash: canonical || blockTag ? blockHash : txHash }),
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 100n, blockHash, transactionHash: txHash,
      logs: [{ address: account, data: "0x", topics: encodeEventTopics({ abi: TRANSFER,
        eventName: "OwnerTransferred", args: { previousOwner: owner, newOwner: buyer } }) }] }),
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      assert.equal(blockNumber, finalized, "every proof read must use the finalized snapshot");
      switch (functionName) {
        case "owner": return currentOwner;
        case "pendingOwner": return buyer;
        case "pendingOwnerExpiresAt": return 2_000n;
        case "verifier": return verifier;
        case "openPackage": return { entryReceiptHash: entryHash, baseToken: base, perpInstrument: perp,
          perpExpiry: 0, baseQuantityAtoms: origin.netSpotDelta!, perpQuantityWad: -origin.perpPositionDelta };
        case "receipt": return { orderHash: entryOrder, strategyAccount: account, action: 1 };
        case "balanceOf": return balance;
        case "getPosition": return { size: positionSize };
        default: throw new Error(functionName);
      }
    },
  };
  const verify = createBaseStrategyTransferVerifier({ rpcUrl: "https://unused.example", deployment,
    originReceipt: () => origin, originOrder: () => order, reads: reads as never });
  const claim = { strategyId: state.strategyId, venueId: origin.spotVenue, evidenceHashHex: txHash.slice(2),
    fromOwnerId: owner, toOwnerId: buyer, state, stateHashHex: toHex(strategyStateHash(state)), originReceiptHashHex: "ef".repeat(32) };
  const context = createBaseStrategyTransferContext({ rpcUrl: "https://unused.example", deployment,
    originReceipt: () => origin, originOrder: () => order, reads: reads as never });
  return { verify, context, claim, origin, set: (v: Partial<{ finalized: bigint; owner: Address; chain: number; balance: bigint;
    size: bigint; canonical: boolean; code: Hex; order: string; entryHash: Hex }>) => {
    finalized = v.finalized ?? finalized; currentOwner = v.owner ?? currentOwner; chain = v.chain ?? chain;
    balance = v.balance ?? balance; positionSize = v.size ?? positionSize; canonical = v.canonical ?? canonical;
    deployedCode = v.code ?? deployedCode; entryOrder = v.order ?? entryOrder;
    entryHash = v.entryHash ?? entryHash;
  } };
}

test("novation verifies the finalized owner transfer and both actual positions against the originating entry", async () => {
  const f = fixture();
  assert.equal(await f.verify(f.claim), true);
  assert.equal(await f.verify({ ...f.claim, venueId: f.origin.perpVenue }), true);
  assert.equal(await f.verify({ ...f.claim, venueId: "unrelated" }), false);
  assert.equal(await f.verify({ ...f.claim, stateHashHex: "00".repeat(32) }), false);
  assert.equal(await f.verify({ ...f.claim, fromOwnerId: address(8) }), false);
});

test("transfer context resolves the originating account and rejects a reorganized snapshot", async () => {
  const f = fixture();
  const stored = { state: f.claim.state, stateHashHex: f.claim.stateHashHex, originReceiptHashHex: f.claim.originReceiptHashHex };
  const context = await f.context(stored);
  assert.equal(context.strategyAccount, account);
  assert.equal(context.pendingOwner, buyer);
  assert.equal(context.chainTimestamp, "1000");
  f.set({ canonical: false });
  await assert.rejects(f.context(stored), /snapshot changed/);
  f.set({ canonical: true, chain: 1 });
  await assert.rejects(f.context(stored), /no supported/);
});

test("pending, reorganized, foreign, changed and emptied accounts never verify a transfer", async () => {
  for (const change of [{ finalized: 99n }, { canonical: false }, { owner }, { chain: 1 }, { balance: 0n },
    { size: 0n }, { code: "0x6002" as Hex }, { order: `0x${"aa".repeat(32)}` }, { entryHash: `0x${"cc".repeat(32)}` as Hex }]) {
    const f = fixture(); f.set(change);
    assert.equal(await f.verify(f.claim), false, JSON.stringify(change, (_, v) => typeof v === "bigint" ? v.toString() : v));
  }
});
