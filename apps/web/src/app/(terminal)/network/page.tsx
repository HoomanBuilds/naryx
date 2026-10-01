import type { Metadata } from "next";
import { NetworkView } from "@/features/terminal/pages/network-view";

export const metadata: Metadata = { title: "Network" };

export default function NetworkPage() {
  return <NetworkView />;
}
