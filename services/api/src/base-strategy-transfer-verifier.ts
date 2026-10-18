import {
  ERC20_ABI, NARYX_STRATEGY_ACCOUNT_OWNER_ABI,
  NARYX_TEST_PERP_MARKET_ABI, PACKAGE_VERIFIER_ACCOUNT_ABI, PACKAGE_VERIFIER_OBSERVATION_ABI,
  type EvmDeploymentIdentity,
} from "@naryx/adapter-evm";
import { bytesEqual, domainRefFromManifest, packageOrderHash, strategyStateHash, toHex, type PackageOrder } from "@naryx/protocol-types";
import { createPublicClient, decodeEventLog, getAddress, http, keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import type { OriginReceiptReader, StoredStrategy, TransferEvidenceVerifier } from "./strategy-book-store.js";

const TRANSFER_ABI = parseAbi(["event OwnerTransferred(address indexed previousOwner,address indexed newOwner)"]);
const PENDING_ABI = parseAbi(["function pendingOwner() view returns (address)", "function pendingOwnerExpiresAt() view returns (uint64)"]);
type Reads = Pick<PublicClient, "getChainId" | "getCode" | "getTransactionReceipt" | "getBlock" | "readContract">;
const sameAddress = (left: string, right: string) => getAddress(left) === getAddress(right);
const hex = (value: Uint8Array | string): Hex => `0x${typeof value === "string" ? value.replace(/^0x/, "") : toHex(value)}`;
type OriginOrderReader = (hash: string) => PackageOrder | undefined;

export function createBaseStrategyTransferContext(input: {
  rpcUrl: string; deployment: EvmDeploymentIdentity; originReceipt: OriginReceiptReader; originOrder: OriginOrderReader; reads?: Reads;
}) {
  const client: Reads = input.reads ?? createPublicClient({ transport: http(input.rpcUrl, { timeout: 10_000, retryCount: 1 }) });
  return async (stored: StoredStrategy) => {
    const origin = stored.originReceiptHashHex === undefined ? undefined : input.originReceipt(stored.originReceiptHashHex);
    if (origin === undefined || "legOutcomes" in origin || origin.domain.domainId !== "eip155:84532"
      || origin.finalityStatus !== "FINALIZED" || origin.terminalState !== "FINALIZED_COMPLETE" || origin.action !== "ENTRY"
      || !stored.state.venuePositionsTransferable || !stored.state.open || stored.retiredByCommandHashHex !== undefined
      || origin.domain.domainManifestVersion !== input.deployment.domainManifest.manifestVersion
      || !bytesEqual(origin.domain.domainManifestHash, domainRefFromManifest(input.deployment.domainManifest).domainManifestHash)
      || await client.getChainId() !== 84532) throw new Error("Strategy has no supported Base account transfer.");
    const block = await client.getBlock({ blockTag: "latest" });
    if (block.number === null || block.hash === null) throw new Error("Base block is unavailable.");
    const factory = getAddress(input.deployment.strategyAccountFactory.address);
    const order = input.originOrder(hex(origin.orderHash).slice(2));
    if (order === undefined || hex(packageOrderHash(order)) !== hex(origin.orderHash)
      || !sameAddress(order.owner, origin.owner)) throw new Error("The originating signed order is unavailable.");
    const account = getAddress(order.settlementAccount);
    for (const [address, expected] of [[factory, input.deployment.strategyAccountFactory.expectedCodeHash],
      [account, input.deployment.strategyAccountCodeHash]] as const) {
      const code = await client.getCode({ address, blockNumber: block.number });
      if (code === undefined || keccak256(code).toLowerCase() !== expected.toLowerCase()) throw new Error("Transfer account deployment differs.");
    }
    const [owner, verifier, pendingOwner, expires] = await Promise.all([
      client.readContract({ address: account, abi: NARYX_STRATEGY_ACCOUNT_OWNER_ABI, functionName: "owner", blockNumber: block.number }),
      client.readContract({ address: account, abi: NARYX_STRATEGY_ACCOUNT_OWNER_ABI, functionName: "verifier", blockNumber: block.number }),
      client.readContract({ address: account, abi: PENDING_ABI, functionName: "pendingOwner", blockNumber: block.number }),
      client.readContract({ address: account, abi: PENDING_ABI, functionName: "pendingOwnerExpiresAt", blockNumber: block.number }),
    ]);
    if (!sameAddress(String(verifier), input.deployment.packageVerifier.address)) throw new Error("Transfer account verifier differs.");
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("The account snapshot changed. Refresh before signing.");
    return { version: 1, chainId: 84532, strategyId: stored.state.strategyId, strategyAccount: account,
      owner: getAddress(String(owner)), pendingOwner: getAddress(String(pendingOwner)), pendingOwnerExpiresAt: String(expires),
      chainTimestamp: block.timestamp.toString(), bookOwner: stored.state.ownerId };
  };
}

export function createBaseStrategyTransferVerifier(input: {
  rpcUrl: string;
  deployment: EvmDeploymentIdentity;
  originReceipt: OriginReceiptReader;
  originOrder: OriginOrderReader;
  reads?: Reads;
}): TransferEvidenceVerifier {
  const client: Reads = input.reads ?? createPublicClient({ transport: http(input.rpcUrl, { timeout: 10_000, retryCount: 1 }) });
  const deployment = input.deployment;
  return async claim => {
    const origin = claim.originReceiptHashHex === undefined ? undefined : input.originReceipt(claim.originReceiptHashHex);
    if (origin === undefined || "legOutcomes" in origin || origin.domain.domainId !== "eip155:84532"
      || origin.domain.domainManifestVersion !== deployment.domainManifest.manifestVersion
      || !bytesEqual(origin.domain.domainManifestHash, domainRefFromManifest(deployment.domainManifest).domainManifestHash)
      || origin.action !== "ENTRY" || origin.finalityStatus !== "FINALIZED" || origin.terminalState !== "FINALIZED_COMPLETE"
      || ![origin.spotVenue, origin.perpVenue].includes(claim.venueId)
      || !/^0x[0-9a-fA-F]{40}$/.test(claim.fromOwnerId) || !/^0x[0-9a-fA-F]{40}$/.test(claim.toOwnerId)
      || !/^[0-9a-f]{64}$/.test(claim.evidenceHashHex)
      || claim.stateHashHex !== toHex(strategyStateHash(claim.state)) || claim.state.ownerId !== claim.fromOwnerId
      || !claim.state.open || claim.state.liabilities.length !== 0 || claim.state.legs.length !== 2) return false;
    const spot = claim.state.legs.find(leg => leg.venueId === origin.spotVenue);
    const perp = claim.state.legs.find(leg => leg.venueId === origin.perpVenue);
    if (spot === undefined || perp === undefined || spot.signedQuantityAtoms !== origin.netSpotDelta
      || perp.signedQuantityAtoms !== origin.perpPositionDelta || spot.signedQuantityAtoms <= 0n) return false;
    if (await client.getChainId() !== 84532) return false;
    const finalized = await client.getBlock({ blockTag: "finalized" });
    if (finalized.number === null || finalized.hash === null) return false;
    const blockNumber = finalized.number;
    const verifier = getAddress(deployment.packageVerifier.address);
    const factory = getAddress(deployment.strategyAccountFactory.address);
    const order = input.originOrder(hex(origin.orderHash).slice(2));
    if (order === undefined || hex(packageOrderHash(order)) !== hex(origin.orderHash)
      || !sameAddress(order.owner, origin.owner)) return false;
    const account = getAddress(order.settlementAccount);
    const transfer = await client.getTransactionReceipt({ hash: `0x${claim.evidenceHashHex}` });
    if (transfer.status !== "success" || transfer.blockNumber > blockNumber) return false;
    const block = await client.getBlock({ blockNumber: transfer.blockNumber });
    if (block.hash !== transfer.blockHash || transfer.transactionHash !== `0x${claim.evidenceHashHex}`) return false;
    const matches = transfer.logs.filter(log => {
      if (!sameAddress(log.address, account)) return false;
      try {
        const event = decodeEventLog({ abi: TRANSFER_ABI, data: log.data, topics: log.topics });
        return sameAddress(event.args.previousOwner, claim.fromOwnerId) && sameAddress(event.args.newOwner, claim.toOwnerId);
      } catch { return false; }
    });
    if (matches.length !== 1) return false;
    for (const [address, expected] of [
      [account, deployment.strategyAccountCodeHash], [factory, deployment.strategyAccountFactory.expectedCodeHash],
      [verifier, deployment.packageVerifier.expectedCodeHash],
    ] as const) {
      const code = await client.getCode({ address, blockNumber });
      if (code === undefined || code === "0x" || keccak256(code).toLowerCase() !== expected.toLowerCase()) return false;
    }
    const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;
    const [owner, boundVerifier, open] = await Promise.all([
      read<Address>(account, NARYX_STRATEGY_ACCOUNT_OWNER_ABI, "owner"),
      read<Address>(account, NARYX_STRATEGY_ACCOUNT_OWNER_ABI, "verifier"),
      read<{ entryReceiptHash: Hex; baseToken: Address; perpInstrument: Address; perpExpiry: number;
        baseQuantityAtoms: bigint; perpQuantityWad: bigint }>(verifier, PACKAGE_VERIFIER_ACCOUNT_ABI, "openPackage", [account]),
    ]);
    if (!sameAddress(owner, claim.toOwnerId) || !sameAddress(boundVerifier, verifier)
      || ("kind" in origin && (open.entryReceiptHash !== hex(origin.receiptHashHex) || !sameAddress(origin.strategyAccount, account)))
      || !sameAddress(open.baseToken, deployment.baseAsset.address)
      || !sameAddress(open.perpInstrument, deployment.perpetual.market.address)
      || open.baseQuantityAtoms !== spot.signedQuantityAtoms || -open.perpQuantityWad !== perp.signedQuantityAtoms) return false;
    const [entry, balance, position] = await Promise.all([
      read<{ orderHash: Hex; strategyAccount: Address; action: number }>(verifier, PACKAGE_VERIFIER_OBSERVATION_ABI, "receipt", [open.entryReceiptHash]),
      read<bigint>(open.baseToken, ERC20_ABI, "balanceOf", [account]),
      read<{ size: bigint }>(open.perpInstrument, NARYX_TEST_PERP_MARKET_ABI, "getPosition", [open.perpInstrument, open.perpExpiry, account]),
    ]);
    const snapshot = await client.getBlock({ blockNumber });
    return snapshot.hash === finalized.hash
      && entry.orderHash === hex(origin.orderHash) && sameAddress(entry.strategyAccount, account) && entry.action === 1
      && balance >= spot.signedQuantityAtoms && position.size === perp.signedQuantityAtoms;
  };
}
