import { NextResponse } from "next/server";
import { callMemoryTool } from "../../../../lib/memory/handler";

// One-click smoke test for the memory knowledge graph. Hit GET
// /api/mcp/memory/smoke to run a full round-trip — create -> relate -> observe
// -> search -> read -> cleanup — against the real store, in a throwaway
// namespace, then report each step. It calls the memory tools in-process (the
// same path the sandbox uses), so it works even when the deployment is behind
// Vercel Deployment Protection, and confirms the database is wired up before you
// test the Memory canvas.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Step {
  step: string;
  ok: boolean;
  detail?: unknown;
}

export async function GET() {
  // Throwaway namespace so the smoke test never touches real memory.
  const namespace = `__smoke__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const steps: Step[] = [];
  const record = (step: string, ok: boolean, detail?: unknown) => {
    steps.push({ step, ok, detail });
    return ok;
  };

  try {
    // 1. Create two entities with observations.
    const created = await callMemoryTool(namespace, "create_entities", {
      entities: [
        { name: "Ada Lovelace", entityType: "person", observations: ["wrote the first algorithm"] },
        { name: "Analytical Engine", entityType: "machine", observations: ["designed by Babbage"] },
      ],
    });
    record("create_entities", true, created);

    // 2. Relate them.
    const related = await callMemoryTool(namespace, "create_relations", {
      relations: [{ from: "Ada Lovelace", to: "Analytical Engine", relationType: "worked_on" }],
    });
    record("create_relations", true, related);

    // 3. Add an observation to an existing entity.
    const observed = await callMemoryTool(namespace, "add_observations", {
      observations: [{ entityName: "Ada Lovelace", contents: ["considered the first programmer"] }],
    });
    record("add_observations", true, observed);

    // 4. Search recalls the matching node.
    const found = (await callMemoryTool(namespace, "search_nodes", { query: "algorithm" })) as {
      entities?: unknown[];
    };
    record("search_nodes", (found.entities?.length ?? 0) >= 1, found);

    // 5. Read the whole graph: two entities, one relation.
    const graph = (await callMemoryTool(namespace, "read_graph", {})) as {
      entities?: unknown[];
      relations?: unknown[];
    };
    record(
      "read_graph",
      (graph.entities?.length ?? 0) === 2 && (graph.relations?.length ?? 0) === 1,
      graph
    );

    // 6. Clean up — delete both entities (cascades the relation).
    const cleaned = await callMemoryTool(namespace, "delete_entities", {
      entityNames: ["Ada Lovelace", "Analytical Engine"],
    });
    record("delete_entities (cleanup)", true, cleaned);

    const ok = steps.every((s) => s.ok);
    return NextResponse.json({ ok, namespace, steps }, { status: ok ? 200 : 500 });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        namespace,
        steps,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
