"use client";

import { NaryxClient, type VerifiedCrossBatchClearing } from "@naryx/sdk";
import { useQuery } from "@tanstack/react-query";
import { ChainIcon } from "@/features/brand/chain-icons";
import { SolverMetrics } from "../pro/solver-metrics";
import type { PrivateTerminalRuntimeHealth, RuntimeBoundaryHealth } from "../private-http-terminal-provider";
import type { DomainId } from "../terminal-view-model";
import { DOMAIN_META, DOMAIN_ORDER, domainHealth, domainLive, useTerminal, type HealthState } from "../shell/terminal-context";
import t from "../trading-terminal.module.css";
import styles from "./pages.module.css";

type Status = "Available" | "Checking" | "Unavailable" | "Preview";

function statusOf(healthState: HealthState, health: RuntimeBoundaryHealth | null, gateUp: boolean): Status {
  if (healthState === "unconfigured") return "Preview";
  if (!health) return healthState === "checking" ? "Checking" : "Unavailable";
  return health.available && gateUp ? "Available" : "Unavailable";
}

function blockerOf(healthState: HealthState, health: RuntimeBoundaryHealth | null, domain: DomainId, gateUp: boolean): string {
  if (healthState === "unconfigured") return "Private service not configured. No testnet execution from this terminal.";
  if (!health) return healthState === "checking" ? "Checking private service health." : "Service health unavailable.";
  if (health.available) {
    if (!gateUp) return "Runtime up, but the execution safety gate is not configured, so trades are refused.";
    if (domain === "solana") return "Live. Every Devnet signature follows an explicit review.";
    if (domain === "hyperliquid") return "Live. Naryx's shared testnet account executes each package your wallet signs, one at a time.";
    return "Live. Your wallet signs each reviewed package.";
  }
  if (health.reason === "DISABLED_BY_CONFIGURATION") return "Disabled in service configuration.";
  if (health.reason === "RUNTIME_FACTORY_NOT_INJECTED") return "Runtime not wired in the service.";
  if (health.reason === "RUNTIME_INITIALIZATION_FAILED") return "Runtime failed to start.";
  if (health.reason === "REQUIRED_PORTS_MISSING") return "Service ports missing.";
  return "Runtime unavailable.";
}

function pillFor(status: Status) {
  return status === "Available" ? styles.pillOk : status === "Checking" ? styles.pill : status === "Preview" ? styles.pill : styles.pillWarn;
}

