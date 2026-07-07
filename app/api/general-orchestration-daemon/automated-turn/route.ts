import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

import {
  buildCurrentBuildSnapshot,
  hasStructuredOrchestrationProject,
  summarizeProjectForPrompt,
  type OrchestrationEnvironmentPlayer,
  type OrchestrationMessage,
  type OrchestrationProject,
} from "../../../lib/general-orchestration";
import {
  GENERAL_ORCHESTRATION_DAEMON_ENDPOINT,
  GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE,
  DAEMON_RUN_TARGET_SIMULATION_TOOL_NAME,
  hydrateDaemonRuntimeProject,
  resolveDaemonWorkflowStageId,
  scopeDaemonCanvasDocToWorkflowStage,
  type GeneralOrchestrationDaemonConfigRow,
} from "../../../lib/general-orchestration-daemon-config";
import {
  buildStructuralExecutionPlan,
} from "../../../lib/canvas-structural-planner";
import {
  type CanvasExecutionSourceNodeRef,
  type PolicyExecutionGraph,
  type PolicyStageHandoff,
  type PromptValueSnapshot,
  type RuntimeStateField,
  type StateExecutionGraph,
  type StatePromptExtractionPlan,
  type StateSnapshot,
} from "../../../lib/canvas-hybrid-runtime";
import {
  runPolicyExecutionGraphWithHandlers,
  type PolicyExecutionGraphTraceStep,
} from "../../../lib/policy-execution-graph-runtime";
import {
  runStateExecutionGraphWithHandlers,
  type StateExecutionGraphTraceStep,
} from "../../../lib/state-execution-graph-runtime";
import {
  buildEnvironmentAgentIngressPromptValues,
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
  LATEST_SIMULATION_ERROR_PROMPT_VALUE_NAME,
  LATEST_SIMULATION_TRANSCRIPT_PROMPT_VALUE_NAME,
} from "../../../lib/canvas-flow-values";
import {
  compileToolsByName,
  formatPromptValuesJson,
  normalizePromptExtractionFields,
  normalizePromptExtractionValue,
  parseStatePromptExtractionReply,
  renderPromptExtractionInstruction,
  runDirectCanvasTool,
} from "../../../lib/orchestration-run-runtime";
import { compileCanvas } from "../../../components/canvas/compiler";
import { compileStateExtractionPrompt } from "../../../components/canvas/stateCompiler";
import {
  extractFirstJsonObject,
  parseJsonObject,
} from "../../../lib/json-object-extraction";
import {
  DAEMON_ENVIRONMENT_TURN_MAX_COMPLETION_TOKENS,
  OPENAI_MODEL,
  resolveOpenAiApiKey,
} from "../../../lib/openai-config";
import { createSupabaseAdminClient } from "../../../lib/supabase-admin";

export const dynamic = "force-dynamic";
const AUTOMATED_GENERATION_COMPLETE_MARKER = "<<AUTOMATED_GENERATION_COMPLETE>>";

interface AutomatedTurnRequestBody {
  draftId?: unknown;
  targetDescription?: unknown;
  project?: unknown;
  messages?: unknown;
  daemonState?: unknown;
  environmentState?: unknown;
  latestSimulation?: unknown;
  latestSimulationError?: unknown;
}

interface DaemonEnvironmentCanvasTraceEvent {
  agent: "environment";
  phase: "state" | "policy";
  stepId: string;
  stepType: string;
  sourceNodeRefs?: CanvasExecutionSourceNodeRef[];
  toolName?: string;
  skipped?: boolean;
  stageHandoff?: PolicyStageHandoff | null;
}

function normalizeMessages(raw: unknown): OrchestrationMessage[] {
  return Array.isArray(raw)
    ? raw
        .filter(
          (message): message is OrchestrationMessage =>
            !!message &&
            typeof message === "object" &&
            ((message as OrchestrationMessage).role === "user" ||
              (message as OrchestrationMessage).role === "assistant") &&
            typeof (message as OrchestrationMessage).content === "string"
        )
        .slice(-12)
    : [];
}

function formatTranscript(messages: OrchestrationMessage[]): string {
  if (messages.length === 0) {
    return "(no daemon conversation yet)";
  }

  return messages
    .map((message) => {
      const speaker =
        message.role === "assistant"
          ? "Daemon primary agent"
          : "Daemon environment agent";
      return `${speaker}: ${message.content}`;
    })
    .join("\n\n");
}

function stripSpeakerPrefix(value: string): string {
  return value
    .replace(/^\s*(daemon\s+environment\s+agent|environment\s+agent|user)\s*:\s*/i, "")
    .trim();
}

