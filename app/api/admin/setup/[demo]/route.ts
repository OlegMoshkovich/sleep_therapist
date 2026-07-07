import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { resolveCurrentUser } from "../../../../lib/admin-auth";
import {
  type HybridExecutionPlan,
  type RuntimeStateField,
} from "../../../../lib/canvas-hybrid-runtime";
import { buildStructuralExecutionPlan } from "../../../../lib/canvas-structural-planner";
import { createSupabaseAdminClient } from "../../../../lib/supabase-admin";
import { DEMO_SETUP, isDemoKey } from "../../../../lib/demo-config";
import type { CanvasDoc, CanvasEntry } from "../../../../components/canvas/types";
import {
  classifyDaemonProjectActionNodes,
  daemonProjectNeedsActionClassification,
  normalizeDaemonProjectActionNodes,
} from "../../../../lib/general-orchestration-daemon-action-classifier";
import {
  hydrateDaemonRuntimeProject,
  serializeDaemonRuntimeProject,
  type GeneralOrchestrationDaemonCanvasRow,
  type GeneralOrchestrationDaemonConfigRow,
} from "../../../../lib/general-orchestration-daemon-config";
import { refreshDerivedCanvasRuleRegistry } from "../../../../lib/canvas-rule-registry-extraction";
import { resolveOptionalOpenAiApiKey } from "../../../../lib/openai-config";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ demo: string }>;
}

type CanvasTable =
  | "workflow_canvases"
  | "policy_canvases"
  | "state_policy_canvases";

interface StateSchemaField {
  field_name?: string;
  type?: RuntimeStateField["type"];
  initial_value?: string | null;
}

const BASE_CONFIG_SELECT =
  "id, created_at, updated_at, config_name, state_schema, state_update_prompt, policy_prompt, guideline_blocks, uploaded_files, typical_user_patterns, edge_cases_to_cover";
const CONFIG_SELECT_WITH_DATASETS = `${BASE_CONFIG_SELECT}, datasets`;
const CONFIG_SELECT_WITH_ENVIRONMENT_PLAYERS = `${BASE_CONFIG_SELECT}, environment_players`;
const CONFIG_SELECT_WITH_OPTIONAL_FIELDS = `${BASE_CONFIG_SELECT}, datasets, environment_players`;
interface UploadedFileMeta {
  path?: string;
  bucket?: string;
}

interface ConfigShape {
  uploaded_files?: unknown;
  environment_players?: unknown;
}

/**
 * Walks both top-level `uploaded_files` and any nested
 * `environment_players[i].uploaded_files` arrays and returns a map of every
 * storage path to the bucket it lives in. Used to diff the previously-saved
 * config against the incoming one so orphaned objects can be removed from
 * storage at save time (the client-side delete can silently fail or be
 * skipped — e.g. when an env-player is removed wholesale).
 */
function collectFilePaths(
  config: ConfigShape | null | undefined,
  fallbackBucket: string
): Map<string, string> {
  const result = new Map<string, string>();
  if (!config) return result;

  const push = (f: UploadedFileMeta | null | undefined) => {
    if (!f || typeof f !== "object") return;
    const path = typeof f.path === "string" ? f.path : "";
    if (!path) return;
    const bucket = typeof f.bucket === "string" && f.bucket ? f.bucket : fallbackBucket;
    result.set(path, bucket);
  };

  const top = Array.isArray(config.uploaded_files) ? config.uploaded_files : [];
  for (const f of top) push(f as UploadedFileMeta);

  const players = Array.isArray(config.environment_players)
    ? config.environment_players
    : [];
  for (const player of players) {
    if (!player || typeof player !== "object") continue;
    const pf = (player as { uploaded_files?: unknown }).uploaded_files;
    const list = Array.isArray(pf) ? pf : [];
    for (const f of list) push(f as UploadedFileMeta);
  }

  return result;
}

