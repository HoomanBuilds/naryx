"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { NaryxApiError, NaryxClient, type VerifiedNativeClearingDomain, type VerifiedRiskDomain } from "@naryx/sdk";
import { formatAtomicAmount } from "../format";
import styles from "./pages.module.css";

type ClearingAccount = Awaited<ReturnType<NaryxClient["getNativeClearingAccounts"]>>[number];
type ClearingMark = Awaited<ReturnType<NaryxClient["getNativeClearingMark"]>>;
type ClearingEvent = Awaited<ReturnType<NaryxClient["getNativeClearingEvents"]>>[number];
type Status = "ACTIVE" | "REDUCE_ONLY" | "LIQUIDATABLE" | "DEFAULTED" | "FLAT";

type AccountHealth = Readonly<
  | { kind: "computed"; equityAtoms: bigint; initialAtoms: bigint; maintenanceAtoms: bigint; status: Status }
  | { kind: "stale" | "no-mark" }
>;

type OwnedAccount = Readonly<{
  domain: VerifiedNativeClearingDomain;
  account: ClearingAccount;
  health: AccountHealth;
  markAgeMs: bigint | null;
  events: readonly ClearingEvent[];
}>;

export type NativeClearingState = Readonly<{
  configured: boolean;
  domains: readonly VerifiedNativeClearingDomain[];
  accounts: readonly OwnedAccount[];
  unreadableDomains: readonly string[];
  eventsPartial: boolean;
  loading: boolean;
  failed: boolean;
}>;

const ZERO = BigInt(0);
const EVENT_PAGE = 500;
const EVENT_PAGES = 10;
const RECENT_EVENTS = 5;
// Clearing state moves slowly; a hidden tab does not poll at all and catches up when it returns.
const CLEARING_REFRESH_MS = 60_000;
const CLEARING_RETRY_MS = 180_000;

function clearingRefreshInterval(query: { state: { status: string } }): number {
  return query.state.status === "error" ? CLEARING_RETRY_MS : CLEARING_REFRESH_MS;
}

/** Where a domain's event scan stopped and the latest events per owned account, bounded. */
type EventTail = Readonly<{ after: number; recent: ReadonlyMap<string, readonly ClearingEvent[]>; partial: boolean }>;