function parseAutomatedGenerationReply(raw: string): {
  environmentMessage: string;
  complete: boolean;
} {
  const stripped = stripSpeakerPrefix(raw);
  const lines = stripped.split(/\r?\n/);
  const complete =
    lines.some((line) => line.trim() === AUTOMATED_GENERATION_COMPLETE_MARKER) ||
    stripped.includes(AUTOMATED_GENERATION_COMPLETE_MARKER);
  const environmentMessage = lines
    .filter(
      (line) =>
        line.trim() !== AUTOMATED_GENERATION_COMPLETE_MARKER
    )
    .join("\n")
    .replaceAll(AUTOMATED_GENERATION_COMPLETE_MARKER, "")
    .trim();

  return { environmentMessage, complete };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatLatestSimulationTranscript(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "";
  }

  const result = raw as {
    environmentAgentLabel?: unknown;
    simulationSettings?: {
      environmentPlayerId?: unknown;
      connectionId?: unknown;
      targetAgentId?: unknown;
      openingSpeaker?: unknown;
      turnCount?: unknown;
    };
    openingEnvironmentTurn?: {
      observation?: unknown;
      reward?: unknown;
      notes?: unknown;
    } | null;
    turns?: unknown;
    interactionTerminated?: unknown;
    terminatedBy?: unknown;
  };
  const lines: string[] = [];
  const counterpartLabel = readString(result.environmentAgentLabel);
  lines.push(
    counterpartLabel
      ? `Simulation with connected counterpart: ${counterpartLabel}`
      : "Simulation transcript"
  );

  const settings = result.simulationSettings;
  if (settings) {
    const settingParts = [
      readString(settings.connectionId)
        ? `connectionId=${readString(settings.connectionId)}`
        : "",
      readString(settings.targetAgentId)
        ? `counterpart targetAgentId=${readString(settings.targetAgentId)}`
        : "",
      readString(settings.environmentPlayerId)
        ? `environmentPlayerId=${readString(settings.environmentPlayerId)}`
        : "",
      readString(settings.openingSpeaker)
        ? `openingSpeaker=${readString(settings.openingSpeaker)}`
        : "",
      typeof settings.turnCount === "number"
        ? `turnCount=${settings.turnCount}`
        : "",
    ].filter(Boolean);
    if (settingParts.length > 0) {
      lines.push(`Settings: ${settingParts.join(", ")}`);
    }
  }

  const opening = result.openingEnvironmentTurn;
  if (opening) {
    const observation = readString(opening.observation);
    const reward = readString(opening.reward);
    const notes = readString(opening.notes);
    if (observation || reward || notes) {
      lines.push(
        [
          "Opening connected counterpart turn:",
          observation ? `Observation: ${observation}` : "",
          reward ? `Reward: ${reward}` : "",
          notes ? `Notes: ${notes}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  }

  const turns = Array.isArray(result.turns) ? result.turns : [];
  turns.forEach((rawTurn, index) => {
    if (!rawTurn || typeof rawTurn !== "object" || Array.isArray(rawTurn)) {
      return;
    }
    const turn = rawTurn as {
      turn?: unknown;
      primaryAction?: unknown;
      environmentObservation?: unknown;
      reward?: unknown;
      environmentNotes?: unknown;
    };
    const turnNumber =
      typeof turn.turn === "number" && Number.isFinite(turn.turn)
        ? turn.turn
        : index + 1;
    lines.push(
      [
        `Turn ${turnNumber}`,
        `Draft primary agent: ${readString(turn.primaryAction) || "(no action)"}`,
        `Connected counterpart: ${
          readString(turn.environmentObservation) || "(no observation)"
        }`,
        readString(turn.reward) ? `Reward: ${readString(turn.reward)}` : "",
        readString(turn.environmentNotes)
          ? `Notes: ${readString(turn.environmentNotes)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  });

  if (result.interactionTerminated === true) {
    const terminatedBy = readString(result.terminatedBy);
    lines.push(
      terminatedBy ? `Interaction terminated by ${terminatedBy}.` : "Interaction terminated."
    );
  }

  return lines.join("\n\n").trim();
}

async function runAwaitedTargetSimulation(args: {
  requestOrigin: string;
  requestCookie: string;
  requestAuthorization: string;
  project: OrchestrationProject;
  draftId: string;
}): Promise<TargetSimulationAttempt> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (args.requestCookie.trim()) {
      headers.cookie = args.requestCookie;
    }
    if (args.requestAuthorization.trim()) {
      headers.authorization = args.requestAuthorization;
    }

    const response = await fetch(
      new URL("/api/general-orchestration-daemon/simulate", args.requestOrigin),
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          project: args.project,
          draftId: args.draftId || undefined,
        }),
        cache: "no-store",
      }
    );
    const data = (await response.json().catch(() => ({}))) as {
      error?: unknown;
    };

    if (!response.ok) {
      return {
        simulation: null,
        error:
          typeof data.error === "string" && data.error.trim()
            ? data.error.trim()
            : "Failed to run target simulation.",
      };
    }

    return {
      simulation: data,
      error: "",
    };
  } catch (error) {
    return {
      simulation: null,
      error:
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Failed to run target simulation.",
    };
  }
}

interface DaemonEnvironmentAgentRuntime {
  setupId: string;
  agent: OrchestrationEnvironmentPlayer | null;
}

interface TargetSimulationAttempt {
  simulation: unknown | null;
  error: string;
}

