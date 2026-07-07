import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "../../../lib/supabase-admin";
import { getRequestUserUUID } from "../../../lib/admin-auth";
import { SEED_DOC, SEED_FIELDS, SEED_KNOWLEDGE } from "../../../sandbox/seed";

interface CanvasRow {
  id: string;
  name: string;
  doc: unknown;
  sort_order: number;
}

interface KnowledgeRow {
  id: string;
  topic: string;
  content: string;
  sort_order: number;
  source_tool_call_id: string | null;
}

interface StateFieldRow {
  id: string;
  name: string;
  type: string;
  initial_value: string;
  sort_order: number;
}

async function loadChildren(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  configId: string
) {
  const [blocks, fields, canvases] = await Promise.all([
    supabase
      .from("sandbox_knowledge_blocks")
      .select("id, topic, content, sort_order, source_tool_call_id")
      .eq("config_id", configId)
      .order("sort_order"),
    supabase
      .from("sandbox_state_fields")
      .select("id, name, type, initial_value, sort_order")
      .eq("config_id", configId)
      .order("sort_order"),
    supabase
      .from("sandbox_canvases")
      .select("id, name, doc, sort_order")
      .eq("config_id", configId)
      .order("sort_order"),
  ]);

  return {
    knowledgeBlocks: (blocks.data ?? []) as KnowledgeRow[],
    stateFields: (fields.data ?? []) as StateFieldRow[],
    canvases: (canvases.data ?? []) as CanvasRow[],
  };
}

export async function GET(_request: NextRequest) {
  const userUUID = await getRequestUserUUID();
  if (!userUUID) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseAdminClient();

  const { data: existing, error: findError } = await supabase
    .from("sandbox_configs")
    .select("id, endpoint, config_name, policy_prompt, state_update_prompt")
    .eq("expert_id", userUUID)
    .maybeSingle();

  if (findError) {
    console.error("[api/sandbox/state] find error:", findError.message);
    return NextResponse.json({ error: findError.message }, { status: 500 });
  }

  let configId: string;
  let configRow: typeof existing;

  if (existing) {
    configId = existing.id;
    configRow = existing;
  } else {
    const { data: created, error: createError } = await supabase
      .from("sandbox_configs")
      .insert({
        endpoint: "sandbox/default",
        expert_id: userUUID,
      })
      .select("id, endpoint, config_name, policy_prompt, state_update_prompt")
      .single();

    if (createError || !created) {
      console.error("[api/sandbox/state] create error:", createError?.message);
      return NextResponse.json(
        { error: createError?.message ?? "Failed to create config" },
        { status: 500 }
      );
    }

    configId = created.id;
    configRow = created;

    await Promise.all([
      supabase.from("sandbox_knowledge_blocks").insert(
        SEED_KNOWLEDGE.map((k, i) => ({
          config_id: configId,
          topic: k.topic,
          content: k.content,
          sort_order: i,
        }))
      ),
      supabase.from("sandbox_state_fields").insert(
        SEED_FIELDS.map((f, i) => ({
          config_id: configId,
          name: f.name,
          type: f.type,
          initial_value: f.initialValue,
          sort_order: i,
        }))
      ),
      supabase.from("sandbox_canvases").insert(
        SEED_DOC.canvases.map((c, i) => ({
          config_id: configId,
          name: c.name,
          doc: { freeText: c.freeText, graph: c.graph },
          sort_order: i,
        }))
      ),
    ]);
  }

  const children = await loadChildren(supabase, configId);

  return NextResponse.json({
    configId,
    config: configRow,
    ...children,
  });
}

interface PutBody {
  configId: string;
  config?: {
    config_name?: string | null;
    policy_prompt?: string | null;
    state_update_prompt?: string | null;
  };
  knowledgeBlocks: Array<{
    id: string;
    topic: string;
    content: string;
    source_tool_call_id?: string | null;
  }>;
  stateFields: Array<{
    id: string;
    name: string;
    type: string;
    initial_value: string;
  }>;
  canvases: Array<{
    id: string;
    name: string;
    doc: unknown;
  }>;
}

async function reconcile<T extends { id: string }>(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  table: string,
  configId: string,
  items: T[],
  toRow: (item: T, index: number) => Record<string, unknown>
) {
  const rows = items.map((item, i) => ({ ...toRow(item, i), config_id: configId }));
  if (rows.length > 0) {
    const { error: upsertError } = await supabase.from(table).upsert(rows, { onConflict: "id" });
    if (upsertError) {
      console.error(`[api/sandbox/state] upsert ${table} error:`, upsertError.message);
      throw new Error(upsertError.message);
    }
  }

  const { data: existing, error: selectError } = await supabase
    .from(table)
    .select("id")
    .eq("config_id", configId);
  if (selectError) {
    console.error(`[api/sandbox/state] select ${table} error:`, selectError.message);
    throw new Error(selectError.message);
  }
  const keep = new Set(items.map((item) => item.id));
  const toDelete = ((existing ?? []) as Array<{ id: string }>)
    .map((r) => r.id)
    .filter((id) => !keep.has(id));
  if (toDelete.length > 0) {
    const { error: deleteError } = await supabase.from(table).delete().in("id", toDelete);
    if (deleteError) {
      console.error(`[api/sandbox/state] delete ${table} error:`, deleteError.message);
      throw new Error(deleteError.message);
    }
  }
}

export async function PUT(request: NextRequest) {
  const userUUID = await getRequestUserUUID();
  if (!userUUID) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as PutBody;
  if (!body?.configId) {
    return NextResponse.json({ error: "configId is required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  const { data: owned, error: ownError } = await supabase
    .from("sandbox_configs")
    .select("id")
    .eq("id", body.configId)
    .eq("expert_id", userUUID)
    .maybeSingle();
  if (ownError) {
    return NextResponse.json({ error: ownError.message }, { status: 500 });
  }
  if (!owned) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (body.config) {
    const { error: updateError } = await supabase
      .from("sandbox_configs")
      .update({
        config_name: body.config.config_name ?? null,
        policy_prompt: body.config.policy_prompt ?? null,
        state_update_prompt: body.config.state_update_prompt ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", body.configId);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
  }

  try {
    await reconcile(
      supabase,
      "sandbox_knowledge_blocks",
      body.configId,
      body.knowledgeBlocks ?? [],
      (item, i) => ({
        id: item.id,
        topic: item.topic,
        content: item.content,
        sort_order: i,
        source_tool_call_id: item.source_tool_call_id ?? null,
      })
    );
    await reconcile(
      supabase,
      "sandbox_state_fields",
      body.configId,
      body.stateFields ?? [],
      (item, i) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        initial_value: item.initial_value,
        sort_order: i,
      })
    );
    await reconcile(
      supabase,
      "sandbox_canvases",
      body.configId,
      body.canvases ?? [],
      (item, i) => ({
        id: item.id,
        name: item.name,
        doc: item.doc,
        sort_order: i,
      })
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Reconcile failed" },
      { status: 500 }
    );
  }

  const children = await loadChildren(supabase, body.configId);
  return NextResponse.json({ configId: body.configId, ...children });
}
