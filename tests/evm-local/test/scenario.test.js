import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseEther,
  parseEventLogs,
  stringToHex,
  toHex,
} from "viem";
import { evmLocalArtifacts, withLocalEvmEnvironment } from "../src/environment.js";

const entryAction = 1;
const exitAction = 2;

function execution(environment, action, nonce, entryReceiptHash = `0x${"00".repeat(32)}`) {
  const { manifest } = environment;
  return {
    domainIdHash: keccak256(stringToHex(manifest.domain.domainId)),
    domainManifestVersion: manifest.domain.manifestVersion,
    domainManifestHash: manifest.domain.manifestHash,
    orderHash: keccak256(stringToHex(`base-local-order-${action}-${nonce}`)),
    quoteHash: keccak256(stringToHex(`base-local-quote-${action}-${nonce}`)),
    routeHash: keccak256(stringToHex(`base-local-route-${action}-${nonce}`)),
    action,
    quantity: parseEther("5"),
    limitQuote: action === entryAction ? parseEther("9") : parseEther("7"),
    collateral: parseEther("4"),
    trader: manifest.identities.trader,
    recipient: manifest.identities.recovery,
    solver: manifest.identities.solver,
    venue: manifest.contracts.venue.address,
    executor: manifest.contracts.executor.address,
    chainId: BigInt(manifest.chainId),
    entryReceiptHash,
    nonce,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  };
}

async function signatures(environment, value) {
  const traderDigest = await environment.client.readContract({
    address: environment.manifest.contracts.executor.address,
    abi: evmLocalArtifacts.executor.abi,
    functionName: "traderPermitDigest",
    args: [value],
  });
  const solverDigest = await environment.client.readContract({
    address: environment.manifest.contracts.executor.address,
    abi: evmLocalArtifacts.executor.abi,
    functionName: "solverAuthorizationDigest",
    args: [value],
  });
  return {
    trader: await environment.accounts.trader.sign({ hash: traderDigest }),
    solver: await environment.accounts.solver.sign({ hash: solverDigest }),
  };
}

async function balances(environment) {
  const { client, manifest } = environment;
  const read = (token, owner) =>
    client.readContract({
      address: token,
      abi: evmLocalArtifacts.token.abi,
      functionName: "balanceOf",
      args: [owner],
    });
  return {
    executorBase: await read(manifest.assets.base.address, manifest.contracts.executor.address),
    executorQuote: await read(manifest.assets.quote.address, manifest.contracts.executor.address),
    traderQuote: await read(manifest.assets.quote.address, manifest.identities.trader),
    venueBase: await read(manifest.assets.base.address, manifest.contracts.venue.address),
    venueQuote: await read(manifest.assets.quote.address, manifest.contracts.venue.address),
  };
}

async function submit(environment, value) {
  const signed = await signatures(environment, value);
  const data = encodeFunctionData({
    abi: evmLocalArtifacts.executor.abi,
    functionName: "execute",
    args: [value, signed.trader, signed.solver],
  });
  const hash = await environment.wallets.deployer.sendTransaction({
    to: environment.manifest.contracts.executor.address,
    data,
    gas: 3_000_000n,
  });
  return environment.client.waitForTransactionReceipt({ hash });
}

test("executes Base local rollback, entry, and exit", { timeout: 30_000 }, async () => {
  await withLocalEvmEnvironment(async (environment) => {
    const { client, manifest } = environment;
    const beforeFailure = await balances(environment);
    const positionSlot = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [manifest.identities.trader, 0n],
      ),
    );
    await client.request({
      method: "anvil_setStorageAt",
      params: [manifest.contracts.venue.address, positionSlot, toHex(1n, { size: 32 })],
    });
    const failed = await submit(environment, execution(environment, entryAction, 0n));
    assert.equal(failed.status, "reverted");
    assert.deepEqual(await balances(environment), beforeFailure);
    assert.equal(
      await client.readContract({
        address: manifest.contracts.executor.address,
        abi: evmLocalArtifacts.executor.abi,
        functionName: "nextNonce",
        args: [manifest.identities.trader],
      }),
      0n,
    );
    await client.request({
      method: "anvil_setStorageAt",
      params: [manifest.contracts.venue.address, positionSlot, toHex(0n, { size: 32 })],
    });

    const entry = await submit(environment, execution(environment, entryAction, 0n));
    assert.equal(entry.status, "success");
    const entryEvents = parseEventLogs({
      abi: evmLocalArtifacts.executor.abi,
      eventName: "PackageExecuted",
      logs: entry.logs,
      strict: true,
    });
    assert.equal(entryEvents.length, 1);
    const entryReceiptHash = entryEvents[0].args.receiptHash;
    const open = await client.readContract({
      address: manifest.contracts.executor.address,
      abi: evmLocalArtifacts.executor.abi,
      functionName: "positions",
      args: [manifest.identities.trader],
    });
    assert.equal(open[0], parseEther("5"));
    assert.equal(open[1], parseEther("4"));
    assert.equal(open[2], entryReceiptHash);

    const exit = await submit(environment, execution(environment, exitAction, 1n, entryReceiptHash));
    assert.equal(exit.status, "success");
    const closed = await client.readContract({
      address: manifest.contracts.executor.address,
      abi: evmLocalArtifacts.executor.abi,
      functionName: "positions",
      args: [manifest.identities.trader],
    });
    assert.deepEqual(closed, [0n, 0n, `0x${"00".repeat(32)}`]);
    assert.equal(
      await client.readContract({
        address: manifest.contracts.executor.address,
        abi: evmLocalArtifacts.executor.abi,
        functionName: "nextNonce",
        args: [manifest.identities.trader],
      }),
      2n,
    );
  });
});
