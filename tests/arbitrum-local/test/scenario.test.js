import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeAbiParameters,
  keccak256,
  padHex,
  parseEther,
  stringToHex,
  zeroHash,
} from "viem";
import {
  arbitrumLocalArtifacts,
  withLocalArbitrumEnvironment,
} from "../src/environment.js";

const executionFee = parseEther("0.002");
const collateralAtoms = 5_000_000n;
const spotBaseAtoms = 1_000_000n;
const maxSpotQuoteAtoms = 3_000_000n;
const sizeDeltaUsd = 4_000n * 10n ** 30n;

async function write(environment, wallet, address, abi, functionName, args = [], value) {
  const request = { address, abi, functionName, args };
  if (value !== undefined) request.value = value;
  const hash = await wallet.writeContract(request);
  return environment.client.waitForTransactionReceipt({ hash });
}

function requestParameter() {
  const item = arbitrumLocalArtifacts.coordinator.abi.find(
    (candidate) => candidate.type === "function" && candidate.name === "submitRequest",
  );
  if (!item) throw new Error("submitRequest ABI missing");
  return item.inputs[2];
}

async function buildRequest(environment) {
  const { client, contracts, manifest } = environment;
  const block = await client.getBlock();
  return {
    marketId: padHex(contracts.market, { size: 32 }),
    collateralToken: contracts.collateral,
    sizeDelta: -sizeDeltaUsd,
    collateralAtoms,
    acceptablePrice: 2_500n * 10n ** 30n,
    executionFeeWei: executionFee,
    callbackGasLimit: 2_000_000n,
    packageNonce: 0n,
    orderHash: keccak256(stringToHex("arbitrum-local-order")),
    quoteHash: keccak256(stringToHex("arbitrum-local-quote")),
    routeHash: keccak256(stringToHex("arbitrum-local-route")),
    spot: {
      fundingOwner: manifest.identities.solver,
      port: contracts.spotPort,
      portCodeHash: manifest.contracts.spotPort.codeHash,
      baseToken: contracts.base,
      quoteToken: contracts.collateral,
      baseAtoms: spotBaseAtoms,
      maxQuoteAtoms: maxSpotQuoteAtoms,
      rollbackMinQuoteAtoms: spotBaseAtoms,
      entryFillCommitment: keccak256(stringToHex("arbitrum-local-entry-fill")),
      rollbackFillCommitment: keccak256(stringToHex("arbitrum-local-rollback-fill")),
    },
    submissionDeadline: block.timestamp + 100n,
    venueDeadline: block.timestamp + 200n,
    recoveryDeadline: block.timestamp + 300n,
  };
}

async function buildTerms(environment, request) {
  const { client, contracts, manifest } = environment;
  const read = (functionName, args = []) => client.readContract({
    address: contracts.coordinator,
    abi: arbitrumLocalArtifacts.coordinator.abi,
    functionName,
    args,
  });
  const requestPayloadHash = keccak256(encodeAbiParameters([requestParameter()], [request]));
  const terms = {
    domain: {
      domainIdHash: keccak256(stringToHex(manifest.domain.domainId)),
      manifestVersion: manifest.domain.manifestVersion,
      manifestHash: manifest.domain.manifestHash,
    },
    owner: manifest.identities.trader,
    solver: manifest.identities.solver,
    adapter: contracts.adapter,
    handler: contracts.adapter,
    adapterCodeHash: manifest.contracts.adapter.codeHash,
    handlerCodeHash: manifest.contracts.adapter.codeHash,
    orderHash: request.orderHash,
    quoteHash: request.quoteHash,
    routeHash: request.routeHash,
    seriesIdentityKey: keccak256(stringToHex("arbitrum-local-series")),
    seriesBindingVersion: 1,
    seriesBindingHash: keccak256(stringToHex("arbitrum-local-series-binding")),
    executionClassIdentityHash: await read("EXECUTION_CLASS_ID"),
    executionClassManifestHash: await read("executionClassManifestHash"),
    requestPayloadHash,
    reservationHash: zeroHash,
    bondHash: zeroHash,
    recoveryPolicyHash: zeroHash,
    evidenceSchemaHash: await read("EVIDENCE_SCHEMA_ID"),
    bondRecipient: manifest.identities.solver,
    recoveryReserveRecipient: manifest.identities.recovery,
    slashRecipient: manifest.identities.recovery,
    lossAsset: contracts.collateral,
    residualAsset: contracts.collateral,
    bondAtoms: 100n,
    recoveryReserveAtoms: 25n,
    maxAggregateLossAtoms: 25n,
    maxIntermediateResidualAtoms: collateralAtoms,
    maxTerminalResidualAtoms: 1n,
    nonce: request.packageNonce,
    submissionDeadline: request.submissionDeadline,
    venueDeadline: request.venueDeadline,
    recoveryDeadline: request.recoveryDeadline,
  };
  terms.bondHash = await read("bondCommitment", [terms]);
  terms.reservationHash = await read("reservationCommitment", [terms]);
  terms.recoveryPolicyHash = await read("recoveryPolicyCommitment", [terms]);
  return terms;
}