async function deleteOrphanStorageObjects(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  fallbackBucket: string,
  existingConfig: ConfigShape,
  incomingConfig: ConfigShape
) {
  const oldPaths = collectFilePaths(existingConfig, fallbackBucket);
  const newPaths = collectFilePaths(incomingConfig, fallbackBucket);

  const orphansByBucket = new Map<string, string[]>();
  for (const [path, bucket] of oldPaths) {
    if (newPaths.has(path)) continue;
    const list = orphansByBucket.get(bucket) ?? [];
    list.push(path);
    orphansByBucket.set(bucket, list);
  }

  for (const [bucket, paths] of orphansByBucket) {
    if (paths.length === 0) continue;
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) {
      console.error(
        `[api/admin/setup PUT] storage cleanup failed for bucket ${bucket}:`,
        error.message
      );
    }
  }
}

function formatProvisioningError(demo: string, message: string) {
  if (message.includes("datasets")) {
    return "Dataset storage is not provisioned yet. Run `supabase/migrations/20260514_setup_datasets.sql` in the Supabase SQL editor, then refresh.";
  }
  if (message.includes("environment_players")) {
    return "Environment Player storage is not provisioned yet. Apply the latest Supabase migrations (for example `supabase db push`), then refresh.";
  }
  if (
    demo === "research-assistant" &&
    (message.includes("research_assistant_inputs") || message.includes("research-assistant-input-files"))
  ) {
    return "Research Assistant Supabase resources are not provisioned yet. Run `supabase/migrations/20260527203000_research_assistant_setup.sql` in the Supabase SQL editor, then refresh.";
  }
  if (
    demo === "general-orchestration-daemon" &&
    (message.includes("general_orchestration_daemon_inputs") ||
      message.includes("general-orchestration-daemon-input-files"))
  ) {
    return "General Orchestration Daemon Supabase resources are not provisioned yet. Run `supabase/migrations/20260524_general_orchestration_daemon_setup.sql` in the Supabase SQL editor, then refresh.";
  }
  return message;
}

function normalizeStateSchemaForPlanner(raw: unknown): RuntimeStateField[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => {
      const field = entry as StateSchemaField;
      const fieldName = typeof field.field_name === "string" ? field.field_name.trim() : "";
      if (!fieldName) {
        return null;
      }

      const type =
        field.type === "string" ||
        field.type === "integer" ||
        field.type === "boolean" ||
        field.type === "string[]" ||
        field.type === "number" ||
        field.type === "json"
          ? field.type
          : "string";

      return {
        fieldName,
        type,
        initialValue: field.initial_value === null ? "null" : String(field.initial_value ?? ""),
      };
    })
    .filter((field): field is RuntimeStateField => field !== null);
}

function buildCanvasDocFromRows(
  rows: Array<{
    canvas_id?: string;
    name?: string;
    sort_order?: number | null;
    canvas?: unknown;
  }>
): CanvasDoc | null {
  if (rows.length === 0) {
    return null;
  }

  const canvases = [...rows]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .flatMap((row) => {
      if (!row.canvas || typeof row.canvas !== "object") {
        return [];
      }

      const canvas = row.canvas as CanvasEntry;
      return [
        {
          ...canvas,
          id: row.canvas_id || canvas.id,
          name: row.name || canvas.name,
        },
      ];
    });

  if (canvases.length === 0) {
    return null;
  }

  return {
    version: 2,
    activeId: canvases[0].id,
    canvases,
  };
}

interface SetupCanvasRow {
  canvas_id?: string;
  name?: string;
  sort_order?: number | null;
  canvas?: unknown;
}

