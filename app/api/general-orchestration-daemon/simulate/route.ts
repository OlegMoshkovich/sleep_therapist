import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

import type { CanvasDoc } from "../../../components/canvas/types";
import {
  buildConversationMemoryActionEvent,
  buildConversationMemoryObservationEvent,
  formatConversationMemoryTurn,
} from "../../../lib/conversation-memory";
import {
  type PromptValueSnapshot,
  type CanvasExecutionSourceNodeRef,
  type StateCodeRuntimeContext,
  type StatePromptExtractionPlan,
} from "../../../lib/canvas-hybrid-runtime";
import { buildStructuralExecutionPlan } from "../../../lib/canvas-structural-planner";
import {
  findOrchestrationFieldByCanonicalName,
  getMissingInteractionFieldIssues,
  normalizeLatestInteractionStateFields,
  PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
  syncDerivedPrompts,
  type OrchestrationField,
  type OrchestrationProject,
  type OrchestrationSkill,
} from "../../../lib/general-orchestration";
import {
  buildEnvironmentAgentIngressPromptValues,
  buildPrimaryAgentIngressPromptValues,
} from "../../../lib/canvas-flow-values";
import {
  buildEnvironmentReplyJsonShape,
  buildEnvironmentReplySchemaInstruction,
  parseExplicitInteractionProtocol,
  parseExplicitSimulationSettings,
  type InteractionProtocolConfig,
} from "../../../lib/interaction-protocol";
import { extractFirstJsonObject } from "../../../lib/json-object-extraction";
import {
  resolveOpenAiApiKey,
  SIMULATION_TOKEN_BUDGETS,
} from "../../../lib/openai-config";
import {
  buildExpandSystemPromptsByKey,
  buildInitialStateSnapshot,
  buildRuntimeStateSchema,
  compileToolsByName,
  createPolicyRuntimeOperationHandler,
  formatPromptValuesJson,
  normalizeExpandKey,
  normalizePromptExtractionFields,
  normalizeStateValueForBlock,
  parsePolicyDecisionExtractionReply,
  parseStatePromptExtractionReply,
  parseStateUpdateReply,
  renderPolicyDecisionExtractionInstruction,
  renderPromptExtractionInstruction,
  renderStateJson,
  runDirectCanvasTool,
  runPrompt,
  type OrchestrationRunRuntimeConfigBase,
  type StateSnapshot,
} from "../../../lib/orchestration-run-runtime";
import {
  runPolicyExecutionGraphWithHandlers,
  type PolicyExecutionGraphTraceStep,
} from "../../../lib/policy-execution-graph-runtime";
import {
  runStateExecutionGraphWithHandlers,
  type StateExecutionGraphTraceStep,
} from "../../../lib/state-execution-graph-runtime";
import { getRequestUserUUID } from "../../../lib/admin-auth";
import { createSupabaseAdminClient } from "../../../lib/supabase-admin";
import { GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE } from "../../../lib/general-orchestration-daemon-drafts";
import { verifyDaemonDraftOwnership } from "../../../lib/general-orchestration-daemon-draft-store";
import {
  appendContextToPrompt,
  buildDatasetSchemasContext,
  compiledToolsNeedDatasetContext,
  createDatasetToolRuntime,
  createDatasetWriteCollector,
  createToolErrorCollector,
  mergeDatasetsForAgentContext,
} from "../../../lib/general-orchestration-dataset-runtime";
import type { ToolDispatchContext } from "../../../lib/tools/types";
import type { SimulationPlayerDataset } from "../../../components/setup/dataset-schema";
import {
  SKILL_CONDITION_FALSE_OUTPUT,
  SKILL_CONDITION_TRUE_OUTPUT,
  prepareSkillConditionCanvasDoc,
  skillConditionOutputIsTrue,
} from "../../../lib/orchestration-skills-runtime";
import {
  applyConnectionParticipantPolicy,
  projectAgentRuntimeToPrimaryProject,
  resolveProjectAgentRuntimes,
  type ProjectGraphRuntime,
  type ProjectAgentRuntime,
} from "../../../lib/project-agent-runtime-resolver";

interface SimulationTurn {
  turn: number;
  primaryAction: string;
  environmentObservation: string;
  reward: string;
  targetReward?: string;
  environmentNotes: string;
  primaryTrace?: RuntimeNodeTraceEvent[];
  environmentTrace?: RuntimeNodeTraceEvent[];
  interactionTerminated?: boolean;
  terminatedBy?: RuntimeNodeTraceAgent;
}

interface OpeningEnvironmentTurn {
  observation: string;
  reward: string;
  notes: string;
  trace?: RuntimeNodeTraceEvent[];
}

interface EnvironmentStructuredReply {
  observation: string;
  reward: string;
  notes: string;
}

type SimulationAgentKind = "primary" | "environment";
type RuntimeNodeTraceAgent = "primary" | "environment";
type RuntimeNodeTracePhase =
  | "state"
  | "policy"
  | "skill_start_condition"
  | "skill_termination_condition";

interface RuntimeNodeTraceEvent {
  agent: RuntimeNodeTraceAgent;
  phase: RuntimeNodeTracePhase;
  stepId: string;
  stepType: string;
  sourceNodeRefs?: CanvasExecutionSourceNodeRef[];
  toolName?: string;
  skipped?: boolean;
  interactionTerminated?: boolean;
}

function legacyEnvironmentPlayerToTargetRuntime(args: {
  player: OrchestrationProject["environmentPlayers"][number];
  index: number;
}): ProjectAgentRuntime {
  return {
    id: args.player.id,
    title: `Legacy Target Agent ${args.index + 1}`,
    roleContext:
      "Legacy embedded simulation participant converted at runtime for compatibility.",
    fields: normalizeLatestInteractionStateFields(args.player.fields),
    stateUpdatePrompt: args.player.stateUpdatePrompt,
    policyPrompt: args.player.policyPrompt,
    policyCanvases: args.player.policyCanvases,
    statePolicyCanvases: args.player.statePolicyCanvases,
    skills: args.player.skills,
    guidelines: args.player.guidelines,
    datasets: args.player.datasets,
    uploadedFiles: args.player.uploadedFiles,
    binding: null,
    templateVersion: null,
  };
}

function mapPolicyTraceStep(args: {
  agent: RuntimeNodeTraceAgent;
  phase: RuntimeNodeTracePhase;
  step: PolicyExecutionGraphTraceStep;
}): RuntimeNodeTraceEvent {
  return {
    agent: args.agent,
    phase: args.phase,
    stepId: args.step.stepId,
    stepType: args.step.stepType,
    sourceNodeRefs: args.step.sourceNodeRefs,
    toolName: args.step.toolName,
    skipped: args.step.skipped,
    interactionTerminated: args.step.interactionTerminated,
  };
}

function mapStateTraceStep(args: {
  agent: RuntimeNodeTraceAgent;
  step: StateExecutionGraphTraceStep;
}): RuntimeNodeTraceEvent {
  return {
    agent: args.agent,
    phase: "state",
    stepId: args.step.stepId,
    stepType: args.step.stepType,
    sourceNodeRefs: args.step.sourceNodeRefs,
    toolName: args.step.toolName,
    skipped: args.step.skipped,
    interactionTerminated: args.step.interactionTerminated,
  };
}

interface SimulationAgentRuntimeConfig extends OrchestrationRunRuntimeConfigBase {
  kind: SimulationAgentKind;
  fields: OrchestrationField[];
  eventMode: "observation" | "observation_and_reward" | "primary_action";
  /** Draft-level interaction protocol resolved from the visible panel data. */
  protocol: InteractionProtocolConfig;
  /**
   * Request-scoped tool context. Dataset tools always read/write the submitted
   * project snapshot first; saved draft identity is attached only when writes
   * can also be persisted.
   */
  dispatchContext?: Omit<ToolDispatchContext, "toolName">;
  /**
   * Builder-facing diagnostics hook: the policy graph replies with a generic
   * message on tool failure, so the raw error is reported here instead.
   */
  onToolError?: (toolName: string, error: unknown) => void;
  skills: SimulationSkillRuntimeConfig[];
}

interface SimulationSkillRuntimeConfig {
  id: string;
  name: string;
  policyExecutionSystemPrompt: string;
  policyExecutionPlan: OrchestrationRunRuntimeConfigBase["executionPlan"];
  startConditionExecutionPlan: OrchestrationRunRuntimeConfigBase["executionPlan"];
  terminationConditionExecutionPlan: OrchestrationRunRuntimeConfigBase["executionPlan"];
}

function buildSimulationAgentRuntimeConfig(args: {
  kind: SimulationAgentKind;
  fields: OrchestrationField[];
  stateUpdatePrompt: string;
  policyPrompt: string;
  stateCanvasDoc: CanvasDoc | null;
  policyCanvasDoc: CanvasDoc | null;
  eventMode: SimulationAgentRuntimeConfig["eventMode"];
  datasets: SimulationPlayerDataset[];
  protocol: InteractionProtocolConfig;
  skills?: OrchestrationSkill[];
}): SimulationAgentRuntimeConfig {
  const stateSchema = buildRuntimeStateSchema(args.fields);
  const executionPlan = buildStructuralExecutionPlan({
    stateSchema,
    stateCanvasDoc: args.stateCanvasDoc,
    policyCanvasDoc: args.policyCanvasDoc,
  });
  const datasetSchemasContext = buildDatasetSchemasContext(args.datasets);
  const skills = (args.skills ?? []).map((skill, index) => {
    const name = skill.name.trim() || `Skill ${index + 1}`;
    return {
      id: skill.id,
      name,
      policyExecutionSystemPrompt: appendContextToPrompt(
        skill.policyPrompt,
        datasetSchemasContext
      ),
      policyExecutionPlan: buildStructuralExecutionPlan({
        stateSchema,
        stateCanvasDoc: null,
        policyCanvasDoc: skill.policyCanvases,
      }),
      startConditionExecutionPlan: buildStructuralExecutionPlan({
        stateSchema,
        stateCanvasDoc: null,
        policyCanvasDoc: prepareSkillConditionCanvasDoc({
          doc: skill.startConditionCanvases,
          skillName: name,
          phase: "start",
        }),
      }),
      terminationConditionExecutionPlan: buildStructuralExecutionPlan({
        stateSchema,
        stateCanvasDoc: null,
        policyCanvasDoc: prepareSkillConditionCanvasDoc({
          doc: skill.terminationConditionCanvases,
          skillName: name,
          phase: "termination",
        }),
      }),
    };
  });
  const skillPolicyExpandPrompts = (args.skills ?? []).reduce<
    Record<string, string>
  >((acc, skill) => {
    return {
      ...acc,
      ...buildExpandSystemPromptsByKey({
        policyCanvasDoc: skill.policyCanvases,
        policyPrompt: skill.policyPrompt,
      }),
    };
  }, {});
  const skillDocs = (args.skills ?? []).flatMap((skill) => [
    skill.startConditionCanvases,
    skill.policyCanvases,
    skill.terminationConditionCanvases,
  ]);

  return {
    kind: args.kind,
    fields: args.fields,
    protocol: args.protocol,
    stateUpdateSystemPrompt: appendContextToPrompt(
      args.stateUpdatePrompt,
      datasetSchemasContext
    ),
    policyExecutionSystemPrompt: appendContextToPrompt(
      args.policyPrompt,
      datasetSchemasContext
    ),
    stateSchema,
    expandSystemPromptsByKey: {
      ...buildExpandSystemPromptsByKey({
        policyCanvasDoc: args.policyCanvasDoc,
        policyPrompt: args.policyPrompt,
      }),
      ...skillPolicyExpandPrompts,
    },
    toolsByName: compileToolsByName(
      args.stateCanvasDoc,
      args.policyCanvasDoc,
      ...skillDocs
    ),
    executionPlan,
    eventMode: args.eventMode,
    skills,
  };
}