function abs(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

function apiStatus(error: unknown): number {
  return error instanceof NaryxApiError ? error.status : 0;
}

function ageText(value: bigint): string {
  if (value < BigInt(1_000)) return "now";
  if (value < BigInt(60_000)) return `${value / BigInt(1_000)} s ago`;
  if (value < BigInt(3_600_000)) return `${value / BigInt(60_000)} min ago`;
  if (value < BigInt(86_400_000)) return `${value / BigInt(3_600_000)} h ago`;
  return `${value / BigInt(86_400_000)} d ago`;
}

function short(value: string): string {
  return value.length > 22 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value;
}

/**
 * The same equity and margin arithmetic as the protocol's nativeClearingAccountHealth, which the
 * SDK does not export. It is display only and refuses a stale or future mark, as the protocol does.
 */
function accountHealth(account: ClearingAccount, domain: VerifiedNativeClearingDomain, mark: ClearingMark | null, nowMs: bigint): AccountHealth {
  const { policy } = domain;
  if (mark === null) return { kind: "no-mark" };
  if (mark.observedAtMs > nowMs || nowMs - mark.observedAtMs > policy.markMaximumStalenessMs
    || account.positionAtoms % policy.packageQuantityIncrementAtoms !== ZERO) return { kind: "stale" };
  const increments = account.positionAtoms / policy.packageQuantityIncrementAtoms;
  const equityAtoms = account.collateralQuoteAtoms + account.cashBalanceQuoteAtoms + increments * mark.priceTicks * policy.priceTickQuoteAtoms;
  const initialAtoms = abs(increments) * policy.initialMarginQuoteAtomsPerIncrement;
  const maintenanceAtoms = abs(increments) * policy.maintenanceMarginQuoteAtomsPerIncrement;
  const status: Status = account.positionAtoms === ZERO && equityAtoms >= ZERO ? "FLAT"
    : equityAtoms < ZERO ? "DEFAULTED"
      : equityAtoms < maintenanceAtoms ? "LIQUIDATABLE"
        : equityAtoms < initialAtoms ? "REDUCE_ONLY" : "ACTIVE";
  return { kind: "computed", equityAtoms, initialAtoms, maintenanceAtoms, status };
}

function mentions(value: unknown, id: string, depth = 0): boolean {
  if (value === id) return true;
  if (depth > 6 || value === null || typeof value !== "object" || value instanceof Uint8Array) return false;
  return Object.values(value).some((entry) => mentions(entry, id, depth + 1));
}

/**
 * Reads only events after the last scanned sequence and keeps the latest few per account. A long
 * history is scanned a bounded number of pages per poll, so later polls catch up to the head.
 */
async function tailDomainEvents(
  client: NaryxClient,
  clearingDomainId: string,
  accountIds: readonly string[],
  previous: EventTail | undefined,
): Promise<EventTail> {
  const recent = new Map(accountIds.map((id) => [id, [...(previous?.recent.get(id) ?? [])]]));
  let after = previous?.after ?? 0;
  for (let page = 0; page < EVENT_PAGES; page += 1) {
    const batch = await client.getNativeClearingEvents(clearingDomainId, { after, limit: EVENT_PAGE });
    for (const event of batch) {
      for (const [id, events] of recent) {
        if (!mentions(event.payload, id)) continue;
        events.push(event);
        if (events.length > RECENT_EVENTS) events.shift();
      }
    }
    if (batch.length > 0) after = batch[batch.length - 1]!.sequence;
    if (batch.length < EVENT_PAGE) return { after, recent, partial: false };
  }
  return { after, recent, partial: true };
}

export function useNativeClearing(baseUrl: string | null, owners: readonly string[]): NativeClearingState {
  // Per base URL, domain, and account set; a changed account set rescans that domain from the start.
  const tails = useRef(new Map<string, EventTail>());
  const query = useQuery({
    queryKey: ["native-clearing", baseUrl, owners],
    enabled: baseUrl !== null && owners.length > 0,
    refetchInterval: clearingRefreshInterval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const client = new NaryxClient({ baseUrl: baseUrl!.replace(/\/+$/, "") });
      let domains: readonly VerifiedNativeClearingDomain[];
      try {
        domains = await client.getNativeClearingDomains();
      } catch (error) {
        if (apiStatus(error) === 503 || apiStatus(error) === 404) return { configured: false, domains: [], accounts: [], unreadableDomains: [], eventsPartial: false };
        throw error;
      }
      const unreadableDomains: string[] = [];
      let eventsPartial = false;
      const perDomain = await Promise.all(domains.map(async (domain): Promise<readonly OwnedAccount[]> => {
        const id = domain.policy.clearingDomainId;
        try {
          const mine = (await client.getNativeClearingAccounts(id)).filter((account) => owners.includes(account.ownerId));
          if (mine.length === 0) return [];
          const tailKey = `${baseUrl}|${id}|${mine.map((account) => account.accountId).sort().join(",")}`;
          const [mark, history] = await Promise.all([
            client.getNativeClearingMark(id).catch((error: unknown) => {
              if (signal.aborted || apiStatus(error) !== 404) throw error;
              return null;
            }),
            tailDomainEvents(client, id, mine.map((account) => account.accountId), tails.current.get(tailKey)),
          ]);
          tails.current.set(tailKey, history);
          eventsPartial ||= history.partial;
          const nowMs = BigInt(Date.now());
          return mine.map((account) => Object.freeze({
            domain,
            account,
            health: accountHealth(account, domain, mark, nowMs),
            markAgeMs: mark === null ? null : nowMs - mark.observedAtMs,
            events: Object.freeze([...(history.recent.get(account.accountId) ?? [])].reverse()),
          }));
        } catch (error) {
          if (signal.aborted) throw error;
          unreadableDomains.push(id);
          return [];
        }
      }));
      return { configured: true, domains, accounts: perDomain.flat(), unreadableDomains: unreadableDomains.sort(), eventsPartial };
    },
  });
  return {
    configured: baseUrl !== null && query.data?.configured !== false,
    domains: query.data?.domains ?? [],
    accounts: query.data?.accounts ?? [],
    unreadableDomains: query.data?.unreadableDomains ?? [],
    eventsPartial: query.data?.eventsPartial ?? false,
    loading: query.isLoading,
    failed: query.isError,
  };
}

