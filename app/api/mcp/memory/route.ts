import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { callMemoryTool } from "../../../lib/memory/handler";

// In-repo MCP server exposing a persistent knowledge graph over Streamable HTTP,
// mirroring Anthropic's `@modelcontextprotocol/server-memory` reference server
// (same tool surface: create_entities / create_relations / add_observations /
// delete_* / read_graph / search_nodes / open_nodes). The reference server is
// file-backed and local; this one stores the graph in Postgres (see
// app/lib/memory/store.ts) so the same policy binding
// { server: "memory", tool: "create_entities" } works on serverless/edge, where
// the stdio `npx @modelcontextprotocol/server-memory` path can't spawn a
// subprocess or write to local disk. Point MEMORY_MCP_SERVER_URL at this route.
//
// Tenancy mirrors the corpus route: the graph is scoped by the bearer token,
// used directly as the namespace, so each caller has its own memory.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_NAMESPACE = "default";

function namespaceFromRequest(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || DEFAULT_NAMESPACE;
}

const entitySchema = z.object({
  name: z.string().describe("The unique name of the entity"),
  entityType: z.string().describe("The type of the entity (e.g. person, project, preference)"),
  observations: z
    .array(z.string())
    .describe("Short free-text facts observed about this entity"),
});

const relationSchema = z.object({
  from: z.string().describe("The name of the entity the relation starts from"),
  to: z.string().describe("The name of the entity the relation points to"),
  relationType: z.string().describe("The relationship type, in active voice (e.g. works_at)"),
});

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function buildServer(namespace: string): McpServer {
  const server = new McpServer({ name: "airlab-memory-mcp", version: "1.0.0" });

  server.registerTool(
    "create_entities",
    {
      description:
        "Create one or more new entities (named nodes with a type and observations) in the knowledge graph. Existing entities with the same name are skipped.",
      inputSchema: { entities: z.array(entitySchema) },
    },
    async (args) => jsonText(await callMemoryTool(namespace, "create_entities", args))
  );

  server.registerTool(
    "create_relations",
    {
      description:
        "Create one or more directed relations between existing entities. Duplicate relations are skipped.",
      inputSchema: { relations: z.array(relationSchema) },
    },
    async (args) => jsonText(await callMemoryTool(namespace, "create_relations", args))
  );

  server.registerTool(
    "add_observations",
    {
      description: "Add new observations (facts) to existing entities, identified by name.",
      inputSchema: {
        observations: z.array(
          z.object({
            entityName: z.string().describe("The name of the entity to add observations to"),
            contents: z.array(z.string()).describe("The new observations to add"),
          })
        ),
      },
    },
    async (args) => jsonText(await callMemoryTool(namespace, "add_observations", args))
  );

  server.registerTool(
    "delete_entities",
    {
      description: "Delete entities by name, cascading to any relations that touch them.",
      inputSchema: { entityNames: z.array(z.string()) },
    },
    async (args) => jsonText(await callMemoryTool(namespace, "delete_entities", args))
  );

  server.registerTool(
    "delete_observations",
    {
      description: "Delete specific observations from entities, leaving the entities in place.",
      inputSchema: {
        deletions: z.array(
          z.object({
            entityName: z.string().describe("The entity to remove observations from"),
            observations: z.array(z.string()).describe("The observations to remove"),
          })
        ),
      },
    },
    async (args) => jsonText(await callMemoryTool(namespace, "delete_observations", args))
  );

  server.registerTool(
    "delete_relations",
    {
      description: "Delete specific relations from the knowledge graph.",
      inputSchema: { relations: z.array(relationSchema) },
    },
    async (args) => jsonText(await callMemoryTool(namespace, "delete_relations", args))
  );

  server.registerTool(
    "read_graph",
    {
      description: "Read the entire knowledge graph (all entities and relations).",
      inputSchema: {},
    },
    async (args) => jsonText(await callMemoryTool(namespace, "read_graph", args))
  );

  server.registerTool(
    "search_nodes",
    {
      description:
        "Search the knowledge graph for nodes whose name, type, or observations match the query, and return them with the relations among them.",
      inputSchema: { query: z.string().describe("The search query") },
    },
    async (args) => jsonText(await callMemoryTool(namespace, "search_nodes", args))
  );

  server.registerTool(
    "open_nodes",
    {
      description: "Open specific entities by name and return them with the relations among them.",
      inputSchema: { names: z.array(z.string()).describe("The names of the entities to open") },
    },
    async (args) => jsonText(await callMemoryTool(namespace, "open_nodes", args))
  );

  return server;
}

async function handle(request: Request): Promise<Response> {
  const namespace = namespaceFromRequest(request);
  const server = buildServer(namespace);
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
