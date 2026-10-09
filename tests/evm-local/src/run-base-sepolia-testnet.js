import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  NARYX_STRATEGY_ACCOUNT_ABI,
  NARYX_STRATEGY_ACCOUNT_FACTORY_ABI,
  NARYX_STRATEGY_ACCOUNT_OWNER_ABI,
  NARYX_TEST_PERP_MARKET_ABI,
  PACKAGE_VERIFIER_ACCOUNT_ABI,
  PACKAGE_VERIFIER_OBSERVATION_ABI,
  packageVerifierOpenPackage,
} from "@naryx/adapter-evm";
import {
  BASE_SEPOLIA_RESOURCES,
  buildBaseSepoliaEntryPlan,
  buildBaseSepoliaExitPlan,
  failedPostconditionEntryPlan,
} from "./base-sepolia-testnet-plan.js";

const root = resolve(import.meta.dirname, "../../..");
const releasePath = resolve(root, "deployments/evm/base-sepolia/release.json");
const chainId = 84_532;
const quantityAtoms = 1_000_000_000_000_000n;
const marginAtoms = 1_000_000n;
const fundingAtoms = 10_000_000n;
const confirmations = 2;
const transactionGas = 5_000_000n;
const zeroHash = `0x${"00".repeat(32)}`;

const tokenAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address recipient, uint256 amount)",
]);
const solverRegistryAbi = parseAbi(["function isActiveSolver(address solver) view returns (bool)"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const executionComponents = NARYX_STRATEGY_ACCOUNT_ABI[0].inputs[0].components;
const admissionComponents = NARYX_STRATEGY_ACCOUNT_ABI[0].inputs[1].components;
const verifierAuthorizationAbi = [
  {
    type: "function",
    name: "traderPermitDigest",
    stateMutability: "view",
    inputs: [
      { name: "execution", type: "tuple", components: executionComponents },
      { name: "admission", type: "tuple", components: admissionComponents },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "solverAuthorizationDigest",
    stateMutability: "view",
    inputs: [
      { name: "execution", type: "tuple", components: executionComponents },
      { name: "admission", type: "tuple", components: admissionComponents },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadKey(path) {
  if (!isAbsolute(path)) throw new Error("NARYX_BASE_SEPOLIA_SOLVER_KEY_PATH must be absolute");
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Base Sepolia key must be an owner-only regular file");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.environment !== "BASE_SEPOLIA" || value.version !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(value.privateKey)) {
    throw new Error("Base Sepolia key file is invalid");
  }
  return privateKeyToAccount(value.privateKey);
}

function outputPath() {
  const index = process.argv.indexOf("--output");
  if (index === -1) return "/home/shreyas/.local/share/naryx/testnet/evidence/base-sepolia-atomic.json";
  const value = process.argv[index + 1];
  if (!value || !isAbsolute(value)) throw new Error("--output requires an absolute path outside the repository");
  if (value.startsWith(`${root}/`)) throw new Error("Base Sepolia evidence must stay outside the repository");
  return value;
}

function json(value) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function asPosition(value) {
  return Object.freeze({
    balance: value.balance ?? value[0],
    size: value.size ?? value[1],
    entryNotional: value.entryNotional ?? value[2],
  });
}

function asHex(value) {
  return `0x${Buffer.from(value).toString("hex")}`;
}

const rpcUrl = required("NARYX_BASE_SEPOLIA_RPC_URL");
const keyPath = required("NARYX_BASE_SEPOLIA_SOLVER_KEY_PATH");
const account = loadKey(keyPath);
const release = JSON.parse(readFileSync(releasePath, "utf8"));
const chain = defineChain({
  id: chainId,
  name: "Base Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

async function wait(hash) {
  return publicClient.waitForTransactionReceipt({ hash, confirmations });
}

async function send(to, abi, functionName, args) {
  const hash = await walletClient.sendTransaction({
    account,
    chain,
    to,
    data: encodeFunctionData({ abi, functionName, args }),
    gas: transactionGas,
  });
  const receipt = await wait(hash);
  assert.equal(receipt.status, "success", `${functionName} reverted: ${hash}`);
  return receipt;
}

async function codeHash(address) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`No code at ${address}`);
  return keccak256(code);
}

async function verifyRelease() {
  assert.equal(await publicClient.getChainId(), chainId);
  assert.equal(release.chainId, chainId);
  assert.equal(release.network, "base-sepolia");
  assert.equal(release.activationState, "ACTIVE");
  const identities = [
    release.contracts.packageVerifier,
    release.contracts.strategyAccountFactory,
    release.contracts.spotPort,
    release.contracts.testPerpMarket,
    release.externalDependencies.weth,
    release.externalDependencies.testUsdc,
    release.externalDependencies.uniswapFactory,
    release.externalDependencies.uniswapPool,
    release.externalDependencies.uniswapQuoter,
  ];
  for (const identity of identities) {
    assert.equal((await codeHash(identity.address)).toLowerCase(), identity.runtimeCodeHash.toLowerCase());
  }
  assert.equal(await publicClient.readContract({
    address: release.contracts.solverRegistry.address,
    abi: solverRegistryAbi,
    functionName: "isActiveSolver",
    args: [account.address],
  }), true);
}

async function snapshot(strategyAccount, perpExpiry) {
  const [base, quote, reserve, rawPosition, nonce, rawOpen] = await Promise.all([
    publicClient.readContract({ address: release.externalDependencies.weth.address, abi: tokenAbi, functionName: "balanceOf", args: [strategyAccount] }),
    publicClient.readContract({ address: release.externalDependencies.testUsdc.address, abi: tokenAbi, functionName: "balanceOf", args: [strategyAccount] }),
    publicClient.readContract({ address: release.contracts.testPerpMarket.address, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: "reserveOf", args: [strategyAccount] }),
    publicClient.readContract({ address: release.contracts.testPerpMarket.address, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: "getPosition", args: [release.contracts.testPerpMarket.address, perpExpiry, strategyAccount] }),
    publicClient.readContract({ address: release.contracts.packageVerifier.address, abi: PACKAGE_VERIFIER_ACCOUNT_ABI, functionName: "nextNonce", args: [strategyAccount] }),
    publicClient.readContract({ address: release.contracts.packageVerifier.address, abi: PACKAGE_VERIFIER_ACCOUNT_ABI, functionName: "openPackage", args: [strategyAccount] }),
  ]);
  const position = asPosition(rawPosition);
  const open = packageVerifierOpenPackage(rawOpen);
  return Object.freeze({
    base,
    quote,
    reserve,
    position,
    nonce,
    openEntryReceiptHash: open?.entryReceiptHash ?? zeroHash,
  });
}

async function authorize(plan) {
  const verifier = release.contracts.packageVerifier.address;
  const [traderDigest, solverDigest] = await Promise.all([
    publicClient.readContract({ address: verifier, abi: verifierAuthorizationAbi, functionName: "traderPermitDigest", args: [plan.execution, plan.admission] }),
    publicClient.readContract({ address: verifier, abi: verifierAuthorizationAbi, functionName: "solverAuthorizationDigest", args: [plan.execution, plan.admission] }),
  ]);
  const [traderSignature, solverSignature] = await Promise.all([
    account.sign({ hash: traderDigest }),
    account.sign({ hash: solverDigest }),
  ]);
  return encodeFunctionData({
    abi: NARYX_STRATEGY_ACCOUNT_ABI,
    functionName: "executePackage",
    args: [plan.execution, plan.admission, traderSignature, solverSignature, plan.perpArgs.map(asHex)],
  });
}

async function execute(strategyAccount, plan) {
  const data = await authorize(plan);
  const hash = await walletClient.sendTransaction({ account, chain, to: strategyAccount, data, gas: transactionGas });
  return wait(hash);
}

function packageReceipt(receipt, action) {
  const events = parseEventLogs({
    abi: PACKAGE_VERIFIER_OBSERVATION_ABI,
    eventName: "PackageVerified",
    logs: receipt.logs,
    strict: false,
  }).filter((event) => event.args.action === action);
  assert.equal(events.length, 1);
  return events[0].args.receiptHash;
}

async function spotQuote(functionName) {
  const input = functionName === "quoteExactOutputSingle"
    ? { tokenIn: release.externalDependencies.testUsdc.address, tokenOut: release.externalDependencies.weth.address, amount: quantityAtoms, fee: release.externalDependencies.uniswapPool.fee, sqrtPriceLimitX96: 0n }
    : { tokenIn: release.externalDependencies.weth.address, tokenOut: release.externalDependencies.testUsdc.address, amountIn: quantityAtoms, fee: release.externalDependencies.uniswapPool.fee, sqrtPriceLimitX96: 0n };
  const result = await publicClient.readContract({
    address: release.externalDependencies.uniswapQuoter.address,
    abi: quoterAbi,
    functionName,
    args: [input],
  });
  return result[0];
}

async function main() {
  await verifyRelease();
  const factory = release.contracts.strategyAccountFactory.address;
  const strategyAccount = getAddress(await publicClient.readContract({
    address: factory,
    abi: NARYX_STRATEGY_ACCOUNT_FACTORY_ABI,
    functionName: "accountOf",
    args: [account.address],
  }));
  let accountCode = await publicClient.getCode({ address: strategyAccount });
  if (!accountCode || accountCode === "0x") {
    await send(factory, NARYX_STRATEGY_ACCOUNT_FACTORY_ABI, "create", [account.address]);
    accountCode = await publicClient.getCode({ address: strategyAccount });
  }
  assert.equal(keccak256(accountCode).toLowerCase(), release.contracts.strategyAccountFactory.accountCodeHash.toLowerCase());
  assert.equal(getAddress(await publicClient.readContract({ address: strategyAccount, abi: NARYX_STRATEGY_ACCOUNT_OWNER_ABI, functionName: "owner" })), account.address);

  const perpExpiry = Number(await publicClient.readContract({ address: release.contracts.testPerpMarket.address, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: "expiry" }));
  const initial = await snapshot(strategyAccount, perpExpiry);
  assert.equal(initial.base, 0n);
  assert.equal(initial.quote, 0n);
  assert.equal(initial.reserve, 0n);
  assert.deepEqual(initial.position, { balance: 0n, size: 0n, entryNotional: 0n });
  assert.equal(initial.openEntryReceiptHash, zeroHash);

  await send(release.externalDependencies.testUsdc.address, tokenAbi, "mint", [strategyAccount, fundingAtoms]);
  await send(strategyAccount, NARYX_STRATEGY_ACCOUNT_OWNER_ABI, "depositPerpMargin", [BASE_SEPOLIA_RESOURCES.perpetualVenue.subjectId, marginAtoms]);
  const funded = await snapshot(strategyAccount, perpExpiry);

  const [spotEntryQuote, preview, collateralScale, takerFeeBps, initialMarginBps, block] = await Promise.all([
    spotQuote("quoteExactOutputSingle"),
    publicClient.readContract({ address: release.contracts.testPerpMarket.address, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: "previewOpen", args: [-quantityAtoms, marginAtoms * 1_000_000_000_000n] }),
    publicClient.readContract({ address: release.contracts.testPerpMarket.address, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: "collateralScale" }),
    publicClient.readContract({ address: release.contracts.testPerpMarket.address, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: "takerFeeBps" }),
    publicClient.readContract({ address: release.contracts.testPerpMarket.address, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: "initialMarginBps" }),
    publicClient.getBlock(),
  ]);
  assert.equal(collateralScale, 1_000_000_000_000n);
  const entryPlan = buildBaseSepoliaEntryPlan({
    release,
    strategyAccount,
    solver: account.address,
    quantityAtoms,
    nonce: funded.nonce,
    deadline: block.timestamp + 600n,
    perpExpiry,
    marginAtoms,
    collateralScale,
    takerFeeBps: BigInt(takerFeeBps),
    initialMarginBps: BigInt(initialMarginBps),
    oracleMoveAllowanceBps: 100n,
    spotSlippageBps: 200n,
    spotQuoteAtoms: spotEntryQuote,
    previewEntryNotionalWad: preview[1],
  });

  const failedReceipt = await execute(strategyAccount, failedPostconditionEntryPlan(entryPlan));
  assert.equal(failedReceipt.status, "reverted");
  const afterFailure = await snapshot(strategyAccount, perpExpiry);
  assert.deepEqual(afterFailure, funded);

  const entryReceipt = await execute(strategyAccount, entryPlan);
  assert.equal(entryReceipt.status, "success");
  const entryReceiptHash = packageReceipt(entryReceipt, 1);
  const opened = await snapshot(strategyAccount, perpExpiry);
  assert.equal(opened.base, quantityAtoms);
  assert.equal(opened.position.size, -quantityAtoms);
  assert.equal(opened.nonce, funded.nonce + 1n);
  assert.equal(opened.openEntryReceiptHash, entryReceiptHash);

  const exitQuote = await spotQuote("quoteExactInputSingle");
  const exitBlock = await publicClient.getBlock();
  const exitPlan = buildBaseSepoliaExitPlan({
    release,
    strategyAccount,
    solver: account.address,
    quantityAtoms,
    nonce: opened.nonce,
    deadline: exitBlock.timestamp + 600n,
    perpExpiry,
    position: opened.position,
    entryReceiptHash,
    spotSlippageBps: 200n,
    spotQuoteAtoms: exitQuote,
  });
  const exitReceipt = await execute(strategyAccount, exitPlan);
  assert.equal(exitReceipt.status, "success");
  const exitReceiptHash = packageReceipt(exitReceipt, 2);
  const closed = await snapshot(strategyAccount, perpExpiry);
  assert.equal(closed.base, 0n);
  assert.deepEqual(closed.position, { balance: 0n, size: 0n, entryNotional: 0n });
  assert.equal(closed.openEntryReceiptHash, zeroHash);
  assert.equal(closed.nonce, opened.nonce + 1n);

  if (closed.reserve > 0n) {
    await send(strategyAccount, NARYX_STRATEGY_ACCOUNT_OWNER_ABI, "withdrawPerpMargin", [BASE_SEPOLIA_RESOURCES.perpetualVenue.subjectId, closed.reserve]);
  }
  const quoteBalance = await publicClient.readContract({ address: release.externalDependencies.testUsdc.address, abi: tokenAbi, functionName: "balanceOf", args: [strategyAccount] });
  if (quoteBalance > 0n) {
    await send(strategyAccount, NARYX_STRATEGY_ACCOUNT_OWNER_ABI, "withdrawIdleToken", [release.externalDependencies.testUsdc.address, account.address, quoteBalance]);
  }
  const final = await snapshot(strategyAccount, perpExpiry);
  assert.equal(final.base, 0n);
  assert.equal(final.quote, 0n);
  assert.equal(final.reserve, 0n);
  assert.deepEqual(final.position, { balance: 0n, size: 0n, entryNotional: 0n });

  const evidence = {
    evidenceClass: "NARYX_BASE_SEPOLIA_ATOMIC_ROLLBACK_V1",
    environment: "BASE_SEPOLIA",
    chainId,
    conformancePerpetual: "BASE_SEPOLIA_CONFORMANCE_ONLY",
    releaseCommit: release.releaseCommit,
    solver: account.address,
    strategyAccount,
    quantityAtoms,
    failedEntry: { transactionHash: failedReceipt.transactionHash, blockNumber: failedReceipt.blockNumber, status: failedReceipt.status },
    rollbackStateEqual: true,
    entry: { transactionHash: entryReceipt.transactionHash, blockNumber: entryReceipt.blockNumber, receiptHash: entryReceiptHash },
    exit: { transactionHash: exitReceipt.transactionHash, blockNumber: exitReceipt.blockNumber, receiptHash: exitReceiptHash },
    final,
    generatedAt: new Date().toISOString(),
  };
  const destination = outputPath();
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${json(evidence)}\n`, { mode: 0o600 });
  process.stdout.write(`${json(evidence)}\nEvidence: ${destination}\n`);
}

await main();
