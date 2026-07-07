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
  transpilePackages: ["@airlab/openclaw-discovery", "@airlab/openclaw-runtime", "@airlab/canvas-core", "@airlab/canvas-compiler", "@airlab/canvas-planner", "@airlab/canvas-rules", "@airlab/canvas-ui", "@airlab/chat-ui", "@airlab/orchestration-core", "@airlab/orchestration-runtime"],
  // Keep the MCP SDK out of the bundled function chunks: load it from
  // node_modules at runtime instead. The SDK uses Node built-ins (child_process
  // for the stdio transport, etc.) and is shared by several routes — bundling a
  // copy into each function chunk bloats them and can fail the deploy upload.
  // Combined with the literal dynamic import() in app/lib/tools/mcp.ts, Vercel's
  // tracer still includes the package, so it's present at runtime.
  serverExternalPackages: ["@modelcontextprotocol/sdk"],
};

export default nextConfig;
