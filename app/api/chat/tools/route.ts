import { auth } from "@clerk/nextjs/server";
import { createChatToolsPostHandler } from "@airlab/orchestration-runtime/chat-tools-route";

import { dispatchTool } from "../../../lib/tools/dispatch";

// MCP tools can resolve to a local stdio server (e.g. npx wikipedia-mcp), which
// spawns a subprocess — that needs the Node runtime, not edge.
export const runtime = "nodejs";

export const POST = createChatToolsPostHandler({
  authenticate: async () => {
    const { userId } = await auth();
    return { userId };
  },
  dispatchTool,
});
