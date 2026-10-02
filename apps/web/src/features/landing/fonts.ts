import { Geist, Geist_Mono, Instrument_Serif, Space_Grotesk } from "next/font/google";

// Every face here is SIL Open Font License. next/font downloads them at build time and serves them from this app.

/** Space Grotesk, set in uppercase for display. */
export const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
});

/** Instrument Serif Italic, for the footer's particle wordmark. */
export const accent = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: "italic",
  preload: false,
  variable: "--font-accent",
});

/** Geist Mono, variable weight, for labels and data. */
export const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

/** Geist, variable weight, for body copy. */
export const body = Geist({
  subsets: ["latin"],
  variable: "--font-body",
});

/** Instrument Serif, the editorial serif. */
export const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-serif",
});

export const fontVariables = [display, accent, mono, body, serif].map((font) => font.variable).join(" ");
