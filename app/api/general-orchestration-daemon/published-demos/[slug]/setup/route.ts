import { NextRequest, NextResponse } from "next/server";

import {
  type HybridExecutionPlan,
  type RuntimeStateField,
} from "../../../../../lib/canvas-hybrid-runtime";
import { buildStructuralExecutionPlan } from "../../../../../lib/canvas-structural-planner";
import {
  ensureDaemonConversationProject,
  hydrateDaemonDraft,
  type GeneralOrchestrationDaemonDraftRow,
} from "../../../../../lib/general-orchestration-daemon-drafts";
import {
  GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE,
} from "../../../../../lib/general-orchestration-daemon-published-demos";
import {
  type OrchestrationProject,
} from "../../../../../lib/general-orchestration";
import {
  serializeOrchestrationProject,
  type StoredOrchestrationCanvasRow,
} from "../../../../../lib/orchestration-project-storage";
import { materializeLegacyProjectAgentTemplate } from "../../../../../lib/project-agent-template-materialization";
import { resolveCurrentUser } from "../../../../../lib/admin-auth";
import { createSupabaseAdminClient } from "../../../../../lib/supabase-admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

interface SetupBody {
  project?: unknown;
}

type SupabaseClient = ReturnType<typeof createSupabaseAdminClient>;
type CanvasTable = "policy_canvases" | "state_policy_canvases";

const PUBLISHED_DEMO_SELECT =
  "id, expert_id, endpoint, agent_id, config_name, route_slug, setup_summary, policy_intent, workspace_status, state_schema, state_update_prompt, policy_prompt, guideline_blocks, datasets, shared_datasets, interaction_protocol, skills, agent_bindings, agent_connections, environment_players, uploaded_files, daemon_state, conversation_messages, created_at, updated_at";

