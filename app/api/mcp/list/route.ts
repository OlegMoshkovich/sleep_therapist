import { NextRequest, NextResponse } from "next/server";

// MCP clients need a Node runtime (not edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type McpClientTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type McpClientInstance = {
  connect: (transport: unknown) => Promise<void>;
  listTools: () => Promise<{ tools: McpClientTool[] }>;
  getServerVersion?: () => unknown;
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
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loadMcpSdk(): Promise<McpSdkModules> {
  // Literal dynamic import() (not Function-wrapped) so Vercel's tracer bundles
  // the SDK into the function — see app/lib/tools/mcp.ts for the full rationale.
  const clientModule = (await import(
    "@modelcontextprotocol/sdk/client/index.js"
  )) as unknown as { Client: McpSdkModules["Client"] };
  const streamableModule = (await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  )) as unknown as { StreamableHTTPClientTransport: McpSdkModules["StreamableHTTPClientTransport"] };
  const sseModule = (await import(
    "@modelcontextprotocol/sdk/client/sse.js"
  )) as unknown as { SSEClientTransport: McpSdkModules["SSEClientTransport"] };

  return {
    Client: clientModule.Client,
    StreamableHTTPClientTransport: streamableModule.StreamableHTTPClientTransport,
    SSEClientTransport: sseModule.SSEClientTransport,
  };
}

export async function POST(req: NextRequest) {
  let sdk: McpSdkModules;
  try {
    sdk = await loadMcpSdk();
  } catch (error) {
    return NextResponse.json(
      { error: `MCP SDK is unavailable on this deployment: ${errMsg(error)}` },
      { status: 503 }
    );
  }

  let body: { serverUrl?: string; bearer?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const serverUrl = (body.serverUrl ?? "").trim();
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return NextResponse.json({ error: "Enter a valid URL." }, { status: 400 });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return NextResponse.json({ error: "Only http(s) MCP servers are supported." }, { status: 400 });
  }

  const headers: Record<string, string> = {};
  if (body.bearer?.trim()) headers.Authorization = `Bearer ${body.bearer.trim()}`;
  const requestInit = Object.keys(headers).length ? { headers } : undefined;

  const client = new sdk.Client({ name: "airlab-mcp-browser", version: "1.0.0" });

  // Try modern Streamable HTTP first, then fall back to the older SSE transport.
  let transport: "streamable-http" | "sse" = "streamable-http";
  try {
    await client.connect(new sdk.StreamableHTTPClientTransport(url, { requestInit }));
  } catch (httpErr) {
    transport = "sse";
    try {
      await client.connect(new sdk.SSEClientTransport(url, { requestInit }));
    } catch (sseErr) {
      return NextResponse.json(
        {
          error: `Could not connect. Streamable HTTP: ${errMsg(httpErr)} · SSE: ${errMsg(sseErr)}`,
        },
        { status: 502 }
      );
    }
  }

  try {
    const { tools } = await client.listTools();
    const server = client.getServerVersion?.() ?? null;
    return NextResponse.json({
      transport,
      server,
      count: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: `listTools failed: ${errMsg(e)}` }, { status: 502 });
  } finally {
    await client.close().catch(() => {});
  }
}
