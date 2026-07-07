import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createSupabaseAdminClient } from "../../../lib/supabase-admin";
import {
  GENERAL_ORCHESTRATION_DAEMON_ENDPOINT,
  GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE,
  hydrateDaemonRuntimeProject,
  serializeDaemonRuntimeProject,
  type GeneralOrchestrationDaemonCanvasRow,
  type GeneralOrchestrationDaemonConfigRow,
} from "../../../lib/general-orchestration-daemon-config";
import {
  classifyDaemonProjectActionNodes,
  daemonProjectNeedsActionClassification,
  normalizeDaemonProjectActionNodes,
} from "../../../lib/general-orchestration-daemon-action-classifier";
import { resolveOptionalOpenAiApiKey } from "../../../lib/openai-config";

export const dynamic = "force-dynamic";

type MissingOptionalField = "datasets" | "environment_players";

const BASE_CONFIG_SELECT =
  "id, created_at, updated_at, config_name, state_schema, state_update_prompt, policy_prompt, guideline_blocks, uploaded_files, typical_user_patterns, edge_cases_to_cover";
const CONFIG_SELECT_WITH_DATASETS = `${BASE_CONFIG_SELECT}, datasets`;
const CONFIG_SELECT_WITH_ENVIRONMENT_PLAYERS = `${BASE_CONFIG_SELECT}, environment_players`;
const CONFIG_SELECT_WITH_OPTIONAL_FIELDS = `${BASE_CONFIG_SELECT}, datasets, environment_players`;