async function normalizeGeneralOrchestrationDaemonSetup(args: {
  config: Record<string, unknown> | null;
  workflowCanvases: SetupCanvasRow[];
  policyCanvases: SetupCanvasRow[];
  statePolicyCanvases: SetupCanvasRow[];
}, options: {
  deriveRuleRegistry?: boolean;
} = {}): Promise<{
  config: Record<string, unknown>;
  workflowCanvases: SetupCanvasRow[];
  policyCanvases: SetupCanvasRow[];
  statePolicyCanvases: SetupCanvasRow[];
}> {
  let project = hydrateDaemonRuntimeProject(
    {
      config:
        (args.config as GeneralOrchestrationDaemonConfigRow | null) ?? null,
      workflowCanvases:
        args.workflowCanvases as GeneralOrchestrationDaemonCanvasRow[],
      policyCanvases: args.policyCanvases as GeneralOrchestrationDaemonCanvasRow[],
      statePolicyCanvases:
        args.statePolicyCanvases as GeneralOrchestrationDaemonCanvasRow[],
    },
    {
      syncPrompts: false,
    }
  );
  project = normalizeDaemonProjectActionNodes(project);

  const apiKey = resolveOptionalOpenAiApiKey();
  const openai = apiKey ? new OpenAI({ apiKey }) : null;
  if (openai && daemonProjectNeedsActionClassification(project)) {
    try {
      project = await classifyDaemonProjectActionNodes({
        openai,
        project,
      });
    } catch (error) {
      console.error(
        "[admin/setup] daemon action classification failed",
        error
      );
    }
  }

  if (options.deriveRuleRegistry) {
    if (!openai) {
      throw new Error(
        "Cannot update daemon rule_registry because neither AIRLAB_OPENAI_API_KEY nor OPENAI_API_KEY is configured."
      );
    }
    project = await refreshDerivedCanvasRuleRegistry({
      openai,
      project,
    });
  }

  const serialized = serializeDaemonRuntimeProject(project);
  return {
    config: serialized.config,
    workflowCanvases: serialized.workflowCanvases as SetupCanvasRow[],
    policyCanvases: serialized.policyCanvases as SetupCanvasRow[],
    statePolicyCanvases: serialized.statePolicyCanvases as SetupCanvasRow[],
  };
}

async function generateExecutionPlanAtSetupTime(args: {
  stateSchema: RuntimeStateField[];
  stateUpdatePrompt: string;
  policyExecutionPrompt: string;
  stateCanvasDoc: CanvasDoc | null;
  policyCanvasDoc: CanvasDoc | null;
}): Promise<HybridExecutionPlan> {
  return normalizeExecutionPlanForRuntime(
    buildStructuralExecutionPlan({
      stateSchema: args.stateSchema,
      stateCanvasDoc: args.stateCanvasDoc,
      policyCanvasDoc: args.policyCanvasDoc,
    })
  );
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
    (step) => step.type === "code" || step.type === "tool_call" || step.type === "end"
  );
}

