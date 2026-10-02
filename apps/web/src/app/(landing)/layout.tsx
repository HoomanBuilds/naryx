import type { Metadata, Viewport } from "next";
import { fontVariables } from "@/features/landing/fonts";
import { siteUrl } from "../site-url";
import "./globals.css";

const TITLE = "Naryx: trade the strategy, not the legs";
const DESCRIPTION =
  "Naryx is the open execution, lifecycle and clearing network for complete onchain strategies. Send one order with every leg, let solvers quote the whole outcome, and get one receipt for the package.";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "Naryx", title: TITLE, description: DESCRIPTION, url: "/" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
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
