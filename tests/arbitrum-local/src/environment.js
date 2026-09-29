import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  stringToHex,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = resolve(import.meta.dirname, "../../..");
const artifactRoot = join(root, "contracts/evm/out");
const chainId = 421_614;
const domainId = `eip155:${chainId}`;
const domainManifestHash = keccak256(stringToHex("naryx-arbitrum-local-v1"));
const delaySeconds = 1n;
const controllerRole = keccak256(encodeAbiParameters([{ type: "string" }], ["CONTROLLER"]));

function artifact(relativePath) {
  const value = JSON.parse(readFileSync(join(artifactRoot, relativePath), "utf8"));
  const object = value.bytecode?.object;
  if (!Array.isArray(value.abi) || typeof object !== "string" || object.length === 0) {
    throw new Error(`Invalid Foundry artifact ${relativePath}`);
  }
  return { abi: value.abi, bytecode: object.startsWith("0x") ? object : `0x${object}` };
}

export const arbitrumLocalArtifacts = Object.freeze({
  token: artifact("GmxV2ArbitrumAdapter.t.sol/GmxTestToken.json"),
  dataStore: artifact("GmxV2ArbitrumAdapter.t.sol/GmxTestDataStore.json"),
  roleStore: artifact("GmxV2ArbitrumAdapter.t.sol/GmxTestRoleStore.json"),
  router: artifact("GmxV2ArbitrumAdapter.t.sol/GmxTestRouter.json"),
  orderHandler: artifact("GmxV2ArbitrumAdapter.t.sol/GmxTestOrderHandler.json"),
  code: artifact("GmxV2ArbitrumAdapter.t.sol/GmxTestCode.json"),
  orderVault: artifact("GmxV2ArbitrumAdapter.t.sol/GmxTestOrderVault.json"),
  exchangeRouter: artifact("GmxV2ArbitrumAdapter.t.sol/GmxTestExchangeRouter.json"),
  spotFactory: artifact("GmxV2ArbitrumAdapter.t.sol/GmxSpotFactory.json"),
  spotPool: artifact("GmxV2ArbitrumAdapter.t.sol/GmxSpotPool.json"),
  config: artifact("ProtocolConfig.sol/ProtocolConfig.json"),
  coordinator: artifact("AsyncBondedPackageCoordinator.sol/AsyncBondedPackageCoordinator.json"),
  account: artifact("GmxV2IsolatedAccount.sol/GmxV2IsolatedAccount.json"),
  adapter: artifact("GmxV2ArbitrumAdapter.sol/GmxV2ArbitrumAdapter.json"),
  orderVerifier: artifact("GmxV2OrderVerifier.sol/GmxV2OrderVerifier.json"),
  exitVerifier: artifact("GmxV2ExitOrderVerifier.sol/GmxV2ExitOrderVerifier.json"),
  exitController: artifact("GmxV2ExitController.sol/GmxV2ExitController.json"),
  spotPort: artifact("UniswapV3SpotPort.sol/UniswapV3SpotPort.json"),
});

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForAnvil(client, child, logPath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Anvil exited early\n${readFileSync(logPath, "utf8")}`);
    try {
      if (await client.getChainId() === chainId) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Timed out waiting for local Anvil");
}

async function deploy(wallet, client, contract, args = []) {
  const hash = await wallet.deployContract({ abi: contract.abi, bytecode: contract.bytecode, args });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Local deployment failed");
  return receipt.contractAddress;
}

async function write(wallet, client, address, abi, functionName, args = [], value) {
  const request = { address, abi, functionName, args };
  if (value !== undefined) request.value = value;
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Local ${functionName} transaction failed`);
  return receipt;
}

async function codeIdentity(client, address) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error("Expected deployed runtime code");
  return keccak256(code);
}

async function deploymentIdentity(client, addresses) {
  const result = {};
  for (const name of ["dataStore", "eventEmitter", "exchangeRouter", "router", "orderVault", "orderHandler", "roleStore"]) {
    result[name] = addresses[name];
    result[`${name}CodeHash`] = await codeIdentity(client, addresses[name]);
  }
  return result;
}

async function fundNative(client, address) {
  await client.request({ method: "anvil_setBalance", params: [address, toHex(10n ** 20n)] });
}