async function loadDaemonEnvironmentAgent(): Promise<DaemonEnvironmentAgentRuntime> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from(GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE)
    .select(
      "id, config_name, state_schema, state_update_prompt, policy_prompt, datasets, environment_players, uploaded_files, typical_user_patterns, edge_cases_to_cover"
    )
    .eq("endpoint", GENERAL_ORCHESTRATION_DAEMON_ENDPOINT)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load daemon environment agent: ${error.message}`);
  }

  const project = hydrateDaemonRuntimeProject(
    {
      config: (data ?? null) as GeneralOrchestrationDaemonConfigRow | null,
      policyCanvases: [],
      statePolicyCanvases: [],
    },
    {
      syncPrompts: false,
    }
  );

  return {
    setupId:
      data && typeof data === "object" && typeof data.id === "string"
        ? data.id
        : "",
    agent: project.environmentPlayers[0] ?? null,
  };
}

function environmentAgentHasRunTargetSimulationTool(agent: OrchestrationEnvironmentPlayer | null): boolean {
  return (
    agent?.policyCanvases?.canvases.some((canvas) =>
      canvas.graph.nodes.some(
        (node) =>
          node.type === "tool_call" &&
          typeof node.data?.toolName === "string" &&
          node.data.toolName.trim() === DAEMON_RUN_TARGET_SIMULATION_TOOL_NAME
      )
    ) === true
  );
}

function buildRuntimeStateFields(
  agent: OrchestrationEnvironmentPlayer
): RuntimeStateField[] {
  return agent.fields.map((field) => ({
    fieldName: field.name,
    type: field.type,
    initialValue: field.initialValue,
  }));
}

function buildInitialStateSnapshot(fields: RuntimeStateField[]): StateSnapshot {
  return fields.reduce<StateSnapshot>((acc, field) => {
    acc[field.fieldName] = field.initialValue;
    return acc;
  }, {});
}

function normalizeEnvironmentStateSnapshot(
  raw: unknown,
  fields: RuntimeStateField[]
): StateSnapshot {
  const initialState = buildInitialStateSnapshot(fields);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return initialState;
  }

  const record = raw as Record<string, unknown>;
  return fields.reduce<StateSnapshot>((acc, field) => {
    acc[field.fieldName] = normalizeEnvironmentStateValue(
      record[field.fieldName],
      field.type,
      initialState[field.fieldName] ?? field.initialValue
    );
    return acc;
  }, {});
}

function normalizeEnvironmentStateValue(
  value: unknown,
  type: RuntimeStateField["type"],
  fallbackValue: string
): string {
  if (value === null || value === undefined) {
    return fallbackValue;
  }
  if (type === "string[]") {
    if (Array.isArray(value)) {
      return JSON.stringify(value.map((item) => String(item)));
    }
    return typeof value === "string" ? value : fallbackValue;
  }
  if (type === "json") {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (type === "boolean") {
    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }
    return typeof value === "string" ? value : fallbackValue;
  }
  if (type === "integer" || type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return typeof value === "string" ? value : fallbackValue;
  }
  return typeof value === "string" ? value : String(value);
}

function parseEnvironmentStateSnapshot(args: {
  text: string;
  fields: RuntimeStateField[];
  fallbackState: StateSnapshot;
}): StateSnapshot {
  const parsed = parseJsonObject<Record<string, unknown>>(args.text);
  return args.fields.reduce<StateSnapshot>((acc, field) => {
    acc[field.fieldName] = normalizeEnvironmentStateValue(
      parsed?.[field.fieldName],
      field.type,
      args.fallbackState[field.fieldName] ?? field.initialValue
    );
    return acc;
  }, {});
}

function buildEnvironmentContextPrompt(args: {
  targetDescription: string;
  project: OrchestrationProject;
  structuredTargetDraftExists: boolean;
  messages: OrchestrationMessage[];
  daemonState: unknown;
  latestSimulation: unknown;
  latestSimulationTranscript: string;
  latestSimulationError: string;
}): string {
  return [
    `target_agent_description:\n${args.targetDescription}`,
    `structured_target_draft_exists: ${
      args.structuredTargetDraftExists ? "true" : "false"
    }`,
    `Current target draft summary:\n${summarizeProjectForPrompt(args.project)}`,
    `Current target draft JSON snapshot:\n${JSON.stringify(
      buildCurrentBuildSnapshot(args.project),
      null,
      2
    )}`,
    args.daemonState
      ? `Current daemon primary-agent state snapshot:\n${JSON.stringify(args.daemonState, null, 2)}`
      : "",
    args.latestSimulation
      ? `Readable latest target simulation transcript:\n${args.latestSimulationTranscript}`
      : "",
    args.latestSimulation
      ? `Latest target simulation result JSON:\n${JSON.stringify(
          args.latestSimulation,
          null,
          2
        )}`
      : "",
    args.latestSimulationError
      ? `Latest target simulation attempt failed:\n${args.latestSimulationError}`
      : "",
    `Recent daemon conversation:\n${formatTranscript(args.messages)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function runEnvironmentCompletion(
  openai: OpenAI,
  systemPrompt: string | undefined,
  prompt: string
): Promise<string> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (systemPrompt?.trim()) {
    messages.push({ role: "system", content: systemPrompt.trim() });
  }
  messages.push({ role: "user", content: prompt });

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    max_completion_tokens: DAEMON_ENVIRONMENT_TURN_MAX_COMPLETION_TOKENS,
    messages,
  });

  return completion.choices[0]?.message?.content ?? "";
}

