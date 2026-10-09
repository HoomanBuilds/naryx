import assert from 'node:assert/strict';
import test from 'node:test';
import type { TimeOptions } from '@hapi/sntp';
import type { OrderSuccessResponse } from '@nktkas/hyperliquid/api/exchange';
import {
  HYPERLIQUID_RECOVERY_SIGNER_SCOPE,
  HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL,
  HyperliquidRecoveryTrustedClock,
  HyperliquidSdkRecoveryTestnetSubmitter,
  type HyperliquidRecoverySigner,
  type HyperliquidRecoveryTestnetExchangeTransport,
} from '../src/index.js';

const agentWallet = `0x${'33'.repeat(20)}` as const;
const clientOrderId = `0x${'51'.repeat(16)}` as const;

function ntp(remoteTimeMs: number, roundTripMs: number): TimeOptions {
  return {
    isValid: true,
    leapIndicator: 'no-warning',
    version: 4,
    mode: 'server',
    stratum: 'secondary',
    pollInterval: 0,
    precision: 0,
    rootDelay: 0,
    rootDispersion: 0,
    referenceId: 'test',
    referenceTimestamp: 0,
    originateTimestamp: 0,
    receiveTimestamp: 0,
    transmitTimestamp: 0,
    d: roundTripMs,
    t: remoteTimeMs - 1_000,
    receivedLocally: 1_000,
  };
}

test('builds a trusted recovery clock decision from two NTP sources and Testnet l2Book', async () => {
  const localTimes = [1_000, 1_005];
  const clock = new HyperliquidRecoveryTrustedClock({
    ntpHosts: ['time.google.com', 'time.cloudflare.com'],
    ntpTimeoutMs: 2_000,
    maximumNtpRoundTripMs: 500,
    maximumSourceSpreadMs: 10,
    maximumLocalClockSkewMs: 10,
    maximumFutureNonceLeadMs: 10_000,
    hyperliquidClockMarket: 'HYPE',
  }, {
    readNtp: async (host) => host === 'time.google.com' ? ntp(1_001, 10) : ntp(1_003, 11),
    readHyperliquidBookTime: async () => 1_002,
    currentTimeMs: () => localTimes.shift()!,
  });
  const decision = await clock.decide('recovery-attempt-1');
  assert.equal(decision.selectedTimeMs, 1_002);
  assert.equal(decision.sourceSpreadMs, 2);
  assert.equal(decision.localClockSkewMs, 3);
  assert.match(decision.decisionHash, /^0x[0-9a-f]{64}$/);
});

function signer(): HyperliquidRecoverySigner {
  return {
    signerScope: HYPERLIQUID_RECOVERY_SIGNER_SCOPE,
    async getAddress() {
      return agentWallet;
    },
    async signTypedData(_domain: unknown, _types: unknown, _value: unknown) {
      return `0x${'01'.repeat(64)}1b`;
    },
  } as HyperliquidRecoverySigner;
}

class FakeTransport implements HyperliquidRecoveryTestnetExchangeTransport {
  readonly isTestnet = true as const;
  readonly apiUrl = HYPERLIQUID_RECOVERY_TESTNET_EXCHANGE_URL;
  requestPayload: unknown;

  request<T>(endpoint: 'exchange', payload: unknown): Promise<T> {
    assert.equal(endpoint, 'exchange');
    this.requestPayload = payload;
    const response: OrderSuccessResponse = {
      status: 'ok',
      response: {
        type: 'order',
        data: {
          statuses: [{ filled: {
            totalSz: '0.001',
            avgPx: '60000',
            oid: 1,
            cloid: clientOrderId,
          } }],
        },
      },
    };
    return Promise.resolve(response as T);
  }
}

test('signs and submits the exact durable recovery action only to Hyperliquid Testnet', async () => {
  const transport = new FakeTransport();
  const submitter = new HyperliquidSdkRecoveryTestnetSubmitter(signer(), transport);
  const result = await submitter.submit({
    action: {
      type: 'order',
      grouping: 'na',
      orders: [{
        a: 3,
        b: false,
        p: '60000',
        s: '0.001',
        r: false,
        t: { limit: { tif: 'Ioc' } },
        c: clientOrderId,
      }],
    },
    nonce: 1_001n,
    expiresAfterMs: 5_000n,
    vaultAddress: null,
  });
  assert.match(result.acknowledgementId, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(transport.requestPayload, {
    action: {
      type: 'order',
      grouping: 'na',
      orders: [{
        a: 3,
        b: false,
        p: '60000',
        s: '0.001',
        r: false,
        t: { limit: { tif: 'Ioc' } },
        c: clientOrderId,
      }],
    },
    signature: { r: `0x${'01'.repeat(32)}`, s: `0x${'01'.repeat(32)}`, v: 27 },
    nonce: 1_001,
    expiresAfter: 5_000,
    vaultAddress: undefined,
  });
});
