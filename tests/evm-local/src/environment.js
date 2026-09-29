import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getContractAddress,
  http,
  keccak256,
  parseEther,
  stringToHex,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = resolve(import.meta.dirname, "../../..");
const artifactRoot = join(root, "contracts/evm/out");
const chainId = 31_338;
const domainId = `eip155:${chainId}`;
const domainManifestHash = keccak256(stringToHex("naryx-base-local-conformance-v1"));
const delaySeconds = 1n;

function artifact(relativePath) {
  const value = JSON.parse(readFileSync(join(artifactRoot, relativePath), "utf8"));
  const object = value.bytecode?.object;
  if (!Array.isArray(value.abi) || typeof object !== "string" || object.length === 0) {
    throw new Error(`Invalid Foundry artifact ${relativePath}`);
  }
  return { abi: value.abi, bytecode: object.startsWith("0x") ? object : `0x${object}` };
}

const artifacts = Object.freeze({
  token: artifact("AtomicPackageExecutor.t.sol/LocalToken.json"),
  config: artifact("ProtocolConfig.sol/ProtocolConfig.json"),
  registry: artifact("SolverRegistry.sol/SolverRegistry.json"),
  venue: artifact("LocalCashCarryVenue.sol/LocalCashCarryVenue.json"),
  executor: artifact("AtomicPackageExecutor.sol/AtomicPackageExecutor.json"),
});

export const evmLocalArtifacts = artifacts;

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
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
    if (child.exitCode !== null) {
      throw new Error(`Anvil exited early\n${readFileSync(logPath, "utf8")}`);
    }
    try {
      if (await client.getChainId() === chainId) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Timed out waiting for local Anvil");
}

