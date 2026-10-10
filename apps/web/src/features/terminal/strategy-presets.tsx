"use client";

import { useState, useSyncExternalStore } from "react";
import type { DomainId, PackageMode, QuoteMode, SlippageBps } from "./terminal-view-model";
import styles from "./trading-terminal.module.css";

const STORAGE_KEY = "naryx.terminal.strategy-presets.v1";
const CHANGE_EVENT = "naryx-strategy-presets";
const MAX_PRESETS = 20;
const DOMAINS: readonly DomainId[] = ["solana", "base", "arbitrum", "hyperliquid"];
const MODES: readonly PackageMode[] = ["entry", "exit"];
const QUOTE_MODES: readonly QuoteMode[] = ["coordinated_limits", "indicative_preview"];
const SLIPPAGES: readonly SlippageBps[] = [5, 10, 25];
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
const EMPTY_PRESETS: readonly StrategyPreset[] = Object.freeze([]);
let memoryValue: string | null = null;
let cachedValue: string | null | undefined;
let cachedPresets: readonly StrategyPreset[] = EMPTY_PRESETS;

export type StrategyConfiguration = Readonly<{
  domain: DomainId;
  templateId: string;
  lifecycleAction: string;
  mode: PackageMode;
  size: string;
  slippageBps: SlippageBps;
  quoteMode: QuoteMode;
  packageMarketId: string | null;
}>;

type StrategyPreset = StrategyConfiguration & Readonly<{
  version: 1;
  id: string;
  name: string;
  createdAtMs: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfiguration(value: unknown): StrategyConfiguration | null {
  if (!isRecord(value)) return null;
  const { domain, templateId, lifecycleAction, mode, size, slippageBps, quoteMode, packageMarketId } = value;
  if (typeof domain !== "string" || !DOMAINS.includes(domain as DomainId)) return null;
  if (typeof templateId !== "string" || !IDENTIFIER.test(templateId)) return null;
  if (typeof lifecycleAction !== "string" || !IDENTIFIER.test(lifecycleAction)) return null;
  if (typeof mode !== "string" || !MODES.includes(mode as PackageMode)) return null;
  if (typeof size !== "string" || !DECIMAL.test(size) || !/[1-9]/.test(size)) return null;
  if (typeof slippageBps !== "number" || !SLIPPAGES.includes(slippageBps as SlippageBps)) return null;
  if (typeof quoteMode !== "string" || !QUOTE_MODES.includes(quoteMode as QuoteMode)) return null;
  if (packageMarketId !== null && (typeof packageMarketId !== "string" || !IDENTIFIER.test(packageMarketId))) return null;
  return {
    domain: domain as DomainId,
    templateId,
    lifecycleAction,
    mode: mode as PackageMode,
    size,
    slippageBps: slippageBps as SlippageBps,
    quoteMode: quoteMode as QuoteMode,
    packageMarketId,
  };
}

function parsePreset(value: unknown): StrategyPreset | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" || !IDENTIFIER.test(value.id)) return null;
  if (typeof value.name !== "string" || value.name.trim().length === 0 || value.name.length > 48) return null;
  if (typeof value.createdAtMs !== "number" || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs <= 0) return null;
  const configuration = parseConfiguration(value);
  return configuration === null ? null : { ...configuration, version: 1, id: value.id, name: value.name, createdAtMs: value.createdAtMs };
}

function storedValue() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? memoryValue;
  } catch {
    return memoryValue;
  }
}

function readPresets(): readonly StrategyPreset[] {
  const value = storedValue();
  if (value === cachedValue) return cachedPresets;
  cachedValue = value;
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    cachedPresets = Array.isArray(parsed) ? parsed.flatMap((item) => {
      const preset = parsePreset(item);
      return preset === null ? [] : [preset];
    }).slice(0, MAX_PRESETS) : EMPTY_PRESETS;
  } catch {
    cachedPresets = EMPTY_PRESETS;
  }
  return cachedPresets;
}

