import {
  addObservations,
  createEntities,
  createRelations,
  deleteEntities,
  deleteObservations,
  deleteRelations,
  openNodes,
  readGraph,
  searchNodes,
  type MemoryEntity,
  type MemoryRelation,
  type ObservationAddition,
  type ObservationDeletion,
} from "./memory-store";

// Single source of truth that maps a memory MCP tool name + arguments onto the
// knowledge-graph store. Two callers share it:
//   1. The in-repo MCP server route (/api/mcp/memory) — wraps the result as MCP
//      content for external clients reaching the server over HTTP.
//   2. The tool dispatcher — calls this directly, in-process, for the sandbox,
//      so a self-hosted deployment never makes an HTTP loopback to its own MCP
//      endpoint (which on Vercel is behind Deployment Protection and would 401).
//
// Keeping the mapping here means the over-the-wire server and the in-process
// path can never drift.
export async function callMemoryTool(
  namespace: string,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (tool) {
    case "create_entities":
      return { created: await createEntities(namespace, (args.entities as MemoryEntity[]) ?? []) };
    case "create_relations":
      return { created: await createRelations(namespace, (args.relations as MemoryRelation[]) ?? []) };
    case "add_observations":
      return await addObservations(namespace, (args.observations as ObservationAddition[]) ?? []);
    case "delete_entities":
      await deleteEntities(namespace, (args.entityNames as string[]) ?? []);
      return { deleted: (args.entityNames as string[]) ?? [] };
    case "delete_observations":
      await deleteObservations(namespace, (args.deletions as ObservationDeletion[]) ?? []);
      return { ok: true };
    case "delete_relations":
      await deleteRelations(namespace, (args.relations as MemoryRelation[]) ?? []);
      return { ok: true };
    case "read_graph":
      return await readGraph(namespace);
    case "search_nodes":
      return await searchNodes(namespace, String(args.query ?? ""));
    case "open_nodes":
      return await openNodes(namespace, (args.names as string[]) ?? []);
    default:
      throw new Error(`Unknown memory tool: ${tool}`);
  }
}