export async function validateArbitrumLocalEnvironment(environment) {
  const { client, manifest } = environment;
  if (new URL(manifest.rpc.url).hostname !== "127.0.0.1") throw new Error("Arbitrum local RPC is not loopback");
  if (await client.getChainId() !== chainId || manifest.environment !== "local" || manifest.mainnet !== false) {
    throw new Error("Arbitrum local chain identity mismatch");
  }
  for (const [name, contract] of Object.entries(manifest.contracts)) {
    if (await codeIdentity(client, contract.address) !== contract.codeHash) throw new Error(`${name} code hash mismatch`);
  }
  const configuredDomain = await client.readContract({
    address: manifest.contracts.config.address,
    abi: arbitrumLocalArtifacts.config.abi,
    functionName: "domain",
  });
  if (configuredDomain[0] !== domainId || Number(configuredDomain[1]) !== 1 || configuredDomain[2] !== domainManifestHash) {
    throw new Error("Arbitrum local domain mismatch");
  }
  const configuredEntry = await client.readContract({
    address: manifest.contracts.account.address,
    abi: arbitrumLocalArtifacts.account.abi,
    functionName: "entryController",
  });
  const configuredExit = await client.readContract({
    address: manifest.contracts.account.address,
    abi: arbitrumLocalArtifacts.account.abi,
    functionName: "exitController",
  });
  if (configuredEntry.toLowerCase() !== manifest.contracts.adapter.address.toLowerCase()
      || configuredExit.toLowerCase() !== manifest.contracts.exitController.address.toLowerCase()) {
    throw new Error("Arbitrum local isolated account controller mismatch");
  }
  return true;
}

