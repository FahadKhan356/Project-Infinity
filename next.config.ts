import path from "node:path";
import type { NextConfig } from "next";

// No anonymous usage telemetry to Vercel, whichever env file is in use (the
// local template sets it too). Read by `next build`/`next dev` after this
// file is loaded, so setting it here is early enough.
process.env.NEXT_TELEMETRY_DISABLED ??= "1";

const nextConfig: NextConfig = {
  // The Docker image builds with NEXT_OUTPUT_STANDALONE=1 to get
  // .next/standalone for a small runtime image (no node_modules copy).
  // Everywhere else a normal build, which `npm start` (next start) serves —
  // next start does not support standalone output.
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  // Pin the workspace root: an unrelated package-lock.json above this
  // directory would otherwise widen the build scope.
  turbopack: { root: path.resolve(".") },
  // The app sits behind Caddy on the internal network.
  poweredByHeader: false,
};

export default nextConfig;
