import OpenAI from "openai";
import {
  type HybridExecutionPlan,
} from "@airlab/canvas-planner/canvas-hybrid-runtime";
import { buildStructuralExecutionPlan } from "@airlab/canvas-planner/canvas-structural-planner";
import type { OrchestrationField } from "@airlab/orchestration-core/general-orchestration";
import {
  classifyDaemonProjectActionNodes,
  daemonProjectNeedsActionClassification,
  normalizeDaemonProjectActionNodes,
} from "./general-orchestration-daemon-action-classifier";
import {
  GENERAL_ORCHESTRATION_DAEMON_ENDPOINT,
  GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE,
  hydrateDaemonRuntimeProject,
  resolveDaemonWorkflowStageId,
  scopeDaemonCanvasDocToWorkflowStage,
  type GeneralOrchestrationDaemonCanvasRow,
  type GeneralOrchestrationDaemonConfigRow,
} from "@airlab/orchestration-core/general-orchestration-daemon-config";
import {
  getSeededCanvasRuleDefinitions,
  isCanvasRuleRegistryDatasetName,
  readCanvasRuleRegistryFromDatasets,
  type CanvasRuleDefinition,
} from "@airlab/canvas-core/lib/canvas-rule-registry";
import { compileToolsByName } from "./orchestration-run-runtime";
import type { CanvasDoc, CompiledToolDef } from "@airlab/canvas-compiler/types";
import { compileCanvas } from "@airlab/canvas-compiler/compiler";
import { compileStateExtractionPrompt } from "@airlab/canvas-compiler/stateCompiler";

const DEFAULT_DAEMON_OPENING_MESSAGE_MAX_COMPLETION_TOKENS = 180;

export interface DaemonRuntimeSupabaseClient {
  from: (table: string) => any;
}

export type DaemonRuntimeSupabaseFactory = () => DaemonRuntimeSupabaseClient;
export type DaemonRuntimeOptionalOpenAiApiKeyResolver = () => string | null;

let daemonRuntimeSupabaseFactory: DaemonRuntimeSupabaseFactory | null = null;
let daemonRuntimeOpenAiModel = "";
let daemonRuntimeOpeningMessageMaxCompletionTokens =
  DEFAULT_DAEMON_OPENING_MESSAGE_MAX_COMPLETION_TOKENS;
let daemonRuntimeOptionalOpenAiApiKeyResolver:
  | DaemonRuntimeOptionalOpenAiApiKeyResolver
  | null = null;

export function registerDaemonRuntimeSupabaseFactory(
  factory: DaemonRuntimeSupabaseFactory | null
): void {
  daemonRuntimeSupabaseFactory = factory;
}

export function registerDaemonRuntimeOpenAiConfig(config: {
  model: string;
  openingMessageMaxCompletionTokens?: number;
  resolveOptionalApiKey?: DaemonRuntimeOptionalOpenAiApiKeyResolver | null;
}): void {
  daemonRuntimeOpenAiModel = config.model.trim();
  if (
    typeof config.openingMessageMaxCompletionTokens === "number" &&
    Number.isFinite(config.openingMessageMaxCompletionTokens) &&
    config.openingMessageMaxCompletionTokens > 0
  ) {
    daemonRuntimeOpeningMessageMaxCompletionTokens = Math.trunc(
      config.openingMessageMaxCompletionTokens
    );
  }
  if ("resolveOptionalApiKey" in config) {
    daemonRuntimeOptionalOpenAiApiKeyResolver =
      config.resolveOptionalApiKey ?? null;
  }
}

function createDaemonRuntimeSupabaseClient(): DaemonRuntimeSupabaseClient {
  if (!daemonRuntimeSupabaseFactory) {
    throw new Error("Daemon runtime Supabase factory is not registered.");
  }
  return daemonRuntimeSupabaseFactory();
}

function getDaemonRuntimeOpenAiModel(): string {
  if (!daemonRuntimeOpenAiModel) {
    throw new Error("Daemon runtime OpenAI model is not registered.");
  }
  return daemonRuntimeOpenAiModel;
}

function resolveDaemonRuntimeOptionalOpenAiApiKey(): string | null {
  return daemonRuntimeOptionalOpenAiApiKeyResolver?.() ?? null;
}