function writePresets(presets: readonly StrategyPreset[]) {
  memoryValue = JSON.stringify(presets.slice(0, MAX_PRESETS));
  try {
    window.localStorage.setItem(STORAGE_KEY, memoryValue);
  } catch {
    // The current page still keeps the presets when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

export function readSharedStrategyConfiguration(search: string): StrategyConfiguration | null {
  const params = new URLSearchParams(search);
  if (params.get("strategy") !== "1") return null;
  return parseConfiguration({
    domain: params.get("domain"),
    templateId: params.get("template"),
    lifecycleAction: params.get("action"),
    mode: params.get("mode"),
    size: params.get("size"),
    slippageBps: Number(params.get("slippage")),
    quoteMode: params.get("quote"),
    packageMarketId: params.get("market"),
  });
}

function strategyUrl(configuration: StrategyConfiguration) {
  const url = new URL(window.location.href);
  url.searchParams.set("strategy", "1");
  url.searchParams.set("domain", configuration.domain);
  url.searchParams.set("template", configuration.templateId);
  url.searchParams.set("action", configuration.lifecycleAction);
  url.searchParams.set("mode", configuration.mode);
  url.searchParams.set("size", configuration.size);
  url.searchParams.set("slippage", configuration.slippageBps.toString());
  url.searchParams.set("quote", configuration.quoteMode);
  if (configuration.packageMarketId === null) url.searchParams.delete("market");
  else url.searchParams.set("market", configuration.packageMarketId);
  return url.toString();
}

async function copyText(value: string) {
  if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
  await navigator.clipboard.writeText(value);
}

export function StrategyPresetControls({
  configuration,
  defaultName,
  onApply,
}: {
  configuration: StrategyConfiguration;
  defaultName: string;
  onApply: (configuration: StrategyConfiguration) => string | null;
}) {
  const presets = useSyncExternalStore(subscribe, readPresets, () => EMPTY_PRESETS);
  const [name, setName] = useState(defaultName);
  const [status, setStatus] = useState<string | null>(null);

  function replacePresets(next: readonly StrategyPreset[]) {
    writePresets(next);
  }

  function save() {
    const trimmed = name.trim().slice(0, 48);
    if (trimmed.length === 0) {
      setStatus("Name this preset before saving it.");
      return;
    }
    const preset: StrategyPreset = {
      ...configuration,
      version: 1,
      id: crypto.randomUUID(),
      name: trimmed,
      createdAtMs: Date.now(),
    };
    replacePresets([preset, ...presets.filter((item) => item.name !== trimmed)].slice(0, MAX_PRESETS));
    setStatus(`Saved ${trimmed}.`);
  }

  async function share(item: StrategyConfiguration, label: string) {
    try {
      await copyText(strategyUrl(item));
      setStatus(`${label} link copied.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The link could not be copied.");
    }
  }

  return (
    <details className={styles.strategyPresets}>
      <summary>
        <span>Saved strategies</span>
        <span>{presets.length}</span>
      </summary>
      <div className={styles.strategyPresetCreate}>
        <input
          aria-label="Strategy preset name"
          maxLength={48}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="button" onClick={save}>Save</button>
        <button type="button" onClick={() => void share(configuration, "Strategy")}>Share</button>
      </div>
      {presets.length > 0 ? (
        <ul className={styles.strategyPresetList}>
          {presets.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                className={styles.strategyPresetName}
                title={`${preset.domain} / ${preset.templateId} / ${preset.size}`}
                onClick={() => setStatus(onApply(preset) ?? `Applied ${preset.name}.`)}
              >
                <strong>{preset.name}</strong>
                <span>{preset.domain} / {preset.size}</span>
              </button>
              <button type="button" onClick={() => void share(preset, preset.name)}>Copy</button>
              <button
                type="button"
                aria-label={`Delete ${preset.name}`}
                onClick={() => {
                  replacePresets(presets.filter((item) => item.id !== preset.id));
                  setStatus(`Deleted ${preset.name}.`);
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p>Links restore validated inputs only. They never sign or execute a trade.</p>
      {status ? <output aria-live="polite">{status}</output> : null}
    </details>
  );
}
