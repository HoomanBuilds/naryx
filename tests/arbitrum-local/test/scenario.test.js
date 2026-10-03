import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeAbiParameters,
  hashTypedData,
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
// The conformance spot pool fills at two quote atoms per base atom in both directions.
const spotQuoteAtoms = 2n * spotBaseAtoms;
const sizeDeltaUsd = 4_000n * 10n ** 30n;

async function write(environment, wallet, address, abi, functionName, args = [], value, gas) {
  const request = { address, abi, functionName, args };
  if (value !== undefined) request.value = value;
  if (gas !== undefined) request.gas = gas;
  const hash = await wallet.writeContract(request);
  return environment.client.waitForTransactionReceipt({ hash });
}

function abiFunction(abi, name) {
  const item = abi.find((candidate) => candidate.type === "function" && candidate.name === name);
  if (!item) throw new Error(`${name} ABI missing`);
  return item;
}

function requestParameter() {
  return abiFunction(arbitrumLocalArtifacts.coordinator.abi, "submitRequest").inputs[2];
}

function activeSpotRegistrationParameter() {
  return abiFunction(arbitrumLocalArtifacts.account.abi, "activeSpotRegistration").outputs[0];
}

function termsHash(terms) {
  return keccak256(encodeAbiParameters([abiFunction(arbitrumLocalArtifacts.coordinator.abi, "reserveDigest").inputs[0]], [terms]));
}

// The owner signs EIP-712 typed data built here from the contract ABI, not a digest read back from chain.
function reserveTypedData(environment, terms) {
  return {
    domain: {
      name: "Naryx Async Bonded Package",
      version: "1",
      chainId: environment.manifest.chainId,
      verifyingContract: environment.contracts.coordinator,
    },
    types: { ReserveAsyncPackage: [{ name: "termsHash", type: "bytes32" }] },
    primaryType: "ReserveAsyncPackage",
    message: { termsHash: termsHash(terms) },
  };
}

