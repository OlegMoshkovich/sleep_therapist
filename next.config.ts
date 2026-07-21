import type { NextConfig } from "next";

// Clerk SDK reads CLERK_SECRET_KEY from process.env. We store it under
// AIR_CLERK_SECRET_KEY so it doesn't collide with the same name used by
// another project on Vercel — bridge the value here at build time.
if (process.env.AIR_CLERK_SECRET_KEY && !process.env.CLERK_SECRET_KEY) {
  process.env.CLERK_SECRET_KEY = process.env.AIR_CLERK_SECRET_KEY;
}

const nextConfig: NextConfig = {
  // Tests can set NEXT_DIST_DIR=.next-test so the test dev server doesn't
  // collide with a separately-running `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Hide the Next.js Dev Tools / route indicator overlay in development.
  devIndicators: false,
  transpilePackages: ["@airlab/openclaw-discovery", "@airlab/openclaw-runtime", "@airlab/canvas-core", "@airlab/canvas-compiler", "@airlab/canvas-planner", "@airlab/canvas-rules", "@airlab/canvas-ui", "@airlab/chat-ui", "@airlab/orchestration-core", "@airlab/orchestration-runtime"],
  // Keep the MCP SDK out of the bundled function chunks: load it from
  // node_modules at runtime instead. The SDK uses Node built-ins (child_process
  // for the stdio transport, etc.) and can be pulled in via orchestration-runtime.
  serverExternalPackages: ["@modelcontextprotocol/sdk"],
  // Sleep used to ship standalone /input + /expert-dashboard pages; those now
  // live in the shared studio layout (same as law / analyst).
  async redirects() {
    return [
      {
        source: "/demo/sleep/input",
        destination: "/demo/sleep/studio/config",
        permanent: true,
      },
      {
        source: "/demo/sleep/expert-dashboard",
        destination: "/demo/sleep/studio",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
