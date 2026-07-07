import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { searchCorpusDocuments, formatChunksAsText } from "../../../lib/corpus/search";

// In-repo MCP server exposing the uploaded document corpus over Streamable HTTP,
// mirroring the Wikipedia route's shape. The portable harness reaches this via
// the binding { server: "corpus", tool: "search_documents" } and the servers
// map (SEED_SERVERS.corpus) — it knows nothing about Supabase, pgvector, or the
// embedding model, all of which live behind this server.
//
// Tenancy (B1 first slice): the corpus is scoped by the bearer token, which is
// used directly as the corpus_id. A real deployment would map token -> corpus
// via a lookup table rather than using the raw token as the id.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_CORPUS_ID = "default";

function corpusIdFromRequest(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || DEFAULT_CORPUS_ID;
}

function buildServer(corpusId: string): McpServer {
  const server = new McpServer({ name: "airlab-corpus-mcp", version: "1.0.0" });

  server.registerTool(
    "search_documents",
    {
      description:
        "Search the uploaded document corpus for passages relevant to a query and return the most similar chunks. Use this to answer questions from the documents.",
      inputSchema: {
        query: z.string().describe("The user's question, used to search the corpus"),
      },
    },
    async ({ query }) => {
      const chunks = await searchCorpusDocuments(corpusId, query);
      return { content: [{ type: "text", text: formatChunksAsText(chunks) }] };
    }
  );

  return server;
}

async function handle(request: Request): Promise<Response> {
  const corpusId = corpusIdFromRequest(request);
  const server = buildServer(corpusId);
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
