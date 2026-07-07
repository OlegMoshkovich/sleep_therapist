import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

import {
  type CanvasExecutionSourceNodeRef,
  type PromptValueSnapshot,
  type StatePromptExtractionPlan,
} from "../../../lib/canvas-hybrid-runtime";
import type { CanvasDoc } from "../../../components/canvas/types";
import { buildStructuralExecutionPlan } from "../../../lib/canvas-structural-planner";
import {
  buildConversationMemoryObservationEvent,
  formatConversationMemoryTurn,
} from "../../../lib/conversation-memory";
import {
  findOrchestrationFieldByCanonicalName,
  getMissingInteractionFieldIssues,
  PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
  syncDerivedPrompts,
  type OrchestrationField,
  type OrchestrationProject,
  type OrchestrationSkill,
} from "../../../lib/general-orchestration";
import { buildPrimaryAgentIngressPromptValues } from "../../../lib/canvas-flow-values";
import {
  parseExplicitInteractionProtocol,
  type InteractionProtocolConfig,
} from "../../../lib/interaction-protocol";
import { extractFirstJsonObject } from "../../../lib/json-object-extraction";
import {
  LIVE_SESSION_TOKEN_BUDGETS,
  resolveOpenAiApiKey,
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
import { runStateExecutionGraphWithHandlers } from "../../../lib/state-execution-graph-runtime";
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

interface LiveSessionRuntimeState {
  primaryState: StateSnapshot;
  primaryActiveSkillId?: string | null;
  interactionTerminated?: boolean;
  terminated?: boolean;
}

type LiveSessionNodeTracePhase =
  | "policy"
  | "skill_start_condition"
  | "skill_termination_condition";

interface LiveSessionNodeTraceEvent {
  agent: "primary";
  phase: LiveSessionNodeTracePhase;
  stepId: string;
  stepType: string;
  sourceNodeRefs?: CanvasExecutionSourceNodeRef[];
  toolName?: string;
  skipped?: boolean;
  interactionTerminated?: boolean;
}

function mapLivePolicyTraceStep(args: {
  phase: LiveSessionNodeTracePhase;
  step: PolicyExecutionGraphTraceStep;
}): LiveSessionNodeTraceEvent {
  return {
    agent: "primary",
    phase: args.phase,
    stepId: args.step.stepId,
    stepType: args.step.stepType,
    sourceNodeRefs: args.step.sourceNodeRefs,
    toolName: args.step.toolName,
    skipped: args.step.skipped,
    interactionTerminated: args.step.interactionTerminated,
  };
}

type LiveSessionDispatchContext = Omit<ToolDispatchContext, "toolName">;

function resolveLiveSessionUserAgentId(args: {
  requestedUserAgentId?: string;
  sourceAgentId: string;
  targetAgentIds: string[];
}): { userAgentId: string; error?: string } {
  const requested = args.requestedUserAgentId?.trim() ?? "";
  if (requested) {
    if (args.targetAgentIds.includes(requested)) {
      return { userAgentId: requested };
    }
    return {
      userAgentId: "",
      error: "Selected live-session user agent is not part of this project graph.",
    };
  }

  if (args.targetAgentIds.length === 1) {
    return { userAgentId: args.targetAgentIds[0] };
  }

  if (args.targetAgentIds.length > 1) {
    return {
      userAgentId: "",
      error:
        "Live session has multiple connected agents. Select which agent the user controls.",
    };
  }

  return { userAgentId: "external-user" };
}

type LiveSessionRuntimeConfig = OrchestrationRunRuntimeConfigBase & {
  /** Draft-level interaction protocol resolved from the visible panel data. */
  protocol: InteractionProtocolConfig;
  dispatchContext?: LiveSessionDispatchContext;
  /**
   * Builder-facing diagnostics hook: the policy graph replies with a generic
   * message on tool failure, so the raw error is reported here instead.
   */
  onToolError?: (toolName: string, error: unknown) => void;
  skills: LiveSessionSkillRuntimeConfig[];
};

interface LiveSessionSkillRuntimeConfig {
  id: string;
  name: string;
  policyExecutionSystemPrompt: string;
  policyExecutionPlan: OrchestrationRunRuntimeConfigBase["executionPlan"];
  startConditionExecutionPlan: OrchestrationRunRuntimeConfigBase["executionPlan"];
  terminationConditionExecutionPlan: OrchestrationRunRuntimeConfigBase["executionPlan"];
}

function collectSkillCanvasDocs(
  skills: OrchestrationSkill[] | undefined
): Array<CanvasDoc | null> {
  return (skills ?? []).flatMap((skill) => [
    skill.startConditionCanvases,
    skill.policyCanvases,
    skill.terminationConditionCanvases,
  ]);
}

function buildLiveSessionRuntimeConfig(
  project: OrchestrationProject,
  protocol: InteractionProtocolConfig,
  dispatchContext?: LiveSessionDispatchContext,
  onToolError?: (toolName: string, error: unknown) => void
): LiveSessionRuntimeConfig {
  const stateSchema = buildRuntimeStateSchema(project.fields);
  // The primary agent sees its own datasets first, then the draft's shared
  // datasets as fallback — mirroring tool-time resolution.
  const datasetSchemasContext = buildDatasetSchemasContext(
    mergeDatasetsForAgentContext(
      project.datasets,
      Array.isArray(project.sharedDatasets) ? project.sharedDatasets : []
    )
  );
  const skills = (project.skills ?? []).map((skill, index) => {
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
  const skillPolicyExpandPrompts = (project.skills ?? []).reduce<
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
  const skillDocs = collectSkillCanvasDocs(project.skills);
  return {
    stateSchema,
    stateUpdateSystemPrompt: appendContextToPrompt(
      project.stateUpdatePrompt,
      datasetSchemasContext
    ),
    policyExecutionSystemPrompt: appendContextToPrompt(
      project.policyPrompt,
      datasetSchemasContext
    ),
    expandSystemPromptsByKey: {
      ...buildExpandSystemPromptsByKey({
        policyCanvasDoc: project.policyCanvases,
        policyPrompt: project.policyPrompt,
      }),
      ...skillPolicyExpandPrompts,
    },
    toolsByName: compileToolsByName(
      project.statePolicyCanvases,
      project.policyCanvases,
      ...skillDocs
    ),
    executionPlan: buildStructuralExecutionPlan({
      stateSchema,
      stateCanvasDoc: project.statePolicyCanvases,
      policyCanvasDoc: project.policyCanvases,
    }),
    protocol,
    dispatchContext,
    onToolError,
    skills,
  };
}

function buildLiveSessionRewardRuntimeConfig(args: {
  fields: OrchestrationField[];
  rewardPrompt: string;
  rewardCanvasDoc: CanvasDoc | null;
  datasets: OrchestrationProject["datasets"];
  protocol: InteractionProtocolConfig;
  dispatchContext?: LiveSessionDispatchContext;
  onToolError?: (toolName: string, error: unknown) => void;
}): LiveSessionRuntimeConfig {
  const stateSchema = buildRuntimeStateSchema(args.fields);
  const datasetSchemasContext = buildDatasetSchemasContext(args.datasets);
  return {
    stateSchema,
    stateUpdateSystemPrompt: "",
    policyExecutionSystemPrompt: appendContextToPrompt(
      args.rewardPrompt,
      datasetSchemasContext
    ),
    expandSystemPromptsByKey: buildExpandSystemPromptsByKey({
      policyCanvasDoc: args.rewardCanvasDoc,
      policyPrompt: args.rewardPrompt,
    }),
    toolsByName: compileToolsByName(null, args.rewardCanvasDoc),
    executionPlan: buildStructuralExecutionPlan({
      stateSchema,
      stateCanvasDoc: null,
      policyCanvasDoc: args.rewardCanvasDoc,
    }),
    protocol: args.protocol,
    dispatchContext: args.dispatchContext,
    onToolError: args.onToolError,
    skills: [],
  };
}

function buildLiveAllAgentStateSnapshot(args: {
  graphRuntime: ProjectGraphRuntime;
  sourceRuntime: ProjectAgentRuntime;
  targetRuntime: ProjectAgentRuntime;
  primaryState: StateSnapshot;
  targetState: StateSnapshot;
}): Record<string, StateSnapshot> {
  const allAgentStates: Record<string, StateSnapshot> = {};
  args.graphRuntime.agentsById.forEach((runtime, agentId) => {
    allAgentStates[agentId] = buildInitialStateSnapshot(runtime.fields);
  });
  allAgentStates[args.sourceRuntime.id] = args.primaryState;
  allAgentStates[args.targetRuntime.id] = args.targetState;
  return allAgentStates;
}

function buildLiveRewardPromptValues(args: {
  connectionId: string;
  direction: "target_to_source";
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

function buildLiveRewardPrompt(args: {
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

function buildLiveRewardSubtreePrompt(args: {
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

function buildLiveRewardExtractionPrompt(args: {
  runtimeConfig: LiveSessionRuntimeConfig;
  state: StateSnapshot;
  fields: OrchestrationField[];
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
    args.fields
  )}\n\nReward-agent inputs (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Extract only the intermediate values needed for deterministic reward code.\nDo not return the final reward value.\nUse null for values that should not be set from the current inputs.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildLiveRewardSubtreeExtractionPrompt(args: {
  runtimeConfig: LiveSessionRuntimeConfig;
  state: StateSnapshot;
  fields: OrchestrationField[];
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
    args.fields
  )}\n\nReward-agent inputs (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Execute only the provided reward subtree instructions.\nReturn the scalar reward plus any extracted intermediate values.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildLiveRewardTransformPrompt(args: {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readLiveStringValue(
  record: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (isRecord(value)) {
      const nested = readLiveStringValue(value, ...keys);
      if (nested) {
        return nested;
      }
    }
  }
  return "";
}

function parseLiveJsonRecordCandidate(text: string): Record<string, unknown> | null {
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
        const nested = parseLiveJsonRecordCandidate(parsed);
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

function normalizeLiveRewardScalar(text: string, fallback: string): string {
  const parsed = parseLiveJsonRecordCandidate(text);
  const candidate = parsed
    ? readLiveStringValue(parsed, "reward", "scalar_reward", "value", "score")
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

async function runLiveSessionRewardCanvas(args: {
  openai: OpenAI;
  runtimeConfig: LiveSessionRuntimeConfig | null;
  fields: OrchestrationField[];
  currentState: StateSnapshot;
  latestAction: string;
  connectionId: string;
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
  const promptValues = buildLiveRewardPromptValues({
    connectionId: args.connectionId,
    direction: "target_to_source",
    latestAction: args.latestAction,
    sourceAgentId: args.sourceAgentId,
    recipientAgentId: args.recipientAgentId,
    sourceState: args.sourceState,
    recipientState: args.recipientState,
    allAgentStates: args.allAgentStates,
  });
  const runtimeContext = {
    latestUserTurn: formatConversationMemoryTurn("user", args.latestAction),
    latestObservationEvent: buildConversationMemoryObservationEvent({
      observation: args.latestAction,
      reward: args.fallbackReward,
    }),
    latestObservationAndRewardEvent: buildConversationMemoryObservationEvent({
      observation: args.latestAction,
      reward: args.fallbackReward,
    }),
  };
  const policyGraph =
    runtimeConfig.executionPlan.policy.code_plan?.execution_graph;

  const result =
    runtimeConfig.executionPlan.policy.mode !== "full_prompt" && policyGraph
      ? await runPolicyExecutionGraphWithHandlers({
          updatedState: args.currentState,
          stateSchema: runtimeConfig.stateSchema,
          graph: policyGraph,
          initialPromptValues: promptValues,
          runtimeContext,
          runFullPromptDecision: (decisionState, existingPromptValues) =>
            runPrompt(
              args.openai,
              runtimeConfig.policyExecutionSystemPrompt,
              buildLiveRewardPrompt({
                state: decisionState,
                fields: args.fields,
                rewardInstruction,
                existingPromptValues,
              }),
              LIVE_SESSION_TOKEN_BUDGETS.policyDecision
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
              buildLiveRewardSubtreePrompt({
                state: decisionState,
                fields: args.fields,
                incomingOutput: currentOutput,
                rewardInstruction,
                existingPromptValues,
              }),
              LIVE_SESSION_TOKEN_BUDGETS.policySubtree
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
              buildLiveRewardSubtreeExtractionPrompt({
                runtimeConfig,
                state: decisionState,
                fields: args.fields,
                incomingOutput: currentOutput,
                promptPlan,
                existingPromptValues,
              }),
              LIVE_SESSION_TOKEN_BUDGETS.policySubtreeExtraction
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
              buildLiveRewardTransformPrompt({
                state: decisionState,
                fields: args.fields,
                incomingOutput,
                instruction,
                existingPromptValues,
              }),
              LIVE_SESSION_TOKEN_BUDGETS.policyTransform
            ),
          runPromptExtraction: async (
            decisionState,
            promptPlan,
            existingPromptValues
          ) => {
            const reply = await runPrompt(
              args.openai,
              "",
              buildLiveRewardExtractionPrompt({
                runtimeConfig,
                state: decisionState,
                fields: args.fields,
                promptPlan,
                existingPromptValues,
              }),
              LIVE_SESSION_TOKEN_BUDGETS.policyExtraction
            );
            return parseStatePromptExtractionReply(reply, promptPlan);
          },
          runRuntimeOperation: createPolicyRuntimeOperationHandler({
            raiseErrorFallback:
              "Live-session reward canvas raised an explicit runtime error.",
            unsupportedOperation: (operation) =>
              `Live-session reward canvases do not yet support runtime_operation("${operation}").`,
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
          runExpandPrompt: (
            decisionState,
            expandLabel,
            currentOutput,
            existingPromptValues
          ) => {
            const expandPrompt =
              runtimeConfig.expandSystemPromptsByKey[
                normalizeExpandKey(expandLabel)
              ] ?? runtimeConfig.policyExecutionSystemPrompt;
            return runPrompt(
              args.openai,
              expandPrompt,
              buildLiveRewardSubtreePrompt({
                state: decisionState,
                fields: args.fields,
                incomingOutput: currentOutput,
                rewardInstruction,
                existingPromptValues,
              }),
              LIVE_SESSION_TOKEN_BUDGETS.expandPrompt
            );
          },
        })
      : {
          output: await runPrompt(
            args.openai,
            runtimeConfig.policyExecutionSystemPrompt,
            buildLiveRewardPrompt({
              state: args.currentState,
              fields: args.fields,
              rewardInstruction,
              existingPromptValues: promptValues,
            }),
            LIVE_SESSION_TOKEN_BUDGETS.policyDecision
          ),
          visibleOutput: "",
          nextState: args.currentState,
          interactionTerminated: false,
        };

  return normalizeLiveRewardScalar(
    result.visibleOutput || result.output,
    args.fallbackReward
  );
}

function normalizeKnownState(
  rawState: unknown,
  fields: OrchestrationField[]
): StateSnapshot | null {
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
    return null;
  }

  const record = rawState as Record<string, unknown>;
  return fields.reduce<StateSnapshot>((acc, field) => {
    acc[field.name] = normalizeStateValueForBlock(record[field.name], field.type);
    return acc;
  }, {});
}

function readStateFieldValue(
  state: StateSnapshot,
  fields: OrchestrationField[],
  canonicalFieldName: string
): string {
  const matchingField = fields.find(
    (field) => field.name.trim().toLowerCase() === canonicalFieldName
  );
  return matchingField ? state[matchingField.name] ?? "" : "";
}

function writeStateFieldValue(
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

function buildLiveStateUpdatePrompt(args: {
  project: OrchestrationProject;
  state: StateSnapshot;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.project.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nReturn only the full updated state JSON object.`;
}

function buildLiveStateSubtreePrompt(args: {
  project: OrchestrationProject;
  state: StateSnapshot;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.project.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nNow execute only the provided state subtree instructions.\nReturn only the full updated state JSON object and nothing else.`;
}

function buildLiveStateTransformPrompt(args: {
  project: OrchestrationProject;
  state: StateSnapshot;
  incomingOutput: string;
  instruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.project.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${
    args.incomingOutput || "(empty)"
  }\n\nState local-value transform instruction:\n${
    args.instruction
  }\n\nReturn only the transformed local value. Do not return the full state JSON object.`;
}

function buildLiveStateExtractionPrompt(args: {
  project: OrchestrationProject;
  runtimeConfig: LiveSessionRuntimeConfig;
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
  return `State flow instructions:\n${args.runtimeConfig.stateUpdateSystemPrompt}\n\nCurrent primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.project.fields
  )}\n\nCurrent ingress/local values (JSON):\n${promptValuesJson}\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Extract only the intermediate values needed for deterministic state code.\nDo not return the final updated state object.\nUse null for values that should not be set from the current ingress/local values.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildLivePolicyExecutionPrompt(args: {
  project: OrchestrationProject;
  state: StateSnapshot;
  actionInstruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.project.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\n${args.actionInstruction}`;
}

function buildLivePolicySubtreePrompt(args: {
  project: OrchestrationProject;
  state: StateSnapshot;
  incomingOutput: string;
  actionInstruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.project.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${
    args.incomingOutput || "(empty)"
  }\n\nNow execute only the provided policy subtree instructions.\n${args.actionInstruction}`;
}

function buildLivePolicyExtractionPrompt(args: {
  project: OrchestrationProject;
  runtimeConfig: LiveSessionRuntimeConfig;
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
    args.project.fields
  )}\n\nCurrent ingress/local values (JSON):\n${promptValuesJson}\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Extract only the intermediate values needed for deterministic policy code.\nDo not return the final assistant response.\nUse null for values that should not be set from the current ingress/local values.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildLivePolicySubtreeExtractionPrompt(args: {
  project: OrchestrationProject;
  runtimeConfig: LiveSessionRuntimeConfig;
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
    args.project.fields
  )}\n\nCurrent ingress/local values (JSON):\n${promptValuesJson}\n\nCurrent carried output:\n${
    args.incomingOutput || "(empty)"
  }\n\n${
    contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""
  }Execute only the provided policy subtree instructions.\nReturn the assistant reply plus any extracted intermediate values.\n\n${extractionShape}\n\nExtraction rules:\n${extractionRules}`;
}

function buildLivePolicyTransformPrompt(args: {
  project: OrchestrationProject;
  state: StateSnapshot;
  incomingOutput: string;
  instruction: string;
  existingPromptValues?: PromptValueSnapshot;
}): string {
  return `Current primary-agent state (JSON):\n${renderStateJson(
    args.state,
    args.project.fields
  )}\n\nCurrent ingress/local values (JSON):\n${formatPromptValuesJson(
    args.existingPromptValues
  )}\n\nCurrent carried output:\n${args.incomingOutput || "(empty)"}\n\nTransformation instruction:\n${args.instruction}\n\nReturn only the transformed primary agent reply.`;
}

function createLiveSessionPolicyRuntimeConfig(args: {
  runtimeConfig: LiveSessionRuntimeConfig;
  policyExecutionSystemPrompt: string;
  executionPlan: OrchestrationRunRuntimeConfigBase["executionPlan"];
}): LiveSessionRuntimeConfig {
  return {
    ...args.runtimeConfig,
    policyExecutionSystemPrompt: args.policyExecutionSystemPrompt,
    executionPlan: {
      ...args.runtimeConfig.executionPlan,
      policy: args.executionPlan.policy,
    },
  };
}

function buildLiveSkillConditionInstruction(
  skill: LiveSessionSkillRuntimeConfig,
  phase: "start" | "termination"
): string {
  const phaseLabel = phase === "start" ? "start" : "termination";
  return [
    `Evaluate the ${phaseLabel} condition for the temporally extended action "${skill.name}".`,
    `Return exactly ${SKILL_CONDITION_TRUE_OUTPUT} if the condition is true.`,
    `Return exactly ${SKILL_CONDITION_FALSE_OUTPUT} if the condition is false.`,
  ].join("\n");
}

async function resolveActiveLiveSessionSkill(args: {
  runtimeConfig: LiveSessionRuntimeConfig;
  activeSkillId: string | null;
  currentState: StateSnapshot;
  evaluateCondition: (
    skill: LiveSessionSkillRuntimeConfig,
    phase: "start" | "termination",
    currentState: StateSnapshot
  ) => Promise<boolean>;
}): Promise<LiveSessionSkillRuntimeConfig | null> {
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

  const executableSkills: LiveSessionSkillRuntimeConfig[] = [];
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
    const names = executableSkills.map((skill) => `"${skill.name}"`).join(", ");
    throw new Error(
      `Primary agent has multiple executable skills (${names}). At most one skill can execute at a time.`
    );
  }

  return executableSkills[0] ?? null;
}

async function runLiveSessionTurn(args: {
  openai: OpenAI;
  project: OrchestrationProject;
  protocol: InteractionProtocolConfig;
  currentState: StateSnapshot;
  latestObservation: string;
  latestReward: string;
  activeSkillId: string | null;
  dispatchContext?: LiveSessionDispatchContext;
  onToolError?: (toolName: string, error: unknown) => void;
}): Promise<{
  assistantMessage: string;
  nextState: StateSnapshot;
  activeSkillId: string | null;
  trace: LiveSessionNodeTraceEvent[];
  interactionTerminated: boolean;
}> {
  const runtimeConfig = buildLiveSessionRuntimeConfig(
    args.project,
    args.protocol,
    args.dispatchContext,
    args.onToolError
  );
  const ingressPromptValues = buildPrimaryAgentIngressPromptValues({
    latestObservation: args.latestObservation,
    latestReward: args.latestReward,
  });
  const turnRuntimeContext = {
    latestUserTurn: formatConversationMemoryTurn("user", args.latestObservation),
    latestObservationEvent: buildConversationMemoryObservationEvent({
      observation: args.latestObservation,
      reward: args.latestReward,
    }),
    latestObservationAndRewardEvent: buildConversationMemoryObservationEvent({
      observation: args.latestObservation,
      reward: args.latestReward,
    }),
  };

  let updatedState = args.currentState;
  let interactionTerminated = false;

  const stateGraph = runtimeConfig.executionPlan.state.code_plan?.execution_graph;
  if (
    runtimeConfig.executionPlan.state.mode === "full_prompt" ||
    !stateGraph ||
    !runtimeConfig.stateUpdateSystemPrompt.trim()
  ) {
    if (runtimeConfig.stateUpdateSystemPrompt.trim() && args.project.fields.length > 0) {
      const reply = await runPrompt(
          args.openai,
          runtimeConfig.stateUpdateSystemPrompt,
          buildLiveStateUpdatePrompt({
            project: args.project,
            state: updatedState,
            existingPromptValues: ingressPromptValues,
          }),
          LIVE_SESSION_TOKEN_BUDGETS.stateUpdate
        );
      updatedState = parseStateUpdateReply(reply, args.project.fields, updatedState);
    }
  } else {
    const stateResult = await runStateExecutionGraphWithHandlers({
      knownState: updatedState,
      stateSchema: runtimeConfig.stateSchema,
      graph: stateGraph,
      initialPromptValues: ingressPromptValues,
      runtimeContext: turnRuntimeContext,
      runFullPromptUpdate: async (currentState, existingPromptValues) => {
        const reply = await runPrompt(
          args.openai,
          runtimeConfig.stateUpdateSystemPrompt,
          buildLiveStateUpdatePrompt({
            project: args.project,
            state: currentState,
            existingPromptValues,
          }),
          LIVE_SESSION_TOKEN_BUDGETS.stateUpdate
        );
        return parseStateUpdateReply(reply, args.project.fields, currentState);
      },
      runPromptSubtreeUpdate: async (
        currentState,
        subtreePrompt,
        existingPromptValues
      ) => {
        const reply = await runPrompt(
          args.openai,
          subtreePrompt,
          buildLiveStateSubtreePrompt({
            project: args.project,
            state: currentState,
            existingPromptValues,
          }),
          LIVE_SESSION_TOKEN_BUDGETS.stateSubtreeUpdate
        );
        return parseStateUpdateReply(reply, args.project.fields, currentState);
      },
      runPromptTransform: async (
        currentState,
        incomingOutput,
        instruction,
        existingPromptValues
      ) => {
        const reply = await runPrompt(
          args.openai,
          "",
          buildLiveStateTransformPrompt({
            project: args.project,
            state: currentState,
            incomingOutput,
            instruction,
            existingPromptValues,
          }),
          LIVE_SESSION_TOKEN_BUDGETS.stateSubtreeUpdate
        );
        return reply;
      },
      runPromptExtraction: async (
        currentState,
        promptPlan,
        existingPromptValues
      ) => {
        const reply = await runPrompt(
          args.openai,
          "",
          buildLiveStateExtractionPrompt({
            project: args.project,
            runtimeConfig,
            state: currentState,
            promptPlan,
            existingPromptValues,
          }),
          LIVE_SESSION_TOKEN_BUDGETS.stateExtraction
        );
        return parseStatePromptExtractionReply(reply, promptPlan);
      },
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
  }

  if (interactionTerminated) {
    return {
      assistantMessage: "",
      nextState: updatedState,
      activeSkillId: null,
      trace: [],
      interactionTerminated: true,
    };
  }

  const runLivePolicy = async (
    policyRuntimeConfig: LiveSessionRuntimeConfig,
    currentState: StateSnapshot,
    actionInstruction = policyRuntimeConfig.protocol.liveSessionActionInstruction,
    phase: LiveSessionNodeTracePhase = "policy",
    traceTarget?: LiveSessionNodeTraceEvent[]
  ): Promise<{
    output: string;
    visibleOutput: string;
    nextState: StateSnapshot;
    interactionTerminated: boolean;
  }> => {
    const policyGraph =
      policyRuntimeConfig.executionPlan.policy.code_plan?.execution_graph;

    if (
      policyRuntimeConfig.executionPlan.policy.mode !== "full_prompt" &&
      policyGraph
    ) {
      return runPolicyExecutionGraphWithHandlers({
        updatedState: currentState,
        stateSchema: policyRuntimeConfig.stateSchema,
        graph: policyGraph,
        initialPromptValues: ingressPromptValues,
        runtimeContext: turnRuntimeContext,
        onStep: traceTarget
          ? (step) => traceTarget.push(mapLivePolicyTraceStep({ phase, step }))
          : undefined,
        runFullPromptDecision: (decisionState, existingPromptValues) =>
          runPrompt(
            args.openai,
            policyRuntimeConfig.policyExecutionSystemPrompt,
            buildLivePolicyExecutionPrompt({
              project: args.project,
              state: decisionState,
              actionInstruction,
              existingPromptValues,
            }),
            LIVE_SESSION_TOKEN_BUDGETS.policyDecision
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
            buildLivePolicySubtreePrompt({
              project: args.project,
              state: decisionState,
              incomingOutput: currentOutput,
              actionInstruction,
              existingPromptValues,
            }),
            LIVE_SESSION_TOKEN_BUDGETS.policySubtree
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
            buildLivePolicySubtreeExtractionPrompt({
              project: args.project,
              runtimeConfig: policyRuntimeConfig,
              state: decisionState,
              incomingOutput: currentOutput,
              promptPlan,
              existingPromptValues,
            }),
            LIVE_SESSION_TOKEN_BUDGETS.policySubtreeExtraction
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
            buildLivePolicyTransformPrompt({
              project: args.project,
              state: decisionState,
              incomingOutput,
              instruction,
              existingPromptValues,
            }),
            LIVE_SESSION_TOKEN_BUDGETS.policyTransform
          ),
        runPromptExtraction: async (
          decisionState,
          promptPlan,
          existingPromptValues
        ) => {
          const reply = await runPrompt(
            args.openai,
            "",
            buildLivePolicyExtractionPrompt({
              project: args.project,
              runtimeConfig: policyRuntimeConfig,
              state: decisionState,
              promptPlan,
              existingPromptValues,
            }),
            LIVE_SESSION_TOKEN_BUDGETS.policyExtraction
          );
          return parseStatePromptExtractionReply(reply, promptPlan);
        },
        runRuntimeOperation: createPolicyRuntimeOperationHandler({
          raiseErrorFallback: "Live-session policy raised an explicit runtime error.",
          unsupportedOperation: (operation) =>
            `Live sessions do not yet support runtime_operation("${operation}").`,
        }),
        runDirectTool: async (toolName, resultVariable, inputContributions) => {
          try {
            return await runDirectCanvasTool({
              toolsByName: policyRuntimeConfig.toolsByName,
              toolName,
              resultVariable,
              inputContributions,
              dispatchContext: policyRuntimeConfig.dispatchContext,
            });
          } catch (error) {
            policyRuntimeConfig.onToolError?.(toolName, error);
            throw error;
          }
        },
        runExpandPrompt: async (
          decisionState,
          expandLabel,
          currentOutput,
          existingPromptValues
        ) => {
          const expandPrompt =
            policyRuntimeConfig.expandSystemPromptsByKey[
              normalizeExpandKey(expandLabel)
            ] ?? policyRuntimeConfig.policyExecutionSystemPrompt;
          return runPrompt(
            args.openai,
            expandPrompt,
            buildLivePolicySubtreePrompt({
              project: args.project,
              state: decisionState,
              incomingOutput: currentOutput,
              actionInstruction,
              existingPromptValues,
            }),
            LIVE_SESSION_TOKEN_BUDGETS.expandPrompt
          );
        },
      });
    }

    const output = await runPrompt(
      args.openai,
      policyRuntimeConfig.policyExecutionSystemPrompt,
      buildLivePolicyExecutionPrompt({
        project: args.project,
        state: currentState,
        actionInstruction,
        existingPromptValues: ingressPromptValues,
      }),
      LIVE_SESSION_TOKEN_BUDGETS.fallbackAssistantMessage
    );
    return {
      output,
      visibleOutput: output,
      nextState: currentState,
      interactionTerminated: false,
    };
  };
  const turnTrace: LiveSessionNodeTraceEvent[] = [];
  const evaluateSkillCondition = async (
    skill: LiveSessionSkillRuntimeConfig,
    phase: "start" | "termination",
    currentState: StateSnapshot
  ) => {
    const conditionInstruction = buildLiveSkillConditionInstruction(skill, phase);
    const conditionRuntimeConfig = createLiveSessionPolicyRuntimeConfig({
      runtimeConfig,
      policyExecutionSystemPrompt: conditionInstruction,
      executionPlan:
        phase === "start"
          ? skill.startConditionExecutionPlan
          : skill.terminationConditionExecutionPlan,
    });
    const result = await runLivePolicy(
      conditionRuntimeConfig,
      currentState,
      conditionInstruction,
      phase === "start"
        ? "skill_start_condition"
        : "skill_termination_condition",
      turnTrace
    );
    return skillConditionOutputIsTrue(result.output);
  };
  const activeSkill = await resolveActiveLiveSessionSkill({
    runtimeConfig,
    activeSkillId: args.activeSkillId,
    currentState: updatedState,
    evaluateCondition: evaluateSkillCondition,
  });
  const policyRuntimeConfig = activeSkill
    ? createLiveSessionPolicyRuntimeConfig({
        runtimeConfig,
        policyExecutionSystemPrompt: activeSkill.policyExecutionSystemPrompt,
        executionPlan: activeSkill.policyExecutionPlan,
      })
    : runtimeConfig;
  const policyResult = await runLivePolicy(
    policyRuntimeConfig,
    updatedState,
    policyRuntimeConfig.protocol.liveSessionActionInstruction,
    "policy",
    turnTrace
  );
  const assistantMessage = policyResult.visibleOutput.trim();
  const nextState = assistantMessage
    ? writeStateFieldValue(
        policyResult.nextState,
        args.project.fields,
        PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
        assistantMessage
      )
    : policyResult.nextState;
  const nextActiveSkillId =
    !policyResult.interactionTerminated &&
    activeSkill &&
    !(await evaluateSkillCondition(activeSkill, "termination", nextState))
      ? activeSkill.id
      : null;

  return {
    assistantMessage,
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
      userMessage?: string;
      sessionState?: LiveSessionRuntimeState | null;
      draftId?: string;
      userAgentId?: string;
    };

    if (!body?.project) {
      return NextResponse.json(
        { error: "Expected `project` in the request body." },
        { status: 400 }
      );
    }

    const userMessage =
      typeof body.userMessage === "string" ? body.userMessage.trim() : "";
    if (!userMessage) {
      return NextResponse.json(
        { error: "Expected a non-empty `userMessage`." },
        { status: 400 }
      );
    }

    if (
      body.sessionState?.interactionTerminated === true ||
      body.sessionState?.terminated === true
    ) {
      return NextResponse.json(
        {
          error:
            "This interaction has ended. Terminate means no future turns; start a new live session to continue.",
          sessionState: {
            ...(body.sessionState ?? {}),
            interactionTerminated: true,
            terminated: true,
          },
        },
        { status: 409 }
      );
    }

    const graphRuntime = await resolveProjectAgentRuntimes({
      project: body.project,
    });
    const targetAgentIds = [
      ...graphRuntime.connectedTargets.map((target) => target.agent.id),
      ...body.project.environmentPlayers
        .map((player) => player.id.trim())
        .filter(
          (id) =>
            id &&
            !graphRuntime.connectedTargets.some((target) => target.agent.id === id)
        ),
    ];
    const userControl = resolveLiveSessionUserAgentId({
      requestedUserAgentId:
        typeof body.userAgentId === "string" ? body.userAgentId : undefined,
      sourceAgentId: graphRuntime.sourceAgentId,
      targetAgentIds,
    });
    if (userControl.error) {
      return NextResponse.json({ error: userControl.error }, { status: 400 });
    }

    const selectedGraphTarget = graphRuntime.connectedTargets.find(
      (target) => target.agent.id === userControl.userAgentId
    );
    const sourceRuntime = selectedGraphTarget
      ? applyConnectionParticipantPolicy({
          runtime: graphRuntime.sourceAgent,
          connection: selectedGraphTarget.connection,
          participant: "source",
        })
      : graphRuntime.sourceAgent;
    const project = syncDerivedPrompts(
      projectAgentRuntimeToPrimaryProject(body.project, sourceRuntime)
    );
    const parsedProtocol = parseExplicitInteractionProtocol(
      project.interactionProtocol
    );
    if (!parsedProtocol.protocol) {
      return NextResponse.json(
        {
          error: `Complete the Run Contract before starting a live session. ${parsedProtocol.issues.join(" ")}`,
        },
        { status: 400 }
      );
    }
    const protocol = parsedProtocol.protocol;
    const targetRuntime = selectedGraphTarget?.agent ?? null;
    const interactionFieldIssues = getMissingInteractionFieldIssues(
      project.fields,
      PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
      PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME
    );

    if (interactionFieldIssues.length > 0) {
      return NextResponse.json(
        {
          error: `Live sessions require the latest observation and action state fields. ${interactionFieldIssues.join(" ")}`,
        },
        { status: 400 }
      );
    }

    const knownState = writeStateFieldValue(
      normalizeKnownState(body.sessionState?.primaryState, project.fields) ??
        buildInitialStateSnapshot(project.fields),
      project.fields,
      PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
      userMessage
    );
    const fallbackLatestReward = readStateFieldValue(
      knownState,
      project.fields,
      PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME
    );
    const primaryActiveSkillId =
      typeof body.sessionState?.primaryActiveSkillId === "string" &&
      body.sessionState.primaryActiveSkillId.trim()
        ? body.sessionState.primaryActiveSkillId.trim()
        : null;

    const { writes: datasetWrites, onDatasetSave } = createDatasetWriteCollector();
    const { toolErrors, recordToolError } = createToolErrorCollector(
      "general-orchestration-daemon:live-session"
    );
    const sharedDatasets = Array.isArray(project.sharedDatasets)
      ? project.sharedDatasets
      : [];
    const targetToSourceRewardRuntimeConfig =
      selectedGraphTarget && targetRuntime
        ? buildLiveSessionRewardRuntimeConfig({
            fields: project.fields,
            rewardPrompt: selectedGraphTarget.connection.targetRewardPrompt,
            rewardCanvasDoc: selectedGraphTarget.connection.targetRewardCanvases,
            datasets: mergeDatasetsForAgentContext(
              [...project.datasets, ...targetRuntime.datasets],
              sharedDatasets
            ),
            protocol,
            onToolError: recordToolError,
          })
        : null;
    let dispatchContext: LiveSessionDispatchContext | undefined;
    const needsDatasetContext =
      compiledToolsNeedDatasetContext(
        compileToolsByName(
          project.statePolicyCanvases,
          project.policyCanvases,
          ...collectSkillCanvasDocs(project.skills)
        )
      ) ||
      (targetToSourceRewardRuntimeConfig
        ? compiledToolsNeedDatasetContext(
            targetToSourceRewardRuntimeConfig.toolsByName
          )
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
      dispatchContext = {
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
      if (targetToSourceRewardRuntimeConfig) {
        targetToSourceRewardRuntimeConfig.dispatchContext = dispatchContext;
      }
    }

    const openai = new OpenAI({ apiKey: resolveOpenAiApiKey() });
    const targetState = targetRuntime
      ? buildInitialStateSnapshot(targetRuntime.fields)
      : {};
    const latestReward =
      selectedGraphTarget && targetRuntime
        ? await runLiveSessionRewardCanvas({
            openai,
            runtimeConfig: targetToSourceRewardRuntimeConfig,
            fields: project.fields,
            currentState: knownState,
            latestAction: userMessage,
            connectionId: selectedGraphTarget.connection.id,
            sourceAgentId: targetRuntime.id,
            recipientAgentId: sourceRuntime.id,
            sourceState: targetState,
            recipientState: knownState,
            allAgentStates: buildLiveAllAgentStateSnapshot({
              graphRuntime,
              sourceRuntime,
              targetRuntime,
              primaryState: knownState,
              targetState,
            }),
            fallbackReward: fallbackLatestReward,
          })
        : fallbackLatestReward;
    const currentStateForTurn = latestReward
      ? writeStateFieldValue(
          knownState,
          project.fields,
          PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
          latestReward
        )
      : knownState;
    const {
      assistantMessage,
      nextState,
      activeSkillId,
      trace,
      interactionTerminated,
    } =
      await runLiveSessionTurn({
        openai,
        project,
        protocol,
        currentState: currentStateForTurn,
        latestObservation: userMessage,
        latestReward,
        activeSkillId: primaryActiveSkillId,
        dispatchContext,
        onToolError: recordToolError,
      });

    return NextResponse.json({
      assistantMessage,
      sessionState: {
        primaryState: nextState,
        primaryActiveSkillId: activeSkillId,
        interactionTerminated,
        terminated: interactionTerminated,
      },
      sessionControl: {
        userAgentId: userControl.userAgentId,
        modelAgentId: graphRuntime.sourceAgentId,
        interactionTerminated,
        terminated: interactionTerminated,
        controlledBy: {
          [userControl.userAgentId]: "user",
          [graphRuntime.sourceAgentId]: "model",
        },
      },
      trace,
      datasetWrites,
      toolErrors,
    });
  } catch (error) {
    console.error("[general-orchestration-daemon:live-session]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to run live session.",
      },
      { status: 500 }
    );
  }
}
