/**
 * Perpetual venue account profiles for the cash-and-carry perp leg. `PHOENIX_RISE` matches the
 * default `naryx_core` build. `NARYX_TEST_PERP` matches a `naryx_core` built with the
 * `devnet-test-perp` feature, which keeps the `rise_strategy` slot for the venue strategy PDA and
 * replaces the Rise venue accounts with the test perp accounts. A Devnet manifest selects the kind;
 * there is no implicit fallback between them.
 */
export type SolanaPerpVenueKind = 'PHOENIX_RISE' | 'NARYX_TEST_PERP';

export const RISE_VENUE_ACCOUNT_NAMES = [
  'riseLogAuthority',
  'riseGlobalConfig',
  'riseTraderAccount',
  'risePerpAssetMap',
  'riseGlobalTraderIndexHeader',
  'riseActiveTraderBufferHeader',
  'riseOrderbook',
  'riseSplineCollection',
] as const;
export type RiseVenueAccountName = typeof RISE_VENUE_ACCOUNT_NAMES[number];

export const NARYX_TEST_PERP_ACCOUNT_NAMES = [
  'testPerpMarket',
  'testPerpPosition',
  'testPerpOracle',
  'testPerpCollateralVault',
  'testPerpFeeVault',
  'testPerpInsuranceVault',
] as const;
export type NaryxTestPerpAccountName = typeof NARYX_TEST_PERP_ACCOUNT_NAMES[number];

export type PerpVenueAccountName = RiseVenueAccountName | NaryxTestPerpAccountName;

export interface PerpVenueAccountSpec {
  readonly idlName: string;
  readonly bindingName: PerpVenueAccountName;
  readonly writable: boolean;
}

export interface SolanaPerpVenueProfile {
  readonly kind: SolanaPerpVenueKind;
  readonly accounts: readonly PerpVenueAccountSpec[];
  readonly venueSubject: PerpVenueAccountName;
  readonly marketSubject: PerpVenueAccountName;
  readonly maxDynamicAccounts: number;
}

const RISE_PROFILE: SolanaPerpVenueProfile = Object.freeze({
  kind: 'PHOENIX_RISE',
  accounts: Object.freeze([
    { idlName: 'rise_log_authority', bindingName: 'riseLogAuthority', writable: false },
    { idlName: 'rise_global_config', bindingName: 'riseGlobalConfig', writable: true },
    { idlName: 'rise_trader_account', bindingName: 'riseTraderAccount', writable: true },
    { idlName: 'rise_perp_asset_map', bindingName: 'risePerpAssetMap', writable: true },
    { idlName: 'rise_global_trader_index_header', bindingName: 'riseGlobalTraderIndexHeader', writable: true },
    { idlName: 'rise_active_trader_buffer_header', bindingName: 'riseActiveTraderBufferHeader', writable: true },
    { idlName: 'rise_orderbook', bindingName: 'riseOrderbook', writable: true },
    { idlName: 'rise_spline_collection', bindingName: 'riseSplineCollection', writable: true },
  ] as const),
  venueSubject: 'riseGlobalConfig',
  marketSubject: 'riseOrderbook',
  maxDynamicAccounts: 5,
});

// The test perp market account is the subject of both the venue and the market record.
const TEST_PERP_PROFILE: SolanaPerpVenueProfile = Object.freeze({
  kind: 'NARYX_TEST_PERP',
  accounts: Object.freeze([
    { idlName: 'test_perp_market', bindingName: 'testPerpMarket', writable: true },
    { idlName: 'test_perp_position', bindingName: 'testPerpPosition', writable: true },
    { idlName: 'test_perp_oracle', bindingName: 'testPerpOracle', writable: false },
    { idlName: 'test_perp_collateral_vault', bindingName: 'testPerpCollateralVault', writable: true },
    { idlName: 'test_perp_fee_vault', bindingName: 'testPerpFeeVault', writable: true },
    { idlName: 'test_perp_insurance_vault', bindingName: 'testPerpInsuranceVault', writable: true },
  ] as const),
  venueSubject: 'testPerpMarket',
  marketSubject: 'testPerpMarket',
  maxDynamicAccounts: 0,
});

export function solanaPerpVenueProfile(kind: SolanaPerpVenueKind | undefined): SolanaPerpVenueProfile {
  if (kind === undefined || kind === 'PHOENIX_RISE') return RISE_PROFILE;
  if (kind === 'NARYX_TEST_PERP') return TEST_PERP_PROFILE;
  throw new Error('unsupported perp venue kind');
}

/** Rejects a binding that carries accounts for a venue other than the selected one. */
export function requireOnlyProfileVenueAccounts(accounts: object, profile: SolanaPerpVenueProfile): void {
  const selected = new Set<string>(profile.accounts.map((account) => account.bindingName));
  for (const name of [...RISE_VENUE_ACCOUNT_NAMES, ...NARYX_TEST_PERP_ACCOUNT_NAMES]) {
    if (Object.hasOwn(accounts, name) !== selected.has(name)) {
      throw new Error(`perp venue account ${name} does not match ${profile.kind}`);
    }
  }
}
