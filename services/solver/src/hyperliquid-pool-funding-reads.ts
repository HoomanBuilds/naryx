import { HttpTransport, InfoClient, ExplorerClient, SubscriptionClient, WebSocketTransport, TESTNET_API_URL, TESTNET_API_WS_URL, TESTNET_RPC_URL } from '@nktkas/hyperliquid';
import type { AllDexsClearinghouseStateEvent } from '@nktkas/hyperliquid/api/subscription';
import { decimalToAtoms } from '@naryx/adapter-hyperliquid';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import type { HyperliquidPoolFundingReadPort } from './hyperliquid-pool-funding.js';

const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const ZERO = /^-?0(?:\.0+)?$/;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Pool venue evidence: ${message}`);
}

async function allDexStates(account: `0x${string}`): Promise<AllDexsClearinghouseStateEvent> {
  const transport = new WebSocketTransport({ isTestnet: true, url: TESTNET_API_WS_URL, timeout: 5_000, resubscribe: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<AllDexsClearinghouseStateEvent>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Pool all-DEX snapshot timed out')), 5_000);
      new SubscriptionClient({ transport }).allDexsClearinghouseState({ user: account }, resolve).catch(reject);
    });
  } finally { clearTimeout(timer); transport.close(); }
}

export function hyperliquidTestnetPoolFundingReads(collateralTokenId: `0x${string}`): HyperliquidPoolFundingReadPort {
  const transport = new HttpTransport({ isTestnet: true, apiUrl: TESTNET_API_URL, rpcUrl: TESTNET_RPC_URL, timeout: 5_000 });
  const explorer = new ExplorerClient({ transport });
  return createHyperliquidPoolFundingReads(collateralTokenId, new InfoClient({ transport }),
    { txDetails: params => explorer.txDetails(params) }, allDexStates);
}

export function createHyperliquidPoolFundingReads(collateralTokenId: `0x${string}`,
  info: Pick<InfoClient, 'userRole' | 'userAbstraction' | 'userDexAbstraction' | 'spotClearinghouseState'
    | 'openOrders' | 'meta' | 'spotMeta' | 'twapHistory' | 'userNonFundingLedgerUpdates'>,
  explorer: { txDetails(params: Parameters<ExplorerClient['txDetails']>[0]): ReturnType<ExplorerClient['txDetails']> },
  snapshot: (account: `0x${string}`) => Promise<AllDexsClearinghouseStateEvent>, clock = Date.now,
): HyperliquidPoolFundingReadPort {
  check(/^0x[0-9a-f]{32}$/.test(collateralTokenId), 'collateral token id is invalid');
  return {
    async flat(account) {
      check(ADDRESS.test(account), 'invalid pool account');
      const requestedAtMs = clock();
      const [role, abstraction, dexAbstraction, spot, all, orders, meta, spotMeta, twaps] = await Promise.all([
        info.userRole({ user: account }), info.userAbstraction({ user: account }),
        info.userDexAbstraction({ user: account }), info.spotClearinghouseState({ user: account }),
        snapshot(account), info.openOrders({ user: account, dex: '' }),
        info.meta({ dex: '' }), info.spotMeta(), info.twapHistory({ user: account }),
      ]);
      const collateral = spotMeta.tokens.find(token => token.index === meta.collateralToken);
      check(meta.collateralToken === 0 && collateral?.name === 'USDC'
        && collateral.isCanonical && collateral.weiDecimals === 8 && collateral.tokenId.toLowerCase() === collateralTokenId,
      'default perpetual collateral identity changed');
      check(twaps.every(twap => ['finished', 'terminated', 'stopped', 'error'].includes(twap.status.status)),
        'pool has active or waiting TWAP instructions');
      check(all.user.toLowerCase() === account && all.clearinghouseStates.length > 0
        && all.clearinghouseStates.length <= 1_024, 'all-DEX snapshot identity or bound differs');
      const dexes = all.clearinghouseStates.map(([dex]) => dex);
      check(new Set(dexes).size === dexes.length && dexes.includes(''), 'all-DEX snapshot is missing or repeats the settlement DEX');
      check(role.role === 'user' && (abstraction === 'default' || abstraction === 'disabled')
        && dexAbstraction === false && spot.portfolioMarginEnabled !== true,
      'pool must be a dedicated Standard testnet account');
      check(spot.balances.every(balance => ZERO.test(balance.total) && ZERO.test(balance.hold)
        && (!('borrowed' in balance) || balance.borrowed === undefined || ZERO.test(balance.borrowed))
        && (!('supplied' in balance) || balance.supplied === undefined || ZERO.test(balance.supplied)))
        && (spot.evmEscrows ?? []).every(balance => ZERO.test(balance.total)), 'pool has non-perpetual assets or liabilities');
      check(orders.length === 0, 'pool has open orders on the settlement DEX');
      const observedAtMs = clock();
      for (const [dex, state] of all.clearinghouseStates) {
        check(Number.isSafeInteger(state.time) && state.time >= requestedAtMs - 5_000 && state.time <= observedAtMs
          && state.assetPositions.every(entry => ZERO.test(entry.position.szi))
          && ZERO.test(state.marginSummary.totalNtlPos) && ZERO.test(state.marginSummary.totalMarginUsed)
          && ZERO.test(state.crossMaintenanceMarginUsed), 'pool is not freshly flat');
        const equity = decimalToAtoms(state.marginSummary.accountValue, 6, 'pool equity');
        check(equity >= 0n && decimalToAtoms(state.marginSummary.totalRawUsd, 6, 'pool raw balance') === equity
          && decimalToAtoms(state.withdrawable, 6, 'pool withdrawable balance') === equity,
        'pool equity is not fully withdrawable');
        if (dex !== '') check(equity === 0n, 'pool holds collateral on an unsupported DEX');
      }
      const primary = all.clearinghouseStates.find(([dex]) => dex === '')![1];
      return { environment: 'TESTNET', account, equityQuoteAtoms: decimalToAtoms(primary.marginSummary.accountValue, 6, 'pool equity'),
        withdrawableQuoteAtoms: decimalToAtoms(primary.withdrawable, 6, 'pool withdrawable'), requestedAtMs, observedAtMs };
    },
    async transfer(hash, timeMs, source, destination) {
      check(/^0x[0-9a-f]{64}$/.test(hash) && Number.isSafeInteger(timeMs) && timeMs > 0
        && timeMs <= clock() && ADDRESS.test(source) && ADDRESS.test(destination) && source !== destination,
      'invalid transfer lookup');
      const histories = await Promise.all([source, destination].map(user => info.userNonFundingLedgerUpdates({
        user, startTime: timeMs, endTime: timeMs,
      })));
      const matches = histories.map(history => history.filter(entry => entry.hash.toLowerCase() === hash && entry.time === timeMs));
      check(matches.every(rows => rows.length === 1)
        && stringifyProtocolJson(matches[0]![0]) === stringifyProtocolJson(matches[1]![0]),
      'transfer is not identically observed in both account histories');
      const entry = matches[0]![0]!;
      check(entry.delta.type === 'internalTransfer', 'only Core USDC internal transfers are admitted');
      const transfer = entry.delta;
      check(transfer.user.toLowerCase() === source && transfer.destination.toLowerCase() === destination,
        'transfer counterparty mismatch');
      const debitedQuoteAtoms = decimalToAtoms(transfer.usdc, 6, 'transfer amount');
      const fee = decimalToAtoms(transfer.fee, 6, 'transfer fee');
      check(fee >= 0n && debitedQuoteAtoms > fee, 'transfer fee consumes the receipt');
      const { tx } = await explorer.txDetails({ hash: hash as `0x${string}` });
      const action = tx.action;
      check(tx.error === null && tx.hash.toLowerCase() === hash && tx.user.toLowerCase() === source
        && tx.time === timeMs && Number.isSafeInteger(tx.block) && tx.block > 0
        && action.type === 'usdSend' && action.hyperliquidChain === 'Testnet'
        && typeof action.destination === 'string' && action.destination.toLowerCase() === destination
        && typeof action.amount === 'string' && decimalToAtoms(action.amount, 6, 'transfer action amount') === debitedQuoteAtoms
        && typeof action.time === 'number' && Number.isSafeInteger(action.time) && action.time > 0 && action.time <= timeMs,
      'successful testnet transfer action does not match the ledger evidence');
      return { environment: 'TESTNET', hash, source, destination, debitedQuoteAtoms,
        receivedQuoteAtoms: debitedQuoteAtoms - fee, timeMs, nonce: action.time };
    },
  };
}
