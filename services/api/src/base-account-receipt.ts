import { PACKAGE_VERIFIER_OBSERVATION_ABI, NARYX_STRATEGY_ACCOUNT_OWNER_ABI } from "@naryx/adapter-evm";
import { cashCarrySeriesBindingV1, cashCarrySeriesBindingV1Hash, cashCarrySeriesIdentityKey, domainRefFromManifest, packageOrderHash, toHex, type PackageOrder, type PackageReceiptInput } from "@naryx/protocol-types";
import { createPublicClient, decodeEventLog, getAddress, http, keccak256, type Hex, type PublicClient } from "viem";
import type { BaseSepoliaAtomicDeploymentConfiguration } from "./base-sepolia-atomic-context-provider.js";
import type { SqlitePreparedEvmTestnetAtomicStore } from "./evm-testnet-prepared-store.js";

export type BaseAccountReceipt = Pick<PackageReceiptInput, "environment" | "domain" | "owner" | "templateId" | "templateVersion"
  | "action" | "settlementClass" | "terminalState" | "finalityStatus" | "quantity"
  | "packageMarketId" | "spotVenue" | "perpVenue" | "netSpotDelta" | "perpPositionDelta"> & {
  readonly kind: "BASE_ACCOUNT_RECEIPT_V1";
  readonly orderHash: Uint8Array;
  readonly packageTemplateManifestHash: Uint8Array;
  readonly receiptHashHex: string;
  readonly entryReceiptHashHex: string;
  readonly strategyAccount: string;
  readonly transactionHash: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
};

