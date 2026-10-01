import { createPublicKey, verify } from "node:crypto";
import {
  bytesEqual,
  fromProtocolJson,
  packageOrderHash,
  quoteHash,
  routeHash,
  routePayload,
  routePayloadBytes,
  solverQuote,
  solverQuoteBytes,
  solverSignatureDigest,
  type PackageOrder,
  type RoutePayload,
  type RoutePayloadInput,
  type SolverQuote,
  type SolverQuoteInput,
} from "@naryx/protocol-types";
import {
  SolverQuoteClientError,
  type SolverAtomicQuotePort,
  type SolverAtomicQuoteResponse,
  type VerifiedSolverAtomicQuote,
} from "./solver-quote-client.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

/**
 * Verifies a Solana Devnet firm quote. The Devnet route settles against a funded, finalized
 * inventory reservation and an onchain quote lock, so the quote is FIRM_ONCHAIN and must carry the
 * reservation id the solver will fund; every other rule matches the execution-commitment verifier.
 */
export function verifySolanaDevnetFirmQuoteResponse(
  response: SolverAtomicQuoteResponse,
  order: PackageOrder,
  currentClock: bigint,
): VerifiedSolverAtomicQuote {
  let route: RoutePayload;
  let quote: SolverQuote;
  try {
    route = routePayload(fromProtocolJson(response.route, "solver.route") as RoutePayloadInput);
    quote = solverQuote(fromProtocolJson(response.quote, "solver.quote") as SolverQuoteInput);
  } catch {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver route or quote is malformed");
  }
  const orderHash = packageOrderHash(order);
  const computedRouteHash = routeHash(route);
  if (order.domain.domainId !== "svm:devnet"
    || order.environment !== "devnet"
    || response.orderHash !== hex(orderHash)
    || response.routeHash !== hex(computedRouteHash)
    || response.quoteHash !== hex(quoteHash(quote))
    || response.solverSignatureDigest !== hex(solverSignatureDigest(quote))
    || response.routeBytes !== hex(routePayloadBytes(route))
    || response.solverQuoteBytes !== hex(solverQuoteBytes(quote))
    || !bytesEqual(route.orderHash, orderHash)
    || !bytesEqual(quote.orderHash, orderHash)
    || !bytesEqual(quote.routeHash, computedRouteHash)) {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver evidence does not match canonical bytes");
  }
  if (route.environment !== order.environment
    || quote.environment !== order.environment
    || route.routeExpiryUnit !== "SOLANA_SLOT"
    || quote.validUntilUnit !== "SOLANA_SLOT"
    || route.routeExpiryValue !== quote.validUntilValue
    || route.routeExpiryValue > order.expiryValue
    || typeof currentClock !== "bigint"
    || currentClock <= 0n
    || currentClock >= quote.validUntilValue) {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver quote freshness or environment is invalid");
  }
  if (quote.solverSignatureScheme !== "ED25519"
    || quote.quoteMode !== "FIRM_ONCHAIN"
    || quote.reservationId === undefined
    || quote.reservationId.every((byte) => byte === 0)
    || quote.solverVerificationKey.length !== 32
    || quote.signature.length !== 64) {
    throw new SolverQuoteClientError("INVALID_RESPONSE", "solver firm quote shape is invalid");
  }
  let signatureValid = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(quote.solverVerificationKey)]),
      format: "der",
      type: "spki",
    });
    signatureValid = verify(null, Buffer.from(solverSignatureDigest(quote)), publicKey, Buffer.from(quote.signature));
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new SolverQuoteClientError("INVALID_RESPONSE", "solver signature verification failed");
  return Object.freeze({ route, quote });
}

/** Routes Devnet orders to the firm verifier; every other domain keeps the port's own verifier. */
export function withSolanaDevnetFirmQuoteVerification(port: SolverAtomicQuotePort): SolverAtomicQuotePort {
  return Object.freeze({
    quote: (request: Parameters<SolverAtomicQuotePort["quote"]>[0]) => port.quote(request),
    verify: (response: SolverAtomicQuoteResponse, order: PackageOrder, currentClock: bigint) => {
      if (order.domain.domainId === "svm:devnet") return verifySolanaDevnetFirmQuoteResponse(response, order, currentClock);
      if (port.verify === undefined) throw new SolverQuoteClientError("INVALID_RESPONSE", "solver quote verifier is unavailable");
      return port.verify(response, order, currentClock);
    },
  });
}