function normalizeExecutionPlanForRuntime(plan: HybridExecutionPlan): HybridExecutionPlan {
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

async function saveExecutionPlan(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  setupTable: string,
  setupId: string,
  executionPlan: HybridExecutionPlan
) {
  const { error } = await supabase
    .from("canvas_execution_plans")
    .upsert(
      {
        setup_table: setupTable,
        setup_id: setupId,
        execution_plan: executionPlan,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "setup_table,setup_id" }
    );

  if (error) {
    throw error;
  }
}

async function authorize(demoParam: string, opts?: { write?: boolean }) {
  if (!isDemoKey(demoParam)) {
    return { error: NextResponse.json({ error: "Unknown demo" }, { status: 404 }) };
  }
  const demo = demoParam;
  const me = await resolveCurrentUser();
  if (!me) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  // Reads are open to any signed-in user — the model setup (Knowledge / State /
  // Policy, Observability) is viewable, but read-only, for regular users.
  // Writes require admin or the demo's expert.
  if (opts?.write) {
    const allowed = me.isAdmin || me.expertDemos.includes(demo);
    if (!allowed) {
      return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
  }
  return { demo, me };
}

function isMissingEnvironmentPlayersColumn(message: string) {
  return message.includes("environment_players");
}

function isMissingDatasetsColumn(message: string) {
  return message.includes("datasets");
}

function isMissingOptionalSetupColumn(message: string) {
  return isMissingEnvironmentPlayersColumn(message) || isMissingDatasetsColumn(message);
}

function collectMissingOptionalFields(message: string) {
  const fields: Array<"datasets" | "environment_players"> = [];
  if (isMissingDatasetsColumn(message)) {
    fields.push("datasets");
  }
  if (isMissingEnvironmentPlayersColumn(message)) {
    fields.push("environment_players");
  }
  return fields;
}

async function fetchConfigRow(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  setupTable: string,
  endpoint: string
) {
  const missingOptionalFields = new Set<"datasets" | "environment_players">();
  const attempts = [
    { select: CONFIG_SELECT_WITH_OPTIONAL_FIELDS, defaults: {} },
    { select: CONFIG_SELECT_WITH_ENVIRONMENT_PLAYERS, defaults: { datasets: [] } },
    { select: CONFIG_SELECT_WITH_DATASETS, defaults: { environment_players: [] } },
    { select: BASE_CONFIG_SELECT, defaults: { datasets: [], environment_players: [] } },
  ] as const;

  for (const attempt of attempts) {
    const result = await supabase
      .from(setupTable)
      .select(attempt.select)
      .eq("endpoint", endpoint)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!result.error) {
      const config =
        result.data && typeof result.data === "object"
          ? { ...(result.data as Record<string, unknown>), ...attempt.defaults }
          : result.data;
      return { data: config, error: null, missingOptionalFields: [...missingOptionalFields] };
    }

    collectMissingOptionalFields(result.error.message).forEach((field) => {
      missingOptionalFields.add(field);
    });

    if (!isMissingOptionalSetupColumn(result.error.message)) {
      return { ...result, missingOptionalFields: [...missingOptionalFields] };
    }
  }

  return { data: null, error: null, missingOptionalFields: [...missingOptionalFields] };
}

function getRetryPayloadForMissingOptionalFields(
  message: string,
  payload: Record<string, unknown>
) {
  const retryPayload = { ...payload };
  let changed = false;

  if (
    isMissingEnvironmentPlayersColumn(message) &&
    Array.isArray(payload.environment_players) &&
    payload.environment_players.length === 0
  ) {
    delete retryPayload.environment_players;
    changed = true;
  }

  if (
    isMissingDatasetsColumn(message) &&
    Array.isArray(payload.datasets) &&
    payload.datasets.length === 0
  ) {
    delete retryPayload.datasets;
    changed = true;
  }

  return changed ? retryPayload : null;
}

async function fetchCanvases(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  table: CanvasTable,
  setupTable: string,
  setupId: string,
  opts: { ignoreMissingTable?: boolean } = {}
): Promise<unknown[]> {
  const { data, error } = await supabase
    .from(table)
    .select("canvas_id, name, sort_order, canvas")
    .eq("setup_table", setupTable)
    .eq("setup_id", setupId)
    .order("sort_order", { ascending: true });
  if (error) {
    if (opts.ignoreMissingTable) return [];
    throw new Error(error.message);
  }
  return data ?? [];
}

export async function GET(_request: NextRequest, ctx: RouteContext) {
  const { demo: demoParam } = await ctx.params;
  const auth = await authorize(demoParam);
  if (auth.error) return auth.error;
  const { demo } = auth;
  const cfg = DEMO_SETUP[demo];

  const supabase = createSupabaseAdminClient();
  const {
    data: config,
    error,
    missingOptionalFields,
  } = await fetchConfigRow(supabase, cfg.setupTable, cfg.endpoint);
  const configRow =
    config && typeof config === "object"
      ? (config as { id?: string } & Record<string, unknown>)
      : null;

  if (error) {
    return NextResponse.json({ error: formatProvisioningError(demo, error.message) }, { status: 500 });
  }

  let workflowCanvases: unknown[] = [];
  let policyCanvases: unknown[] = [];
  let statePolicyCanvases: unknown[] = [];

  if (configRow?.id) {
    try {
      workflowCanvases = await fetchCanvases(
        supabase,
        "workflow_canvases",
        cfg.setupTable,
        configRow.id,
        { ignoreMissingTable: true }
      );
      policyCanvases = await fetchCanvases(supabase, "policy_canvases", cfg.setupTable, configRow.id);
    } catch (err) {
      return NextResponse.json(
        { error: formatProvisioningError(demo, (err as Error).message) },
        { status: 500 }
      );
    }
    statePolicyCanvases = await fetchCanvases(
      supabase,
      "state_policy_canvases",
      cfg.setupTable,
      configRow.id,
      { ignoreMissingTable: true }
    );
  }

  if (demo === "general-orchestration-daemon") {
    const normalized = await normalizeGeneralOrchestrationDaemonSetup({
      config: (configRow as Record<string, unknown> | null) ?? null,
      workflowCanvases: workflowCanvases as SetupCanvasRow[],
      policyCanvases: policyCanvases as SetupCanvasRow[],
      statePolicyCanvases: statePolicyCanvases as SetupCanvasRow[],
    });

    return NextResponse.json({
      config: configRow?.id
        ? {
            ...normalized.config,
            id: configRow.id,
          }
        : null,
      workflowCanvases: normalized.workflowCanvases,
      policyCanvases: normalized.policyCanvases,
      statePolicyCanvases: normalized.statePolicyCanvases,
      missingOptionalFields,
    });
  }

  return NextResponse.json({
    config: configRow,
    workflowCanvases,
    policyCanvases,
    statePolicyCanvases,
    missingOptionalFields,
  });
}

export async function PUT(request: NextRequest, ctx: RouteContext) {
  const { demo: demoParam } = await ctx.params;
  const auth = await authorize(demoParam, { write: true });
  if (auth.error) return auth.error;
  const { demo, me } = auth;
  const cfg = DEMO_SETUP[demo];

  const body = (await request.json().catch(() => ({}))) as {
    config?: Record<string, unknown>;
    workflowCanvases?: SetupCanvasRow[];
    policyCanvases?: SetupCanvasRow[];
    statePolicyCanvases?: SetupCanvasRow[];
  };

  if (!body.config) {
    return NextResponse.json({ error: "Missing config" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  let incomingConfig = body.config;
  let workflowCanvasRows = body.workflowCanvases ?? [];
  let policyCanvasRows = body.policyCanvases ?? [];
  let statePolicyCanvasRows = body.statePolicyCanvases ?? [];

  if (demo === "general-orchestration-daemon") {
    let normalized: Awaited<
      ReturnType<typeof normalizeGeneralOrchestrationDaemonSetup>
    >;
    try {
      normalized = await normalizeGeneralOrchestrationDaemonSetup(
        {
          config: incomingConfig,
          workflowCanvases: workflowCanvasRows,
          policyCanvases: policyCanvasRows,
          statePolicyCanvases: statePolicyCanvasRows,
        },
        {
          deriveRuleRegistry: true,
        }
      );
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to update daemon rule_registry from the policy canvas.",
        },
        { status: 500 }
      );
    }
    incomingConfig = normalized.config;
    workflowCanvasRows = normalized.workflowCanvases;
    policyCanvasRows = normalized.policyCanvases;
    statePolicyCanvasRows = normalized.statePolicyCanvases;
  }

  const payload: Record<string, unknown> = {
    ...incomingConfig,
    endpoint: cfg.endpoint,
    expert_id: me.userUUID,
    updated_at: new Date().toISOString(),
  };

  // Pull the existing uploaded_files + environment_players alongside the id so
  // we can diff against incomingConfig and delete orphan storage objects.
  // Stored as JSONB; cast through unknown to avoid bringing in Supabase types.
  const { data: existing, error: lookupError } = await supabase
    .from(cfg.setupTable)
    .select("id, uploaded_files, environment_players")
    .eq("endpoint", cfg.endpoint)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupError) {
    return NextResponse.json({ error: formatProvisioningError(demo, lookupError.message) }, { status: 500 });
  }

  // Storage cleanup runs before the DB update so a successful PUT never leaves
  // orphan objects behind. Failures are logged but don't block the update —
  // it's better to land the DB change than to refuse the save because the
  // bucket complained.
  if (existing) {
    await deleteOrphanStorageObjects(supabase, cfg.filesBucket, existing, incomingConfig);
  }

  let setupId: string;
  if (existing?.id) {
    setupId = existing.id;
    let { error: updateError } = await supabase
      .from(cfg.setupTable)
      .update(payload)
      .eq("id", existing.id);
    const retryPayload = updateError
      ? getRetryPayloadForMissingOptionalFields(updateError.message, payload)
      : null;
    if (updateError && retryPayload) {
      ({ error: updateError } = await supabase
        .from(cfg.setupTable)
        .update(retryPayload)
        .eq("id", existing.id));
    }
    if (updateError) {
      return NextResponse.json({ error: formatProvisioningError(demo, updateError.message) }, { status: 500 });
    }
  } else {
    let { data: inserted, error: insertError } = await supabase
      .from(cfg.setupTable)
      .insert(payload)
      .select("id")
      .single();
    const retryPayload = insertError
      ? getRetryPayloadForMissingOptionalFields(insertError.message, payload)
      : null;
    if (insertError && retryPayload) {
      ({ data: inserted, error: insertError } = await supabase
        .from(cfg.setupTable)
        .insert(retryPayload)
        .select("id")
        .single());
    }
    if (insertError) {
      return NextResponse.json({ error: formatProvisioningError(demo, insertError.message) }, { status: 500 });
    }
    setupId = inserted!.id as string;
  }

  try {
    if (body.workflowCanvases !== undefined || demo === "general-orchestration-daemon") {
      await replaceCanvases(
        supabase,
        "workflow_canvases",
        cfg.setupTable,
        setupId,
        workflowCanvasRows,
        { ignoreMissingTable: true }
      );
    }

    await replaceCanvases(supabase, "policy_canvases", cfg.setupTable, setupId, policyCanvasRows);

    if (body.statePolicyCanvases !== undefined) {
      await replaceCanvases(
        supabase,
        "state_policy_canvases",
        cfg.setupTable,
        setupId,
        statePolicyCanvasRows,
        { ignoreMissingTable: true }
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: formatProvisioningError(demo, (err as Error).message) },
      { status: 500 }
    );
  }

  let executionPlanSaved = false;
  let executionPlanError: string | undefined;

  try {
    const executionPlan = await generateExecutionPlanAtSetupTime({
      stateSchema: normalizeStateSchemaForPlanner(incomingConfig.state_schema),
      stateUpdatePrompt:
        typeof incomingConfig.state_update_prompt === "string" ? incomingConfig.state_update_prompt : "",
      policyExecutionPrompt:
        typeof incomingConfig.policy_prompt === "string" ? incomingConfig.policy_prompt : "",
      stateCanvasDoc: buildCanvasDocFromRows(statePolicyCanvasRows),
      policyCanvasDoc: buildCanvasDocFromRows(policyCanvasRows),
    });

    await saveExecutionPlan(supabase, cfg.setupTable, setupId, executionPlan);
    executionPlanSaved = true;
  } catch (err) {
    executionPlanError = err instanceof Error ? err.message : "Unknown execution-plan error";
    console.error("[admin/setup] execution plan generation failed", {
      demo,
      setupTable: cfg.setupTable,
      setupId,
      error: executionPlanError,
    });
  }

  return NextResponse.json({
    id: setupId,
    executionPlanSaved,
    executionPlanError,
    config:
      demo === "general-orchestration-daemon"
        ? {
            ...incomingConfig,
            id: setupId,
          }
        : undefined,
    workflowCanvases:
      demo === "general-orchestration-daemon" ? workflowCanvasRows : undefined,
    policyCanvases:
      demo === "general-orchestration-daemon" ? policyCanvasRows : undefined,
    statePolicyCanvases:
      demo === "general-orchestration-daemon" ? statePolicyCanvasRows : undefined,
  });
}

async function replaceCanvases(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  table: CanvasTable,
  setupTable: string,
  setupId: string,
  rows: Array<{
    canvas_id?: string;
    name?: string;
    sort_order?: number | null;
    canvas?: unknown;
  }>,
  opts: { ignoreMissingTable?: boolean } = {}
) {
  const { error: deleteError } = await supabase
    .from(table)
    .delete()
    .eq("setup_table", setupTable)
    .eq("setup_id", setupId);
  if (deleteError) {
    if (opts.ignoreMissingTable) return;
    throw new Error(deleteError.message);
  }
  const canvasRows = rows.map((row, index) => ({
    setup_table: setupTable,
    setup_id: setupId,
    canvas_id: row.canvas_id,
    name: row.name,
    sort_order: row.sort_order ?? index,
    canvas: row.canvas,
  }));
  if (canvasRows.length > 0) {
    const { error: upsertError } = await supabase
      .from(table)
      .upsert(canvasRows, { onConflict: "setup_table,setup_id,canvas_id" });
    if (upsertError && !opts.ignoreMissingTable) {
      throw new Error(upsertError.message);
    }
  }
}