function buildSimulationRewardRuntimeConfig(args: {
  fields: OrchestrationField[];
  rewardPrompt: string;
  rewardCanvasDoc: CanvasDoc | null;
  datasets: SimulationPlayerDataset[];
  protocol: InteractionProtocolConfig;
}): SimulationAgentRuntimeConfig {
  return buildSimulationAgentRuntimeConfig({
    kind: "environment",
    fields: args.fields,
    stateUpdatePrompt: "",
    policyPrompt: args.rewardPrompt,
    stateCanvasDoc: null,
    policyCanvasDoc: args.rewardCanvasDoc,
    eventMode: "primary_action",
    datasets: args.datasets,
    protocol: args.protocol,
    skills: [],
  });
}

function buildAllAgentStateSnapshot(args: {
  graphRuntime: ProjectGraphRuntime;
  sourceRuntime: ProjectAgentRuntime;
  targetRuntime: ProjectAgentRuntime;
  primaryState: StateSnapshot;
  environmentState: StateSnapshot;
}): Record<string, StateSnapshot> {
  const allAgentStates: Record<string, StateSnapshot> = {};
  args.graphRuntime.agentsById.forEach((runtime, agentId) => {
    allAgentStates[agentId] = buildInitialStateSnapshot(runtime.fields);
  });
  allAgentStates[args.sourceRuntime.id] = args.primaryState;
  allAgentStates[args.targetRuntime.id] = args.environmentState;
  return allAgentStates;
}

function buildRewardAgentIngressPromptValues(args: {
  connectionId: string;
  direction: "source_to_target" | "target_to_source";
  latestAction: string;
  sourceAgentId: string;
  recipientAgentId: string;
  sourceState: StateSnapshot;
  recipientState: StateSnapshot;
  allAgentStates: Record<string, StateSnapshot>;
}): PromptValueSnapshot {
  return {
    latest_action: args.latestAction,
    connection_id: args.connectionId,
    direction: args.direction,
    source_agent_id: args.sourceAgentId,
    recipient_agent_id: args.recipientAgentId,
    source_agent_state: args.sourceState,
    recipient_agent_state: args.recipientState,
    all_agent_states: args.allAgentStates,
  };
}