export interface DaemonRuntimeStateField {
  fieldName: string;
  type: OrchestrationField["type"];
  initialValue: string;
}

export interface DaemonRuntimeConfig {
  stateSchema: DaemonRuntimeStateField[];
  stateUpdateSystemPrompt: string;
  policyExecutionSystemPrompt: string;
  canvasRuleRegistry: CanvasRuleDefinition[];
  executionPlan: HybridExecutionPlan;
  stateCanvasDoc: CanvasDoc | null;
  policyCanvasDoc: CanvasDoc | null;
  /**
   * The daemon setup row id — the identity dataset/knowledge tools on the
   * daemon's own canvases read and write against (daemon-global memory).
   */
  setupId: string;
  /** Tools compiled from the daemon's own state + policy canvases. */
  toolsByName: Record<string, CompiledToolDef>;
}

export class DaemonRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonRuntimeConfigError";
  }
}

function rawDatasetsIncludeRuleRegistry(raw: unknown): boolean {
  if (!Array.isArray(raw)) {
    return false;
  }

  return raw.some((dataset) => {
    if (!dataset || typeof dataset !== "object") {
      return false;
    }
    const name = (dataset as { name?: unknown }).name;
    return typeof name === "string" && isCanvasRuleRegistryDatasetName(name);
  });
}

function mergeDaemonCanvasRuleRegistry(
  savedRules: readonly CanvasRuleDefinition[]
): CanvasRuleDefinition[] {
  const rulesById = new Map<string, CanvasRuleDefinition>();
  for (const rule of getSeededCanvasRuleDefinitions()) {
    rulesById.set(rule.id, rule);
  }
  for (const rule of savedRules) {
    rulesById.set(rule.id, rule);
  }
  return [...rulesById.values()];
}

async function fetchCanvasRows(
  supabase: DaemonRuntimeSupabaseClient,
  table: "policy_canvases" | "state_policy_canvases",
  setupId: string
): Promise<GeneralOrchestrationDaemonCanvasRow[]> {
  const { data, error } = await supabase
    .from(table)
    .select("canvas_id, name, sort_order, canvas")
    .eq("setup_table", GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE)
    .eq("setup_id", setupId)
    .order("sort_order", { ascending: true });

  if (error) {
    return [];
  }

  return (data ?? []) as GeneralOrchestrationDaemonCanvasRow[];
}

export async function loadDaemonRuntimeConfig(): Promise<DaemonRuntimeConfig> {
  const supabase = createDaemonRuntimeSupabaseClient();
  const { data, error } = await supabase
    .from(GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE)
    .select(
      "id, config_name, state_schema, state_update_prompt, policy_prompt, datasets, uploaded_files, typical_user_patterns, edge_cases_to_cover"
    )
    .eq("endpoint", GENERAL_ORCHESTRATION_DAEMON_ENDPOINT)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new DaemonRuntimeConfigError(
      `Failed to load daemon configuration: ${error.message}`
    );
  }

  if (!data) {
    throw new DaemonRuntimeConfigError(
      `General Orchestration Daemon is not configured yet. Open ${GENERAL_ORCHESTRATION_DAEMON_ENDPOINT} and save the daemon setup first.`
    );
  }

  const row = data as GeneralOrchestrationDaemonConfigRow;
  if (!rawDatasetsIncludeRuleRegistry(row.datasets)) {
    throw new DaemonRuntimeConfigError(
      "General Orchestration Daemon setup is missing the required `rule_registry` dataset. Update the daemon setup and save a rule_registry dataset before running the daemon."
    );
  }

  const policyCanvases = await fetchCanvasRows(supabase, "policy_canvases", row.id ?? "");
  const statePolicyCanvases = await fetchCanvasRows(
    supabase,
    "state_policy_canvases",
    row.id ?? ""
  );
  const apiKey = resolveDaemonRuntimeOptionalOpenAiApiKey();
  let project = hydrateDaemonRuntimeProject({
    config: row,
    policyCanvases,
    statePolicyCanvases,
  });
  project = normalizeDaemonProjectActionNodes(project);
  if (apiKey && daemonProjectNeedsActionClassification(project)) {
    try {
      project = await classifyDaemonProjectActionNodes({
        openai: new OpenAI({ apiKey }),
        project,
      });
    } catch (error) {
      console.error(
        "[general-orchestration-daemon-runtime] action classification failed",
        error
      );
    }
  }
  const executionPlan: HybridExecutionPlan = buildStructuralExecutionPlan({
    stateSchema: project.fields.map((field) => ({
      fieldName: field.name,
      type: field.type,
      initialValue: field.initialValue,
    })),
    stateCanvasDoc: project.statePolicyCanvases,
    policyCanvasDoc: project.policyCanvases,
  });

  if (!project.stateUpdatePrompt.trim()) {
    throw new DaemonRuntimeConfigError(
      "General Orchestration Daemon setup is missing `state_update_prompt`."
    );
  }

  if (!project.policyPrompt.trim()) {
    throw new DaemonRuntimeConfigError(
      "General Orchestration Daemon setup is missing `policy_prompt`."
    );
  }

  return {
    stateSchema: project.fields.map((field) => ({
      fieldName: field.name,
      type: field.type,
      initialValue: field.initialValue,
    })),
    stateUpdateSystemPrompt: project.stateUpdatePrompt,
    policyExecutionSystemPrompt: project.policyPrompt,
    canvasRuleRegistry: mergeDaemonCanvasRuleRegistry(
      readCanvasRuleRegistryFromDatasets(project.datasets)
    ),
    executionPlan,
    stateCanvasDoc: project.statePolicyCanvases,
    policyCanvasDoc: project.policyCanvases,
    setupId: row.id ?? "",
    toolsByName: compileToolsByName(
      project.statePolicyCanvases,
      project.policyCanvases
    ),
  };
}

