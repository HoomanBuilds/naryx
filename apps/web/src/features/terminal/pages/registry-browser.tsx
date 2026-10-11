"use client";

import type { NaryxClient, RegisteredDocumentView } from "@naryx/sdk";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { usePersistedFlag, usePersistedSetting } from "../persisted-setting";
import { ReadState, asRecord, compact, payload, publicClient, shown } from "./public-read";
import styles from "./pages.module.css";

type RegistryTab = "series" | "templates" | "instruments" | "domains";

const TABS: readonly { readonly id: RegistryTab; readonly label: string; readonly subject: string }[] = [
  { id: "series", label: "Strategy series", subject: "Strategy series registry" },
  { id: "templates", label: "Package templates", subject: "Package template registry" },
  { id: "instruments", label: "Instruments", subject: "Instrument registry" },
  { id: "domains", label: "Domains", subject: "Domain registry" },
];

type Row =
  | { readonly kind: "series"; readonly key: string; readonly series: Record<string, unknown> }
  | { readonly kind: "document"; readonly key: string; readonly document: RegisteredDocumentView };

async function readRows(client: NaryxClient, tab: RegistryTab): Promise<readonly Row[]> {
  if (tab === "series") {
    return (await client.listStrategySeries()).map((series) => ({ kind: "series", key: `${shown(series.seriesId)}:${shown(series.seriesVersion)}`, series }));
  }
  const documents = tab === "templates" ? await client.listPackageTemplates()
    : tab === "instruments" ? await client.listInstruments() : await client.listDomains();
  return documents.map((document) => ({ kind: "document", key: `${document.subjectId}:${document.subjectVersion}`, document }));
}

function searchable(row: Row): string {
  if (row.kind === "document") return `${row.document.subjectId} ${row.document.kind} ${row.document.environment} ${row.document.documentHashHex}`.toLowerCase();
  const series = row.series;
  return [series.seriesId, series.templateId, series.quoteAsset, series.quoteConvention, series.riskClass, series.underlyingRefs]
    .map(shown).join(" ").toLowerCase();
}

