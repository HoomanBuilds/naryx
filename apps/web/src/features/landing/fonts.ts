import localFont from "next/font/local";

/** Space Grotesk, set in uppercase for display. */
export const display = localFont({
  src: "./fonts/space-grotesk.woff2",
  weight: "300 700",
  variable: "--font-display",
});

/** Redaction 35 Italic, a bitmap-worn serif, for the footer wordmark. */
export const accent = localFont({
  src: "./fonts/redaction-35-italic.woff2",
  weight: "400",
  style: "italic",
  variable: "--font-accent",
});

/** PP Fraktion Mono, for labels and data. */
export const mono = localFont({
  src: "./fonts/fraktion-mono.ttf",
  weight: "200 800",
  variable: "--font-mono",
});

/** Favorit, body copy. */
export const body = localFont({
  src: [
    { path: "./fonts/favorit-book.woff2", weight: "350" },
    { path: "./fonts/favorit-regular.woff2", weight: "400" },
  ],
  variable: "--font-body",
});

/** Nib Pro, the editorial serif. */
export const serif = localFont({
  src: [
    { path: "./fonts/nib-pro-regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/nib-pro-italic.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-serif",
});

export const fontVariables = [display, accent, mono, body, serif].map((font) => font.variable).join(" ");
