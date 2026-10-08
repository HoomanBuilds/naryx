import assert from "node:assert/strict";
import test from "node:test";
import { strategyCommandAuthorizationTypedData, type StrategyCommandInput } from "@naryx/protocol-types";
import { privateKeyToAccount } from "viem/accounts";
import {
  storedStrategyCommandAuthorization,
  verifyStrategyCommandAuthorization,
} from "../src/strategy-command-authorization.js";

const owner = privateKeyToAccount(`0x${"41".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"42".repeat(32)}`);

function command(): StrategyCommandInput {
  return {
    commandVersion: 1,
    environment: "testnet",
    strategyId: "evm-carry-1",
    actorId: owner.address.toLowerCase(),
    expectedStateVersion: 2n,
    expectedStateHash: "22".repeat(32),
    atValue: 1_800_000_000_000n,
    parameters: { kind: "ASSIGN_INTERNAL", subaccountId: "treasury" },
  };
}

test("verifies and restores an EVM strategy command authorization", async () => {
  const input = command();
  const signerId = owner.address.toLowerCase();
  const signature = (await owner.signTypedData(strategyCommandAuthorizationTypedData(input, signerId) as never)).toLowerCase();
  const verified = await verifyStrategyCommandAuthorization(input, signerId, { scheme: "EIP712_SECP256K1", signature });
  assert.equal(verified?.length, 65);
  assert.deepEqual(storedStrategyCommandAuthorization(signerId, verified as Uint8Array), {
    scheme: "EIP712_SECP256K1",
    signature,
  });
  assert.equal(await verifyStrategyCommandAuthorization(input, stranger.address.toLowerCase(), { scheme: "EIP712_SECP256K1", signature }), undefined);
});
