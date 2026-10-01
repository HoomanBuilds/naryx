"use client";

import { ChainIcon } from "@/features/brand/chain-icons";
import { SolverMetrics } from "../pro/solver-metrics";
import type { RuntimeBoundaryHealth } from "../private-http-terminal-provider";
import type { DomainId } from "../terminal-view-model";
import { DOMAIN_META, DOMAIN_ORDER, domainHealth, useTerminal, type HealthState } from "../shell/terminal-context";
import t from "../trading-terminal.module.css";
import styles from "./pages.module.css";

type Status = "Available" | "Checking" | "Unavailable" | "Preview";

function statusOf(healthState: HealthState, health: RuntimeBoundaryHealth | null): Status {
  if (healthState === "unconfigured") return "Preview";
  if (!health) return healthState === "checking" ? "Checking" : "Unavailable";
  return health.available ? "Available" : "Unavailable";
}

function blockerOf(healthState: HealthState, health: RuntimeBoundaryHealth | null, domain: DomainId): string {
  if (healthState === "unconfigured") return "Private service not configured. Market data and tickets use the local fixture.";
  if (!health) return healthState === "checking" ? "Checking private service health." : "Health unavailable. Local fixture data only.";
  if (health.available) {
    if (domain === "solana") return "Ready. Every Devnet signature follows an explicit review.";
    if (domain === "hyperliquid") return "Ready. The dedicated testnet account gate runs after explicit review.";
    return "Runtime ready. Contracts are not deployed on this testnet yet.";
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

export function NetworkView() {
  const { selectedDomain, setSelectedDomain, runtimeHealth, healthState, refreshHealth, publicApiBaseUrl } = useTerminal();
  const selectedMeta = DOMAIN_META[selectedDomain];
  const selectedHealth = domainHealth(selectedDomain, runtimeHealth);
  const localVerified = runtimeHealth !== null &&
    runtimeHealth.controls.localAtomicRuntimeMode === "MANIFEST_VALIDATED" &&
    runtimeHealth.controls.localExecutionAvailable &&
    runtimeHealth.controls.lifecycleReadAvailable &&
    runtimeHealth.controls.solverQuotingAvailable;
  const stages = [
    { label: "Local verification", state: localVerified ? "VERIFIED" : "UNKNOWN", tone: localVerified ? t.stageDone : t.stageUnknown },
    { label: "Public testnet", state: "DEPLOYMENT DEFERRED", tone: t.stageDeferred },
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
    ? runtimeHealth.controls.executionReadinessAvailable ? "ENFORCED AT HANDOFF" : "NOT CONFIGURED"
    : "UNKNOWN";

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
          const status = statusOf(healthState, health);
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
              <p>{blockerOf(healthState, health, domain)}</p>
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
            <dt>Funded operation hash</dt><dd className={styles.mono}>NOT AVAILABLE</dd>
            <dt>Readiness decision hash</dt><dd className={styles.mono}>NOT AVAILABLE</dd>
            <dt>Authority fence</dt><dd className={styles.mono}>{authorityFence}</dd>
            <dt>Dependencies</dt><dd className={styles.mono} title={dependencyStatus}>{dependencyStatus}</dd>
            <dt>Incident state</dt><dd className={styles.mono}>UNKNOWN</dd>
          </dl>
        </section>
      </div>
    </main>
  );
}
