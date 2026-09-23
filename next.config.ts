import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone for a small runtime image (no node_modules copy).
  output: "standalone",
  // Pin the workspace root: an unrelated package-lock.json above this
  // directory would otherwise widen the build scope.
  turbopack: { root: path.resolve(".") },
  // The app sits behind Caddy on the internal network.
  poweredByHeader: false,
};

export default nextConfig;
