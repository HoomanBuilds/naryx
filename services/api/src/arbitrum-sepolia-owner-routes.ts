import type { IncomingMessage, ServerResponse } from "node:http";
import { equalAddress, equalHash, requiredEvmAddress } from "@naryx/adapter-evm";
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import {
  ARBITRUM_SEPOLIA_CHAIN_REFERENCE,
  ARBITRUM_SEPOLIA_DOMAIN_ID,
  arbitrumSepoliaAccountCodeHash,
  arbitrumSepoliaAccountOf,
  type ArbitrumSepoliaAsyncDeploymentConfiguration,
} from "./arbitrum-sepolia-async-context-provider.js";
import {
  ArbitrumSepoliaHandoffError,
  type ArbitrumSepoliaExitAuthorizationExecutor,
  type ArbitrumSepoliaOwnerAuthorization,
  type ArbitrumSepoliaOwnerAuthorizationExecutor,
} from "./arbitrum-sepolia-executor-client.js";
import {
  ArbitrumSepoliaExitError,
  createArbitrumSepoliaExitOrder,
  readArbitrumSepoliaOpenPackage,
  requireArbitrumSepoliaExitBinding,
  requireOwnerSignature,
  type ArbitrumSepoliaExitAuthorization,
} from "./arbitrum-sepolia-exit.js";
import type { ArbitrumSepoliaOrderRuntime, ArbitrumSepoliaPriceReadPort } from "./arbitrum-sepolia-order-context.js";
import { EntryOrderValidationError } from "./canonical-entry-order.js";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import { createReadCache } from "./read-cache.js";
import { isAllowedTerminalOrigin, type TerminalOrigins } from "./terminal-origin.js";
import { InternalOrderConflictError, type InternalOrderStore } from "./internal-order-store.js";

export const ARBITRUM_SEPOLIA_ACCOUNT_PATH = "/internal/terminal/arbitrum-sepolia/account";
export const ARBITRUM_SEPOLIA_PREPARE_OWNER_AUTHORIZATION_PATH =
  "/internal/terminal/arbitrum-sepolia/prepare-owner-authorization";
export const ARBITRUM_SEPOLIA_AUTHORIZE_OWNER_PATH = "/internal/terminal/arbitrum-sepolia/authorize-owner";
export const ARBITRUM_SEPOLIA_EXIT_ORDER_PATH = "/internal/terminal/arbitrum-sepolia/exit-order";
export const ARBITRUM_SEPOLIA_PREPARE_EXIT_AUTHORIZATION_PATH =
  "/internal/terminal/arbitrum-sepolia/prepare-exit-authorization";
export const ARBITRUM_SEPOLIA_AUTHORIZE_EXIT_PATH = "/internal/terminal/arbitrum-sepolia/authorize-exit";

const MAX_BODY_BYTES = 4_096;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const FACTORY_ABI = parseAbi(["function create(address owner) returns (address)"]);
const ADAPTER_ABI = parseAbi([
  "struct SpotEntry { address fundingOwner; address port; bytes32 portCodeHash; address baseToken; address quoteToken; uint256 baseAtoms; uint256 maxQuoteAtoms; uint256 rollbackMinQuoteAtoms; bytes32 entryFillCommitment; bytes32 rollbackFillCommitment; }",
  "struct VenueRequest { bytes32 marketId; address collateralToken; int256 sizeDelta; uint256 collateralAtoms; uint256 acceptablePrice; uint256 executionFeeWei; uint256 callbackGasLimit; uint256 packageNonce; bytes32 orderHash; bytes32 quoteHash; bytes32 routeHash; SpotEntry spot; uint64 submissionDeadline; uint64 venueDeadline; uint64 recoveryDeadline; }",
  "function fundRequest(bytes32 packageId, VenueRequest venueRequest) payable",
]);

export interface ArbitrumSepoliaOwnerRoutesOptions {
  readonly terminalOrigin: TerminalOrigins;
  readonly deployment: ArbitrumSepoliaAsyncDeploymentConfiguration;
  readonly executor: ArbitrumSepoliaOwnerAuthorizationExecutor & ArbitrumSepoliaExitAuthorizationExecutor;
  /** Signerless chain reads. Chain identity always comes from eth_chainId. */
  readonly port: ArbitrumSepoliaPriceReadPort;
  readonly intents: Pick<ExecutionIntentStore, "getAttempt">;
  readonly orders: Pick<InternalOrderStore, "getCanonicalOrderByHash">;
  /** The live order context and the order store; without them the exit-order route answers 503. */
  readonly exit?: Readonly<{ runtime: ArbitrumSepoliaOrderRuntime; orders: Pick<InternalOrderStore, "createOrGet"> }>;
}

class OwnerRouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

function reject(response: ServerResponse, status: number, code: string, message: string): void {
  send(response, status, { error: { code, message } });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new OwnerRouteError(400, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_BODY_BYTES) throw new OwnerRouteError(400, "BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OwnerRouteError(400, "INVALID_JSON", "Request body must contain valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OwnerRouteError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function exactStrings(body: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  if (Object.keys(body).sort().join(",") !== [...keys].sort().join(",")
    || keys.some((key) => typeof body[key] !== "string")) {
    throw new OwnerRouteError(400, "INVALID_FIELDS", `Request must contain only ${keys.join(" and ")}.`);
  }
  return body as Record<string, string>;
}

function openPackageBody(open: Awaited<ReturnType<typeof readArbitrumSepoliaOpenPackage>>) {
  return open === null ? null : {
    packageId: open.packageId,
    entryRequestKey: open.entryRequestKey,
    entryExecuted: open.entryExecuted,
    positionSizeUsd: open.positionSizeUsd.toString(),
    spotBaseAtoms: open.spotBaseAtoms.toString(),
    activeExitRequestKey: open.activeExitRequestKey,
    exitable: open.exitable,
  };
}

function ownerAddress(value: unknown): Address {
  if (typeof value !== "string" || !ADDRESS.test(value) || /^0x0{40}$/i.test(value)) {
    throw new OwnerRouteError(400, "INVALID_OWNER", "Owner must be a nonzero 0x address.");
  }
  return value.toLowerCase() as Address;
}

export function createArbitrumSepoliaOwnerRoutes(
  options: ArbitrumSepoliaOwnerRoutesOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  const { deployment, executor, port } = options;
  const factory = requiredEvmAddress(deployment.accountFactory.address, "accountFactory").toLowerCase() as Address;
  const coordinator = requiredEvmAddress(deployment.coordinator.address, "coordinator");
  const adapter = requiredEvmAddress(deployment.entryAdapter.address, "entryAdapter");
  const collateral = requiredEvmAddress(deployment.collateralToken.address, "collateralToken");
  const accountCodeHash = arbitrumSepoliaAccountCodeHash(deployment);

  const requireChain = async () => {
    if (await port.chainId() !== BigInt(ARBITRUM_SEPOLIA_CHAIN_REFERENCE)) {
      throw new OwnerRouteError(503, "WRONG_CHAIN", "Arbitrum Sepolia RPC eth_chainId is not 421614.");
    }
  };

  /** The selected Arbitrum attempt and its stored canonical order. */
  const selectedAttempt = (attemptId: string) => {
    let attempt;
    try {
      attempt = options.intents.getAttempt(attemptId);
    } catch {
      attempt = undefined;
    }
    const order = attempt === undefined ? undefined : options.orders.getCanonicalOrderByHash(attempt.orderHash);
    if (attempt === undefined || attempt.status !== "ARBITRUM_ASYNC_QUOTE_SELECTED"
      || attempt.domainId !== ARBITRUM_SEPOLIA_DOMAIN_ID || order === undefined) {
      throw new OwnerRouteError(404, "ATTEMPT_NOT_FOUND", "Arbitrum Sepolia attempt was not found.");
    }
    return { attempt, order };
  };

  /** The stored order owner of a selected Arbitrum attempt; the prepared work must be for exactly it. */
  const attemptOwner = (attemptId: string): Address => ownerAddress(selectedAttempt(attemptId).order.owner);

  /** Independently binds the solver's prepared exit to the EXIT attempt, its entry package, and this deployment. */
  const checkedExit = (attemptId: string, authorization: ArbitrumSepoliaExitAuthorization) => {
    const { attempt, order } = selectedAttempt(attemptId);
    if (order.action !== "EXIT" || order.entryReceiptHash === undefined) {
      throw new OwnerRouteError(409, "NOT_AN_EXIT", "The Arbitrum Sepolia attempt is not an exit.");
    }
    try {
      return requireArbitrumSepoliaExitBinding(authorization, {
        deployment,
        owner: order.owner,
        settlementAccount: order.settlementAccount,
        packageId: `0x${Buffer.from(order.entryReceiptHash).toString("hex")}`,
        orderHash: `0x${attempt.orderHash}`,
        quoteHash: `0x${attempt.quoteHash}`,
        routeHash: `0x${attempt.routeHash}`,
      });
    } catch {
      throw new OwnerRouteError(502, "AUTHORIZATION_MISMATCH", "Prepared exit authorization does not match this attempt.");
    }
  };

  /** Independently binds the solver's prepared work to this deployment and the attempt owner. */
  const checked = (authorization: ArbitrumSepoliaOwnerAuthorization, owner: Address) => {
    const account = arbitrumSepoliaAccountOf(deployment, owner);
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: ADAPTER_ABI, data: authorization.funding.fundRequest.data });
    } catch {
      decoded = undefined;
    }
    const request = decoded?.args?.[1] as { spot?: { fundingOwner?: string }; executionFeeWei?: bigint } | undefined;
    if (!equalAddress(authorization.owner, owner) || !equalAddress(authorization.account, account)
      || !equalAddress(authorization.accountFactory, factory) || !equalAddress(authorization.coordinator, coordinator)
      || !equalAddress(authorization.adapter, adapter) || !equalAddress(authorization.funding.spender, adapter)
      || !equalAddress(authorization.funding.token, collateral)
      || decoded?.functionName !== "fundRequest" || decoded.args?.[0] !== authorization.packageId
      || typeof request?.spot?.fundingOwner !== "string" || !equalAddress(request.spot.fundingOwner as Address, owner)
      || request.executionFeeWei !== BigInt(authorization.funding.executionFeeWei)) {
      throw new OwnerRouteError(502, "AUTHORIZATION_MISMATCH", "Prepared owner authorization does not match this deployment.");
    }
    return authorization;
  };

  /** One wallet's account and open package, read from chain; identical reads within 2s are joined. */
  const accountReads = createReadCache<unknown>({ ttlMs: 2_000 });
  const accountStatus = async (owner: Address) => {
    await requireChain();
    const account = arbitrumSepoliaAccountOf(deployment, owner);
    const code = await port.codeHash(account);
    if (code !== undefined && !equalHash(code, accountCodeHash)) {
      throw new OwnerRouteError(409, "ACCOUNT_CODE_MISMATCH", "Code at the owner account address is not a factory account.");
    }
    // Read from chain on every call, so a package entered on another device can still be exited.
    const openPackage = code === undefined ? null : await readArbitrumSepoliaOpenPackage(port, deployment, owner);
    return {
      version: 1,
      domainId: ARBITRUM_SEPOLIA_DOMAIN_ID,
      chainId: Number(ARBITRUM_SEPOLIA_CHAIN_REFERENCE),
      owner,
      account,
      accountFactory: factory,
      deployed: code !== undefined,
      createAccount: code !== undefined ? null : {
        to: factory,
        data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "create", args: [owner] }),
        value: "0",
      },
      openPackage: openPackageBody(openPackage),
    };
  };

  const handlers: Readonly<Record<string, (request: IncomingMessage, url: URL) => Promise<unknown>>> = {
    [ARBITRUM_SEPOLIA_ACCOUNT_PATH]: async (request, url) => {
      if (request.method !== "GET") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
      if ([...url.searchParams.keys()].join(",") !== "owner") {
        throw new OwnerRouteError(400, "INVALID_FIELDS", "Query must contain only owner.");
      }
      const owner = ownerAddress(url.searchParams.get("owner"));
      return accountReads(owner, () => accountStatus(owner));
    },
    [ARBITRUM_SEPOLIA_EXIT_ORDER_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      const body = await readJson(request);
      if (Object.keys(body).sort().join(",") !== "idempotencyKey,owner,slippageBps"
        || typeof body.slippageBps !== "number" || typeof body.idempotencyKey !== "string"
        || !/^[A-Za-z0-9_-]{16,64}$/.test(body.idempotencyKey)) {
        throw new OwnerRouteError(400, "INVALID_FIELDS", "Request must contain only owner, slippageBps, and idempotencyKey.");
      }
      const owner = ownerAddress(body.owner);
      if (options.exit === undefined || deployment.exitController === undefined) {
        throw new OwnerRouteError(503, "EXIT_UNAVAILABLE", "Arbitrum Sepolia exit is not configured.");
      }
      await requireChain();
      const result = await createArbitrumSepoliaExitOrder({
        deployment,
        port,
        runtime: options.exit.runtime,
        orders: options.exit.orders,
        owner,
        slippageBps: body.slippageBps,
        idempotencyKey: body.idempotencyKey,
      });
      return {
        status: "UNSIGNED_CREATED",
        created: result.created,
        order: result.record,
        packageId: result.packageId,
        quantityAtoms: result.limits.quantityAtoms.toString(),
        limits: {
          entryNotionalAtoms: result.limits.entryNotionalAtoms.toString(),
          minSpotQuoteOutAtoms: result.limits.minSpotQuoteOutAtoms.toString(),
          minPerpOutputAtoms: result.limits.minPerpOutputAtoms.toString(),
          minExitQuoteOutcomeAtoms: result.limits.minExitQuoteOutcomeAtoms.toString(),
        },
        traderAuthorization: "REQUIRED",
        solverQuoting: "REQUIRED",
      };
    },
    [ARBITRUM_SEPOLIA_PREPARE_EXIT_AUTHORIZATION_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      const { attemptId } = exactStrings(await readJson(request), ["attemptId"]);
      selectedAttempt(attemptId!);
      return checkedExit(attemptId!, await executor.prepareExit(attemptId!));
    },
    [ARBITRUM_SEPOLIA_AUTHORIZE_EXIT_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      const { attemptId, ownerSignature } = exactStrings(await readJson(request), ["attemptId", "ownerSignature"]);
      selectedAttempt(attemptId!);
      return checkedExit(attemptId!, await executor.authorizeExit(attemptId!, requireOwnerSignature(ownerSignature)));
    },
    [ARBITRUM_SEPOLIA_PREPARE_OWNER_AUTHORIZATION_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      const { attemptId } = exactStrings(await readJson(request), ["attemptId"]);
      const owner = attemptOwner(attemptId!);
      return checked(await executor.prepare(attemptId!), owner);
    },
    [ARBITRUM_SEPOLIA_AUTHORIZE_OWNER_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      const { attemptId, ownerSignature } = exactStrings(await readJson(request), ["attemptId", "ownerSignature"]);
      const owner = attemptOwner(attemptId!);
      return checked(await executor.authorize(attemptId!, ownerSignature!), owner);
    },
  };

  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://private-terminal.local");
    const handler = handlers[url.pathname];
    if (handler === undefined) return false;
    // The same exact-origin browser policy as the private terminal routes.
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!isAllowedTerminalOrigin(options.terminalOrigin, origin)) {
        reject(response, 403, "ORIGIN_NOT_ALLOWED", "Browser origin is not allowed.");
        return true;
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      if (origin === undefined) {
        reject(response, 403, "ORIGIN_REQUIRED", "Preflight requires an allowed browser origin.");
      } else {
        response.statusCode = 204;
        response.end();
      }
      return true;
    }
    void handler(request, url).then(
      (body) => send(response, 200, body),
      (error: unknown) => {
        if (error instanceof OwnerRouteError) {
          reject(response, error.status, error.code, error.message);
        } else if (error instanceof InternalOrderConflictError) {
          reject(response, 409, error.code, error.message);
        } else if (error instanceof ArbitrumSepoliaExitError || error instanceof EntryOrderValidationError) {
          const status = error.code === "INVALID_SIGNATURE" || error.code === "EXCESS_SLIPPAGE" ? 400
            : error.code === "INVALID_EXECUTOR_RESPONSE" || error.code === "CHAIN_MISMATCH" ? 502 : 409;
          reject(response, status, error.code, error.message);
        } else if (error instanceof ArbitrumSepoliaHandoffError) {
          const status = error.code === "INVALID_SIGNATURE" || error.code === "INVALID_REQUEST"
            || error.code === "ACCOUNT_MISMATCH" || error.code === "ACCOUNT_NOT_CREATED" ? 400
            : error.code === "NOT_PREPARED" || error.code === "ATTEMPT_NOT_FOUND" ? 404
              : error.code === "EXECUTOR_UNREACHABLE" || error.code === "INVALID_EXECUTOR_RESPONSE"
                || error.code === "EXECUTOR_REJECTED" ? 502 : 409;
          reject(response, status, error.code, error.message);
        } else {
          reject(response, 502, "ARBITRUM_OWNER_ROUTE_FAILED", "Arbitrum Sepolia owner route failed closed.");
        }
      },
    );
    return true;
  };
}