function buildEnvironmentStatePrompt(args: {
  stateSnapshot: StateSnapshot;
  contextPrompt: string;
  existingPromptValues?: PromptValueSnapshot;
  promptPlan?: StatePromptExtractionPlan;
  extractValuesOnly?: boolean;
}): string {
  const promptValues = args.existingPromptValues ?? {};
  if (args.extractValuesOnly) {
    const fields = normalizePromptExtractionFields(args.promptPlan);
    return [
      "Automated daemon environment-agent context:",
      args.contextPrompt,
      "",
      "Current environment-agent state snapshot:",
      JSON.stringify(args.stateSnapshot, null, 2),
      "",
      "Current ingress/local values (JSON):",
      formatPromptValuesJson(promptValues),
      "",
      "Extract only the intermediate values needed for deterministic environment-agent state code.",
      "Use null for values that should not be set from the current ingress/local values.",
      "",
      renderPromptExtractionInstruction(fields),
      "",
      "Extraction rules:",
      fields.length > 0
        ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
        : "- (none)",
    ].join("\n");
  }

  return [
    "Automated daemon environment-agent context:",
    args.contextPrompt,
    "",
    "Current environment-agent state snapshot:",
    JSON.stringify(args.stateSnapshot, null, 2),
    "",
    "Current ingress/local values (JSON):",
    formatPromptValuesJson(promptValues),
    "",
    "Return only the updated environment-agent state JSON object.",
  ].join("\n");
}

function parseEnvironmentDecisionExtractionReply(
  text: string,
  promptPlan: StatePromptExtractionPlan | undefined
): { output: string; promptValues: PromptValueSnapshot | null } {
  const objectText = extractFirstJsonObject(text);
  if (!objectText) {
    return {
      output: text.trim(),
      promptValues: parseStatePromptExtractionReply(text, promptPlan),
    };
  }

  try {
    const parsed = JSON.parse(objectText) as Record<string, unknown>;
    const fields = normalizePromptExtractionFields(promptPlan);
    return {
      output:
        typeof parsed.assistant_reply === "string"
          ? parsed.assistant_reply.trim()
          : text.trim(),
      promptValues:
        fields.length === 0
          ? null
          : fields.reduce<PromptValueSnapshot>((acc, field) => {
              acc[field.name] = normalizePromptExtractionValue(
                parsed[field.name],
                field.type
              );
              return acc;
            }, {}),
    };
  } catch {
    return {
      output: text.trim(),
      promptValues: parseStatePromptExtractionReply(text, promptPlan),
    };
  }
}

