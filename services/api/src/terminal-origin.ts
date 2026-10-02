/**
 * The browser origins allowed to call the private terminal routes: one exact origin, or several
 * (for example the Vercel production domain and a custom domain). No wildcard is accepted.
 */
export type TerminalOrigins = string | readonly string[] | null;

export function isAllowedTerminalOrigin(configured: TerminalOrigins, origin: string): boolean {
  if (configured === null) return false;
  return typeof configured === "string" ? origin === configured : configured.includes(origin);
}

/** NARYX_TERMINAL_ORIGIN: one exact HTTP(S) origin or a comma-separated list of them. */
export function parseTerminalOrigins(value: string | undefined): TerminalOrigins {
  if (value === undefined || value.trim() === "") return null;
  const origins = value.split(",").map((entry) => entry.trim());
  for (const entry of origins) {
    let origin: URL;
    try {
      origin = new URL(entry);
    } catch {
      throw new Error("NARYX_TERMINAL_ORIGIN must list exact HTTP or HTTPS origins.");
    }
    // A hostname of letters, digits, dots, and hyphens, or a bracketed IPv6 literal: no wildcard.
    if ((origin.protocol !== "http:" && origin.protocol !== "https:") ||
        origin.origin !== entry || origin.username !== "" || origin.password !== "" ||
        !/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/.test(origin.hostname)) {
      throw new Error("NARYX_TERMINAL_ORIGIN must list exact HTTP or HTTPS origins.");
    }
  }
  if (new Set(origins).size !== origins.length) throw new Error("NARYX_TERMINAL_ORIGIN lists an origin twice.");
  return origins.length === 1 ? origins[0]! : Object.freeze(origins);
}
