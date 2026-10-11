"use client";

import type { NaryxClient } from "@naryx/sdk";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ReadState, asRecord, compact, publicClient, shown } from "./public-read";
import styles from "./pages.module.css";

function domainsOf(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? value.map((domain) => shown(asRecord(domain)?.domainId)).join(" + ") : "None";
}

function atoms(value: unknown, asset: unknown): string {
  const ref = asRecord(asset);
  return typeof value === "bigint" ? `${value.toLocaleString("en-US")} ${ref === null ? "" : `${shown(ref.assetId)} `}atoms` : "-";
}

function Capacity({ client, scope, solverId }: { client: NaryxClient; scope: string; solverId: string }) {
  const query = useQuery({
    queryKey: ["solver-capacity", scope, solverId],
    retry: false,
    staleTime: 10_000,
    queryFn: () => client.getSolverCapacity(solverId),
  });
  return (
    <ReadState
      query={query}
      subject="Firm capacity"
      empty={(body) => Array.isArray(body.scopes) && body.scopes.length > 0 ? null : "This solver has published no capacity evidence, so it has no firm capacity."}
    >
      {(body) => (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Evidence</th>
              <th>State</th>
              <th className={styles.num}>Available</th>
              <th className={styles.num}>Committed</th>
              <th className={styles.num}>Remaining</th>
              <th className={styles.num}>Recovery committed / max</th>
            </tr>
          </thead>
          <tbody>
            {(body.scopes as unknown[]).map((candidate, index) => {
              const entry = asRecord(candidate) ?? {};
              const record = asRecord(entry.record) ?? {};
              const status = asRecord(entry.status) ?? {};
              const expired = typeof record.expiresAtValue === "bigint" && typeof body.asOfValue === "bigint" && body.asOfValue >= record.expiresAtValue;
              return (
                <tr key={`${shown(entry.scope)}:${index}`}>
                  <td className={styles.mono} title={`Domain ${domainsOf([record.domain])}`}>{shown(entry.scope)}</td>
                  <td>{shown(record.evidenceGrade).replaceAll("_", " ")}</td>
                  <td>
                    <span className={expired ? styles.pillBad : status.state === "ACTIVE" ? styles.pillOk : styles.pillWarn}>
                      {expired ? "Expired" : shown(status.state).replaceAll("_", " ")}
                    </span>
                  </td>
                  <td className={styles.num}>{atoms(record.availableAtoms, record.asset)}</td>
                  <td className={styles.num}>{atoms(status.committedAtoms, record.asset)}</td>
                  <td className={styles.num}>{atoms(status.remainingAtoms, record.asset)}</td>
                  <td className={styles.num}>{shown(status.committedRecoveryAtoms)} / {shown(record.maximumConcurrentRecoveryAtoms)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </ReadState>
  );
}

function Manifest({ client, scope, solverId, manifestHash }: { client: NaryxClient; scope: string; solverId: string; manifestHash: string }) {
  const query = useQuery({
    queryKey: ["solver-manifest", scope, solverId, manifestHash],
    retry: false,
    staleTime: Infinity,
    queryFn: () => client.getSolverManifest(solverId, manifestHash),
  });
  return (
    <ReadState query={query} subject="Active manifest">
      {({ manifest, manifestHash: verifiedHash, operatorSignatureVerified }) => (
        <dl className={styles.facts}>
          <dt>Manifest hash</dt><dd className={styles.mono} title={verifiedHash}>{compact(verifiedHash)} recomputed</dd>
          <dt>Operator signature</dt>
          <dd>
            <span className={operatorSignatureVerified ? styles.pillOk : styles.pillWarn}>
              {operatorSignatureVerified ? "Verified here" : "Not checked in this browser"}
            </span>
          </dd>
          <dt>Environment</dt><dd>{manifest.environment}</dd>
          <dt>Control group</dt><dd className={styles.mono}>{manifest.commonControlGroupId}</dd>
          <dt>Domains</dt><dd>{domainsOf(manifest.supportedDomains)}</dd>
          <dt>Templates</dt><dd title={manifest.supportedTemplateIds.join(", ")}>{shown(manifest.supportedTemplateIds)}</dd>
          <dt>Quote modes</dt><dd>{shown(manifest.supportedQuoteModes)}</dd>
          <dt>Quote keys</dt><dd>{manifest.quoteVerificationKeys.length}</dd>
          <dt>Market caps</dt>
          <dd title={manifest.maximumNotionalByMarket.map((cap) => `${cap.marketId}: ${atoms(cap.maximumNotionalAtoms, cap.quoteAsset)}`).join("; ")}>
            {manifest.maximumNotionalByMarket.length === 0 ? "None" : `${manifest.maximumNotionalByMarket.length} market${manifest.maximumNotionalByMarket.length === 1 ? "" : "s"}`}
          </dd>
          <dt>Valid until</dt><dd className={styles.mono}>{manifest.validUntilValue.toString()} {manifest.validityUnit}</dd>
        </dl>
      )}
    </ReadState>
  );
}

function Qualification({ client, scope, solverId }: { client: NaryxClient; scope: string; solverId: string }) {
  const current = useQuery({
    queryKey: ["qualification", scope, "SOLVER", solverId],
    retry: false,
    staleTime: 10_000,
    queryFn: () => client.getQualification("SOLVER", solverId),
  });
  const history = useQuery({
    queryKey: ["qualification-history", scope, "SOLVER", solverId],
    retry: false,
    staleTime: 10_000,
    queryFn: () => client.getQualificationHistory("SOLVER", solverId),
  });
  return (
    <>
      <ReadState query={current} subject="Qualification record">
        {(view) => "unavailable" in view ? (
          <p className={styles.readNote}>No record governs this solver now ({view.unavailable.replaceAll("_", " ").toLowerCase()}), so execution treats it as unqualified.</p>
        ) : (
          <dl className={styles.facts}>
            <dt>State</dt>
            <dd><span className={view.current.record.state === "ACTIVE" ? styles.pillOk : styles.pillWarn}>{view.current.record.state.replaceAll("_", " ")}</span></dd>
            <dt>Domain</dt><dd>{view.current.record.domain.domainId}</dd>
            <dt>Notional limit</dt><dd className={styles.mono}>{view.current.record.effectiveLimits.maximumNotionalQuoteAtoms.toLocaleString("en-US")} quote atoms</dd>
            <dt>Open packages limit</dt><dd className={styles.mono}>{view.current.record.effectiveLimits.maximumOpenPackages}</dd>
            <dt>Authority</dt><dd>{view.current.record.authorityKind.replaceAll("_", " ").toLowerCase()} by {view.current.record.authority}</dd>
            <dt>Triggers</dt><dd>{shown(view.current.record.triggerCodes)}</dd>
            <dt>Record hash</dt><dd className={styles.mono} title={view.current.recordHash}>{compact(view.current.recordHash)} recomputed</dd>
          </dl>
        )}
      </ReadState>
      <ReadState query={history} subject="Qualification history" empty={(records) => records.length === 0 ? "No qualification history recorded." : null}>
        {(records) => (
          <>
            <p className={styles.readNote}>{records.length} record{records.length === 1 ? "" : "s"}; each re-hashed and checked to chain to the one before it.</p>
            <ol className={styles.timeline}>
              {records.map(({ record, recordHash }) => (
                <li key={recordHash}>
                  <i aria-hidden="true" />
                  <strong>{record.state.replaceAll("_", " ")}</strong>
                  <span>from {record.effectiveAtValue.toString()} {record.timeUnit}</span>
                  <small title={recordHash}>{record.domain.domainId} / {record.triggerCodes.length === 0 ? "no trigger" : record.triggerCodes.join(", ")} / {compact(recordHash)}</small>
                </li>
              ))}
            </ol>
          </>
        )}
      </ReadState>
    </>
  );
}

/** Registered solvers with firm capacity, the verified active manifest, and qualification, read per solver on expand. */
export function SolverEvidence({ baseUrl }: { baseUrl: string | null }) {
  const client = useMemo(() => publicClient(baseUrl), [baseUrl]);
  const [openId, setOpenId] = useState<string | null>(null);
  const scope = baseUrl ?? "";
  const solvers = useQuery({
    queryKey: ["registered-solvers", scope],
    enabled: client !== null,
    retry: false,
    staleTime: 30_000,
    queryFn: () => client!.listSolvers(),
  });
  if (client === null) {
    return (
      <div className={styles.empty}>
        <strong>Solver registry is not connected</strong>
        <p>Configure an HTTPS public API to inspect solver capacity and qualification.</p>
      </div>
    );
  }
  return (
    <div className={styles.scroll}>
      <ReadState query={solvers} subject="Solver registry" empty={(rows) => rows.length === 0 ? "No solver manifest is registered on this server." : null}>
        {(rows) => (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Solver</th>
                <th>Domains</th>
                <th>Quote modes</th>
                <th>Manifest</th>
                <th aria-label="Action" />
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((solver) => {
                const solverId = shown(solver.solverId);
                const manifestHash = shown(solver.manifestHash);
                const open = openId === solverId;
                return [
                  <tr key={solverId}>
                    <td className={styles.mono}>{solverId}</td>
                    <td>{domainsOf(solver.supportedDomains)}</td>
                    <td>{shown(solver.supportedQuoteModes)}</td>
                    <td className={styles.mono} title={manifestHash}>{compact(manifestHash)} n{shown(solver.manifestNonce)}</td>
                    <td>
                      <button type="button" className={open ? styles.watching : styles.ghost} aria-expanded={open} onClick={() => setOpenId(open ? null : solverId)}>
                        {open ? "Hide" : "Evidence"}
                      </button>
                    </td>
                  </tr>,
                  open ? (
                    <tr key={`${solverId}:detail`} className={styles.detailRow}>
                      <td colSpan={5}>
                        <div className={styles.transparencyGrid}>
                          <div className={styles.transparencyPanel}>
                            <h3>Firm capacity</h3>
                            <p className={styles.readNote}>Capacity counts only within its evidence scope; only onchain reserved or available evidence can back a firm commitment.</p>
                            <Capacity client={client} scope={scope} solverId={solverId} />
                          </div>
                          <div className={styles.transparencyPanel}>
                            <h3>Active manifest</h3>
                            <Manifest client={client} scope={scope} solverId={solverId} manifestHash={manifestHash} />
                          </div>
                          <div className={styles.transparencyPanel}>
                            <h3>Qualification</h3>
                            <Qualification client={client} scope={scope} solverId={solverId} />
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        )}
      </ReadState>
    </div>
  );
}