function buildEnvironmentPolicyPrompt(args: {
  contextPrompt: string;
  currentState: StateSnapshot;
  existingPromptValues: PromptValueSnapshot;
  currentOutput?: string;
  promptPlan?: StatePromptExtractionPlan;
  includeExtraction?: boolean;
}): string {
  const fields = normalizePromptExtractionFields(args.promptPlan);
  return [
    "Automated daemon environment-agent context:",
    args.contextPrompt,
    "",
    "Current environment-agent state snapshot:",
    JSON.stringify(args.currentState, null, 2),
    "",
    "Current ingress/local values (JSON):",
    formatPromptValuesJson(args.existingPromptValues),
    "",
    args.currentOutput
      ? `Current carried output:\n${args.currentOutput}`
      : "",
    args.includeExtraction
      ? [
          "Return a JSON object. Put the visible environment-agent message in `assistant_reply`.",
          renderPromptExtractionInstruction(fields),
          "",
          "Extraction rules:",
          fields.length > 0
            ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
            : "- (none)",
        ].join("\n")
      : "Write the next daemon-environment-agent message now. Return plain text only.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function appendEnvironmentCanvasTraceStep(
  trace: DaemonEnvironmentCanvasTraceEvent[],
  phase: "state" | "policy",
  step: StateExecutionGraphTraceStep | PolicyExecutionGraphTraceStep
): void {
  trace.push({
    agent: "environment",
    phase,
    stepId: step.stepId,
    stepType: step.stepType,
    sourceNodeRefs: step.sourceNodeRefs,
    toolName: step.toolName,
    skipped: step.skipped,
    stageHandoff:
      "stageHandoff" in step ? step.stageHandoff ?? null : undefined,
  });
}

function getDirectToolResultVariableName(
  toolName: string,
  resultVariable: string | undefined
): string {
  const normalized = resultVariable?.trim();
  return normalized && normalized.length > 0 ? normalized : toolName;
}

function formatLatestSimulationToolOutput(args: {
  latestSimulation: unknown;
  latestSimulationTranscript: string;
  latestSimulationError: string;
}): string {
  const transcript = args.latestSimulationTranscript.trim();
  if (transcript) {
    return transcript;
  }

  const error = args.latestSimulationError.trim();
  if (error) {
    return `Latest target simulation attempt failed:\n${error}`;
  }

  return args.latestSimulation
    ? JSON.stringify(args.latestSimulation, null, 2)
    : "";
}

function buildRunTargetSimulationPromptValues(args: {
  toolName: string;
  resultVariable?: string;
  latestSimulation: unknown;
  latestSimulationTranscript: string;
  latestSimulationError: string;
}): PromptValueSnapshot | null {
  const output = formatLatestSimulationToolOutput(args);
  if (!output.trim()) {
    return null;
  }

  const resultKey = getDirectToolResultVariableName(
    args.toolName,
    args.resultVariable
  );
  return {
    [resultKey]: output,
    [LATEST_SIMULATION_TRANSCRIPT_PROMPT_VALUE_NAME]:
      args.latestSimulationTranscript,
    [LATEST_SIMULATION_ERROR_PROMPT_VALUE_NAME]: args.latestSimulationError,
    latest_simulation_available: "true",
    latest_simulation_json: args.latestSimulation
      ? JSON.stringify(args.latestSimulation, null, 2)
      : "",
  };
}

function buildEnvironmentPromptValues(args: {
  contextPrompt: string;
  targetDescription: string;
  currentBuild: unknown;
  structuredTargetDraftExists: boolean;
  latestSimulation: unknown;
  latestSimulationTranscript: string;
  latestSimulationError: string;
}): PromptValueSnapshot {
  return {
    ...buildEnvironmentAgentIngressPromptValues({
      latestObservation: args.contextPrompt,
      latestReward: "",
    }),
    target_agent_description: args.targetDescription,
    structured_target_draft_exists: args.structuredTargetDraftExists,
    current_target_build: JSON.stringify(args.currentBuild, null, 2),
    [LATEST_SIMULATION_TRANSCRIPT_PROMPT_VALUE_NAME]:
      args.latestSimulationTranscript,
    [LATEST_SIMULATION_ERROR_PROMPT_VALUE_NAME]: args.latestSimulationError,
    latest_simulation_available:
      args.latestSimulation ||
      args.latestSimulationTranscript.trim() ||
      args.latestSimulationError.trim()
        ? "true"
        : "false",
    latest_simulation_json: args.latestSimulation
      ? JSON.stringify(args.latestSimulation, null, 2)
      : "",
  };
}

async function runEnvironmentAgentCanvas(args: {
  openai: OpenAI;
  runtime: DaemonEnvironmentAgentRuntime;
  requestOrigin: string;
  requestCookie: string;
  requestAuthorization: string;
  draftId: string;
  targetDescription: string;
  project: OrchestrationProject;
  messages: OrchestrationMessage[];
  daemonState: unknown;
  environmentState: unknown;
  latestSimulation: unknown;
  latestSimulationTranscript: string;
  latestSimulationError: string;
}): Promise<{
  environmentMessage: string;
  visibleEnvironmentMessage: string;
  environmentState: StateSnapshot;
  complete: boolean;
  simulationRan: boolean;
  latestSimulation: unknown | null;
  latestSimulationError: string;
  canvasTrace: DaemonEnvironmentCanvasTraceEvent[];
  stageHandoff?: PolicyStageHandoff | null;
}> {
  const { agent } = args.runtime;
  if (!agent) {
    throw new Error("Daemon environment agent is not configured.");
  }

  const stateSchema = buildRuntimeStateFields(agent);
  const daemonStateRecord =
    args.daemonState &&
    typeof args.daemonState === "object" &&
    !Array.isArray(args.daemonState)
      ? (args.daemonState as Record<string, unknown>)
      : null;
  const stageId = resolveDaemonWorkflowStageId(daemonStateRecord);
  const stateCanvasDoc = scopeDaemonCanvasDocToWorkflowStage({
    doc: agent.statePolicyCanvases,
    stageId,
    participant: "environment",
    phase: "state",
  });
  const policyCanvasDoc = scopeDaemonCanvasDocToWorkflowStage({
    doc: agent.policyCanvases,
    stageId,
    participant: "environment",
    phase: "policy",
  });
  const stateUpdatePrompt = stateCanvasDoc
    ? compileStateExtractionPrompt(
        stateCanvasDoc,
        stateSchema.map((field) => ({
          name: field.fieldName,
          type: field.type,
          initialValue: field.initialValue,
        }))
      )
    : agent.stateUpdatePrompt;
  const policyPrompt = policyCanvasDoc
    ? compileCanvas(policyCanvasDoc).output
    : agent.policyPrompt;
  const executionPlan = buildStructuralExecutionPlan({
    stateSchema,
    stateCanvasDoc,
    policyCanvasDoc,
  });
  const currentBuild = buildCurrentBuildSnapshot(args.project);
  const structuredTargetDraftExists = hasStructuredOrchestrationProject(
    args.project
  );
  const contextPrompt = buildEnvironmentContextPrompt({
    targetDescription: args.targetDescription,
    project: args.project,
    structuredTargetDraftExists,
    messages: args.messages,
    daemonState: args.daemonState,
    latestSimulation: args.latestSimulation,
    latestSimulationTranscript: args.latestSimulationTranscript,
    latestSimulationError: args.latestSimulationError,
  });
  const initialPromptValues = buildEnvironmentPromptValues({
    contextPrompt,
    targetDescription: args.targetDescription,
    currentBuild,
    structuredTargetDraftExists,
    latestSimulation: args.latestSimulation,
    latestSimulationTranscript: args.latestSimulationTranscript,
    latestSimulationError: args.latestSimulationError,
  });
  const trace: DaemonEnvironmentCanvasTraceEvent[] = [];
  const toolsByName = compileToolsByName(
    stateCanvasDoc,
    policyCanvasDoc
  );

  let environmentState = normalizeEnvironmentStateSnapshot(
    args.environmentState,
    stateSchema
  );
  let rawEnvironmentMessage = "";
  let rawVisibleEnvironmentMessage = "";
  let interactionTerminated = false;
  let stageHandoff: PolicyStageHandoff | null = null;
  const simulationAttempts: TargetSimulationAttempt[] = [];
  const runTargetSimulationTool = async (
    toolName: string,
    resultVariable?: string
  ): Promise<PromptValueSnapshot> => {
    const attempt = await runAwaitedTargetSimulation({
      requestOrigin: args.requestOrigin,
      requestCookie: args.requestCookie,
      requestAuthorization: args.requestAuthorization,
      project: args.project,
      draftId: args.draftId,
    });
    simulationAttempts.push(attempt);
    const latestSimulationTranscript = formatLatestSimulationTranscript(
      attempt.simulation
    );
    const promptValues = buildRunTargetSimulationPromptValues({
      toolName,
      resultVariable,
      latestSimulation: attempt.simulation,
      latestSimulationTranscript,
      latestSimulationError: attempt.error,
    });
    return (
      promptValues ?? {
        [getDirectToolResultVariableName(toolName, resultVariable)]:
          "Target simulation returned no result.",
        [LATEST_SIMULATION_TRANSCRIPT_PROMPT_VALUE_NAME]: "",
        [LATEST_SIMULATION_ERROR_PROMPT_VALUE_NAME]:
          "Target simulation returned no result.",
        latest_simulation_available: "true",
        latest_simulation_json: "",
      }
    );
  };
  const stateGraph = executionPlan.state.code_plan?.execution_graph;
  if (stateSchema.length > 0) {
    const runPromptStateUpdate = async (
      currentState: StateSnapshot,
      systemPrompt: string,
      existingPromptValues?: PromptValueSnapshot
    ) => {
      const reply = await runEnvironmentCompletion(
        args.openai,
        systemPrompt,
        buildEnvironmentStatePrompt({
          stateSnapshot: currentState,
          contextPrompt,
          existingPromptValues,
        })
      );
      return parseEnvironmentStateSnapshot({
        text: reply,
        fields: stateSchema,
        fallbackState: currentState,
      });
    };

    if (
      executionPlan.state.mode === "full_prompt" ||
      !stateGraph
    ) {
      environmentState = await runPromptStateUpdate(
        environmentState,
        stateUpdatePrompt,
        initialPromptValues
      );
    } else {
      try {
        const stateResult = await runStateExecutionGraphWithHandlers({
          knownState: environmentState,
          stateSchema,
          graph: stateGraph as StateExecutionGraph,
          initialPromptValues,
          runFullPromptUpdate: (currentState, existingPromptValues) =>
            runPromptStateUpdate(
              currentState,
              stateUpdatePrompt,
              existingPromptValues
            ),
          runPromptSubtreeUpdate: (currentState, subtreePrompt, existingPromptValues) =>
            runPromptStateUpdate(currentState, subtreePrompt, existingPromptValues),
          runPromptTransform: (currentState, incomingOutput, instruction, existingPromptValues) =>
            runEnvironmentCompletion(
              args.openai,
              undefined,
              [
                buildEnvironmentStatePrompt({
                  stateSnapshot: currentState,
                  contextPrompt,
                  existingPromptValues,
                }),
                "",
                "Current carried output:",
                incomingOutput || "(empty)",
                "",
                "State local-value transform instruction:",
                instruction,
                "",
                "Return only the transformed local value.",
              ].join("\n")
            ),
          runPromptExtraction: async (currentState, promptPlan, existingPromptValues) => {
            const reply = await runEnvironmentCompletion(
              args.openai,
              undefined,
              buildEnvironmentStatePrompt({
                stateSnapshot: currentState,
                contextPrompt,
                existingPromptValues,
                promptPlan,
                extractValuesOnly: true,
              })
            );
            return parseStatePromptExtractionReply(reply, promptPlan);
          },
          runDirectTool: async (toolName, resultVariable, inputContributions) => {
            const normalizedToolName = toolName.trim();
            if (normalizedToolName === DAEMON_RUN_TARGET_SIMULATION_TOOL_NAME) {
              return runTargetSimulationTool(normalizedToolName, resultVariable);
            }
            return runDirectCanvasTool({
              toolsByName,
              toolName: normalizedToolName,
              resultVariable,
              inputContributions,
              dispatchContext: {
                setupTable: GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE,
                setupId: args.runtime.setupId,
              },
            });
          },
          onStep: (step) => appendEnvironmentCanvasTraceStep(trace, "state", step),
        });
        environmentState = stateResult.nextState;
      } catch (error) {
        throw error;
      }
    }
  }

  const policyGraph = executionPlan.policy.code_plan?.execution_graph;
  const usesPolicyGraph =
    executionPlan.policy.mode !== "full_prompt" && Boolean(policyGraph);
  const systemPolicyPrompt = [
    "You are the environment agent of the General Orchestration Daemon.",
    "Follow the active daemon environment policy canvas as the behavioral source of truth.",
    "Use the supplied target_agent_description, current target draft snapshot, daemon state, latest simulation, and recent daemon conversation as inputs.",
    environmentAgentHasRunTargetSimulationTool(agent)
      ? `If execution reaches the ${DAEMON_RUN_TARGET_SIMULATION_TOOL_NAME} tool-call node, the runtime will run and await the target simulation exactly at that node, publish latest_simulation_transcript or latest_simulation_error, then continue the canvas after the tool node. Do not request simulation from prompt text.`
      : "",
    "Return only the visible message the user-side daemon environment agent would send. Do not prefix the message with a speaker name.",
    policyPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!usesPolicyGraph) {
    rawEnvironmentMessage = await runEnvironmentCompletion(
      args.openai,
      systemPolicyPrompt,
      buildEnvironmentPolicyPrompt({
        contextPrompt,
        currentState: environmentState,
        existingPromptValues: initialPromptValues,
      })
    );
    rawVisibleEnvironmentMessage = rawEnvironmentMessage;
  } else {
    try {
      const policyResult = await runPolicyExecutionGraphWithHandlers({
        updatedState: environmentState,
        stateSchema,
        graph: policyGraph as PolicyExecutionGraph,
        initialPromptValues,
        onStep: (step) => appendEnvironmentCanvasTraceStep(trace, "policy", step),
        runFullPromptDecision: (currentState, existingPromptValues) =>
          runEnvironmentCompletion(
            args.openai,
            systemPolicyPrompt,
            buildEnvironmentPolicyPrompt({
              contextPrompt,
              currentState,
              existingPromptValues,
            })
          ),
        runPromptSubtreeDecision: (
          currentState,
          subtreePrompt,
          currentOutput,
          existingPromptValues
        ) =>
          runEnvironmentCompletion(
            args.openai,
            [systemPolicyPrompt, subtreePrompt].filter(Boolean).join("\n\n"),
            buildEnvironmentPolicyPrompt({
              contextPrompt,
              currentState,
              existingPromptValues,
              currentOutput,
            })
          ),
        runPromptSubtreeDecisionWithExtraction: async (
          currentState,
          subtreePrompt,
          promptPlan,
          existingPromptValues,
          currentOutput
        ) => {
          const reply = await runEnvironmentCompletion(
            args.openai,
            [systemPolicyPrompt, subtreePrompt].filter(Boolean).join("\n\n"),
            buildEnvironmentPolicyPrompt({
              contextPrompt,
              currentState,
              existingPromptValues,
              currentOutput,
              promptPlan,
              includeExtraction: true,
            })
          );
          return parseEnvironmentDecisionExtractionReply(reply, promptPlan);
        },
        runPromptTransform: (
          currentState,
          incomingOutput,
          instruction,
          existingPromptValues
        ) =>
          runEnvironmentCompletion(
            args.openai,
            undefined,
            [
              buildEnvironmentPolicyPrompt({
                contextPrompt,
                currentState,
                existingPromptValues,
                currentOutput: incomingOutput,
              }),
              "",
              "Policy output transform instruction:",
              instruction,
              "",
              "Return only the transformed output.",
            ].join("\n")
          ),
        runPromptExtraction: async (currentState, promptPlan, existingPromptValues) => {
          const reply = await runEnvironmentCompletion(
            args.openai,
            undefined,
            buildEnvironmentPolicyPrompt({
              contextPrompt,
              currentState,
              existingPromptValues,
              currentOutput:
                typeof existingPromptValues[CARRIED_OUTPUT_PROMPT_VALUE_NAME] ===
                "string"
                  ? existingPromptValues[CARRIED_OUTPUT_PROMPT_VALUE_NAME]
                  : "",
              promptPlan,
              includeExtraction: true,
            })
          );
          return parseStatePromptExtractionReply(reply, promptPlan);
        },
        runDirectTool: async (toolName, resultVariable, inputContributions) => {
          const normalizedToolName = toolName.trim();
          if (normalizedToolName === DAEMON_RUN_TARGET_SIMULATION_TOOL_NAME) {
            return runTargetSimulationTool(normalizedToolName, resultVariable);
          }
          return runDirectCanvasTool({
            toolsByName,
            toolName: normalizedToolName,
            resultVariable,
            inputContributions,
            dispatchContext: {
              setupTable: GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE,
              setupId: args.runtime.setupId,
            },
          });
        },
      });
      rawEnvironmentMessage = policyResult.output;
      rawVisibleEnvironmentMessage =
        policyResult.visibleOutput || policyResult.output;
      environmentState = policyResult.nextState;
      interactionTerminated = policyResult.interactionTerminated;
      stageHandoff = policyResult.stageHandoff ?? null;
    } catch (error) {
      throw error;
    }
  }

  const latestSimulationAttempt =
    simulationAttempts[simulationAttempts.length - 1] ?? null;
  const parsedReply = parseAutomatedGenerationReply(rawEnvironmentMessage);
  const parsedVisibleReply = parseAutomatedGenerationReply(
    rawVisibleEnvironmentMessage || rawEnvironmentMessage
  );
  return {
    environmentMessage: parsedReply.environmentMessage,
    visibleEnvironmentMessage:
      parsedVisibleReply.environmentMessage || parsedReply.environmentMessage,
    environmentState,
    complete: interactionTerminated || (!usesPolicyGraph && parsedReply.complete),
    simulationRan: Boolean(latestSimulationAttempt),
    latestSimulation: latestSimulationAttempt?.simulation ?? null,
    latestSimulationError: latestSimulationAttempt?.error ?? "",
    canvasTrace: trace,
    stageHandoff,
  };
}

export async function POST(request: NextRequest) {
  try {
    const apiKey = resolveOpenAiApiKey();
    const body = (await request.json()) as AutomatedTurnRequestBody;
    const targetDescription =
      typeof body.targetDescription === "string"
        ? body.targetDescription.trim()
        : "";
    if (!targetDescription) {
      return NextResponse.json(
        { error: "Provide a target agent description." },
        { status: 400 }
      );
    }

    if (!body.project || typeof body.project !== "object") {
      return NextResponse.json(
        { error: "Expected `project` in the request body." },
        { status: 400 }
      );
    }

    const project = body.project as OrchestrationProject;
    const draftId = typeof body.draftId === "string" ? body.draftId.trim() : "";
    const messages = normalizeMessages(body.messages);
    const latestSimulationError =
      typeof body.latestSimulationError === "string"
        ? body.latestSimulationError.trim()
        : "";
    const readableLatestSimulationTranscript = formatLatestSimulationTranscript(
      body.latestSimulation
    );
    const daemonEnvironmentRuntime = await loadDaemonEnvironmentAgent();
    const openai = new OpenAI({ apiKey });

    const environmentResult = await runEnvironmentAgentCanvas({
      openai,
      runtime: daemonEnvironmentRuntime,
      requestOrigin: request.nextUrl.origin,
      requestCookie: request.headers.get("cookie") ?? "",
      requestAuthorization: request.headers.get("authorization") ?? "",
      draftId,
      targetDescription,
      project,
      messages,
      daemonState: body.daemonState,
      environmentState: body.environmentState,
      latestSimulation: body.latestSimulation,
      latestSimulationTranscript: readableLatestSimulationTranscript,
      latestSimulationError,
    });

    if (environmentResult.complete) {
      return NextResponse.json({
        complete: true,
        environmentMessage: environmentResult.environmentMessage || undefined,
        visibleEnvironmentMessage:
          environmentResult.visibleEnvironmentMessage || undefined,
        environmentState: environmentResult.environmentState,
        simulationRan: environmentResult.simulationRan || undefined,
        latestSimulation: environmentResult.latestSimulation || undefined,
        latestSimulationError:
          environmentResult.latestSimulationError || undefined,
        canvasTrace: environmentResult.canvasTrace,
        stageHandoff: environmentResult.stageHandoff ?? undefined,
      });
    }
    if (!environmentResult.environmentMessage) {
      throw new Error("The daemon environment agent did not return a message.");
    }

    return NextResponse.json({
      environmentMessage: environmentResult.environmentMessage,
      visibleEnvironmentMessage:
        environmentResult.visibleEnvironmentMessage || undefined,
      environmentState: environmentResult.environmentState,
      simulationRan: environmentResult.simulationRan || undefined,
      latestSimulation: environmentResult.latestSimulation || undefined,
      latestSimulationError:
        environmentResult.latestSimulationError || undefined,
      canvasTrace: environmentResult.canvasTrace,
      stageHandoff: environmentResult.stageHandoff ?? undefined,
    });
  } catch (error) {
    console.error("[general-orchestration-daemon:automated-turn]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate the daemon environment turn.",
      },
      { status: 500 }
    );
  }
}