function domainGateUp(domain: DomainId, health: PrivateTerminalRuntimeHealth | null): boolean {
  if (health?.controls.executionReadinessAvailable !== true) return false;
  return health.executionReadiness === null || health.executionReadiness.domains.some((entry) =>
    entry.domainId === DOMAIN_META[domain].domainId);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compact(value: string): string {
  return value.length > 19 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function clearingDomain(clearing: VerifiedCrossBatchClearing): string {
  const domain = DOMAIN_ORDER.find((candidate) => DOMAIN_META[candidate].domainId === clearing.plan.domain.domainId);
  return domain === undefined ? clearing.plan.domain.domainId : DOMAIN_META[domain].label;
}

function clearingStatusClass(status: VerifiedCrossBatchClearing["status"]): string {
  if (status === "EXACT_FILLED") return styles.pillOk;
  if (status === "RECOVERY_REQUIRED") return styles.pillBad;
  return styles.pillWarn;
}

export function NetworkView() {
  const { selectedDomain, setSelectedDomain, runtimeHealth, healthState, refreshHealth, publicApiBaseUrl } = useTerminal();
  const pooledClearings = useQuery({
    queryKey: ["recent-cross-batch-clearings", publicApiBaseUrl],
    enabled: publicApiBaseUrl !== null,
    retry: false,
    refetchInterval: 15_000,
    queryFn: () => {
      if (publicApiBaseUrl === null) throw new Error("Public API not configured.");
      return new NaryxClient({ baseUrl: publicApiBaseUrl }).listRecentCrossBatchClearings(20);
    },
  });
  const nativeClearings = useQuery({
    queryKey: ["native-clearing-domains", publicApiBaseUrl],
    enabled: publicApiBaseUrl !== null,
    retry: false,
    refetchInterval: 15_000,
    queryFn: () => {
      if (publicApiBaseUrl === null) throw new Error("Public API not configured.");
      return new NaryxClient({ baseUrl: publicApiBaseUrl }).getNativeClearingDomains();
    },
  });
  const gateUp = domainGateUp(selectedDomain, runtimeHealth);
  const anyTestnetLive = DOMAIN_ORDER.some((domain) => domainLive(domain, runtimeHealth));
  const selectedMeta = DOMAIN_META[selectedDomain];
  const selectedHealth = domainHealth(selectedDomain, runtimeHealth);
  const localVerified = runtimeHealth !== null &&
    runtimeHealth.controls.localAtomicRuntimeMode === "MANIFEST_VALIDATED" &&
    runtimeHealth.controls.localExecutionAvailable &&
    runtimeHealth.controls.lifecycleReadAvailable &&
    runtimeHealth.controls.solverQuotingAvailable;
  const stages = [
    { label: "Local verification", state: localVerified ? "VERIFIED" : "UNKNOWN", tone: localVerified ? t.stageDone : t.stageUnknown },
    { label: "Public testnet", state: anyTestnetLive ? "LIVE" : healthState === "unconfigured" ? "NOT CONNECTED" : "NOT LIVE", tone: anyTestnetLive ? t.stageDone : t.stageDeferred },
    { label: "Pinned fork", state: "HARNESS READY, RPC DEPENDENT", tone: t.stageConditional },
    { label: "Mainnet shadow", state: "SIGNERLESS READ ONLY", tone: t.stageConditional },
    { label: "Mainnet writes", state: "PROHIBITED", tone: t.stageProhibited },
  ];
  const serviceLabel = healthState === "unconfigured"
    ? "Local fixture"
    : healthState === "checking" ? "Checking service" : healthState === "ok" ? "Service connected" : "Service unavailable";
  const dependencyStatus = selectedHealth
    ? selectedHealth.available ? "AVAILABLE" : selectedHealth.reason ?? "UNAVAILABLE"
    : "UNKNOWN";
  const authorityFence = runtimeHealth
    ? gateUp ? "ENFORCED AT HANDOFF" : "NOT AUTHORIZED"
    : "UNKNOWN";
  const readiness = runtimeHealth?.executionReadiness ?? null;
  const selectedReadiness = readiness?.domains.find((entry) => entry.domainId === selectedMeta.domainId) ?? null;
  const latestAuthorization = selectedReadiness?.latestAuthorization ?? null;
  const selectedIncidentScopes = runtimeHealth?.dependencyIncidents?.scopes.filter((entry) =>
    entry.domainId === selectedMeta.domainId) ?? [];
  const newestIncidentEvidence = selectedIncidentScopes.reduce((latest, entry) =>
    latest === null || BigInt(entry.evidenceObservedAtMs) > BigInt(latest.evidenceObservedAtMs) ? entry : latest,
  null as (typeof selectedIncidentScopes)[number] | null);
  const incidentState = runtimeHealth === null
    ? "UNKNOWN"
    : !runtimeHealth.controls.dependencyIncidentStatusAvailable
      ? "NOT PUBLISHED"
      : selectedIncidentScopes.length === 0
        ? "NO DOMAIN SCOPE"
        : `${[...new Set(selectedIncidentScopes.map((entry) => entry.state))].join(", ")}${selectedIncidentScopes.some((entry) => !entry.evidenceFresh) ? " (STALE EVIDENCE)" : ""}`;
  const incidentPermissions = selectedIncidentScopes.length === 0
    ? "NOT AVAILABLE"
    : selectedIncidentScopes.some((entry) => !entry.evidenceFresh)
      ? "ENTRY BLOCKED, EXIT UNVERIFIED"
    : `ENTRY ${selectedIncidentScopes.every((entry) => entry.entryAllowed) ? "ALLOWED" : "BLOCKED"}, EXIT ${selectedIncidentScopes.every((entry) => entry.exitAllowed) ? "ALLOWED" : "BLOCKED"}`;

  return (
    <main className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1>Network</h1>
          <p>Execution readiness on each chain, how far each environment has been promoted, and solver performance. Only observed controls are shown; missing proof stays unavailable.</p>
        </div>
        <div className={styles.headActions}>
          <span className={healthState === "ok" ? styles.pillOk : healthState === "unavailable" ? styles.pillWarn : styles.pill}>{serviceLabel}</span>
          {healthState !== "unconfigured" ? (
            <button
              type="button"
              className={styles.ghost}
              disabled={healthState === "checking" || pooledClearings.isFetching || nativeClearings.isFetching}
              onClick={() => {
                refreshHealth();
                void pooledClearings.refetch();
                void nativeClearings.refetch();
              }}
            >
              Refresh
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.chainGrid} role="group" aria-label="Execution domains">
        {DOMAIN_ORDER.map((domain) => {
          const meta = DOMAIN_META[domain];
          const health = domainHealth(domain, runtimeHealth);
          const status = statusOf(healthState, health, domainGateUp(domain, runtimeHealth));
          const selected = domain === selectedDomain;
          return (
            <button
              key={domain}
              type="button"
              className={selected ? `${styles.chainCard} ${styles.chainCardOn}` : styles.chainCard}
              aria-pressed={selected}
              onClick={() => setSelectedDomain(domain)}
            >
              <span className={styles.chainCardHead}>
                <ChainIcon chain={domain} size={28} />
                <span className={styles.chainCell}>
                  <span>
                    <strong>{meta.label}</strong>
                    <small>{meta.network}</small>
                  </span>
                </span>
                <span className={pillFor(status)}>{status}</span>
              </span>
              <p>{blockerOf(healthState, health, domain, gateUp)}</p>
              <dl className={styles.facts}>
                <dt>Runtime</dt><dd>{meta.runtime}</dd>
                <dt>Settlement</dt><dd title={meta.settlementClass}>{meta.settlement}</dd>
                <dt>Mode</dt><dd>{meta.executionMode}</dd>
              </dl>
            </button>
          );
        })}
      </div>

      <section className={styles.card} aria-labelledby="promotion-title">
        <div className={styles.cardHead}>
          <h2 id="promotion-title">Promotion boundary</h2>
          <p>Where each environment stands. Nothing is promoted without its evidence.</p>
        </div>
        <ol className={t.stageRail} aria-label="Environment promotion boundary">
          {stages.map((stage, index) => (
            <li key={stage.label} className={stage.tone}>
              <span className={t.stageIndex}>{String(index + 1).padStart(2, "0")}</span>
              <strong>{stage.label}</strong>
              <small>{stage.state}</small>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.card} aria-labelledby="pooled-clearing-title">
        <div className={styles.cardHead}>
          <h2 id="pooled-clearing-title">Pooled cross-batch clearing</h2>
          <p>Verified internal matching and the smaller residual sent to an external venue.</p>
          <span className={styles.pill}>{pooledClearings.data?.length ?? 0} RECENT</span>
        </div>
        {publicApiBaseUrl === null ? (
          <div className={styles.empty}>
            <strong>Public clearing evidence is not connected</strong>
            <p>Configure the public API to inspect independently verified pooled clearings.</p>
          </div>
        ) : pooledClearings.isPending ? (
          <div className={styles.empty}>
            <strong>Reading pooled clearing evidence</strong>
            <p>Every plan and terminal receipt is verified before it appears here.</p>
          </div>
        ) : pooledClearings.isError ? (
          <div className={styles.empty}>
            <strong>Pooled clearing evidence unavailable</strong>
            <p>{pooledClearings.error instanceof Error ? pooledClearings.error.message : "The public API request failed."}</p>
          </div>
        ) : pooledClearings.data.length === 0 ? (
          <div className={styles.empty}>
            <strong>No pooled clearings recorded</strong>
            <p>Cross-batch activity appears after compatible package residuals are matched across separate batches.</p>
          </div>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Domain</th>
                  <th>Status</th>
                  <th className={styles.num}>Batches</th>
                  <th className={styles.num}>Sources</th>
                  <th className={styles.num}>Internally matched</th>
                  <th>External residual</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {pooledClearings.data.map((clearing) => {
                  const planHash = hex(clearing.plan.planHash);
                  const sourceBatches = new Set(clearing.sourceIntents.map((intent) => hex(intent.nettingProofHash))).size;
                  return (
                    <tr key={planHash}>
                      <td className={styles.mono} title={planHash}>{compact(planHash)}</td>
                      <td>{clearingDomain(clearing)}</td>
                      <td><span className={clearingStatusClass(clearing.status)}>{clearing.status.replaceAll("_", " ")}</span></td>
                      <td className={styles.num}>{sourceBatches}</td>
                      <td className={styles.num}>{clearing.sourceIntents.length}</td>
                      <td className={styles.num}>{clearing.plan.internalMatchedQuantityAtoms.toLocaleString("en-US")} atoms</td>
                      <td className={styles.mono}>
                        {clearing.plan.externalSide === undefined
                          ? "NONE"
                          : `${clearing.plan.externalSide} ${clearing.plan.externalQuantityAtoms.toLocaleString("en-US")} atoms`}
                      </td>
                      <td>{new Date(clearing.recordedAtMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.card} aria-labelledby="native-clearing-title">
        <div className={styles.cardHead}>
          <h2 id="native-clearing-title">Native package clearing</h2>
          <p>Isolated collateral, open interest, and funded recovery state for standardized package markets.</p>
          <span className={styles.pill}>{nativeClearings.data?.length ?? 0} DOMAINS</span>
        </div>
        {publicApiBaseUrl === null ? (
          <div className={styles.empty}>
            <strong>Native clearing evidence is not connected</strong>
            <p>Configure the public API to inspect verified clearing policy and state.</p>
          </div>
        ) : nativeClearings.isPending ? (
          <div className={styles.empty}>
            <strong>Reading native clearing state</strong>
            <p>Policy and state hashes are recomputed before they appear here.</p>
          </div>
        ) : nativeClearings.isError ? (
          <div className={styles.empty}>
            <strong>Native clearing state unavailable</strong>
            <p>{nativeClearings.error instanceof Error ? nativeClearings.error.message : "The public API request failed."}</p>
          </div>
        ) : nativeClearings.data.length === 0 ? (
          <div className={styles.empty}>
            <strong>No native clearing domain activated</strong>
            <p>The clearing house remains inactive until a reviewed domain policy is registered.</p>
          </div>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Execution class</th>
                  <th>Risk domain</th>
                  <th className={styles.num}>Open interest</th>
                  <th className={styles.num}>Recovery reserve</th>
                  <th className={styles.num}>Sequence</th>
                </tr>
              </thead>
              <tbody>
                {nativeClearings.data.map(({ policy, state }) => (
                  <tr key={policy.clearingDomainId}>
                    <td className={styles.mono}>{policy.clearingDomainId}</td>
                    <td className={styles.mono}>{policy.executionClassId}</td>
                    <td className={styles.mono}>{policy.riskDomainId}</td>
                    <td className={styles.num}>{state.openInterestAtoms.toLocaleString("en-US")} atoms</td>
                    <td className={styles.num}>{state.recoveryReserveQuoteAtoms.toLocaleString("en-US")} atoms</td>
                    <td className={styles.num}>{state.sequence.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className={styles.split}>
        <section className={styles.card} aria-labelledby="solvers-title">
          <div className={styles.cardHead}>
            <h2 id="solvers-title">Solvers</h2>
            <p>Registered solvers and their measured quote performance.</p>
          </div>
          <div className={styles.scroll}>
            <SolverMetrics publicApiBaseUrl={publicApiBaseUrl} />
          </div>
        </section>

        <section className={styles.card} aria-labelledby="ledger-title">
          <div className={styles.cardHead}>
            <ChainIcon chain={selectedDomain} size={16} />
            <h2 id="ledger-title">{selectedMeta.label} evidence</h2>
          </div>
          <dl className={`${styles.facts} ${styles.cardBody}`}>
            <dt>Network</dt><dd>{selectedMeta.network}</dd>
            <dt>Settlement class</dt><dd className={styles.mono} title={selectedMeta.settlementClass}>{selectedMeta.settlementClass}</dd>
            <dt>Execution policy hash</dt><dd className={styles.mono}>{readiness?.policyHash ?? "NOT PUBLISHED"}</dd>
            <dt>Latest approval hash</dt><dd className={styles.mono}>{latestAuthorization?.decisionHash ?? "NO APPROVAL RECORDED"}</dd>
            <dt>Authorized today</dt><dd className={styles.mono}>{selectedReadiness ? `${selectedReadiness.authorizedPrincipalAtomsToday} ${selectedReadiness.quoteAssetId} atoms` : "NOT AUTHORIZED"}</dd>
            <dt>Per operation cap</dt><dd className={styles.mono}>{selectedReadiness ? `${selectedReadiness.maxPrincipalAtomsPerOperation} ${selectedReadiness.quoteAssetId} atoms` : "NOT AUTHORIZED"}</dd>
            <dt>Recovery loss cap</dt><dd className={styles.mono}>{selectedReadiness ? `${selectedReadiness.maxRecoveryLossAtomsPerOperation} ${selectedReadiness.quoteAssetId} atoms` : "NOT AUTHORIZED"}</dd>
            <dt>Authority fence</dt><dd className={styles.mono}>{authorityFence}</dd>
            <dt>Dependencies</dt><dd className={styles.mono} title={dependencyStatus}>{dependencyStatus}</dd>
            <dt>Incident state</dt><dd className={styles.mono}>{incidentState}</dd>
            <dt>Incident permissions</dt><dd className={styles.mono}>{incidentPermissions}</dd>
            <dt>Incident evidence</dt><dd className={styles.mono}>{newestIncidentEvidence?.evidenceCommitment ?? "NOT AVAILABLE"}</dd>
          </dl>
        </section>
      </div>
    </main>
  );
}
