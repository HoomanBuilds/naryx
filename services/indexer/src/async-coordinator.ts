import { address, uint } from "./bond-vault.js";
import { EVIDENCE_GRADE, type EvidenceGrade, type Finality } from "./package-record.js";

/** keccak256("PackageTransition(bytes32,uint8,uint64,bytes32)") */
export const PACKAGE_TRANSITION_TOPIC = "0xc58693c297eb3e86bcaf486289abc60e5cef9ea0bb4a12e36c5c0d38711fc3f1";
/** keccak256("PackageReleased(bytes32,address,address,uint256,address,uint256)") */
export const PACKAGE_RELEASED_TOPIC = "0xef28988ea6944858156a639fdd1ed077038dea8cee3ffb67bdb300d4d070795a";
/** keccak256("BondSlashed(bytes32,uint256)") */
export const BOND_SLASHED_TOPIC = "0xaf9f84551ac4989ebd3133324f530341c312ed19efaa94e9f7d18d69ca4522c5";

export const COORDINATOR_TOPICS = Object.freeze([PACKAGE_TRANSITION_TOPIC, PACKAGE_RELEASED_TOPIC, BOND_SLASHED_TOPIC]);

/** AsyncBondedPackageCoordinator.State in declaration order. NONE is never emitted. */
const STATES = Object.freeze([
  "NONE",
  "RESERVED",
  "REQUEST_SUBMITTED",
  "VENUE_PENDING",
  "EXECUTED",
  "CANCELLED",
  "FROZEN",
  "RECOVERY_PENDING",
  "RECOVERED",
  "MANUAL_INTERVENTION",
  "CLOSED",
] as const);
export type CoordinatorState = Exclude<(typeof STATES)[number], "NONE">;
export const COORDINATOR_STATES: readonly CoordinatorState[] = Object.freeze(STATES.slice(1) as CoordinatorState[]);

export type CoordinatorEventType = "PACKAGE_TRANSITION" | "PACKAGE_RELEASED" | "BOND_SLASHED";

