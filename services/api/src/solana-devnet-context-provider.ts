import {
  compileFirmCashCarryPlan,
  type FirmCashCarryBinding,
} from "@naryx/adapter-solana";
import {
  bytesEqual,
  fromProtocolJson,
  routePayloadBytes,
  solverQuoteBytes,
  solverSignatureDigest,
  toHex,
  validatePackageAdmission,
  type PackageAdmissionInput,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from "@naryx/protocol-types";
import type { ExecutionIntentStore, LocalSelectedExecutionAttempt } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import type { NormalizedCashCarryExecutionRequest } from "./terminal-execution.js";
import type { SolanaDevnetExecutionContext } from "./solana-devnet-runtime-ports.js";

type AdmissionConfiguration = Omit<PackageAdmissionInput, "order" | "quote" | "route" | "currentTime">;

export interface SolanaDevnetLiveBindingSource {
  readBinding(input: Readonly<{
    attempt: LocalSelectedExecutionAttempt;
    request: NormalizedCashCarryExecutionRequest;
  }>): Promise<FirmCashCarryBinding>;
}

export type SolanaDevnetContextConfiguration = Readonly<{
  admission: AdmissionConfiguration;
  evidenceClass: "SOLANA_FINALIZED_ACCOUNT_EVIDENCE_V1";
}>;

export type SolanaDevnetContextProviderOptions = Readonly<{
  intents: ExecutionIntentStore;
  orders: InternalOrderStore;
  configuration: SolanaDevnetContextConfiguration;
  currentSlot: () => Promise<bigint>;
  bindings: SolanaDevnetLiveBindingSource;
}>;

function fail(message: string): never {
  throw new Error(`Solana Devnet context rejected: ${message}`);
}

export function createSolanaDevnetContextProvider(options: SolanaDevnetContextProviderOptions) {
  if (options.configuration.evidenceClass !== "SOLANA_FINALIZED_ACCOUNT_EVIDENCE_V1") {
    throw new Error("Solana Devnet evidence class is unsupported.");
  }
  return async (request: NormalizedCashCarryExecutionRequest): Promise<SolanaDevnetExecutionContext> => {
    if (request.domain !== "svm:devnet" || request.mode !== "entry") {
      fail("only svm:devnet durable entry attempts are supported");
    }
    const record = options.orders.getByIdempotencyKey(request.idempotencyKey);
    if (record === undefined) fail("canonical order was not found");
    const order = options.orders.getCanonicalOrderByHash(record.orderHashHex);
    const attempt = options.intents.getAttemptForOrder(record.orderHashHex);
    if (order === undefined || attempt === undefined || attempt.status !== "AUTHORIZED_QUOTE_SELECTED") {
      fail("authorized selected attempt evidence is missing");
    }
    const selected = options.intents.getSelectedQuote(attempt.attemptId);
    if (selected === undefined
      || selected.idempotencyKey !== record.idempotencyKey
      || selected.orderHash !== record.orderHashHex
      || selected.orderHash !== attempt.orderHash
      || selected.quoteHash !== attempt.quoteHash
      || selected.routeHash !== attempt.routeHash) {
      fail("selected attempt evidence is inconsistent");
    }
    if (record.domainId !== "svm:devnet"
      || order.environment !== "devnet"
      || order.domain.domainId !== "svm:devnet"
      || record.domainManifestVersion !== order.domain.domainManifestVersion
      || record.domainManifestHashHex !== toHex(order.domain.domainManifestHash)
      || order.owner !== request.traderPublicKey
      || order.quantity.atoms.toString() !== request.sizeAtoms) {
      fail("request does not match the durable canonical order");
    }
    const slot = await options.currentSlot();
    if (typeof slot !== "bigint" || slot <= 0n) fail("finalized slot is invalid");
    let admission;
    try {
      admission = validatePackageAdmission({
        ...options.configuration.admission,
        order,
        route: fromProtocolJson(selected.route, "selected.route") as RoutePayloadInput,
        quote: fromProtocolJson(selected.quote, "selected.quote") as SolverQuoteInput,
        currentTime: { unit: "SOLANA_SLOT", value: slot },
      });
    } catch (error) {
      fail(`package admission failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (toHex(admission.orderHash) !== attempt.orderHash
      || toHex(admission.quoteHash) !== attempt.quoteHash
      || toHex(admission.routeHash) !== attempt.routeHash
      || toHex(routePayloadBytes(admission.route)) !== selected.routeBytes
      || toHex(solverQuoteBytes(admission.quote)) !== selected.solverQuoteBytes
      || toHex(solverSignatureDigest(admission.quote)) !== selected.solverSignatureDigest) {
      fail("stored signed quote bytes do not match admitted evidence");
    }
    const binding = await options.bindings.readBinding({ attempt, request });
    if (binding.environment !== "devnet"
      || binding.domain.domainId !== "svm:devnet"
      || binding.domain.domainManifestVersion !== order.domain.domainManifestVersion
      || !bytesEqual(binding.domain.domainManifestHash, order.domain.domainManifestHash)
      || binding.currentSlot !== slot) {
      fail("live binding domain or finalized slot does not match admitted evidence");
    }
    try {
      compileFirmCashCarryPlan(admission, binding);
    } catch (error) {
      fail(`registry, series, resource, or transaction binding failed validation: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return Object.freeze({ admission, binding });
  };
}
