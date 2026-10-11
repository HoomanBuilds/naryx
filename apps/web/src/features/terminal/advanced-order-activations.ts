"use client";

import { useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import type { OwnerOrderActivation } from "./private-http-terminal-provider";
import { useTerminal } from "./shell/terminal-context";

export const ORDER_ACTIVATIONS_QUERY = "owner-order-activations";
const ORDER_ACTIVATION_DETAILS_QUERY = "owner-order-activation-details";

const KIND_LABEL: Readonly<Record<OwnerOrderActivation["kind"], string>> = {
  CONDITIONAL: "Conditional",
  SCHEDULED: "Scheduled",
  PACKAGE_TWAP: "Package TWAP",
};

export function activationKind(activation: OwnerOrderActivation): string {
  return KIND_LABEL[activation.kind];
}

/** The connected wallets as order owners; EVM strategy orders bind the lowercase address. */
export function useActivationOwners(): readonly string[] {
  const solanaOwner = useSolanaWallet().selectedAccount?.address ?? null;
  const evmOwner = useEvmWallet().account?.toLowerCase() ?? null;
  return [solanaOwner, evmOwner].filter((owner): owner is string => owner !== null);
}

function clockValue(value: bigint, unit: string): string {
  const ms = unit === "EVM_UNIX_SECONDS" ? value * BigInt(1000) : unit === "HYPERLIQUID_UNIX_MILLISECONDS" ? value : null;
  if (ms === null) return unit === "SOLANA_SLOT" ? `slot ${value.toString()}` : value.toString();
  if (ms > BigInt(8_640_000_000_000_000)) return value.toString();
  return new Date(Number(ms)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * When the activation runtime may next act on a WAITING order. The summary carries the next slice
 * window; trigger terms show only after the owner's signed full read.
 */
export function nextActivation(activation: OwnerOrderActivation): string {
  if (activation.status !== "WAITING") return "-";
  if (activation.attemptReserved) return "Slice reserved and executing";
  let gate: string | null = null;
  if (activation.condition !== null) {
    const { metric, comparator, threshold, unit } = activation.condition;
    gate = metric === "TIME"
      ? `At ${clockValue(threshold, unit)}`
      : `When ${metric.replaceAll("_", " ").toLowerCase()} ${comparator === "AT_OR_ABOVE" ? ">=" : "<="} ${threshold.toString()}`;
  } else if (activation.kind === "CONDITIONAL") {
    gate = "On its private trigger";
  }
  if (activation.kind === "CONDITIONAL") return gate ?? "-";
  if (activation.nextSlice === null) return "No slices left";
  const { schedule, lastAttemptedSliceIndex } = activation;
  const index = lastAttemptedSliceIndex === null ? 0 : lastAttemptedSliceIndex + 1;
  const from = clockValue(activation.nextSlice.value, activation.nextSlice.unit);
  const slice = schedule !== null && activation.disclosure === "FULL"
    ? `Slice ${index + 1} of ${schedule.sliceCount} from ${from}`
    : `Next slice from ${from}`;
  return gate === null ? slice : `${slice}; ${gate.charAt(0).toLowerCase()}${gate.slice(1)}`;
}

/**
 * A summary with the owner's signed full read laid over it. Trigger and schedule terms never change,
 * so they always apply; slice counts apply only while the order has not moved since that read.
 */
function withDetail(summary: OwnerOrderActivation, detail: OwnerOrderActivation | undefined): OwnerOrderActivation {
  if (detail === undefined || summary.disclosure === "FULL") return summary;
  const current = detail.updatedAtMs === summary.updatedAtMs;
  return Object.freeze({
    ...summary,
    condition: detail.condition,
    schedule: detail.schedule,
    ...(current ? {
      disclosure: "FULL" as const,
      attemptedSlices: detail.attemptedSlices,
      failedSlices: detail.failedSlices,
      lastAttemptedSliceIndex: detail.lastAttemptedSliceIndex,
    } : {}),
  });
}

/** Each owner's advanced orders from the private terminal service, newest update first. */
export function useOwnerOrderActivations(owners: readonly string[]) {
  const { privateProvider } = useTerminal();
  // Filled only by revealDetails after the owner signs; never fetched on its own.
  const details = useQueries({
    queries: owners.map((owner) => ({
      queryKey: [ORDER_ACTIVATION_DETAILS_QUERY, owner],
      enabled: false,
      staleTime: Infinity,
      queryFn: (): readonly OwnerOrderActivation[] => {
        throw new Error("Full advanced-order details need the owner's signed read.");
      },
    })),
  });
  const detailByHash = new Map<string, OwnerOrderActivation>();
  for (const query of details) for (const activation of query.data ?? []) detailByHash.set(activation.orderHash, activation);
  const queries = useQueries({
    queries: owners.map((owner) => ({
      queryKey: [ORDER_ACTIVATIONS_QUERY, owner],
      enabled: privateProvider !== null,
      refetchInterval: 15_000,
      refetchOnWindowFocus: true,
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        if (!privateProvider) throw new Error("Private service not configured.");
        return privateProvider.listOwnerOrderActivations(owner, signal);
      },
    })),
  });
  const byHash = new Map<string, OwnerOrderActivation>();
  for (const query of queries) {
    for (const activation of query.data ?? []) byHash.set(activation.orderHash, withDetail(activation, detailByHash.get(activation.orderHash)));
  }
  return {
    activations: [...byHash.values()].sort((left, right) => right.updatedAtMs - left.updatedAtMs),
    configured: privateProvider !== null,
    loading: privateProvider !== null && queries.some((query) => query.isPending),
    errors: [...new Set(queries.flatMap((query) => query.error ? [query.error.message] : []))],
  };
}

/** Signs and submits one owner cancellation, then refreshes every advanced-order list. */
export function useCancelOrderActivation() {
  const { privateProvider } = useTerminal();
  const evm = useEvmWallet();
  const solana = useSolanaWallet();
  const queryClient = useQueryClient();
  const [state, setState] = useState<Readonly<{ orderHash: string; phase: "busy" | "ok" | "error"; text: string }> | null>(null);

  async function cancel(activation: OwnerOrderActivation) {
    setState({ orderHash: activation.orderHash, phase: "busy", text: "Preparing the cancellation." });
    try {
      if (privateProvider === null) throw new Error("The private terminal service is not configured, so the order cannot be cancelled here.");
      const evmOwner = activation.owner.startsWith("0x");
      if (evmOwner ? evm.account?.toLowerCase() !== activation.owner
        : solana.selectedAccount?.address !== activation.owner || !solana.canSignMessage) {
        throw new Error(evmOwner
          ? "Connect the EVM wallet that owns this order."
          : "Connect the Solana wallet that owns this order and supports message signing.");
      }
      await privateProvider.cancelOrderActivation(activation, (challenge) => challenge.scheme === "EIP712_SECP256K1"
        ? evm.signChainlessTypedData(challenge.typedData)
        : solana.signMessage(challenge.message));
      setState({ orderHash: activation.orderHash, phase: "ok", text: "Advanced order cancelled. No further slices will activate." });
    } catch (cause) {
      setState({ orderHash: activation.orderHash, phase: "error", text: cause instanceof Error ? cause.message : "Cancellation failed." });
    } finally {
      await queryClient.invalidateQueries({ queryKey: [ORDER_ACTIVATIONS_QUERY] });
    }
  }

  return {
    cancel,
    state,
    busy: state?.phase === "busy",
    awaitingWallet: evm.awaitingWallet || solana.awaitingWallet,
  };
}

/** Signs one single-use full read per connected owner and lays the trigger and schedule terms over the list. */
export function useRevealOrderActivationDetails() {
  const { privateProvider } = useTerminal();
  const evm = useEvmWallet();
  const solana = useSolanaWallet();
  const queryClient = useQueryClient();
  const [state, setState] = useState<Readonly<{ phase: "busy" | "ok" | "error"; text: string }> | null>(null);

  async function reveal(owners: readonly string[]) {
    setState({ phase: "busy", text: "Preparing the signed read." });
    try {
      if (privateProvider === null) throw new Error("The private terminal service is not configured, so full details cannot be read.");
      const signable = owners.filter((owner) => owner.startsWith("0x")
        ? evm.account?.toLowerCase() === owner
        : solana.selectedAccount?.address === owner && solana.canSignMessage);
      if (signable.length === 0) throw new Error("Connect a wallet that owns these orders and can sign messages.");
      for (const owner of signable) {
        const full = await privateProvider.readOwnerOrderActivationsFull(owner, (challenge) => challenge.scheme === "EIP712_SECP256K1"
          ? evm.signChainlessTypedData(challenge.typedData)
          : solana.signMessage(challenge.message));
        queryClient.setQueryData([ORDER_ACTIVATION_DETAILS_QUERY, owner], full);
      }
      setState({ phase: "ok", text: "Full trigger and schedule terms loaded for this session." });
    } catch (cause) {
      setState({ phase: "error", text: cause instanceof Error ? cause.message : "The signed read failed." });
    }
  }

  return { reveal, state, busy: state?.phase === "busy", awaitingWallet: evm.awaitingWallet || solana.awaitingWallet };
}