const STATUS_PILL: Readonly<Record<Status, string>> = {
  ACTIVE: styles.pillOk,
  FLAT: styles.pill,
  REDUCE_ONLY: styles.pillWarn,
  LIQUIDATABLE: styles.pillBad,
  DEFAULTED: styles.pillBad,
};

export function NativeClearingCard({ state, connected }: { state: NativeClearingState; connected: boolean }) {
  if (!connected || (!state.configured && !state.loading)) return null;
  return (
    <section className={styles.card} aria-labelledby="native-clearing-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="native-clearing-title">Native clearing accounts</h2>
          <p>Package clearing accounts owned by the connected wallets, verified against each domain&apos;s policy. Equity and margin are recomputed here from the latest signed mark. Deposits and withdrawals are not available from the terminal yet.</p>
        </div>
        <span className={styles.pill}>Read only</span>
      </div>
      {state.failed ? <p className={styles.noticeError} role="status">Native clearing domains could not be read, so no account state is shown. Retrying.</p> : null}
      {state.unreadableDomains.length > 0 ? (
        <p className={styles.noticeError} role="status">Could not read {state.unreadableDomains.join(", ")}; accounts there are missing, not empty.</p>
      ) : null}
      {state.accounts.length === 0 ? (
        <div className={styles.empty}>
          <strong>{state.loading ? "Reading clearing accounts" : "No clearing account"}</strong>
          <p>{state.failed ? "No account amount is inferred while the read fails." : "None of the connected wallets owns an account in a native clearing domain on this service."}</p>
        </div>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col" className={styles.num}>Collateral</th>
                <th scope="col" className={styles.num}>Cash</th>
                <th scope="col" className={styles.num}>Position</th>
                <th scope="col" className={styles.num}>Equity</th>
                <th scope="col" className={styles.num}>Maintenance</th>
                <th scope="col">Status</th>
                <th scope="col">Mark</th>
                <th scope="col">Recent events</th>
              </tr>
            </thead>
            <tbody>
              {state.accounts.map(({ domain, account, health, markAgeMs, events }) => {
                const asset = domain.policy.accountingAsset;
                const symbol = asset.assetId.toUpperCase();
                const amount = (atoms: bigint) => formatAtomicAmount(atoms, asset.decimals, symbol);
                return (
                  <tr key={`${domain.policy.clearingDomainId}:${account.accountId}`}>
                    <td>
                      <span className={styles.mono} title={account.accountId}>{short(account.accountId)}</span>
                      <small className={styles.cellDetail}>{domain.policy.clearingDomainId}</small>
                    </td>
                    <td className={styles.num}>{amount(account.collateralQuoteAtoms)}</td>
                    <td className={styles.num}>{amount(account.cashBalanceQuoteAtoms)}</td>
                    <td className={styles.num} title={`Increment ${domain.policy.packageQuantityIncrementAtoms.toString()} atoms`}>
                      {account.positionAtoms.toLocaleString("en-US")} <span className={styles.dim}>atoms</span>
                    </td>
                    <td className={styles.num}>{health.kind === "computed" ? amount(health.equityAtoms) : <span className={styles.dim}>-</span>}</td>
                    <td className={styles.num}>
                      {health.kind === "computed" ? (
                        <>
                          {amount(health.maintenanceAtoms)}
                          <small className={styles.cellDetail}>{amount(health.initialAtoms)} initial</small>
                        </>
                      ) : <span className={styles.dim}>-</span>}
                    </td>
                    <td>
                      {health.kind === "computed"
                        ? <span className={STATUS_PILL[health.status]}>{health.status.replace("_", " ")}</span>
                        : <span className={styles.pillWarn} title="Equity is not computed without a fresh signed mark">{health.kind === "stale" ? "Mark stale" : "No mark"}</span>}
                    </td>
                    <td>
                      {markAgeMs === null ? <span className={styles.dim}>Unavailable</span> : (
                        <span className={markAgeMs > domain.policy.markMaximumStalenessMs ? styles.pillWarn : styles.pillOk}>
                          {ageText(markAgeMs < ZERO ? ZERO : markAgeMs)}
                        </span>
                      )}
                    </td>
                    <td>
                      {events.length === 0 ? <span className={styles.dim}>None</span> : (
                        <span className={styles.cellStack}>
                          {events.map((event) => {
                            const payload = event.payload as { collateralDeltaQuoteAtoms?: unknown } | null;
                            const delta = event.kind === "COLLATERAL" && typeof payload?.collateralDeltaQuoteAtoms === "bigint" ? payload.collateralDeltaQuoteAtoms : null;
                            return (
                              <span key={event.eventHashHex} title={`Event ${event.eventHashHex}`}>
                                {event.kind} <span className={styles.dim}>#{event.sequence}</span>{delta === null ? null : ` ${amount(delta)}`}
                                <small className={styles.cellDetail}>{ageText(BigInt(Math.max(0, Date.now() - event.recordedAtMs)))}</small>
                              </span>
                            );
                          })}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {state.eventsPartial ? <p className={styles.notice}>Event history is long; {EVENT_PAGE * EVENT_PAGES} more domain events are scanned each refresh until the latest are reached.</p> : null}
    </section>
  );
}

type RiskDomainView = Readonly<{ id: string; status: "observed" | "none" | "unavailable"; view: VerifiedRiskDomain | null }>;

export function useRiskDomains(baseUrl: string | null, ids: readonly string[]) {
  return useQuery({
    queryKey: ["risk-domains", baseUrl, ids],
    enabled: baseUrl !== null && ids.length > 0,
    refetchInterval: clearingRefreshInterval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const client = new NaryxClient({ baseUrl: baseUrl!.replace(/\/+$/, "") });
      return Promise.all(ids.map(async (id): Promise<RiskDomainView> => {
        try {
          return { id, status: "observed", view: await client.getRiskDomain(id) };
        } catch (error) {
          if (signal.aborted) throw error;
          return { id, status: apiStatus(error) === 404 ? "none" : "unavailable", view: null };
        }
      }));
    },
  });
}

export function RiskDomainsCard({ baseUrl, ids, clearingDomains }: {
  baseUrl: string | null;
  ids: readonly string[];
  clearingDomains: readonly VerifiedNativeClearingDomain[];
}) {
  const query = useRiskDomains(baseUrl, ids);
  if (baseUrl === null || ids.length === 0) return null;
  const views = query.data ?? [];
  return (
    <section className={styles.card} aria-labelledby="risk-domains-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="risk-domains-title">Risk domains</h2>
          <p>Every risk domain your strategies touch, across all accounts in it. Exposure and close cost are recomputed here from the signed position records. Caps come from native clearing policy where one governs the domain.</p>
        </div>
        <span className={styles.pill}>Observed</span>
      </div>
      {query.isError ? <p className={styles.noticeError} role="status">Risk domains could not be read. Retrying.</p> : null}
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Risk domain</th>
              <th scope="col" className={styles.num}>Accounts</th>
              <th scope="col" className={styles.num}>Net / gross exposure</th>
              <th scope="col" className={styles.num}>Close cost</th>
              <th scope="col" className={styles.num}>10% stress loss</th>
              <th scope="col" className={styles.num}>Open interest cap</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const entry = views.find((candidate) => candidate.id === id);
              const view = entry?.view ?? null;
              const caps = clearingDomains.filter((domain) => domain.policy.riskDomainId === id);
              const missing = <span className={styles.dim}>{entry === undefined ? (query.isLoading ? "Reading" : "-") : entry.status === "none" ? "No observation" : "Unavailable"}</span>;
              return (
                <tr key={id}>
                  <td className={styles.mono}>{id}</td>
                  <td className={styles.num}>
                    {view === null ? missing : (
                      <>
                        {new Set(view.accounts.map((account) => account.strategyAccount)).size}
                        <small className={styles.cellDetail}>{view.accounts.reduce((sum, account) => sum + account.positionsInDomain, 0)} positions</small>
                      </>
                    )}
                  </td>
                  <td className={styles.num}>
                    {view === null ? missing : view.byAccountingAsset.length === 0 ? <span className={styles.dim}>No exposure</span> : (
                      <span className={styles.cellStack}>
                        {view.byAccountingAsset.map((group) => {
                          const symbol = group.accountingAsset.assetId.toUpperCase();
                          const net = group.exposure.byUnderlying.reduce((sum, line) => sum + line.netNotional, ZERO);
                          const gross = group.exposure.byUnderlying.reduce((sum, line) => sum + line.grossNotional, ZERO);
                          return (
                            <span key={`${group.accountingAsset.assetId}:${group.accountingAsset.decimals}`}>
                              {formatAtomicAmount(net, group.accountingAsset.decimals, symbol)}
                              <small className={styles.cellDetail}>{formatAtomicAmount(gross, group.accountingAsset.decimals, symbol)} gross</small>
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </td>
                  <td className={styles.num}>
                    {view === null ? missing : (
                      <span className={styles.cellStack}>
                        {view.byAccountingAsset.map((group) => (
                          <span key={`${group.accountingAsset.assetId}:${group.accountingAsset.decimals}`}>
                            {formatAtomicAmount(group.closeCost.costQuoteAtoms, group.accountingAsset.decimals, group.accountingAsset.assetId.toUpperCase())}
                            {group.closeCost.complete ? null : <small className={styles.cellDetail}>Incomplete close liquidity</small>}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className={styles.num}>
                    {view === null ? missing : (
                      <span className={styles.cellStack}>
                        {view.byAccountingAsset.map((group) => {
                          const worst = group.stress.results
                            .filter((result) => result.scenarioId === "uniform-down-10pct" || result.scenarioId === "uniform-up-10pct")
                            .reduce((max, result) => result.lossQuoteAtoms > max ? result.lossQuoteAtoms : max, ZERO);
                          return (
                            <span key={`${group.accountingAsset.assetId}:${group.accountingAsset.decimals}`} title="Larger of the fixed 10% down and up shocks, modeled">
                              {formatAtomicAmount(worst, group.accountingAsset.decimals, group.accountingAsset.assetId.toUpperCase())}
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </td>
                  <td className={styles.num}>
                    {caps.length === 0 ? <span className={styles.dim} title="No native clearing policy governs this domain">No cap published</span> : (
                      <span className={styles.cellStack}>
                        {caps.map((domain) => (
                          <span key={domain.policy.clearingDomainId} title={`${domain.policy.clearingDomainId}; per-account maximum ${domain.policy.maximumPositionAtoms.toString()} atoms`}>
                            {domain.state.openInterestAtoms.toLocaleString("en-US")} / {domain.policy.maximumOpenInterestAtoms.toLocaleString("en-US")} <span className={styles.dim}>atoms</span>
                            <small className={styles.cellDetail}>Max {domain.policy.maximumPositionAtoms.toLocaleString("en-US")} per account</small>
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
