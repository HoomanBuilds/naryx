"use client";

import { useState } from "react";
import {
  NaryxClient,
  fromProtocolJson,
  packageGraph,
  toProtocolJson,
  type GraphLegSide,
  type LegFamily,
  type PackageGraphInput,
  type StrategyProgramView,
} from "@naryx/sdk";
import styles from "./pages.module.css";

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

type StudioState = "idle" | "loading" | "ready" | "error";

function short(value: string): string {
  return value.length > 24 ? `${value.slice(0, 14)}...${value.slice(-7)}` : value;
}

function cloneGraph(graph: PackageGraphInput): PackageGraphInput {
  return {
    ...graph,
    strategyAccountRefs: [...graph.strategyAccountRefs],
    legs: graph.legs.map((leg) => ({ ...leg, assets: [...leg.assets], preconditionHashes: [...leg.preconditionHashes], postconditionHashes: [...leg.postconditionHashes] })),
    dependencyEdges: graph.dependencyEdges.map((edge) => ({ ...edge })),
    executionGroups: graph.executionGroups.map((group) => ({ ...group, legIds: [...group.legIds] })),
    policyHashes: { ...graph.policyHashes },
    recoverySlots: graph.recoverySlots.map((slot) => ({ ...slot })),
  };
}

function parseGraph(text: string): PackageGraphInput {
  const decoded = fromProtocolJson(JSON.parse(text) as unknown) as PackageGraphInput;
  return cloneGraph(packageGraph(decoded));
}

