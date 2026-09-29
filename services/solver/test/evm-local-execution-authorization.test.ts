import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileEvmLocalAtomicExecution,
  type EvmLocalAtomicBinding,
  type EvmLocalAtomicBounds,
  type EvmLocalAtomicExecution,
} from '@naryx/adapter-evm';
import type { DomainRef, PackageAdmission } from '@naryx/protocol-types';
import { keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmLocalExecutionAuthorizationService } from '../src/evm-local-execution-authorization.js';

const trader = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const solver = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const otherTrader = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const hash = (label: string) => Uint8Array.from(Buffer.from(keccak256(stringToHex(label)).slice(2), 'hex'));
const domain = {
  domainId: 'eip155:31338',
  domainManifestVersion: 1,
  domainManifestHash: hash('domain'),
} as unknown as DomainRef;
const executor = `0x${'44'.repeat(20)}` as const;
const venue = `0x${'55'.repeat(20)}` as const;
const asset = (assetId: string) => ({ assetId, assetManifestHash: hash(assetId), decimals: 18 });
const base = asset('base');
const quoteAsset = asset('quote');
const admission = {
  orderHash: hash('order'),
  quoteHash: hash('quote'),
  routeHash: hash('route'),
  order: {
    environment: 'local', domain, owner: trader.address, settlementAccount: executor,
    action: 'ENTRY', quantity: { asset: base, atoms: 5n },
    maxSpotQuoteIn: { asset: quoteAsset, atoms: 9n }, nonce: 0n,
  },
  quote: {
    environment: 'local', domain,
    solverVerificationKey: Uint8Array.from(Buffer.from(solver.address.slice(2), 'hex')),
  },
  route: { environment: 'local', domain, action: 'ENTRY' },
} as unknown as PackageAdmission;
const binding: EvmLocalAtomicBinding = {
  chainReference: 31_338n,
  domain,
  executor,
  venue,
  solver: solver.address,
};

function unsignedBounds(traderSignature: Hex): Omit<EvmLocalAtomicBounds, 'solverSignature'> {
  return {
    recipient: trader.address,
    collateralAtoms: 4n,
    nonce: 0n,
    deadline: 2_000_000_000n,
    traderSignature,
  };
}

function executionDigest(execution: EvmLocalAtomicExecution, kind: string): Hex {
  return keccak256(stringToHex(`${kind}:${execution.orderHash}:${execution.nonce}`));
}

async function authorizeWith(account = trader) {
  const placeholder = compileEvmLocalAtomicExecution(admission, binding, {
    ...unsignedBounds(`0x${'00'.repeat(65)}`),
    solverSignature: `0x${'00'.repeat(65)}`,
  });
  const permitDigest = executionDigest(placeholder.payload.execution, 'trader');
  const traderSignature = await account.sign({ hash: permitDigest });
  const chain = {
    environment: 'local' as const,
    mainnet: false as const,
    chainReference: async () => 31_338n,
    traderPermitDigest: async (execution: EvmLocalAtomicExecution) => executionDigest(execution, 'trader'),
    solverAuthorizationDigest: async (execution: EvmLocalAtomicExecution) => executionDigest(execution, 'solver'),
  };
  return new EvmLocalExecutionAuthorizationService({
    chain,
    signer: { address: solver.address, signDigest: (digest) => solver.sign({ hash: digest }) },
  }).authorize({ admission, binding, bounds: unsignedBounds(traderSignature) });
}

test('authorizes a local EVM package with independent trader and solver signatures', async () => {
  const authorized = await authorizeWith();
  assert.equal(authorized.compiled.payload.execution.trader, trader.address);
  assert.equal(authorized.compiled.payload.execution.solver, solver.address);
  assert.equal(authorized.compiled.payload.to, executor);
  assert.equal(authorized.solverSignature.length, 132);
});

test('rejects a trader signature from a different account', async () => {
  await assert.rejects(authorizeWith(otherTrader), /admitted owner/);
});
