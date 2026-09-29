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
import { observeAsyncBondedPackage } from "@naryx/adapter-evm";
import {
  arbitrumLocalArtifacts,
  withLocalArbitrumEnvironment,
} from "../src/environment.js";

const executionFee = parseEther("0.002");
const collateralAtoms = 5_000_000n;
const spotBaseAtoms = 1_000_000n;
const maxSpotQuoteAtoms = 3_000_000n;
const sizeDeltaUsd = 4_000n * 10n ** 30n;

async function write(environment, wallet, address, abi, functionName, args = [], value, gas) {
  const request = { address, abi, functionName, args };
  if (value !== undefined) request.value = value;
  if (gas !== undefined) request.gas = gas;
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

function activeSpotRegistrationParameter() {
  const item = arbitrumLocalArtifacts.account.abi.find(
    (candidate) => candidate.type === "function" && candidate.name === "activeSpotRegistration",
  );
  if (!item) throw new Error("activeSpotRegistration ABI missing");
  return item.outputs[0];
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

test("rolls back a failed entry then executes and closes the asynchronous package", { timeout: 30_000 }, async () => {
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

    const registration = await client.readContract({
      address: contracts.account,
      abi: a.account.abi,
      functionName: "activeSpotRegistration",
    });
    const block = await client.getBlock();
    const authorization = {
      packageId,
      entryRequestKey: requestKey,
      spotRegistrationHash: keccak256(encodeAbiParameters([activeSpotRegistrationParameter()], [registration])),
      account: contracts.account,
      owner: manifest.identities.trader,
      receiver: manifest.identities.trader,
      spotProceedsRecipient: manifest.identities.trader,
      feePayer: manifest.identities.feePayer,
      executionFeeRefundRecipient: manifest.identities.recovery,
      market: contracts.market,
      collateralToken: contracts.collateral,
      isLong: false,
      fullCloseSizeUsd: sizeDeltaUsd,
      spotBaseAtoms,
      spotMinQuoteAtoms: spotBaseAtoms,
      packageNonce: request.packageNonce,
      exitOrderHash: keccak256(stringToHex("arbitrum-local-exit-order")),
      exitQuoteHash: keccak256(stringToHex("arbitrum-local-exit-quote")),
      exitRouteHash: keccak256(stringToHex("arbitrum-local-exit-route")),
      exitFillCommitment: keccak256(stringToHex("arbitrum-local-exit-fill")),
      acceptablePrice: 2_400n * 10n ** 30n,
      minOutputAmount: 1_000n * 10n ** 30n,
      executionFeeWei: executionFee,
      callbackGasLimit: 2_000_000n,
      authorizationExpiry: block.timestamp + 100n,
      cancelAfter: block.timestamp + 200n,
      nonce: await client.readContract({
        address: contracts.exitController,
        abi: a.exitController.abi,
        functionName: "nextNonce",
      }),
    };
    const exitDigest = await client.readContract({
      address: contracts.exitController,
      abi: a.exitController.abi,
      functionName: "exitDigest",
      args: [authorization],
    });
    const exitSignature = await accounts.trader.sign({ hash: exitDigest });
    assert.equal((await write(
      environment,
      wallets.feePayer,
      contracts.exitController,
      a.exitController.abi,
      "submitFullClose",
      [authorization, exitSignature],
      executionFee,
    )).status, "success");
    const exitRequestKey = await client.readContract({
      address: contracts.exitController,
      abi: a.exitController.abi,
      functionName: "activeExitRequestKey",
    });
    assert.notEqual(exitRequestKey, zeroHash);
    assert.equal((await write(
      environment,
      wallets.deployer,
      contracts.exchangeRouter,
      a.exchangeRouter.abi,
      "executeDecreaseOrder",
      [exitRequestKey, 0n, collateralAtoms],
      undefined,
      8_000_000n,
    )).status, "success");
    const exitEvidence = await client.readContract({
      address: contracts.exitController,
      abi: a.exitController.abi,
      functionName: "exitEvidence",
      args: [exitRequestKey],
    });
    const finalReceipt = await client.readContract({
      address: contracts.exitController,
      abi: a.exitController.abi,
      functionName: "finalPackageReceipt",
      args: [exitRequestKey],
    });
    assert.equal(exitEvidence[0], 2);
    assert.equal(exitEvidence[4], true);
    assert.notEqual(finalReceipt.commitment, zeroHash);
    assert.equal(finalReceipt.packageId, packageId);
    assert.equal(finalReceipt.entryRequestKey, requestKey);
    assert.equal(finalReceipt.exitRequestKey, exitRequestKey);
    assert.equal(finalReceipt.terminalState, 1);
    assert.equal(await client.readContract({
      address: contracts.base,
      abi: a.token.abi,
      functionName: "balanceOf",
      args: [contracts.account],
    }), 0n);
    assert.equal(await client.readContract({
      address: contracts.collateral,
      abi: a.token.abi,
      functionName: "balanceOf",
      args: [contracts.account],
    }), 0n);
    const beforeClose = await client.readContract({
      address: contracts.coordinator,
      abi: a.coordinator.abi,
      functionName: "packageState",
      args: [packageId],
    });
    assert.equal((await write(
      environment,
      wallets.deployer,
      contracts.coordinator,
      a.coordinator.abi,
      "close",
      [packageId, beforeClose.stateVersion],
    )).status, "success");
    const closed = await client.readContract({
      address: contracts.coordinator,
      abi: a.coordinator.abi,
      functionName: "packageState",
      args: [packageId],
    });
    assert.equal(closed.state, 10);
    const observation = await observeAsyncBondedPackage({
      chainId: async () => BigInt(await client.getChainId()),
      transactionReceipt: async () => null,
      readContract: ({ address, abi, functionName, args }) => client.readContract({
        address,
        abi,
        functionName,
        ...(args === undefined ? {} : { args }),
      }),
      chainHead: async () => {
        const latestBlock = await client.getBlockNumber();
        return { latestBlock, finalizedBlock: latestBlock };
      },
    }, {
      chainReference: BigInt(manifest.chainId),
      coordinator: contracts.coordinator,
      entryAdapter: contracts.adapter,
      handler: contracts.adapter,
      exitController: contracts.exitController,
      owner: manifest.identities.trader,
      orderHash: request.orderHash,
      quoteHash: request.quoteHash,
      routeHash: request.routeHash,
      domainIdHash: terms.domain.domainIdHash,
      domainManifestVersion: terms.domain.manifestVersion,
      domainManifestHash: terms.domain.manifestHash,
      executionClassManifestHash: terms.executionClassManifestHash,
    }, {
      packageId,
      entryRequestKey: requestKey,
      exitRequestKey,
    });
    assert.equal(observation.lifecycle, "CLOSED");
    assert.equal(observation.evidenceGrade, "finalized-contract-receipt");
    assert.equal(observation.exitCompleted, true);
    assert.equal(observation.finalReceipt?.commitment, finalReceipt.commitment);
  });
});