export function StrategyGraphStudio({ baseUrl }: { baseUrl: string | null }) {
  const [quoteHash, setQuoteHash] = useState("");
  const [importText, setImportText] = useState("");
  const [graph, setGraph] = useState<PackageGraphInput | null>(null);
  const [program, setProgram] = useState<StrategyProgramView | null>(null);
  const [selectedLegId, setSelectedLegId] = useState("");
  const [edgeFrom, setEdgeFrom] = useState("");
  const [edgeTo, setEdgeTo] = useState("");
  const [state, setState] = useState<StudioState>("idle");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [compileResult, setCompileResult] = useState<string | null>(null);

  const install = async (next: PackageGraphInput) => {
    const checked = cloneGraph(packageGraph(next));
    let nextProgram = program;
    if (nextProgram === null && baseUrl !== null) nextProgram = await new NaryxClient({ baseUrl }).getStrategyProgram();
    setProgram(nextProgram);
    setGraph(checked);
    setSelectedLegId(checked.legs[0]?.legId ?? "");
    setCompileResult(null);
    setState("ready");
    setNotice({ kind: "ok", text: `Loaded ${checked.legs.length} canonical legs and ${checked.dependencyEdges.length} dependency edges.` });
  };

  const loadProof = async () => {
    if (baseUrl === null) return;
    setState("loading");
    setNotice(null);
    try {
      const normalized = quoteHash.trim().toLowerCase();
      if (!HASH.test(normalized)) throw new Error("Enter a 32-byte lowercase quote hash.");
      const proof = await new NaryxClient({ baseUrl }).getStrategyQuoteProof(normalized);
      await install(proof.graph);
    } catch (error) {
      setState("error");
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Verified graph load failed." });
    }
  };

  const importGraph = async () => {
    setState("loading");
    setNotice(null);
    try {
      await install(parseGraph(importText));
    } catch (error) {
      setState("error");
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Graph import failed." });
    }
  };

  const updateLeg = (legId: string, patch: Partial<PackageGraphInput["legs"][number]>) => {
    if (graph === null) return;
    const renamed = typeof patch.legId === "string" ? patch.legId : legId;
    setGraph({
      ...graph,
      legs: graph.legs.map((leg) => leg.legId === legId ? { ...leg, ...patch } : leg),
      dependencyEdges: graph.dependencyEdges.map((edge) => ({
        fromLegId: edge.fromLegId === legId ? renamed : edge.fromLegId,
        toLegId: edge.toLegId === legId ? renamed : edge.toLegId,
      })),
      executionGroups: graph.executionGroups.map((group) => ({ ...group, legIds: group.legIds.map((id) => id === legId ? renamed : id) })),
      recoverySlots: graph.recoverySlots.map((slot) => slot.legId === legId ? { ...slot, legId: renamed } : slot),
    });
    if (selectedLegId === legId) setSelectedLegId(renamed);
    setCompileResult(null);
  };

  const removeLeg = (legId: string) => {
    if (graph === null || graph.legs.length <= 1) return;
    const next = graph.legs.filter((leg) => leg.legId !== legId);
    setGraph({
      ...graph,
      legs: next,
      dependencyEdges: graph.dependencyEdges.filter((edge) => edge.fromLegId !== legId && edge.toLegId !== legId),
      executionGroups: graph.executionGroups.map((group) => ({ ...group, legIds: group.legIds.filter((id) => id !== legId) })).filter((group) => group.legIds.length > 0),
      recoverySlots: graph.recoverySlots.filter((slot) => slot.legId !== legId),
    });
    setSelectedLegId(next[0]?.legId ?? "");
    setCompileResult(null);
  };

  const addLeg = () => {
    if (graph === null || graph.legs.length >= 32) return;
    const source = graph.legs.find((leg) => leg.legId === selectedLegId) ?? graph.legs[0];
    if (source === undefined) return;
    let counter = graph.legs.length + 1;
    while (graph.legs.some((leg) => leg.legId === `leg-${counter}`)) counter += 1;
    const legId = `leg-${counter}`;
    const firstGroup = graph.executionGroups[0];
    setGraph({
      ...graph,
      legs: [...graph.legs, { ...source, legId, assets: [...source.assets], preconditionHashes: [...source.preconditionHashes], postconditionHashes: [...source.postconditionHashes] }],
      executionGroups: firstGroup === undefined
        ? [{ groupId: "package", kind: "ALL_OR_NONE", legIds: graph.legs.map((leg) => leg.legId).concat(legId) }]
        : graph.executionGroups.map((group, index) => index === 0 ? { ...group, legIds: [...group.legIds, legId] } : group),
    });
    setSelectedLegId(legId);
    setCompileResult(null);
  };

  const addEdge = () => {
    if (graph === null || edgeFrom === edgeTo || !graph.legs.some((leg) => leg.legId === edgeFrom) || !graph.legs.some((leg) => leg.legId === edgeTo)) return;
    if (graph.dependencyEdges.some((edge) => edge.fromLegId === edgeFrom && edge.toLegId === edgeTo)) return;
    setGraph({ ...graph, dependencyEdges: [...graph.dependencyEdges, { fromLegId: edgeFrom, toLegId: edgeTo }] });
    setCompileResult(null);
  };

  const compile = async () => {
    if (graph === null || baseUrl === null) return;
    setState("loading");
    setNotice(null);
    try {
      const checked = cloneGraph(packageGraph(graph));
      const stageCount = packageGraph(checked).stages.length;
      const client = new NaryxClient({ baseUrl });
      const [compiled, simulated] = await Promise.all([client.compilePackageGraph(checked), client.simulatePackageGraph(checked)]);
      const result = compiled as Record<string, unknown>;
      const reasons = Array.isArray(result.reasons) ? result.reasons.join(", ") : "Registry or resource policy rejected the graph";
      setCompileResult(result.compiled === true
        ? `Compiled successfully. ${simulated.failurePoints.length} modeled failure point${simulated.failurePoints.length === 1 ? "" : "s"} across ${stageCount} execution stage${stageCount === 1 ? "" : "s"}.`
        : `Compile rejected: ${reasons}. Simulation still found ${simulated.failurePoints.length} failure point${simulated.failurePoints.length === 1 ? "" : "s"}.`);
      setGraph(checked);
      setState("ready");
    } catch (error) {
      setState("error");
      setCompileResult(null);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Graph compilation failed." });
    }
  };

  const template = program?.templates.find((candidate) => candidate.templateId === graph?.templateId) ?? null;
  const action = template?.actions.find((candidate) => candidate.action === graph?.lifecycleAction) ?? null;
  const selectedLeg = graph?.legs.find((leg) => leg.legId === selectedLegId) ?? graph?.legs[0] ?? null;
  const role = action?.legRoles.find((candidate) => candidate.legTypeId === selectedLeg?.legTypeId) ?? null;
  const exportText = graph === null ? "" : JSON.stringify(toProtocolJson(graph), null, 2);

  return (
    <section className={styles.card} aria-labelledby="graph-studio-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="graph-studio-title">N-leg strategy graph studio</h2>
          <p>Load a verified admitted graph or import canonical protocol JSON, then edit typed legs and dependencies before compiling against the active testnet registries.</p>
        </div>
        <span className={styles.pill}>{graph ? `${graph.legs.length} legs` : "Canonical input"}</span>
      </div>
      <div className={`${styles.cardBody} ${styles.graphLoadGrid}`}>
        <label className={styles.field}><span>Admitted quote hash</span><input className={styles.mono} value={quoteHash} onChange={(event) => setQuoteHash(event.target.value)} placeholder="64 lowercase hexadecimal characters" spellCheck={false} /></label>
        <button type="button" className={styles.ghost} disabled={baseUrl === null || state === "loading" || !HASH.test(quoteHash)} onClick={() => void loadProof()}>Load verified graph</button>
        <label className={`${styles.field} ${styles.graphImport}`}><span>Or import canonical graph JSON</span><textarea className={styles.graphPayload} value={importText} onChange={(event) => setImportText(event.target.value)} spellCheck={false} /></label>
        <button type="button" className={styles.ghost} disabled={state === "loading" || importText.trim() === ""} onClick={() => void importGraph()}>Validate import</button>
      </div>
      {graph ? (
        <>
          <div className={styles.graphToolbar}>
            <span><strong>{template?.displayName ?? graph.templateId}</strong> / {graph.lifecycleAction.replaceAll("_", " ")} / {graph.settlementClass.replaceAll("_", " ")}</span>
            <div>
              <button type="button" className={styles.ghost} onClick={addLeg} disabled={graph.legs.length >= 32}>Clone selected leg</button>
              <button type="button" className={styles.connect} onClick={() => void compile()} disabled={state === "loading" || baseUrl === null}>{state === "loading" ? "Compiling..." : "Compile and simulate"}</button>
            </div>
          </div>
          <div className={styles.graphCanvas}>
            {graph.legs.map((leg, index) => {
              const legRole = action?.legRoles.find((candidate) => candidate.legTypeId === leg.legTypeId) ?? null;
              return (
                <article key={`${leg.legId}:${index}`} className={leg.legId === selectedLeg?.legId ? styles.graphNodeSelected : styles.graphNode} onClick={() => setSelectedLegId(leg.legId)}>
                  <header><span>Leg {index + 1}</span><strong>{leg.legId}</strong></header>
                  <small>{leg.legTypeId} / {leg.legFamily}</small>
                  <p>{short(leg.domain.domainId)} / {short(leg.venue.subjectId)} / {short(leg.market.subjectId)}</p>
                  <footer><span>{leg.side}</span><span>{leg.quantityAtoms.toString()} atoms</span><span>{legRole ? `${legRole.minimumCount}-${legRole.maximumCount}` : "Unsupported role"}</span></footer>
                </article>
              );
            })}
          </div>
          {selectedLeg ? (
            <div className={`${styles.cardBody} ${styles.graphEditor}`}>
              <label className={styles.field}><span>Leg id</span><input value={selectedLeg.legId} onChange={(event) => { if (ID.test(event.target.value)) updateLeg(selectedLeg.legId, { legId: event.target.value }); }} /></label>
              <label className={styles.field}><span>Typed role</span><select value={selectedLeg.legTypeId} onChange={(event) => {
                const nextRole = action?.legRoles.find((candidate) => candidate.legTypeId === event.target.value);
                updateLeg(selectedLeg.legId, { legTypeId: event.target.value, ...(nextRole?.allowedFamilies[0] ? { legFamily: nextRole.allowedFamilies[0] } : {}), ...(nextRole?.allowedSides[0] ? { side: nextRole.allowedSides[0] } : {}) });
              }}>{action?.legRoles.map((candidate) => <option key={candidate.legTypeId} value={candidate.legTypeId}>{candidate.legTypeId}</option>) ?? <option value={selectedLeg.legTypeId}>{selectedLeg.legTypeId}</option>}</select></label>
              <label className={styles.field}><span>Leg family</span><select value={selectedLeg.legFamily} onChange={(event) => updateLeg(selectedLeg.legId, { legFamily: event.target.value as LegFamily })}>{(role?.allowedFamilies ?? [selectedLeg.legFamily]).map((family) => <option key={family} value={family}>{family.replaceAll("_", " ")}</option>)}</select></label>
              <label className={styles.field}><span>Side</span><select value={selectedLeg.side} onChange={(event) => updateLeg(selectedLeg.legId, { side: event.target.value as GraphLegSide })}>{(role?.allowedSides ?? [selectedLeg.side]).map((side) => <option key={side} value={side}>{side}</option>)}</select></label>
              <label className={styles.field}><span>Quantity atoms</span><input inputMode="numeric" value={selectedLeg.quantityAtoms.toString()} onChange={(event) => { if (/^[1-9][0-9]*$/.test(event.target.value)) updateLeg(selectedLeg.legId, { quantityAtoms: BigInt(event.target.value) }); }} /></label>
              <label className={styles.field}><span>Minimum atoms</span><input inputMode="numeric" value={selectedLeg.minimumQuantityAtoms.toString()} onChange={(event) => { if (/^[1-9][0-9]*$/.test(event.target.value)) updateLeg(selectedLeg.legId, { minimumQuantityAtoms: BigInt(event.target.value) }); }} /></label>
              <label className={styles.field}><span>Maximum fee atoms</span><input inputMode="numeric" value={selectedLeg.maximumFeeQuoteAtoms.toString()} onChange={(event) => { if (/^(?:0|[1-9][0-9]*)$/.test(event.target.value)) updateLeg(selectedLeg.legId, { maximumFeeQuoteAtoms: BigInt(event.target.value) }); }} /></label>
              <button type="button" className={styles.dangerButton} disabled={graph.legs.length <= 1} onClick={() => removeLeg(selectedLeg.legId)}>Remove leg</button>
            </div>
          ) : null}
          <div className={`${styles.cardBody} ${styles.edgeEditor}`}>
            <label className={styles.field}><span>Depends on</span><select value={edgeFrom} onChange={(event) => setEdgeFrom(event.target.value)}><option value="">Select predecessor</option>{graph.legs.map((leg) => <option key={leg.legId} value={leg.legId}>{leg.legId}</option>)}</select></label>
            <label className={styles.field}><span>Then execute</span><select value={edgeTo} onChange={(event) => setEdgeTo(event.target.value)}><option value="">Select dependent leg</option>{graph.legs.map((leg) => <option key={leg.legId} value={leg.legId}>{leg.legId}</option>)}</select></label>
            <button type="button" className={styles.ghost} disabled={edgeFrom === "" || edgeTo === "" || edgeFrom === edgeTo} onClick={addEdge}>Add dependency</button>
            <div className={styles.edgeList}>{graph.dependencyEdges.map((edge, index) => <button key={`${edge.fromLegId}:${edge.toLegId}:${index}`} type="button" onClick={() => setGraph({ ...graph, dependencyEdges: graph.dependencyEdges.filter((_, edgeIndex) => edgeIndex !== index) })}>{edge.fromLegId} -&gt; {edge.toLegId} x</button>)}</div>
          </div>
          {compileResult ? <p className={compileResult.startsWith("Compiled successfully") ? styles.noticeOk : styles.noticeError}>{compileResult}</p> : null}
          <details className={styles.graphExport}><summary>Canonical graph JSON</summary><textarea className={styles.graphPayload} value={exportText} readOnly spellCheck={false} /></details>
        </>
      ) : (
        <div className={styles.empty}><strong>No graph loaded</strong><p>Use an admitted quote for verified identities, or import a full canonical graph. The studio does not invent domain, adapter, venue, market, asset, or policy hashes.</p></div>
      )}
      {notice ? <p className={notice.kind === "ok" ? styles.noticeOk : styles.noticeError} role="status">{notice.text}</p> : null}
    </section>
  );
}