export function scopeDaemonRuntimeConfigToWorkflowStage(
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null | undefined
): DaemonRuntimeConfig {
  const stageId = resolveDaemonWorkflowStageId(daemonState);
  const stateCanvasDoc = scopeDaemonCanvasDocToWorkflowStage({
    doc: runtimeConfig.stateCanvasDoc,
    stageId,
    participant: "primary",
    phase: "state",
  });
  const policyCanvasDoc = scopeDaemonCanvasDocToWorkflowStage({
    doc: runtimeConfig.policyCanvasDoc,
    stageId,
    participant: "primary",
    phase: "policy",
  });
  const stateSchema = runtimeConfig.stateSchema.map((field) => ({
    fieldName: field.fieldName,
    type: field.type,
    initialValue: field.initialValue,
  }));
  const stateExtractionFields = runtimeConfig.stateSchema.map((field) => ({
    name: field.fieldName,
    type: field.type,
    initialValue: field.initialValue,
  }));

  return {
    ...runtimeConfig,
    stateUpdateSystemPrompt: stateCanvasDoc
      ? compileStateExtractionPrompt(stateCanvasDoc, stateExtractionFields)
      : runtimeConfig.stateUpdateSystemPrompt,
    policyExecutionSystemPrompt: policyCanvasDoc
      ? compileCanvas(policyCanvasDoc).output.trim()
      : runtimeConfig.policyExecutionSystemPrompt,
    executionPlan: buildStructuralExecutionPlan({
      stateSchema,
      stateCanvasDoc,
      policyCanvasDoc,
    }),
    stateCanvasDoc,
    policyCanvasDoc,
    toolsByName: compileToolsByName(stateCanvasDoc, policyCanvasDoc),
  };
}

export async function generateDaemonOpeningMessage(
  openai: OpenAI,
  runtimeConfig: DaemonRuntimeConfig
): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: getDaemonRuntimeOpenAiModel(),
      max_completion_tokens: daemonRuntimeOpeningMessageMaxCompletionTokens,
      messages: [
        {
          role: "system",
          content: [
            `Configured daemon policy:\n${runtimeConfig.policyExecutionSystemPrompt.trim()}`,
            "You are writing the very first visible assistant message for a brand-new General Orchestration Daemon conversation.",
            "Keep it short, natural, and consistent with the configured behavior.",
            "Return plain text only.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        {
          role: "user",
          content: [
            "The user has not said anything yet.",
            runtimeConfig.stateSchema.length > 0
              ? `Internal state the daemon tracks:\n${runtimeConfig.stateSchema
                  .map((field) => `- ${field.fieldName} (${field.type})`)
                  .join("\n")}`
              : "",
            "Write the best opening assistant message now.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    });

    return completion.choices[0]?.message?.content?.trim() || "";
  } catch {
    return "";
  }
}
