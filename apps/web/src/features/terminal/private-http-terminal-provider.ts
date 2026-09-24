import type {
  DomainId,
  TerminalPreview,
  TerminalPreviewInput,
  TerminalViewModel,
  TerminalViewModelProvider,
} from "./terminal-view-model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSnapshot(value: unknown): TerminalViewModel {
  if (!isRecord(value) || !isRecord(value.environment) ||
      value.environment.source !== "PRIVATE_TERMINAL_BFF" ||
      value.environment.executionEnabled !== false ||
      !Array.isArray(value.domains) || !isRecord(value.market) ||
      !isRecord(value.chart) || !Array.isArray(value.plans) ||
      !isRecord(value.ticket) || !Array.isArray(value.workspaces)) {
    throw new Error("Private terminal snapshot response is invalid.");
  }
  return value as TerminalViewModel;
}

function requirePreview(value: unknown): TerminalPreview {
  if (!isRecord(value) || value.source !== "PRIVATE_TERMINAL_BFF" ||
      value.executionAvailable !== false || !isRecord(value.size) ||
      !isRecord(value.bound) || !Array.isArray(value.fees) ||
      !Array.isArray(value.legs) || !isRecord(value.totalFee) ||
      !isRecord(value.action)) {
    throw new Error("Private terminal preview response is invalid.");
  }
  return value as TerminalPreview;
}

export class PrivateHttpTerminalProvider implements TerminalViewModelProvider {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    const parsed = new URL(baseUrl);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username !== "" || parsed.password !== "" ||
        parsed.search !== "" || parsed.hash !== "") {
      throw new Error("Private terminal base URL must be an HTTP or HTTPS URL.");
    }
    this.#baseUrl = parsed.href.replace(/\/$/, "");
  }

  async getSnapshot(domain: DomainId, signal?: AbortSignal): Promise<TerminalViewModel> {
    const response = await fetch(
      `${this.#baseUrl}/internal/terminal/snapshot?domain=${encodeURIComponent(domain)}`,
      {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal,
      },
    );
    if (!response.ok) throw new Error(`Private terminal snapshot failed with ${response.status}.`);
    return requireSnapshot(await response.json() as unknown);
  }

  async getPreview(
    input: TerminalPreviewInput,
    signal?: AbortSignal,
  ): Promise<TerminalPreview> {
    const response = await fetch(`${this.#baseUrl}/internal/terminal/preview`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) throw new Error(`Private terminal preview failed with ${response.status}.`);
    return requirePreview(await response.json() as unknown);
  }
}