function exitTypedData(environment, authorization) {
  const fields = abiFunction(arbitrumLocalArtifacts.exitController.abi, "exitDigest").inputs[0].components
    .map(({ name, type }) => ({ name, type }));
  return {
    domain: {
      name: "Naryx GMX V2 Exit",
      version: "1",
      chainId: environment.manifest.chainId,
      verifyingContract: environment.contracts.exitController,
    },
    types: { ExitAuthorization: fields },
    primaryType: "ExitAuthorization",
    message: authorization,
  };
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
    packageNonce: await client.readContract({
      address: contracts.coordinator,
      abi: arbitrumLocalArtifacts.coordinator.abi,
      functionName: "nextNonce",
      args: [manifest.identities.trader],
    }),
    orderHash: keccak256(stringToHex("arbitrum-local-order")),
    quoteHash: keccak256(stringToHex("arbitrum-local-quote")),
    routeHash: keccak256(stringToHex("arbitrum-local-route")),
    spot: {
      fundingOwner: manifest.identities.trader,
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
    const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
    const balance = (token, owner) => read(token, a.token.abi, "balanceOf", [owner]);
    const trader = manifest.identities.trader;
    const request = await buildRequest(environment);
    const terms = await buildTerms(environment, request);
    const packageId = await read(contracts.coordinator, a.coordinator.abi, "packageId", [terms]);
    const reservation = reserveTypedData(environment, terms);
    assert.equal(packageId, keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }],
      [BigInt(manifest.chainId), contracts.coordinator, reservation.message.termsHash],
    )));
    assert.equal(hashTypedData(reservation), await read(contracts.coordinator, a.coordinator.abi, "reserveDigest", [terms]));
    const ownerSignature = await accounts.trader.signTypedData(reservation);
    assert.equal((await write(environment, wallets.solver, contracts.coordinator, a.coordinator.abi, "reserve", [terms, ownerSignature])).status, "success");
    assert.equal(await read(contracts.coordinator, a.coordinator.abi, "nextNonce", [trader]), request.packageNonce + 1n);

    const traderBeforeEntry = await balance(contracts.collateral, trader);
    assert.equal((await write(environment, wallets.trader, contracts.adapter, a.adapter.abi, "fundRequest", [packageId, request], executionFee)).status, "success");
    const fundedAtoms = collateralAtoms + maxSpotQuoteAtoms;
    assert.equal(await balance(contracts.collateral, contracts.adapter), fundedAtoms);
    assert.equal(await read(contracts.adapter, a.adapter.abi, "unconsumedFundingAtoms"), fundedAtoms);

    await write(environment, wallets.deployer, contracts.exchangeRouter, a.exchangeRouter.abi, "setFailCreate", [true]);
    const poolBaseBefore = await balance(contracts.base, contracts.spotPool);
    const poolQuoteBefore = await balance(contracts.collateral, contracts.spotPool);
    await assert.rejects(
      wallets.solver.writeContract({
        address: contracts.coordinator,
        abi: a.coordinator.abi,
        functionName: "submitRequest",
        args: [packageId, 1n, request],
      }),
      /CREATE_FAILED/,
    );
    assert.equal(await balance(contracts.base, contracts.account), 0n);
    assert.equal(await balance(contracts.collateral, contracts.account), 0n);
    assert.equal(await balance(contracts.base, contracts.spotPool), poolBaseBefore);
    assert.equal(await balance(contracts.collateral, contracts.spotPool), poolQuoteBefore);
    assert.equal(await balance(contracts.collateral, contracts.adapter), fundedAtoms);
    assert.equal(await client.getBalance({ address: contracts.adapter }), executionFee);
    assert.equal(await read(contracts.account, a.account.abi, "hasActiveSpotInventory"), false);
    assert.equal(await read(contracts.adapter, a.adapter.abi, "activeRequestKeyOf", [contracts.account]), zeroHash);
    const fundingAfterFailure = await read(contracts.adapter, a.adapter.abi, "funding", [packageId, trader]);
    assert.equal(fundingAfterFailure[0], contracts.account);
    assert.equal(fundingAfterFailure[6], false);
    const reservedAfterFailure = await read(contracts.coordinator, a.coordinator.abi, "packageState", [packageId]);
    assert.equal(reservedAfterFailure.state, 1);
    assert.equal(reservedAfterFailure.stateVersion, 1n);

    await write(environment, wallets.deployer, contracts.exchangeRouter, a.exchangeRouter.abi, "setFailCreate", [false]);
    assert.equal((await write(environment, wallets.solver, contracts.coordinator, a.coordinator.abi, "submitRequest", [packageId, 1n, request])).status, "success");
    const requestKey = await read(contracts.adapter, a.adapter.abi, "activeRequestKeyOf", [contracts.account]);
    assert.notEqual(requestKey, zeroHash);
    assert.equal(await read(contracts.adapter, a.adapter.abi, "requestAccount", [requestKey]), contracts.account);
    assert.equal(await read(contracts.adapter, a.adapter.abi, "activePackageOf", [contracts.account]), packageId);
    assert.equal(await balance(contracts.base, contracts.account), spotBaseAtoms);
    assert.equal(await balance(contracts.collateral, contracts.orderVault), collateralAtoms);
    assert.equal(await balance(contracts.collateral, trader), traderBeforeEntry - collateralAtoms - spotQuoteAtoms);
    assert.equal(await read(contracts.adapter, a.adapter.abi, "unconsumedFundingAtoms"), 0n);
    assert.equal((await write(environment, wallets.deployer, contracts.exchangeRouter, a.exchangeRouter.abi, "executeOrder", [requestKey, sizeDeltaUsd])).status, "success");
    const beforeRelay = await read(contracts.coordinator, a.coordinator.abi, "packageState", [packageId]);
    assert.equal((await write(environment, wallets.deployer, contracts.adapter, a.adapter.abi, "relayEvidence", [requestKey, beforeRelay.stateVersion])).status, "success");
    const evidence = await read(contracts.adapter, a.adapter.abi, "requestEvidence", [requestKey]);
    const packageState = await read(contracts.coordinator, a.coordinator.abi, "packageState", [packageId]);
    assert.equal(evidence[0], 2);
    assert.equal(evidence[3], sizeDeltaUsd);
    assert.equal(packageState.state, 4);
    assert.equal(packageState.requestKey, requestKey);
    assert.equal(packageState.terms.owner, trader);

    const registration = await read(contracts.account, a.account.abi, "activeSpotRegistration");
    assert.equal(registration.fundingOwner, trader);
    const block = await client.getBlock();
    const authorization = {
      packageId,
      entryRequestKey: requestKey,
      spotRegistrationHash: keccak256(encodeAbiParameters([activeSpotRegistrationParameter()], [registration])),
      account: contracts.account,
      owner: trader,
      receiver: trader,
      spotProceedsRecipient: trader,
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
      nonce: await read(contracts.exitController, a.exitController.abi, "nextNonce", [contracts.account]),
    };
    const exit = exitTypedData(environment, authorization);
    assert.equal(hashTypedData(exit), await read(contracts.exitController, a.exitController.abi, "exitDigest", [authorization]));
    const exitSignature = await accounts.trader.signTypedData(exit);
    assert.equal((await write(
      environment,
      wallets.feePayer,
      contracts.exitController,
      a.exitController.abi,
      "submitFullClose",
      [authorization, exitSignature],
      executionFee,
    )).status, "success");
    assert.equal(await read(contracts.exitController, a.exitController.abi, "nextNonce", [contracts.account]), authorization.nonce + 1n);
    const exitRequestKey = await read(contracts.exitController, a.exitController.abi, "activeExitRequestKey", [contracts.account]);
    assert.notEqual(exitRequestKey, zeroHash);
    const traderBeforeExit = await balance(contracts.collateral, trader);
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
    const exitEvidence = await read(contracts.exitController, a.exitController.abi, "exitEvidence", [exitRequestKey]);
    const finalReceipt = await read(contracts.exitController, a.exitController.abi, "finalPackageReceipt", [exitRequestKey]);
    assert.equal(exitEvidence[0], 2);
    assert.equal(exitEvidence[4], true);
    assert.notEqual(finalReceipt.commitment, zeroHash);
    assert.equal(finalReceipt.packageId, packageId);
    assert.equal(finalReceipt.entryRequestKey, requestKey);
    assert.equal(finalReceipt.exitRequestKey, exitRequestKey);
    assert.equal(finalReceipt.recipient, trader);
    assert.equal(finalReceipt.spotQuoteAtoms, spotQuoteAtoms);
    assert.equal(finalReceipt.terminalState, 1);
    assert.equal(await balance(contracts.collateral, trader), traderBeforeExit + collateralAtoms + spotQuoteAtoms);
    assert.equal(await balance(contracts.base, contracts.account), 0n);
    assert.equal(await balance(contracts.collateral, contracts.account), 0n);
    assert.equal(await read(contracts.account, a.account.abi, "hasActiveSpotInventory"), false);
    assert.equal(await read(contracts.adapter, a.adapter.abi, "activePackageOf", [contracts.account]), zeroHash);
    assert.equal(await read(contracts.adapter, a.adapter.abi, "activeRequestKeyOf", [contracts.account]), zeroHash);
    assert.equal(await read(contracts.exitController, a.exitController.abi, "activeExitRequestKey", [contracts.account]), zeroHash);

    const beforeClose = await read(contracts.coordinator, a.coordinator.abi, "packageState", [packageId]);
    const bondRecipientBefore = await balance(contracts.collateral, terms.bondRecipient);
    const reserveRecipientBefore = await balance(contracts.collateral, terms.recoveryReserveRecipient);
    assert.equal((await write(
      environment,
      wallets.deployer,
      contracts.coordinator,
      a.coordinator.abi,
      "close",
      [packageId, beforeClose.stateVersion],
    )).status, "success");
    const closed = await read(contracts.coordinator, a.coordinator.abi, "packageState", [packageId]);
    assert.equal(closed.state, 10);
    assert.equal(await balance(contracts.collateral, terms.bondRecipient), bondRecipientBefore + terms.bondAtoms);
    assert.equal(await balance(contracts.collateral, terms.recoveryReserveRecipient), reserveRecipientBefore + terms.recoveryReserveAtoms);
    assert.equal(await balance(contracts.collateral, contracts.coordinator), 0n);
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
      owner: trader,
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
