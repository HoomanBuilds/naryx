import assert from 'node:assert/strict';
import test from 'node:test';
import { type DomainRef, type Hash32, type PackageAdmission } from '@naryx/protocol-types';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { ATOMIC_PACKAGE_EXECUTOR_ABI, compileEvmLocalAtomicExecution } from '../src/index.js';

const bytes = (value: number): Hash32 => new Uint8Array(32).fill(value) as Hash32;
const address = (value: number): Address => `0x${value.toString(16).padStart(40, '0')}` as Address;
const signature = (value: number): Hex => `0x${value.toString(16).padStart(2, '0').repeat(65)}` as Hex;
const domain = {
  domainId: 'eip155:31338',
  domainManifestVersion: 1,
  domainManifestHash: bytes(1),
} as unknown as DomainRef;

function admission(action: 'ENTRY' | 'EXIT'): PackageAdmission {
  const orderHash = bytes(2);
  const quoteHash = bytes(3);
  const routeHash = bytes(4);
  return {
    orderHash,
    quoteHash,
    routeHash,
    order: {
      environment: 'local',
      domain,
      owner: address(1),
      settlementAccount: address(2),
      action,
      quantity: { asset: { assetId: 'base', assetManifestHash: bytes(5), decimals: 18 }, atoms: 5n },
      ...(action === 'ENTRY'
        ? { maxSpotQuoteIn: { asset: { assetId: 'quote', assetManifestHash: bytes(6), decimals: 18 }, atoms: 9n } }
        : {
            minSpotQuoteOut: { asset: { assetId: 'quote', assetManifestHash: bytes(6), decimals: 18 }, atoms: 7n },
            entryReceiptHash: bytes(7),
          }),
    },
    quote: {
      environment: 'local',
      domain,
      solverVerificationKey: Uint8Array.from(Buffer.from(address(3).slice(2), 'hex')),
    },
    route: { environment: 'local', domain, action },
  } as unknown as PackageAdmission;
}

const binding = {
  chainReference: 31_338n,
  domain,
  executor: address(2),
  venue: address(4),
  solver: address(3),
};

const bounds = {
  recipient: address(5),
  collateralAtoms: 4n,
  nonce: 0n,
  deadline: 100n,
  traderSignature: signature(9),
  solverSignature: signature(10),
};

test('compiles a manifest-bound local atomic entry', () => {
  const compiled = compileEvmLocalAtomicExecution(admission('ENTRY'), binding, bounds);
  assert.equal(compiled.payload.to, binding.executor);
  assert.equal(compiled.payload.execution.action, 1);
  assert.equal(compiled.payload.execution.entryReceiptHash, `0x${'00'.repeat(32)}`);
  const decoded = decodeFunctionData({ abi: ATOMIC_PACKAGE_EXECUTOR_ABI, data: compiled.payload.data });
  assert.equal(decoded.functionName, 'execute');
});

test('binds exit receipt and rejects solver substitution', () => {
  const compiled = compileEvmLocalAtomicExecution(admission('EXIT'), binding, { ...bounds, nonce: 1n });
  assert.equal(compiled.payload.execution.action, 2);
  assert.equal(compiled.payload.execution.entryReceiptHash, `0x${'07'.repeat(32)}`);
  assert.throws(
    () => compileEvmLocalAtomicExecution(admission('ENTRY'), { ...binding, solver: address(8) }, bounds),
    /quoted solver mismatch/,
  );
});
