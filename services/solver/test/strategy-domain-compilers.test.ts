import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  domainRef,
  versionedManifestRef,
} from '@naryx/protocol-types';
import type { EvmStrategyLegMaterializer } from '@naryx/adapter-evm';
import {
  createEvmStrategyDomainCompiler,
  createHyperliquidStrategyDomainCompiler,
} from '../src/index.js';

const domain = domainRef('eip155:84532', 1, '11'.repeat(32));
const otherDomain = domainRef('eip155:421614', 1, '12'.repeat(32));
const adapter = adapterRef({
  adapterId: 'spot-adapter',
  adapterManifestVersion: 1,
  adapterManifestHash: '22'.repeat(32),
});
const venue = versionedManifestRef('spot-venue', 1, '33'.repeat(32));
const market = versionedManifestRef('spot-market', 1, '44'.repeat(32));

function materializer(materializerDomain = domain): EvmStrategyLegMaterializer {
  return {
    domain: materializerDomain,
    adapter,
    venue,
    market,
    legFamily: 'SPOT_SWAP',
    materializationClassId: 'naryx.evm.spot-exact',
    adapterAddress: '0x1111111111111111111111111111111111111111',
    expectedAdapterCodeHash: `0x${'55'.repeat(32)}`,
    maximumGasLimit: 300_000n,
    materialize: () => { throw new Error('not called'); },
  };
}

test('domain compilers expose only their exact runtime family and reject mixed-domain materializers', () => {
  const compiler = createEvmStrategyDomainCompiler({
    domain,
    executionPlanKind: 'EVM_ATOMIC_BATCH',
    strategyAccount: '0x2222222222222222222222222222222222222222',
    materializers: [materializer()],
  });
  assert.equal(compiler.executionPlanKind, 'EVM_ATOMIC_BATCH');
  assert.equal(compiler.domain.domainId, domain.domainId);
  assert.throws(() => createEvmStrategyDomainCompiler({
    domain,
    executionPlanKind: 'EVM_ASYNC_REQUEST',
    strategyAccount: '0x2222222222222222222222222222222222222222',
    materializers: [materializer(otherDomain)],
  }), /materializer domain mismatch/);
  assert.throws(() => createHyperliquidStrategyDomainCompiler({ domain, bindings: [] }), /market binding/);
  const hyperliquidBinding = {
    adapter,
    venue,
    market,
    assetId: 0,
    sizeDecimals: 5,
    maximumPriceDecimals: 6,
  };
  assert.throws(() => createHyperliquidStrategyDomainCompiler({
    domain,
    bindings: [hyperliquidBinding, hyperliquidBinding],
  }), /must be unique/);
});