export function createBaseAccountReceiptResolver(input: {
  rpcUrl: string; configuration: BaseSepoliaAtomicDeploymentConfiguration;
  store: Pick<SqlitePreparedEvmTestnetAtomicStore, "accountReceipt" | "finalizedReceiptSource" | "saveAccountReceipt">;
  order: (hash: string) => PackageOrder | undefined;
  reads?: Pick<PublicClient, "getChainId" | "getTransactionReceipt" | "getBlock" | "getCode" | "readContract">;
}) {
  const client = input.reads ?? createPublicClient({ transport: http(input.rpcUrl, { timeout: 10_000, retryCount: 1 }) });
  const configuration = input.configuration, deployment = configuration.deployment;
  const asHex = (value: Uint8Array) => `0x${toHex(value)}` as Hex;
  return async (hash: string): Promise<BaseAccountReceipt | undefined> => {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    const cached = input.store.accountReceipt(hash);
    if (cached !== undefined) return cached;
    const source = input.store.finalizedReceiptSource(hash);
    if (source === undefined) return undefined;
    const prepared = source.preparation;
    const order = input.order(prepared.orderHash.slice(2));
    if (order === undefined || asHex(packageOrderHash(order)) !== prepared.orderHash
      || order.domain.domainId !== "eip155:84532" || order.environment !== "testnet"
      || order.domain.domainManifestVersion !== deployment.domainManifest.manifestVersion
      || asHex(order.domain.domainManifestHash) !== asHex(domainRefFromManifest(deployment.domainManifest).domainManifestHash)
      || await client.getChainId() !== 84532) throw new Error("The finalized Base receipt has no matching order or deployment.");
    const transaction = await client.getTransactionReceipt({ hash: source.transactionHash as Hex });
    const finalized = await client.getBlock({ blockTag: "finalized" });
    const block = await client.getBlock({ blockNumber: transaction.blockNumber });
    if (transaction.status !== "success" || finalized.number === null || transaction.blockNumber > finalized.number
      || transaction.blockHash !== block.hash || transaction.blockNumber.toString() !== source.blockNumber) {
      throw new Error("The account receipt is not canonical and finalized.");
    }
    const verifier = getAddress(deployment.packageVerifier.address), account = getAddress(order.settlementAccount);
    const events = transaction.logs.filter(log => {
      if (getAddress(log.address) !== verifier) return false;
      try {
        const event = decodeEventLog({ abi: PACKAGE_VERIFIER_OBSERVATION_ABI, topics: log.topics, data: log.data });
        return event.eventName === "PackageVerified" && (event.args as { receiptHash?: string }).receiptHash === `0x${hash}`;
      } catch { return false; }
    });
    if (events.length !== 1) throw new Error("The finalized transaction has no unique bound package event.");
    for (const [address, expected] of [[verifier, deployment.packageVerifier.expectedCodeHash], [account, deployment.strategyAccountCodeHash]] as const) {
      const code = await client.getCode({ address, blockNumber: block.number });
      if (code === undefined || keccak256(code).toLowerCase() !== expected.toLowerCase()) throw new Error("Account receipt code identity differs.");
    }
    const raw = await client.readContract({ address: verifier, abi: PACKAGE_VERIFIER_OBSERVATION_ABI,
      functionName: "receipt", args: [`0x${hash}`], blockNumber: block.number }) as {
      orderHash: Hex; quoteHash: Hex; routeHash: Hex; strategyAccount: string; action: number; recovery: boolean;
      seriesIdentityKey: Hex; seriesBindingVersion: number; seriesBindingHash: Hex;
      baseQuantityAtoms: bigint; prePerpSizeWad: bigint; postPerpSizeWad: bigint; entryReceiptHash: Hex;
    };
    const owner = await client.readContract({ address: account, abi: NARYX_STRATEGY_ACCOUNT_OWNER_ABI, functionName: "owner", blockNumber: block.number });
    const entry = order.action === "ENTRY";
    const binding = cashCarrySeriesBindingV1(configuration.seriesBindingInput);
    if (getAddress(String(owner)) !== getAddress(order.owner) || getAddress(raw.strategyAccount) !== account
      || raw.orderHash !== prepared.orderHash || raw.quoteHash !== prepared.quoteHash || raw.routeHash !== prepared.routeHash
      || raw.action !== (entry ? 1 : 2) || raw.recovery || raw.baseQuantityAtoms !== order.quantity.atoms
      || raw.seriesIdentityKey !== asHex(cashCarrySeriesIdentityKey(binding)) || raw.seriesBindingVersion !== binding.bindingVersion
      || raw.seriesBindingHash !== asHex(cashCarrySeriesBindingV1Hash(binding))
      || (entry ? raw.prePerpSizeWad !== 0n || raw.postPerpSizeWad >= 0n : raw.postPerpSizeWad !== 0n || raw.prePerpSizeWad >= 0n)
      || (!entry && (order.entryReceiptHash === undefined || raw.entryReceiptHash !== asHex(order.entryReceiptHash)))
      || (await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("The finalized entry or exit does not match its bound order.");
    const receipt: BaseAccountReceipt = {
      kind: "BASE_ACCOUNT_RECEIPT_V1", receiptHashHex: hash, entryReceiptHashHex: raw.entryReceiptHash.slice(2),
      strategyAccount: account.toLowerCase(), transactionHash: source.transactionHash, blockNumber: block.number, blockHash: block.hash!,
      environment: "testnet", domain: order.domain, owner: order.owner.toLowerCase(), orderHash: packageOrderHash(order),
      templateId: order.templateId, templateVersion: order.templateVersion, packageTemplateManifestHash: order.packageTemplateManifestHash,
      action: order.action, settlementClass: order.settlementClass, terminalState: "FINALIZED_COMPLETE", finalityStatus: "FINALIZED",
      quantity: raw.baseQuantityAtoms, packageMarketId: `class-${toHex(binding.executionClassManifestHash)}`,
      spotVenue: deployment.spot.venue.subjectId, perpVenue: deployment.perpetual.venue.subjectId,
      netSpotDelta: (entry ? 1n : -1n) * raw.baseQuantityAtoms, perpPositionDelta: raw.postPerpSizeWad - raw.prePerpSizeWad,
    };
    input.store.saveAccountReceipt(receipt);
    return receipt;
  };
}
