import type {
  McpAuth,
  ToolDispatchResult,
} from "@airlab/canvas-compiler/tool-types";

// Contract 3 from the design proposal — "Tool resolution (reference → reality)".
// A broker that takes a resolved server URL + the remote tool name, connects
// over MCP, and dispatches the call. No tool logic lives here; it only brokers
// between a policy's references and a public MCP server. MCP is the choice
// because it is the vendor-neutral standard: a tool defined once on a server is
// callable by any compliant client, which keeps the tool layer independent of
// both our codebase and the chosen LLM.
//
// The SDK is loaded via a dynamic import (Node runtime only) so a deployment
// without it degrades gracefully instead of failing the whole route. This
// mirrors app/api/mcp/list/route.ts.

const MAX_RESPONSE_BYTES = 64_000;

type McpToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

type McpClientInstance = {
  connect: (transport: unknown) => Promise<void>;
  callTool: (args: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<McpToolResult>;
  close: () => Promise<void>;
};

type McpSdkModules = {
  Client: new (args: { name: string; version: string }) => McpClientInstance;
  StreamableHTTPClientTransport: new (
    url: URL,
    options?: { requestInit?: { headers: Record<string, string> } }
  ) => unknown;
  SSEClientTransport: new (
    url: URL,
    options?: { requestInit?: { headers: Record<string, string> } }
  ) => unknown;
  StdioClientTransport: new (params: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }) => unknown;
};

async function loadMcpSdk(): Promise<McpSdkModules> {
  // Plain dynamic import() with literal specifiers — NOT wrapped in
  // Function("return import(...)") — so Next/Vercel's dependency tracer
  // (@vercel/nft) sees the dependency and bundles the SDK into the serverless
  // function. The earlier Function-indirection hid it from the tracer, so on
  // Vercel the package was absent at runtime ("Cannot find package
  // '@modelcontextprotocol/sdk'"). Still lazy — loaded on first call.
  const clientModule = (await import(
    "@modelcontextprotocol/sdk/client/index.js"
  )) as unknown as { Client: McpSdkModules["Client"] };
  const streamableModule = (await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  )) as unknown as { StreamableHTTPClientTransport: McpSdkModules["StreamableHTTPClientTransport"] };
  const sseModule = (await import(
    "@modelcontextprotocol/sdk/client/sse.js"
  )) as unknown as { SSEClientTransport: McpSdkModules["SSEClientTransport"] };
  const stdioModule = (await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  )) as unknown as { StdioClientTransport: McpSdkModules["StdioClientTransport"] };

  return {
    Client: clientModule.Client,
    StreamableHTTPClientTransport: streamableModule.StreamableHTTPClientTransport,
    SSEClientTransport: sseModule.SSEClientTransport,
    StdioClientTransport: stdioModule.StdioClientTransport,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Flatten an MCP tool result into something the model can read. Text parts are
// joined; anything else is returned verbatim. Capped like the HTTP fetcher.
function normalizeResult(result: McpToolResult): unknown {
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .slice(0, MAX_RESPONSE_BYTES);
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result.content ?? result;
}

export interface McpTarget {
  /** Remote MCP server URL (Streamable HTTP / SSE). */
  serverUrl?: string;
  auth?: McpAuth;
  /** Local stdio MCP server launch command (e.g. "npx"). Used when no url. */
  command?: string;
  args?: string[];
  /** The tool to call on that server. */
  remoteTool: string;
}

// Connect the client to either a remote (url) or local (stdio command) server.
async function connect(sdk: McpSdkModules, client: McpClientInstance, target: McpTarget) {
  if (target.serverUrl) {
    const url = new URL(target.serverUrl);
    const headers: Record<string, string> = {};
    if (target.auth?.type === "bearer") headers.Authorization = `Bearer ${target.auth.token}`;
    const requestInit = Object.keys(headers).length ? { headers } : undefined;
    // Try modern Streamable HTTP first, then fall back to the older SSE transport.
    try {
      await client.connect(new sdk.StreamableHTTPClientTransport(url, { requestInit }));
    } catch (httpErr) {
      try {
        await client.connect(new sdk.SSEClientTransport(url, { requestInit }));
      } catch (sseErr) {
        throw new Error(
          `Streamable HTTP: ${errMsg(httpErr)} · SSE: ${errMsg(sseErr)}`
        );
      }
    }
    return;
  }
  if (target.command) {
    // Launch the public server as a subprocess and talk over stdio. The server
    // is referenced, never bundled — npx fetches it on first run.
    await client.connect(
      new sdk.StdioClientTransport({ command: target.command, args: target.args ?? [] })
    );
    return;
  }
  throw new Error("No MCP server URL or command provided.");
}

export async function callMcpTool(
  target: McpTarget,
  args: Record<string, unknown>
): Promise<ToolDispatchResult> {
  let sdk: McpSdkModules;
  try {
    sdk = await loadMcpSdk();
  } catch (e) {
    return { ok: false, error: `MCP SDK unavailable: ${errMsg(e)}` };
  }

  const client = new sdk.Client({ name: "airlab-tool-broker", version: "1.0.0" });

  try {
    await connect(sdk, client, target);
  } catch (e) {
    return { ok: false, error: `Could not connect to MCP server. ${errMsg(e)}` };
  }

  try {
    const result = await client.callTool({ name: target.remoteTool, arguments: args });
    if (result.isError) {
      return { ok: false, error: `MCP tool "${target.remoteTool}" reported an error.` };
    }
    return { ok: true, data: normalizeResult(result) };
  } catch (e) {
    return { ok: false, error: `MCP callTool failed: ${errMsg(e)}` };
  } finally {
    await client.close().catch(() => {});
  }
}
