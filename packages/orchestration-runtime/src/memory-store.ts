import { createMemorySupabaseClient } from "./memory-supabase";

// The knowledge-graph store behind the memory MCP server. It mirrors the data
// model of Anthropic's `@modelcontextprotocol/server-memory` reference server —
// entities (named nodes with a type + free-text observations) and relations
// (directed, named edges between entities) — but persists to Postgres instead of
// a local JSONL file, so the graph survives across sessions on serverless/edge.
//
// Every operation is scoped to a `namespace` (the bearer-token tenant the MCP
// server resolves), so two callers never see each other's memories. The harness
// knows none of this: it only calls the MCP tools; embedding-free name lookups,
// dedup, and cascade deletes all live behind the server.

export interface MemoryEntity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface MemoryRelation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: MemoryEntity[];
  relations: MemoryRelation[];
}

export interface ObservationAddition {
  entityName: string;
  contents: string[];
}

export interface ObservationDeletion {
  entityName: string;
  observations: string[];
}

type EntityRow = {
  name: string;
  entity_type: string | null;
  observations: unknown;
};

type RelationRow = {
  from_entity: string;
  to_entity: string;
  relation_type: string;
};

function toObservations(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((o): o is string => typeof o === "string");
}

function rowToEntity(row: EntityRow): MemoryEntity {
  return {
    name: row.name,
    entityType: row.entity_type ?? "",
    observations: toObservations(row.observations),
  };
}

function rowToRelation(row: RelationRow): MemoryRelation {
  return { from: row.from_entity, to: row.to_entity, relationType: row.relation_type };
}

// ── Reads ──────────────────────────────────────────────────────────────────

async function loadEntities(namespace: string): Promise<MemoryEntity[]> {
  const supabase = createMemorySupabaseClient();
  const { data, error } = await supabase
    .from("memory_entities")
    .select("name, entity_type, observations")
    .eq("namespace", namespace);
  if (error) throw new Error(`memory: load entities failed: ${error.message}`);
  return ((data ?? []) as EntityRow[]).map(rowToEntity);
}

async function loadRelations(namespace: string): Promise<MemoryRelation[]> {
  const supabase = createMemorySupabaseClient();
  const { data, error } = await supabase
    .from("memory_relations")
    .select("from_entity, to_entity, relation_type")
    .eq("namespace", namespace);
  if (error) throw new Error(`memory: load relations failed: ${error.message}`);
  return ((data ?? []) as RelationRow[]).map(rowToRelation);
}

export async function readGraph(namespace: string): Promise<KnowledgeGraph> {
  const [entities, relations] = await Promise.all([
    loadEntities(namespace),
    loadRelations(namespace),
  ]);
  return { entities, relations };
}

// Filter the graph to entities whose name, type, or any observation contains the
// query (case-insensitive), plus only the relations that connect two surviving
// entities — matching the reference server's search_nodes behaviour.
export async function searchNodes(
  namespace: string,
  query: string
): Promise<KnowledgeGraph> {
  const { entities, relations } = await readGraph(namespace);
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? entities.filter(
        (e) =>
          e.name.toLowerCase().includes(needle) ||
          e.entityType.toLowerCase().includes(needle) ||
          e.observations.some((o) => o.toLowerCase().includes(needle))
      )
    : entities;
  return filterToEntities(matched, relations);
}

// Return specific entities by exact name plus the relations among them.
export async function openNodes(
  namespace: string,
  names: string[]
): Promise<KnowledgeGraph> {
  const { entities, relations } = await readGraph(namespace);
  const wanted = new Set(names);
  const matched = entities.filter((e) => wanted.has(e.name));
  return filterToEntities(matched, relations);
}

function filterToEntities(
  entities: MemoryEntity[],
  relations: MemoryRelation[]
): KnowledgeGraph {
  const names = new Set(entities.map((e) => e.name));
  return {
    entities,
    relations: relations.filter((r) => names.has(r.from) && names.has(r.to)),
  };
}

// ── Writes ─────────────────────────────────────────────────────────────────

// Insert only entities whose name does not already exist in the namespace, so
// the call is idempotent (re-creating an existing entity is a no-op). Returns
// the entities that were newly created.
export async function createEntities(
  namespace: string,
  entities: MemoryEntity[]
): Promise<MemoryEntity[]> {
  const existing = new Set((await loadEntities(namespace)).map((e) => e.name));
  const fresh: MemoryEntity[] = [];
  const seen = new Set<string>();
  for (const e of entities) {
    const name = e.name?.trim();
    if (!name || existing.has(name) || seen.has(name)) continue;
    seen.add(name);
    fresh.push({
      name,
      entityType: e.entityType ?? "",
      observations: Array.from(new Set(toObservations(e.observations))),
    });
  }
  if (fresh.length === 0) return [];

  const supabase = createMemorySupabaseClient();
  const { error } = await supabase.from("memory_entities").insert(
    fresh.map((e) => ({
      namespace,
      name: e.name,
      entity_type: e.entityType,
      observations: e.observations,
    }))
  );
  if (error) throw new Error(`memory: create entities failed: ${error.message}`);
  return fresh;
}

