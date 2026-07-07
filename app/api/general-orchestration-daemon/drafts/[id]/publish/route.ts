import { NextRequest, NextResponse } from "next/server";

import {
  type HybridExecutionPlan,
  type RuntimeStateField,
} from "../../../../../lib/canvas-hybrid-runtime";
import { buildStructuralExecutionPlan } from "../../../../../lib/canvas-structural-planner";
import {
  ensureDaemonConversationProject,
} from "../../../../../lib/general-orchestration-daemon-drafts";
import {
  GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE,
  buildPublishedDaemonDemoSummary,
  type PublishedDaemonDemoRow,
} from "../../../../../lib/general-orchestration-daemon-published-demos";
import {
  loadDaemonDraft,
} from "../../../../../lib/general-orchestration-daemon-draft-store";
import {
  slugify,
  type OrchestrationProject,
} from "../../../../../lib/general-orchestration";
import {
  serializeOrchestrationProject,
  type StoredOrchestrationCanvasRow,
} from "../../../../../lib/orchestration-project-storage";
import { materializeLegacyProjectAgentTemplate } from "../../../../../lib/project-agent-template-materialization";
import { getRequestUserUUID } from "../../../../../lib/admin-auth";
import { createSupabaseAdminClient } from "../../../../../lib/supabase-admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PublishBody {
  project?: unknown;
}

type SupabaseClient = ReturnType<typeof createSupabaseAdminClient>;
type CanvasTable = "policy_canvases" | "state_policy_canvases";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function readSubmittedProject(body: PublishBody): OrchestrationProject | null {
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

function normalizePublishSlug(value: string): string {
  return slugify(value || "agent-0") || "agent-0";
}

async function resolvePublishTarget(args: {
  supabase: SupabaseClient;
  desiredSlug: string;
}): Promise<{ routeSlug: string; copyIndex: number }> {
  const baseSlug = normalizePublishSlug(args.desiredSlug);

  for (let index = 0; index < 50; index += 1) {
    const routeSlug = index === 0 ? baseSlug : `${baseSlug}-agent-0-${index}`;
    const { data: conflicts, error: conflictError } = await args.supabase
      .from(GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE)
      .select("id")
      .eq("endpoint", `/demo/${routeSlug}`)
      .limit(1);

    if (conflictError) {
      throw new Error(conflictError.message);
    }

    if ((conflicts ?? []).length === 0) {
      return { routeSlug, copyIndex: index };
    }
  }

  throw new Error("Could not find an available route slug for this demo.");
}

function formatPublishedConfigName(baseName: string, copyIndex: number) {
  const normalized = baseName.trim() || "Agent-0";
  return copyIndex === 0 ? normalized : `${normalized} - Agent-0-${copyIndex}`;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const userUUID = await getRequestUserUUID();
    if (!userUUID) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: draftId } = await ctx.params;
    const supabase = createSupabaseAdminClient();
    const body = (await request.json().catch(() => ({}))) as PublishBody;
    const submittedProject = readSubmittedProject(body);
    const draft = isUuid(draftId)
      ? await loadDaemonDraft(supabase, userUUID, draftId).catch(() => null)
      : null;
    const project = submittedProject ?? draft?.project ?? null;

    if (!project) {
      return NextResponse.json(
        { error: "Publish request did not include a target demo draft." },
        { status: 400 }
      );
    }

    const materializedProject = await materializeLegacyProjectAgentTemplate({
      project,
      ownerId: userUUID,
      supabase,
    });
    const serialized = serializeOrchestrationProject(
      ensureDaemonConversationProject(materializedProject),
      { titleFallback: "Agent-0" }
    );
    const { routeSlug, copyIndex } = await resolvePublishTarget({
      supabase,
      desiredSlug: serialized.routeSlug || serialized.configName || "agent-0",
    });
    const now = new Date().toISOString();
    const endpoint = `/demo/${routeSlug}`;
    const configName = formatPublishedConfigName(
      serialized.configName || "Agent-0",
      copyIndex
    );
    const payload = {
      expert_id: userUUID,
      endpoint,
      agent_id: serialized.agentId,
      config_name: configName,
      route_slug: routeSlug,
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
    };

    const { data: inserted, error: insertError } = await supabase
      .from(GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE)
      .insert(payload)
      .select("id")
      .single();

    if (insertError || !inserted) {
      throw new Error(insertError?.message ?? "Failed to publish demo.");
    }

    const setupId = String((inserted as { id?: unknown }).id);

    await Promise.all([
      replaceCanvasRows(
        supabase,
        "policy_canvases",
        setupId,
        serialized.policyCanvases
      ),
      replaceCanvasRows(
        supabase,
        "state_policy_canvases",
        setupId,
        serialized.statePolicyCanvases
      ),
    ]);
    await saveExecutionPlan(supabase, setupId, buildExecutionPlan(serialized.project));

    const demo = buildPublishedDaemonDemoSummary({
      id: setupId,
      endpoint,
      config_name: payload.config_name,
      route_slug: routeSlug,
      setup_summary: payload.setup_summary,
      workspace_status: payload.workspace_status,
      updated_at: now,
    } satisfies PublishedDaemonDemoRow);

    return NextResponse.json({ demo });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to publish demo.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