test("rolls back a failed request creation then executes the admitted asynchronous entry", { timeout: 30_000 }, async () => {
  await withLocalArbitrumEnvironment(async (environment) => {
    const { accounts, client, contracts, manifest, wallets } = environment;
    const a = arbitrumLocalArtifacts;
    const request = await buildRequest(environment);
    const terms = await buildTerms(environment, request);
    const packageId = await client.readContract({
      address: contracts.coordinator,
      abi: a.coordinator.abi,
      functionName: "packageId",
      args: [terms],
    });
    const digest = await client.readContract({
      address: contracts.coordinator,
      abi: a.coordinator.abi,
      functionName: "reserveDigest",
      args: [terms],
    });
    const ownerSignature = await accounts.trader.sign({ hash: digest });
    assert.equal((await write(environment, wallets.solver, contracts.coordinator, a.coordinator.abi, "reserve", [terms, ownerSignature])).status, "success");
    assert.equal((await write(environment, wallets.solver, contracts.adapter, a.adapter.abi, "fundRequest", [packageId, request], executionFee)).status, "success");

    await write(environment, wallets.deployer, contracts.exchangeRouter, a.exchangeRouter.abi, "setFailCreate", [true]);
    await assert.rejects(
      wallets.solver.writeContract({
        address: contracts.coordinator,
        abi: a.coordinator.abi,
        functionName: "submitRequest",
        args: [packageId, 1n, request],
      }),
      /CREATE_FAILED|execution reverted/,
    );
    assert.equal(await client.readContract({
      address: contracts.base,
      abi: a.token.abi,
      functionName: "balanceOf",
      args: [contracts.account],
    }), 0n);
    const fundingAfterFailure = await client.readContract({
      address: contracts.adapter,
      abi: a.adapter.abi,
      functionName: "funding",
      args: [packageId],
    });
    assert.equal(fundingAfterFailure[5], false);

    await write(environment, wallets.deployer, contracts.exchangeRouter, a.exchangeRouter.abi, "setFailCreate", [false]);
    assert.equal((await write(environment, wallets.solver, contracts.coordinator, a.coordinator.abi, "submitRequest", [packageId, 1n, request])).status, "success");
    const requestKey = await client.readContract({
      address: contracts.adapter,
      abi: a.adapter.abi,
      functionName: "activeRequestKey",
    });
    assert.notEqual(requestKey, zeroHash);
    assert.equal((await write(environment, wallets.deployer, contracts.exchangeRouter, a.exchangeRouter.abi, "executeOrder", [requestKey, sizeDeltaUsd])).status, "success");
    const beforeRelay = await client.readContract({
      address: contracts.coordinator,
      abi: a.coordinator.abi,
      functionName: "packageState",
      args: [packageId],
    });
    assert.equal((await write(environment, wallets.deployer, contracts.adapter, a.adapter.abi, "relayEvidence", [requestKey, beforeRelay.stateVersion])).status, "success");
    const evidence = await client.readContract({
      address: contracts.adapter,
      abi: a.adapter.abi,
      functionName: "requestEvidence",
      args: [requestKey],
    });
    const packageState = await client.readContract({
      address: contracts.coordinator,
      abi: a.coordinator.abi,
      functionName: "packageState",
      args: [packageId],
    });
    assert.equal(evidence[0], 2);
    assert.equal(packageState.state, 4);
    assert.equal(packageState.requestKey, requestKey);
    assert.equal(packageState.terms.owner, manifest.identities.trader);
  });
});