function buildRewardPolicyExecutionPrompt(args: {
  state: StateSnapshot;
  fields: OrchestrationField[];
  rewardInstruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current recipient-agent state (JSON):\n${renderStateJson(
    args.state,
    args.fields
  )}\n\nReward-agent inputs (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\n${args.rewardInstruction}`;
}

function buildRewardPolicySubtreePrompt(args: {
  state: StateSnapshot;
  fields: OrchestrationField[];
  incomingOutput: string;
  rewardInstruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current recipient-agent state (JSON):\n${renderStateJson(
    args.state,
    args.fields
  )}\n\nReward-agent inputs (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${
    args.incomingOutput || "(empty)"
  }\n\nNow execute only the provided reward subtree instructions.\n${args.rewardInstruction}`;
}

function buildRewardPolicyExtractionPrompt(args: {
  runtimeConfig: SimulationAgentRuntimeConfig;
  state: StateSnapshot;
  promptPlan: StatePromptExtractionPlan | undefined;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  const fields = normalizePromptExtractionFields(args.promptPlan);
  const extractionShape = renderPromptExtractionInstruction(fields);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const contextPrompt =
    typeof args.promptPlan?.context_prompt === "string"
      ? args.promptPlan.context_prompt.trim()
      : "";

  return `Reward flow instructions:\n${args.runtimeConfig.policyExecutionSystemPrompt}\n\nCurrent recipient-agent state (JSON):\n${renderStateJson(
    args.state,
    args.runtimeConfig.fields
  )}\n\nReward-agent inputs (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Extract only the intermediate values needed for deterministic reward code.\nDo not return the final reward value.\nUse null for values that should not be set from the current inputs.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildRewardPolicySubtreeExtractionPrompt(args: {
  runtimeConfig: SimulationAgentRuntimeConfig;
  state: StateSnapshot;
  incomingOutput: string;
  promptPlan: StatePromptExtractionPlan | undefined;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  const fields = normalizePromptExtractionFields(args.promptPlan);
  const extractionShape = renderPolicyDecisionExtractionInstruction(fields);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const contextPrompt =
    typeof args.promptPlan?.context_prompt === "string"
      ? args.promptPlan.context_prompt.trim()
      : "";

  return `Reward flow instructions:\n${args.runtimeConfig.policyExecutionSystemPrompt}\n\nCurrent recipient-agent state (JSON):\n${renderStateJson(
    args.state,
    args.runtimeConfig.fields
  )}\n\nReward-agent inputs (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Execute only the provided reward subtree instructions.\nReturn the scalar reward plus any extracted intermediate values.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildRewardPolicyTransformPrompt(args: {
  state: StateSnapshot;
  fields: OrchestrationField[];
  incomingOutput: string;
  instruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current recipient-agent state (JSON):\n${renderStateJson(
    args.state,
    args.fields
  )}\n\nReward-agent inputs (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${
    args.incomingOutput || "(empty)"
  }\n\nTransformation instruction:\n${args.instruction}\n\nReturn only the transformed scalar reward value.`;
}

function normalizeRewardScalar(text: string, fallback: string): string {
  const parsed = parseJsonRecordCandidate(text);
  const candidate = parsed
    ? readStringValue(parsed, "reward", "scalar_reward", "value", "score")
    : text.trim();
  const trimmed = candidate.trim();
  if (!trimmed) {
    return fallback;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return trimmed;
  }
  const match = trimmed.match(/-?\d+(?:\.\d+)?/);
  return match?.[0] ?? fallback;
}

async function runRewardAgentTurn(args: {
  openai: OpenAI;
  runtimeConfig: SimulationAgentRuntimeConfig | null;
  currentState: StateSnapshot;
  latestAction: string;
  connectionId: string;
  direction: "source_to_target" | "target_to_source";
  sourceAgentId: string;
  recipientAgentId: string;
  sourceState: StateSnapshot;
  recipientState: StateSnapshot;
  allAgentStates: Record<string, StateSnapshot>;
  fallbackReward: string;
}): Promise<string> {
  const runtimeConfig = args.runtimeConfig;
  if (
    !runtimeConfig ||
    (!runtimeConfig.policyExecutionSystemPrompt.trim() &&
      !runtimeConfig.executionPlan.policy.code_plan?.execution_graph)
  ) {
    return args.fallbackReward;
  }

  const rewardInstruction = [
    runtimeConfig.policyExecutionSystemPrompt,
    "Return only a scalar numeric reward value for recipient_agent_id. Do not include prose.",
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n\n");
  const initialPromptValues = buildRewardAgentIngressPromptValues({
    connectionId: args.connectionId,
    direction: args.direction,
    latestAction: args.latestAction,
    sourceAgentId: args.sourceAgentId,
    recipientAgentId: args.recipientAgentId,
    sourceState: args.sourceState,
    recipientState: args.recipientState,
    allAgentStates: args.allAgentStates,
  });
  const turnRuntimeContext = {
    latestUserTurn: formatConversationMemoryTurn("user", args.latestAction),
    latestObservationEvent: buildConversationMemoryObservationEvent({
      observation: args.latestAction,
    }),
    latestObservationAndRewardEvent: buildConversationMemoryObservationEvent({
      observation: args.latestAction,
      reward: args.fallbackReward,
    }),
    latestPrimaryActionEvent: buildConversationMemoryActionEvent(
      args.latestAction
    ),
  };
  const result = await runSimulationPolicyDecision({
    openai: args.openai,
    runtimeConfig,
    currentState: args.currentState,
    initialPromptValues,
    turnRuntimeContext,
    runFullPromptDecision: (decisionState, existingPromptValues) =>
      runPrompt(
        args.openai,
        runtimeConfig.policyExecutionSystemPrompt,
        buildRewardPolicyExecutionPrompt({
          state: decisionState,
          fields: runtimeConfig.fields,
          rewardInstruction,
          existingPromptValues,
        }),
        SIMULATION_TOKEN_BUDGETS.environmentPolicyDecision
      ),
    runPromptSubtreeDecision: (
      decisionState,
      subtreePrompt,
      currentOutput,
      existingPromptValues
    ) =>
      runPrompt(
        args.openai,
        subtreePrompt,
        buildRewardPolicySubtreePrompt({
          state: decisionState,
          fields: runtimeConfig.fields,
          incomingOutput: currentOutput,
          rewardInstruction,
          existingPromptValues,
        }),
        SIMULATION_TOKEN_BUDGETS.environmentPolicySubtree
      ),
    runPromptSubtreeDecisionWithExtraction: async (
      decisionState,
      subtreePrompt,
      promptPlan,
      existingPromptValues,
      currentOutput
    ) => {
      const reply = await runPrompt(
        args.openai,
        subtreePrompt,
        buildRewardPolicySubtreeExtractionPrompt({
          runtimeConfig,
          state: decisionState,
          incomingOutput: currentOutput,
          promptPlan,
          existingPromptValues,
        }),
        SIMULATION_TOKEN_BUDGETS.environmentPolicySubtreeExtraction
      );
      const parsed = parsePolicyDecisionExtractionReply(reply, promptPlan);
      return {
        output: parsed.assistantReply,
        promptValues: parsed.promptValues,
      };
    },
    runPromptTransform: (
      decisionState,
      incomingOutput,
      instruction,
      existingPromptValues
    ) =>
      runPrompt(
        args.openai,
        "",
        buildRewardPolicyTransformPrompt({
          state: decisionState,
          fields: runtimeConfig.fields,
          incomingOutput,
          instruction,
          existingPromptValues,
        }),
        SIMULATION_TOKEN_BUDGETS.environmentPolicyTransform
      ),
    runPromptExtraction: (decisionState, promptPlan, existingPromptValues) =>
      runPrompt(
        args.openai,
        "",
        buildRewardPolicyExtractionPrompt({
          runtimeConfig,
          state: decisionState,
          promptPlan,
          existingPromptValues,
        }),
        SIMULATION_TOKEN_BUDGETS.environmentPolicyExtraction
      ).then((reply) => parseStatePromptExtractionReply(reply, promptPlan)),
  });

  return normalizeRewardScalar(result.visibleOutput || result.output, args.fallbackReward);
}

function buildGraphStateUpdatePrompt(
  currentState: StateSnapshot,
  fields: OrchestrationField[],
  existingPromptValues?: PromptValueSnapshot
): string {
  return `Current conversation state (JSON):\n${renderStateJson(
    currentState,
    fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    existingPromptValues
  )}\n\nReturn only the full updated state JSON object.`;
}

function buildGraphStateTransformPrompt(args: {
  currentState: StateSnapshot;
  fields: OrchestrationField[];
  incomingOutput: string;
  instruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current conversation state (JSON):\n${renderStateJson(
    args.currentState,
    args.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${
    args.incomingOutput || "(empty)"
  }\n\nState local-value transform instruction:\n${
    args.instruction
  }\n\nReturn only the transformed local value. Do not return the full state JSON object.`;
}

function buildGraphStateExtractionPrompt(args: {
  currentState: StateSnapshot;
  fields: OrchestrationField[];
  stateUpdatePrompt: string;
  promptPlan: StatePromptExtractionPlan | undefined;
  existingPromptValues: PromptValueSnapshot;
}): string {
  const promptFields = normalizePromptExtractionFields(args.promptPlan);
  const extractionRules =
    promptFields.length > 0
      ? promptFields
          .map((field) => `- ${field.name}: ${field.instruction}`)
          .join("\n")
      : "- (none)";
  const contextPrompt =
    typeof args.promptPlan?.context_prompt === "string" ? args.promptPlan.context_prompt.trim() : "";
  const promptValuesJson = formatPromptValuesJson(args.existingPromptValues);
  return `State flow instructions:\n${args.stateUpdatePrompt}\n\nCurrent conversation state (JSON):\n${renderStateJson(
    args.currentState,
    args.fields
  )}\n\nCurrent ingress/local values (JSON):\n${promptValuesJson}\n\n${contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""}Extract only the intermediate values needed for deterministic state code.\nDo not return the final updated state object.\nUse null for values that should not be set from the current ingress/local values.\n\n${renderPromptExtractionInstruction(
    promptFields
  )}\n\nExtraction rules:\n${extractionRules}`;
}

async function runGraphPromptBasedStateUpdate(args: {
  openai: OpenAI;
  fields: OrchestrationField[];
  stateUpdatePrompt: string;
  currentState: StateSnapshot;
  existingPromptValues?: PromptValueSnapshot;
}): Promise<StateSnapshot> {
  if (!args.stateUpdatePrompt.trim() || args.fields.length === 0) {
    return args.currentState;
  }

  const reply = await runPrompt(
    args.openai,
    args.stateUpdatePrompt,
    buildGraphStateUpdatePrompt(
      args.currentState,
      args.fields,
      args.existingPromptValues
    ),
    SIMULATION_TOKEN_BUDGETS.stateUpdate
  );

  return parseStateUpdateReply(reply, args.fields, args.currentState);
}

async function runGraphPromptBasedStateTransform(args: {
  openai: OpenAI;
  fields: OrchestrationField[];
  currentState: StateSnapshot;
  incomingOutput: string;
  instruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): Promise<string> {
  if (args.fields.length === 0) {
    return args.incomingOutput;
  }

  return runPrompt(
    args.openai,
    "",
    buildGraphStateTransformPrompt({
      currentState: args.currentState,
      fields: args.fields,
      incomingOutput: args.incomingOutput,
      instruction: args.instruction,
      existingPromptValues: args.existingPromptValues,
    }),
    SIMULATION_TOKEN_BUDGETS.stateUpdate
  );
}

async function runGraphPromptBasedStateExtraction(args: {
  openai: OpenAI;
  fields: OrchestrationField[];
  stateUpdatePrompt: string;
  currentState: StateSnapshot;
  promptPlan: StatePromptExtractionPlan | undefined;
  existingPromptValues: PromptValueSnapshot;
}): Promise<PromptValueSnapshot | null> {
  if (!args.stateUpdatePrompt.trim()) {
    return null;
  }

  const reply = await runPrompt(
    args.openai,
    "",
    buildGraphStateExtractionPrompt({
      currentState: args.currentState,
      fields: args.fields,
      stateUpdatePrompt: args.stateUpdatePrompt,
      promptPlan: args.promptPlan,
      existingPromptValues: args.existingPromptValues,
    }),
    SIMULATION_TOKEN_BUDGETS.stateExtraction
  );

  return parseStatePromptExtractionReply(reply, args.promptPlan);
}

async function deriveNextState(args: {
  openai: OpenAI;
  runtimeConfig: SimulationAgentRuntimeConfig;
  currentState: StateSnapshot;
  initialPromptValues: PromptValueSnapshot;
  turnRuntimeContext: StateCodeRuntimeContext;
  onTraceStep?: (step: StateExecutionGraphTraceStep) => void;
}): Promise<{ nextState: StateSnapshot; interactionTerminated: boolean }> {
  const { runtimeConfig } = args;
  const stateGraph =
    runtimeConfig.executionPlan.state.code_plan?.execution_graph ?? null;
  let updatedState = args.currentState;
  let interactionTerminated = false;

  if (
    runtimeConfig.executionPlan.state.mode !== "full_prompt" &&
    stateGraph
  ) {
    const stateResult = await runStateExecutionGraphWithHandlers({
      knownState: args.currentState,
      stateSchema: runtimeConfig.stateSchema,
      graph: stateGraph,
      initialPromptValues: args.initialPromptValues,
      runtimeContext: args.turnRuntimeContext,
      onStep: args.onTraceStep,
      runFullPromptUpdate: (currentState, existingPromptValues) =>
        runGraphPromptBasedStateUpdate({
          openai: args.openai,
          fields: runtimeConfig.fields,
          stateUpdatePrompt: runtimeConfig.stateUpdateSystemPrompt,
          currentState,
          existingPromptValues,
        }),
      runPromptSubtreeUpdate: (
        currentState,
        subtreePrompt,
        existingPromptValues
      ) =>
        runGraphPromptBasedStateUpdate({
          openai: args.openai,
          fields: runtimeConfig.fields,
          stateUpdatePrompt: subtreePrompt,
          currentState,
          existingPromptValues,
        }),
      runPromptTransform: (currentState, incomingOutput, instruction, existingPromptValues) =>
        runGraphPromptBasedStateTransform({
          openai: args.openai,
          fields: runtimeConfig.fields,
          currentState,
          incomingOutput,
          instruction,
          existingPromptValues,
        }),
      runPromptExtraction: (currentState, promptPlan, existingPromptValues) =>
        runGraphPromptBasedStateExtraction({
          openai: args.openai,
          fields: runtimeConfig.fields,
          stateUpdatePrompt: runtimeConfig.stateUpdateSystemPrompt,
          currentState,
          promptPlan,
          existingPromptValues,
        }),
      runDirectTool: async (toolName, resultVariable, inputContributions) => {
        try {
          return await runDirectCanvasTool({
            toolsByName: runtimeConfig.toolsByName,
            toolName,
            resultVariable,
            inputContributions,
            dispatchContext: runtimeConfig.dispatchContext,
          });
        } catch (error) {
          runtimeConfig.onToolError?.(toolName, error);
          throw error;
        }
      },
    });
    updatedState = stateResult.nextState;
    interactionTerminated = stateResult.interactionTerminated;
  } else if (
    runtimeConfig.stateUpdateSystemPrompt.trim() &&
    runtimeConfig.fields.length > 0
  ) {
    updatedState = await runGraphPromptBasedStateUpdate({
      openai: args.openai,
      fields: runtimeConfig.fields,
      stateUpdatePrompt: runtimeConfig.stateUpdateSystemPrompt,
      currentState: args.currentState,
      existingPromptValues: args.initialPromptValues,
    });
  }

  return {
    nextState: updatedState,
    interactionTerminated,
  };
}

function buildPrimaryPolicyExecutionPrompt(args: {
  state: StateSnapshot;
  fields: OrchestrationField[];
  actionInstruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\n${args.actionInstruction}`;
}

function buildPrimaryPolicySubtreePrompt(args: {
  state: StateSnapshot;
  fields: OrchestrationField[];
  incomingOutput: string;
  actionInstruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\nNow execute only the provided policy subtree instructions.\n${args.actionInstruction}`;
}

function buildPrimaryPolicyExtractionPrompt(args: {
  runtimeConfig: SimulationAgentRuntimeConfig;
  state: StateSnapshot;
  promptPlan: StatePromptExtractionPlan | undefined;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  const fields = normalizePromptExtractionFields(args.promptPlan);
  const extractionShape = renderPromptExtractionInstruction(fields);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const contextPrompt =
    typeof args.promptPlan?.context_prompt === "string"
      ? args.promptPlan.context_prompt.trim()
      : "";
  const promptValuesJson = formatPromptValuesJson(args.existingPromptValues);

  return `Policy flow instructions:\n${args.runtimeConfig.policyExecutionSystemPrompt}\n\nCurrent primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.runtimeConfig.fields
  )}\n\nCurrent ingress/local values (JSON):\n${promptValuesJson}\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Extract only the intermediate values needed for deterministic policy code.\nDo not return the final primary-agent action.\nUse null for values that should not be set from the current ingress/local values.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildPrimaryPolicySubtreeExtractionPrompt(args: {
  runtimeConfig: SimulationAgentRuntimeConfig;
  state: StateSnapshot;
  incomingOutput: string;
  promptPlan: StatePromptExtractionPlan | undefined;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  const fields = normalizePromptExtractionFields(args.promptPlan);
  const extractionShape = renderPolicyDecisionExtractionInstruction(fields);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const contextPrompt =
    typeof args.promptPlan?.context_prompt === "string"
      ? args.promptPlan.context_prompt.trim()
      : "";
  const promptValuesJson = formatPromptValuesJson(args.existingPromptValues);

  return `Policy flow instructions:\n${args.runtimeConfig.policyExecutionSystemPrompt}\n\nCurrent primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.runtimeConfig.fields
  )}\n\nCurrent ingress/local values (JSON):\n${promptValuesJson}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Execute only the provided policy subtree instructions.\nReturn the primary agent reply plus any extracted intermediate values.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildPrimaryPolicyTransformPrompt(args: {
  state: StateSnapshot;
  fields: OrchestrationField[];
  incomingOutput: string;
  instruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\nTransformation instruction:\n${args.instruction}\n\nReturn only the transformed primary-agent action or message.`;
}

function buildEnvironmentPolicyExecutionPrompt(args: {
  state: StateSnapshot;
  fields: OrchestrationField[];
  replyInstruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current environment-agent state (JSON):\n${renderStateJson(
    args.state,
    args.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\n${args.replyInstruction}`;
}

function buildEnvironmentPolicySubtreePrompt(args: {
  state: StateSnapshot;
  fields: OrchestrationField[];
  incomingOutput: string;
  replyJsonShape: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current environment-agent state (JSON):\n${renderStateJson(
    args.state,
    args.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\nNow execute only the provided policy subtree instructions.\nReturn only JSON in this exact shape:\n${args.replyJsonShape}`;
}

function buildEnvironmentPolicyInstructionSubtreePrompt(args: {
  state: StateSnapshot;
  fields: OrchestrationField[];
  incomingOutput: string;
  replyInstruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current environment-agent state (JSON):\n${renderStateJson(
    args.state,
    args.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\nNow execute only the provided policy subtree instructions.\n${args.replyInstruction}`;
}

function buildEnvironmentPolicyExtractionPrompt(args: {
  runtimeConfig: SimulationAgentRuntimeConfig;
  state: StateSnapshot;
  promptPlan: StatePromptExtractionPlan | undefined;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  const fields = normalizePromptExtractionFields(args.promptPlan);
  const extractionShape = renderPromptExtractionInstruction(fields);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const contextPrompt =
    typeof args.promptPlan?.context_prompt === "string"
      ? args.promptPlan.context_prompt.trim()
      : "";
  const promptValuesJson = formatPromptValuesJson(args.existingPromptValues);

  return `Policy flow instructions:\n${args.runtimeConfig.policyExecutionSystemPrompt}\n\nCurrent environment-agent state (JSON):\n${renderStateJson(
    args.state,
    args.runtimeConfig.fields
  )}\n\nCurrent ingress/local values (JSON):\n${promptValuesJson}\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Extract only the intermediate values needed for deterministic environment policy code.\nDo not return the final environment response.\nUse null for values that should not be set from the current ingress/local values.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildEnvironmentPolicySubtreeExtractionPrompt(args: {
  runtimeConfig: SimulationAgentRuntimeConfig;
  state: StateSnapshot;
  incomingOutput: string;
  replyJsonShape: string;
  promptPlan: StatePromptExtractionPlan | undefined;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  const fields = normalizePromptExtractionFields(args.promptPlan);
  const extractionShape = renderPolicyDecisionExtractionInstruction(
    fields,
    { kind: "json", shape: args.replyJsonShape }
  );
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const contextPrompt =
    typeof args.promptPlan?.context_prompt === "string"
      ? args.promptPlan.context_prompt.trim()
      : "";
  const promptValuesJson = formatPromptValuesJson(args.existingPromptValues);

  return `Policy flow instructions:\n${args.runtimeConfig.policyExecutionSystemPrompt}\n\nCurrent environment-agent state (JSON):\n${renderStateJson(
    args.state,
    args.runtimeConfig.fields
  )}\n\nCurrent ingress/local values (JSON):\n${promptValuesJson}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Execute only the provided policy subtree instructions.\nReturn the environment reply object plus any extracted intermediate values.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildEnvironmentPolicyInstructionSubtreeExtractionPrompt(args: {
  runtimeConfig: SimulationAgentRuntimeConfig;
  state: StateSnapshot;
  incomingOutput: string;
  replyInstruction: string;
  promptPlan: StatePromptExtractionPlan | undefined;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  const fields = normalizePromptExtractionFields(args.promptPlan);
  const extractionShape = renderPolicyDecisionExtractionInstruction(fields);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const contextPrompt =
    typeof args.promptPlan?.context_prompt === "string"
      ? args.promptPlan.context_prompt.trim()
      : "";
  const promptValuesJson = formatPromptValuesJson(args.existingPromptValues);

  return `Policy flow instructions:\n${args.runtimeConfig.policyExecutionSystemPrompt}\n\nCurrent environment-agent state (JSON):\n${renderStateJson(
    args.state,
    args.runtimeConfig.fields
  )}\n\nCurrent ingress/local values (JSON):\n${promptValuesJson}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Execute only the provided policy subtree instructions.\n${args.replyInstruction}\n\nReturn the policy output plus any extracted intermediate values.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildEnvironmentPolicyTransformPrompt(args: {
  state: StateSnapshot;
  fields: OrchestrationField[];
  incomingOutput: string;
  instruction: string;
  replyJsonShape: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current environment-agent state (JSON):\n${renderStateJson(
    args.state,
    args.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\nTransformation instruction:\n${args.instruction}\n\nReturn only the transformed environment reply as JSON in this exact shape:\n${args.replyJsonShape}`;
}

function buildEnvironmentPolicyInstructionTransformPrompt(args: {
  state: StateSnapshot;
  fields: OrchestrationField[];
  incomingOutput: string;
  instruction: string;
  replyInstruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current environment-agent state (JSON):\n${renderStateJson(
    args.state,
    args.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\nTransformation instruction:\n${args.instruction}\n\n${args.replyInstruction}`;
}

async function runSimulationPolicyDecision(args: {
  openai: OpenAI;
  runtimeConfig: SimulationAgentRuntimeConfig;
  currentState: StateSnapshot;
  initialPromptValues: PromptValueSnapshot;
  turnRuntimeContext: StateCodeRuntimeContext;
  onTraceStep?: (step: PolicyExecutionGraphTraceStep) => void;
  runFullPromptDecision: (
    currentState: StateSnapshot,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<string>;
  runPromptSubtreeDecision: (
    currentState: StateSnapshot,
    subtreePrompt: string,
    currentOutput: string,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<string>;
  runPromptSubtreeDecisionWithExtraction: (
    currentState: StateSnapshot,
    subtreePrompt: string,
    promptPlan: StatePromptExtractionPlan | undefined,
    existingPromptValues: PromptValueSnapshot,
    currentOutput: string
  ) => Promise<{ output: string; promptValues: PromptValueSnapshot | null }>;
  runPromptTransform: (
    currentState: StateSnapshot,
    incomingOutput: string,
    instruction: string,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<string>;
  runPromptExtraction: (
    currentState: StateSnapshot,
    promptPlan: StatePromptExtractionPlan | undefined,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<PromptValueSnapshot | null>;
}): Promise<{
  output: string;
  visibleOutput: string;
  nextState: StateSnapshot;
  interactionTerminated: boolean;
}> {
  const policyGraph =
    args.runtimeConfig.executionPlan.policy.code_plan?.execution_graph;

  if (
    args.runtimeConfig.executionPlan.policy.mode === "full_prompt" ||
    !policyGraph
  ) {
    const output = (
      await args.runFullPromptDecision(
        args.currentState,
        args.initialPromptValues
      )
    ).trim();
    return {
      output,
      visibleOutput: output,
      nextState: args.currentState,
      interactionTerminated: false,
    };
  }

  return runPolicyExecutionGraphWithHandlers({
    updatedState: args.currentState,
    stateSchema: args.runtimeConfig.stateSchema,
    graph: policyGraph,
    initialPromptValues: args.initialPromptValues,
    runtimeContext: args.turnRuntimeContext,
    onStep: args.onTraceStep,
    runFullPromptDecision: (currentState, existingPromptValues) =>
      args.runFullPromptDecision(currentState, existingPromptValues),
    runPromptSubtreeDecision: (
      currentState,
      subtreePrompt,
      currentOutput,
      existingPromptValues
    ) =>
      args.runPromptSubtreeDecision(
        currentState,
        subtreePrompt,
        currentOutput,
        existingPromptValues
      ),
    runPromptSubtreeDecisionWithExtraction: (
      currentState,
      subtreePrompt,
      promptPlan,
      existingPromptValues,
      currentOutput
    ) =>
      args.runPromptSubtreeDecisionWithExtraction(
        currentState,
        subtreePrompt,
        promptPlan,
        existingPromptValues,
        currentOutput
      ),
    runPromptTransform: (
      currentState,
      incomingOutput,
      instruction,
      existingPromptValues
    ) =>
      args.runPromptTransform(
        currentState,
        incomingOutput,
        instruction,
        existingPromptValues
      ),
    runPromptExtraction: (currentState, promptPlan, existingPromptValues) =>
      args.runPromptExtraction(
        currentState,
        promptPlan,
        existingPromptValues
      ),
    runRuntimeOperation: createPolicyRuntimeOperationHandler({
      raiseErrorFallback: "Simulation policy raised an explicit runtime error.",
      unsupportedOperation: (operation) =>
        `Simulation does not yet support runtime_operation("${operation}").`,
    }),
    runDirectTool: async (toolName, resultVariable, inputContributions) => {
      try {
        return await runDirectCanvasTool({
          toolsByName: args.runtimeConfig.toolsByName,
          toolName,
          resultVariable,
          inputContributions,
          dispatchContext: args.runtimeConfig.dispatchContext,
        });
      } catch (error) {
        args.runtimeConfig.onToolError?.(toolName, error);
        throw error;
      }
    },
    runExpandPrompt: (
      currentState,
      expandLabel,
      currentOutput,
      existingPromptValues
    ) => {
      const expandPrompt =
        args.runtimeConfig.expandSystemPromptsByKey[
          normalizeExpandKey(expandLabel)
        ] ?? args.runtimeConfig.policyExecutionSystemPrompt;
      return args.runPromptSubtreeDecision(
        currentState,
        expandPrompt,
        currentOutput,
        existingPromptValues
      );
    },
  });
}

function createSimulationPolicyRuntimeConfig(args: {
  runtimeConfig: SimulationAgentRuntimeConfig;
  policyExecutionSystemPrompt: string;
  executionPlan: OrchestrationRunRuntimeConfigBase["executionPlan"];
}): SimulationAgentRuntimeConfig {
  return {
    ...args.runtimeConfig,
    policyExecutionSystemPrompt: args.policyExecutionSystemPrompt,
    executionPlan: {
      ...args.runtimeConfig.executionPlan,
      policy: args.executionPlan.policy,
    },
  };
}

function buildSkillConditionInstruction(
  skill: SimulationSkillRuntimeConfig,
  phase: "start" | "termination"
): string {
  const phaseLabel = phase === "start" ? "start" : "termination";
  return [
    `Evaluate the ${phaseLabel} condition for the temporally extended action "${skill.name}".`,
    `Return exactly ${SKILL_CONDITION_TRUE_OUTPUT} if the condition is true.`,
    `Return exactly ${SKILL_CONDITION_FALSE_OUTPUT} if the condition is false.`,
  ].join("\n");
}

async function resolveActiveSimulationSkill(args: {
  runtimeConfig: SimulationAgentRuntimeConfig;
  activeSkillId: string | null;
  currentState: StateSnapshot;
  evaluateCondition: (
    skill: SimulationSkillRuntimeConfig,
    phase: "start" | "termination",
    currentState: StateSnapshot
  ) => Promise<boolean>;
}): Promise<SimulationSkillRuntimeConfig | null> {
  const activeSkill = args.activeSkillId
    ? args.runtimeConfig.skills.find((skill) => skill.id === args.activeSkillId) ??
      null
    : null;

  if (activeSkill) {
    const shouldTerminate = await args.evaluateCondition(
      activeSkill,
      "termination",
      args.currentState
    );
    if (!shouldTerminate) {
      return activeSkill;
    }
  }

  const executableSkills: SimulationSkillRuntimeConfig[] = [];
  for (const skill of args.runtimeConfig.skills) {
    const isExecutable = await args.evaluateCondition(
      skill,
      "start",
      args.currentState
    );
    if (isExecutable) {
      executableSkills.push(skill);
    }
  }

  if (executableSkills.length > 1) {
    const agentLabel =
      args.runtimeConfig.kind === "primary"
        ? "Primary agent"
        : "Environment agent";
    const names = executableSkills.map((skill) => `"${skill.name}"`).join(", ");
    throw new Error(
      `${agentLabel} has multiple executable skills (${names}). At most one skill can execute at a time.`
    );
  }

  return executableSkills[0] ?? null;
}

async function runPrimaryAgentTurn(args: {
  openai: OpenAI;
  runtimeConfig: SimulationAgentRuntimeConfig;
  currentState: StateSnapshot;
  latestObservation: string;
  latestReward: string;
  activeSkillId: string | null;
  collectTrace?: boolean;
}): Promise<{
  primaryAction: string;
  targetReward: string;
  nextState: StateSnapshot;
  activeSkillId: string | null;
  trace: RuntimeNodeTraceEvent[];
  interactionTerminated: boolean;
}> {
  const currentState = writeInteractionIngressState(
    args.currentState,
    args.runtimeConfig.fields,
    args.latestObservation,
    args.latestReward
  );
  const latestMessage = `Observation: ${args.latestObservation}\nReward: ${args.latestReward}`;
  const ingressPromptValues = buildPrimaryAgentIngressPromptValues({
    latestObservation: args.latestObservation,
    latestReward: args.latestReward,
  });
  const turnRuntimeContext = {
    latestUserTurn: formatConversationMemoryTurn("user", latestMessage),
    latestObservationEvent: buildConversationMemoryObservationEvent({
      observation: args.latestObservation,
    }),
    latestObservationAndRewardEvent: buildConversationMemoryObservationEvent({
      observation: args.latestObservation,
      reward: args.latestReward,
    }),
    latestPrimaryActionEvent: buildConversationMemoryActionEvent(""),
  };
  const turnTrace: RuntimeNodeTraceEvent[] = [];
  const stateResult = await deriveNextState({
    openai: args.openai,
    runtimeConfig: args.runtimeConfig,
    currentState,
    initialPromptValues: ingressPromptValues,
    turnRuntimeContext,
    onTraceStep: args.collectTrace
      ? (step) =>
          turnTrace.push(mapStateTraceStep({ agent: "primary", step }))
      : undefined,
  });
  const updatedState = stateResult.nextState;
  if (stateResult.interactionTerminated) {
    return {
      primaryAction: "",
      targetReward: "",
      nextState: updatedState,
      activeSkillId: null,
      trace: turnTrace,
      interactionTerminated: true,
    };
  }
  const runPrimaryPolicy = (
    policyRuntimeConfig: SimulationAgentRuntimeConfig,
    currentState: StateSnapshot,
    actionInstruction = policyRuntimeConfig.protocol.primaryActionInstruction,
    phase: RuntimeNodeTracePhase = "policy",
    traceTarget?: RuntimeNodeTraceEvent[]
  ) =>
    runSimulationPolicyDecision({
      openai: args.openai,
      runtimeConfig: policyRuntimeConfig,
      currentState,
      initialPromptValues: ingressPromptValues,
      turnRuntimeContext,
      onTraceStep: traceTarget
        ? (step) =>
            traceTarget.push(
              mapPolicyTraceStep({ agent: "primary", phase, step })
            )
        : undefined,
      runFullPromptDecision: (decisionState, existingPromptValues) =>
        runPrompt(
          args.openai,
          policyRuntimeConfig.policyExecutionSystemPrompt,
          buildPrimaryPolicyExecutionPrompt({
            state: decisionState,
            fields: policyRuntimeConfig.fields,
            actionInstruction,
            existingPromptValues,
          }),
          SIMULATION_TOKEN_BUDGETS.primaryPolicyDecision
        ),
      runPromptSubtreeDecision: (
        decisionState,
        subtreePrompt,
        currentOutput,
        existingPromptValues
      ) =>
        runPrompt(
          args.openai,
          subtreePrompt,
          buildPrimaryPolicySubtreePrompt({
            state: decisionState,
            fields: policyRuntimeConfig.fields,
            incomingOutput: currentOutput,
            actionInstruction,
            existingPromptValues,
          }),
          SIMULATION_TOKEN_BUDGETS.primaryPolicySubtree
        ),
      runPromptSubtreeDecisionWithExtraction: async (
        decisionState,
        subtreePrompt,
        promptPlan,
        existingPromptValues,
        currentOutput
      ) => {
        const reply = await runPrompt(
          args.openai,
          subtreePrompt,
          buildPrimaryPolicySubtreeExtractionPrompt({
            runtimeConfig: policyRuntimeConfig,
            state: decisionState,
            incomingOutput: currentOutput,
            promptPlan,
            existingPromptValues,
          }),
          SIMULATION_TOKEN_BUDGETS.primaryPolicySubtreeExtraction
        );
        const parsed = parsePolicyDecisionExtractionReply(reply, promptPlan);
        return {
          output: parsed.assistantReply,
          promptValues: parsed.promptValues,
        };
      },
      runPromptTransform: (
        decisionState,
        incomingOutput,
        instruction,
        existingPromptValues
      ) =>
        runPrompt(
          args.openai,
          "",
          buildPrimaryPolicyTransformPrompt({
            state: decisionState,
            fields: policyRuntimeConfig.fields,
            incomingOutput,
            instruction,
            existingPromptValues,
          }),
          SIMULATION_TOKEN_BUDGETS.primaryPolicyTransform
        ),
      runPromptExtraction: (decisionState, promptPlan, existingPromptValues) =>
        runPrompt(
          args.openai,
          "",
          buildPrimaryPolicyExtractionPrompt({
            runtimeConfig: policyRuntimeConfig,
            state: decisionState,
            promptPlan,
            existingPromptValues,
          }),
          SIMULATION_TOKEN_BUDGETS.primaryPolicyExtraction
        ).then((reply) => parseStatePromptExtractionReply(reply, promptPlan)),
    });
  const evaluateSkillCondition = async (
    skill: SimulationSkillRuntimeConfig,
    phase: "start" | "termination",
    currentState: StateSnapshot
  ) => {
    const conditionRuntimeConfig = createSimulationPolicyRuntimeConfig({
      runtimeConfig: args.runtimeConfig,
      policyExecutionSystemPrompt: buildSkillConditionInstruction(skill, phase),
      executionPlan:
        phase === "start"
          ? skill.startConditionExecutionPlan
          : skill.terminationConditionExecutionPlan,
    });
    const result = await runPrimaryPolicy(
      conditionRuntimeConfig,
      currentState,
      buildSkillConditionInstruction(skill, phase),
      phase === "start"
        ? "skill_start_condition"
        : "skill_termination_condition",
      args.collectTrace ? turnTrace : undefined
    );
    return skillConditionOutputIsTrue(result.output);
  };
  const activeSkill = await resolveActiveSimulationSkill({
    runtimeConfig: args.runtimeConfig,
    activeSkillId: args.activeSkillId,
    currentState: updatedState,
    evaluateCondition: evaluateSkillCondition,
  });
  const policyRuntimeConfig = activeSkill
    ? createSimulationPolicyRuntimeConfig({
        runtimeConfig: args.runtimeConfig,
        policyExecutionSystemPrompt: activeSkill.policyExecutionSystemPrompt,
        executionPlan: activeSkill.policyExecutionPlan,
      })
    : args.runtimeConfig;
  const policyResult = await runPrimaryPolicy(
    policyRuntimeConfig,
    updatedState,
    policyRuntimeConfig.protocol.primaryActionInstruction,
    "policy",
    args.collectTrace ? turnTrace : undefined
  );
  const visibleOutput = policyResult.visibleOutput.trim();
  const outputCandidate = parseAgentPolicyOutputCandidate(visibleOutput);
  const primaryAction = outputCandidate?.action || visibleOutput;
  const targetReward = outputCandidate?.reward || "";
  const nextState = primaryAction
    ? writeInteractionStateValue(
        policyResult.nextState,
        args.runtimeConfig.fields,
        PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
        primaryAction
      )
    : policyResult.nextState;
  const nextActiveSkillId =
    !policyResult.interactionTerminated &&
    activeSkill &&
    !(await evaluateSkillCondition(activeSkill, "termination", nextState))
      ? activeSkill.id
      : null;

  return {
    primaryAction,
    targetReward,
    nextState,
    activeSkillId: nextActiveSkillId,
    trace: turnTrace,
    interactionTerminated: policyResult.interactionTerminated,
  };
}

function parseEnvironmentStructuredReplyCandidate(
  text: string,
  protocol: InteractionProtocolConfig
): Partial<EnvironmentStructuredReply> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseJsonRecordCandidate(text);
  if (!parsed) {
    return {
      observation: trimmed,
    };
  }

  return {
    observation: readStringValue(
      parsed,
      protocol.environmentReplyObservationKey,
      PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
      "observation",
      "action"
    ),
    reward: readStringValue(
      parsed,
      protocol.environmentReplyRewardKey,
      PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
      "reward"
    ),
    notes: readStringValue(
      parsed,
      protocol.environmentReplyNotesKey,
      "environment_notes",
      "notes"
    ),
  };
}

function parseAgentPolicyOutputCandidate(
  text: string
): { action: string; reward: string } | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseJsonRecordCandidate(text);
  if (!parsed) {
    return { action: trimmed, reward: "" };
  }

  return {
    action: readStringValue(
      parsed,
      "assistantMessage",
      PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
      "action",
      "observation"
    ),
    reward: readStringValue(
      parsed,
      "target_reward",
      "reward_for_target",
      PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
      "reward"
    ),
  };
}

function readStringValue(
  record: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = record[key];
    const normalized = normalizeStructuredReplyScalar(value, keys);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonRecordCandidate(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    extractFirstJsonObject(trimmed) ?? "",
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
      if (typeof parsed === "string") {
        const nested = parseJsonRecordCandidate(parsed);
        if (nested) {
          return nested;
        }
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function normalizeStructuredReplyScalar(
  value: unknown,
  fallbackKeys: string[]
): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    const nested = parseJsonRecordCandidate(trimmed);
    if (nested) {
      return readStringValue(nested, ...fallbackKeys);
    }
    return trimmed;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (isRecord(value)) {
    return readStringValue(value, ...fallbackKeys);
  }

  return "";
}

function readInteractionStateValue(
  state: StateSnapshot,
  fields: OrchestrationField[],
  canonicalFieldName: string
): string {
  const field = findOrchestrationFieldByCanonicalName(fields, canonicalFieldName);
  const value = field ? state[field.name] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

function writeInteractionStateValue(
  state: StateSnapshot,
  fields: OrchestrationField[],
  canonicalFieldName: string,
  value: string
): StateSnapshot {
  const field = findOrchestrationFieldByCanonicalName(fields, canonicalFieldName);
  if (!field) {
    return state;
  }

  return {
    ...state,
    [field.name]: normalizeStateValueForBlock(value, field.type),
  };
}

function writeInteractionIngressState(
  state: StateSnapshot,
  fields: OrchestrationField[],
  latestObservation: string,
  latestReward: string
): StateSnapshot {
  let nextState = state;
  if (latestObservation) {
    nextState = writeInteractionStateValue(
      nextState,
      fields,
      PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
      latestObservation
    );
  }
  if (latestReward) {
    nextState = writeInteractionStateValue(
      nextState,
      fields,
      PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
      latestReward
    );
  }

  return nextState;
}

function resolveEnvironmentStructuredReply(args: {
  text: string;
  protocol: InteractionProtocolConfig;
}): EnvironmentStructuredReply {
  const outputCandidate = parseEnvironmentStructuredReplyCandidate(
    args.text,
    args.protocol
  );

  return {
    observation: outputCandidate?.observation?.trim() || "",
    reward:
      outputCandidate?.reward?.trim() ||
      "",
    notes: outputCandidate?.notes?.trim() || "",
  };
}

function withEnvironmentReplyDefaults(
  reply: EnvironmentStructuredReply,
  protocol: InteractionProtocolConfig
): EnvironmentStructuredReply {
  return {
    observation: reply.observation || protocol.defaultEnvironmentObservation,
    reward: reply.reward || protocol.defaultEnvironmentReward,
    notes: reply.notes,
  };
}

async function runEnvironmentAgentTurn(args: {
  openai: OpenAI;
  runtimeConfig: SimulationAgentRuntimeConfig;
  currentState: StateSnapshot;
  latestPrimaryAction: string;
  latestReward: string;
  activeSkillId: string | null;
  collectTrace?: boolean;
}): Promise<{
  environmentReply: EnvironmentStructuredReply;
  nextState: StateSnapshot;
  activeSkillId: string | null;
  trace: RuntimeNodeTraceEvent[];
  interactionTerminated: boolean;
}> {
  const latestPrimaryAction = args.latestPrimaryAction.trim();
  const currentState = writeInteractionIngressState(
    args.currentState,
    args.runtimeConfig.fields,
    latestPrimaryAction,
    args.latestReward
  );
  const ingressPromptValues = buildEnvironmentAgentIngressPromptValues({
    latestObservation: args.latestPrimaryAction,
    latestReward: args.latestReward,
  });
  const turnRuntimeContext = {
    latestUserTurn: formatConversationMemoryTurn("user", args.latestPrimaryAction),
    latestObservationEvent: buildConversationMemoryObservationEvent({
      observation: args.latestPrimaryAction,
    }),
    latestObservationAndRewardEvent: buildConversationMemoryObservationEvent({
      observation: args.latestPrimaryAction,
      reward: args.latestReward,
    }),
    latestPrimaryActionEvent: buildConversationMemoryActionEvent(
      args.latestPrimaryAction
    ),
  };
  const turnTrace: RuntimeNodeTraceEvent[] = [];
  const stateResult = await deriveNextState({
    openai: args.openai,
    runtimeConfig: args.runtimeConfig,
    currentState,
    initialPromptValues: ingressPromptValues,
    turnRuntimeContext,
    onTraceStep: args.collectTrace
      ? (step) =>
          turnTrace.push(mapStateTraceStep({ agent: "environment", step }))
      : undefined,
  });
  const updatedState = stateResult.nextState;
  if (stateResult.interactionTerminated) {
    return {
      environmentReply: { observation: "", reward: "", notes: "" },
      nextState: updatedState,
      activeSkillId: null,
      trace: turnTrace,
      interactionTerminated: true,
    };
  }
  const replyJsonShape = buildEnvironmentReplyJsonShape(
    args.runtimeConfig.protocol
  );
  const environmentReplyInstruction = [
    args.runtimeConfig.protocol.environmentReplyInstruction,
    buildEnvironmentReplySchemaInstruction(args.runtimeConfig.protocol),
  ].join("\n\n");
  const runEnvironmentPolicy = (
    policyRuntimeConfig: SimulationAgentRuntimeConfig,
    currentState: StateSnapshot,
    options: {
      replyInstruction: string;
      replyJsonShape: string | null;
      phase?: RuntimeNodeTracePhase;
      traceTarget?: RuntimeNodeTraceEvent[];
    } = {
      replyInstruction: environmentReplyInstruction,
      replyJsonShape,
    }
  ) =>
    runSimulationPolicyDecision({
      openai: args.openai,
      runtimeConfig: policyRuntimeConfig,
      currentState,
      initialPromptValues: ingressPromptValues,
      turnRuntimeContext,
      onTraceStep: options.traceTarget
        ? (step) =>
            options.traceTarget?.push(
              mapPolicyTraceStep({
                agent: "environment",
                phase: options.phase ?? "policy",
                step,
              })
            )
        : undefined,
      runFullPromptDecision: (decisionState, existingPromptValues) =>
        runPrompt(
          args.openai,
          policyRuntimeConfig.policyExecutionSystemPrompt,
          buildEnvironmentPolicyExecutionPrompt({
            state: decisionState,
            fields: policyRuntimeConfig.fields,
            replyInstruction: options.replyInstruction,
            existingPromptValues,
          }),
          SIMULATION_TOKEN_BUDGETS.environmentPolicyDecision
        ),
      runPromptSubtreeDecision: (
        decisionState,
        subtreePrompt,
        currentOutput,
        existingPromptValues
      ) =>
        runPrompt(
          args.openai,
          subtreePrompt,
          options.replyJsonShape
            ? buildEnvironmentPolicySubtreePrompt({
                state: decisionState,
                fields: policyRuntimeConfig.fields,
                incomingOutput: currentOutput,
                replyJsonShape: options.replyJsonShape,
                existingPromptValues,
              })
            : buildEnvironmentPolicyInstructionSubtreePrompt({
                state: decisionState,
                fields: policyRuntimeConfig.fields,
                incomingOutput: currentOutput,
                replyInstruction: options.replyInstruction,
                existingPromptValues,
              }),
          SIMULATION_TOKEN_BUDGETS.environmentPolicySubtree
        ),
      runPromptSubtreeDecisionWithExtraction: async (
        decisionState,
        subtreePrompt,
        promptPlan,
        existingPromptValues,
        currentOutput
      ) => {
        const reply = await runPrompt(
          args.openai,
          subtreePrompt,
          options.replyJsonShape
            ? buildEnvironmentPolicySubtreeExtractionPrompt({
                runtimeConfig: policyRuntimeConfig,
                state: decisionState,
                incomingOutput: currentOutput,
                replyJsonShape: options.replyJsonShape,
                promptPlan,
                existingPromptValues,
              })
            : buildEnvironmentPolicyInstructionSubtreeExtractionPrompt({
                runtimeConfig: policyRuntimeConfig,
                state: decisionState,
                incomingOutput: currentOutput,
                replyInstruction: options.replyInstruction,
                promptPlan,
                existingPromptValues,
              }),
          SIMULATION_TOKEN_BUDGETS.environmentPolicySubtreeExtraction
        );
        const parsed = parsePolicyDecisionExtractionReply(reply, promptPlan);
        return {
          output: parsed.assistantReply,
          promptValues: parsed.promptValues,
        };
      },
      runPromptTransform: (
        decisionState,
        incomingOutput,
        instruction,
        existingPromptValues
      ) =>
        runPrompt(
          args.openai,
          "",
          options.replyJsonShape
            ? buildEnvironmentPolicyTransformPrompt({
                state: decisionState,
                fields: policyRuntimeConfig.fields,
                incomingOutput,
                instruction,
                replyJsonShape: options.replyJsonShape,
                existingPromptValues,
              })
            : buildEnvironmentPolicyInstructionTransformPrompt({
                state: decisionState,
                fields: policyRuntimeConfig.fields,
                incomingOutput,
                instruction,
                replyInstruction: options.replyInstruction,
                existingPromptValues,
              }),
          SIMULATION_TOKEN_BUDGETS.environmentPolicyTransform
        ),
      runPromptExtraction: (decisionState, promptPlan, existingPromptValues) =>
        runPrompt(
          args.openai,
          "",
          buildEnvironmentPolicyExtractionPrompt({
            runtimeConfig: policyRuntimeConfig,
            state: decisionState,
            promptPlan,
            existingPromptValues,
          }),
          SIMULATION_TOKEN_BUDGETS.environmentPolicyExtraction
        ).then((reply) => parseStatePromptExtractionReply(reply, promptPlan)),
    });
  const evaluateSkillCondition = async (
    skill: SimulationSkillRuntimeConfig,
    phase: "start" | "termination",
    currentState: StateSnapshot
  ) => {
    const conditionInstruction = buildSkillConditionInstruction(skill, phase);
    const conditionRuntimeConfig = createSimulationPolicyRuntimeConfig({
      runtimeConfig: args.runtimeConfig,
      policyExecutionSystemPrompt: conditionInstruction,
      executionPlan:
        phase === "start"
          ? skill.startConditionExecutionPlan
          : skill.terminationConditionExecutionPlan,
    });
    const result = await runEnvironmentPolicy(
      conditionRuntimeConfig,
      currentState,
      {
        replyInstruction: conditionInstruction,
        replyJsonShape: null,
        phase:
          phase === "start"
            ? "skill_start_condition"
            : "skill_termination_condition",
        traceTarget: args.collectTrace ? turnTrace : undefined,
      }
    );
    return skillConditionOutputIsTrue(result.output);
  };
  const activeSkill = await resolveActiveSimulationSkill({
    runtimeConfig: args.runtimeConfig,
    activeSkillId: args.activeSkillId,
    currentState: updatedState,
    evaluateCondition: evaluateSkillCondition,
  });
  const policyRuntimeConfig = activeSkill
    ? createSimulationPolicyRuntimeConfig({
        runtimeConfig: args.runtimeConfig,
        policyExecutionSystemPrompt: activeSkill.policyExecutionSystemPrompt,
        executionPlan: activeSkill.policyExecutionPlan,
      })
    : args.runtimeConfig;
  const policyResult = await runEnvironmentPolicy(
    policyRuntimeConfig,
    updatedState,
    {
      replyInstruction: environmentReplyInstruction,
      replyJsonShape,
      phase: "policy",
      traceTarget: args.collectTrace ? turnTrace : undefined,
    }
  );
  const environmentReply = resolveEnvironmentStructuredReply({
    text: policyResult.visibleOutput,
    protocol: args.runtimeConfig.protocol,
  });
  let nextState = policyResult.nextState;
  if (environmentReply.observation) {
    nextState = writeInteractionStateValue(
      nextState,
      args.runtimeConfig.fields,
      PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
      environmentReply.observation
    );
  }
  const nextActiveSkillId =
    !policyResult.interactionTerminated &&
    activeSkill &&
    !(await evaluateSkillCondition(activeSkill, "termination", nextState))
      ? activeSkill.id
      : null;

  return {
    environmentReply,
    nextState,
    activeSkillId: nextActiveSkillId,
    trace: turnTrace,
    interactionTerminated: policyResult.interactionTerminated,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      project?: OrchestrationProject;
      draftId?: string;
    };

    if (!body?.project) {
      return NextResponse.json(
        { error: "Expected `project` in the request body." },
        { status: 400 }
      );
    }

    const graphRuntime = await resolveProjectAgentRuntimes({
      project: body.project,
    });
    const baseProject = syncDerivedPrompts({
      ...projectAgentRuntimeToPrimaryProject(body.project, graphRuntime.sourceAgent),
    });
    const graphTargets = graphRuntime.connectedTargets.map((target) => ({
      connectionId: target.connection.id,
      targetAgentId: target.agent.id,
    }));
    if (
      graphRuntime.connectedTargets.length === 0 &&
      baseProject.environmentPlayers.length === 0
    ) {
      return NextResponse.json(
        { error: "The current draft does not have a connected target agent to simulate." },
        { status: 400 }
      );
    }

    const openai = new OpenAI({ apiKey: resolveOpenAiApiKey() });
    const parsedProtocol = parseExplicitInteractionProtocol(
      baseProject.interactionProtocol
    );
    if (!parsedProtocol.protocol) {
      return NextResponse.json(
        {
          error: `Complete the Run Contract before simulating. ${parsedProtocol.issues.join(" ")}`,
        },
        { status: 400 }
      );
    }
    const protocol = parsedProtocol.protocol;
    const parsedSimulationSettings = parseExplicitSimulationSettings(
      baseProject.interactionProtocol,
      baseProject.environmentPlayers,
      graphTargets
    );
    if (!parsedSimulationSettings.settings) {
      return NextResponse.json(
        {
          error: `Complete Simulation Settings before simulating. ${parsedSimulationSettings.issues.join(" ")}`,
        },
        { status: 400 }
      );
    }
    const simulationSettings = parsedSimulationSettings.settings;
    const selectedGraphTarget =
      (simulationSettings.connectionId
        ? graphRuntime.connectedTargets.find(
            (target) => target.connection.id === simulationSettings.connectionId
          )
        : null) ??
      (simulationSettings.targetAgentId
        ? graphRuntime.connectedTargets.find(
            (target) => target.agent.id === simulationSettings.targetAgentId
          )
        : null) ??
      (simulationSettings.environmentPlayerId
        ? graphRuntime.connectedTargets.find(
            (target) => target.agent.id === simulationSettings.environmentPlayerId
          )
        : null) ??
      null;
    const sourceRuntime = selectedGraphTarget
      ? applyConnectionParticipantPolicy({
          runtime: graphRuntime.sourceAgent,
          connection: selectedGraphTarget.connection,
          participant: "source",
        })
      : graphRuntime.sourceAgent;
    const project = syncDerivedPrompts({
      ...projectAgentRuntimeToPrimaryProject(body.project, sourceRuntime),
    });
    const legacyEnvironmentIndex =
      selectedGraphTarget || !simulationSettings.environmentPlayerId.trim()
        ? -1
        : baseProject.environmentPlayers.findIndex(
            (player) => player.id === simulationSettings.environmentPlayerId
          );
    const targetRuntime =
      selectedGraphTarget?.agent ??
      (legacyEnvironmentIndex >= 0
        ? legacyEnvironmentPlayerToTargetRuntime({
            player: project.environmentPlayers[legacyEnvironmentIndex],
            index: legacyEnvironmentIndex,
          })
        : null);
    const environmentIndex =
      legacyEnvironmentIndex >= 0
        ? legacyEnvironmentIndex
        : simulationSettings.environmentIndex;

    if (!targetRuntime) {
      return NextResponse.json(
        { error: "The selected target agent was not found." },
        { status: 400 }
      );
    }

    const interactionFieldIssues = [
      ...getMissingInteractionFieldIssues(
        project.fields,
        PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
        PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
        PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME
      ).map((issue) => `Primary agent: ${issue}`),
      ...getMissingInteractionFieldIssues(
        targetRuntime.fields,
        PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
        PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
        PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME
      ).map((issue) => `Target agent "${targetRuntime.title}": ${issue}`),
    ];
    if (interactionFieldIssues.length > 0) {
      return NextResponse.json(
        {
          error: `Simulation requires the latest observation, reward, and action state fields on both agents. ${interactionFieldIssues.join(" ")}`,
        },
        { status: 400 }
      );
    }
    // Each agent sees its own datasets first, then the draft's shared
    // datasets as fallback (matching how its dataset tools resolve names at
    // dispatch time).
    const sharedDatasets = Array.isArray(project.sharedDatasets)
      ? project.sharedDatasets
      : [];
    const primaryRuntimeConfig = buildSimulationAgentRuntimeConfig({
      kind: "primary",
      fields: project.fields,
      stateUpdatePrompt: project.stateUpdatePrompt,
      policyPrompt: project.policyPrompt,
      stateCanvasDoc: project.statePolicyCanvases,
      policyCanvasDoc: project.policyCanvases,
      eventMode: "observation_and_reward",
      datasets: mergeDatasetsForAgentContext(project.datasets, sharedDatasets),
      protocol,
      skills: project.skills,
    });
    const environmentRuntimeConfig = buildSimulationAgentRuntimeConfig({
      kind: "environment",
      fields: targetRuntime.fields,
      stateUpdatePrompt: targetRuntime.stateUpdatePrompt,
      policyPrompt: targetRuntime.policyPrompt,
      stateCanvasDoc: targetRuntime.statePolicyCanvases,
      policyCanvasDoc: targetRuntime.policyCanvases,
      eventMode: "primary_action",
      datasets: mergeDatasetsForAgentContext(
        targetRuntime.datasets,
        sharedDatasets
      ),
      protocol,
      skills: targetRuntime.skills,
    });
    const rewardDatasets = mergeDatasetsForAgentContext(
      [...project.datasets, ...targetRuntime.datasets],
      sharedDatasets
    );
    const sourceToTargetRewardRuntimeConfig = selectedGraphTarget
      ? buildSimulationRewardRuntimeConfig({
          fields: targetRuntime.fields,
          rewardPrompt: selectedGraphTarget.connection.sourceRewardPrompt,
          rewardCanvasDoc: selectedGraphTarget.connection.sourceRewardCanvases,
          datasets: rewardDatasets,
          protocol,
        })
      : null;
    const targetToSourceRewardRuntimeConfig = selectedGraphTarget
      ? buildSimulationRewardRuntimeConfig({
          fields: project.fields,
          rewardPrompt: selectedGraphTarget.connection.targetRewardPrompt,
          rewardCanvasDoc: selectedGraphTarget.connection.targetRewardCanvases,
          datasets: rewardDatasets,
          protocol,
        })
      : null;

    const { writes: datasetWrites, onDatasetSave } = createDatasetWriteCollector();
    const { toolErrors, recordToolError } = createToolErrorCollector(
      "general-orchestration-daemon:simulate"
    );
    primaryRuntimeConfig.onToolError = recordToolError;
    environmentRuntimeConfig.onToolError = recordToolError;
    if (sourceToTargetRewardRuntimeConfig) {
      sourceToTargetRewardRuntimeConfig.onToolError = recordToolError;
    }
    if (targetToSourceRewardRuntimeConfig) {
      targetToSourceRewardRuntimeConfig.onToolError = recordToolError;
    }
    const needsDatasetContext =
      compiledToolsNeedDatasetContext(primaryRuntimeConfig.toolsByName) ||
      compiledToolsNeedDatasetContext(environmentRuntimeConfig.toolsByName) ||
      (sourceToTargetRewardRuntimeConfig
        ? compiledToolsNeedDatasetContext(sourceToTargetRewardRuntimeConfig.toolsByName)
        : false) ||
      (targetToSourceRewardRuntimeConfig
        ? compiledToolsNeedDatasetContext(targetToSourceRewardRuntimeConfig.toolsByName)
        : false);
    if (needsDatasetContext) {
      const datasetRuntime = createDatasetToolRuntime({
        primaryDatasets: project.datasets,
        sharedDatasets,
        environmentPlayers: [
          ...graphRuntime.connectedTargets.map((target) => ({
            id: target.agent.id,
            datasets: target.agent.datasets,
          })),
          ...project.environmentPlayers.filter(
            (player) =>
              !graphRuntime.connectedTargets.some(
                (target) => target.agent.id === player.id
              )
          ),
        ],
      });
      const draftId = typeof body.draftId === "string" ? body.draftId.trim() : "";
      const userUUID = draftId ? await getRequestUserUUID() : null;
      const shouldPersistDatasetWrites =
        !!userUUID &&
        !!draftId &&
        (await verifyDaemonDraftOwnership(
          createSupabaseAdminClient(),
          userUUID,
          draftId
        ));
      const dispatchContext: SimulationAgentRuntimeConfig["dispatchContext"] = {
        datasetRuntime,
        onDatasetSave,
        ...(shouldPersistDatasetWrites
          ? {
              setupTable: GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE,
              setupId: draftId,
              userId: userUUID,
            }
          : {}),
      };
      primaryRuntimeConfig.dispatchContext = dispatchContext;
      // The environment agent's dataset tools resolve its own datasets first,
      // then fall back to the draft-level ones.
      environmentRuntimeConfig.dispatchContext = {
        ...dispatchContext,
        environmentPlayerId: targetRuntime.id,
      };
      if (sourceToTargetRewardRuntimeConfig) {
        sourceToTargetRewardRuntimeConfig.dispatchContext = dispatchContext;
      }
      if (targetToSourceRewardRuntimeConfig) {
        targetToSourceRewardRuntimeConfig.dispatchContext = dispatchContext;
      }
    }
    let primaryState = buildInitialStateSnapshot(project.fields);
    let environmentState = buildInitialStateSnapshot(targetRuntime.fields);
    let latestPrimaryObservation = protocol.defaultEnvironmentObservation;
    let latestPrimaryReward = protocol.defaultEnvironmentReward;
    let latestTargetReward = protocol.defaultEnvironmentReward;
    let openingEnvironmentTurn: OpeningEnvironmentTurn | null = null;
    let primaryActiveSkillId: string | null = null;
    let environmentActiveSkillId: string | null = null;
    let interactionTerminated = false;
    let terminatedBy: RuntimeNodeTraceAgent | null = null;

    const interactions: SimulationTurn[] = [];

    const applyEnvironmentReplyToPrimaryState = (
      reply: EnvironmentStructuredReply
    ) => {
      if (reply.observation) {
        primaryState = writeInteractionStateValue(
          primaryState,
          project.fields,
          PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
          reply.observation
        );
      }
      if (reply.reward) {
        primaryState = writeInteractionStateValue(
          primaryState,
          project.fields,
          PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
          reply.reward
        );
      }
      latestPrimaryObservation =
        reply.observation || protocol.defaultEnvironmentObservation;
      latestPrimaryReward = reply.reward || protocol.defaultEnvironmentReward;
    };

    const resolveSourceToTargetReward = (args: {
      latestAction: string;
      fallbackReward: string;
    }) =>
      selectedGraphTarget
        ? runRewardAgentTurn({
            openai,
            runtimeConfig: sourceToTargetRewardRuntimeConfig,
            currentState: environmentState,
            latestAction: args.latestAction,
            connectionId: selectedGraphTarget.connection.id,
            direction: "source_to_target",
            sourceAgentId: sourceRuntime.id,
            recipientAgentId: targetRuntime.id,
            sourceState: primaryState,
            recipientState: environmentState,
            allAgentStates: buildAllAgentStateSnapshot({
              graphRuntime,
              sourceRuntime,
              targetRuntime,
              primaryState,
              environmentState,
            }),
            fallbackReward: args.fallbackReward,
          })
        : Promise.resolve(args.fallbackReward);

    const resolveTargetToSourceReward = (args: {
      latestAction: string;
      fallbackReward: string;
    }) =>
      selectedGraphTarget
        ? runRewardAgentTurn({
            openai,
            runtimeConfig: targetToSourceRewardRuntimeConfig,
            currentState: primaryState,
            latestAction: args.latestAction,
            connectionId: selectedGraphTarget.connection.id,
            direction: "target_to_source",
            sourceAgentId: targetRuntime.id,
            recipientAgentId: sourceRuntime.id,
            sourceState: environmentState,
            recipientState: primaryState,
            allAgentStates: buildAllAgentStateSnapshot({
              graphRuntime,
              sourceRuntime,
              targetRuntime,
              primaryState,
              environmentState,
            }),
            fallbackReward: args.fallbackReward,
          })
        : Promise.resolve(args.fallbackReward);

    if (simulationSettings.openingSpeaker === "environment") {
      const initialEnvironmentTurn = await runEnvironmentAgentTurn({
        openai,
        runtimeConfig: environmentRuntimeConfig,
        currentState: environmentState,
        latestPrimaryAction: "",
        latestReward: latestTargetReward,
        activeSkillId: environmentActiveSkillId,
        collectTrace: true,
      });
      environmentState = initialEnvironmentTurn.nextState;
      environmentActiveSkillId = initialEnvironmentTurn.activeSkillId;
      if (initialEnvironmentTurn.interactionTerminated) {
        interactionTerminated = true;
        terminatedBy = "environment";
      }
      const openingReply = withEnvironmentReplyDefaults(
        initialEnvironmentTurn.environmentReply,
        protocol
      );
      const openingReward = await resolveTargetToSourceReward({
        latestAction: openingReply.observation,
        fallbackReward: openingReply.reward,
      });
      openingEnvironmentTurn = {
        ...openingReply,
        reward: openingReward,
        trace: initialEnvironmentTurn.trace,
      };
      applyEnvironmentReplyToPrimaryState(openingEnvironmentTurn);
    }

    for (let turn = 1; turn <= simulationSettings.turnCount; turn += 1) {
      if (interactionTerminated) {
        break;
      }

      const primaryTurn = await runPrimaryAgentTurn({
        openai,
        runtimeConfig: primaryRuntimeConfig,
        currentState: primaryState,
        latestObservation: latestPrimaryObservation,
        latestReward: latestPrimaryReward,
        activeSkillId: primaryActiveSkillId,
        collectTrace: true,
      });
      primaryState = primaryTurn.nextState;
      primaryActiveSkillId = primaryTurn.activeSkillId;
      const primaryAction = primaryTurn.primaryAction;

      if (primaryTurn.interactionTerminated) {
        interactionTerminated = true;
        terminatedBy = "primary";
        interactions.push({
          turn,
          primaryAction,
          environmentObservation: "",
          reward: latestPrimaryReward,
          environmentNotes: "",
          primaryTrace: primaryTurn.trace,
          interactionTerminated: true,
          terminatedBy,
        });
        break;
      }

      latestTargetReward = await resolveSourceToTargetReward({
        latestAction: primaryAction,
        fallbackReward:
          primaryTurn.targetReward || protocol.defaultEnvironmentReward,
      });

      const environmentTurn = await runEnvironmentAgentTurn({
        openai,
        runtimeConfig: environmentRuntimeConfig,
        currentState: environmentState,
        latestPrimaryAction: primaryAction,
        latestReward: latestTargetReward,
        activeSkillId: environmentActiveSkillId,
        collectTrace: true,
      });
      environmentState = environmentTurn.nextState;
      environmentActiveSkillId = environmentTurn.activeSkillId;
      const rawEnvironmentReply = withEnvironmentReplyDefaults(
        environmentTurn.environmentReply,
        protocol
      );
      const primaryReward = await resolveTargetToSourceReward({
        latestAction: rawEnvironmentReply.observation,
        fallbackReward: rawEnvironmentReply.reward,
      });
      const environmentReply = {
        ...rawEnvironmentReply,
        reward: primaryReward,
      };

      applyEnvironmentReplyToPrimaryState(environmentReply);
      if (environmentTurn.interactionTerminated) {
        interactionTerminated = true;
        terminatedBy = "environment";
      }

      interactions.push({
        turn,
        primaryAction,
        environmentObservation: latestPrimaryObservation,
        reward: latestPrimaryReward,
        targetReward: latestTargetReward,
        environmentNotes: environmentReply.notes,
        primaryTrace: primaryTurn.trace,
        environmentTrace: environmentTurn.trace,
        interactionTerminated: environmentTurn.interactionTerminated,
        terminatedBy: environmentTurn.interactionTerminated ? "environment" : undefined,
      });

      if (interactionTerminated) {
        break;
      }
    }

    return NextResponse.json({
      environmentAgentLabel: targetRuntime.title,
      targetAgentLabel: targetRuntime.title,
      simulationSettings: {
        environmentPlayerId:
          simulationSettings.environmentPlayerId || targetRuntime.id,
        environmentIndex,
        connectionId: simulationSettings.connectionId,
        targetAgentId: simulationSettings.targetAgentId || targetRuntime.id,
        openingSpeaker: simulationSettings.openingSpeaker,
        turnCount: simulationSettings.turnCount,
      },
      openingEnvironmentTurn,
      turns: interactions,
      interactionTerminated,
      terminated: interactionTerminated,
      terminatedBy,
      datasetWrites,
      toolErrors,
    });
  } catch (error) {
    console.error("[general-orchestration-daemon:simulate]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to run simulation.",
      },
      { status: 500 }
    );
  }
}
