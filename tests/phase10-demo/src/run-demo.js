import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { buildEvidence, resultStatus } from "./evidence.js";

const root = resolve(import.meta.dirname, "../../..");
const tailLimit = 16_384;

const steps = Object.freeze([
  {
    id: "evm-contract-build",
    title: "EVM contract artifacts",
    command: "forge",
    args: ["build", "--root", "contracts/evm"],
    timeoutMs: 120_000,
  },
  {
    id: "solana-local-lifecycle",
    title: "Solana local entry, rollback, restart, exit, and terminal lifecycle",
    command: "npm",
    args: ["--prefix", "tests/solana-local", "run", "test:phase-exit"],
    timeoutMs: 300_000,
  },
  {
    id: "base-local-atomic-lifecycle",
    title: "Base local atomic entry, failed-entry rollback, and exit",
    command: "npm",
    args: ["--prefix", "tests/evm-local", "run", "test:scenario"],
    timeoutMs: 90_000,
  },
  {
    id: "arbitrum-local-async-lifecycle",
    title: "Arbitrum local async entry, failed-entry rollback, and close",
    command: "npm",
    args: ["--prefix", "tests/arbitrum-local", "run", "test:scenario"],
    timeoutMs: 90_000,
  },
]);

const skipped = Object.freeze([
  {
    id: "solana-devnet-public-lifecycle",
    title: "Solana Devnet public lifecycle",
    status: "SKIPPED",
    reason: "Requires separately reviewed Devnet credentials and test funds",
  },
  {
    id: "base-sepolia-public-lifecycle",
    title: "Base Sepolia public lifecycle",
    status: "SKIPPED",
    reason: "Requires separately reviewed testnet credentials and test funds",
  },
  {
    id: "arbitrum-sepolia-public-lifecycle",
    title: "Arbitrum Sepolia public lifecycle",
    status: "SKIPPED",
    reason: "Requires separately reviewed testnet credentials and test funds",
  },
  {
    id: "hyperliquid-testnet-public-lifecycle",
    title: "Hyperliquid Testnet public lifecycle",
    status: "SKIPPED",
    reason: "Requires a qualified live market, isolated agent account, and test funds",
  },
  {
    id: "production-state-and-shadow-reads",
    title: "Pinned production-state and signerless shadow checks",
    status: "SKIPPED",
    reason: "Requires explicit credential-free RPC endpoints and is not local deterministic evidence",
  },
]);

function outputPath() {
  const index = process.argv.indexOf("--output");
  if (index === -1) return resolve(root, "tmp/phase10-demo-evidence.json");
  const value = process.argv[index + 1];
  if (!value) throw new Error("--output requires a path");
  return resolve(process.cwd(), value);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function childEnvironment() {
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "RUSTUP_HOME",
    "CARGO_HOME",
  ];
  const environment = Object.fromEntries(
    names
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  return {
    ...environment,
    CI: "1",
    NO_COLOR: "1",
    NARYX_DEMO_NETWORK_POLICY: "LOCAL_ONLY_NO_PUBLIC_WRITES",
  };
}

function appendTail(current, chunk) {
  const combined = current + chunk;
  return combined.length <= tailLimit ? combined : combined.slice(-tailLimit);
}

async function runStep(step) {
  process.stdout.write(`\n[${step.id}] ${step.title}\n`);
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutTail = "";
  let stderrTail = "";
  let timedOut = false;

  const child = spawn(step.command, step.args, {
    cwd: root,
    env: childEnvironment(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    stdoutHash.update(chunk);
    stdoutTail = appendTail(stdoutTail, chunk.toString("utf8"));
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrHash.update(chunk);
    stderrTail = appendTail(stderrTail, chunk.toString("utf8"));
    process.stderr.write(chunk);
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    }, 2_000).unref();
  }, step.timeoutMs);

  const outcome = await new Promise((resolvePromise) => {
    child.once("error", (error) =>
      resolvePromise({ exitCode: null, signal: null, spawnError: error.message }),
    );
    child.once("exit", (exitCode, signal) =>
      resolvePromise({ exitCode, signal, spawnError: null }),
    );
  });
  clearTimeout(timeout);
  const status = resultStatus(outcome.exitCode, timedOut);
  process.stdout.write(`[${step.id}] ${status}\n`);
  return {
    id: step.id,
    title: step.title,
    status,
    command: [step.command, ...step.args],
    cwd: ".",
    timeoutMs: step.timeoutMs,
    timedOut,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    spawnError: outcome.spawnError,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    stdoutSha256: stdoutHash.digest("hex"),
    stderrSha256: stderrHash.digest("hex"),
    stdoutTail,
    stderrTail,
  };
}

const startedAt = new Date().toISOString();
const commit = git(["rev-parse", "HEAD"]);
const dirty = git(["status", "--porcelain", "--untracked-files=no"]).length > 0;
const results = [];
for (const step of steps) results.push(await runStep(step));
const evidence = buildEvidence({
  commit,
  dirty,
  startedAt,
  finishedAt: new Date().toISOString(),
  results,
  skipped,
});
const destination = outputPath();
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(`\nEvidence: ${destination}\nResult: ${evidence.status}\n`);
if (evidence.status !== "PASSED") process.exitCode = 1;
