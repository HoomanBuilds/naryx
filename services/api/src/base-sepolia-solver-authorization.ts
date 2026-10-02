import type { EvmAtomicAuthorizationBounds } from "@naryx/adapter-evm";
import type { Hex } from "viem";
import { EvmTestnetTerminalValidationError, type EvmTestnetSolverAuthorizer } from "./evm-testnet-runtime-ports.js";

export const BASE_SEPOLIA_SOLVER_AUTHORIZATION_PATH = "/internal/base-sepolia/solver-authorizations";

const SIGNATURE = /^0x[0-9a-f]{130}$/;

function hexBytes(value: Uint8Array): string {
  return `0x${Buffer.from(value).toString("hex")}`;
}

/** Wire form of the signed bounds: every integer is a decimal string, every hash 0x hex. */
export function serializeBaseSepoliaAuthorizationBounds(bounds: EvmAtomicAuthorizationBounds) {
  return {
    currentUnixSeconds: bounds.currentUnixSeconds.toString(),
    strategyAccount: bounds.strategyAccount,
    solver: bounds.solver,
    spotFillCommitment: hexBytes(bounds.spotFillCommitment),
    packageNonce: bounds.packageNonce.toString(),
    expectedPrePerpEntryNotionalWad: bounds.expectedPrePerpEntryNotionalWad.toString(),
    expectedPrePerpBalanceWad: bounds.expectedPrePerpBalanceWad.toString(),
    minimumPostPerpBalanceWad: bounds.minimumPostPerpBalanceWad.toString(),
    maximumPostPerpBalanceWad: bounds.maximumPostPerpBalanceWad.toString(),
    maximumPostPerpEntryNotionalWad: bounds.maximumPostPerpEntryNotionalWad.toString(),
    perpExpiry: bounds.perpExpiry,
    perpArgs: [hexBytes(bounds.perpArgs[0]), hexBytes(bounds.perpArgs[1])],
  };
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Base Sepolia solver authorization origin must be an absolute URL.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname.startsWith("127.");
  if (url.protocol !== "http:" || !loopback || url.username !== "" || url.password !== ""
    || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Base Sepolia solver authorization origin must be a loopback HTTP origin.");
  }
  return url.origin;
}

/**
 * Asks the solver to co-sign the exact execution the trader authorized. The solver re-derives the
 * digest from the selected attempt it fetches itself; this client only carries the signed bounds.
 */
export function createHttpBaseSepoliaSolverAuthorizer(
  endpoint: string,
  fetchImplementation: typeof fetch = fetch,
): EvmTestnetSolverAuthorizer {
  const origin = loopbackOrigin(endpoint);
  return async ({ attemptId, traderSignature, bounds }) => {
    const response = await fetchImplementation(`${origin}${BASE_SEPOLIA_SOLVER_AUTHORIZATION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        attemptId,
        traderSignature,
        bounds: serializeBaseSepoliaAuthorizationBounds(bounds),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 409) {
      // The solver re-admitted the attempt at chain time and declined; its reason says what to redo.
      const body = await response.json().catch(() => undefined) as { error?: { message?: unknown } } | undefined;
      const reason = typeof body?.error?.message === "string" && body.error.message.length <= 200
        ? body.error.message
        : "no reason given";
      throw new EvmTestnetTerminalValidationError("SOLVER_DECLINED", `The solver declined to co-sign the package: ${reason}.`);
    }
    if (!response.ok) throw new Error(`Base Sepolia solver refused authorization with HTTP ${response.status}.`);
    const body = await response.json() as Record<string, unknown>;
    if (body?.version !== 1 || body.attemptId !== attemptId
      || typeof body.solverSignature !== "string" || !SIGNATURE.test(body.solverSignature)) {
      throw new Error("Base Sepolia solver authorization response is invalid.");
    }
    return body.solverSignature as Hex;
  };
}