function normalizeSlug(value: string) {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function readSubmittedProject(body: SetupBody): OrchestrationProject | null {
  const value = body.project;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as OrchestrationProject;
}

function statePlanUsesOnlyDirectExecution(
  plan: HybridExecutionPlan["state"]["code_plan"] | undefined
): boolean {
  if (!plan) {
    return false;
  }

  if (plan.prompt_extraction_plan) {
    return false;
  }

  if (plan.fallback_to_prompt_when_no_rule_matches) {
    return false;
  }

  if (!plan.execution_graph) {
    return true;
  }

  return plan.execution_graph.steps.every(
    (step) =>
      step.type === "code" ||
      step.type === "tool_call" ||
      step.type === "end"
  );
}

function normalizeExecutionPlanForRuntime(
  plan: HybridExecutionPlan
): HybridExecutionPlan {
  if (plan.state.mode === "full_prompt") {
    return plan;
  }

  if (statePlanUsesOnlyDirectExecution(plan.state.code_plan)) {
    return {
      ...plan,
      state: {
        ...plan.state,
        mode: "code",
      },
    };
  }

  return plan;
}

function buildExecutionPlan(project: OrchestrationProject): HybridExecutionPlan {
  const stateSchema: RuntimeStateField[] = project.fields.map((field) => ({
    fieldName: field.name,
    type: field.type,
    initialValue: field.initialValue,
  }));

  return normalizeExecutionPlanForRuntime(
    buildStructuralExecutionPlan({
      stateSchema,
      stateCanvasDoc: project.statePolicyCanvases,
      policyCanvasDoc: project.policyCanvases,
    })
  );
}

async function fetchCanvasRows(
  supabase: SupabaseClient,
  table: CanvasTable,
  setupId: string
): Promise<StoredOrchestrationCanvasRow[]> {
  const { data, error } = await supabase
    .from(table)
    .select("canvas_id, name, sort_order, canvas")
    .eq("setup_table", GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE)
    .eq("setup_id", setupId)
    .order("sort_order", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as StoredOrchestrationCanvasRow[];
}

async function replaceCanvasRows(
  supabase: SupabaseClient,
  table: CanvasTable,
  setupId: string,
  rows: StoredOrchestrationCanvasRow[]
) {
  const { error: deleteError } = await supabase
    .from(table)
    .delete()
    .eq("setup_table", GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE)
    .eq("setup_id", setupId);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  if (rows.length === 0) {
    return;
  }

  const { error: upsertError } = await supabase.from(table).upsert(
    rows.map((row, index) => ({
      setup_table: GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE,
      setup_id: setupId,
      canvas_id: row.canvas_id,
      name: row.name,
      sort_order: row.sort_order ?? index,
      canvas: row.canvas,
    })),
    { onConflict: "setup_table,setup_id,canvas_id" }
  );

  if (upsertError) {
    throw new Error(upsertError.message);
  }
}

async function saveExecutionPlan(
  supabase: SupabaseClient,
  setupId: string,
  executionPlan: HybridExecutionPlan
) {
  const { error } = await supabase
    .from("canvas_execution_plans")
    .upsert(
      {
        setup_table: GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE,
        setup_id: setupId,
        execution_plan: executionPlan,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "setup_table,setup_id" }
    );

  if (error) {
    throw new Error(error.message);
  }
}

async function loadPublishedDemoRow(
  supabase: SupabaseClient,
  slug: string
): Promise<GeneralOrchestrationDaemonDraftRow | null> {
  const { data, error } = await supabase
    .from(GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE)
    .select(PUBLISHED_DEMO_SELECT)
    .eq("endpoint", `/demo/${slug}`)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? null) as GeneralOrchestrationDaemonDraftRow | null;
}

function isAllowedToManage(args: {
  ownerId: string;
  userUUID: string;
  isAdmin: boolean;
}) {
  return args.isAdmin || (!!args.ownerId && args.ownerId === args.userUUID);
}

export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const { slug: rawSlug } = await ctx.params;
    const slug = normalizeSlug(rawSlug);
    if (!slug || slug.includes("/")) {
      return NextResponse.json({ error: "Unknown demo" }, { status: 404 });
    }

    const me = await resolveCurrentUser();
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();
    const row = await loadPublishedDemoRow(supabase, slug);
    if (!row?.id) {
      return NextResponse.json({ error: "Unknown demo" }, { status: 404 });
    }

    if (
      !isAllowedToManage({
        ownerId: String(row.expert_id ?? ""),
        userUUID: me.userUUID,
        isAdmin: me.isAdmin,
      })
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const [policyCanvases, statePolicyCanvases] = await Promise.all([
      fetchCanvasRows(supabase, "policy_canvases", row.id),
      fetchCanvasRows(supabase, "state_policy_canvases", row.id),
    ]);
    const hydrated = hydrateDaemonDraft({
      config: row,
      policyCanvases,
      statePolicyCanvases,
    });

    return NextResponse.json({
      id: row.id,
      title: row.config_name ?? "Agent-0",
      project: hydrated.project,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load demo setup.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, ctx: RouteContext) {
  try {
    const { slug: rawSlug } = await ctx.params;
    const slug = normalizeSlug(rawSlug);
    if (!slug || slug.includes("/")) {
      return NextResponse.json({ error: "Unknown demo" }, { status: 404 });
    }

    const me = await resolveCurrentUser();
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();
    const row = await loadPublishedDemoRow(supabase, slug);
    if (!row?.id) {
      return NextResponse.json({ error: "Unknown demo" }, { status: 404 });
    }

    if (
      !isAllowedToManage({
        ownerId: String(row.expert_id ?? ""),
        userUUID: me.userUUID,
        isAdmin: me.isAdmin,
      })
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as SetupBody;
    const project = readSubmittedProject(body);
    if (!project) {
      return NextResponse.json({ error: "Missing project" }, { status: 400 });
    }

    const submittedProject = {
      ...project,
      meta: {
        ...project.meta,
        slug,
        status: "Published",
      },
    };
    const materializedProject = await materializeLegacyProjectAgentTemplate({
      project: submittedProject,
      ownerId: String(row.expert_id ?? "") || me.userUUID,
      supabase,
    });
    const serialized = serializeOrchestrationProject(
      ensureDaemonConversationProject(materializedProject),
      { titleFallback: row.config_name ?? "Agent-0" }
    );
    const now = new Date().toISOString();

    const { error: updateError } = await supabase
      .from(GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE)
      .update({
        endpoint: `/demo/${slug}`,
        agent_id: serialized.agentId,
        config_name: serialized.configName || row.config_name || "Agent-0",
        route_slug: slug,
        setup_summary: serialized.summary,
        policy_intent: serialized.policyIntent,
        workspace_status: "Published",
        state_schema: serialized.stateSchema,
        state_update_prompt: serialized.stateUpdatePrompt,
        policy_prompt: serialized.policyPrompt,
        guideline_blocks: serialized.guidelineBlocks,
        datasets: serialized.datasets,
        shared_datasets: serialized.sharedDatasets,
        interaction_protocol: serialized.interactionProtocol,
        skills: serialized.skills,
        agent_bindings: serialized.agentBindings,
        agent_connections: serialized.agentConnections,
        environment_players: serialized.environmentPlayers,
        uploaded_files: serialized.uploadedFiles,
        updated_at: now,
      })
      .eq("id", row.id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    await Promise.all([
      replaceCanvasRows(
        supabase,
        "policy_canvases",
        row.id,
        serialized.policyCanvases
      ),
      replaceCanvasRows(
        supabase,
        "state_policy_canvases",
        row.id,
        serialized.statePolicyCanvases
      ),
    ]);
    await saveExecutionPlan(supabase, row.id, buildExecutionPlan(serialized.project));

    return NextResponse.json({
      id: row.id,
      title: serialized.configName || row.config_name || "Agent-0",
      project: serialized.project,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save demo setup.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
