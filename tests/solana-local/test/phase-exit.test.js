import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  fromProtocolJson,
  packageOrderHash,
  quoteHash,
  routeHash,
  routePayload,
  routePayloadBytes,
  solverQuote,
  solverQuoteBytes,
  solverSignatureDigest,
  toProtocolJson,
} from "@naryx/protocol-types";
import { parseSolanaLocalEnvironmentManifest } from "@naryx/adapter-core";
import { SolanaConformanceAdapter } from "@naryx/adapter-solana";
import {
  ConnectionSolanaLocalExecutionRpc,
  createCanonicalExitOrder,
  createLocalAtomicOrderRuntime,
  createPrivateTerminalServer,
  HttpInternalSolverQuoteClient,
  HttpSolanaLocalExecutionAuthorizationClient,
  loadSolanaLocalEnvironmentRuntime,
  LocalExecutionCoordinator,
  SolanaLocalExecutionService,
  SqliteExecutionIntentStore,
  SqliteInternalOrderStore,
  SqlitePackageLifecycleStore,
  SqliteSolanaLocalPreparedExecutionStore,
  verifySolverAtomicQuoteResponse,
} from "@naryx/api";
import {
  createInternalAtomicQuoteCoordinator,
  createInternalAtomicQuoteServer,
  createLocalAtomicMarketRuntime,
  HttpInternalOrderProvider,
  HttpSelectedSolanaAdmissionProvider,
  SolanaExecutionAuthorizationService,
  SqliteInternalAtomicQuoteStore,
  SqliteSolanaExecutionAuthorizationStore,
} from "@naryx/solver";

