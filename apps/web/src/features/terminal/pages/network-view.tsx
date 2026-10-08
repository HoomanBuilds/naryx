"use client";

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

export function NetworkView() {
  const { selectedDomain, setSelectedDomain, runtimeHealth, healthState, refreshHealth, publicApiBaseUrl } = useTerminal();
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
            <button type="button" className={styles.ghost} disabled={healthState === "checking"} onClick={refreshHealth}>
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
