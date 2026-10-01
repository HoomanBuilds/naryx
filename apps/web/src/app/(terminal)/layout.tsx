import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TerminalShell } from "@/features/terminal/shell/terminal-shell";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Naryx Terminal", template: "%s | Naryx Terminal" },
  description: "Trade complete onchain strategy packages across Solana, Base, Arbitrum, and Hyperliquid.",
};

export const viewport: Viewport = {
  themeColor: "#101011",
};

export default function TerminalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The private execution service, the public v1 market API, and the package market it shows.
  // Without them the terminal runs on the labeled local conformance fixture.
  const config = {
    privateApiBaseUrl: process.env.NEXT_PUBLIC_PRIVATE_TERMINAL_API_BASE_URL ?? null,
    publicApiBaseUrl: process.env.NEXT_PUBLIC_NARYX_PUBLIC_API_BASE_URL ?? null,
    packageMarketId: process.env.NEXT_PUBLIC_NARYX_PACKAGE_MARKET_ID ?? null,
  };
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <TerminalShell config={config}>{children}</TerminalShell>
      </body>
    </html>
  );
}
