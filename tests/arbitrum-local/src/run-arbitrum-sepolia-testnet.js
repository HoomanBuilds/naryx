import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import {
  createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, getAddress,
  hashTypedData, http, keccak256, padHex, parseAbi, parseEventLogs, stringToHex, zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import {
  createViemArbitrumSepoliaReadPort,
  gmxPositionFieldKey,
  readGmxShortExecutionPrice,
} from "@naryx/solver";

const root = resolve(import.meta.dirname, "../../..");
const releasePath = resolve(root, "deployments/evm/arbitrum-sepolia/release.json");
const callbackGasLimit = 2_000_000n;
const quantityAtoms = 1_000_000_000_000_000n;
const collateralAtoms = 2_000_000n;
const confirmations = 2;
const transactionGas = 12_000_000n;
const bps = 10_000n;

const structs = [
  "struct DomainRef { bytes32 domainIdHash; uint32 manifestVersion; bytes32 manifestHash; }",
  "struct Terms { DomainRef domain; address owner; address solver; address adapter; address handler; bytes32 adapterCodeHash; bytes32 handlerCodeHash; bytes32 orderHash; bytes32 quoteHash; bytes32 routeHash; bytes32 seriesIdentityKey; uint32 seriesBindingVersion; bytes32 seriesBindingHash; bytes32 executionClassIdentityHash; bytes32 executionClassManifestHash; bytes32 requestPayloadHash; bytes32 reservationHash; bytes32 bondHash; bytes32 recoveryPolicyHash; bytes32 evidenceSchemaHash; address bondRecipient; address recoveryReserveRecipient; address slashRecipient; address lossAsset; address residualAsset; uint256 bondAtoms; uint256 recoveryReserveAtoms; uint256 maxAggregateLossAtoms; uint256 maxIntermediateResidualAtoms; uint256 maxTerminalResidualAtoms; uint256 nonce; uint64 submissionDeadline; uint64 venueDeadline; uint64 recoveryDeadline; }",
  "struct SpotEntry { address fundingOwner; address port; bytes32 portCodeHash; address baseToken; address quoteToken; uint256 baseAtoms; uint256 maxQuoteAtoms; uint256 rollbackMinQuoteAtoms; bytes32 entryFillCommitment; bytes32 rollbackFillCommitment; }",
  "struct VenueRequest { bytes32 marketId; address collateralToken; int256 sizeDelta; uint256 collateralAtoms; uint256 acceptablePrice; uint256 executionFeeWei; uint256 callbackGasLimit; uint256 packageNonce; bytes32 orderHash; bytes32 quoteHash; bytes32 routeHash; SpotEntry spot; uint64 submissionDeadline; uint64 venueDeadline; uint64 recoveryDeadline; }",
  "struct Package { Terms terms; bytes32 requestKey; bytes32 outcomeEvidenceHash; bytes32 recoveryEvidenceHash; bytes32 venueEvidenceCommitment; bytes32 recoveryEvidenceCommitment; uint8 state; uint64 stateVersion; uint64 admissionGeneration; uint64 recoveryDutyStartedAt; uint8 lastVenueOutcome; bool hasVenueOutcome; bool recoveryDutyActive; bool recoveryActionSubmitted; bool recoveryProven; bool bondSlashed; bool evidenceConflict; uint256 settledLossAtoms; }",
];
const coordinatorAbi = parseAbi([
  ...structs,
  "function nextNonce(address owner) view returns (uint256)",
  "function packageId(Terms terms) view returns (bytes32)",
  "function reserveDigest(Terms terms) view returns (bytes32)",
  "function bondCommitment(Terms terms) view returns (bytes32)",
  "function reservationCommitment(Terms terms) view returns (bytes32)",
  "function recoveryPolicyCommitment(Terms terms) view returns (bytes32)",
  "function packageState(bytes32 id) view returns (Package)",
  "function EXECUTION_CLASS_ID() view returns (bytes32)",
  "function EVIDENCE_SCHEMA_ID() view returns (bytes32)",
  "function executionClassManifestHash() view returns (bytes32)",
  "function reserve(Terms terms, bytes ownerSignature) returns (bytes32)",
  "function submitRequest(bytes32 id, uint64 expectedVersion, VenueRequest request) returns (bytes32)",
  "function markVenuePending(bytes32 id, uint64 expectedVersion)",
  "function beginRecovery(bytes32 id, uint64 expectedVersion)",
  "function submitRecovery(bytes32 id, uint64 expectedVersion)",
  "function slashMissedSubmission(bytes32 id, uint64 expectedVersion)",
  "function close(bytes32 id, uint64 expectedVersion)",
  "event RequestRegistered(bytes32 indexed packageId, bytes32 indexed requestKey)",
]);
const adapterAbi = parseAbi([
  ...structs,
  "function fundRequest(bytes32 packageId, VenueRequest venueRequest) payable",
  "function reclaimExpiredFunding(bytes32 packageId)",
  "function relayEvidence(bytes32 requestKey, uint64 expectedVersion)",
  "function requestEvidence(bytes32 requestKey) view returns (uint8 status, bytes32 evidenceHash, uint256 positionSizeBefore, uint256 positionSizeAfter, uint64 revision)",
  "function activePackageOf(address account) view returns (bytes32)",
  "function activeRequestKeyOf(address account) view returns (bytes32)",
]);
const spotRegistrationStruct = "struct SpotEntryRegistration { bytes32 packageId; bytes32 requestPayloadHash; address fundingOwner; address port; bytes32 portCodeHash; address baseToken; address quoteToken; uint256 packageNonce; bytes32 orderHash; bytes32 quoteHash; bytes32 routeHash; bytes32 entryFillCommitment; bytes32 rollbackFillCommitment; uint256 baseAtoms; uint256 maxQuoteAtoms; uint256 rollbackMinQuoteAtoms; }";
const accountAbi = parseAbi([
  spotRegistrationStruct,
  "function owner() view returns (address)",
  "function positionSize(bool isLong) view returns (uint256)",
  "function hasActiveSpotInventory() view returns (bool)",
  "function activeSpotRequestKey() view returns (bytes32)",
  "function activeSpotRegistration() view returns (SpotEntryRegistration)",
]);
const spotRegistrationParameter = parseAbi([spotRegistrationStruct, "function encode(SpotEntryRegistration registration)"])
  .find((item) => item.type === "function").inputs[0];
const factoryAbi = parseAbi([
  "function accountOf(address owner) view returns (address)",
  "function create(address owner) returns (address)",
]);
const tokenAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const quoterAbi = parseAbi([
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const priceFeedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
const exchangeRouterAbi = parseAbi([
  "function dataStore() view returns (address)",
  "function eventEmitter() view returns (address)",
  "function router() view returns (address)",
  "function orderHandler() view returns (address)",
  "function roleStore() view returns (address)",
]);
const dataStoreAbi = parseAbi([
  "function getUint(bytes32 key) view returns (uint256)",
  "function getInt(bytes32 key) view returns (int256)",
]);
const exitAbi = parseAbi([
  "struct ExitAuthorization { bytes32 packageId; bytes32 entryRequestKey; bytes32 spotRegistrationHash; address account; address owner; address receiver; address spotProceedsRecipient; address feePayer; address executionFeeRefundRecipient; address market; address collateralToken; bool isLong; uint256 fullCloseSizeUsd; uint256 spotBaseAtoms; uint256 spotMinQuoteAtoms; uint256 packageNonce; bytes32 exitOrderHash; bytes32 exitQuoteHash; bytes32 exitRouteHash; bytes32 exitFillCommitment; uint256 acceptablePrice; uint256 minOutputAmount; uint256 executionFeeWei; uint256 callbackGasLimit; uint64 authorizationExpiry; uint64 cancelAfter; uint256 nonce; }",
  "struct FinalPackageReceipt { bytes32 commitment; bytes32 packageId; bytes32 entryRequestKey; bytes32 exitRequestKey; bytes32 entryRequestPayloadHash; bytes32 spotRegistrationHash; bytes32 exitAuthorizationHash; bytes32 perpEvidenceHash; bytes32 spotEvidenceHash; bytes32 entryCommitmentsHash; bytes32 exitCommitmentsHash; address recipient; uint256 fullCloseSizeUsd; uint256 spotBaseAtoms; uint256 spotQuoteAtoms; uint8 perpStatus; uint8 terminalState; }",
  "function nextNonce(address account) view returns (uint256)",
  "function exitDigest(ExitAuthorization authorization) view returns (bytes32)",
  "function submitFullClose(ExitAuthorization authorization, bytes ownerSignature) payable returns (bytes32)",
  "function activeExitRequestKey(address account) view returns (bytes32)",
  "function exitEvidence(bytes32 requestKey) view returns (uint8 status, bytes32 evidenceHash, uint64 revision, bool reconciling, bool released)",
  "function finalPackageReceipt(bytes32 requestKey) view returns (FinalPackageReceipt)",
  "function finalizeExecutedExit(bytes32 requestKey) returns (bool)",
  "function requestCancellationOrReconciliation(bytes32 requestKey) returns (bool)",
  "event ExitSubmitted(bytes32 indexed packageId, bytes32 indexed requestKey, bytes32 authorizationHash)",
]);
const exitFields = exitAbi.find((item) => item.type === "function" && item.name === "exitDigest").inputs[0].components
  .map(({ name, type }) => ({ name, type }));
const requestParameter = coordinatorAbi.find((item) => item.type === "function" && item.name === "submitRequest").inputs[2];
const termsParameter = coordinatorAbi.find((item) => item.type === "function" && item.name === "reserveDigest").inputs[0];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadKey(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} key path must be absolute`);
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`${label} key must be an owner-only regular file`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.version !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(value.privateKey)) throw new Error(`${label} key is invalid`);
  return privateKeyToAccount(value.privateKey);
}

function outputPath() {
  const index = process.argv.indexOf("--output");
  const value = index === -1
    ? "/home/shreyas/.local/share/naryx/testnet/evidence/arbitrum-sepolia-async.json"
    : process.argv[index + 1];
  if (!value || !isAbsolute(value) || value.startsWith(`${root}/`)) {
    throw new Error("Arbitrum Sepolia evidence path must be absolute and outside the repository");
  }
  return value;
}

const json = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
const hash = (label, nonce) => keccak256(stringToHex(`naryx/arbitrum-sepolia/${label}/${nonce}`));
const termsHash = (terms) => keccak256(encodeAbiParameters([termsParameter], [terms]));
const reserveTypedData = (terms, coordinator) => ({
  domain: { name: "Naryx Async Bonded Package", version: "1", chainId: 421_614, verifyingContract: coordinator },
  types: { ReserveAsyncPackage: [{ name: "termsHash", type: "bytes32" }] },
  primaryType: "ReserveAsyncPackage",
  message: { termsHash: termsHash(terms) },
});
const exitTypedData = (authorization, controller) => ({
  domain: { name: "Naryx GMX V2 Exit", version: "1", chainId: 421_614, verifyingContract: controller },
  types: { ExitAuthorization: exitFields },
  primaryType: "ExitAuthorization",
  message: authorization,
});

const rpcUrl = required("NARYX_ARBITRUM_SEPOLIA_RPC_URL");
const solver = loadKey(required("NARYX_ARBITRUM_SEPOLIA_SOLVER_KEY_PATH"), "solver");
const owner = loadKey(required("NARYX_ARBITRUM_SEPOLIA_OWNER_KEY_PATH"), "owner");
assert.notEqual(solver.address.toLowerCase(), owner.address.toLowerCase());
const release = JSON.parse(readFileSync(releasePath, "utf8"));
const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
const solverWallet = createWalletClient({ account: solver, chain: arbitrumSepolia, transport: http(rpcUrl) });
const ownerWallet = createWalletClient({ account: owner, chain: arbitrumSepolia, transport: http(rpcUrl) });
const gmxReadPort = createViemArbitrumSepoliaReadPort(rpcUrl);

async function wait(transactionHash) {
  return publicClient.waitForTransactionReceipt({ hash: transactionHash, confirmations });
}

async function write(wallet, address, abi, functionName, args = [], value) {
  const transactionHash = await wallet.writeContract({
    address, abi, functionName, args, ...(value === undefined ? {} : { value }), gas: transactionGas,
  });
  const receipt = await wait(transactionHash);
  assert.equal(receipt.status, "success", `${functionName} reverted: ${transactionHash}`);
  return receipt;
}

async function sendExpectedRevert(wallet, address, abi, functionName, args) {
  const transactionHash = await wallet.sendTransaction({
    to: address, data: encodeFunctionData({ abi, functionName, args }), gas: transactionGas,
  });
  const receipt = await wait(transactionHash);
  assert.equal(receipt.status, "reverted", `${functionName} unexpectedly succeeded: ${transactionHash}`);
  return receipt;
}

async function codeHash(address) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`No code at ${address}`);
  return keccak256(code);
}

async function verifyRelease() {
  assert.equal(await publicClient.getChainId(), 421_614);
  assert.equal(release.network, "arbitrum-sepolia");
  assert.equal(release.activationState, "ACTIVE");
  const identities = [
    ...Object.values(release.contracts),
    ...Object.values(release.externalDependencies).filter((item) => item.address && item.runtimeCodeHash),
  ];
  for (const identity of identities) {
    assert.equal((await codeHash(identity.address)).toLowerCase(), identity.runtimeCodeHash.toLowerCase());
  }
  const exchangeRouter = release.externalDependencies.gmxExchangeRouter.address;
  const bindings = {
    dataStore: release.externalDependencies.gmxDataStore.address,
    eventEmitter: release.externalDependencies.gmxEventEmitter.address,
    router: release.externalDependencies.gmxRouter.address,
    orderHandler: release.externalDependencies.gmxOrderHandler.address,
    roleStore: release.externalDependencies.gmxRoleStore.address,
  };
  for (const [functionName, expected] of Object.entries(bindings)) {
    const actual = await publicClient.readContract({ address: exchangeRouter, abi: exchangeRouterAbi, functionName });
    assert.equal(getAddress(actual), getAddress(expected), `GMX ${functionName} binding changed`);
  }
}

async function snapshot(account) {
  const token = release.externalDependencies.collateralToken.address;
  const base = release.externalDependencies.weth.address;
  const adapter = release.contracts.entryAdapter.address;
  const controller = release.contracts.exitController.address;
  const [baseAtoms, quoteAtoms, hasSpot, activeSpotKey, activePackage, activeRequest, activeExit] = await Promise.all([
    publicClient.readContract({ address: base, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "hasActiveSpotInventory" }),
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "activeSpotRequestKey" }),
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "activePackageOf", args: [account] }),
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "activeRequestKeyOf", args: [account] }),
    publicClient.readContract({ address: controller, abi: exitAbi, functionName: "activeExitRequestKey", args: [account] }),
  ]);
  return { baseAtoms, quoteAtoms, hasSpot, activeSpotKey, activePackage, activeRequest, activeExit };
}

function dataStoreKey(label) {
  return keccak256(encodeAbiParameters([{ type: "string" }], [label]));
}

async function executionFee() {
  const dataStore = release.externalDependencies.gmxDataStore.address;
  const [baseAmount, perOraclePrice, multiplier, gasLimit, gasPrice] = await Promise.all([
    ...["ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1", "ESTIMATED_GAS_FEE_PER_ORACLE_PRICE", "ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR", "INCREASE_ORDER_GAS_LIMIT"]
      .map((label) => publicClient.readContract({ address: dataStore, abi: dataStoreAbi, functionName: "getUint", args: [dataStoreKey(label)] })),
    publicClient.getGasPrice(),
  ]);
  const adjusted = baseAmount + (gasLimit + callbackGasLimit + perOraclePrice * 3n) * multiplier / 10n ** 30n;
  return adjusted * gasPrice * 12_000n / bps;
}

async function marketValues() {
  const quote = release.externalDependencies.collateralToken.address;
  const base = release.externalDependencies.weth.address;
  const fee = release.externalDependencies.uniswapPool.fee;
  const [buy, sell, round] = await Promise.all([
    publicClient.readContract({
      address: release.externalDependencies.uniswapQuoter.address, abi: quoterAbi,
      functionName: "quoteExactOutputSingle",
      args: [{ tokenIn: quote, tokenOut: base, amount: quantityAtoms, fee, sqrtPriceLimitX96: 0n }],
    }),
    publicClient.readContract({
      address: release.externalDependencies.uniswapQuoter.address, abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: base, tokenOut: quote, amountIn: quantityAtoms, fee, sqrtPriceLimitX96: 0n }],
    }),
    publicClient.readContract({ address: release.externalDependencies.ethUsdPriceFeed.address, abi: priceFeedAbi, functionName: "latestRoundData" }),
  ]);
  const answer = round[1];
  assert(answer > 0n);
  const decimals = BigInt(release.externalDependencies.ethUsdPriceFeed.decimals);
  const gmxPrice = answer * 10n ** (30n - decimals - 18n);
  const sizeDeltaUsd = quantityAtoms * answer * 10n ** (30n - decimals) / 10n ** 18n;
  const execution = await readGmxShortExecutionPrice(
    gmxReadPort,
    {
      address: release.externalDependencies.gmxReader.address.toLowerCase(),
      expectedCodeHash: release.externalDependencies.gmxReader.runtimeCodeHash,
    },
    release.externalDependencies.gmxDataStore.address.toLowerCase(),
    release.externalDependencies.gmxMarket.address.toLowerCase(),
    { indexPrice: gmxPrice, quoteDecimals: 6, sizeDeltaUsd },
  );
  return {
    maxSpotQuoteAtoms: buy[0] * 10_100n / bps + 1n,
    rollbackMinQuoteAtoms: sell[0] * 9_500n / bps,
    spotExitFloorAtoms: sell[0] * 9_500n / bps,
    gmxPrice,
    gmxEntryPrice: execution.executionPrice,
    sizeDeltaUsd,
  };
}

async function ensureAccount() {
  const factory = release.contracts.accountFactory.address;
  const account = getAddress(await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "accountOf", args: [owner.address] }));
  const code = await publicClient.getCode({ address: account });
  if (!code || code === "0x") await write(ownerWallet, factory, factoryAbi, "create", [owner.address]);
  assert.equal(getAddress(await publicClient.readContract({ address: account, abi: accountAbi, functionName: "owner" })), owner.address);
  return account;
}

async function buildPackage(label, feeWei, values, submissionWindow = 300n) {
  const coordinator = release.contracts.coordinator.address;
  const adapter = release.contracts.entryAdapter.address;
  const block = await publicClient.getBlock();
  const nonce = await publicClient.readContract({ address: coordinator, abi: coordinatorAbi, functionName: "nextNonce", args: [owner.address] });
  const submissionDeadline = block.timestamp + submissionWindow;
  const venueDeadline = block.timestamp + 900n;
  const recoveryDeadline = block.timestamp + 1_500n;
  const orderHash = hash(`${label}-order`, nonce);
  const quoteHash = hash(`${label}-quote`, nonce);
  const routeHash = hash(`${label}-route`, nonce);
  const request = {
    marketId: padHex(release.externalDependencies.gmxMarket.address, { size: 32 }),
    collateralToken: release.externalDependencies.collateralToken.address,
    sizeDelta: -values.sizeDeltaUsd,
    collateralAtoms,
    acceptablePrice: values.gmxEntryPrice * 9_900n / bps,
    executionFeeWei: feeWei,
    callbackGasLimit,
    packageNonce: nonce,
    orderHash,
    quoteHash,
    routeHash,
    spot: {
      fundingOwner: owner.address,
      port: release.contracts.spotPort.address,
      portCodeHash: release.contracts.spotPort.runtimeCodeHash,
      baseToken: release.externalDependencies.weth.address,
      quoteToken: release.externalDependencies.collateralToken.address,
      baseAtoms: quantityAtoms,
      maxQuoteAtoms: values.maxSpotQuoteAtoms,
      rollbackMinQuoteAtoms: values.rollbackMinQuoteAtoms,
      entryFillCommitment: hash(`${label}-entry-fill`, nonce),
      rollbackFillCommitment: hash(`${label}-rollback-fill`, nonce),
    },
    submissionDeadline,
    venueDeadline,
    recoveryDeadline,
  };
  const [executionClassIdentityHash, executionClassManifestHash, evidenceSchemaHash] = await Promise.all([
    publicClient.readContract({ address: coordinator, abi: coordinatorAbi, functionName: "EXECUTION_CLASS_ID" }),
    publicClient.readContract({ address: coordinator, abi: coordinatorAbi, functionName: "executionClassManifestHash" }),
    publicClient.readContract({ address: coordinator, abi: coordinatorAbi, functionName: "EVIDENCE_SCHEMA_ID" }),
  ]);
  const terms = {
    domain: {
      domainIdHash: keccak256(stringToHex(release.domainManifest.domainId)),
      manifestVersion: release.domainManifest.manifestVersion,
      manifestHash: release.domainManifest.manifestHash,
    },
    owner: owner.address, solver: solver.address, adapter, handler: adapter,
    adapterCodeHash: release.contracts.entryAdapter.runtimeCodeHash,
    handlerCodeHash: release.contracts.entryAdapter.runtimeCodeHash,
    orderHash, quoteHash, routeHash,
    seriesIdentityKey: hash("series-identity", 1n),
    seriesBindingVersion: 1,
    seriesBindingHash: release.economicSeries.manifestHash,
    executionClassIdentityHash, executionClassManifestHash,
    requestPayloadHash: keccak256(encodeAbiParameters([requestParameter], [request])),
    reservationHash: zeroHash, bondHash: zeroHash, recoveryPolicyHash: zeroHash, evidenceSchemaHash,
    bondRecipient: solver.address, recoveryReserveRecipient: solver.address, slashRecipient: owner.address,
    lossAsset: release.externalDependencies.collateralToken.address,
    residualAsset: release.externalDependencies.collateralToken.address,
    bondAtoms: 1_000_000n, recoveryReserveAtoms: 1_000_000n, maxAggregateLossAtoms: 1_000_000n,
    maxIntermediateResidualAtoms: collateralAtoms, maxTerminalResidualAtoms: 1n,
    nonce, submissionDeadline, venueDeadline, recoveryDeadline,
  };
  terms.bondHash = await publicClient.readContract({ address: coordinator, abi: coordinatorAbi, functionName: "bondCommitment", args: [terms] });
  terms.reservationHash = await publicClient.readContract({ address: coordinator, abi: coordinatorAbi, functionName: "reservationCommitment", args: [terms] });
  terms.recoveryPolicyHash = await publicClient.readContract({ address: coordinator, abi: coordinatorAbi, functionName: "recoveryPolicyCommitment", args: [terms] });
  const packageId = await publicClient.readContract({ address: coordinator, abi: coordinatorAbi, functionName: "packageId", args: [terms] });
  const typedData = reserveTypedData(terms, coordinator);
  assert.equal(hashTypedData(typedData), await publicClient.readContract({ address: coordinator, abi: coordinatorAbi, functionName: "reserveDigest", args: [terms] }));
  return { packageId, request, terms, ownerSignature: await owner.signTypedData(typedData) };
}

async function fundAndReserve(plan) {
  const token = release.externalDependencies.collateralToken.address;
  const adapter = release.contracts.entryAdapter.address;
  const coordinator = release.contracts.coordinator.address;
  await write(ownerWallet, token, tokenAbi, "approve", [adapter, collateralAtoms + plan.request.spot.maxQuoteAtoms]);
  const funding = await write(ownerWallet, adapter, adapterAbi, "fundRequest", [plan.packageId, plan.request], plan.request.executionFeeWei);
  await write(solverWallet, token, tokenAbi, "approve", [coordinator, plan.terms.bondAtoms + plan.terms.recoveryReserveAtoms]);
  const reserve = await write(solverWallet, coordinator, coordinatorAbi, "reserve", [plan.terms, plan.ownerSignature]);
  return { funding: funding.transactionHash, reserve: reserve.transactionHash };
}

async function proveFailedSubmit(account, values) {
  const plan = await buildPackage("failed-entry", 1n, values, 45n);
  const setup = await fundAndReserve(plan);
  const before = await snapshot(account);
  const failed = await sendExpectedRevert(solverWallet, release.contracts.coordinator.address, coordinatorAbi, "submitRequest", [plan.packageId, 1n, plan.request]);
  assert.deepEqual(await snapshot(account), before);
  let state = await publicClient.readContract({ address: release.contracts.coordinator.address, abi: coordinatorAbi, functionName: "packageState", args: [plan.packageId] });
  assert.equal(state.state, 1);
  await poll("failed submission deadline", async () => (await publicClient.getBlock()).timestamp, (timestamp) => timestamp > plan.terms.submissionDeadline);
  const slash = await write(solverWallet, release.contracts.coordinator.address, coordinatorAbi, "slashMissedSubmission", [plan.packageId, state.stateVersion]);
  state = await publicClient.readContract({ address: release.contracts.coordinator.address, abi: coordinatorAbi, functionName: "packageState", args: [plan.packageId] });
  assert.equal(state.state, 9);
  const close = await write(solverWallet, release.contracts.coordinator.address, coordinatorAbi, "close", [plan.packageId, state.stateVersion]);
  const reclaim = await write(ownerWallet, release.contracts.entryAdapter.address, adapterAbi, "reclaimExpiredFunding", [plan.packageId]);
  const clean = await snapshot(account);
  assert.equal(clean.baseAtoms, 0n);
  assert.equal(clean.quoteAtoms, 0n);
  assert.equal(clean.hasSpot, false);
  assert.equal(clean.activePackage, zeroHash);
  assert.equal(clean.activeRequest, zeroHash);
  return {
    packageId: plan.packageId,
    transactions: { ...setup, failedSubmit: failed.transactionHash, slash: slash.transactionHash, close: close.transactionHash, reclaim: reclaim.transactionHash },
    rollback: "FULL_TRANSACTION_REVERT_AND_TIMEOUT_RECOVERY",
  };
}

async function poll(label, read, terminal) {
  const started = Date.now();
  while (Date.now() - started < 360_000) {
    const value = await read();
    if (terminal(value)) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
  throw new Error(`${label} did not reach a terminal state within 360000 ms`);
}

async function waitForEntryOutcome(plan, requestKey) {
  const adapter = release.contracts.entryAdapter.address;
  const coordinator = release.contracts.coordinator.address;
  const transactions = {};
  while (true) {
    const outcome = await publicClient.readContract({
      address: adapter, abi: adapterAbi, functionName: "requestEvidence", args: [requestKey],
    });
    if (Number(outcome[0]) !== 1) return { outcome, transactions };
    const block = await publicClient.getBlock();
    if (block.timestamp > plan.terms.venueDeadline) {
      let state = await publicClient.readContract({
        address: coordinator, abi: coordinatorAbi, functionName: "packageState", args: [plan.packageId],
      });
      const begin = await write(solverWallet, coordinator, coordinatorAbi, "beginRecovery", [plan.packageId, state.stateVersion]);
      transactions.beginRecovery = begin.transactionHash;
      state = await publicClient.readContract({
        address: coordinator, abi: coordinatorAbi, functionName: "packageState", args: [plan.packageId],
      });
      const submit = await write(solverWallet, coordinator, coordinatorAbi, "submitRecovery", [plan.packageId, state.stateVersion]);
      transactions.submitRecovery = submit.transactionHash;
      return {
        outcome: await publicClient.readContract({
          address: adapter, abi: adapterAbi, functionName: "requestEvidence", args: [requestKey],
        }),
        transactions,
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
}

async function closeUnfilledEntry(plan, requestKey, outcome, transactions) {
  const adapter = release.contracts.entryAdapter.address;
  const coordinator = release.contracts.coordinator.address;
  let status = Number(outcome[0]);
  let state = await publicClient.readContract({
    address: coordinator, abi: coordinatorAbi, functionName: "packageState", args: [plan.packageId],
  });
  if (status === 3 || status === 4) {
    const relay = await write(solverWallet, adapter, adapterAbi, "relayEvidence", [requestKey, state.stateVersion]);
    transactions.relayNonExecution = relay.transactionHash;
    state = await publicClient.readContract({
      address: coordinator, abi: coordinatorAbi, functionName: "packageState", args: [plan.packageId],
    });
    const begin = await write(solverWallet, coordinator, coordinatorAbi, "beginRecovery", [plan.packageId, state.stateVersion]);
    transactions.beginRecovery = begin.transactionHash;
    state = await publicClient.readContract({
      address: coordinator, abi: coordinatorAbi, functionName: "packageState", args: [plan.packageId],
    });
    const submit = await write(solverWallet, coordinator, coordinatorAbi, "submitRecovery", [plan.packageId, state.stateVersion]);
    transactions.submitRecovery = submit.transactionHash;
    outcome = await publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "requestEvidence", args: [requestKey] });
    status = Number(outcome[0]);
  }
  assert.equal(status, 5, `Unfilled GMX entry could not be recovered from status ${status}`);
  const rollback = await write(solverWallet, adapter, adapterAbi, "finalizeUnfilledRequest", [requestKey]);
  transactions.rollbackSpot = rollback.transactionHash;
  state = await publicClient.readContract({
    address: coordinator, abi: coordinatorAbi, functionName: "packageState", args: [plan.packageId],
  });
  const relay = await write(solverWallet, adapter, adapterAbi, "relayEvidence", [requestKey, state.stateVersion]);
  transactions.relayRecovery = relay.transactionHash;
  state = await publicClient.readContract({
    address: coordinator, abi: coordinatorAbi, functionName: "packageState", args: [plan.packageId],
  });
  const close = await write(solverWallet, coordinator, coordinatorAbi, "close", [plan.packageId, state.stateVersion]);
  transactions.closeRecovery = close.transactionHash;
}

async function executeEntry(account, feeWei, values) {
  const plan = await buildPackage("successful-entry", feeWei, values);
  const setup = await fundAndReserve(plan);
  const submitted = await write(solverWallet, release.contracts.coordinator.address, coordinatorAbi, "submitRequest", [plan.packageId, 1n, plan.request]);
  const events = parseEventLogs({ abi: coordinatorAbi, eventName: "RequestRegistered", logs: submitted.logs, strict: false });
  assert.equal(events.length, 1);
  const requestKey = events[0].args.requestKey;
  const pending = await write(solverWallet, release.contracts.coordinator.address, coordinatorAbi, "markVenuePending", [plan.packageId, 2n]);
  const resolution = await waitForEntryOutcome(plan, requestKey);
  const outcome = resolution.outcome;
  if (Number(outcome[0]) !== 2) {
    await closeUnfilledEntry(plan, requestKey, outcome, resolution.transactions);
  }
  assert.equal(Number(outcome[0]), 2, `GMX entry terminal status was ${outcome[0]}`);
  const state = await publicClient.readContract({ address: release.contracts.coordinator.address, abi: coordinatorAbi, functionName: "packageState", args: [plan.packageId] });
  const relay = await write(solverWallet, release.contracts.entryAdapter.address, adapterAbi, "relayEvidence", [requestKey, state.stateVersion]);
  assert.equal(await publicClient.readContract({ address: account, abi: accountAbi, functionName: "hasActiveSpotInventory" }), true);
  assert.equal(await publicClient.readContract({ address: account, abi: accountAbi, functionName: "positionSize", args: [false] }), values.sizeDeltaUsd);
  return {
    ...plan,
    requestKey,
    transactions: {
      ...setup,
      submit: submitted.transactionHash,
      markPending: pending.transactionHash,
      ...resolution.transactions,
      relay: relay.transactionHash,
    },
  };
}

async function executeExit(account, entry, feeWei, attempt = 0) {
  const controller = release.contracts.exitController.address;
  const current = await marketValues();
  const [registration, fullCloseSizeUsd, nonce, block] = await Promise.all([
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "activeSpotRegistration" }),
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "positionSize", args: [false] }),
    publicClient.readContract({ address: controller, abi: exitAbi, functionName: "nextNonce", args: [account] }),
    publicClient.getBlock(),
  ]);
  const dataStore = release.externalDependencies.gmxDataStore.address;
  const market = release.externalDependencies.gmxMarket.address;
  const collateral = release.externalDependencies.collateralToken.address;
  const [sizeInTokens, pendingImpactAmount] = await Promise.all([
    publicClient.readContract({ address: dataStore, abi: dataStoreAbi, functionName: "getUint", args: [gmxPositionFieldKey(account, market, collateral, false, "SIZE_IN_TOKENS")] }),
    publicClient.readContract({ address: dataStore, abi: dataStoreAbi, functionName: "getInt", args: [gmxPositionFieldKey(account, market, collateral, false, "PENDING_IMPACT_AMOUNT")] }),
  ]);
  const closeQuote = await readGmxShortExecutionPrice(
    gmxReadPort,
    {
      address: release.externalDependencies.gmxReader.address.toLowerCase(),
      expectedCodeHash: release.externalDependencies.gmxReader.runtimeCodeHash,
    },
    dataStore.toLowerCase(),
    market.toLowerCase(),
    {
      indexPrice: current.gmxPrice,
      quoteDecimals: 6,
      sizeDeltaUsd: -fullCloseSizeUsd,
      position: { sizeInUsd: fullCloseSizeUsd, sizeInTokens, pendingImpactAmount },
    },
  );
  const authorization = {
    packageId: entry.packageId, entryRequestKey: entry.requestKey,
    spotRegistrationHash: keccak256(encodeAbiParameters([spotRegistrationParameter], [registration])),
    account, owner: owner.address, receiver: owner.address, spotProceedsRecipient: owner.address,
    feePayer: solver.address, executionFeeRefundRecipient: solver.address,
    market: release.externalDependencies.gmxMarket.address,
    collateralToken: release.externalDependencies.collateralToken.address,
    isLong: false, fullCloseSizeUsd, spotBaseAtoms: quantityAtoms,
    spotMinQuoteAtoms: current.spotExitFloorAtoms, packageNonce: entry.request.packageNonce,
    exitOrderHash: hash("exit-order", nonce), exitQuoteHash: hash("exit-quote", nonce),
    exitRouteHash: hash("exit-route", nonce), exitFillCommitment: hash("exit-fill", nonce),
    acceptablePrice: closeQuote.executionPrice * 10_100n / bps, minOutputAmount: 1n,
    executionFeeWei: feeWei, callbackGasLimit,
    authorizationExpiry: block.timestamp + 300n, cancelAfter: block.timestamp + 900n, nonce,
  };
  const typedData = exitTypedData(authorization, controller);
  assert.equal(hashTypedData(typedData), await publicClient.readContract({ address: controller, abi: exitAbi, functionName: "exitDigest", args: [authorization] }));
  const submitted = await write(solverWallet, controller, exitAbi, "submitFullClose", [authorization, await owner.signTypedData(typedData)], feeWei);
  const events = parseEventLogs({ abi: exitAbi, eventName: "ExitSubmitted", logs: submitted.logs, strict: false });
  assert.equal(events.length, 1);
  const requestKey = events[0].args.requestKey;
  let reconciliation = null;
  let outcome;
  while (true) {
    outcome = await publicClient.readContract({ address: controller, abi: exitAbi, functionName: "exitEvidence", args: [requestKey] });
    if (Number(outcome[0]) !== 1) break;
    if ((await publicClient.getBlock()).timestamp >= authorization.cancelAfter) {
      reconciliation = await write(solverWallet, controller, exitAbi, "requestCancellationOrReconciliation", [requestKey]);
      outcome = await publicClient.readContract({ address: controller, abi: exitAbi, functionName: "exitEvidence", args: [requestKey] });
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
  if (Number(outcome[0]) !== 2 && attempt === 0 && [3, 5].includes(Number(outcome[0]))) {
    const retried = await executeExit(account, entry, feeWei, attempt + 1);
    retried.previousAttempt = {
      requestKey,
      status: Number(outcome[0]),
      transactions: {
        submit: submitted.transactionHash,
        reconcile: reconciliation?.transactionHash ?? null,
      },
    };
    return retried;
  }
  assert.equal(Number(outcome[0]), 2, `GMX exit terminal status was ${outcome[0]}`);
  let receipt = await publicClient.readContract({ address: controller, abi: exitAbi, functionName: "finalPackageReceipt", args: [requestKey] });
  let finalize = null;
  if (receipt.commitment === zeroHash) {
    const transaction = await write(solverWallet, controller, exitAbi, "finalizeExecutedExit", [requestKey]);
    finalize = transaction.transactionHash;
    receipt = await publicClient.readContract({ address: controller, abi: exitAbi, functionName: "finalPackageReceipt", args: [requestKey] });
  }
  assert.notEqual(receipt.commitment, zeroHash);
  const state = await publicClient.readContract({ address: release.contracts.coordinator.address, abi: coordinatorAbi, functionName: "packageState", args: [entry.packageId] });
  const close = await write(solverWallet, release.contracts.coordinator.address, coordinatorAbi, "close", [entry.packageId, state.stateVersion]);
  const clean = await snapshot(account);
  assert.equal(clean.baseAtoms, 0n);
  assert.equal(clean.quoteAtoms, 0n);
  assert.equal(clean.hasSpot, false);
  assert.equal(clean.activePackage, zeroHash);
  assert.equal(clean.activeRequest, zeroHash);
  assert.equal(clean.activeExit, zeroHash);
  return {
    requestKey, receiptCommitment: receipt.commitment, spotQuoteAtoms: receipt.spotQuoteAtoms,
    terminalState: receipt.terminalState,
    transactions: {
      submit: submitted.transactionHash,
      reconcile: reconciliation?.transactionHash ?? null,
      finalize,
      close: close.transactionHash,
    },
  };
}

async function main() {
  await verifyRelease();
  const account = await ensureAccount();
  assert.equal((await snapshot(account)).activePackage, zeroHash, "owner account already has an active package");
  const [feeWei, values] = await Promise.all([executionFee(), marketValues()]);
  assert(feeWei > 1n);
  const failure = await proveFailedSubmit(account, values);
  const entry = await executeEntry(account, feeWei, values);
  const exit = await executeExit(account, entry, feeWei);
  const evidence = {
    version: 1,
    evidenceClass: "NARYX_ARBITRUM_SEPOLIA_ASYNC_GMX_V1",
    generatedAt: new Date().toISOString(),
    network: "arbitrum-sepolia",
    chainId: 421_614,
    releaseCommit: release.releaseCommit,
    owner: owner.address,
    solver: solver.address,
    strategyAccount: account,
    quantityAtoms,
    collateralAtoms,
    executionFeeWei: feeWei,
    failure,
    entry: { packageId: entry.packageId, requestKey: entry.requestKey, transactions: entry.transactions },
    exit,
    finalState: await snapshot(account),
    limitations: [
      "Testnet only. This evidence authorizes no mainnet action.",
      "USDC.SG is a public-mint GMX test token with no real value.",
      "The Uniswap V3 pool contains test liquidity and is not production depth evidence.",
      "GMX entry and exit are asynchronous and depend on external testnet keepers.",
    ],
  };
  const path = outputPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${json(evidence)}\n`, { mode: 0o600 });
  console.log(json({ output: path, evidence }));
}

await main();