import { withLocalSolanaEnvironment } from "../src/environment.js";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function signerFor(keypair) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      PKCS8_PREFIX,
      Buffer.from(keypair.secretKey.subarray(0, 32)),
    ]),
    format: "der",
    type: "pkcs8",
  });
  return Object.freeze({
    verificationKey: keypair.publicKey.toBytes(),
    signDigest: (digest) =>
      Uint8Array.from(sign(null, Buffer.from(digest), privateKey)),
    signBytes: (bytes) =>
      bs58.encode(sign(null, Buffer.from(bytes), privateKey)),
    signTransaction: (prepared) => {
      const transaction = VersionedTransaction.deserialize(
        Buffer.from(prepared.unsignedTransactionBase64, "base64"),
      );
      transaction.signatures[0] = sign(
        null,
        Buffer.from(transaction.message.serialize()),
        privateKey,
      );
      return Buffer.from(transaction.serialize()).toString("base64");
    },
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function json(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json();
  assert.ok(
    response.ok,
    `${path} returned ${response.status}: ${JSON.stringify(value)}`,
  );
  return value;
}

async function waitForResult(origin, attemptId, rpc) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const result = await json(
      origin,
      `/internal/terminal/attempts/${attemptId}/solana-local/reconcile`,
      {},
    );
    if (result.status === "CONSENSUS_VERIFIED" || result.status === "FAILED")
      return result;
    if (Date.now() >= deadline) {
      throw new Error(
        `attempt ${attemptId} did not settle${rpc.lastSendError ? `: ${rpc.lastSendError}` : ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function tokenBalances(environment) {
  const names = [
    "trader-base",
    "trader-quote",
    "spotBaseVault",
    "spotQuoteVault",
    "perpQuoteVault",
  ];
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        BigInt(
          (
            await environment.connection.getTokenAccountBalance(
              new PublicKey(environment.manifest.accounts[name]),
              "confirmed",
            )
          ).value.amount,
        ),
      ]),
    ),
  );
}

class FaultInjectingRpc extends ConnectionSolanaLocalExecutionRpc {
  constructor(connection) {
    super(connection);
    this.connection = connection;
    this.loseNextResponse = false;
    this.hideNextStatus = false;
    this.broadcastFailedSimulation = false;
  }

  async sendRawTransaction(bytes) {
    let signature;
    try {
      signature = await this.connection.sendRawTransaction(bytes, {
        skipPreflight: this.broadcastFailedSimulation,
        maxRetries: 0,
      });
    } catch (error) {
      this.lastSendError = error;
      throw error;
    }
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      this.hideNextStatus = true;
      throw new Error("injected response loss after validator acceptance");
    }
    return signature;
  }

  async getSignatureStatus(signature) {
    if (this.hideNextStatus) {
      this.hideNextStatus = false;
      return null;
    }
    return super.getSignatureStatus(signature);
  }
}

function buildExitQuote({
  order,
  entryRoute,
  manifest,
  signer,
  currentSlot,
  idempotencyKey,
  entryReceiptAddress,
}) {
  const orderHash = packageOrderHash(order);
  const route = routePayload({
    ...entryRoute,
    orderHash,
    action: "EXIT",
    routeExpiryValue: currentSlot + 32n,
    accountBindings: [
      ...entryRoute.accountBindings,
      { routeBindingId: "entry-receipt", accountIdentity: entryReceiptAddress },
    ],
    actions: entryRoute.actions.map((action, index) =>
      index === 0
        ? {
            ...action,
            accountMetas: [
              ...action.accountMetas,
              {
                routeBindingId: "entry-receipt",
                isSigner: false,
                isWritable: false,
              },
            ],
          }
        : action,
    ),
    legs: entryRoute.legs.map((leg) => ({
      ...leg,
      side: leg.legRole === "SPOT" ? "SELL" : "BUY",
      reduceOnly: true,
    })),
  });
  const routeHashValue = routeHash(route);
  const quoteAsset = order.minSpotQuoteOut.asset;
  const zeroBase = { asset: order.quantity.asset, atoms: 0n };
  const unsigned = {
    version: 1,
    environment: order.environment,
    domain: order.domain,
    orderHash,
    solverId: manifest.identities.solver,
    solverCapabilityManifestHash:
      manifest.runtime.catalog.solver.capabilityManifestHash,
    solverSignatureScheme: "ED25519",
    solverVerificationKey: signer.verificationKey,
    quoteMode: "EXECUTION_COMMITMENT",
    routeHash: routeHashValue,
    quotedOutcome: {
      kind: "EXIT_QUOTE_OUTCOME",
      exitQuoteOutcome: {
        asset: quoteAsset,
        atoms: order.minExitQuoteOutcome.atoms,
      },
    },
    expectedSpotNotional: {
      asset: quoteAsset,
      atoms: order.minSpotQuoteOut.atoms,
    },
    expectedPerpNotional: {
      asset: quoteAsset,
      atoms: order.expectedPrePositionEntryNotional.atoms,
    },
    expectedGrossSpotQuantity: order.quantity,
    expectedNetSpotQuantity: order.quantity,
    expectedBaseAssetFee: zeroBase,
    expectedMarginDelta: { asset: quoteAsset, atoms: 0n },
    expectedRawFillFeesByAsset: [zeroBase],
    expectedBuilderFeesByAsset: [zeroBase],
    expectedNormalizedVenueFeesByAsset: [zeroBase],
    solverFee: { asset: quoteAsset, atoms: 0n },
    protocolFee: { asset: quoteAsset, atoms: 0n },
    expectedPriorityFee: { asset: quoteAsset, atoms: 0n },
    maxRecoveryCostAtomsByAsset: [],
    feePolicyVersion: manifest.runtime.catalog.feePolicy.version,
    feePolicyManifestHash: manifest.runtime.catalog.feePolicy.manifestHash,
    validUntilUnit: order.expiryUnit,
    validUntilValue: currentSlot + 32n,
    quoteNonce: currentSlot,
    signature: new Uint8Array(64),
  };
  const draft = solverQuote(unsigned);
  const quote = solverQuote({
    ...unsigned,
    signature: signer.signDigest(solverSignatureDigest(draft)),
  });
  return Object.freeze({
    version: 1,
    status: "SIGNED",
    idempotencyKey,
    orderHash: Buffer.from(orderHash).toString("hex"),
    routeHash: Buffer.from(routeHashValue).toString("hex"),
    quoteHash: Buffer.from(quoteHash(quote)).toString("hex"),
    solverSignatureDigest: Buffer.from(solverSignatureDigest(quote)).toString(
      "hex",
    ),
    routeBytes: Buffer.from(routePayloadBytes(route)).toString("hex"),
    solverQuoteBytes: Buffer.from(solverQuoteBytes(quote)).toString("hex"),
    route: toProtocolJson(route, "exit.route"),
    quote: toProtocolJson(quote, "exit.quote"),
  });
}

test(
  "runs the local Solana entry, failure rollback, restart, and canonical exit",
  { timeout: 180_000 },
  async () => {
    const apiState = mkdtempSync(join(tmpdir(), "naryx-phase5-api-"));
    const solverState = mkdtempSync(join(tmpdir(), "naryx-phase5-solver-"));
    const traderState = mkdtempSync(join(tmpdir(), "naryx-phase5-trader-"));
    try {
      await withLocalSolanaEnvironment(async (environment) => {
        const manifest = parseSolanaLocalEnvironmentManifest(
          environment.manifest,
        );
        let activeSlot = BigInt(
          await environment.connection.getSlot("confirmed"),
        );
        const runtime = createLocalAtomicOrderRuntime(
          manifest.runtime.catalog,
          () => activeSlot,
          async () => activeSlot,
        );
        const trader = signerFor(environment.identities.trader);
        const solverSigner = signerFor(environment.identities.solver);
        const adapter = new SolanaConformanceAdapter({
          connection: environment.connection,
          domain: manifest.runtime.catalog.domain,
          environment: "local",
          expectedGenesisHash: manifest.rpc.genesisHash,
          executionSignatureProvider: () => {
            throw new Error("authorization boundary required");
          },
        });
        const rpc = new FaultInjectingRpc(environment.connection);
        const apiPort = await availablePort();
        const solverPort = await availablePort();
        const apiOrigin = `http://127.0.0.1:${apiPort}`;
        const solverOrigin = `http://127.0.0.1:${solverPort}`;
        const paths = {
          orders: join(apiState, "orders.db"),
          intents: join(apiState, "intents.db"),
          lifecycle: join(apiState, "lifecycle.db"),
          preparations: join(apiState, "preparations.db"),
          quotes: join(solverState, "quotes.db"),
          authorizations: join(solverState, "authorizations.db"),
        };
        let entryRoute;
        let entryAttemptId;
        let entryReceipt;
        let api;
        let solver;
        let stores;

        const start = async () => {
          const orders = new SqliteInternalOrderStore(paths.orders);
          const intents = new SqliteExecutionIntentStore(paths.intents);
          const lifecycle = new SqlitePackageLifecycleStore(paths.lifecycle);
          const preparations = new SqliteSolanaLocalPreparedExecutionStore(
            paths.preparations,
          );
          const quotes = new SqliteInternalAtomicQuoteStore(paths.quotes);
          const authorizations = new SqliteSolanaExecutionAuthorizationStore(
            paths.authorizations,
          );
          const coordinator = new LocalExecutionCoordinator({
            orders,
            intents,
            lifecycle,
          });
          const orderProvider = new HttpInternalOrderProvider(apiOrigin);
          let quoteSlot = BigInt(manifest.rpc.manifestSlot);
          const market = createLocalAtomicMarketRuntime(
            manifest.runtime.catalog,
            undefined,
            () => quoteSlot,
          );
          const entryQuotes = createInternalAtomicQuoteCoordinator({
            orders: orderProvider.get,
            candidates: market.providers.candidates,
            terms: market.providers.terms,
            signer: solverSigner,
            store: quotes,
          });
          const quotePort = {
            quote: async (request) => {
              quoteSlot = BigInt(
                await environment.connection.getSlot("confirmed"),
              );
              const order = await orderProvider.get(
                Uint8Array.from(Buffer.from(request.orderHash, "hex")),
              );
              if (order?.action !== "EXIT") return entryQuotes.quote(request);
              assert.ok(entryRoute && entryReceipt);
              return buildExitQuote({
                order,
                entryRoute,
                manifest,
                signer: solverSigner,
                currentSlot: BigInt(
                  await environment.connection.getSlot("confirmed"),
                ),
                idempotencyKey: request.idempotencyKey,
                entryReceiptAddress: entryReceipt.address.toBase58(),
              });
            },
          };
          const selected = new HttpSelectedSolanaAdmissionProvider(apiOrigin);
          const authorization = new SolanaExecutionAuthorizationService({
            manifest,
            selectedAdmission: selected.get,
            compiler: adapter,
            signer: solverSigner,
            store: authorizations,
            readSlot: async () =>
              BigInt(await environment.connection.getSlot("confirmed")),
          });
          solver = createInternalAtomicQuoteServer(quotePort, authorization);
          const live = await loadSolanaLocalEnvironmentRuntime(
            environment.manifestPath,
            manifest.identities.solver,
          );
          const execution = new SolanaLocalExecutionService({
            manifest,
            intents,
            orders,
            authorization: new HttpSolanaLocalExecutionAuthorizationClient(
              solverOrigin,
            ),
            adapter,
            rpc,
            store: preparations,
            lifecycle: coordinator,
            validateLive: async () => {
              await live.readSlot();
            },
          });
          api = createPrivateTerminalServer(
            { host: "127.0.0.1", port: apiPort, terminalOrigin: null },
            {},
            { contexts: runtime.contexts, store: orders, clock: runtime.clock },
            undefined,
            {},
            lifecycle,
            new HttpInternalSolverQuoteClient(solverOrigin),
            intents,
            coordinator,
            undefined,
            "MANIFEST_VALIDATED",
            execution,
          );
          await listen(api, apiPort);
          await listen(solver, solverPort);
          stores = {
            orders,
            intents,
            lifecycle,
            preparations,
            quotes,
            authorizations,
          };
        };

        const stop = async () => {
          await close(api);
          await close(solver);
          for (const store of Object.values(stores ?? {})) store.close();
          stores = undefined;
        };

        const createEntryAttempt = async (suffix, size = "1") => {
          activeSlot = BigInt(
            await environment.connection.getSlot("confirmed"),
          );
          const created = await json(apiOrigin, "/internal/terminal/orders", {
            contextId: manifest.runtime.catalog.contextId,
            owner: manifest.identities.trader,
            settlementAccount: manifest.accounts.position,
            size,
            slippageBps:
              manifest.runtime.catalog.orderLimits.maximumSlippageBps,
            idempotencyKey: `phase5-entry-${suffix}`,
          });
          const orderHashHex = created.order.orderHashHex;
          const order = stores.orders.getCanonicalOrderByHash(orderHashHex);
          await json(
            apiOrigin,
            `/internal/terminal/orders/${orderHashHex}/authorize`,
            {
              signature: trader.signBytes(
                Buffer.from(created.order.orderBase64, "base64"),
              ),
            },
          );
          const quoted = await json(
            apiOrigin,
            `/internal/terminal/orders/${orderHashHex}/quote`,
            {
              idempotencyKey: `phase5-quote-${suffix}`,
            },
          );
          verifySolverAtomicQuoteResponse(
            quoted,
            order,
            await runtime.clock.currentClock(
              runtime.contexts(manifest.runtime.catalog.contextId),
            ),
          );
          const selected = await json(
            apiOrigin,
            `/internal/terminal/orders/${orderHashHex}/select`,
            {
              quoteHash: quoted.quoteHash,
            },
          );
          return { attemptId: selected.attempt.attemptId, quoted };
        };

        try {
          await start();
          const entry = await createEntryAttempt("00000001");
          entryAttemptId = entry.attemptId;
          entryRoute = routePayload(
            fromProtocolJson(entry.quoted.route, "entry.route"),
          );
          const prepared = await json(
            apiOrigin,
            `/internal/terminal/attempts/${entryAttemptId}/solana-local/prepare`,
            {},
          );
          rpc.loseNextResponse = true;
          const ambiguous = await json(
            apiOrigin,
            `/internal/terminal/attempts/${entryAttemptId}/solana-local/submit`,
            { signedTransactionBase64: trader.signTransaction(prepared) },
          );
          assert.equal(ambiguous.status, "SUBMITTED_UNKNOWN");

          await stop();
          await start();
          const opened = await waitForResult(apiOrigin, entryAttemptId, rpc);
          assert.equal(opened.status, "CONSENSUS_VERIFIED");
          const entryAdmission =
            stores.intents.getSelectedQuote(entryAttemptId);
          const canonicalEntry = stores.orders.getCanonicalOrderByHash(
            stores.intents.getAttempt(entryAttemptId).orderHash,
          );
          entryReceipt = (
            await adapter.readEvidence(
              stores.preparations.get(entryAttemptId).receiptAddress,
              {
                order: canonicalEntry,
                route: routePayload(
                  fromProtocolJson(entryAdmission.route, "entry.route"),
                ),
                quote: solverQuote(
                  fromProtocolJson(entryAdmission.quote, "entry.quote"),
                ),
                orderHash: packageOrderHash(canonicalEntry),
                routeHash: routeHash(
                  fromProtocolJson(entryAdmission.route, "entry.route"),
                ),
                quoteHash: quoteHash(
                  fromProtocolJson(entryAdmission.quote, "entry.quote"),
                ),
              },
            )
          ).receipt;
          const openPosition = adapter.decodePosition(
            (
              await environment.connection.getAccountInfo(
                new PublicKey(manifest.accounts.position),
                "confirmed",
              )
            ).data,
          );
          assert.equal(openPosition.shortBaseAtoms, 1_000_000n);
          assert.equal(openPosition.collateralQuoteAtoms, 400_000n);

          const beforeFailure = await tokenBalances(environment);
          const beforeFailurePosition = openPosition;
          // Size 10 fills the venue perp cap when added to the open 1-unit
          // position, so the spot leg succeeds but the perp leg fails and the
          // whole transaction rolls back atomically.
          const failing = await createEntryAttempt("00000002", "10");
          const failingPrepared = await json(
            apiOrigin,
            `/internal/terminal/attempts/${failing.attemptId}/solana-local/prepare`,
            {},
          );
          rpc.broadcastFailedSimulation = true;
          const failedSubmission = await json(
            apiOrigin,
            `/internal/terminal/attempts/${failing.attemptId}/solana-local/submit`,
            {
              signedTransactionBase64: trader.signTransaction(failingPrepared),
            },
          );
          const failed =
            failedSubmission.status === "FAILED"
              ? failedSubmission
              : await waitForResult(apiOrigin, failing.attemptId, rpc);
          rpc.broadcastFailedSimulation = false;
          assert.equal(failed.status, "FAILED");
          assert.equal(
            await environment.connection.getAccountInfo(
              new PublicKey(failingPrepared.receiptAddress),
              "confirmed",
            ),
            null,
          );
          assert.deepEqual(await tokenBalances(environment), beforeFailure);
          assert.deepEqual(
            adapter.decodePosition(
              (
                await environment.connection.getAccountInfo(
                  new PublicKey(manifest.accounts.position),
                  "confirmed",
                )
              ).data,
            ),
            beforeFailurePosition,
          );
          const failedTransaction = await environment.connection.getTransaction(
            failed.signature,
            {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            },
          );
          assert.notEqual(failedTransaction?.meta?.err, null);

          await stop();
          await start();
          const currentSlot = BigInt(
            await environment.connection.getSlot("confirmed"),
          );
          activeSlot = currentSlot;
          const exitRequest = {
            contextId: manifest.runtime.catalog.contextId,
            owner: manifest.identities.trader,
            settlementAccount: manifest.accounts.position,
            entryReceiptHash: entryReceipt.executionDigest,
            positionSizeAtoms: entryReceipt.postShortBaseAtoms,
            positionEntryNotionalAtoms: entryReceipt.postCollateralQuoteAtoms,
            minSpotQuoteOutAtoms: 1_900_000n,
            minExitQuoteOutcomeAtoms: 1_900_000n,
            idempotencyKey: "phase5-exit-0000001",
            currentClock: currentSlot,
          };
          const canonicalExit = createCanonicalExitOrder(
            runtime.contexts,
            exitRequest,
          );
          const exitRecord = stores.orders.createOrGet({
            order: canonicalExit,
            request: exitRequest,
          }).record;
          await json(
            apiOrigin,
            `/internal/terminal/orders/${exitRecord.orderHashHex}/authorize`,
            {
              signature: trader.signBytes(canonicalExit.orderBytes),
            },
          );
          const exitQuote = await json(
            apiOrigin,
            `/internal/terminal/orders/${exitRecord.orderHashHex}/quote`,
            {
              idempotencyKey: "phase5-exit-quote-0001",
            },
          );
          verifySolverAtomicQuoteResponse(
            exitQuote,
            canonicalExit.order,
            currentSlot,
          );
          const selectedExit = await json(
            apiOrigin,
            `/internal/terminal/orders/${exitRecord.orderHashHex}/select`,
            {
              quoteHash: exitQuote.quoteHash,
            },
          );
          const exitAttemptId = selectedExit.attempt.attemptId;
          const exitPrepared = await json(
            apiOrigin,
            `/internal/terminal/attempts/${exitAttemptId}/solana-local/prepare`,
            {},
          );
          const exitSubmission = await json(
            apiOrigin,
            `/internal/terminal/attempts/${exitAttemptId}/solana-local/submit`,
            { signedTransactionBase64: trader.signTransaction(exitPrepared) },
          );
          const closed =
            exitSubmission.status === "CONSENSUS_VERIFIED"
              ? exitSubmission
              : await waitForResult(apiOrigin, exitAttemptId, rpc);
          assert.equal(closed.status, "CONSENSUS_VERIFIED");
          const closedPosition = adapter.decodePosition(
            (
              await environment.connection.getAccountInfo(
                new PublicKey(manifest.accounts.position),
                "confirmed",
              )
            ).data,
          );
          assert.equal(closedPosition.shortBaseAtoms, 0n);
          assert.equal(closedPosition.collateralQuoteAtoms, 0n);
          assert.deepEqual(await tokenBalances(environment), {
            "trader-base": 5_000_000n,
            "trader-quote": 49_990_000n,
            spotBaseVault: 100_000_000n,
            spotQuoteVault: 200_010_000n,
            perpQuoteVault: 100_000_000n,
          });
          const history = await json(
            apiOrigin,
            `/internal/terminal/lifecycle?attemptId=${entryAttemptId}`,
          );
          assert.equal(history.attempt.state, "CLOSED");
          assert.deepEqual(
            history.receipts.map((receipt) => receipt.nextState),
            [
              "PACKAGE_CREATED",
              "ENTRY_PREPARED",
              "ENTRY_SUBMITTED",
              "ENTRY_CONFIRMED",
              "OPEN",
              "EXIT_REQUESTED",
              "EXIT_SUBMITTED",
              "CLOSED",
            ],
          );
        } finally {
          await stop();
        }
      });
    } finally {
      rmSync(apiState, { recursive: true, force: true });
      rmSync(solverState, { recursive: true, force: true });
      rmSync(traderState, { recursive: true, force: true });
    }
    assert.equal(existsSync(apiState), false);
    assert.equal(existsSync(solverState), false);
    assert.equal(existsSync(traderState), false);
  },
);