/** One decoded coordinator log. Amounts and versions are decimal strings, hashes lowercase hex. */
export interface ObservedCoordinatorEvent {
  readonly locator: string;
  readonly coordinator: string;
  readonly packageIdHex: string;
  readonly type: CoordinatorEventType;
  readonly evidenceGrade: EvidenceGrade;
  readonly fields: Readonly<Record<string, string>>;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SPECS: ReadonlyMap<string, { readonly type: CoordinatorEventType; readonly words: number }> = new Map([
  [PACKAGE_TRANSITION_TOPIC, { type: "PACKAGE_TRANSITION", words: 3 }],
  [PACKAGE_RELEASED_TOPIC, { type: "PACKAGE_RELEASED", words: 5 }],
  [BOND_SLASHED_TOPIC, { type: "BOND_SLASHED", words: 1 }],
]);

/** Decodes one AsyncBondedPackageCoordinator log, checking every word against its declared width. */
export function decodeCoordinatorLog(
  log: { readonly address: string; readonly topics: readonly string[]; readonly data: string; readonly transactionHash: string; readonly logIndex: string },
  evidenceGrade: EvidenceGrade,
): ObservedCoordinatorEvent {
  const topics = log.topics.map((topic) => topic.toLowerCase());
  const data = log.data.toLowerCase();
  const spec = SPECS.get(topics[0] ?? "");
  if (spec === undefined) throw new Error("not an async coordinator log");
  // Every coordinator event indexes only the package id.
  if (topics.length !== 2 || !topics.every((topic) => HEX32.test(topic))) throw new Error(`${spec.type} carries 2 topics`);
  if (!/^0x([0-9a-f]{64})*$/.test(data) || (data.length - 2) / 64 !== spec.words) throw new Error(`${spec.type} data has the wrong length`);
  const coordinator = log.address.toLowerCase();
  const transactionHash = log.transactionHash.toLowerCase();
  if (!ADDRESS.test(coordinator) || !HEX32.test(transactionHash) || !/^0x(0|[1-9a-f][0-9a-f]*)$/.test(log.logIndex)) throw new Error("log identity is malformed");
  const word = (index: number) => data.slice(2 + index * 64, 2 + (index + 1) * 64);
  let fields: Record<string, string>;
  switch (spec.type) {
    case "PACKAGE_TRANSITION": {
      const state = Number(uint(word(0), 8, "state"));
      if (state === 0 || state >= STATES.length) throw new Error(`state ${state} is not a coordinator state`);
      const stateVersion = uint(word(1), 64, "stateVersion");
      if (stateVersion === 0n) throw new Error("stateVersion is zero");
      fields = { state: STATES[state] as CoordinatorState, stateVersion: stateVersion.toString(), evidenceHash: word(2) };
      break;
    }
    case "PACKAGE_RELEASED":
      fields = {
        bondRecipient: address(word(0), "bondRecipient"),
        reserveRecipient: address(word(1), "reserveRecipient"),
        reserveAtoms: uint(word(2), 256, "reserveAtoms").toString(),
        lossRecipient: address(word(3), "lossRecipient"),
        lossAtoms: uint(word(4), 256, "lossAtoms").toString(),
      };
      break;
    case "BOND_SLASHED":
      fields = { bondAtoms: uint(word(0), 256, "bondAtoms").toString() };
      break;
  }
  return Object.freeze({
    locator: `${transactionHash}:${Number.parseInt(log.logIndex.slice(2), 16)}`,
    coordinator,
    packageIdHex: (topics[1] as string).slice(2),
    type: spec.type,
    evidenceGrade,
    fields: Object.freeze(fields),
  });
}

export interface ObservedAsyncRelease {
  readonly bondRecipient: string;
  readonly reserveRecipient: string;
  readonly reserveAtoms: string;
  readonly lossRecipient: string;
  readonly lossAtoms: string;
}

/**
 * One coordinator package as its canonical logs show it. Any event the coordinator could not have
 * emitted in that order is a violation, and a package with any violation is INCONSISTENT.
 */
export interface ObservedAsyncPackage {
  readonly coordinator: string;
  readonly packageIdHex: string;
  readonly status: "OPEN" | "RELEASED" | "INCONSISTENT";
  /** The latest canonical state, or null when no transition is held. */
  readonly state: CoordinatorState | null;
  readonly stateVersion: string | null;
  readonly evidenceHash: string | null;
  /** True when the reservation itself is held, so the history starts at its first state. */
  readonly observedFromReservation: boolean;
  readonly transitions: readonly { readonly locator: string; readonly height: number; readonly state: CoordinatorState; readonly stateVersion: string; readonly evidenceHash: string }[];
  readonly slashedBondAtoms: string | null;
  readonly release: ObservedAsyncRelease | null;
  readonly lastHeight: number;
  readonly finality: Finality;
  readonly evidenceGrade: EvidenceGrade;
  readonly violations: readonly string[];
}

const transactionOf = (locator: string) => locator.slice(0, locator.indexOf(":"));

/**
 * Replays one package's canonical coordinator events in chain order. The coordinator raises the
 * state version by exactly one on every transition and only the reservation is version 1; it
 * slashes only right after a MANUAL_INTERVENTION transition and releases only right after the
 * CLOSED transition, each in the same transaction, and a released package emits nothing more.
 */
export function replayCoordinatorEvents(
  events: readonly (ObservedCoordinatorEvent & { readonly height: number })[],
  finality: Finality,
): ObservedAsyncPackage | undefined {
  const first = events[0];
  if (first === undefined) return undefined;
  const violations: string[] = [];
  const transitions: ObservedAsyncPackage["transitions"][number][] = [];
  let version: bigint | null = null;
  let slashedBondAtoms: string | null = null;
  let release: ObservedAsyncRelease | null = null;
  let previous: ObservedCoordinatorEvent | undefined;
  const follows = (event: ObservedCoordinatorEvent, state: CoordinatorState) =>
    previous?.type === "PACKAGE_TRANSITION" && previous.fields.state === state && transactionOf(previous.locator) === transactionOf(event.locator);
  for (const event of events) {
    const where = `${event.type} at ${event.locator}`;
    if (release !== null) violations.push(`${where}: the package emitted an event after its release`);
    switch (event.type) {
      case "PACKAGE_TRANSITION": {
        const state = event.fields.state as CoordinatorState;
        const next = BigInt(event.fields.stateVersion as string);
        if ((state === "RESERVED") !== (next === 1n)) violations.push(`${where}: only the reservation is state version 1`);
        if (version !== null && next !== version + 1n) violations.push(`${where}: state version ${next} does not follow ${version}`);
        version = next;
        transitions.push(Object.freeze({ locator: event.locator, height: event.height, state, stateVersion: next.toString(), evidenceHash: event.fields.evidenceHash as string }));
        break;
      }
      case "BOND_SLASHED":
        if (!follows(event, "MANUAL_INTERVENTION")) violations.push(`${where}: a slash must follow a MANUAL_INTERVENTION transition in its transaction`);
        if (slashedBondAtoms !== null) violations.push(`${where}: the bond was slashed twice`);
        slashedBondAtoms = event.fields.bondAtoms as string;
        break;
      case "PACKAGE_RELEASED":
        if (!follows(event, "CLOSED")) violations.push(`${where}: a release must follow the CLOSED transition in its transaction`);
        release = Object.freeze({
          bondRecipient: event.fields.bondRecipient as string,
          reserveRecipient: event.fields.reserveRecipient as string,
          reserveAtoms: event.fields.reserveAtoms as string,
          lossRecipient: event.fields.lossRecipient as string,
          lossAtoms: event.fields.lossAtoms as string,
        });
        break;
    }
    previous = event;
  }
  const latest = transitions[transitions.length - 1];
  if (latest?.state === "CLOSED" && release === null) violations.push("the package closed without a release");
  const last = events[events.length - 1] as ObservedCoordinatorEvent & { height: number };
  return Object.freeze({
    coordinator: first.coordinator,
    packageIdHex: first.packageIdHex,
    status: violations.length > 0 ? "INCONSISTENT" : release !== null ? "RELEASED" : "OPEN",
    state: latest?.state ?? null,
    stateVersion: latest?.stateVersion ?? null,
    evidenceHash: latest?.evidenceHash ?? null,
    observedFromReservation: transitions[0]?.state === "RESERVED",
    transitions: Object.freeze(transitions),
    slashedBondAtoms,
    release,
    lastHeight: last.height,
    finality,
    evidenceGrade: events.reduce<EvidenceGrade>((weakest, event) => (EVIDENCE_GRADE[event.evidenceGrade] < EVIDENCE_GRADE[weakest] ? event.evidenceGrade : weakest), "CONSENSUS_VERIFIED"),
    violations: Object.freeze(violations),
  });
}