async function deploy(wallet, client, contract, args = []) {
  const hash = await wallet.deployContract({
    abi: contract.abi,
    bytecode: contract.bytecode,
    args,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error("Local contract deployment failed");
  }
  return receipt.contractAddress;
}

async function write(wallet, client, address, abi, functionName, args = []) {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Local ${functionName} transaction failed`);
  return receipt;
}

async function setBalance(client, address, atoms = parseEther("100")) {
  await client.request({ method: "anvil_setBalance", params: [address, toHex(atoms)] });
}

function codeHash(code) {
  if (!code || code === "0x") throw new Error("Expected deployed runtime code");
  return keccak256(code);
}

export async function validateEnvironment(environment) {
  const { client, manifest } = environment;
  if (new URL(manifest.rpc.url).hostname !== "127.0.0.1") throw new Error("EVM local RPC is not loopback");
  if ((await client.getChainId()) !== manifest.chainId || manifest.chainId !== chainId) {
    throw new Error("EVM local chain identity mismatch");
  }
  const anchor = await client.getBlock({ blockNumber: 0n });
  if (anchor.hash !== manifest.anchorBlockHash) throw new Error("EVM local anchor block mismatch");
  for (const [name, deployed] of Object.entries(manifest.contracts)) {
    const actual = codeHash(await client.getCode({ address: deployed.address }));
    if (actual !== deployed.codeHash) throw new Error(`${name} code hash mismatch`);
  }
  const domain = await client.readContract({
    address: manifest.contracts.config.address,
    abi: artifacts.config.abi,
    functionName: "domain",
  });
  if (domain[0] !== manifest.domain.domainId || Number(domain[1]) !== manifest.domain.manifestVersion || domain[2] !== manifest.domain.manifestHash) {
    throw new Error("EVM local domain mismatch");
  }
  const activeSolvers = await client.readContract({
    address: manifest.contracts.registry.address,
    abi: artifacts.registry.abi,
    functionName: "activeSolvers",
  });
  if (activeSolvers.length !== 1 || activeSolvers[0].toLowerCase() !== manifest.identities.solver.toLowerCase()) {
    throw new Error("EVM local solver mismatch");
  }
  const paused = await client.readContract({
    address: manifest.contracts.config.address,
    abi: artifacts.config.abi,
    functionName: "entryPaused",
  });
  if (paused) throw new Error("EVM local entry remains paused");
  const allowance = await client.readContract({
    address: manifest.assets.quote.address,
    abi: artifacts.token.abi,
    functionName: "allowance",
    args: [manifest.identities.trader, manifest.contracts.executor.address],
  });
  if (allowance !== BigInt(manifest.seeded.traderQuoteAllowanceAtoms)) throw new Error("EVM local allowance mismatch");
  return true;
}

export async function withLocalEvmEnvironment(callback) {
  const runDir = mkdtempSync(join(tmpdir(), "naryx-evm-local-"));
  const logPath = join(runDir, "anvil.log");
  const logFd = openSync(logPath, "a", 0o600);
  const keys = Object.fromEntries(
    ["deployer", "trader", "solver", "bootstrapSolver", "maker", "recovery", "proposer", "canceller", "governanceExecutor", "pauser"].map(
      (name) => [name, generatePrivateKey()],
    ),
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
    const chain = defineChain({ id: chainId, name: "Naryx EVM Local", nativeCurrency: { name: "Test Ether", symbol: "TETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
    const client = createPublicClient({ chain, transport: http(rpcUrl) });
    await waitForAnvil(client, anvil, logPath);
    for (const account of Object.values(accounts)) await setBalance(client, account.address);
    const wallets = Object.fromEntries(
      Object.entries(accounts).map(([name, account]) => [name, createWalletClient({ account, chain, transport: http(rpcUrl) })]),
    );

    const base = await deploy(wallets.deployer, client, artifacts.token, ["Naryx Test Base", "nBASE"]);
    const quote = await deploy(wallets.deployer, client, artifacts.token, ["Naryx Test Quote", "nQUOTE"]);
    const config = await deploy(wallets.deployer, client, artifacts.config, [
      domainId,
      1,
      domainManifestHash,
      delaySeconds,
      accounts.proposer.address,
      accounts.canceller.address,
      accounts.governanceExecutor.address,
      accounts.pauser.address,
    ]);
    const registry = await deploy(wallets.deployer, client, artifacts.registry, [config, accounts.bootstrapSolver.address]);
    const deployerNonce = BigInt(await client.getTransactionCount({ address: accounts.deployer.address }));
    const predictedExecutor = getContractAddress({ from: accounts.deployer.address, nonce: deployerNonce + 1n });
    const venue = await deploy(wallets.deployer, client, artifacts.venue, [base, quote, predictedExecutor, 3n, 2n]);
    const executor = await deploy(wallets.deployer, client, artifacts.executor, [config, registry, venue]);
    if (executor.toLowerCase() !== predictedExecutor.toLowerCase()) throw new Error("Predicted executor address mismatch");

    await write(wallets.proposer, client, registry, artifacts.registry.abi, "proposeSolver", [accounts.solver.address]);
    await write(wallets.proposer, client, config, artifacts.config.abi, "scheduleUnpause");
    await client.request({ method: "evm_increaseTime", params: [Number(delaySeconds + 1n)] });
    await client.request({ method: "evm_mine", params: [] });
    await write(wallets.governanceExecutor, client, registry, artifacts.registry.abi, "activateSolver", [accounts.solver.address]);
    // The bootstrap solver only seeds the set; the local environment settles with one solver.
    await write(wallets.pauser, client, registry, artifacts.registry.abi, "removeSolver", [accounts.bootstrapSolver.address]);
    await write(wallets.governanceExecutor, client, config, artifacts.config.abi, "activateUnpause");

    const venueSeed = parseEther("1000");
    const traderQuote = parseEther("100");
    for (const [token, recipient, amount] of [
      [base, venue, venueSeed],
      [quote, venue, venueSeed],
      [quote, accounts.trader.address, traderQuote],
    ]) {
      await write(wallets.deployer, client, token, artifacts.token.abi, "mint", [recipient, amount]);
    }
    await write(wallets.trader, client, quote, artifacts.token.abi, "approve", [executor, traderQuote]);

    const anchor = await client.getBlock({ blockNumber: 0n });
    const contracts = {};
    for (const [name, address] of Object.entries({ config, registry, venue, executor })) {
      contracts[name] = { address, codeHash: codeHash(await client.getCode({ address })) };
    }
    const manifest = Object.freeze({
      schemaVersion: 1,
      evidenceGrade: "LOCAL_CONFORMANCE",
      environment: "local",
      chainId,
      rpc: { url: rpcUrl },
      anchorBlockHash: anchor.hash,
      domain: { domainId, manifestVersion: 1, manifestHash: domainManifestHash },
      contracts,
      assets: {
        base: { label: "Naryx Test Base", symbol: "nBASE", address: base, decimals: 18 },
        quote: { label: "Naryx Test Quote", symbol: "nQUOTE", address: quote, decimals: 18 },
      },
      identities: Object.fromEntries(Object.entries(accounts).map(([name, account]) => [name, account.address])),
      economics: { priceNumerator: "3", priceDenominator: "2", configDelaySeconds: delaySeconds.toString() },
      seeded: { venueBaseAtoms: venueSeed.toString(), venueQuoteAtoms: venueSeed.toString(), traderQuoteAtoms: traderQuote.toString(), traderQuoteAllowanceAtoms: traderQuote.toString() },
      limitations: [
        "LocalCashCarryVenue is a deterministic conformance dependency, not a production Base venue.",
        "Local test tokens have no value and cannot leave this private Anvil chain.",
      ],
    });
    const manifestPath = join(runDir, "environment-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const environment = { accounts, client, manifest, manifestPath, rpcUrl, runDir, wallets };
    await validateEnvironment(environment);
    return await callback(environment);
  } finally {
    if (anvil) await stopProcess(anvil);
    closeSync(logFd);
    if (dirname(runDir) !== tmpdir() || !basename(runDir).startsWith("naryx-evm-local-")) {
      throw new Error(`Refusing to clean unexpected run directory ${runDir}`);
    }
    rmSync(runDir, { recursive: true, force: true });
  }
}