function formatProvisioningError(message: string) {
  if (message.includes("datasets")) {
    return "Dataset storage is not provisioned yet. Run `supabase/migrations/20260514_setup_datasets.sql` in the Supabase SQL editor, then refresh.";
  }

  if (message.includes("environment_players")) {
    return "Environment Player storage is not provisioned yet. Apply the latest Supabase migrations (for example `supabase db push`), then refresh.";
  }

  if (
    message.includes("general_orchestration_daemon_inputs") ||
    message.includes("general-orchestration-daemon-input-files")
  ) {
    return "General Orchestration Daemon Supabase resources are not provisioned yet. Run `supabase/migrations/20260524_general_orchestration_daemon_setup.sql` in the Supabase SQL editor, then refresh.";
  }

  return message;
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

function collectMissingOptionalFields(message: string): MissingOptionalField[] {
  const fields: MissingOptionalField[] = [];
  if (isMissingDatasetsColumn(message)) {
    fields.push("datasets");
  }
  if (isMissingEnvironmentPlayersColumn(message)) {
    fields.push("environment_players");
  }
  return fields;
}

async function fetchConfigRow(
  supabase: ReturnType<typeof createSupabaseAdminClient>
) {
  const missingOptionalFields = new Set<MissingOptionalField>();
  const attempts = [
    { select: CONFIG_SELECT_WITH_OPTIONAL_FIELDS, defaults: {} },
    { select: CONFIG_SELECT_WITH_ENVIRONMENT_PLAYERS, defaults: { datasets: [] } },
    { select: CONFIG_SELECT_WITH_DATASETS, defaults: { environment_players: [] } },
    { select: BASE_CONFIG_SELECT, defaults: { datasets: [], environment_players: [] } },
  ] as const;

  for (const attempt of attempts) {
    const result = await supabase
      .from(GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE)
      .select(attempt.select)
      .eq("endpoint", GENERAL_ORCHESTRATION_DAEMON_ENDPOINT)
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

  return {
    data: null,
    error: new Error("Failed to load General Orchestration Daemon setup."),
    missingOptionalFields: [...missingOptionalFields],
  };
}

async function fetchCanvases(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  table: "workflow_canvases" | "policy_canvases" | "state_policy_canvases",
  setupId: string,
  opts: { ignoreMissingTable?: boolean } = {}
): Promise<unknown[]> {
  const { data, error } = await supabase
    .from(table)
    .select("canvas_id, name, sort_order, canvas")
    .eq("setup_table", GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE)
    .eq("setup_id", setupId)
    .order("sort_order", { ascending: true });

  if (error) {
    if (opts.ignoreMissingTable) {
      return [];
    }
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function GET() {
  const supabase = createSupabaseAdminClient();
  const {
    data: config,
    error,
    missingOptionalFields,
  } = await fetchConfigRow(supabase);
  const configRow =
    config && typeof config === "object"
      ? (config as { id?: string } & Record<string, unknown>)
      : null;

  if (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load daemon setup.";
    return NextResponse.json(
      { error: formatProvisioningError(message) },
      { status: 500 }
    );
  }

  let policyCanvases: unknown[] = [];
  let workflowCanvases: unknown[] = [];
  let statePolicyCanvases: unknown[] = [];

  if (configRow?.id) {
    try {
      workflowCanvases = await fetchCanvases(
        supabase,
        "workflow_canvases",
        configRow.id,
        { ignoreMissingTable: true }
      );
      policyCanvases = await fetchCanvases(
        supabase,
        "policy_canvases",
        configRow.id
      );
      statePolicyCanvases = await fetchCanvases(
        supabase,
        "state_policy_canvases",
        configRow.id,
        { ignoreMissingTable: true }
      );
    } catch (fetchError) {
      const message =
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to load daemon canvases.";
      return NextResponse.json(
        { error: formatProvisioningError(message) },
        { status: 500 }
      );
    }
  }

  let normalizedConfig: Record<string, unknown> | null = configRow;
  let normalizedWorkflowCanvases = workflowCanvases;
  let normalizedPolicyCanvases = policyCanvases;
  let normalizedStatePolicyCanvases = statePolicyCanvases;
  let normalizedEnvironmentAgent: Record<string, unknown> | null = null;

  try {
    let project = hydrateDaemonRuntimeProject(
      {
        config: (configRow ?? null) as GeneralOrchestrationDaemonConfigRow | null,
        workflowCanvases:
          workflowCanvases as GeneralOrchestrationDaemonCanvasRow[],
        policyCanvases:
          policyCanvases as GeneralOrchestrationDaemonCanvasRow[],
        statePolicyCanvases:
          statePolicyCanvases as GeneralOrchestrationDaemonCanvasRow[],
      },
      {
        syncPrompts: false,
      }
    );
    project = normalizeDaemonProjectActionNodes(project);

    const apiKey = resolveOptionalOpenAiApiKey();
    if (apiKey && daemonProjectNeedsActionClassification(project)) {
      try {
        project = await classifyDaemonProjectActionNodes({
          openai: new OpenAI({ apiKey }),
          project,
        });
      } catch (error) {
        console.error(
          "[general-orchestration-daemon/setup] action classification failed",
          error
        );
      }
    }

    const serialized = serializeDaemonRuntimeProject(project);
    const environmentAgent = project.environmentPlayers[0] ?? null;
    normalizedEnvironmentAgent = environmentAgent
      ? {
          id: environmentAgent.id,
          fields: environmentAgent.fields,
          stateUpdatePrompt: environmentAgent.stateUpdatePrompt,
          policyPrompt: environmentAgent.policyPrompt,
          datasets: environmentAgent.datasets,
          policyCanvases: environmentAgent.policyCanvases,
          statePolicyCanvases: environmentAgent.statePolicyCanvases,
        }
      : null;
    normalizedWorkflowCanvases = serialized.workflowCanvases;
    normalizedPolicyCanvases = serialized.policyCanvases;
    normalizedStatePolicyCanvases = serialized.statePolicyCanvases;
    normalizedConfig = configRow?.id
      ? {
          ...serialized.config,
          id: configRow.id,
        }
      : null;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to normalize daemon setup.",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    config: normalizedConfig,
    workflowCanvases: normalizedWorkflowCanvases,
    policyCanvases: normalizedPolicyCanvases,
    statePolicyCanvases: normalizedStatePolicyCanvases,
    environmentAgent: normalizedEnvironmentAgent,
    missingOptionalFields,
  });
}