function registered(atMs: number): string {
  return new Date(atMs).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function ExecutionClasses({ client, scope, seriesId }: { client: NaryxClient; scope: string; seriesId: string }) {
  const query = useQuery({
    queryKey: ["registry-execution-classes", scope, seriesId],
    retry: false,
    staleTime: 60_000,
    queryFn: () => client.listExecutionClasses(seriesId),
  });
  return (
    <ReadState query={query} subject="Execution classes" empty={(classes) => classes.length === 0 ? "No execution class is registered for this series." : null}>
      {(classes) => (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Execution class</th>
              <th>Settlement</th>
              <th>Firmness</th>
              <th>Collateral</th>
              <th>Domains</th>
              <th>Matching policy</th>
            </tr>
          </thead>
          <tbody>
            {classes.map((entry) => (
              <tr key={shown(entry.executionClassId)}>
                <td className={styles.mono}>{shown(entry.executionClassId)} v{shown(entry.executionClassVersion)}</td>
                <td>{shown(entry.settlementClass)}</td>
                <td>{shown(entry.firmnessClass)}</td>
                <td>{shown(entry.collateralMode)}</td>
                <td>{Array.isArray(entry.domains) ? entry.domains.map((domain) => shown(asRecord(domain)?.domainId)).join(" + ") : "-"}</td>
                <td className={styles.mono} title={shown(entry.matchingPolicyHash)}>{compact(shown(entry.matchingPolicyHash))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReadState>
  );
}

function TemplateVersion({ client, scope, listed }: { client: NaryxClient; scope: string; listed: RegisteredDocumentView }) {
  const query = useQuery({
    queryKey: ["registry-template", scope, listed.subjectId, listed.subjectVersion],
    retry: false,
    staleTime: 60_000,
    queryFn: () => client.getPackageTemplate(listed.subjectId, listed.subjectVersion),
  });
  return (
    <ReadState query={query} subject="Template version">
      {(exact) => exact.documentHashHex !== listed.documentHashHex ? (
        <p className={styles.noticeError}>The exact version read answers hash {compact(exact.documentHashHex)}, not the listed {compact(listed.documentHashHex)}. It is not shown.</p>
      ) : (
        <>
          <p className={styles.readNote}>Exact version {exact.subjectVersion} read by id; its served document hash matches the registry listing.</p>
          <pre className={styles.registryPayload}>{payload(exact.document)}</pre>
        </>
      )}
    </ReadState>
  );
}

/** Read-only browser over the public registries; nothing here can register or change a record. */
export function RegistryBrowser({ baseUrl }: { baseUrl: string | null }) {
  const [open, setOpen] = usePersistedFlag("markets.registryOpen", false);
  const [tab, setTab] = usePersistedSetting<RegistryTab>("markets.registryTab", "series", TABS.map((entry) => entry.id));
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const client = useMemo(() => publicClient(baseUrl), [baseUrl]);
  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0]!;
  const rows = useQuery({
    queryKey: ["registry", baseUrl, tab],
    enabled: open && client !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: () => readRows(client!, tab),
  });
  const normalized = query.trim().toLowerCase();
  const visible = (rows.data ?? []).filter((row) => normalized === "" || searchable(row).includes(normalized));

  return (
    <section className={styles.card} aria-labelledby="registry-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="registry-title">Registry</h2>
          <p>Registered strategy series, package templates, instruments, and execution domains as the public API serves them. Read only; search stays in this browser.</p>
        </div>
        <button type="button" className={styles.ghost} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide registry" : "Browse registry"}
        </button>
      </div>
      {!open ? null : client === null ? (
        <div className={styles.empty}>
          <strong>Registry is not connected</strong>
          <p>Configure an HTTPS public API to browse registered records.</p>
        </div>
      ) : (
        <>
          <div className={`${styles.evidenceBar} ${styles.registryBar}`}>
            <div className={styles.rowActions} role="group" aria-label="Registry">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={entry.id === tab ? styles.watching : styles.ghost}
                  aria-pressed={entry.id === tab}
                  onClick={() => {
                    setTab(entry.id);
                    setExpanded(null);
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <label className={styles.marketSearch}>
              <span className={styles.visuallyHidden}>Search {active.label.toLowerCase()}</span>
              <input type="search" value={query} placeholder="Search id, asset, hash" onChange={(event) => setQuery(event.target.value)} />
            </label>
          </div>
          <div className={styles.scroll}>
            <ReadState
              query={rows}
              subject={active.subject}
              empty={(data) => data.length === 0 ? `No ${active.label.toLowerCase()} are registered on this server.` : visible.length === 0 ? "No registered record matches this search." : null}
            >
              {() => (
                <table className={styles.table}>
                  <thead>
                    {tab === "series" ? (
                      <tr>
                        <th>Series</th>
                        <th>Template</th>
                        <th>Underlyings / quote</th>
                        <th>Convention</th>
                        <th>Risk class</th>
                        <th aria-label="Action" />
                      </tr>
                    ) : (
                      <tr>
                        <th>Subject</th>
                        <th>Environment</th>
                        <th>Served document hash</th>
                        <th>Registered</th>
                        <th aria-label="Action" />
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {visible.map((row) => {
                      const isOpen = expanded === row.key;
                      const toggle = (
                        <button type="button" className={isOpen ? styles.watching : styles.ghost} aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : row.key)}>
                          {isOpen ? "Hide" : row.kind === "series" ? "Execution classes" : "Document"}
                        </button>
                      );
                      return [
                        row.kind === "series" ? (
                          <tr key={row.key}>
                            <td className={styles.mono}>{shown(row.series.seriesId)} v{shown(row.series.seriesVersion)}</td>
                            <td className={styles.mono}>{shown(row.series.templateId)} v{shown(row.series.templateVersion)}</td>
                            <td>{shown(row.series.underlyingRefs)} / {shown(row.series.quoteAsset)}</td>
                            <td>{shown(row.series.quoteConvention)}</td>
                            <td>{shown(row.series.riskClass)}</td>
                            <td>{toggle}</td>
                          </tr>
                        ) : (
                          <tr key={row.key}>
                            <td className={styles.mono}>{row.document.subjectId} v{row.document.subjectVersion}</td>
                            <td>{row.document.environment}</td>
                            <td className={styles.mono} title={row.document.documentHashHex}>{compact(row.document.documentHashHex)}</td>
                            <td>{registered(row.document.registeredAtMs)}</td>
                            <td>{toggle}</td>
                          </tr>
                        ),
                        isOpen ? (
                          <tr key={`${row.key}:detail`} className={styles.detailRow}>
                            <td colSpan={row.kind === "series" ? 6 : 5}>
                              {row.kind === "series" ? <ExecutionClasses client={client} scope={baseUrl ?? ""} seriesId={shown(row.series.seriesId)} />
                                : tab === "templates" ? <TemplateVersion client={client} scope={baseUrl ?? ""} listed={row.document} />
                                  : <pre className={styles.registryPayload}>{payload(row.document.document)}</pre>}
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
        </>
      )}
    </section>
  );
}