export async function withLocalArbitrumEnvironment(callback) {
  const runDir = mkdtempSync(join(tmpdir(), "naryx-arbitrum-local-"));
  const logPath = join(runDir, "anvil.log");
  const logFd = openSync(logPath, "a", 0o600);
  const keys = Object.fromEntries(
    ["deployer", "trader", "solver", "feePayer", "recovery", "proposer", "canceller", "governanceExecutor", "pauser"]
      .map((name) => [name, generatePrivateKey()]),
  );
  const accounts = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, privateKeyToAccount(key)]));
  let anvil;
  try {
    const port = await availablePort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--accounts", "0", "--silent"], {
      cwd: runDir,
      stdio: ["ignore", logFd, logFd],
    });
    const chain = defineChain({
      id: chainId,
      name: "Naryx Arbitrum Local",
      nativeCurrency: { name: "Test Ether", symbol: "TETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const client = createPublicClient({ chain, transport: http(rpcUrl) });
    await waitForAnvil(client, anvil, logPath);
    for (const account of Object.values(accounts)) await fundNative(client, account.address);
    const wallets = Object.fromEntries(
      Object.entries(accounts).map(([name, account]) => [name, createWalletClient({ account, chain, transport: http(rpcUrl) })]),
    );
    const a = arbitrumLocalArtifacts;
    const collateral = await deploy(wallets.deployer, client, a.token);
    const base = await deploy(wallets.deployer, client, a.token);
    const dataStore = await deploy(wallets.deployer, client, a.dataStore);
    const roleStore = await deploy(wallets.deployer, client, a.roleStore);
    const router = await deploy(wallets.deployer, client, a.router);
    const orderHandler = await deploy(wallets.deployer, client, a.orderHandler);
    const eventEmitter = await deploy(wallets.deployer, client, a.code);
    const orderVault = await deploy(wallets.deployer, client, a.orderVault);
    const market = await deploy(wallets.deployer, client, a.code);
    const entryVerifier = await deploy(wallets.deployer, client, a.orderVerifier);
    const exitVerifier = await deploy(wallets.deployer, client, a.exitVerifier);
    const exchangeRouter = await deploy(wallets.deployer, client, a.exchangeRouter, [
      dataStore, eventEmitter, router, orderHandler, roleStore, orderVault,
    ]);
    await write(wallets.deployer, client, roleStore, a.roleStore.abi, "setRole", [orderHandler, controllerRole, true]);
    const config = await deploy(wallets.deployer, client, a.config, [
      domainId, 1, domainManifestHash, delaySeconds,
      accounts.proposer.address, accounts.canceller.address, accounts.governanceExecutor.address, accounts.pauser.address,
    ]);
    const executionClassHash = keccak256(stringToHex("naryx-arbitrum-local-execution-class-v1"));
    const coordinator = await deploy(wallets.deployer, client, a.coordinator, [config, collateral, executionClassHash]);
    const gmxDeployment = await deploymentIdentity(client, {
      dataStore, eventEmitter, exchangeRouter, router, orderVault, orderHandler, roleStore,
    });
    const isolatedAccount = await deploy(wallets.deployer, client, a.account, [
      accounts.trader.address, accounts.solver.address, market, collateral, gmxDeployment,
    ]);
    const adapter = await deploy(wallets.deployer, client, a.adapter, [
      coordinator,
      await codeIdentity(client, coordinator),
      accounts.solver.address,
      accounts.trader.address,
      market,
      await codeIdentity(client, market),
      collateral,
      await codeIdentity(client, collateral),
      isolatedAccount,
      entryVerifier,
      await codeIdentity(client, entryVerifier),
      gmxDeployment,
    ]);
    await write(wallets.trader, client, isolatedAccount, a.account.abi, "configureEntryController", [
      adapter, await codeIdentity(client, adapter),
    ]);
    const exitController = await deploy(wallets.deployer, client, a.exitController, [
      adapter,
      await codeIdentity(client, adapter),
      isolatedAccount,
      await codeIdentity(client, isolatedAccount),
      exitVerifier,
      await codeIdentity(client, exitVerifier),
      gmxDeployment,
    ]);
    await write(wallets.trader, client, isolatedAccount, a.account.abi, "configureExitController", [
      exitController, await codeIdentity(client, exitController),
    ]);
    const spotFactory = await deploy(wallets.deployer, client, a.spotFactory);
    const spotPool = await deploy(wallets.deployer, client, a.spotPool, [spotFactory, base, collateral, 3_000]);
    await write(wallets.deployer, client, spotFactory, a.spotFactory.abi, "setPool", [base, collateral, 3_000, spotPool]);
    const spotPortDeployment = {
      chainId: BigInt(chainId),
      factory: spotFactory,
      pool: spotPool,
      baseToken: base,
      quoteToken: collateral,
      baseTokenDecimals: 18,
      quoteTokenDecimals: 18,
      poolFee: 3_000,
      factoryCodeHash: await codeIdentity(client, spotFactory),
      poolCodeHash: await codeIdentity(client, spotPool),
      baseTokenCodeHash: await codeIdentity(client, base),
      quoteTokenCodeHash: await codeIdentity(client, collateral),
    };
    const spotPort = await deploy(wallets.deployer, client, a.spotPort, [isolatedAccount, spotPortDeployment]);
    await write(wallets.trader, client, isolatedAccount, a.account.abi, "configureSpotPort", [
      spotPort, await codeIdentity(client, spotPort),
    ]);
    await write(wallets.proposer, client, coordinator, a.coordinator.abi, "proposeAdmission", [
      adapter, adapter, await codeIdentity(client, adapter), await codeIdentity(client, adapter),
    ]);
    await write(wallets.proposer, client, config, a.config.abi, "scheduleUnpause");
    await client.request({ method: "evm_increaseTime", params: [Number(delaySeconds + 1n)] });
    await client.request({ method: "evm_mine", params: [] });
    await write(wallets.governanceExecutor, client, coordinator, a.coordinator.abi, "activateAdmission", [adapter]);
    await write(wallets.governanceExecutor, client, config, a.config.abi, "activateUnpause");
    const seed = 10n ** 24n;
    await write(wallets.deployer, client, base, a.token.abi, "mint", [spotPool, seed]);
    await write(wallets.deployer, client, collateral, a.token.abi, "mint", [spotPool, seed]);
    await write(wallets.deployer, client, collateral, a.token.abi, "mint", [accounts.solver.address, seed]);
    await write(wallets.solver, client, collateral, a.token.abi, "approve", [adapter, seed]);
    await write(wallets.solver, client, collateral, a.token.abi, "approve", [coordinator, seed]);

    const contractAddresses = {
      config, coordinator, collateral, base, dataStore, roleStore, router, orderHandler, eventEmitter,
      orderVault, market, exchangeRouter, entryVerifier, exitVerifier, account: isolatedAccount,
      adapter, exitController, spotFactory, spotPool, spotPort,
    };
    const contracts = Object.fromEntries(await Promise.all(Object.entries(contractAddresses).map(async ([name, address]) => [
      name, { address, codeHash: await codeIdentity(client, address) },
    ])));
    const manifest = Object.freeze({
      schemaVersion: 1,
      environment: "local",
      mainnet: false,
      evidenceGrade: "LOCAL_CONFORMANCE",
      chainId,
      rpc: { url: rpcUrl },
      domain: { domainId, manifestVersion: 1, manifestHash: domainManifestHash },
      contracts,
      identities: Object.fromEntries(Object.entries(accounts).map(([name, account]) => [name, account.address])),
      limitations: [
        "GMX dependencies are deterministic local conformance contracts, not a public GMX deployment.",
        "Local assets have no value and cannot leave this private Anvil chain.",
      ],
    });
    const environment = Object.freeze({ accounts, client, contracts: contractAddresses, gmxDeployment, manifest, wallets });
    await validateArbitrumLocalEnvironment(environment);
    return await callback(environment);
  } finally {
    if (anvil !== undefined) await stopProcess(anvil);
    closeSync(logFd);
    rmSync(runDir, { recursive: true, force: true });
  }
}
