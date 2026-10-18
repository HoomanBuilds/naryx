import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "export",
  poweredByHeader: false,
  images: { unoptimized: true },
  transpilePackages: ["@naryx/protocol-types", "@naryx/sdk"],
  turbopack: { root: path.resolve(import.meta.dirname, "../..") },
};

export default nextConfig;