// Insert only relations not already present (idempotent). Returns the relations
// that were newly created.
export async function createRelations(
  namespace: string,
  relations: MemoryRelation[]
): Promise<MemoryRelation[]> {
  const existing = await loadRelations(namespace);
  const key = (r: MemoryRelation) => `${r.from} ${r.to} ${r.relationType}`;
  const have = new Set(existing.map(key));
  const fresh: MemoryRelation[] = [];
  for (const r of relations) {
    const from = r.from?.trim();
    const to = r.to?.trim();
    const relationType = r.relationType?.trim();
    if (!from || !to || !relationType) continue;
    const rel = { from, to, relationType };
    if (have.has(key(rel))) continue;
    have.add(key(rel));
    fresh.push(rel);
  }
  if (fresh.length === 0) return [];

  const supabase = createMemorySupabaseClient();
  const { error } = await supabase.from("memory_relations").insert(
    fresh.map((r) => ({
      namespace,
      from_entity: r.from,
      to_entity: r.to,
      relation_type: r.relationType,
    }))
  );
  if (error) throw new Error(`memory: create relations failed: ${error.message}`);
  return fresh;
}

// Append new observations to existing entities (deduped per entity). Returns,
// per entity, the observations that were actually added.
export async function addObservations(
  namespace: string,
  additions: ObservationAddition[]
): Promise<Array<{ entityName: string; addedObservations: string[] }>> {
  const entities = await loadEntities(namespace);
  const byName = new Map(entities.map((e) => [e.name, e]));
  const supabase = createMemorySupabaseClient();
  const results: Array<{ entityName: string; addedObservations: string[] }> = [];

  for (const addition of additions) {
    const entity = byName.get(addition.entityName);
    if (!entity) {
      throw new Error(`memory: entity "${addition.entityName}" not found.`);
    }
    const have = new Set(entity.observations);
    const added = toObservations(addition.contents).filter((o) => !have.has(o));
    if (added.length === 0) {
      results.push({ entityName: addition.entityName, addedObservations: [] });
      continue;
    }
    const next = [...entity.observations, ...added];
    entity.observations = next;
    const { error } = await supabase
      .from("memory_entities")
      .update({ observations: next, updated_at: new Date().toISOString() })
      .eq("namespace", namespace)
      .eq("name", addition.entityName);
    if (error) throw new Error(`memory: add observations failed: ${error.message}`);
    results.push({ entityName: addition.entityName, addedObservations: added });
  }
  return results;
}

// Delete entities by name and cascade-delete any relation that touches them.
export async function deleteEntities(
  namespace: string,
  entityNames: string[]
): Promise<void> {
  const names = entityNames.map((n) => n?.trim()).filter((n): n is string => !!n);
  if (names.length === 0) return;
  const supabase = createMemorySupabaseClient();

  const del = await supabase
    .from("memory_entities")
    .delete()
    .eq("namespace", namespace)
    .in("name", names);
  if (del.error) throw new Error(`memory: delete entities failed: ${del.error.message}`);

  // Cascade: drop relations on either side of a removed entity.
  const relFrom = await supabase
    .from("memory_relations")
    .delete()
    .eq("namespace", namespace)
    .in("from_entity", names);
  if (relFrom.error) {
    throw new Error(`memory: cascade relations (from) failed: ${relFrom.error.message}`);
  }
  const relTo = await supabase
    .from("memory_relations")
    .delete()
    .eq("namespace", namespace)
    .in("to_entity", names);
  if (relTo.error) {
    throw new Error(`memory: cascade relations (to) failed: ${relTo.error.message}`);
  }
}

// Remove specific observations from entities, leaving the entities in place.
export async function deleteObservations(
  namespace: string,
  deletions: ObservationDeletion[]
): Promise<void> {
  const entities = await loadEntities(namespace);
  const byName = new Map(entities.map((e) => [e.name, e]));
  const supabase = createMemorySupabaseClient();

  for (const deletion of deletions) {
    const entity = byName.get(deletion.entityName);
    if (!entity) continue;
    const remove = new Set(toObservations(deletion.observations));
    const next = entity.observations.filter((o) => !remove.has(o));
    if (next.length === entity.observations.length) continue;
    entity.observations = next;
    const { error } = await supabase
      .from("memory_entities")
      .update({ observations: next, updated_at: new Date().toISOString() })
      .eq("namespace", namespace)
      .eq("name", deletion.entityName);
    if (error) throw new Error(`memory: delete observations failed: ${error.message}`);
  }
}

// Delete specific relations (exact from/to/relationType match).
export async function deleteRelations(
  namespace: string,
  relations: MemoryRelation[]
): Promise<void> {
  const supabase = createMemorySupabaseClient();
  for (const r of relations) {
    const { error } = await supabase
      .from("memory_relations")
      .delete()
      .eq("namespace", namespace)
      .eq("from_entity", r.from)
      .eq("to_entity", r.to)
      .eq("relation_type", r.relationType);
    if (error) throw new Error(`memory: delete relations failed: ${error.message}`);
  }
}
