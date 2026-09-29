import type { Metadata, Viewport } from "next";
import { fontVariables } from "@/features/landing/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Naryx: trade the strategy, not the legs",
  description:
    "Naryx is the open execution, lifecycle and clearing network for complete onchain strategies. Send one order with every leg, let solvers quote the whole outcome, and get one receipt for the package.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={fontVariables}>
      <body>{children}</body>
    </html>
  );
}
