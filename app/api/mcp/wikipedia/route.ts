import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { searchWikipedia, readWikipediaArticle } from "../../../lib/tools/wikipedia";

// An in-repo MCP server exposing Wikipedia over Streamable HTTP, mirroring the
// public `wikipedia-mcp` server's tools (`search`, `readArticle`). It exists so
// the same policy binding { server: "wikipedia", tool: "readArticle" } can run
// on serverless/edge — where the stdio `npx wikipedia-mcp` path can't spawn a
// subprocess. Point WIKIPEDIA_MCP_SERVER_URL at this route to use it.
//
// Uses the Web-standard transport (Request -> Response) so it drops straight
// into a Next.js route handler, and runs stateless (a fresh server + transport
// per request, JSON responses, no sessions).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildServer(): McpServer {
  const server = new McpServer({ name: "airlab-wikipedia-mcp", version: "1.0.0" });

  server.registerTool(
    "search",
    {
      description: "Search Wikipedia and return the top matching article titles, links, and snippets.",
      inputSchema: { query: z.string().describe("The search term for Wikipedia") },
    },
    async ({ query }) => ({ content: [{ type: "text", text: await searchWikipedia(query) }] })
  );

  server.registerTool(
    "readArticle",
    {
      description: "Read a Wikipedia article by title (or page id). Returns the article text and canonical URL.",
      inputSchema: {
        title: z.string().optional().describe("The title of the Wikipedia article to read"),
        pageId: z.number().optional().describe("The page ID of the Wikipedia article to read"),
      },
    },
    async ({ title, pageId }) => {
      if (!title && pageId === undefined) {
        return {
          content: [{ type: "text", text: "Error: Either title or pageId must be provided." }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: await readWikipediaArticle({ title, pageId }) }] };
    }
  );

  return server;
}

async function handle(request: Request): Promise<Response> {
  const server = buildServer();
  // Stateless: no sessionIdGenerator; reply with a single JSON response.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export const POST = (request: Request) => handle(request);
export const GET = (request: Request) => handle(request);
export const DELETE = (request: Request) => handle(request);
