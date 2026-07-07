import { NextRequest, NextResponse } from "next/server";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { compileCanvas } from "../../components/canvas/compiler";
import type { CompiledToolDef } from "../../components/canvas/types";
import type {
  CanvasExecutionSourceNodeRef,
  PolicyRuntimeOperationName,
  PromptValueSnapshot,
  PolicyStageHandoff,
  StateExecutionGraph,
  StatePromptExtractionPlan,
  StateSnapshot,
} from "../../lib/canvas-hybrid-runtime";
import {
  runStateExecutionGraphWithHandlers,
  type StateExecutionGraphTraceStep,
} from "../../lib/state-execution-graph-runtime";
import {
  buildAsyncRuntimeJobPromptValueUpdates,
  queueRuntimeOperationJob,
  registerDaemonRuntimeOperationExecutor,
  type AsyncDaemonRuntimeOperationJobInput,
  type AsyncRuntimeOperationCompletionPayload,
} from "../../lib/async-job-runtime";
import { canRuntimeOperationQueueAsAsync } from "../../lib/canvas-async-job-config";
import {
  applyCanvasEdits,
  appendToolCanvases,
  buildCurrentBuildSnapshot,
  createEmptyOrchestrationAgentConnection,
  createEmptyOrchestrationProject,
  createRequiredEnvironmentAgentStateFieldSuggestions,
  createRequiredPrimaryAgentStateFieldSuggestions,
  ensureDatasetForTool,
  getRuntimePolicyCanvasDoc,
  getProjectWorkflowCanvasDoc,
  getWorkflowOverviewCanvasDoc,
  getWorkflowStageEdgeHandleAssignments,
  ensureRequiredEnvironmentAgentStateFields,
  ensureRequiredPrimaryAgentStateFields,
  hasStructuredOrchestrationProject,
  inspectCanvasRuleViolationsForDoc,
  makeOrchestrationId,
  mergeSuggestedDatasets,
  mergeSuggestedFields,
  slugify,
  summarizeCanvasDocForPrompt,
  summarizeProjectForPrompt,
  syncAgentConnectionDerivedPrompts,
  syncDerivedPrompts,
  syncEnvironmentPlayerDerivedPrompts,
  syncSkillDerivedPrompts,
  WORKFLOW_OVERVIEW_CANVAS_MARKER,
  WORKFLOW_OVERVIEW_CANVAS_NAME,
  createEmptyOrchestrationEnvironmentPlayer,
  findOrchestrationFieldByCanonicalName,
  PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
  REQUIRED_ENVIRONMENT_AGENT_STATE_FIELD_NAMES,
  REQUIRED_PRIMARY_AGENT_STATE_FIELD_NAMES,
  type CanvasEditAgentTarget,
  type CanvasEditSkillCanvasTarget,
  type OrchestrationCanvasEdit,
  type OrchestrationCanvasNodeRef,
  type OrchestrationAgentConnection,
  type OrchestrationAgentConnectionInvocationMode,
  type OrchestrationMessage,
  type OrchestrationProject,
  type OrchestrationSkill,
  type PolicySeed,
  type SuggestedDataset,
  type SuggestedField,
  type ToolBlueprint,
  type ToolBlueprintParam,
  type ToolBlueprintSourceType,
} from "../../lib/general-orchestration";
import {
  getCanvasRuleDefinitionsForScope,
  type CanvasRuleDefinition,
} from "../../lib/canvas-rule-registry";
import {
  loadDaemonDraftState,
  saveDaemonDraft,
} from "../../lib/general-orchestration-daemon-draft-store";
import { moveLegacyPrimaryCanvasDefaultsToSourceConnections } from "../../lib/project-agent-template-materialization";
import {
  ensureDaemonConversationProject,
  normalizeDaemonOpenQuestionsState,
  type DaemonDraftInteractionMode,
} from "../../lib/general-orchestration-daemon-drafts";
import {
  loadDaemonRuntimeConfig,
  scopeDaemonRuntimeConfigToWorkflowStage,
  type DaemonRuntimeConfig,
} from "../../lib/general-orchestration-daemon-runtime";
import {
  loadAgentTemplateVersion,
  STARTER_AGENT_TEMPLATE_ID,
  STARTER_AGENT_TEMPLATE_VERSION_ID,
  type AgentTemplateVersion,
} from "../../lib/agent-template-catalog";
import {
  DAEMON_WORKFLOW_STAGE_DEFINITIONS,
  DAEMON_WORKFLOW_STAGE_FIELD_NAME,
  GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE,
  isDaemonWorkflowStageId,
  resolveDaemonWorkflowStageId,
} from "../../lib/general-orchestration-daemon-config";
import { getRequestUserUUID } from "../../lib/admin-auth";
import {
  runPolicyExecutionGraphWithHandlers,
  type PolicyExecutionGraphTraceStep,
} from "../../lib/policy-execution-graph-runtime";
import { runAsyncJobPolicyRuntimeStep } from "../../lib/async-job-policy-runtime";
import {
  AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME,
  AGENT_LATEST_REWARD_PROMPT_VALUE_NAME,
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
} from "../../lib/canvas-flow-values";
import { createSupabaseAdminClient } from "../../lib/supabase-admin";
import {
  appendConversationMemoryAction,
  appendConversationMemoryObservationEvent,
  buildConversationMemoryObservationEvent,
  CONVERSATION_SUMMARY_FIELD_NAME,
  DEFAULT_CONVERSATION_MEMORY_LIMIT,
  formatConversationMemoryTurn,
  NEW_EVENTS_FIELD_NAME,
  resolveConversationMemoryFieldName,
} from "../../lib/conversation-memory";
import {
  FINALIZED_ASSISTANT_MESSAGE_PROMPT_VALUE_NAME,
} from "../../lib/canvas-flow-values";
import {
  APPEND_ASSISTANT_TURN_CODE_LABEL,
} from "../../lib/canvas-append-assistant-turn-code";
import {
  isRuntimeManagedStateAppendLabel,
  normalizeRuntimeManagedStateAppendLabel,
  type CanvasDoc,
  type CanvasEdgeRecord,
  type CanvasEntry,
  type CanvasNodeRecord,
} from "../../components/canvas/types";
import { NODE_EXECUTABLE_CODE_OPS_DATA_KEY } from "../../lib/canvas-node-code-ops";
import { NODE_LOCAL_INPUTS_DATA_KEY } from "../../lib/canvas-node-local-fields";
import {
  extractFirstJsonObject,
  parseJsonObject,
} from "../../lib/json-object-extraction";
import {
  DAEMON_BUILDER_MAX_COMPLETION_TOKENS,
  DAEMON_BUILDER_TOKEN_BUDGETS,
  OPENAI_MODEL,
  resolveOpenAiApiKey,
} from "../../lib/openai-config";
import {
  formatPromptValuesJson as formatPlannerPromptValuesJson,
  normalizePromptExtractionFields as normalizePlannerPromptExtractionFields,
  normalizePromptExtractionValue as normalizePlannerPromptExtractionValue,
  parseStatePromptExtractionReply as parsePlannerPromptExtractionReply,
  renderPromptExtractionFieldShape as renderPlannerPromptExtractionFieldShape,
  renderPromptExtractionInstruction as renderPlannerPromptExtractionInstruction,
  replaceStateSnapshot as replacePlannerStateSnapshot,
  runDirectCanvasTool,
} from "../../lib/orchestration-run-runtime";

/**
 * Tool handler for the daemon's own canvases. Daemon tools read and write the
 * daemon's setup row (daemon-global memory), not the conversation draft.
 */
function buildDaemonRunDirectTool(runtimeConfig: DaemonRuntimeConfig) {
  return async (
    toolName: string,
    resultVariable?: string,
    inputContributions?: unknown[]
  ) => {
    try {
      return await runDirectCanvasTool({
        toolsByName: runtimeConfig.toolsByName,
        toolName,
        resultVariable,
        inputContributions,
        dispatchContext: {
          setupTable: GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE,
          setupId: runtimeConfig.setupId,
        },
      });
    } catch (error) {
      // The compiled graph replies with a generic message on tool failure;
      // keep the raw diagnostic in the server log.
      console.error(
        `[general-orchestration-daemon] tool "${toolName}" failed:`,
        error instanceof Error ? error.message : error
      );
      throw error;
    }
  };
}
const INITIAL_CANVAS_SHAPE_MATERIALIZATION_REQUESTS_PROMPT_VALUE_NAME =
  "initial_canvas_shape_materialization_requests";
const INITIAL_CANVAS_SHAPE_MATERIALIZATION_REQUESTS_EXIST_PROMPT_VALUE_NAME =
  "initial_canvas_shape_materialization_requests_exist";
const TYPICAL_CLARIFICATION_ANSWER_CHOICE_INSTRUCTION =
  "When asking a clarification, review, approval, or boundary-selection question, include one concrete typical answer/default choice that can be chosen directly if acceptable, and say it can be revised instead.";

type SupabaseClient = ReturnType<typeof createSupabaseAdminClient>;

interface PrimarySourceTemplateDefaults {
  sourcePolicyPrompt: string;
  sourcePolicyCanvases: CanvasDoc | null;
  sourceStateUpdatePrompt: string;
  sourceStatePolicyCanvases: CanvasDoc | null;
  sourceRewardPrompt: string;
  sourceRewardCanvases: CanvasDoc | null;
}
const MATERIALIZED_INITIAL_CANVAS_STRUCTURES_PROMPT_VALUE_NAME =
  "materialized_initial_canvas_structures";
const CANVAS_RULE_DETECTION_REQUESTS_PROMPT_VALUE_NAME =
  "canvas_rule_detection_requests";
const CANVAS_RULE_DETECTED_ISSUES_PROMPT_VALUE_NAME =
  "canvas_rule_detected_issues";
const CANVAS_RULE_REPAIR_REQUESTS_PROMPT_VALUE_NAME =
  "canvas_rule_repair_requests";
const CANVAS_RULE_REPAIR_EDITS_PROMPT_VALUE_NAME =
  "canvas_rule_repair_edits";
const CANVAS_RULE_RECHECK_REQUESTS_PROMPT_VALUE_NAME =
  "canvas_rule_recheck_requests";
const CANVAS_RULE_REMAINING_ISSUES_PROMPT_VALUE_NAME =
  "canvas_rule_remaining_issues";
const CANVAS_RULE_PREFLIGHT_CHANGES_APPLIED_PROMPT_VALUE_NAME =
  "canvas_rule_preflight_changes_applied";
const CANVAS_RULE_PREFLIGHT_CHANGE_SUMMARIES_PROMPT_VALUE_NAME =
  "canvas_rule_preflight_change_summaries";
const CANVAS_RULE_REPAIR_CHANGES_APPLIED_PROMPT_VALUE_NAME =
  "canvas_rule_repair_changes_applied";
const CANVAS_RULE_REPAIR_CHANGE_SUMMARIES_PROMPT_VALUE_NAME =
  "canvas_rule_repair_change_summaries";
const CANVAS_RULE_RECHECK_CHANGE_SUMMARIES_PROMPT_VALUE_NAME =
  "canvas_rule_recheck_change_summaries";
const CANVAS_RULE_ANY_CHANGES_APPLIED_PROMPT_VALUE_NAME =
  "canvas_rule_any_changes_applied";
const MAX_SESSION_INFERRED_RULES = 8;
const MAX_IMMEDIATE_DAEMON_STAGE_HANDOFFS = 5;

type AssistantReplyIntent =
  | "ask"
  | "report_update"
  | "report_review";

interface PlannerToolRequest {
  capability: string;
  whenToCall: string;
  desiredSourceType: ToolBlueprintSourceType;
  urlHint?: string;
  saveTarget?: "knowledge" | "dataset";
  datasetName?: string;
  parameters?: ToolBlueprintParam[];
}

interface PlannerToolPlacementTool {
  capability: string;
  whenToCall: string;
  toolName?: string;
  description?: string;
  sourceType: ToolBlueprintSourceType;
  url?: string;
  parameters?: ToolBlueprintParam[];
  promoteToKnowledge?: boolean;
  saveTarget?: "knowledge" | "dataset";
  datasetName?: string;
}

interface PlannerToolPlacement {
  target: "policy" | "state";
  placement: "before" | "after";
  agentTarget?: CanvasEditAgentTarget;
  environmentAgentId?: string;
  environmentAgentIndex?: number;
  environmentAgentNumber?: number;
  environmentAgentTitle?: string;
  skillId?: string;
  skillName?: string;
  skillCanvas?: CanvasEditSkillCanvasTarget;
  canvasId?: string;
  canvasName?: string;
  anchorRef?: OrchestrationCanvasNodeRef;
  sourceRef?: OrchestrationCanvasNodeRef;
  targetRef?: OrchestrationCanvasNodeRef;
  sourceHandle?: string | null;
  edgeLabel?: string;
  label?: string;
  querySource?: string;
  tool: PlannerToolPlacementTool;
}

type PlannerSkillTarget = "primary" | "environment";

interface PlannerSkillSeed {
  target: PlannerSkillTarget;
  environmentAgentId?: string;
  environmentAgentIndex?: number;
  environmentAgentTitle?: string;
  name: string;
  startCondition: string;
  terminationCondition: string;
  policySeed?: Partial<PolicySeed> | null;
  replaceExisting?: boolean;
}

interface PlannerAgentSkillSeed {
  agentId: string;
  agentTitle?: string;
  workflowStageId?: string;
  workflowStageName?: string;
  name: string;
  startCondition: string;
  terminationCondition: string;
  policySeed?: Partial<PolicySeed> | null;
  replaceExisting?: boolean;
}

interface PlannerEnvironmentAgentSeed {
  title?: string;
  purpose?: string;
  stateFields: SuggestedField[];
  datasets: SuggestedDataset[];
  skills: PlannerSkillSeed[];
  policySeed?: Partial<PolicySeed> | null;
  initialPolicyCanvasShape?: InitialCanvasShape | null;
  initialStateCanvasShape?: InitialCanvasShape | null;
  initialPolicyCanvasStructure?: InitialCanvasStructure | null;
  initialStateCanvasStructure?: InitialCanvasStructure | null;
  stateFocus: string;
}

interface PlannerAgentConnectionSeed {
  workflowStageId?: string;
  workflowStageName?: string;
  sourceAgentId?: string;
  sourceAgentTitle?: string;
  targetAgentSharedId?: string;
  targetAgentId: string;
  targetAgentTitle?: string;
  purpose?: string;
  invocationMode: OrchestrationAgentConnectionInvocationMode;
  stateFields: SuggestedField[];
  datasets: SuggestedDataset[];
  skills: PlannerSkillSeed[];
  sourcePolicySeed?: Partial<PolicySeed> | null;
  sourceInitialPolicyCanvasShape?: InitialCanvasShape | null;
  sourceInitialPolicyCanvasStructure?: InitialCanvasStructure | null;
  sourceInitialStateCanvasShape?: InitialCanvasShape | null;
  sourceInitialStateCanvasStructure?: InitialCanvasStructure | null;
  sourceRewardSeed?: Partial<PolicySeed> | null;
  sourceInitialRewardCanvasShape?: InitialCanvasShape | null;
  sourceInitialRewardCanvasStructure?: InitialCanvasStructure | null;
  targetPolicySeed?: Partial<PolicySeed> | null;
  targetInitialPolicyCanvasShape?: InitialCanvasShape | null;
  targetInitialPolicyCanvasStructure?: InitialCanvasStructure | null;
  targetRewardSeed?: Partial<PolicySeed> | null;
  targetInitialRewardCanvasShape?: InitialCanvasShape | null;
  targetInitialRewardCanvasStructure?: InitialCanvasStructure | null;
  targetInitialStateCanvasShape?: InitialCanvasShape | null;
  targetInitialStateCanvasStructure?: InitialCanvasStructure | null;
  stateFocus: string;
}

interface PlannerAgentTemplateBindingSeed {
  agentId: string;
  templateId: string;
  templateVersionId: string;
  title?: string;
  roleContext?: string;
}

interface PlannerWorkflowStageAgent {
  agentId: string;
  agentTitle?: string;
  role?: string;
  sharedStateFields: SuggestedField[];
  stageStateFields: SuggestedField[];
}

interface PlannerWorkflowStage {
  stageId: string;
  name: string;
  purpose: string;
  entryCondition?: string;
  completionCondition?: string;
  nextStageIds: string[];
  agents: PlannerWorkflowStageAgent[];
}

interface PlannerWorkflowStagePartition {
  parentStageId: string;
  parentStageName?: string;
  canvasId?: string;
  canvasName?: string;
  purpose?: string;
  stages: PlannerWorkflowStage[];
}

interface PlannerSetup {
  title?: string;
  slug?: string;
  summary?: string;
}

type SessionInferredRuleSource =
  | "process_description"
  | "user_chat"
  | "both";

interface SessionInferredRule extends CanvasRuleDefinition {
  source: SessionInferredRuleSource;
}

type InitialCanvasShapeActionTypeHint =
  | "prompt"
  | "code"
  | "prompt_transform"
  | "display";

interface InitialCanvasShapePhaseStep {
  kind: "phase";
  title: string;
  purpose: string;
  actionTypeHint?: InitialCanvasShapeActionTypeHint;
}

interface InitialCanvasShapeDecisionStep {
  kind: "decision";
  question: string;
  whenTrue: InitialCanvasShapeStep[];
  whenFalse: InitialCanvasShapeStep[];
}

interface InitialCanvasShapeLoopStep {
  kind: "for" | "while";
  title: string;
  purpose: string;
  maxIterations?: number;
  body: InitialCanvasShapeStep[];
}

type InitialCanvasShapeStep =
  | InitialCanvasShapePhaseStep
  | InitialCanvasShapeDecisionStep
  | InitialCanvasShapeLoopStep;

interface InitialCanvasShape {
  canvasName?: string;
  notes?: string;
  startLabel: string;
  overview?: string;
  steps: InitialCanvasShapeStep[];
}

type InitialCanvasStructureActionType =
  | "prompt"
  | "code"
  | "prompt_transform"
  | "display";

interface InitialCanvasStructureActionStep {
  kind: "prompt" | "code" | "display" | "call_agent";
  label: string;
  actionType?: InitialCanvasStructureActionType;
  displayType?: "text" | "video";
  inputVariable?: string;
  outputVariable?: string;
  videoUrl?: string;
  targetAgentId?: string;
  callAgentType?: "default" | "openclaw" | "hermes";
  executionMode?: "sync" | "async";
}

interface InitialCanvasStructureTerminateStep {
  kind: "terminate";
  label?: string;
}

interface InitialCanvasStructureYieldStep {
  kind: "yield";
  label?: string;
}

interface InitialCanvasStructureContinueStep {
  kind: "continue";
  label?: string;
}

interface InitialCanvasStructureStageTerminateStep {
  kind: "terminate_stage" | "terminate_stage_immediate";
  label?: string;
  nextStageId?: string;
  nextStageName?: string;
}

interface InitialCanvasStructureConditionStep {
  kind: "condition";
  label: string;
  whenTrue: InitialCanvasStructureStep[];
  whenFalse: InitialCanvasStructureStep[];
}

interface InitialCanvasStructureLoopStep {
  kind: "for" | "while";
  label: string;
  maxIterations?: number;
  body: InitialCanvasStructureStep[];
}

type InitialCanvasStructureStep =
  | InitialCanvasStructureActionStep
  | InitialCanvasStructureConditionStep
  | InitialCanvasStructureLoopStep
  | InitialCanvasStructureYieldStep
  | InitialCanvasStructureContinueStep
  | InitialCanvasStructureStageTerminateStep
  | InitialCanvasStructureTerminateStep;

interface InitialCanvasStructure {
  canvasName?: string;
  notes?: string;
  startLabel: string;
  steps: InitialCanvasStructureStep[];
}

interface PlannerResult {
  assistantMessage: string;
  assistantReplyIntent: AssistantReplyIntent;
  status: string;
  generalDescription: string;
  setup?: PlannerSetup;
  policySeed?: Partial<PolicySeed> | null;
  initialPolicyCanvasShape?: InitialCanvasShape | null;
  initialStateCanvasShape?: InitialCanvasShape | null;
  initialPolicyCanvasStructure?: InitialCanvasStructure | null;
  initialStateCanvasStructure?: InitialCanvasStructure | null;
  workflowStages: PlannerWorkflowStage[];
  workflowStagePartitions: PlannerWorkflowStagePartition[];
  stateFields: SuggestedField[];
  datasets: SuggestedDataset[];
  agentTemplateBindings: PlannerAgentTemplateBindingSeed[];
  agentSkills: PlannerAgentSkillSeed[];
  agentConnections: PlannerAgentConnectionSeed[];
  environmentAgents: PlannerEnvironmentAgentSeed[];
  skills: PlannerSkillSeed[];
  triageQuestions: string[];
  stateFocus: string;
  toolRequests: PlannerToolRequest[];
  toolPlacements: PlannerToolPlacement[];
  canvasEdits: OrchestrationCanvasEdit[];
  replacePolicyCanvas?: boolean;
  replaceStateCanvas?: boolean;
}

interface PlannerPatchApplicationResult {
  project: OrchestrationProject;
  appliedChanges: string[];
  effectiveGeneralDescription: string;
  effectiveStatus: string;
}

interface PlannerWorkflowResult extends PlannerPatchApplicationResult {
  plan: PlannerResult;
  assistantMessage: string;
  daemonState: Record<string, unknown> | null;
  stageHandoff?: PolicyStageHandoff | null;
}

type DaemonCanvasTracePhase = "state" | "policy";

const DAEMON_CANVAS_TRACE_LOG_DIR = path.join(
  process.cwd(),
  ".tmp",
  "general-orchestration-daemon"
);
const DAEMON_CANVAS_TRACE_LOG_FILE = path.join(
  DAEMON_CANVAS_TRACE_LOG_DIR,
  "canvas-traces.jsonl"
);

interface DaemonCanvasTraceEvent {
  phase: DaemonCanvasTracePhase;
  stepId: string;
  stepType: string;
  sourceNodeRefs?: CanvasExecutionSourceNodeRef[];
  toolName?: string;
  skipped?: boolean;
  interactionTerminated?: boolean;
  stageHandoff?: PolicyStageHandoff | null;
}

function appendDaemonCanvasTraceStep(
  trace: DaemonCanvasTraceEvent[] | undefined,
  phase: DaemonCanvasTracePhase,
  step: StateExecutionGraphTraceStep | PolicyExecutionGraphTraceStep
): void {
  if (!trace) {
    return;
  }

  trace.push({
    phase,
    stepId: step.stepId,
    stepType: step.stepType,
    sourceNodeRefs: step.sourceNodeRefs,
    toolName: step.toolName,
    skipped: step.skipped,
    interactionTerminated: step.interactionTerminated,
    stageHandoff:
      "stageHandoff" in step ? step.stageHandoff ?? null : undefined,
  });
}

interface DaemonCanvasTraceResolvedNodeRef extends CanvasExecutionSourceNodeRef {
  canvasName?: string;
  nodeType?: string;
  label?: string;
}

interface DaemonCanvasTraceLogEvent
  extends Omit<DaemonCanvasTraceEvent, "sourceNodeRefs"> {
  sourceNodeRefs?: DaemonCanvasTraceResolvedNodeRef[];
}

function buildDaemonCanvasTraceNodeIndex(
  doc: CanvasDoc | null | undefined
): Map<string, Omit<DaemonCanvasTraceResolvedNodeRef, "canvasId" | "nodeId">> {
  const index = new Map<
    string,
    Omit<DaemonCanvasTraceResolvedNodeRef, "canvasId" | "nodeId">
  >();
  for (const canvas of doc?.canvases ?? []) {
    for (const node of canvas.graph.nodes) {
      index.set(`${canvas.id}:${node.id}`, {
        canvasName: canvas.name,
        nodeType: node.type,
        label: node.data.label,
      });
    }
  }
  return index;
}

function resolveDaemonCanvasTraceEvents(
  runtimeConfig: DaemonRuntimeConfig,
  canvasTrace: DaemonCanvasTraceEvent[]
): DaemonCanvasTraceLogEvent[] {
  const policyNodeIndex = buildDaemonCanvasTraceNodeIndex(
    runtimeConfig.policyCanvasDoc
  );
  const stateNodeIndex = buildDaemonCanvasTraceNodeIndex(
    runtimeConfig.stateCanvasDoc
  );

  return canvasTrace.map((event) => {
    const nodeIndex =
      event.phase === "policy" ? policyNodeIndex : stateNodeIndex;
    return {
      ...event,
      sourceNodeRefs: event.sourceNodeRefs?.map((ref) => ({
        ...ref,
        ...nodeIndex.get(`${ref.canvasId}:${ref.nodeId}`),
      })),
    };
  });
}

function truncateDaemonCanvasTraceLogText(value: string, maxLength = 4000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function buildDaemonTraceProjectSummary(project: OrchestrationProject): {
  id: string;
  title: string;
  status: string;
  hasStructuredDraft: boolean;
} {
  return {
    id: project.id,
    title: project.meta.title,
    status: project.meta.status,
    hasStructuredDraft: hasStructuredOrchestrationProject(project),
  };
}

async function writeDaemonCanvasTraceLog(args: {
  runtimeConfig: DaemonRuntimeConfig;
  draftId?: string;
  assistantMessageId: string;
  projectBefore: OrchestrationProject;
  projectAfter: OrchestrationProject;
  latestUserMessage: string;
  assistantMessage: string;
  appliedChanges: string[];
  canvasTrace: DaemonCanvasTraceEvent[];
}): Promise<void> {
  const entry = {
    schemaVersion: 1,
    loggedAt: new Date().toISOString(),
    setupId: args.runtimeConfig.setupId,
    draftId: args.draftId,
    assistantMessageId: args.assistantMessageId,
    projectBefore: buildDaemonTraceProjectSummary(args.projectBefore),
    projectAfter: buildDaemonTraceProjectSummary(args.projectAfter),
    latestUserMessage: truncateDaemonCanvasTraceLogText(args.latestUserMessage),
    assistantMessage: truncateDaemonCanvasTraceLogText(args.assistantMessage),
    appliedChanges: args.appliedChanges,
    canvasTrace: resolveDaemonCanvasTraceEvents(
      args.runtimeConfig,
      args.canvasTrace
    ),
  };

  try {
    await mkdir(DAEMON_CANVAS_TRACE_LOG_DIR, { recursive: true });
    await appendFile(
      DAEMON_CANVAS_TRACE_LOG_FILE,
      `${JSON.stringify(entry)}\n`,
      "utf8"
    );
  } catch (error) {
    console.warn(
      "[general-orchestration-daemon] failed to write canvas trace log:",
      error
    );
  }
}

interface PlannerRuntimeOperationMutableState {
  workflowProject: OrchestrationProject;
  parsedPlan: PlannerResult | null;
  patchResult: PlannerPatchApplicationResult | null;
  workflowAppliedChanges: string[];
  finalizedAssistantMessage: string | null;
  currentState: StateSnapshot;
}

interface ExecutePlannerRuntimeOperationArgs {
  openai: OpenAI;
  step: {
    operation: PolicyRuntimeOperationName;
    message?: string | null;
  };
  incomingOutput: string;
  promptValues: PromptValueSnapshot;
  messages: OrchestrationMessage[];
  runtimeConfig: DaemonRuntimeConfig;
  canonicalCurrentBuild: unknown;
  mutable: PlannerRuntimeOperationMutableState;
  parsePlannerText: (text: string) => PlannerResult;
  graphRuntimeOperations: Set<PolicyRuntimeOperationName>;
}

interface RequestBody {
  messages: Array<OrchestrationMessage & { id?: string }>;
  project: OrchestrationProject;
  draftId?: string | null;
  assistantMessageId?: string | null;
  daemonState?: Record<string, unknown> | null;
  interactionMode?: unknown;
}

function normalizeRequestInteractionMode(
  value: unknown
): DaemonDraftInteractionMode | undefined {
  return value === "chat" || value === "lazy" || value === "automated"
    ? value
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalString(value: unknown): string | undefined {
  const normalized = asString(value);
  return normalized.length > 0 ? normalized : undefined;
}

function parsePlannerDecisionExtractionReply(
  text: string,
  promptPlan: StatePromptExtractionPlan | undefined
): { output: string; promptValues: PromptValueSnapshot | null } {
  const objectText = extractFirstJsonObject(text);
  if (!objectText) {
    return {
      output: text.trim(),
      promptValues: parsePlannerPromptExtractionReply(text, promptPlan),
    };
  }

  try {
    const parsed = JSON.parse(objectText) as Record<string, unknown>;
    const assistantReplyRaw = parsed.assistant_reply;
    const plannerReply =
      typeof assistantReplyRaw === "string"
        ? normalizePlannerResult(parseJsonObject<PlannerResult>(assistantReplyRaw))
        : assistantReplyRaw && typeof assistantReplyRaw === "object" && !Array.isArray(assistantReplyRaw)
          ? normalizePlannerResult(assistantReplyRaw as PlannerResult)
          : null;
    const fields = normalizePlannerPromptExtractionFields(promptPlan);
    const promptValues =
      fields.length === 0
        ? null
        : fields.reduce<PromptValueSnapshot>((acc, field) => {
            acc[field.name] = normalizePlannerPromptExtractionValue(
              parsed[field.name],
              field.type
            );
            return acc;
          }, {});

    return {
      output: plannerReply ? serializePlannerResult(plannerReply) : text.trim(),
      promptValues,
    };
  } catch {
    return {
      output: text.trim(),
      promptValues: parsePlannerPromptExtractionReply(text, promptPlan),
    };
  }
}

function normalizePlannerStateValue(
  value: unknown,
  type: DaemonRuntimeConfig["stateSchema"][number]["type"],
  fallbackInitialValue: string
): string {
  const sourceValue =
    value === undefined ? fallbackInitialValue : value === null ? "" : value;

  if (type === "boolean") {
    if (typeof sourceValue === "boolean") {
      return sourceValue ? "true" : "false";
    }
    if (typeof sourceValue === "string") {
      const trimmed = sourceValue.trim();
      if (!trimmed || trimmed === "null") {
        return "";
      }
      if (/^(true|yes|1)$/i.test(trimmed)) {
        return "true";
      }
      if (/^(false|no|0)$/i.test(trimmed)) {
        return "false";
      }
      return trimmed;
    }
    return "";
  }

  if (type === "string[]") {
    if (Array.isArray(sourceValue)) {
      return sourceValue
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0)
        .join(", ");
    }
    if (typeof sourceValue === "string") {
      const trimmed = sourceValue.trim();
      if (!trimmed || trimmed === "null") {
        return "";
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item)).join(", ");
        }
      } catch {
        return trimmed;
      }
      return trimmed;
    }
    return "";
  }

  if (type === "integer" || type === "number") {
    if (typeof sourceValue === "number" && Number.isFinite(sourceValue)) {
      return String(sourceValue);
    }
    if (typeof sourceValue === "string") {
      const trimmed = sourceValue.trim();
      return trimmed === "null" ? "" : trimmed;
    }
    return "";
  }

  if (type === "json") {
    if (typeof sourceValue === "string") {
      const trimmed = sourceValue.trim();
      return trimmed === "null" ? "" : trimmed;
    }
    try {
      return JSON.stringify(sourceValue);
    } catch {
      return String(sourceValue);
    }
  }

  if (typeof sourceValue === "string") {
    const trimmed = sourceValue.trim();
    return trimmed === "null" ? "" : trimmed;
  }

  return String(sourceValue);
}

function buildPlannerStateSnapshot(
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null
): Record<string, string> {
  return runtimeConfig.stateSchema.reduce<Record<string, string>>((acc, field) => {
    acc[field.fieldName] = normalizePlannerStateValue(
      daemonState?.[field.fieldName],
      field.type,
      field.initialValue
    );
    return acc;
  }, {});
}

function buildSeedDaemonStateSnapshot(
  runtimeConfig: DaemonRuntimeConfig,
  canonicalCurrentBuild: unknown,
  existingDaemonState: Record<string, unknown> | null
): StateSnapshot {
  return runtimeConfig.stateSchema.reduce<StateSnapshot>((acc, field) => {
    acc[field.fieldName] =
      field.fieldName === "current_build"
        ? normalizePlannerStateValue(
            canonicalCurrentBuild,
            field.type,
            field.initialValue
          )
        : normalizePlannerStateValue(
            existingDaemonState?.[field.fieldName],
            field.type,
            field.initialValue
          );
    return acc;
  }, {});
}

function appendMessagesToDaemonConversationState(
  stateSnapshot: StateSnapshot,
  messages: OrchestrationMessage[]
): StateSnapshot {
  const memoryFieldName = resolveConversationMemoryFieldName(
    Object.keys(stateSnapshot)
  );
  if (!memoryFieldName) {
    return stateSnapshot;
  }

  let nextRecentConversation = stateSnapshot[memoryFieldName] ?? "";

  for (const message of messages) {
    nextRecentConversation =
      message.role === "assistant"
        ? appendConversationMemoryAction(
            nextRecentConversation,
            message.content
          )
        : appendConversationMemoryObservationEvent(
            nextRecentConversation,
            message.content
          );
  }

  return {
    ...stateSnapshot,
    [memoryFieldName]: nextRecentConversation,
    [CONVERSATION_SUMMARY_FIELD_NAME]:
      stateSnapshot[CONVERSATION_SUMMARY_FIELD_NAME] ?? "",
  };
}

function setDaemonStateFieldIfPresent(args: {
  stateSnapshot: StateSnapshot;
  runtimeConfig: DaemonRuntimeConfig;
  fieldName: string;
  value: unknown;
}): StateSnapshot {
  const field = args.runtimeConfig.stateSchema.find(
    (entry) => entry.fieldName === args.fieldName
  );
  if (!field) {
    return args.stateSnapshot;
  }

  return {
    ...args.stateSnapshot,
    [args.fieldName]: normalizePlannerStateValue(
      args.value,
      field.type,
      field.initialValue
    ),
  };
}

function applyLatestUserIngressToDaemonState(
  stateSnapshot: StateSnapshot,
  runtimeConfig: DaemonRuntimeConfig,
  latestUserMessage: string
): StateSnapshot {
  const latestObservation = latestUserMessage.trim();
  if (!latestObservation) {
    return stateSnapshot;
  }

  const withObservation = setDaemonStateFieldIfPresent({
    stateSnapshot,
    runtimeConfig,
    fieldName: PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
    value: latestObservation,
  });
  const withReward = setDaemonStateFieldIfPresent({
    stateSnapshot: withObservation,
    runtimeConfig,
    fieldName: PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
    value: null,
  });

  return withReward;
}

function deserializeDaemonStateValue(
  value: string,
  type: DaemonRuntimeConfig["stateSchema"][number]["type"]
): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return type === "string[]" ? [] : null;
  }

  if (type === "boolean") {
    return /^(true|yes|1)$/i.test(trimmed);
  }

  if (type === "integer") {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (type === "number") {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (type === "string[]") {
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (type === "json") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function deserializeDaemonStateSnapshot(
  runtimeConfig: DaemonRuntimeConfig,
  stateSnapshot: StateSnapshot,
  canonicalCurrentBuild: unknown
): Record<string, unknown> {
  return runtimeConfig.stateSchema.reduce<Record<string, unknown>>((acc, field) => {
    if (field.fieldName === "current_build") {
      acc[field.fieldName] = canonicalCurrentBuild;
      return acc;
    }

    acc[field.fieldName] = deserializeDaemonStateValue(
      stateSnapshot[field.fieldName] ?? "",
      field.type
    );
    return acc;
  }, {});
}

function buildDaemonStatePromptBody(args: {
  stateSnapshot: StateSnapshot;
  canonicalCurrentBuild: unknown;
}): string {
  return [
    "Canonical current_build JSON for the live target draft:",
    JSON.stringify(args.canonicalCurrentBuild, null, 2),
    "",
    "Current daemon state snapshot:",
    JSON.stringify(args.stateSnapshot, null, 2),
    "",
    "Derive the daemon's current internal orchestration state from the current state snapshot plus current_build.",
    "Treat current_build as canonical system-supplied state. Do not reinterpret or rewrite it.",
    "current_build.datasets lists seeded target-draft datasets. current_build.bootstrap_datasets lists built-in authoring inputs such as external_episodes, workflow_historical_records, and workflow_reference_materials and does not by itself imply structured_draft_exists=true.",
    "Return only the JSON state object.",
  ].join("\n");
}

function buildDaemonStateExtractionPrompt(args: {
  runtimeConfig: DaemonRuntimeConfig;
  stateSnapshot: StateSnapshot;
  canonicalCurrentBuild: unknown;
  promptPlan: StatePromptExtractionPlan | undefined;
  existingPromptValues: PromptValueSnapshot;
}): string {
  const fields = normalizePlannerPromptExtractionFields(args.promptPlan);
  const extractionShape = renderPlannerPromptExtractionInstruction(fields);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const contextPrompt =
    typeof args.promptPlan?.context_prompt === "string"
      ? args.promptPlan.context_prompt.trim()
      : "";

  return [
    "Daemon state flow instructions:",
    args.runtimeConfig.stateUpdateSystemPrompt,
    "",
    "Canonical current_build JSON for the live target draft:",
    JSON.stringify(args.canonicalCurrentBuild, null, 2),
    "",
    "Current daemon state snapshot:",
    JSON.stringify(args.stateSnapshot, null, 2),
    "",
    "Current ingress/local values (JSON):",
    formatPlannerPromptValuesJson(args.existingPromptValues),
    "",
    ...(contextPrompt ? ["Focused subtree or node context:", contextPrompt, ""] : []),
    "Extract only the intermediate values needed for deterministic daemon state code.",
    "Do not return the final updated daemon state object.",
    "Treat current_build as canonical system-supplied state. Do not reinterpret or rewrite it.",
    "Use null for values that should not be set from the current ingress/local values.",
    "",
    extractionShape,
    "",
    "Extraction rules:",
    extractionRules,
  ].join("\n");
}

function parseDaemonStateReplyToSnapshot(args: {
  text: string;
  runtimeConfig: DaemonRuntimeConfig;
  fallbackState: StateSnapshot;
  canonicalCurrentBuild: unknown;
}): StateSnapshot {
  const parsed = parseJsonObject<Record<string, unknown>>(args.text);

  return args.runtimeConfig.stateSchema.reduce<StateSnapshot>((acc, field) => {
    if (field.fieldName === "current_build") {
      acc[field.fieldName] = normalizePlannerStateValue(
        args.canonicalCurrentBuild,
        field.type,
        field.initialValue
      );
      return acc;
    }

    acc[field.fieldName] = normalizePlannerStateValue(
      parsed?.[field.fieldName],
      field.type,
      args.fallbackState[field.fieldName] ?? field.initialValue
    );
    return acc;
  }, {});
}

async function deriveDaemonConversationState(
  openai: OpenAI,
  runtimeConfig: DaemonRuntimeConfig,
  project: OrchestrationProject,
  messages: OrchestrationMessage[],
  persistedDaemonState: Record<string, unknown> | null = null,
  canvasTrace?: DaemonCanvasTraceEvent[]
): Promise<Record<string, unknown> | null> {
  const currentBuild = buildCurrentBuildSnapshot(project);
  const latestUserMessage = getLatestUserMessage(messages);

  if (runtimeConfig.stateSchema.length === 0) {
    return {
      current_build: currentBuild,
    };
  }

  const initialStateSnapshot = buildSeedDaemonStateSnapshot(
    runtimeConfig,
    currentBuild,
    persistedDaemonState
  );
  const shouldReplayHistoricalMessages =
    persistedDaemonState === null ||
    Object.keys(persistedDaemonState).length === 0;
  const historicalMessages = shouldReplayHistoricalMessages
    ? messages.length > 0 && messages[messages.length - 1]?.role === "user"
      ? messages.slice(0, -1)
      : messages
    : [];
  const stateWithConversationMemory =
    historicalMessages.length > 0
      ? appendMessagesToDaemonConversationState(
          initialStateSnapshot,
          historicalMessages
        )
      : initialStateSnapshot;
  const memoryFieldName = resolveConversationMemoryFieldName(
    runtimeConfig.stateSchema.map((field) => field.fieldName)
  );
  const stateWithLatestUserTurnBase = latestUserMessage.trim()
    ? memoryFieldName
      ? {
          ...stateWithConversationMemory,
          [memoryFieldName]: appendConversationMemoryObservationEvent(
            stateWithConversationMemory[memoryFieldName] ?? "",
            latestUserMessage
          ),
        }
      : stateWithConversationMemory
    : stateWithConversationMemory;
  const stateWithLatestUserTurn = applyLatestUserIngressToDaemonState(
    stateWithLatestUserTurnBase,
    runtimeConfig,
    latestUserMessage
  );
  const stateWithLatestIngress = applyLatestUserIngressToDaemonState(
    stateWithConversationMemory,
    runtimeConfig,
    latestUserMessage
  );
  const statePlan = runtimeConfig.executionPlan.state;

  const runPromptBasedDaemonStateUpdate = async (
    stateSnapshot: StateSnapshot,
    systemPrompt: string
  ): Promise<StateSnapshot> => {
    if (!systemPrompt.trim()) {
      return stateSnapshot;
    }

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      max_completion_tokens: DAEMON_BUILDER_MAX_COMPLETION_TOKENS,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: buildDaemonStatePromptBody({
            stateSnapshot,
            canonicalCurrentBuild: currentBuild,
          }),
        },
      ],
    });

    return parseDaemonStateReplyToSnapshot({
      text: completion.choices[0]?.message?.content ?? "",
      runtimeConfig,
      fallbackState: stateSnapshot,
      canonicalCurrentBuild: currentBuild,
    });
  };

  if (statePlan.mode === "full_prompt" || !statePlan.code_plan?.execution_graph) {
    return deserializeDaemonStateSnapshot(
      runtimeConfig,
      await runPromptBasedDaemonStateUpdate(
        stateWithLatestUserTurn,
        runtimeConfig.stateUpdateSystemPrompt
      ),
      currentBuild
    );
  }

  const updatedStateResult = await runStateExecutionGraphWithHandlers({
    knownState: stateWithLatestIngress,
    stateSchema: runtimeConfig.stateSchema,
    graph: statePlan.code_plan.execution_graph as StateExecutionGraph,
    runtimeContext: {
      latestUserTurn: formatConversationMemoryTurn("user", latestUserMessage),
      latestObservationEvent: buildConversationMemoryObservationEvent({
        observation: latestUserMessage,
      }),
      latestObservationAndRewardEvent: buildConversationMemoryObservationEvent({
        observation: latestUserMessage,
        reward: "",
      }),
    },
    runFullPromptUpdate: (currentState) =>
      runPromptBasedDaemonStateUpdate(
        currentState,
        runtimeConfig.stateUpdateSystemPrompt
      ),
    runPromptSubtreeUpdate: (currentState, subtreePrompt) =>
      runPromptBasedDaemonStateUpdate(currentState, subtreePrompt),
    runPromptTransform: (currentState, incomingOutput, instruction, existingPromptValues) =>
      runPlannerPromptCompletion(
        openai,
        undefined,
        [
          "Current daemon state snapshot:",
          JSON.stringify(currentState, null, 2),
          "",
          "Current ingress/local values (JSON):",
          JSON.stringify(existingPromptValues, null, 2),
          "",
          "Current transform input value:",
          incomingOutput || "(empty)",
          "",
          "State/local value transform instruction:",
          instruction,
          "",
          "Return only the transformed value. Do not return the full state JSON.",
        ].join("\n")
      ),
    runPromptExtraction: async (
      currentState,
      promptPlan,
      existingPromptValues
    ) => {
      const extractionReply = await runPlannerPromptCompletion(
        openai,
        undefined,
        buildDaemonStateExtractionPrompt({
          runtimeConfig,
          stateSnapshot: currentState,
          canonicalCurrentBuild: currentBuild,
          promptPlan,
          existingPromptValues,
        })
      );

      return parsePlannerPromptExtractionReply(extractionReply, promptPlan);
    },
    runDirectTool: buildDaemonRunDirectTool(runtimeConfig),
    onStep: (step) => appendDaemonCanvasTraceStep(canvasTrace, "state", step),
  });

  return deserializeDaemonStateSnapshot(
    runtimeConfig,
    updatedStateResult.nextState,
    currentBuild
  );
}

function normalizeDaemonStageHandoffKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function resolveDaemonStageHandoffTarget(
  handoff: PolicyStageHandoff | null | undefined
): string | null {
  const nextStageId = handoff?.next_stage_id?.trim() ?? "";
  if (isDaemonWorkflowStageId(nextStageId)) {
    return nextStageId;
  }

  const nextStageName = handoff?.next_stage_name?.trim() ?? "";
  const targetKey = normalizeDaemonStageHandoffKey(nextStageId || nextStageName);
  if (!targetKey) {
    return null;
  }

  const matchingDefinition = DAEMON_WORKFLOW_STAGE_DEFINITIONS.find((stage) => {
    const candidates = [
      stage.id,
      stage.label,
      stage.primaryPolicyCanvasName,
      stage.primaryStateCanvasName,
      stage.environmentPolicyCanvasName,
      stage.environmentStateCanvasName,
    ];
    return candidates.some(
      (candidate) => normalizeDaemonStageHandoffKey(candidate) === targetKey
    );
  });

  return matchingDefinition?.id ?? null;
}

function applyPolicyStageHandoffToDaemonState(
  daemonState: Record<string, unknown> | null,
  handoff: PolicyStageHandoff | null | undefined
): Record<string, unknown> | null {
  if (!daemonState) {
    return daemonState;
  }

  const nextStageId = resolveDaemonStageHandoffTarget(handoff);
  if (!nextStageId) {
    return daemonState;
  }

  return {
    ...daemonState,
    [DAEMON_WORKFLOW_STAGE_FIELD_NAME]: nextStageId,
  };
}

async function executeImmediateDaemonStageState(
  openai: OpenAI,
  runtimeConfig: DaemonRuntimeConfig,
  project: OrchestrationProject,
  daemonState: Record<string, unknown> | null,
  canvasTrace?: DaemonCanvasTraceEvent[]
): Promise<Record<string, unknown> | null> {
  const currentBuild = buildCurrentBuildSnapshot(project);

  if (runtimeConfig.stateSchema.length === 0) {
    return {
      current_build: currentBuild,
    };
  }

  const startingStateSnapshot = buildSeedDaemonStateSnapshot(
    runtimeConfig,
    currentBuild,
    daemonState
  );
  const statePlan = runtimeConfig.executionPlan.state;

  const runPromptBasedDaemonStateUpdate = async (
    stateSnapshot: StateSnapshot,
    systemPrompt: string
  ): Promise<StateSnapshot> => {
    if (!systemPrompt.trim()) {
      return stateSnapshot;
    }

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      max_completion_tokens: DAEMON_BUILDER_MAX_COMPLETION_TOKENS,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: buildDaemonStatePromptBody({
            stateSnapshot,
            canonicalCurrentBuild: currentBuild,
          }),
        },
      ],
    });

    return parseDaemonStateReplyToSnapshot({
      text: completion.choices[0]?.message?.content ?? "",
      runtimeConfig,
      fallbackState: stateSnapshot,
      canonicalCurrentBuild: currentBuild,
    });
  };

  if (statePlan.mode === "full_prompt" || !statePlan.code_plan?.execution_graph) {
    return deserializeDaemonStateSnapshot(
      runtimeConfig,
      await runPromptBasedDaemonStateUpdate(
        startingStateSnapshot,
        runtimeConfig.stateUpdateSystemPrompt
      ),
      currentBuild
    );
  }

  const updatedStateResult = await runStateExecutionGraphWithHandlers({
    knownState: startingStateSnapshot,
    stateSchema: runtimeConfig.stateSchema,
    graph: statePlan.code_plan.execution_graph as StateExecutionGraph,
    runtimeContext: {
      latestObservationEvent: null,
      latestObservationAndRewardEvent: null,
    },
    runFullPromptUpdate: (currentState) =>
      runPromptBasedDaemonStateUpdate(
        currentState,
        runtimeConfig.stateUpdateSystemPrompt
      ),
    runPromptSubtreeUpdate: (currentState, subtreePrompt) =>
      runPromptBasedDaemonStateUpdate(currentState, subtreePrompt),
    runPromptTransform: (
      currentState,
      incomingOutput,
      instruction,
      existingPromptValues
    ) =>
      runPlannerPromptCompletion(
        openai,
        undefined,
        [
          "Current daemon state snapshot:",
          JSON.stringify(currentState, null, 2),
          "",
          "Current ingress/local values (JSON):",
          JSON.stringify(existingPromptValues, null, 2),
          "",
          "Current transform input value:",
          incomingOutput || "(empty)",
          "",
          "State/local value transform instruction:",
          instruction,
          "",
          "Return only the transformed value. Do not return the full state JSON.",
        ].join("\n")
      ),
    runPromptExtraction: async (
      currentState,
      promptPlan,
      existingPromptValues
    ) => {
      const extractionReply = await runPlannerPromptCompletion(
        openai,
        undefined,
        buildDaemonStateExtractionPrompt({
          runtimeConfig,
          stateSnapshot: currentState,
          canonicalCurrentBuild: currentBuild,
          promptPlan,
          existingPromptValues,
        })
      );

      return parsePlannerPromptExtractionReply(extractionReply, promptPlan);
    },
    runDirectTool: buildDaemonRunDirectTool(runtimeConfig),
    onStep: (step) => appendDaemonCanvasTraceStep(canvasTrace, "state", step),
  });

  return deserializeDaemonStateSnapshot(
    runtimeConfig,
    updatedStateResult.nextState,
    currentBuild
  );
}

function normalizeSessionInferredRuleScope(
  value: unknown
): CanvasRuleDefinition["scope"] {
  return value === "policy" ||
    value === "state" ||
    value === "workflow" ||
    value === "both"
    ? value
    : "both";
}

function normalizeSessionInferredRuleSource(
  value: unknown
): SessionInferredRuleSource {
  return value === "process_description" ||
    value === "user_chat" ||
    value === "both"
    ? value
    : "both";
}

function buildSessionInferredRuleId(
  title: string,
  description: string,
  index: number
): string {
  const slugBase = slugify(title || description)
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `session_rule_${slugBase || "rule"}_${index + 1}`;
}

function normalizeSessionInferredRule(
  value: unknown,
  index: number
): SessionInferredRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const title = asString(record.title).trim();
  const description = asString(record.description).trim() || title;
  if (!title && !description) {
    return null;
  }

  return {
    id: buildSessionInferredRuleId(title, description, index),
    title: title || description,
    scope: normalizeSessionInferredRuleScope(record.scope),
    checkMode: "rule_registry",
    description,
    repairGuidance:
      asString(record.repairGuidance).trim() ||
      `Align the draft with this active session rule: ${description}`,
    source: normalizeSessionInferredRuleSource(record.source),
  };
}

function filterSessionInferredRulesForTarget(
  rules: SessionInferredRule[],
  target?: CanvasRuleTarget
): SessionInferredRule[] {
  if (!target) {
    return rules;
  }

  return rules.filter((rule) =>
    target === "workflow"
      ? rule.scope === "workflow"
      : rule.scope === "both" || rule.scope === target
  );
}

function renderSessionInferredRulesForPrompt(
  rules: SessionInferredRule[],
  target?: CanvasRuleTarget
): string {
  const filtered = filterSessionInferredRulesForTarget(rules, target);
  if (filtered.length === 0) {
    return "- (none)";
  }

  return filtered
    .map(
      (rule) =>
        `- ${rule.id}: ${rule.title} (scope=${rule.scope}; source=${rule.source})\n  Description: ${rule.description}\n  Repair: ${rule.repairGuidance}`
    )
    .join("\n");
}

function readSessionInferredRulesFromDaemonState(
  daemonState: Record<string, unknown> | null
): SessionInferredRule[] {
  if (!daemonState) {
    return [];
  }

  const rawValue = daemonState.session_rules ?? daemonState.sessionRules;
  const rawRules = Array.isArray(rawValue)
    ? rawValue
    : typeof rawValue === "string" && rawValue.trim()
      ? (() => {
          try {
            const parsed = JSON.parse(rawValue) as unknown;
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  const dedupe = new Set<string>();

  return rawRules
    .map((entry, index) => normalizeSessionInferredRule(entry, index))
    .filter((rule): rule is SessionInferredRule => Boolean(rule))
    .filter((rule) => {
      const key = `${rule.scope}::${rule.title.toLowerCase()}::${rule.description.toLowerCase()}`;
      if (dedupe.has(key)) {
        return false;
      }
      dedupe.add(key);
      return true;
    })
    .slice(0, MAX_SESSION_INFERRED_RULES);
}

function buildRuntimeContext(
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null
): string {
  const stateSchemaLines =
    runtimeConfig.stateSchema.length > 0
      ? runtimeConfig.stateSchema
          .map(
            (field) =>
              `- ${field.fieldName} (${field.type}) initial=${field.initialValue || "null"}`
          )
          .join("\n")
      : "- (none)";

  return [
    "Configured daemon runtime:",
    "State schema:",
    stateSchemaLines,
    "",
    "Derived daemon state:",
    daemonState ? JSON.stringify(daemonState, null, 2) : "(none)",
    "",
    "Note:",
    "current_build inside daemon state is the canonical server-generated snapshot of the live draft.",
    "current_build.bootstrap_datasets contains built-in authoring inputs such as external_episodes, workflow_historical_records, and workflow_reference_materials; those inputs do not by themselves mean the target draft is already seeded.",
  ].join("\n");
}

function renderUserRequestBucketsForPrompt(
  daemonState: Record<string, unknown> | null
): string {
  const buckets: Array<{ label: string; keys: string[] }> = [
    { label: "user_requests", keys: ["user_requests"] },
    { label: "user_edit_requests", keys: ["user_edit_requests"] },
    { label: "user_tooling_requests", keys: ["user_tooling_requests"] },
    { label: "user_skill_requests", keys: ["user_skill_requests"] },
    {
      label: "user_environment_agent_requests",
      keys: ["user_environment_agent_requests"],
    },
  ];

  const lines = buckets.map(({ label, keys }) => {
    const values = readDaemonStateStringArray(daemonState, keys);
    return `- ${label}: ${values.length > 0 ? JSON.stringify(values) : "[]"}`;
  });

  return lines.join("\n");
}

function renderDraftChangeConstraintsContext(args: {
  daemonState: Record<string, unknown> | null;
  registryRules: readonly CanvasRuleDefinition[];
  sessionRules?: SessionInferredRule[];
  target?: CanvasRuleTarget;
}): string {
  const sessionRules =
    args.sessionRules ?? readSessionInferredRulesFromDaemonState(args.daemonState);
  const registryText = args.target
    ? renderCanvasRulesForPrompt(args.target, [], args.registryRules)
    : renderPlannerCanvasRuleRegistry(args.registryRules);

  return [
    "Durable daemon rule_registry:",
    registryText || "- (none)",
    "",
    "Active session-specific inferred rules:",
    renderSessionInferredRulesForPrompt(sessionRules, args.target),
    "",
    "Cumulative user requests and typed pending request queues:",
    renderUserRequestBucketsForPrompt(args.daemonState),
    "",
    "How to apply these constraints:",
    "- Apply rule_registry as durable daemon-level drafting and repair constraints.",
    "- Apply session_rules as conversation-scoped constraints inferred from confirmed process details and chat.",
    "- Treat user_requests as cumulative user-request memory, including already-applied requests; preserve those constraints and avoid regressions when changing the right-hand draft.",
    "- Treat the typed request queues as pending work subsets; satisfy, preserve, or explicitly account for them when changing the right-hand draft.",
    "- If a user_request is already fulfilled according to current_build, avoid duplicating it but do not violate it.",
    "- If constraints conflict, prefer the latest explicit user request over older session_rules while still respecting durable rule_registry constraints.",
  ].join("\n");
}

function getLatestUserMessage(messages: OrchestrationMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
}

function buildPlannerContextPrompt(
  _project: OrchestrationProject,
  _messages: OrchestrationMessage[],
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null
): string {
  const sessionRules = readSessionInferredRulesFromDaemonState(daemonState);
  return [
    buildRuntimeContext(runtimeConfig, daemonState),
    "",
    "Draft-change constraints and preferences:",
    renderDraftChangeConstraintsContext({
      daemonState,
      registryRules: runtimeConfig.canvasRuleRegistry,
      sessionRules,
    }),
  ].join("\n");
}

function buildPlannerJsonShapeLines(): string[] {
  return [
    "{",
    '  "assistantMessage": string,',
    '  "assistantReplyIntent": "ask" | "report_update" | "report_review",',
    '  "status": string,',
    '  "generalDescription": string,',
    '  "setup": { "title": string, "slug": string, "summary": string },',
    '  "policySeed": {',
    '    "canvasName": string,',
    '    "generalPrompt": string,',
    '    "clarificationGate": string,',
    '    "clarificationActions": string[],',
    '    "executionActions": string[],',
    '    "responseRule": string,',
    '    "notes": string',
    "  },",
    '  "initialPolicyCanvasShape": { "canvasName": string, "notes": string, "startLabel": string, "overview": string, "steps": CanvasShapeStep[] } | null,',
    '  "initialStateCanvasShape": { "canvasName": string, "notes": string, "startLabel": string, "overview": string, "steps": CanvasShapeStep[] } | null,',
    '  "initialPolicyCanvasStructure": { "canvasName": string, "notes": string, "startLabel": string, "steps": InitialCanvasStep[] } | null,',
    '  "initialStateCanvasStructure": { "canvasName": string, "notes": string, "startLabel": string, "steps": InitialCanvasStep[] } | null,',
    '  "workflowStages": [{ "stageId": string, "name": string, "purpose": string, "entryCondition": string, "completionCondition": string, "nextStageIds": string[], "agents": [{ "agentId": string, "agentTitle": string, "role": string, "sharedStateFields": [{ "name": string, "type": "string" | "integer" | "boolean" | "string[]" | "number" | "json", "initialValue": string }], "stageStateFields": [{ "name": string, "type": "string" | "integer" | "boolean" | "string[]" | "number" | "json", "initialValue": string }] }] }],',
    '  "workflowStagePartitions": [{ "parentStageId": string, "parentStageName": string, "canvasId": string, "canvasName": string, "purpose": string, "stages": [{ "stageId": string, "name": string, "purpose": string, "entryCondition": string, "completionCondition": string, "nextStageIds": string[], "agents": [{ "agentId": string, "agentTitle": string, "role": string, "sharedStateFields": [{ "name": string, "type": "string" | "integer" | "boolean" | "string[]" | "number" | "json", "initialValue": string }], "stageStateFields": [{ "name": string, "type": "string" | "integer" | "boolean" | "string[]" | "number" | "json", "initialValue": string }] }] }] }],',
    '  "stateFields": [{ "name": string, "type": "string" | "integer" | "boolean" | "string[]" | "number" | "json", "initialValue": string }],',
    '  "datasets": [{ "name": string, "notes": string, "columns": [{ "name": string, "type": "string" | "url" | "string[]" | "integer" | "number" | "boolean" }], "exampleRecords": object[] }],',
    '  "agentTemplateBindings": [{ "agentId": string, "templateId": string, "templateVersionId": string, "title": string, "roleContext": string }],',
    '  "agentSkills": [{ "agentId": string, "agentTitle": string, "workflowStageId": string, "workflowStageName": string, "name": string, "startCondition": string, "terminationCondition": string, "policySeed": { "canvasName": string, "generalPrompt": string, "clarificationGate": string, "clarificationActions": string[], "executionActions": string[], "responseRule": string, "notes": string }, "replaceExisting": boolean }],',
    '  "agentConnections": [{ "workflowStageId": string, "workflowStageName": string, "sourceAgentId": string, "sourceAgentTitle": string, "targetAgentSharedId": string, "targetAgentId": string, "targetAgentTitle": string, "purpose": string, "invocationMode": "sync" | "async", "stateFields": [{ "name": string, "type": "string" | "integer" | "boolean" | "string[]" | "number" | "json", "initialValue": string }], "datasets": [{ "name": string, "notes": string, "columns": [{ "name": string, "type": "string" | "url" | "string[]" | "integer" | "number" | "boolean" }], "exampleRecords": object[] }], "skills": [{ "name": string, "startCondition": string, "terminationCondition": string, "policySeed": { "canvasName": string, "generalPrompt": string, "clarificationGate": string, "clarificationActions": string[], "executionActions": string[], "responseRule": string, "notes": string }, "replaceExisting": boolean }], "stateFocus": string, "sourcePolicySeed": { "canvasName": string, "generalPrompt": string, "clarificationGate": string, "clarificationActions": string[], "executionActions": string[], "responseRule": string, "notes": string }, "sourceInitialPolicyCanvasShape": { "canvasName": string, "notes": string, "startLabel": string, "overview": string, "steps": CanvasShapeStep[] } | null, "sourceInitialPolicyCanvasStructure": { "canvasName": string, "notes": string, "startLabel": string, "steps": InitialCanvasStep[] } | null, "sourceInitialStateCanvasShape": { "canvasName": string, "notes": string, "startLabel": string, "overview": string, "steps": CanvasShapeStep[] } | null, "sourceInitialStateCanvasStructure": { "canvasName": string, "notes": string, "startLabel": string, "steps": InitialCanvasStep[] } | null, "targetPolicySeed": { "canvasName": string, "generalPrompt": string, "clarificationGate": string, "clarificationActions": string[], "executionActions": string[], "responseRule": string, "notes": string }, "targetInitialPolicyCanvasShape": { "canvasName": string, "notes": string, "startLabel": string, "overview": string, "steps": CanvasShapeStep[] } | null, "targetInitialPolicyCanvasStructure": { "canvasName": string, "notes": string, "startLabel": string, "steps": InitialCanvasStep[] } | null, "targetInitialStateCanvasShape": { "canvasName": string, "notes": string, "startLabel": string, "overview": string, "steps": CanvasShapeStep[] } | null, "targetInitialStateCanvasStructure": { "canvasName": string, "notes": string, "startLabel": string, "steps": InitialCanvasStep[] } | null }],',
    '  "triageQuestions": string[],',
    '  "stateFocus": string,',
    '  "toolRequests": [{ "capability": string, "whenToCall": string, "desiredSourceType": "http" | "rss" | "page" | "web_search" | "knowledge_save" | "dataset_read", "urlHint": string, "saveTarget": "knowledge" | "dataset", "datasetName": string, "parameters": [{ "name": string, "type": "string" | "number" | "integer" | "boolean", "description": string }] }],',
    '  "toolPlacements": [{ "target": "policy" | "state", "agentTarget": "primary" | "environment" | "both", "environmentAgentId": string, "environmentAgentIndex": number, "environmentAgentNumber": number, "environmentAgentTitle": string, "skillId": string, "skillName": string, "skillCanvas": "policy" | "start_condition" | "termination_condition", "placement": "before" | "after", "canvasId": string, "canvasName": string, "anchorRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "sourceRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "targetRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "sourceHandle": string | null, "edgeLabel": string, "label": string, "querySource": string, "tool": { "capability": string, "whenToCall": string, "toolName": string, "description": string, "sourceType": "http" | "rss" | "page" | "web_search" | "knowledge_save" | "dataset_read", "url": string, "parameters": [{ "name": string, "type": "string" | "number" | "integer" | "boolean", "description": string }], "promoteToKnowledge": boolean, "saveTarget": "knowledge" | "dataset", "datasetName": string } }],',
    '  "canvasEdits": [{ "target": "policy" | "state", "agentTarget": "primary" | "environment" | "both", "agentConnectionId": string, "targetAgentId": string, "targetAgentTitle": string, "environmentAgentId": string, "environmentAgentIndex": number, "environmentAgentNumber": number, "environmentAgentTitle": string, "skillId": string, "skillName": string, "skillCanvas": "policy" | "start_condition" | "termination_condition", "op": "add_canvas" | "rename_canvas" | "set_canvas_notes" | "set_active_canvas" | "add_node" | "insert_node_before" | "insert_node_after" | "update_node" | "delete_node" | "add_edge" | "update_edge" | "delete_edge", "canvasId": string, "canvasName": string, "nextName": string, "notes": string, "nodeKey": string, "nodeType": "start" | "condition" | "for" | "while" | "stage" | "prompt" | "code" | "tool_call" | "call_agent" | "display" | "expand" | "yield" | "continue" | "terminate_stage" | "terminate_stage_immediate" | "terminate" | "build_default_primary_state_schema" | "build_default_environment_state_schema" | "build_initial_canvas_shape_materialization_requests" | "materialize_initial_canvas_structures" | "merge_materialized_initial_canvas_structures" | "prepare_canvas_rule_detection_requests" | "build_canvas_rule_repair_requests" | "apply_canvas_rule_repairs" | "prepare_canvas_rule_recheck_requests" | "finalize_canvas_rule_repair_pass" | "apply_structured_patch" | "scaffold_tools" | "sync_derived_prompts" | "repair_canvas_rules" | "finalize_assistant_reply" | "raise_error", "label": string, "x": number, "y": number, "data": object, "nodeRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "sourceRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "targetRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "edgeId": string, "sourceHandle": string | null, "edgeLabel": string }],',
    '  "replacePolicyCanvas": boolean,',
    '  "replaceStateCanvas": boolean',
    "}",
  ];
}

function buildPlannerProtocolLines(): string[] {
  return [
    "Protocol:",
    "- The configured daemon policy in the system message is authoritative. This section only describes output format and deterministic patch mechanics.",
    "- current_build inside daemon state is the canonical server-generated snapshot of the live draft.",
    "- CanvasShapeStep may be one of: { kind: \"phase\", title: string, purpose: string, actionTypeHint?: \"prompt\" | \"code\" | \"prompt_transform\" | \"display\" }, { kind: \"decision\", question: string, whenTrue: CanvasShapeStep[], whenFalse: CanvasShapeStep[] }, or { kind: \"for\" | \"while\", title: string, purpose: string, maxIterations?: integer, body: CanvasShapeStep[] }.",
    "- InitialCanvasStep may be one of: { kind: \"prompt\" | \"code\" | \"display\" | \"call_agent\", label: string, actionType?: \"prompt\" | \"code\" | \"prompt_transform\" | \"display\", displayType?: \"text\" | \"video\", inputVariable?: string, outputVariable?: string, videoUrl?: string, targetAgentId?: string, callAgentType?: \"default\" | \"openclaw\" | \"hermes\", executionMode?: \"sync\" | \"async\" }, { kind: \"condition\", label: string, whenTrue: InitialCanvasStep[], whenFalse: InitialCanvasStep[] }, { kind: \"for\" | \"while\", label: string, maxIterations?: integer, body: InitialCanvasStep[] }, { kind: \"yield\", label?: string }, { kind: \"continue\", label?: string }, { kind: \"terminate_stage\" | \"terminate_stage_immediate\", label?: string, nextStageId?: string, nextStageName?: string }, or { kind: \"terminate\", label?: string }. Direct InitialCanvasStructure fields are still accepted as a compatibility fallback, but shape fields are preferred.",
    "- Canvas node refs may identify nodes by id, nodeKey, type, actionType, labelEquals, labelContains, or toolName.",
    "- A new node may set nodeKey so later sourceRef, targetRef, or nodeRef values in the same patch can reference it.",
    "- workflowStages creates the editable project-level workflow overview canvas. Each workflow stage becomes one editable stage node with its description, conditions, and participating agents. Do not put stage state/policy/reward logic inside the workflow overview canvas.",
    "- workflowStages must encode the temporal process in nextStageIds. If the process repeats, retries, revises, evaluates again, or returns to an earlier stage, include the earlier stage id in nextStageIds so the workflow canvas has a visible loop/back-edge. Do not describe loops only in stage text.",
    "- workflowStagePartitions creates or updates an editable child workflow canvas for a parent stage whose operation is still too broad. Each item must name parentStageId and stages; it becomes a separate workflow canvas such as \"Workflow: Intake\" and annotates the parent stage node with the child canvas name.",
    "- When process_ready=true and workflow_decomposition_complete=false, create or revise workflowStages/workflowStagePartitions only when the current workflow canvas is missing, the expert requested changes, or an approved stage genuinely needs a child workflow canvas. If the latest expert reply semantically approves the existing workflow without requesting changes, do not re-emit workflowStages to ask again, simplify, compress, or replace the approved Overall Workflow. Do not emit stateFields, policySeed, initial policy/state canvas shapes or structures, datasets, agentSkills, tools, or agentConnections before workflow decomposition is complete and agent boundaries are confirmed.",
    `- First create or revise the Overall Workflow canvas with workflowStages. After it is approved, approval freezes that canvas: inspect current_build.workflow and, if a named approved stage is still too large to depict with low-level canvas operations, emit exactly one workflowStagePartitions item for that stage and ask for approval of that child workflow canvas. Repeat recursively for oversized child stages. ${TYPICAL_CLARIFICATION_ANSWER_CHOICE_INSTRUCTION}`,
    "- If the expert gives workflow comments while workflow_decomposition_complete=false, revise the relevant workflow canvas and ask again. If the expert semantically approves the current workflow or child workflow without requesting changes, workflow_approved can become true through daemon state extraction; workflow_decomposition_complete remains false only when another named child workflow partition is actually needed. If no child partition is needed, state extraction should set workflow_decomposition_complete=true so the next visible step is agent-boundary selection.",
    "- When asking for agent boundary selection, the assistantMessage and its typical/default answer must explicitly list every participating workflow agent with one mode value: build, import_template, or user_played. A default that only confirms the agent names or says to use a two-agent boundary is incomplete and should not be treated as confirmed.",
    "- When workflow_decomposition_complete=true, agent_boundaries_confirmed=true, and structured_draft_exists=false, build the first implementation draft from current_build.workflow, agent_boundary_plan, and the confirmed process facts: state schema, state/policy canvases, datasets, guidelines, tools, agentSkills, and stage-scoped agentConnections as needed.",
    `- For agent_boundary_plan entries whose mode is import_template, emit agentTemplateBindings only when the exact templateId and templateVersionId are known from the user or current context. If an imported agent lacks a concrete catalog template/version, ask for the catalog choice instead of inventing one, and include a typical catalog choice/default template type that can be accepted or revised. ${TYPICAL_CLARIFICATION_ANSWER_CHOICE_INSTRUCTION}`,
    "- Stage-specific state/policy/reward canvases must be emitted separately through agentConnections using workflowStageId and workflowStageName. Workflow canvases are maps; the per-stage canvases are the implementation.",
    "- When emitting agentConnections, set sourceAgentId and targetAgentId from the approved workflow's agent identities whenever the direction is known; do not assume every connection originates from one privileged default agent. When the same real agent participates in multiple stages, keep a stable targetAgentSharedId for that real agent and use stage-scoped targetAgentId values when separate stage canvases are needed, for example student__evaluation and student__teaching.",
    "- Put state variables shared across stages into each stage connection's stateFields for that agent, and include stage-only variables only on the relevant stage connection.",
    "- insert_node_before and insert_node_after splice one new node around a referenced node; nodeRef is the existing anchor. For insert_node_before, optional sourceRef limits the incoming edge to reroute. For insert_node_after, optional targetRef limits the outgoing edge to reroute.",
    "- toolPlacements are normalized into tool_call node insertion edits. querySource is copied into the placed tool node data when provided.",
    "- To edit or place tools inside an existing skill, set skillId or skillName on canvasEdits/toolPlacements and optionally skillCanvas=policy/start_condition/termination_condition. Omit skillCanvas for the skill policy canvas.",
    "- For every new temporally extended skill, emit agentSkills[] with the owning workflow agentId. If the skill belongs to a stage-specific target side of an interaction, put it in the matching agentConnections[] item instead. Do not emit top-level skills[] for new behavior.",
    "- Every new agentConnections[] item represents a directional interaction contract between two workflow agents. Use sourcePolicySeed/sourceInitialPolicyCanvasShape/sourceInitialPolicyCanvasStructure for the source side's pairwise interaction policy. Use targetPolicySeed/targetInitialPolicyCanvasShape/targetInitialPolicyCanvasStructure for a built target agent's own behavior. Use sourceRewardSeed/sourceInitialRewardCanvasShape/sourceInitialRewardCanvasStructure for the scalar reward delivered to the target after a source action, and targetRewardSeed/targetInitialRewardCanvasShape/targetInitialRewardCanvasStructure for the scalar reward delivered to the source after a target action. Use targetInitialStateCanvasShape/targetInitialStateCanvasStructure for a built target agent's state canvas. Do not emit agentConnections[].policySeed or agentConnections[].initialPolicyCanvasShape; those ambiguous connection fields are not accepted.",
    "- Include target stateFields, datasets, and skills when relevant. Required connected-agent memory fields are added in code if omitted.",
    `- New state canvas structures are applied to the catalog starter state template: Code "Add agent_latest_observation and agent_latest_reward to new_events." after Start, then condition "summary plus new_events exceeds ${DEFAULT_CONVERSATION_MEMORY_LIMIT} characters", TRUE to summary-update Prompt and clear-new_events Code, with FALSE and clear paths rejoining at remaining-state update. Emit only the project-specific remaining-state behavior that belongs after that memory path; do not emit special append/summary/clear IR steps.`,
    "- New policy canvas structures are applied to the catalog starter policy template Start -> fallback action Prompt -> commit Code node -> Display node. Emit only the project-specific behavior that replaces the fallback prompt before the commit/display tail; do not emit a special append/commit IR step.",
    "- New reward canvas structures are applied to the catalog starter reward template Start -> fallback reward Prompt -> reward calculation Code node. Emit only project-specific reward reasoning or preparation behavior that replaces the fallback prompt before the final calculation Code node; do not emit a policy commit/display tail.",
    "- Do not mark starter-template nodes as runtime-managed or read-only.",
    "- update_edge can change an existing edge's kind or label; delete_edge plus add_edge can rewire endpoints.",
    "- for and while nodes are bounded control nodes. Set data.maxIterations to a small positive integer. while labels must use the normal condition syntax, and use sourceHandle=body for the repeat branch plus sourceHandle=done for the exit branch.",
    "- Tool source types must be one of: http, rss, page, web_search, knowledge_save, dataset_read.",
    "- Display nodes use nodeType=\"display\". For text display, set data.displayType=\"text\" and data.inputVariable. For video display, set data.displayType=\"video\" and data.videoUrl.",
    "- Call Agent nodes use nodeType=\"call_agent\" with data.targetAgentId, data.executionMode=\"sync\" or \"async\", and optional data.callAgentType=\"default\" | \"openclaw\" | \"hermes\". Default refers to another pairwise agent-connection policy canvas; OpenClaw and Hermes delegate to those backends.",
    "- End Turn nodes use nodeType=\"yield\" and end only the current visible turn. Use Yield when waiting for user input, job completion, or another future event.",
    "- Terminate nodes use nodeType=\"terminate\" and end the whole interaction, not just the current turn. Reaching Terminate means no future turns should occur in that live session or pairwise agent connection. Use Terminate only when the current task is complete.",
    "- Output JSON only.",
  ];
}

function normalizeAssistantReplyIntentValue(
  value: unknown
): AssistantReplyIntent | null {
  return value === "ask" ||
    value === "report_update" ||
    value === "report_review"
    ? value
    : null;
}

function normalizeFieldType(value: unknown): SuggestedField["type"] {
  return value === "integer" ||
    value === "boolean" ||
    value === "string[]" ||
    value === "number" ||
    value === "json"
    ? value
    : "string";
}

function normalizeSuggestedFieldArray(value: unknown): SuggestedField[] {
  return Array.isArray(value)
    ? value
        .map((field) => ({
          name: asString((field as Record<string, unknown> | undefined)?.name),
          type: normalizeFieldType(
            (field as Record<string, unknown> | undefined)?.type
          ),
          initialValue:
            asString(
              (field as Record<string, unknown> | undefined)?.initialValue
            ) || "null",
        }))
        .filter((field) => field.name.length > 0)
    : [];
}

function normalizeWorkflowStageId(value: string, fallbackName: string): string {
  const candidate = value.trim() || fallbackName.trim();
  const slug = slugify(candidate);
  return slug || `stage-${makeOrchestrationId().slice(0, 8)}`;
}

function normalizePlannerWorkflowStageAgent(
  value: unknown
): PlannerWorkflowStageAgent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const agentId = asString(raw.agentId ?? raw.agent_id);
  if (!agentId) {
    return null;
  }
  return {
    agentId,
    agentTitle: asOptionalString(raw.agentTitle ?? raw.agent_title),
    role: asOptionalString(raw.role),
    sharedStateFields: normalizeSuggestedFieldArray(raw.sharedStateFields),
    stageStateFields: normalizeSuggestedFieldArray(raw.stageStateFields),
  };
}

function normalizePlannerWorkflowStage(
  value: unknown,
  index: number
): PlannerWorkflowStage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const name =
    asString(raw.name ?? raw.title ?? raw.stageName ?? raw.stage_name) ||
    `Stage ${index + 1}`;
  const stageId = normalizeWorkflowStageId(
    asString(raw.stageId ?? raw.stage_id ?? raw.id),
    name
  );
  const purpose = asString(raw.purpose ?? raw.description);
  const nextStageIds = Array.isArray(raw.nextStageIds ?? raw.next_stage_ids)
    ? ((raw.nextStageIds ?? raw.next_stage_ids) as unknown[])
        .map((entry) => normalizeWorkflowStageId(asString(entry), asString(entry)))
        .filter(Boolean)
    : [];
  const agents = Array.isArray(raw.agents)
    ? raw.agents
        .map((agent) => normalizePlannerWorkflowStageAgent(agent))
        .filter((agent): agent is PlannerWorkflowStageAgent => agent !== null)
    : [];

  return {
    stageId,
    name,
    purpose,
    entryCondition: asOptionalString(
      raw.entryCondition ?? raw.entry_condition
    ),
    completionCondition: asOptionalString(
      raw.completionCondition ?? raw.completion_condition
    ),
    nextStageIds,
    agents,
  };
}

function normalizePlannerWorkflowStagePartition(
  value: unknown,
  index: number
): PlannerWorkflowStagePartition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const parentStageName = asString(
    raw.parentStageName ??
      raw.parent_stage_name ??
      raw.stageName ??
      raw.stage_name ??
      raw.name
  );
  const parentStageId = normalizeWorkflowStageId(
    asString(
      raw.parentStageId ?? raw.parent_stage_id ?? raw.stageId ?? raw.stage_id
    ),
    parentStageName || `parent-stage-${index + 1}`
  );
  const rawStages =
    raw.stages ?? raw.subStages ?? raw.sub_stages ?? raw.workflowStages;
  const stages = Array.isArray(rawStages)
    ? rawStages
        .map((stage, stageIndex) =>
          normalizePlannerWorkflowStage(stage, stageIndex)
        )
        .filter((stage): stage is PlannerWorkflowStage => stage !== null)
    : [];

  if (stages.length === 0) {
    return null;
  }

  const canvasName =
    asString(raw.canvasName ?? raw.canvas_name) ||
    `Workflow: ${parentStageName || parentStageId}`;
  const canvasId =
    slugify(asString(raw.canvasId ?? raw.canvas_id)) ||
    `workflow-${parentStageId}`;

  return {
    parentStageId,
    ...(parentStageName ? { parentStageName } : {}),
    canvasId,
    canvasName,
    ...(asOptionalString(raw.purpose ?? raw.description)
      ? { purpose: asString(raw.purpose ?? raw.description) }
      : {}),
    stages,
  };
}

function normalizeDatasetColumnType(
  value: unknown
): SuggestedDataset["columns"][number]["type"] {
  return value === "url" ||
    value === "string[]" ||
    value === "integer" ||
    value === "number" ||
    value === "boolean"
    ? value
    : "string";
}

function normalizeToolParamType(value: unknown): ToolBlueprintParam["type"] {
  return value === "number" || value === "integer" || value === "boolean"
    ? value
    : "string";
}

function normalizePlannerCanvasNodeType(value: unknown): string {
  return value === "start" ||
    value === "condition" ||
    value === "for" ||
    value === "while" ||
    value === "stage" ||
    value === "prompt" ||
    value === "code" ||
    value === "tool_call" ||
    value === "call_agent" ||
    value === "display" ||
    value === "expand" ||
    value === "yield" ||
    value === "continue" ||
    value === "terminate_stage" ||
    value === "terminate_stage_immediate" ||
    value === "terminate" ||
    value === "build_default_primary_state_schema" ||
    value === "build_default_environment_state_schema" ||
    value === "build_initial_canvas_shape_materialization_requests" ||
    value === "materialize_initial_canvas_structures" ||
    value === "merge_materialized_initial_canvas_structures" ||
    value === "prepare_canvas_rule_detection_requests" ||
    value === "build_canvas_rule_repair_requests" ||
    value === "apply_canvas_rule_repairs" ||
    value === "prepare_canvas_rule_recheck_requests" ||
    value === "finalize_canvas_rule_repair_pass" ||
    value === "apply_structured_patch" ||
    value === "scaffold_tools" ||
    value === "sync_derived_prompts" ||
    value === "repair_canvas_rules" ||
    value === "finalize_assistant_reply" ||
    value === "raise_error"
    ? value
    : "prompt";
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizePlannerCanvasDataValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizePlannerCanvasDataValue(item))
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === "object") {
    return Object.entries(value).reduce<Record<string, unknown>>((acc, [key, entry]) => {
      const sanitized = sanitizePlannerCanvasDataValue(entry);
      if (sanitized !== undefined) {
        acc[key] = sanitized;
      }
      return acc;
    }, {});
  }

  return undefined;
}

function normalizePlannerCanvasData(
  value: unknown
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const sanitized = Object.entries(value).reduce<Record<string, unknown>>((acc, [key, entry]) => {
    const normalized = sanitizePlannerCanvasDataValue(entry);
    if (normalized !== undefined) {
      acc[key] = normalized;
    }
    return acc;
  }, {});

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function normalizePlannerCanvasNodeRef(
  value: unknown
): OrchestrationCanvasNodeRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const ref = {
    nodeKey: asOptionalString((value as Record<string, unknown>).nodeKey),
    id: asOptionalString((value as Record<string, unknown>).id),
    type: asOptionalString((value as Record<string, unknown>).type),
    actionType: asOptionalString((value as Record<string, unknown>).actionType),
    labelEquals: asOptionalString((value as Record<string, unknown>).labelEquals),
    labelContains: asOptionalString((value as Record<string, unknown>).labelContains),
    toolName: asOptionalString((value as Record<string, unknown>).toolName),
  };

  return Object.values(ref).some(Boolean) ? ref : undefined;
}

function normalizePlannerCanvasAgentTarget(
  raw: Record<string, unknown>
): CanvasEditAgentTarget | undefined {
  const target = asString(
    raw.agentTarget ??
      raw.targetAgent ??
      raw.agent ??
      raw.agentScope ??
      raw.targetAgentScope
  )
    .trim()
    .toLowerCase();

  if (
    target === "primary" ||
    target === "primary_agent" ||
    target === "primary agent" ||
    target === "main" ||
    target === "main_agent" ||
    target === "main agent"
  ) {
    return "primary";
  }

  if (
    target === "environment" ||
    target === "environment_agent" ||
    target === "environment agent" ||
    target === "env" ||
    target === "env_agent" ||
    target === "env agent"
  ) {
    return "environment";
  }

  if (
    target === "both" ||
    target === "all" ||
    target === "primary_and_environment" ||
    target === "primary and environment" ||
    target === "primary_and_env" ||
    target === "primary and env"
  ) {
    return "both";
  }

  if (
    raw.environmentAgentId !== undefined ||
    raw.environmentAgentIndex !== undefined ||
    raw.environmentAgentNumber !== undefined ||
    raw.environmentAgentTitle !== undefined ||
    raw.environmentAgentName !== undefined
  ) {
    return "environment";
  }

  return undefined;
}

function normalizePlannerEnvironmentAgentIndex(
  raw: Record<string, unknown>
): number | undefined {
  return (
    normalizePlannerSkillIndex(raw.environmentAgentIndex) ??
    (() => {
      const number = normalizePlannerSkillIndex(raw.environmentAgentNumber);
      return number === undefined ? undefined : Math.max(0, number - 1);
    })()
  );
}

function normalizePlannerSkillCanvasTarget(
  raw: Record<string, unknown>
): CanvasEditSkillCanvasTarget | undefined {
  const value = asString(
    raw.skillCanvas ??
      raw.skillCanvasTarget ??
      raw.skillTargetCanvas ??
      raw.skillCanvasRole ??
      raw.skillCondition
  )
    .trim()
    .toLowerCase();

  if (
    value === "start" ||
    value === "start_condition" ||
    value === "start condition" ||
    value === "trigger" ||
    value === "trigger_condition" ||
    value === "trigger condition"
  ) {
    return "start_condition";
  }

  if (
    value === "termination" ||
    value === "termination_condition" ||
    value === "termination condition" ||
    value === "stop" ||
    value === "stop_condition" ||
    value === "stop condition" ||
    value === "end" ||
    value === "end_condition" ||
    value === "end condition"
  ) {
    return "termination_condition";
  }

  if (value === "policy" || value === "skill_policy" || value === "skill policy") {
    return "policy";
  }

  return undefined;
}

function normalizePlannerCanvasEdit(value: unknown): OrchestrationCanvasEdit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const target =
    raw.target === "workflow"
      ? "workflow"
      : raw.target === "state"
        ? "state"
        : raw.target === "policy"
          ? "policy"
          : null;
  const op =
    raw.op === "add_canvas" ||
    raw.op === "rename_canvas" ||
    raw.op === "set_canvas_notes" ||
    raw.op === "set_active_canvas" ||
    raw.op === "add_node" ||
    raw.op === "insert_node_before" ||
    raw.op === "insert_node_after" ||
    raw.op === "update_node" ||
    raw.op === "delete_node" ||
    raw.op === "add_edge" ||
    raw.op === "update_edge" ||
    raw.op === "delete_edge"
      ? raw.op
      : null;

  if (!target || !op) {
    return null;
  }

  return {
    target,
    op,
    agentTarget: normalizePlannerCanvasAgentTarget(raw),
    agentConnectionId: asOptionalString(
      raw.agentConnectionId ?? raw.connectionId
    ),
    targetAgentId: asOptionalString(raw.targetAgentId),
    targetAgentTitle: asOptionalString(raw.targetAgentTitle ?? raw.targetAgentName),
    environmentAgentId: asOptionalString(raw.environmentAgentId),
    environmentAgentIndex: normalizePlannerEnvironmentAgentIndex(raw),
    environmentAgentNumber:
      normalizePlannerSkillIndex(raw.environmentAgentNumber) === undefined
        ? undefined
        : normalizePlannerSkillIndex(raw.environmentAgentNumber),
    environmentAgentTitle: asOptionalString(
      raw.environmentAgentTitle ?? raw.environmentAgentName
    ),
    skillId: asOptionalString(raw.skillId),
    skillName: asOptionalString(raw.skillName ?? raw.skillTitle),
    skillCanvas: normalizePlannerSkillCanvasTarget(raw),
    canvasId: asOptionalString(raw.canvasId),
    canvasName: asOptionalString(raw.canvasName),
    nextName: asOptionalString(raw.nextName),
    notes: asOptionalString(raw.notes),
    nodeKey: asOptionalString(raw.nodeKey),
    nodeType:
      typeof raw.nodeType === "string"
        ? normalizePlannerCanvasNodeType(raw.nodeType)
        : undefined,
    label: raw.label === undefined ? undefined : asString(raw.label),
    x: asFiniteNumber(raw.x),
    y: asFiniteNumber(raw.y),
    data: normalizePlannerCanvasData(raw.data),
    nodeRef: normalizePlannerCanvasNodeRef(raw.nodeRef),
    sourceRef: normalizePlannerCanvasNodeRef(raw.sourceRef),
    targetRef: normalizePlannerCanvasNodeRef(raw.targetRef),
    edgeId: asOptionalString(raw.edgeId),
    sourceHandle:
      typeof raw.sourceHandle === "string" || raw.sourceHandle === null
        ? raw.sourceHandle
        : undefined,
    edgeLabel: raw.edgeLabel === undefined ? undefined : asString(raw.edgeLabel),
  };
}

function normalizePlannerToolSourceType(value: unknown): ToolBlueprintSourceType {
  return value === "rss" ||
    value === "page" ||
    value === "web_search" ||
    value === "knowledge_save" ||
    value === "dataset_read"
    ? value
    : "http";
}

function normalizePlannerToolPlacementTool(
  value: unknown
): PlannerToolPlacementTool | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const capability = asString(raw.capability);
  const toolName = asOptionalString(raw.toolName);
  const description = asOptionalString(raw.description);
  const sourceType = normalizePlannerToolSourceType(raw.sourceType);
  const parameters = Array.isArray(raw.parameters)
    ? raw.parameters
        .map((param) => ({
          name: asString(param?.name),
          type: normalizeToolParamType(param?.type),
          description: asString(param?.description),
        }))
        .filter((param) => param.name.length > 0)
    : [];

  if (!capability && !toolName && !description) {
    return null;
  }

  return {
    capability,
    whenToCall: asString(raw.whenToCall),
    toolName,
    description,
    sourceType,
    url: asOptionalString(raw.url ?? raw.urlHint),
    parameters,
    promoteToKnowledge: raw.promoteToKnowledge === true,
    saveTarget: raw.saveTarget === "dataset" ? "dataset" : "knowledge",
    datasetName: asOptionalString(raw.datasetName),
  };
}

function normalizePlannerToolPlacement(value: unknown): PlannerToolPlacement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const target = raw.target === "state" ? "state" : raw.target === "policy" ? "policy" : null;
  const placement =
    raw.placement === "after" || raw.position === "after" ? "after" : "before";
  const tool = normalizePlannerToolPlacementTool(raw.tool ?? raw);
  const anchorRef = normalizePlannerCanvasNodeRef(raw.anchorRef ?? raw.nodeRef);

  if (!target || !tool || !anchorRef) {
    return null;
  }

  return {
    target,
    placement,
    agentTarget: normalizePlannerCanvasAgentTarget(raw),
    environmentAgentId: asOptionalString(raw.environmentAgentId),
    environmentAgentIndex: normalizePlannerEnvironmentAgentIndex(raw),
    environmentAgentNumber:
      normalizePlannerSkillIndex(raw.environmentAgentNumber) === undefined
        ? undefined
        : normalizePlannerSkillIndex(raw.environmentAgentNumber),
    environmentAgentTitle: asOptionalString(
      raw.environmentAgentTitle ?? raw.environmentAgentName
    ),
    skillId: asOptionalString(raw.skillId),
    skillName: asOptionalString(raw.skillName ?? raw.skillTitle),
    skillCanvas: normalizePlannerSkillCanvasTarget(raw),
    canvasId: asOptionalString(raw.canvasId),
    canvasName: asOptionalString(raw.canvasName),
    anchorRef,
    sourceRef: normalizePlannerCanvasNodeRef(raw.sourceRef),
    targetRef: normalizePlannerCanvasNodeRef(raw.targetRef),
    sourceHandle:
      typeof raw.sourceHandle === "string" || raw.sourceHandle === null
        ? raw.sourceHandle
        : undefined,
    edgeLabel: raw.edgeLabel === undefined ? undefined : asString(raw.edgeLabel),
    label: raw.label === undefined ? undefined : asString(raw.label),
    querySource: asOptionalString(raw.querySource),
    tool,
  };
}

function normalizePlannerPolicySeedValue(
  value: unknown
): Partial<PolicySeed> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  return {
    canvasName: asString(raw.canvasName),
    generalPrompt: asString(raw.generalPrompt),
    clarificationGate: asString(raw.clarificationGate),
    clarificationActions: Array.isArray(raw.clarificationActions)
      ? raw.clarificationActions.map((action) => asString(action)).filter(Boolean)
      : [],
    executionActions: Array.isArray(raw.executionActions)
      ? raw.executionActions.map((action) => asString(action)).filter(Boolean)
      : [],
    responseRule: asString(raw.responseRule),
    notes: asString(raw.notes),
  };
}

function normalizeInitialCanvasShapeActionTypeHint(
  value: unknown
): InitialCanvasShapeActionTypeHint | undefined {
  return value === "prompt" ||
    value === "code" ||
    value === "prompt_transform" ||
    value === "display"
    ? value
    : undefined;
}

function normalizeInitialCanvasShapeStep(
  value: unknown,
  depth = 0
): InitialCanvasShapeStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const kind = asString(raw.kind);

  if (kind === "phase" || kind === "action") {
    const title =
      asString(raw.title) ||
      asString(raw.label) ||
      asString(raw.name);
    const purpose =
      asString(raw.purpose) ||
      asString(raw.description) ||
      asString(raw.details) ||
      asString(raw.label);
    return title && purpose
      ? {
          kind: "phase",
          title,
          purpose,
          actionTypeHint: normalizeInitialCanvasShapeActionTypeHint(
            raw.actionTypeHint ?? raw.actionType
          ),
        }
      : null;
  }

  if (kind === "decision" || kind === "condition") {
    const question =
      asString(raw.question) ||
      asString(raw.label) ||
      asString(raw.decision);
    const whenTrue = Array.isArray(raw.whenTrue)
      ? raw.whenTrue
          .map((step) => normalizeInitialCanvasShapeStep(step, depth + 1))
          .filter((step): step is InitialCanvasShapeStep => step !== null)
      : [];
    const whenFalse = Array.isArray(raw.whenFalse)
      ? raw.whenFalse
          .map((step) => normalizeInitialCanvasShapeStep(step, depth + 1))
          .filter((step): step is InitialCanvasShapeStep => step !== null)
      : [];
    return question
      ? {
          kind: "decision",
          question,
          whenTrue,
          whenFalse,
        }
      : null;
  }

  if (kind === "for" || kind === "while") {
    const title =
      asString(raw.title) ||
      asString(raw.label) ||
      asString(raw.name);
    const purpose =
      asString(raw.purpose) ||
      asString(raw.description) ||
      asString(raw.details) ||
      title;
    const body = Array.isArray(raw.body)
      ? raw.body
          .map((step) => normalizeInitialCanvasShapeStep(step, depth + 1))
          .filter((step): step is InitialCanvasShapeStep => step !== null)
      : [];
    const maxIterations = asFiniteNumber(raw.maxIterations);
    return title
      ? {
          kind,
          title,
          purpose,
          maxIterations:
            typeof maxIterations === "number"
              ? Math.min(Math.max(Math.trunc(maxIterations), 1), 12)
              : undefined,
          body,
        }
      : null;
  }

  return null;
}

function normalizeInitialCanvasShape(value: unknown): InitialCanvasShape | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const startLabel = asString(raw.startLabel);
  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .map((step) => normalizeInitialCanvasShapeStep(step))
        .filter((step): step is InitialCanvasShapeStep => step !== null)
    : [];

  if (!startLabel || steps.length === 0) {
    return null;
  }

  return {
    canvasName: asOptionalString(raw.canvasName),
    notes: asOptionalString(raw.notes),
    startLabel,
    overview: asOptionalString(raw.overview),
    steps,
  };
}

function normalizeInitialCanvasStructureActionType(
  value: unknown
): InitialCanvasStructureActionType | undefined {
  return value === "prompt" ||
    value === "code" ||
    value === "prompt_transform" ||
    value === "display"
    ? value
    : undefined;
}

function normalizeInitialCanvasStructureStep(
  value: unknown,
  depth = 0
): InitialCanvasStructureStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const kind = asString(raw.kind);
  if (
    kind === "action" ||
    kind === "prompt" ||
    kind === "code" ||
    kind === "display" ||
    kind === "call_agent"
  ) {
    const label = asString(raw.label);
    const actionType =
      normalizeInitialCanvasStructureActionType(raw.actionType) ??
      (kind === "code" ? "code" : kind === "display" ? "display" : "prompt");
    return label
      ? {
          kind:
            kind === "call_agent"
              ? "call_agent"
              : actionType === "code"
                ? "code"
                : actionType === "display"
                  ? "display"
                  : "prompt",
          label,
          actionType,
          displayType: raw.displayType === "video" ? "video" : "text",
          inputVariable: asOptionalString(raw.inputVariable),
          outputVariable: asOptionalString(raw.outputVariable),
          videoUrl: asOptionalString(raw.videoUrl ?? raw.url),
          targetAgentId: asOptionalString(raw.targetAgentId),
          callAgentType:
            raw.callAgentType === "openclaw" || raw.callAgentType === "hermes"
              ? raw.callAgentType
              : "default",
          executionMode: raw.executionMode === "async" ? "async" : "sync",
        }
      : null;
  }

  if (kind === "yield" || kind === "end_turn") {
    return {
      kind: "yield",
      label: asOptionalString(raw.label),
    };
  }

  if (kind === "continue" || kind === "continue_stage") {
    return {
      kind: "continue",
      label: asOptionalString(raw.label),
    };
  }

  if (
    kind === "terminate_stage" ||
    kind === "stage_terminate" ||
    kind === "end_stage" ||
    kind === "terminate_stage_immediate" ||
    kind === "stage_terminate_immediate" ||
    kind === "move_immediately"
  ) {
    return {
      kind:
        kind === "terminate_stage_immediate" ||
        kind === "stage_terminate_immediate" ||
        kind === "move_immediately"
          ? "terminate_stage_immediate"
          : "terminate_stage",
      label: asOptionalString(raw.label),
      nextStageId: asOptionalString(raw.nextStageId ?? raw.next_stage_id),
      nextStageName: asOptionalString(raw.nextStageName ?? raw.next_stage_name),
    };
  }

  if (kind === "terminate" || kind === "end") {
    return {
      kind: "terminate",
      label: asOptionalString(raw.label),
    };
  }

  if (kind === "condition") {
    const label = asString(raw.label);
    const whenTrue = Array.isArray(raw.whenTrue)
      ? raw.whenTrue
          .map((step) => normalizeInitialCanvasStructureStep(step, depth + 1))
          .filter((step): step is InitialCanvasStructureStep => step !== null)
      : [];
    const whenFalse = Array.isArray(raw.whenFalse)
      ? raw.whenFalse
          .map((step) => normalizeInitialCanvasStructureStep(step, depth + 1))
          .filter((step): step is InitialCanvasStructureStep => step !== null)
      : [];
    return label
      ? {
          kind: "condition",
          label,
          whenTrue,
          whenFalse,
        }
      : null;
  }

  if (kind === "for" || kind === "while") {
    const label = asString(raw.label);
    const body = Array.isArray(raw.body)
      ? raw.body
          .map((step) => normalizeInitialCanvasStructureStep(step, depth + 1))
          .filter((step): step is InitialCanvasStructureStep => step !== null)
      : [];
    const maxIterations = asFiniteNumber(raw.maxIterations);
    return label
      ? {
          kind,
          label,
          maxIterations:
            typeof maxIterations === "number"
              ? Math.min(Math.max(Math.trunc(maxIterations), 1), 12)
              : undefined,
          body,
        }
      : null;
  }

  return null;
}

function normalizeInitialCanvasStructure(
  value: unknown
): InitialCanvasStructure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const startLabel = asString(raw.startLabel);
  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .map((step) => normalizeInitialCanvasStructureStep(step))
        .filter((step): step is InitialCanvasStructureStep => step !== null)
    : [];

  if (!startLabel || steps.length === 0) {
    return null;
  }

  return {
    canvasName: asOptionalString(raw.canvasName),
    notes: asOptionalString(raw.notes),
    startLabel,
    steps,
  };
}

function normalizePlannerSkillIndex(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
  }

  return undefined;
}

function normalizePlannerSkillTarget(
  raw: Record<string, unknown>
): PlannerSkillTarget | null {
  const target = asString(raw.target ?? raw.agentTarget)
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (
    target === "primary" ||
    target === "primary_agent" ||
    target === "main_agent"
  ) {
    return "primary";
  }

  if (
    target === "environment" ||
    target === "environment_agent"
  ) {
    return "environment";
  }

  return null;
}

function normalizePlannerSkillSeed(
  value: unknown,
  defaultTarget?: PlannerSkillTarget
): PlannerSkillSeed | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const name = asString(raw.name ?? raw.title);
  if (!name) {
    return null;
  }

  const target = normalizePlannerSkillTarget(raw) ?? defaultTarget;
  if (!target) {
    return null;
  }
  const environmentAgentIndex =
    target === "environment"
      ? normalizePlannerSkillIndex(raw.environmentAgentIndex) ??
        (() => {
          const number = normalizePlannerSkillIndex(raw.environmentAgentNumber);
          return number === undefined ? undefined : Math.max(0, number - 1);
        })()
      : undefined;
  const startCondition =
    asString(
      raw.startCondition ??
        raw.start_condition ??
        raw.triggerCondition ??
        raw.trigger_condition
    ) || "";
  const terminationCondition =
    asString(
      raw.terminationCondition ??
        raw.termination_condition ??
        raw.stopCondition ??
        raw.stop_condition
    ) || "";

  return {
    target,
    environmentAgentId:
      target === "environment" ? asOptionalString(raw.environmentAgentId) : undefined,
    environmentAgentIndex,
    environmentAgentTitle: asOptionalString(
      target === "environment"
        ? raw.environmentAgentTitle ?? raw.environmentAgentName
        : undefined
    ),
    name,
    startCondition,
    terminationCondition,
    policySeed: normalizePlannerPolicySeedValue(raw.policySeed),
    replaceExisting: raw.replaceExisting === true,
  };
}

function normalizePlannerAgentSkillSeed(
  value: unknown
): PlannerAgentSkillSeed | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const agentId = asString(
    raw.agentId ?? raw.agent_id ?? raw.ownerAgentId ?? raw.owner_agent_id
  );
  const name = asString(raw.name ?? raw.title);
  if (!agentId || !name) {
    return null;
  }

  return {
    agentId,
    agentTitle: asOptionalString(
      raw.agentTitle ?? raw.agent_title ?? raw.ownerTitle ?? raw.owner_title
    ),
    workflowStageId: asOptionalString(
      raw.workflowStageId ?? raw.workflow_stage_id
    ),
    workflowStageName: asOptionalString(
      raw.workflowStageName ?? raw.workflow_stage_name
    ),
    name,
    startCondition:
      asString(
        raw.startCondition ??
          raw.start_condition ??
          raw.triggerCondition ??
          raw.trigger_condition
      ) || "",
    terminationCondition:
      asString(
        raw.terminationCondition ??
          raw.termination_condition ??
          raw.stopCondition ??
          raw.stop_condition
      ) || "",
    policySeed: normalizePlannerPolicySeedValue(raw.policySeed),
    replaceExisting: raw.replaceExisting === true,
  };
}

function normalizePlannerEnvironmentAgentSeed(
  value: unknown
): PlannerEnvironmentAgentSeed | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const stateFields = Array.isArray(raw.stateFields)
    ? raw.stateFields
        .map((field) => ({
          name: asString((field as Record<string, unknown> | undefined)?.name),
          type: normalizeFieldType((field as Record<string, unknown> | undefined)?.type),
          initialValue:
            asString((field as Record<string, unknown> | undefined)?.initialValue) ||
            "null",
        }))
        .filter((field) => field.name.length > 0)
    : [];

  const datasets = Array.isArray(raw.datasets)
    ? raw.datasets
        .map((dataset) => ({
          name: asString((dataset as Record<string, unknown> | undefined)?.name),
          notes: asString((dataset as Record<string, unknown> | undefined)?.notes),
          columns: Array.isArray(
            (dataset as Record<string, unknown> | undefined)?.columns
          )
            ? (((dataset as Record<string, unknown>).columns as unknown[]) ?? [])
                .map((column) => ({
                  name: asString((column as Record<string, unknown> | undefined)?.name),
                  type: normalizeDatasetColumnType(
                    (column as Record<string, unknown> | undefined)?.type
                  ),
                }))
                .filter((column) => column.name.length > 0)
            : [],
          exampleRecords: Array.isArray(
            (dataset as Record<string, unknown> | undefined)?.exampleRecords
          )
            ? (((dataset as Record<string, unknown>).exampleRecords as unknown[]) ?? []).filter(
                (record): record is Record<string, unknown> =>
                  !!record && typeof record === "object" && !Array.isArray(record)
              )
            : [],
        }))
        .filter((dataset) => dataset.name.length > 0)
    : [];

  return {
    title: asOptionalString(raw.title),
    purpose: asOptionalString(raw.purpose),
    stateFields,
    datasets,
    skills: Array.isArray(raw.skills)
      ? raw.skills
          .map((skill) => normalizePlannerSkillSeed(skill, "environment"))
          .filter((skill): skill is PlannerSkillSeed => skill !== null)
          .map((skill) => ({ ...skill, target: "environment" }))
      : [],
    policySeed: normalizePlannerPolicySeedValue(raw.policySeed),
    initialPolicyCanvasShape: normalizeInitialCanvasShape(
      raw.initialPolicyCanvasShape
    ),
    initialStateCanvasShape: normalizeInitialCanvasShape(
      raw.initialStateCanvasShape
    ),
    initialPolicyCanvasStructure: normalizeInitialCanvasStructure(
      raw.initialPolicyCanvasStructure
    ),
    initialStateCanvasStructure: normalizeInitialCanvasStructure(
      raw.initialStateCanvasStructure
    ),
    stateFocus: asString(raw.stateFocus),
  };
}

function normalizePlannerInvocationMode(
  value: unknown
): OrchestrationAgentConnectionInvocationMode {
  return value === "async" ? "async" : "sync";
}

function normalizePlannerAgentConnectionSeed(
  value: unknown
): PlannerAgentConnectionSeed | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const targetAgentId = asString(
    raw.targetAgentId ?? raw.target_agent_id ?? raw.agentId ?? raw.agent_id
  );
  if (!targetAgentId) {
    return null;
  }

  return {
    workflowStageId: asOptionalString(
      raw.workflowStageId ?? raw.workflow_stage_id
    ),
    workflowStageName: asOptionalString(
      raw.workflowStageName ?? raw.workflow_stage_name
    ),
    sourceAgentId: asOptionalString(
      raw.sourceAgentId ?? raw.source_agent_id ?? raw.sourceId ?? raw.source_id
    ),
    sourceAgentTitle: asOptionalString(
      raw.sourceAgentTitle ??
        raw.source_agent_title ??
        raw.sourceTitle ??
        raw.source_title
    ),
    targetAgentSharedId: asOptionalString(
      raw.targetAgentSharedId ?? raw.target_agent_shared_id
    ),
    targetAgentId,
    targetAgentTitle: asOptionalString(
      raw.targetAgentTitle ?? raw.target_agent_title ?? raw.agentTitle
    ),
    purpose: asOptionalString(raw.purpose),
    invocationMode: normalizePlannerInvocationMode(
      raw.invocationMode ?? raw.invocation_mode
    ),
    stateFields: Array.isArray(raw.stateFields)
      ? raw.stateFields
          .map((field) => ({
            name: asString((field as Record<string, unknown> | undefined)?.name),
            type: normalizeFieldType(
              (field as Record<string, unknown> | undefined)?.type
            ),
            initialValue:
              asString(
                (field as Record<string, unknown> | undefined)?.initialValue
              ) || "null",
          }))
          .filter((field) => field.name.length > 0)
      : [],
    datasets: Array.isArray(raw.datasets)
      ? raw.datasets
          .map((dataset) => ({
            name: asString((dataset as Record<string, unknown> | undefined)?.name),
            notes: asString(
              (dataset as Record<string, unknown> | undefined)?.notes
            ),
            columns: Array.isArray(
              (dataset as Record<string, unknown> | undefined)?.columns
            )
              ? (((dataset as Record<string, unknown>).columns as unknown[]) ?? [])
                  .map((column) => ({
                    name: asString(
                      (column as Record<string, unknown> | undefined)?.name
                    ),
                    type: normalizeDatasetColumnType(
                      (column as Record<string, unknown> | undefined)?.type
                    ),
                  }))
                  .filter((column) => column.name.length > 0)
              : [],
            exampleRecords: Array.isArray(
              (dataset as Record<string, unknown> | undefined)?.exampleRecords
            )
              ? (((dataset as Record<string, unknown>).exampleRecords as unknown[]) ?? []).filter(
                  (record): record is Record<string, unknown> =>
                    !!record && typeof record === "object" && !Array.isArray(record)
                )
              : [],
          }))
          .filter((dataset) => dataset.name.length > 0)
      : [],
    skills: Array.isArray(raw.skills)
      ? raw.skills
          .map((skill) => normalizePlannerSkillSeed(skill, "environment"))
          .filter((skill): skill is PlannerSkillSeed => skill !== null)
          .map((skill) => ({ ...skill, target: "environment" }))
      : [],
    sourcePolicySeed: normalizePlannerPolicySeedValue(raw.sourcePolicySeed),
    sourceInitialPolicyCanvasShape: normalizeInitialCanvasShape(
      raw.sourceInitialPolicyCanvasShape
    ),
    sourceInitialPolicyCanvasStructure: normalizeInitialCanvasStructure(
      raw.sourceInitialPolicyCanvasStructure
    ),
    sourceInitialStateCanvasShape: normalizeInitialCanvasShape(
      raw.sourceInitialStateCanvasShape
    ),
    sourceInitialStateCanvasStructure: normalizeInitialCanvasStructure(
      raw.sourceInitialStateCanvasStructure
    ),
    sourceRewardSeed: normalizePlannerPolicySeedValue(raw.sourceRewardSeed),
    sourceInitialRewardCanvasShape: normalizeInitialCanvasShape(
      raw.sourceInitialRewardCanvasShape
    ),
    sourceInitialRewardCanvasStructure: normalizeInitialCanvasStructure(
      raw.sourceInitialRewardCanvasStructure
    ),
    targetPolicySeed: normalizePlannerPolicySeedValue(raw.targetPolicySeed),
    targetInitialPolicyCanvasShape: normalizeInitialCanvasShape(
      raw.targetInitialPolicyCanvasShape
    ),
    targetInitialPolicyCanvasStructure: normalizeInitialCanvasStructure(
      raw.targetInitialPolicyCanvasStructure
    ),
    targetRewardSeed: normalizePlannerPolicySeedValue(raw.targetRewardSeed),
    targetInitialRewardCanvasShape: normalizeInitialCanvasShape(
      raw.targetInitialRewardCanvasShape
    ),
    targetInitialRewardCanvasStructure: normalizeInitialCanvasStructure(
      raw.targetInitialRewardCanvasStructure
    ),
    targetInitialStateCanvasShape: normalizeInitialCanvasShape(
      raw.targetInitialStateCanvasShape
    ),
    targetInitialStateCanvasStructure: normalizeInitialCanvasStructure(
      raw.targetInitialStateCanvasStructure
    ),
    stateFocus: asString(raw.stateFocus),
  };
}

function normalizePlannerAgentTemplateBindingSeed(
  value: unknown
): PlannerAgentTemplateBindingSeed | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const agentId = asString(raw.agentId ?? raw.agent_id ?? raw.id);
  const templateId = asString(raw.templateId ?? raw.template_id);
  const templateVersionId = asString(
    raw.templateVersionId ??
      raw.template_version_id ??
      raw.versionId ??
      raw.version_id
  );
  if (!agentId || !templateId || !templateVersionId) {
    return null;
  }

  return {
    agentId,
    templateId,
    templateVersionId,
    title: asOptionalString(raw.title ?? raw.agentTitle ?? raw.agent_title),
    roleContext: asOptionalString(
      raw.roleContext ?? raw.role_context ?? raw.role
    ),
  };
}

function normalizePlannerResult(raw: PlannerResult | null): PlannerResult {
  const rawRecord = raw as (PlannerResult & Record<string, unknown>) | null;
  const assistantMessage = asString(raw?.assistantMessage);
  const assistantReplyIntent = normalizeAssistantReplyIntentValue(
    raw?.assistantReplyIntent
  );
  const generalDescription = asString(raw?.generalDescription);
  const status = asString(raw?.status);

  const stateFields = Array.isArray(raw?.stateFields)
    ? raw.stateFields
        .map((field) => ({
          name: asString(field?.name),
          type: normalizeFieldType(field?.type),
          initialValue: asString(field?.initialValue) || "null",
        }))
        .filter((field) => field.name.length > 0)
    : [];

  const datasets = Array.isArray(raw?.datasets)
    ? raw.datasets
        .map((dataset) => ({
          name: asString(dataset?.name),
          notes: asString(dataset?.notes),
          columns: Array.isArray(dataset?.columns)
            ? dataset.columns
                .map((column) => ({
                  name: asString(column?.name),
                  type: normalizeDatasetColumnType(column?.type),
                }))
                .filter((column) => column.name.length > 0)
            : [],
          exampleRecords: Array.isArray(dataset?.exampleRecords)
            ? dataset.exampleRecords.filter(
                (record): record is Record<string, unknown> =>
                  !!record && typeof record === "object" && !Array.isArray(record)
              )
            : [],
        }))
        .filter((dataset) => dataset.name.length > 0)
    : [];

  const agentTemplateBindings = Array.isArray(
    rawRecord?.agentTemplateBindings ?? rawRecord?.agent_template_bindings
  )
    ? ((rawRecord?.agentTemplateBindings ??
        rawRecord?.agent_template_bindings) as unknown[])
        .map((binding) => normalizePlannerAgentTemplateBindingSeed(binding))
        .filter(
          (binding): binding is PlannerAgentTemplateBindingSeed =>
            binding !== null
        )
    : [];

  const triageQuestions = Array.isArray(raw?.triageQuestions)
    ? raw.triageQuestions.map((question) => asString(question)).filter(Boolean)
    : [];

  const toolRequests = Array.isArray(raw?.toolRequests)
    ? raw.toolRequests
        .map<PlannerToolRequest>((tool) => {
          const desiredSourceType: ToolBlueprintSourceType =
            tool?.desiredSourceType === "rss" ||
            tool?.desiredSourceType === "page" ||
            tool?.desiredSourceType === "web_search" ||
            tool?.desiredSourceType === "knowledge_save" ||
            tool?.desiredSourceType === "dataset_read"
              ? tool.desiredSourceType
              : "http";

          return {
            capability: asString(tool?.capability),
            whenToCall: asString(tool?.whenToCall),
            desiredSourceType,
            urlHint: asString(tool?.urlHint),
            saveTarget: tool?.saveTarget === "dataset" ? "dataset" : "knowledge",
            datasetName: asString(tool?.datasetName),
            parameters: Array.isArray(tool?.parameters)
              ? tool.parameters
                  .map((param) => ({
                    name: asString(param?.name),
                    type: normalizeToolParamType(param?.type),
                    description: asString(param?.description),
                  }))
                  .filter((param) => param.name.length > 0)
              : [],
          };
        })
        .filter((tool) => tool.capability.length > 0)
    : [];

  const canvasEdits = Array.isArray(raw?.canvasEdits)
    ? raw.canvasEdits
        .map((edit) => normalizePlannerCanvasEdit(edit))
        .filter((edit): edit is OrchestrationCanvasEdit => edit !== null)
    : [];
  const toolPlacements = Array.isArray(raw?.toolPlacements)
    ? raw.toolPlacements
        .map((placement) => normalizePlannerToolPlacement(placement))
        .filter((placement): placement is PlannerToolPlacement => placement !== null)
    : [];

  const policySeed = normalizePlannerPolicySeedValue(raw?.policySeed);
  const initialPolicyCanvasShape = normalizeInitialCanvasShape(
    raw?.initialPolicyCanvasShape
  );
  const initialStateCanvasShape = normalizeInitialCanvasShape(
    raw?.initialStateCanvasShape
  );
  const initialPolicyCanvasStructure = normalizeInitialCanvasStructure(
    raw?.initialPolicyCanvasStructure
  );
  const initialStateCanvasStructure = normalizeInitialCanvasStructure(
    raw?.initialStateCanvasStructure
  );
  const workflowStages = Array.isArray(raw?.workflowStages)
    ? raw.workflowStages
        .map((stage, index) => normalizePlannerWorkflowStage(stage, index))
        .filter((stage): stage is PlannerWorkflowStage => stage !== null)
    : [];
  const rawWorkflowStagePartitions =
    rawRecord?.workflowStagePartitions ??
    rawRecord?.workflow_stage_partitions ??
    rawRecord?.stagePartitions ??
    rawRecord?.stage_partitions ??
    rawRecord?.stageWorkflowCanvases ??
    rawRecord?.stage_workflow_canvases;
  const workflowStagePartitions = Array.isArray(rawWorkflowStagePartitions)
    ? rawWorkflowStagePartitions
        .map((partition, index) =>
          normalizePlannerWorkflowStagePartition(partition, index)
        )
        .filter(
          (partition): partition is PlannerWorkflowStagePartition =>
            partition !== null
        )
    : [];
  const environmentAgents = Array.isArray(raw?.environmentAgents)
    ? raw.environmentAgents
        .map((seed) => normalizePlannerEnvironmentAgentSeed(seed))
        .filter((seed): seed is PlannerEnvironmentAgentSeed => seed !== null)
    : [];
  const explicitAgentConnections = Array.isArray(raw?.agentConnections)
    ? raw.agentConnections
        .map((seed) => normalizePlannerAgentConnectionSeed(seed))
        .filter((seed): seed is PlannerAgentConnectionSeed => seed !== null)
    : [];
  const legacyEnvironmentConnections = environmentAgents.map((seed, index) => ({
    targetAgentId: makeOrchestrationId(),
    targetAgentTitle:
      seed.title?.trim() || `Connected agent ${index + 1}`,
    purpose:
      seed.purpose?.trim() ||
      "Converted from a legacy environment-agent seed into an ID-addressed agent connection.",
    invocationMode: "sync" as const,
    stateFields: seed.stateFields,
    datasets: seed.datasets,
    skills: seed.skills,
    stateFocus: seed.stateFocus,
    targetPolicySeed: seed.policySeed,
    targetInitialPolicyCanvasShape: seed.initialPolicyCanvasShape,
    targetInitialStateCanvasShape: seed.initialStateCanvasShape,
    targetInitialPolicyCanvasStructure: seed.initialPolicyCanvasStructure,
    targetInitialStateCanvasStructure: seed.initialStateCanvasStructure,
  }));
  const agentConnections = [
    ...explicitAgentConnections,
    ...legacyEnvironmentConnections,
  ];
  const explicitAgentSkills = Array.isArray(
    rawRecord?.agentSkills ?? rawRecord?.agent_skills
  )
    ? ((rawRecord?.agentSkills ?? rawRecord?.agent_skills) as unknown[])
        .map((skill) => normalizePlannerAgentSkillSeed(skill))
        .filter((skill): skill is PlannerAgentSkillSeed => skill !== null)
    : [];
  const legacySkillValues = Array.isArray(raw?.skills) ? raw.skills : [];
  const legacyAgentSkills = legacySkillValues
    .map((skill) => normalizePlannerAgentSkillSeed(skill))
    .filter((skill): skill is PlannerAgentSkillSeed => skill !== null);
  const skills = legacySkillValues
    .filter((skill) => !normalizePlannerAgentSkillSeed(skill))
    .map((skill) => normalizePlannerSkillSeed(skill))
    .filter((skill): skill is PlannerSkillSeed => skill !== null);
  const agentSkills = [...explicitAgentSkills, ...legacyAgentSkills];

  return {
    assistantMessage,
    assistantReplyIntent:
      assistantReplyIntent ??
      (triageQuestions.length > 0
        ? "ask"
        : assistantMessage.trim()
          ? "report_update"
          : "report_review"),
    status,
    generalDescription,
    setup: raw?.setup
      ? {
          title: asString(raw.setup.title),
          slug: asString(raw.setup.slug),
          summary: asString(raw.setup.summary),
        }
      : undefined,
    policySeed,
    initialPolicyCanvasShape,
    initialStateCanvasShape,
    initialPolicyCanvasStructure,
    initialStateCanvasStructure,
    workflowStages,
    workflowStagePartitions,
    stateFields,
    datasets,
    agentTemplateBindings,
    agentSkills,
    agentConnections,
    environmentAgents: [],
    skills,
    triageQuestions,
    stateFocus: asString(raw?.stateFocus),
    toolRequests,
    toolPlacements,
    canvasEdits,
    replacePolicyCanvas: raw?.replacePolicyCanvas === true,
    replaceStateCanvas: raw?.replaceStateCanvas === true,
  };
}

interface CompiledStructureNodeSpec {
  nodeKey: string;
  nodeType: OrchestrationCanvasEdit["nodeType"];
  label: string;
  x: number;
  y: number;
  data?: Record<string, unknown>;
}

interface CompiledStructureEdgeSpec {
  sourceKey: string;
  targetKey: string;
  sourceHandle?: string | null;
}

interface CompiledStructureExitRef {
  sourceKey: string;
  sourceHandle?: string | null;
}

interface CompiledStructureFlow {
  entryKey: string | null;
  exitRefs: CompiledStructureExitRef[];
  nextY: number;
}

interface CompiledInitialCanvasBody {
  canvasName: string;
  notes: string;
  startLabel: string;
  nodes: CompiledStructureNodeSpec[];
  edges: CompiledStructureEdgeSpec[];
  entryKey: string | null;
  exitRefs: CompiledStructureExitRef[];
}

const STATE_INGRESS_APPEND_LABEL =
  "Add agent_latest_observation and agent_latest_reward to new_events.";
const STATE_SUMMARY_GATE_LABEL = `summary plus new_events exceeds ${DEFAULT_CONVERSATION_MEMORY_LIMIT} characters`;
const STATE_SUMMARY_UPDATE_LABEL =
  "Update summary with a concise summary of summary plus new_events.";
const STATE_CLEAR_NEW_EVENTS_LABEL = "Set new_events to empty list.";
const STATE_REMAINING_UPDATE_LABEL =
  "Use only the current state to update the remaining fields. Leave unchanged values untouched and only fill fields supported by the current state.";

function normalizeInitialCanvasTemplateLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\+/g, " and ")
    .replace(/[.!?]+$/g, "")
    .replace(/[_\s-]+/g, " ");
}

function isStateSummaryGateLabel(label: string): boolean {
  const normalized = normalizeInitialCanvasTemplateLabel(label);
  return (
    normalized.includes("summary plus new events exceeds") &&
    normalized.includes(String(DEFAULT_CONVERSATION_MEMORY_LIMIT))
  );
}

function isStateSummaryUpdateLabel(label: string): boolean {
  const normalized = normalizeInitialCanvasTemplateLabel(label);
  return (
    normalized ===
      normalizeInitialCanvasTemplateLabel(STATE_SUMMARY_UPDATE_LABEL) ||
    (normalized.includes("update summary") &&
      normalized.includes("summary plus new events"))
  );
}

function isStateClearNewEventsLabel(label: string): boolean {
  return (
    normalizeInitialCanvasTemplateLabel(label) ===
    normalizeInitialCanvasTemplateLabel(STATE_CLEAR_NEW_EVENTS_LABEL)
  );
}

function isGenericStateRemainingUpdateLabel(label: string): boolean {
  return (
    normalizeInitialCanvasTemplateLabel(label) ===
    normalizeInitialCanvasTemplateLabel(STATE_REMAINING_UPDATE_LABEL)
  );
}

function isStateStarterTemplateStep(step: InitialCanvasStructureStep): boolean {
  if (step.kind === "condition") {
    return isStateSummaryGateLabel(step.label);
  }

  if (
    step.kind !== "prompt" &&
    step.kind !== "code" &&
    step.kind !== "display" &&
    step.kind !== "call_agent"
  ) {
    return false;
  }

  return (
    isRuntimeManagedStateAppendLabel(step.label) ||
    isStateSummaryUpdateLabel(step.label) ||
    isStateClearNewEventsLabel(step.label) ||
    isGenericStateRemainingUpdateLabel(step.label)
  );
}

function extractStateCanvasBodySteps(
  step: InitialCanvasStructureStep
): InitialCanvasStructureStep[] {
  if (step.kind === "condition" && isStateSummaryGateLabel(step.label)) {
    const falseSteps = step.whenFalse.flatMap(extractStateCanvasBodySteps);
    return falseSteps.length > 0
      ? falseSteps
      : step.whenTrue.flatMap(extractStateCanvasBodySteps);
  }

  return isStateStarterTemplateStep(step) ? [] : [step];
}

function getStateCanvasBodySteps(
  steps: InitialCanvasStructureStep[]
): InitialCanvasStructureStep[] {
  return steps.flatMap(extractStateCanvasBodySteps);
}

function buildClearNewEventsCodeData(): Record<string, unknown> {
  return {
    actionType: "code",
    actionTypeSource: "auto",
    [NODE_EXECUTABLE_CODE_OPS_DATA_KEY]: [
      {
        kind: "set_field",
        field: NEW_EVENTS_FIELD_NAME,
        source: { kind: "constant", value: [] },
      },
    ],
  };
}

function buildStateIngressAppendData(
  label: string
): Record<string, unknown> {
  if (!isRuntimeManagedStateAppendLabel(label)) {
    return {};
  }

  const normalized = normalizeRuntimeManagedStateAppendLabel(label);
  const isObservationAndReward =
    normalized === "add agent latest observation and agent latest reward to new events" ||
    normalized === "add latest observation and reward turn to new events" ||
    normalized === "add latest observation and reward event to new events" ||
    normalized === "add latest observation reward turn to new events" ||
    normalized === "add latest observation reward event to new events";
  const isObservationOnly =
    normalized === "add latest observation event to new events";
  const isPrimaryAction =
    normalized === "add latest primary agent action turn to new events" ||
    normalized === "add latest primary agent action event to new events" ||
    normalized === "add latest primary action turn to new events" ||
    normalized === "add latest primary action event to new events";
  const source = isObservationAndReward
    ? "latest_observation_and_reward_event"
    : isObservationOnly
      ? "latest_observation_event"
      : isPrimaryAction
        ? "latest_primary_action_event"
        : null;

  return {
    actionType: "code",
    actionTypeSource: "auto",
    ...(source
      ? {
          [NODE_EXECUTABLE_CODE_OPS_DATA_KEY]: [
            {
              kind: "append_list_item",
              field: NEW_EVENTS_FIELD_NAME,
              source: { kind: source },
            },
          ],
        }
      : {}),
    ...(isObservationAndReward
      ? {
          [NODE_LOCAL_INPUTS_DATA_KEY]: [
            {
              name: AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME,
              type: "string",
            },
            {
              name: AGENT_LATEST_REWARD_PROMPT_VALUE_NAME,
              type: "string",
            },
          ],
        }
      : isObservationOnly
        ? {
            [NODE_LOCAL_INPUTS_DATA_KEY]: [
              {
                name: AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME,
                type: "string",
              },
            ],
          }
        : {}),
  };
}

function buildInitialCanvasStructureBody(args: {
  structure: InitialCanvasStructure;
  target: "policy" | "state" | "reward";
  fallbackCanvasName: string;
  fallbackNotes?: string;
}): CompiledInitialCanvasBody | null {
  const startLabel = args.structure.startLabel.trim();
  if (!startLabel) {
    return null;
  }

  const canvasName =
    args.structure.canvasName?.trim() ||
    args.fallbackCanvasName.trim() ||
    (args.target === "state"
      ? "State extraction"
      : args.target === "reward"
        ? "Reward calculation"
        : "Main policy");
  const notes = args.structure.notes?.trim() || args.fallbackNotes?.trim() || "";
  const nodes: CompiledStructureNodeSpec[] = [];
  const edges: CompiledStructureEdgeSpec[] = [];
  let nextNodeId = 1;
  const verticalSpacing = 170;
  const branchOffset = 320;

  const createNode = (
    nodeType: CompiledStructureNodeSpec["nodeType"],
    label: string,
    x: number,
    y: number,
    data?: Record<string, unknown>
  ): string => {
    const nodeKey = `node_${nextNodeId}`;
    nextNodeId += 1;
    nodes.push({
      nodeKey,
      nodeType,
      label,
      x,
      y,
      data,
    });
    return nodeKey;
  };

  const connectExitRefs = (
    exitRefs: CompiledStructureExitRef[],
    targetKey: string
  ) => {
    for (const exitRef of exitRefs) {
      edges.push({
        sourceKey: exitRef.sourceKey,
        targetKey,
        ...(exitRef.sourceHandle !== undefined
          ? { sourceHandle: exitRef.sourceHandle }
          : {}),
      });
    }
  };

  const compileSequence = (
    steps: InitialCanvasStructureStep[],
    x: number,
    startY: number
  ): CompiledStructureFlow => {
    let entryKey: string | null = null;
    let exitRefs: CompiledStructureExitRef[] = [];
    let cursorY = startY;

    for (const step of steps) {
      const flow = compileStep(step, x, cursorY);
      if (!entryKey) {
        entryKey = flow.entryKey;
      }
      if (flow.entryKey && exitRefs.length > 0) {
        connectExitRefs(exitRefs, flow.entryKey);
      }
      exitRefs = flow.exitRefs;
      cursorY = flow.nextY;
    }

    return {
      entryKey,
      exitRefs,
      nextY: cursorY,
    };
  };

  const compileStep = (
    step: InitialCanvasStructureStep,
    x: number,
    y: number
  ): CompiledStructureFlow => {
    if (
      step.kind === "prompt" ||
      step.kind === "code" ||
      step.kind === "display" ||
      step.kind === "call_agent"
    ) {
      const actionType = step.actionType;
      const stateIngressAppendData =
        args.target === "state"
          ? buildStateIngressAppendData(step.label)
          : {};
      const nodeType =
        step.kind === "call_agent"
          ? "call_agent"
          : step.kind === "display" || actionType === "display"
          ? "display"
          : step.kind === "code" ||
              actionType === "code" ||
              Object.keys(stateIngressAppendData).length > 0
            ? "code"
            : "prompt";
      const actionData =
        actionType || Object.keys(stateIngressAppendData).length > 0
          ? {
              ...(actionType
                ? nodeType === "display"
                  ? {}
                  : {
                      actionType,
                      actionTypeSource: "manual",
                    }
                : {}),
              ...(nodeType === "display"
                ? {
                    displayType: step.displayType === "video" ? "video" : "text",
                    inputVariable:
                      step.inputVariable || CARRIED_OUTPUT_PROMPT_VALUE_NAME,
                    ...(step.videoUrl ? { videoUrl: step.videoUrl } : {}),
                  }
                : actionType === "prompt_transform"
                  ? {
                      inputVariable:
                        step.inputVariable || CARRIED_OUTPUT_PROMPT_VALUE_NAME,
                      ...(step.outputVariable
                        ? { outputVariable: step.outputVariable }
                        : {}),
                    }
                : {}),
              ...(nodeType === "call_agent"
                ? {
                    targetAgentId: step.targetAgentId ?? "",
                    callAgentType: step.callAgentType ?? "default",
                    backendType:
                      step.callAgentType && step.callAgentType !== "default"
                        ? step.callAgentType
                        : undefined,
                    executionMode: step.executionMode ?? "sync",
                  }
                : {}),
              ...stateIngressAppendData,
            }
          : undefined;
      const actionKey = createNode(nodeType, step.label, x, y, actionData);
      return {
        entryKey: actionKey,
        exitRefs: [{ sourceKey: actionKey }],
        nextY: y + verticalSpacing,
      };
    }

    if (step.kind === "yield") {
      const label = step.label?.trim() || "pause here; continue on the next event";
      const yieldKey = createNode("yield", label, x, y);
      return {
        entryKey: yieldKey,
        exitRefs: [],
        nextY: y + verticalSpacing,
      };
    }

    if (step.kind === "continue") {
      const label = step.label?.trim() || "continue this stage next turn";
      const continueKey = createNode("continue", label, x, y);
      return {
        entryKey: continueKey,
        exitRefs: [],
        nextY: y + verticalSpacing,
      };
    }

    if (
      step.kind === "terminate_stage" ||
      step.kind === "terminate_stage_immediate"
    ) {
      const label =
        step.label?.trim() ||
        (step.kind === "terminate_stage_immediate"
          ? "finish this stage; run the next state canvas now"
          : "finish this stage; continue on the next turn");
      const data = {
        ...(step.nextStageId ? { nextStageId: step.nextStageId } : {}),
        ...(step.nextStageName ? { nextStageName: step.nextStageName } : {}),
      };
      const terminateStageKey = createNode(
        step.kind,
        label,
        x,
        y,
        Object.keys(data).length > 0 ? data : undefined
      );
      return {
        entryKey: terminateStageKey,
        exitRefs: [],
        nextY: y + verticalSpacing,
      };
    }

    if (step.kind === "terminate") {
      const label = step.label?.trim() || "task complete; no future turns";
      const terminateKey = createNode("terminate", label, x, y);
      return {
        entryKey: terminateKey,
        exitRefs: [],
        nextY: y + verticalSpacing,
      };
    }

    if (step.kind === "condition") {
      const conditionKey = createNode("condition", step.label, x, y);
      const trueFlow = compileSequence(step.whenTrue, x - branchOffset, y + verticalSpacing);
      const falseFlow = compileSequence(step.whenFalse, x + branchOffset, y + verticalSpacing);

      const trueExitRefs =
        trueFlow.entryKey
          ? trueFlow.exitRefs
          : [{ sourceKey: conditionKey, sourceHandle: "true" as const }];
      const falseExitRefs =
        falseFlow.entryKey
          ? falseFlow.exitRefs
          : [{ sourceKey: conditionKey, sourceHandle: "false" as const }];

      if (trueFlow.entryKey) {
        edges.push({
          sourceKey: conditionKey,
          targetKey: trueFlow.entryKey,
          sourceHandle: "true",
        });
      }
      if (falseFlow.entryKey) {
        edges.push({
          sourceKey: conditionKey,
          targetKey: falseFlow.entryKey,
          sourceHandle: "false",
        });
      }

      return {
        entryKey: conditionKey,
        exitRefs: [...trueExitRefs, ...falseExitRefs],
        nextY: Math.max(trueFlow.nextY, falseFlow.nextY, y + verticalSpacing),
      };
    }

    if (step.kind !== "for" && step.kind !== "while") {
      return {
        entryKey: null,
        exitRefs: [],
        nextY: y,
      };
    }

    const loopKey = createNode(step.kind, step.label, x, y, {
      maxIterations:
        typeof step.maxIterations === "number" ? step.maxIterations : undefined,
    });
    const bodyFlow = compileSequence(step.body, x + branchOffset, y + verticalSpacing);
    if (bodyFlow.entryKey) {
      edges.push({
        sourceKey: loopKey,
        targetKey: bodyFlow.entryKey,
        sourceHandle: "body",
      });
      connectExitRefs(bodyFlow.exitRefs, loopKey);
    }

    return {
      entryKey: loopKey,
      exitRefs: [{ sourceKey: loopKey, sourceHandle: "done" }],
      nextY: Math.max(bodyFlow.nextY, y + verticalSpacing),
    };
  };

  const bodySteps =
    args.target === "state"
      ? getStateCanvasBodySteps(args.structure.steps)
      : args.structure.steps;
  const compiledBody = compileSequence(
    bodySteps,
    args.target === "state" ? 420 : 220,
    args.target === "state" ? 720 : 210
  );

  return {
    canvasName,
    notes,
    startLabel,
    nodes,
    edges,
    entryKey: compiledBody.entryKey,
    exitRefs: compiledBody.exitRefs,
  };
}

function createCanvasEdgeRecord(
  source: string,
  target: string,
  sourceHandle?: string | null
): CanvasEdgeRecord {
  return {
    id: makeOrchestrationId(),
    source,
    target,
    ...(sourceHandle !== undefined ? { sourceHandle } : {}),
  };
}

function findCanvasStartNode(canvas: CanvasEntry): CanvasNodeRecord | null {
  return canvas.graph.nodes.find((node) => node.type === "start") ?? null;
}

function findPolicyCommitNode(canvas: CanvasEntry): CanvasNodeRecord | null {
  return (
    canvas.graph.nodes.find(
      (node) =>
        node.type === "code" &&
        (node.data.codeTemplateId === "policy_turn_commit" ||
          normalizeInitialCanvasTemplateLabel(String(node.data.label ?? "")) ===
            normalizeInitialCanvasTemplateLabel(APPEND_ASSISTANT_TURN_CODE_LABEL))
    ) ?? null
  );
}

function isStarterFallbackNode(node: CanvasNodeRecord): boolean {
  return node.data?.starterFallback === true;
}

function findStateRemainingUpdateNode(canvas: CanvasEntry): CanvasNodeRecord | null {
  return (
    canvas.graph.nodes.find((node) =>
      isGenericStateRemainingUpdateLabel(String(node.data.label ?? ""))
    ) ?? null
  );
}

function appendCompiledBodyNodes(
  canvas: CanvasEntry,
  body: CompiledInitialCanvasBody
): Map<string, string> {
  const idByKey = new Map<string, string>();
  for (const node of body.nodes) {
    const id = makeOrchestrationId();
    idByKey.set(node.nodeKey, id);
    canvas.graph.nodes.push({
      id,
      type: node.nodeType ?? "prompt",
      position: { x: node.x, y: node.y },
      data: {
        label: node.label,
        ...(node.data ?? {}),
      },
    });
  }

  for (const edge of body.edges) {
    const source = idByKey.get(edge.sourceKey);
    const target = idByKey.get(edge.targetKey);
    if (!source || !target) {
      continue;
    }
    canvas.graph.edges.push(
      createCanvasEdgeRecord(source, target, edge.sourceHandle)
    );
  }

  return idByKey;
}

function applyPolicyBodyToStarterCanvas(
  canvas: CanvasEntry,
  body: CompiledInitialCanvasBody
): boolean {
  const startNode = findCanvasStartNode(canvas);
  const commitNode = findPolicyCommitNode(canvas);
  if (!startNode || !commitNode) {
    return false;
  }

  canvas.name = body.canvasName || canvas.name;
  canvas.freeText = body.notes || canvas.freeText;
  startNode.data = { ...startNode.data, label: body.startLabel };

  if (!body.entryKey) {
    return true;
  }

  const starterFallbackNodeIds = new Set(
    canvas.graph.nodes
      .filter(isStarterFallbackNode)
      .map((node) => node.id)
  );
  if (starterFallbackNodeIds.size > 0) {
    canvas.graph.nodes = canvas.graph.nodes.filter(
      (node) => !starterFallbackNodeIds.has(node.id)
    );
    canvas.graph.edges = canvas.graph.edges.filter(
      (edge) =>
        !starterFallbackNodeIds.has(edge.source) &&
        !starterFallbackNodeIds.has(edge.target)
    );
  }

  const idByKey = appendCompiledBodyNodes(canvas, body);
  const entryId = idByKey.get(body.entryKey);
  if (!entryId) {
    return false;
  }

  canvas.graph.edges = canvas.graph.edges.filter(
    (edge) => !(edge.source === startNode.id && edge.target === commitNode.id)
  );
  canvas.graph.edges.push(createCanvasEdgeRecord(startNode.id, entryId));
  for (const exitRef of body.exitRefs) {
    const source = idByKey.get(exitRef.sourceKey);
    if (source) {
      canvas.graph.edges.push(
        createCanvasEdgeRecord(source, commitNode.id, exitRef.sourceHandle)
      );
    }
  }

  return true;
}

function applyStateBodyToStarterCanvas(
  canvas: CanvasEntry,
  body: CompiledInitialCanvasBody
): boolean {
  const startNode = findCanvasStartNode(canvas);
  const remainingNode = findStateRemainingUpdateNode(canvas);
  if (!startNode || !remainingNode) {
    return false;
  }

  canvas.name = body.canvasName || canvas.name;
  canvas.freeText = body.notes || canvas.freeText;
  startNode.data = { ...startNode.data, label: body.startLabel };

  if (!body.entryKey) {
    return true;
  }

  const incomingToRemaining = canvas.graph.edges.filter(
    (edge) => edge.target === remainingNode.id
  );
  const idByKey = appendCompiledBodyNodes(canvas, body);
  const entryId = idByKey.get(body.entryKey);
  if (!entryId) {
    return false;
  }

  canvas.graph.nodes = canvas.graph.nodes.filter(
    (node) => node.id !== remainingNode.id
  );
  canvas.graph.edges = canvas.graph.edges.filter(
    (edge) => edge.source !== remainingNode.id && edge.target !== remainingNode.id
  );
  for (const edge of incomingToRemaining) {
    canvas.graph.edges.push(
      createCanvasEdgeRecord(edge.source, entryId, edge.sourceHandle)
    );
  }

  return true;
}

function findRewardCalculationNode(canvas: CanvasEntry): CanvasNodeRecord | null {
  const calculationNode =
    canvas.graph.nodes.find(
      (node) =>
        node.type === "code" &&
        typeof node.data?.codeTemplateId === "string" &&
        node.data.codeTemplateId.trim() === "reward_scalar_calculation"
    ) ??
    canvas.graph.nodes.find(
      (node) =>
        node.type === "code" &&
        normalizeInitialCanvasTemplateLabel(String(node.data?.label ?? "")) ===
          "calculate the scalar reward value"
    ) ??
    canvas.graph.nodes.find((node) => node.type === "code") ??
    null;

  return calculationNode;
}

function applyRewardBodyToStarterCanvas(
  canvas: CanvasEntry,
  body: CompiledInitialCanvasBody
): boolean {
  const startNode = findCanvasStartNode(canvas);
  const calculationNode = findRewardCalculationNode(canvas);
  if (!startNode || !calculationNode) {
    return false;
  }

  canvas.name = body.canvasName || canvas.name;
  canvas.freeText = body.notes || canvas.freeText;
  startNode.data = { ...startNode.data, label: body.startLabel };

  if (!body.entryKey) {
    return true;
  }

  const starterFallbackNodeIds = new Set(
    canvas.graph.nodes
      .filter(isStarterFallbackNode)
      .map((node) => node.id)
  );
  if (starterFallbackNodeIds.size > 0) {
    canvas.graph.nodes = canvas.graph.nodes.filter(
      (node) => !starterFallbackNodeIds.has(node.id)
    );
    canvas.graph.edges = canvas.graph.edges.filter(
      (edge) =>
        !starterFallbackNodeIds.has(edge.source) &&
        !starterFallbackNodeIds.has(edge.target)
    );
  }

  const idByKey = appendCompiledBodyNodes(canvas, body);
  const entryId = idByKey.get(body.entryKey);
  if (!entryId) {
    return false;
  }

  canvas.graph.edges = canvas.graph.edges.filter(
    (edge) => !(edge.source === startNode.id && edge.target === calculationNode.id)
  );
  canvas.graph.edges.push(createCanvasEdgeRecord(startNode.id, entryId));
  for (const exitRef of body.exitRefs) {
    const source = idByKey.get(exitRef.sourceKey);
    if (source) {
      canvas.graph.edges.push(
        createCanvasEdgeRecord(source, calculationNode.id, exitRef.sourceHandle)
      );
    }
  }

  return true;
}

function applyInitialCanvasStructureToStarterCanvasDoc(args: {
  starterCanvasDoc: CanvasDoc | null | undefined;
  structure: InitialCanvasStructure;
  target: "policy" | "state" | "reward";
  fallbackCanvasName: string;
  fallbackNotes?: string;
}): CanvasDoc | null {
  const body = buildInitialCanvasStructureBody(args);
  const nextDoc = cloneCanvasDoc(args.starterCanvasDoc);
  if (!body || !nextDoc?.canvases.length) {
    return null;
  }

  const activeCanvas =
    nextDoc.canvases.find((canvas) => canvas.id === nextDoc.activeId) ??
    nextDoc.canvases[0];
  if (!activeCanvas) {
    return null;
  }

  const applied =
    args.target === "policy"
      ? applyPolicyBodyToStarterCanvas(activeCanvas, body)
      : args.target === "state"
        ? applyStateBodyToStarterCanvas(activeCanvas, body)
        : applyRewardBodyToStarterCanvas(activeCanvas, body);

  return applied ? nextDoc : null;
}

interface InitialCanvasShapeMaterializationRequest {
  key: string;
  target: "policy" | "state" | "reward";
  scope: "main" | "environment_agent" | "agent_connection";
  ownerTitle: string;
  ownerPurpose?: string;
  generalDescription: string;
  stateFields: SuggestedField[];
  stateFocus?: string;
  policySeed?: Partial<PolicySeed> | null;
  shape: InitialCanvasShape;
}

function plannerResultNeedsInitialCanvasMaterialization(
  plan: PlannerResult
): boolean {
  if (
    (plan.initialPolicyCanvasShape && !plan.initialPolicyCanvasStructure) ||
    (plan.initialStateCanvasShape && !plan.initialStateCanvasStructure)
  ) {
    return true;
  }

  return plan.environmentAgents.some(
    (seed) =>
      (seed.initialPolicyCanvasShape && !seed.initialPolicyCanvasStructure) ||
      (seed.initialStateCanvasShape && !seed.initialStateCanvasStructure)
  ) || plan.agentConnections.some(
    (seed) =>
      (seed.sourceInitialPolicyCanvasShape &&
        !seed.sourceInitialPolicyCanvasStructure) ||
      (seed.sourceInitialStateCanvasShape &&
        !seed.sourceInitialStateCanvasStructure) ||
      (seed.sourceInitialRewardCanvasShape &&
        !seed.sourceInitialRewardCanvasStructure) ||
      (seed.targetInitialPolicyCanvasShape &&
        !seed.targetInitialPolicyCanvasStructure) ||
      (seed.targetInitialRewardCanvasShape &&
        !seed.targetInitialRewardCanvasStructure) ||
      (seed.targetInitialStateCanvasShape &&
        !seed.targetInitialStateCanvasStructure)
  );
}

function plannerPolicySeedHasContent(
  seed: Partial<PolicySeed> | null | undefined
): boolean {
  if (!seed) {
    return false;
  }

  return (
    asString(seed.canvasName).length > 0 ||
    asString(seed.generalPrompt).length > 0 ||
    asString(seed.clarificationGate).length > 0 ||
    asString(seed.responseRule).length > 0 ||
    asString(seed.notes).length > 0 ||
    (Array.isArray(seed.clarificationActions) &&
      seed.clarificationActions.some((action) => asString(action).length > 0)) ||
    (Array.isArray(seed.executionActions) &&
      seed.executionActions.some((action) => asString(action).length > 0))
  );
}

function plannerSetupHasContent(setup: PlannerSetup | undefined): boolean {
  return Boolean(
    setup &&
      (asString(setup.title) || asString(setup.slug) || asString(setup.summary))
  );
}

function plannerResultHasTargetDraftPatch(plan: PlannerResult): boolean {
  return (
    plannerSetupHasContent(plan.setup) ||
    plannerPolicySeedHasContent(plan.policySeed) ||
    Boolean(plan.initialPolicyCanvasShape) ||
    Boolean(plan.initialStateCanvasShape) ||
    Boolean(plan.initialPolicyCanvasStructure) ||
    Boolean(plan.initialStateCanvasStructure) ||
    plan.workflowStages.length > 0 ||
    plan.workflowStagePartitions.length > 0 ||
    plan.stateFields.length > 0 ||
    plan.datasets.length > 0 ||
    plan.agentTemplateBindings.length > 0 ||
    plan.agentSkills.length > 0 ||
    plan.agentConnections.length > 0 ||
    plan.environmentAgents.length > 0 ||
    plan.skills.length > 0 ||
    plan.toolPlacements.length > 0 ||
    plan.canvasEdits.length > 0 ||
    plan.replacePolicyCanvas === true ||
    plan.replaceStateCanvas === true
  );
}

function plannerResultIsWorkflowReviewOnly(plan: PlannerResult): boolean {
  return (
    (plan.workflowStages.length > 0 ||
      plan.workflowStagePartitions.length > 0) &&
    !plannerSetupHasContent(plan.setup) &&
    !plannerPolicySeedHasContent(plan.policySeed) &&
    !plan.initialPolicyCanvasShape &&
    !plan.initialStateCanvasShape &&
    !plan.initialPolicyCanvasStructure &&
    !plan.initialStateCanvasStructure &&
    plan.stateFields.length === 0 &&
    plan.datasets.length === 0 &&
    plan.agentTemplateBindings.length === 0 &&
    plan.agentSkills.length === 0 &&
    plan.agentConnections.length === 0 &&
    plan.environmentAgents.length === 0 &&
    plan.skills.length === 0 &&
    plan.toolRequests.length === 0 &&
    plan.toolPlacements.length === 0 &&
    plan.canvasEdits.length === 0 &&
    plan.replacePolicyCanvas !== true &&
    plan.replaceStateCanvas !== true
  );
}

function isDaemonProcessReady(
  daemonState: Record<string, unknown> | null
): boolean {
  return (
    readDaemonStateBoolean(daemonState, [
      "process_ready",
      "processReady",
    ]) === true
  );
}

function buildInitialCanvasShapeMaterializationRequests(args: {
  project: OrchestrationProject;
  plan: PlannerResult;
  daemonState: Record<string, unknown> | null;
}): InitialCanvasShapeMaterializationRequest[] {
  const generalDescription = resolveGeneralDescription(
    args.project,
    args.plan,
    args.daemonState
  );
  const processModel = readProcessModelSnapshot(args.daemonState);
  const mainStateFields = ensureRequiredPrimaryAgentStateFields(
    mergeSuggestedFields(args.project.fields, args.plan.stateFields, {
      protectedFieldNames: REQUIRED_PRIMARY_AGENT_STATE_FIELD_NAMES,
    }),
    {
      observationType: inferProcessSignalFieldType(
        processModel?.observation.description ?? ""
      ),
      actionType: inferProcessSignalFieldType(
        processModel?.action.description ?? ""
      ),
    }
  );
  const requests: InitialCanvasShapeMaterializationRequest[] = [];
  const ownerTitle = deriveSetupTitle(
    args.project,
    args.plan,
    generalDescription
  );

  if (
    args.plan.initialPolicyCanvasShape &&
    !args.plan.initialPolicyCanvasStructure
  ) {
    requests.push({
      key: "main_policy",
      target: "policy",
      scope: "main",
      ownerTitle,
      ownerPurpose:
        args.plan.setup?.summary?.trim() || generalDescription || undefined,
      generalDescription,
      stateFields: mainStateFields.map((field) => ({
        name: field.name,
        type: field.type,
        initialValue: field.initialValue,
      })),
      policySeed: args.plan.policySeed,
      shape: args.plan.initialPolicyCanvasShape,
    });
  }

  if (
    args.plan.initialStateCanvasShape &&
    !args.plan.initialStateCanvasStructure
  ) {
    requests.push({
      key: "main_state",
      target: "state",
      scope: "main",
      ownerTitle,
      ownerPurpose:
        args.plan.setup?.summary?.trim() || generalDescription || undefined,
      generalDescription,
      stateFields: mainStateFields.map((field) => ({
        name: field.name,
        type: field.type,
        initialValue: field.initialValue,
      })),
      stateFocus: args.plan.stateFocus,
      shape: args.plan.initialStateCanvasShape,
    });
  }

  args.plan.environmentAgents.forEach((seed, index) => {
    const ownerTitle = seed.title?.trim() || `Environment simulation ${index + 1}`;
    const mergedEnvFields = ensureRequiredEnvironmentAgentStateFields(
      mergeSuggestedFields(
        createEmptyOrchestrationEnvironmentPlayer().fields,
        seed.stateFields,
        { protectedFieldNames: REQUIRED_ENVIRONMENT_AGENT_STATE_FIELD_NAMES }
      ),
      {
        observationType:
          seed.stateFields.find(
            (field) => field.name === PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME
          )?.type,
        actionType:
          seed.stateFields.find(
            (field) => field.name === PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME
          )?.type,
      }
    );

    if (seed.initialPolicyCanvasShape && !seed.initialPolicyCanvasStructure) {
      requests.push({
        key: `environment_${index}_policy`,
        target: "policy",
        scope: "environment_agent",
        ownerTitle,
        ownerPurpose: seed.purpose?.trim() || undefined,
        generalDescription,
        stateFields: mergedEnvFields.map((field) => ({
          name: field.name,
          type: field.type,
          initialValue: field.initialValue,
        })),
        policySeed: seed.policySeed,
        shape: seed.initialPolicyCanvasShape,
      });
    }

    if (seed.initialStateCanvasShape && !seed.initialStateCanvasStructure) {
      requests.push({
        key: `environment_${index}_state`,
        target: "state",
        scope: "environment_agent",
        ownerTitle,
        ownerPurpose: seed.purpose?.trim() || undefined,
        generalDescription,
        stateFields: mergedEnvFields.map((field) => ({
          name: field.name,
          type: field.type,
          initialValue: field.initialValue,
        })),
        stateFocus: seed.stateFocus,
        shape: seed.initialStateCanvasShape,
      });
    }
  });

  args.plan.agentConnections.forEach((seed, index) => {
    const sourceTitle =
      seed.sourceAgentTitle?.trim() ||
      seed.sourceAgentId?.trim() ||
      ownerTitle;
    const targetTitle =
      seed.targetAgentTitle?.trim() ||
      seed.targetAgentId.trim() ||
      `Agent ${index + 1}`;
    const targetFields = ensureRequiredEnvironmentAgentStateFields(
      mergeSuggestedFields(
        createEmptyOrchestrationEnvironmentPlayer().fields,
        seed.stateFields,
        { protectedFieldNames: REQUIRED_ENVIRONMENT_AGENT_STATE_FIELD_NAMES }
      )
    );
    if (
      seed.sourceInitialPolicyCanvasShape &&
      !seed.sourceInitialPolicyCanvasStructure
    ) {
      requests.push({
        key: `agent_connection_${index}_source_policy`,
        target: "policy",
        scope: "agent_connection",
        ownerTitle: `${sourceTitle} -> ${targetTitle}`,
        ownerPurpose: seed.purpose?.trim() || undefined,
        generalDescription,
        stateFields: mainStateFields.map((field) => ({
          name: field.name,
          type: field.type,
          initialValue: field.initialValue,
        })),
        policySeed: seed.sourcePolicySeed,
        shape: seed.sourceInitialPolicyCanvasShape,
      });
    }

    if (
      seed.sourceInitialStateCanvasShape &&
      !seed.sourceInitialStateCanvasStructure
    ) {
      requests.push({
        key: `agent_connection_${index}_source_state`,
        target: "state",
        scope: "agent_connection",
        ownerTitle: `${sourceTitle} -> ${targetTitle}`,
        ownerPurpose: seed.purpose?.trim() || undefined,
        generalDescription,
        stateFields: mainStateFields.map((field) => ({
          name: field.name,
          type: field.type,
          initialValue: field.initialValue,
        })),
        stateFocus: seed.stateFocus,
        shape: seed.sourceInitialStateCanvasShape,
      });
    }

    if (
      seed.sourceInitialRewardCanvasShape &&
      !seed.sourceInitialRewardCanvasStructure
    ) {
      requests.push({
        key: `agent_connection_${index}_source_reward`,
        target: "reward",
        scope: "agent_connection",
        ownerTitle: `Reward: ${sourceTitle} -> ${targetTitle}`,
        ownerPurpose: seed.purpose?.trim() || undefined,
        generalDescription,
        stateFields: targetFields.map((field) => ({
          name: field.name,
          type: field.type,
          initialValue: field.initialValue,
        })),
        policySeed: seed.sourceRewardSeed,
        shape: seed.sourceInitialRewardCanvasShape,
      });
    }

    if (
      seed.targetInitialPolicyCanvasShape &&
      !seed.targetInitialPolicyCanvasStructure
    ) {
      requests.push({
        key: `agent_connection_${index}_target_policy`,
        target: "policy",
        scope: "agent_connection",
        ownerTitle: targetTitle,
        ownerPurpose: seed.purpose?.trim() || undefined,
        generalDescription,
        stateFields: targetFields.map((field) => ({
          name: field.name,
          type: field.type,
          initialValue: field.initialValue,
        })),
        policySeed: seed.targetPolicySeed,
        shape: seed.targetInitialPolicyCanvasShape,
      });
    }

    if (
      seed.targetInitialRewardCanvasShape &&
      !seed.targetInitialRewardCanvasStructure
    ) {
      requests.push({
        key: `agent_connection_${index}_target_reward`,
        target: "reward",
        scope: "agent_connection",
        ownerTitle: `Reward: ${targetTitle} -> ${sourceTitle}`,
        ownerPurpose: seed.purpose?.trim() || undefined,
        generalDescription,
        stateFields: mainStateFields.map((field) => ({
          name: field.name,
          type: field.type,
          initialValue: field.initialValue,
        })),
        policySeed: seed.targetRewardSeed,
        shape: seed.targetInitialRewardCanvasShape,
      });
    }

    if (
      seed.targetInitialStateCanvasShape &&
      !seed.targetInitialStateCanvasStructure
    ) {
      requests.push({
        key: `agent_connection_${index}_target_state`,
        target: "state",
        scope: "agent_connection",
        ownerTitle: targetTitle,
        ownerPurpose: seed.purpose?.trim() || undefined,
        generalDescription,
        stateFields: targetFields.map((field) => ({
          name: field.name,
          type: field.type,
          initialValue: field.initialValue,
        })),
        stateFocus: seed.stateFocus,
        shape: seed.targetInitialStateCanvasShape,
      });
    }
  });

  return requests;
}

function normalizeMaterializedInitialCanvasStructuresValue(
  value: unknown
): Map<string, InitialCanvasStructure> {
  const byKey = new Map<string, InitialCanvasStructure>();

  if (Array.isArray(value)) {
    for (const entry of value) {
      const key =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? asString((entry as { key?: unknown }).key)
          : "";
      const structure =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? normalizeInitialCanvasStructure(
              (entry as { structure?: unknown }).structure
            )
          : null;
      if (key && structure) {
        byKey.set(key, structure);
      }
    }
    return byKey;
  }

  if (!value || typeof value !== "object") {
    return byKey;
  }

  for (const [key, rawStructure] of Object.entries(
    value as Record<string, unknown>
  )) {
    const normalizedKey = asString(key);
    const structure = normalizeInitialCanvasStructure(rawStructure);
    if (normalizedKey && structure) {
      byKey.set(normalizedKey, structure);
    }
  }

  return byKey;
}

function buildInitialCanvasStructureMaterializationPrompt(args: {
  requests: InitialCanvasShapeMaterializationRequest[];
  registryRules: readonly CanvasRuleDefinition[];
  daemonState: Record<string, unknown> | null;
}): string {
  const processModel = readProcessModelSnapshot(args.daemonState);
  const processDescription =
    readDaemonStateString(args.daemonState, ["process_description"]) ||
    (processModel ? buildProcessDescriptionFromModel(processModel) : "");
  const openQuestions = readDaemonStateStringArray(args.daemonState, [
    "process_open_questions",
  ]);
  const sessionRules = readSessionInferredRulesFromDaemonState(args.daemonState);

  return [
    "Convert each abstract canvas shape into InitialCanvasStructure IR for the starter-template applicator.",
    "Return JSON only.",
    "",
    "Confirmed process description:",
    processDescription || "(none)",
    "",
    "Confirmed process model JSON:",
    processModel ? JSON.stringify(processModel, null, 2) : "(none)",
    "",
    "Outstanding process open questions:",
    openQuestions.length > 0 ? JSON.stringify(openQuestions, null, 2) : "[]",
    "",
    "Draft-change constraints and preferences:",
    renderDraftChangeConstraintsContext({
      daemonState: args.daemonState,
      registryRules: args.registryRules,
      sessionRules,
    }),
    "",
    "Requests:",
    JSON.stringify(args.requests, null, 2),
    "",
    "Return strict JSON with this shape:",
    "{",
    '  "structures": [{',
    '    "key": string,',
    '    "structure": { "canvasName": string, "notes": string, "startLabel": string, "steps": InitialCanvasStep[] } | null',
    "  }]",
    "}",
    "",
    "Protocol:",
    "- Preserve every request key exactly.",
    "- Stay faithful to the supplied shape. Do not invent major branches or loops that the shape did not imply.",
    "- phase steps become prompt or code steps. Use actionTypeHint when present.",
    "- decision steps become condition steps with genuine branching-condition labels.",
    "- for/while steps stay as for/while steps, and keep maxIterations small when present.",
    "- Use policySeed, generalDescription, ownerPurpose, stateFields, and stateFocus only as semantic guidance for labels and notes.",
    "- Use only confirmed process facts as source material for structure labels and notes.",
    "- Treat process_open_questions as follow-up questions for later turns, not as text that should appear inside the generated draft structure.",
    "- For policy canvases, start from the catalog starter template Start -> fallback action Prompt -> commit Code node -> Display node. Emit only project-specific prompt/tool/condition/display behavior that replaces the fallback prompt before the commit/display tail; do not emit a special append/commit IR step and do not mark the commit node runtime-managed or read-only.",
    `- For state canvases, start from the catalog starter template Start -> code "Add agent_latest_observation and agent_latest_reward to new_events." -> condition "summary plus new_events exceeds ${DEFAULT_CONVERSATION_MEMORY_LIMIT} characters" -> TRUE summary-update prompt -> code "Set new_events to empty list.", with FALSE and clear paths rejoining at remaining-state update. Emit only project-specific prompt/tool/condition/display behavior that belongs after that memory path; do not emit special append/summary/clear IR steps.`,
    "- For reward canvases, start from the catalog starter template Start -> fallback reward Prompt -> reward calculation Code node. Emit only project-specific reward reasoning/preparation steps that replace the fallback prompt before the final calculation Code node. Do not emit a policy commit/display tail, and do not mark the calculation node runtime-managed or read-only.",
    "- Use prompt_transform for steps whose purpose is to rewrite an existing local or state value, such as finalizing an assistant-facing reply, condensing a prior local value, or transforming a state field into a new local value. Do not use prompt_transform for ordinary state-field updates.",
    "- Use call_agent steps only when the requested interaction should invoke another agent by ID. Include targetAgentId and, when needed, callAgentType=\"openclaw\" or \"hermes\".",
    "- Use terminate steps only when the current pairwise task is complete. A terminate step means the interaction is over permanently for that session/connection: no future turns, not merely end-of-turn.",
    "- Output InitialCanvasStructure IR only. Do not return canvasEdits.",
  ].join("\n");
}

function parseInitialCanvasStructureMaterializationReply(
  text: string
): Map<string, InitialCanvasStructure> {
  const parsed = parseJsonObject<{
    structures?: unknown;
  }>(text);

  return normalizeMaterializedInitialCanvasStructuresValue(parsed?.structures);
}

function mergeMaterializedInitialCanvasStructuresIntoPlan(
  plan: PlannerResult,
  materializedByKey: Map<string, InitialCanvasStructure>
): PlannerResult {
  if (materializedByKey.size === 0) {
    return plan;
  }

  return {
    ...plan,
    initialPolicyCanvasStructure:
      plan.initialPolicyCanvasStructure ??
      materializedByKey.get("main_policy") ??
      null,
    initialStateCanvasStructure:
      plan.initialStateCanvasStructure ??
      materializedByKey.get("main_state") ??
      null,
    environmentAgents: plan.environmentAgents.map((seed, index) => ({
      ...seed,
      initialPolicyCanvasStructure:
        seed.initialPolicyCanvasStructure ??
        materializedByKey.get(`environment_${index}_policy`) ??
        null,
      initialStateCanvasStructure:
        seed.initialStateCanvasStructure ??
        materializedByKey.get(`environment_${index}_state`) ??
        null,
    })),
    agentConnections: plan.agentConnections.map((seed, index) => ({
      ...seed,
      sourceInitialPolicyCanvasStructure:
        seed.sourceInitialPolicyCanvasStructure ??
        materializedByKey.get(`agent_connection_${index}_source_policy`) ??
        null,
      sourceInitialStateCanvasStructure:
        seed.sourceInitialStateCanvasStructure ??
        materializedByKey.get(`agent_connection_${index}_source_state`) ??
        null,
      sourceInitialRewardCanvasStructure:
        seed.sourceInitialRewardCanvasStructure ??
        materializedByKey.get(`agent_connection_${index}_source_reward`) ??
        null,
      targetInitialPolicyCanvasStructure:
        seed.targetInitialPolicyCanvasStructure ??
        materializedByKey.get(`agent_connection_${index}_target_policy`) ??
        null,
      targetInitialRewardCanvasStructure:
        seed.targetInitialRewardCanvasStructure ??
        materializedByKey.get(`agent_connection_${index}_target_reward`) ??
        null,
      targetInitialStateCanvasStructure:
        seed.targetInitialStateCanvasStructure ??
        materializedByKey.get(`agent_connection_${index}_target_state`) ??
        null,
    })),
  };
}

function summarizeWorkflowStageFields(fields: SuggestedField[]): string {
  if (fields.length === 0) {
    return "(none)";
  }
  return fields
    .map((field) => `${field.name} (${field.type})`)
    .join(", ");
}

function buildWorkflowStageNodeLabel(stage: PlannerWorkflowStage): string {
  const agents =
    stage.agents.length > 0
      ? stage.agents
          .map((agent) => {
            const title = agent.agentTitle?.trim() || agent.agentId;
            const role = agent.role?.trim() ? ` - ${agent.role.trim()}` : "";
            return [
              `- ${title} (${agent.agentId})${role}`,
              `  Shared state: ${summarizeWorkflowStageFields(agent.sharedStateFields)}`,
              `  Stage state: ${summarizeWorkflowStageFields(agent.stageStateFields)}`,
            ].join("\n");
          })
          .join("\n")
      : "- (none listed)";

  return [
    `Stage: ${stage.name}`,
    stage.purpose ? `Purpose: ${stage.purpose}` : "Purpose:",
    stage.entryCondition ? `Entry: ${stage.entryCondition}` : "Entry:",
    stage.completionCondition
      ? `Completion: ${stage.completionCondition}`
      : "Completion:",
    "Agents:",
    agents,
  ].join("\n");
}

function buildWorkflowStageTransitions(
  stages: PlannerWorkflowStage[]
): Map<string, string[]> {
  const stageIds = new Set(stages.map((stage) => stage.stageId));
  const transitions = new Map<string, string[]>();

  stages.forEach((stage, index) => {
    const explicitTargets = stage.nextStageIds.filter((stageId) =>
      stageIds.has(stageId)
    );
    const targets =
      explicitTargets.length > 0
        ? explicitTargets
        : stages[index + 1]
          ? [stages[index + 1].stageId]
          : [];
    transitions.set(stage.stageId, Array.from(new Set(targets)));
  });

  return transitions;
}

function layoutWorkflowStageNodes(
  stages: PlannerWorkflowStage[],
  _transitions: Map<string, string[]>
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  stages.forEach((stage, index) => {
    positions.set(stage.stageId, {
      x: 420 + index * 430,
      y: 120,
    });
  });

  return positions;
}

function createWorkflowCanvasEntry(args: {
  canvasId: string;
  canvasName: string;
  stages: PlannerWorkflowStage[];
  project: OrchestrationProject;
  parentStageId?: string;
  parentStageName?: string;
  purpose?: string;
}): CanvasEntry | null {
  const { canvasId, canvasName, stages, project } = args;
  if (stages.length === 0) {
    return null;
  }

  const transitions = buildWorkflowStageTransitions(stages);
  const positions = layoutWorkflowStageNodes(stages, transitions);
  const isChildWorkflow = Boolean(args.parentStageId);
  const startNode: CanvasNodeRecord = {
    id: `${canvasId}-start`,
    type: "start",
    position: { x: 80, y: 120 },
    data: {
      label: isChildWorkflow
        ? `Editable workflow partition for ${
            args.parentStageName || args.parentStageId
          }. Approve this stage breakdown before detailed implementation canvases are built.`
        : "Editable overview of the main workflow stages. Stage implementation canvases live separately on stage-scoped agent connections.",
      workflowOverview: true,
      runtimeRole: "workflow_overview",
      workflowCanvasId: canvasId,
      ...(args.parentStageId
        ? { workflowParentStageId: args.parentStageId }
        : {}),
    },
  };
  const stageNodes: CanvasNodeRecord[] = stages.map((stage, index) => ({
    id: `${canvasId}-stage-${stage.stageId}`,
    type: "stage",
    position: positions.get(stage.stageId) ?? {
      x: 420 + index * 430,
      y: 120,
    },
    data: {
      label: buildWorkflowStageNodeLabel(stage),
      workflowOverview: true,
      runtimeRole: "workflow_overview",
      workflowCanvasId: canvasId,
      workflowStageId: stage.stageId,
      workflowStageName: stage.name,
      ...(args.parentStageId
        ? { workflowParentStageId: args.parentStageId }
        : {}),
    },
  }));
  const stageNodeById = new Map(
    stages.map((stage, index) => [stage.stageId, stageNodes[index]?.id ?? ""])
  );
  const stageIndexById = new Map(
    stages.map((stage, index) => [stage.stageId, index])
  );
  const stageIndexByNodeId = new Map(
    stageNodes.map((node, index) => [node.id, index])
  );
  const edges: CanvasEdgeRecord[] = [];
  const incomingStageIds = new Set(
    Array.from(transitions.values()).flatMap((targets) => targets)
  );
  const rootStageNodes = stageNodes.filter((node, index) => {
    const stage = stages[index];
    return stage && (index === 0 || !incomingStageIds.has(stage.stageId));
  });
  for (const rootNode of rootStageNodes.length > 0 ? rootStageNodes : stageNodes.slice(0, 1)) {
    edges.push({
      id: makeOrchestrationId(),
      source: startNode.id,
      target: rootNode.id,
    });
  }

  const stageTransitionEdges: CanvasEdgeRecord[] = [];
  stages.forEach((stage, index) => {
    const source = stageNodes[index]?.id;
    if (!source) {
      return;
    }
    for (const targetStageId of transitions.get(stage.stageId) ?? []) {
      const target = stageNodeById.get(targetStageId);
      if (!target) {
        continue;
      }
      const isLoopReturn =
        typeof stageIndexById.get(targetStageId) === "number" &&
        (stageIndexById.get(targetStageId) ?? 0) <= index;
      stageTransitionEdges.push({
        id: makeOrchestrationId(),
        source,
        target,
        ...(isLoopReturn ? { label: "loop / return" } : {}),
      });
    }
  });
  const handleAssignments = getWorkflowStageEdgeHandleAssignments(
    stageTransitionEdges,
    stageIndexByNodeId
  );
  stageTransitionEdges.forEach((edge, index) => {
    const assignment = handleAssignments.get(index);
    edges.push(
      assignment
        ? {
            ...edge,
            sourceHandle: assignment.sourceHandle,
            targetHandle: assignment.targetHandle,
          }
        : edge
    );
  });

  return {
    id: canvasId,
    name: canvasName,
    freeText: [
      WORKFLOW_OVERVIEW_CANVAS_MARKER,
      `Primary agent: ${project.meta.title || project.agentId || project.id}`,
      ...(args.parentStageId
        ? [
            `Parent workflow stage id: ${args.parentStageId}`,
            `Parent workflow stage name: ${
              args.parentStageName || args.parentStageId
            }`,
          ]
        : []),
      ...(args.purpose ? [`Purpose: ${args.purpose}`] : []),
      isChildWorkflow
        ? "This child workflow is editable and non-runtime. If any child stage remains too broad, create another child workflow canvas and get approval before implementation."
        : "This overview is editable and non-runtime. Each stage's state, policy, and reward canvases are stored separately on stage-scoped agent connections.",
    ].join("\n"),
    graph: {
      nodes: [startNode, ...stageNodes],
      edges,
    },
  };
}

function createWorkflowStagePartitionCanvasEntry(
  partition: PlannerWorkflowStagePartition,
  project: OrchestrationProject
): CanvasEntry | null {
  const parentStageName =
    partition.parentStageName?.trim() || partition.parentStageId;
  return createWorkflowCanvasEntry({
    canvasId: partition.canvasId || `workflow-${partition.parentStageId}`,
    canvasName: partition.canvasName || `Workflow: ${parentStageName}`,
    stages: partition.stages,
    project,
    parentStageId: partition.parentStageId,
    parentStageName,
    ...(partition.purpose ? { purpose: partition.purpose } : {}),
  });
}

const WORKFLOW_PARENT_STAGE_ID_PREFIX = "Parent workflow stage id:";

function getWorkflowParentStageId(canvas: CanvasEntry): string {
  const line = (canvas.freeText ?? "")
    .split("\n")
    .find((entry) => entry.trim().startsWith(WORKFLOW_PARENT_STAGE_ID_PREFIX));
  return line?.slice(WORKFLOW_PARENT_STAGE_ID_PREFIX.length).trim() ?? "";
}

function annotateWorkflowChildLinks(canvases: CanvasEntry[]): CanvasEntry[] {
  const childByParentStageId = new Map<string, CanvasEntry>();
  for (const canvas of canvases) {
    const parentStageId = getWorkflowParentStageId(canvas);
    if (parentStageId) {
      childByParentStageId.set(parentStageId, canvas);
    }
  }

  return canvases.map((canvas) => ({
    ...canvas,
    graph: {
      ...canvas.graph,
      nodes: canvas.graph.nodes.map((node) => {
        const workflowStageId =
          typeof node.data?.workflowStageId === "string"
            ? node.data.workflowStageId
            : "";
        if (!workflowStageId) {
          return node;
        }
        const childCanvas = childByParentStageId.get(workflowStageId);
        const data = { ...(node.data ?? {}) };
        delete data.childWorkflowCanvasId;
        delete data.childWorkflowCanvasName;
        delete data.hasChildWorkflow;
        return {
          ...node,
          data: childCanvas
            ? {
                ...data,
                childWorkflowCanvasId: childCanvas.id,
                childWorkflowCanvasName: childCanvas.name,
                hasChildWorkflow: true,
              }
            : data,
        };
      }),
    },
  }));
}

function upsertWorkflowCanvasEntryInDoc(
  workflowDoc: CanvasDoc | null | undefined,
  entry: CanvasEntry
): CanvasDoc {
  const existingCanvases = workflowDoc?.canvases ?? [];
  const canvases = [
    entry,
    ...existingCanvases.filter((canvas) => canvas.id !== entry.id),
  ];
  return {
    version: workflowDoc?.version ?? 2,
    activeId: entry.id,
    canvases: annotateWorkflowChildLinks(canvases),
  };
}

async function materializeInitialCanvasStructuresForPlan(args: {
  openai: OpenAI;
  project: OrchestrationProject;
  plan: PlannerResult;
  runtimeConfig: DaemonRuntimeConfig;
  daemonState: Record<string, unknown> | null;
}): Promise<PlannerResult> {
  const requests = buildInitialCanvasShapeMaterializationRequests({
    project: args.project,
    plan: args.plan,
    daemonState: args.daemonState,
  });
  if (requests.length === 0) {
    return args.plan;
  }

  const reply = await runPlannerPromptCompletion(
    args.openai,
    "You convert abstract canvas-shape specs into normalized InitialCanvasStructure IR for a canvas orchestration runtime. Output JSON only.",
    buildInitialCanvasStructureMaterializationPrompt({
      requests,
      registryRules: args.runtimeConfig.canvasRuleRegistry,
      daemonState: args.daemonState,
    }),
    DAEMON_BUILDER_TOKEN_BUDGETS.initialCanvasStructureMaterialization
  );
  const materializedByKey = parseInitialCanvasStructureMaterializationReply(reply);

  return mergeMaterializedInitialCanvasStructuresIntoPlan(
    args.plan,
    materializedByKey
  );
}

function parseCanvasRuleRepairReply(text: string): {
  canvasEdits: OrchestrationCanvasEdit[];
  notes: string;
} {
  const parsed = parseJsonObject<{
    canvasEdits?: unknown;
    notes?: unknown;
  }>(text);
  const canvasEdits = Array.isArray(parsed?.canvasEdits)
    ? parsed.canvasEdits
        .map((edit) => normalizePlannerCanvasEdit(edit))
        .filter((edit): edit is OrchestrationCanvasEdit => edit !== null)
    : [];

  return {
    canvasEdits,
    notes: asString(parsed?.notes),
  };
}

interface CanvasRuleModelIssue {
  ruleId: string;
  summary: string;
  evidence: string;
  canvasId?: string;
  canvasName?: string;
  nodeId?: string;
  edgeId?: string;
}

interface CanvasRulePromptField {
  name: string;
  type: OrchestrationProject["fields"][number]["type"];
  initialValue?: string | null;
}

interface CanvasRulePromptHeuristicIssue {
  ruleId: string;
  summary: string;
  canvasId?: string;
  canvasName?: string;
  nodeId?: string;
  edgeId?: string;
  evidence?: string;
}

type CanvasRuleTarget = "policy" | "state" | "workflow";

function renderPlannerCanvasRuleRegistry(
  registryRules: readonly CanvasRuleDefinition[]
): string {
  const policyRules = getCanvasRuleDefinitionsForScope(registryRules, "policy", {
    checkMode: "rule_registry",
  });
  const stateRules = getCanvasRuleDefinitionsForScope(registryRules, "state", {
    checkMode: "rule_registry",
  });
  const workflowRules = getCanvasRuleDefinitionsForScope(registryRules, "workflow", {
    checkMode: "rule_registry",
  });
  const ruleById = new Map<string, CanvasRuleDefinition>();
  const scopeByRuleId = new Map<string, Set<CanvasRuleTarget>>();

  for (const rule of policyRules) {
    ruleById.set(rule.id, rule);
    const scopes = scopeByRuleId.get(rule.id) ?? new Set<CanvasRuleTarget>();
    scopes.add("policy");
    scopeByRuleId.set(rule.id, scopes);
  }

  for (const rule of stateRules) {
    ruleById.set(rule.id, rule);
    const scopes = scopeByRuleId.get(rule.id) ?? new Set<CanvasRuleTarget>();
    scopes.add("state");
    scopeByRuleId.set(rule.id, scopes);
  }

  for (const rule of workflowRules) {
    ruleById.set(rule.id, rule);
    const scopes = scopeByRuleId.get(rule.id) ?? new Set<CanvasRuleTarget>();
    scopes.add("workflow");
    scopeByRuleId.set(rule.id, scopes);
  }

  const orderedRules = [...ruleById.values()];
  if (orderedRules.length === 0) {
    return "- (none)";
  }

  return orderedRules
    .map((rule) => {
      const scopes = scopeByRuleId.get(rule.id) ?? new Set<CanvasRuleTarget>();
      const scopeLabel = (["policy", "state", "workflow"] as CanvasRuleTarget[])
        .filter((scope) => scopes.has(scope))
        .join(",");
      return [
        `- [${scopeLabel || rule.scope}] ${rule.id}: ${rule.title}`,
        `  Description: ${rule.description}`,
        `  Repair: ${rule.repairGuidance}`,
      ].join("\n");
    })
    .join("\n");
}

interface CanvasRuleDocRequest {
  docKey: string;
  target: CanvasRuleTarget;
  isRewardCanvas?: boolean;
  canvasRole: string;
  canvasLabel: string;
  docSummary: string;
  stateFields: CanvasRulePromptField[];
  heuristicIssues: CanvasRulePromptHeuristicIssue[];
  rules: CanvasRuleDefinition[];
}

interface CanvasRuleRequestBundle {
  generalDescription: string;
  processDescription: string;
  currentBuildMeta: ReturnType<typeof buildCurrentBuildSnapshot>["meta"];
  requests: CanvasRuleDocRequest[];
}

interface CanvasRulePromptIssue extends CanvasRuleModelIssue {
  docKey: string;
  target: CanvasRuleTarget;
}

interface CanvasRuleRepairRequest extends CanvasRuleDocRequest {
  issues: CanvasRulePromptIssue[];
}

interface CanvasRuleRepairRequestBundle {
  generalDescription: string;
  processDescription: string;
  currentBuildMeta: ReturnType<typeof buildCurrentBuildSnapshot>["meta"];
  requests: CanvasRuleRepairRequest[];
}

interface CanvasRuleRepairEditGroup {
  docKey: string;
  target: CanvasRuleTarget;
  canvasEdits: OrchestrationCanvasEdit[];
  notes?: string;
}

interface PreparedCanvasRuleRequests {
  project: OrchestrationProject;
  bundle: CanvasRuleRequestBundle;
  appliedChanges: string[];
}

interface CanvasRuleDocContext {
  docKey: string;
  target: CanvasRuleTarget;
  isRewardCanvas?: boolean;
  canvasRole: string;
  canvasLabel: string;
  stateFields: OrchestrationProject["fields"];
  doc: OrchestrationProject["policyCanvases"];
}

function readCanvasRulePromptBoolean(
  promptValues: PromptValueSnapshot,
  key: string
): boolean {
  const value = promptValues[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return /^(true|yes|1)$/i.test(value.trim());
  }
  return false;
}

function readCanvasRulePromptStringArray(
  promptValues: PromptValueSnapshot,
  key: string
): string[] {
  const value = promptValues[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function dedupeCanvasRulePromptStringArray(values: string[]): string[] {
  const dedupe = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || dedupe.has(trimmed)) {
      continue;
    }
    dedupe.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function buildCanvasRuleRepairPassResetPromptValues(): PromptValueSnapshot {
  return {
    [CANVAS_RULE_DETECTED_ISSUES_PROMPT_VALUE_NAME]: [],
    [CANVAS_RULE_REPAIR_REQUESTS_PROMPT_VALUE_NAME]: [],
    [CANVAS_RULE_REPAIR_EDITS_PROMPT_VALUE_NAME]: [],
    [CANVAS_RULE_RECHECK_REQUESTS_PROMPT_VALUE_NAME]: [],
    [CANVAS_RULE_REMAINING_ISSUES_PROMPT_VALUE_NAME]: [],
    [CANVAS_RULE_REPAIR_CHANGES_APPLIED_PROMPT_VALUE_NAME]: false,
    [CANVAS_RULE_REPAIR_CHANGE_SUMMARIES_PROMPT_VALUE_NAME]: [],
    [CANVAS_RULE_RECHECK_CHANGE_SUMMARIES_PROMPT_VALUE_NAME]: [],
    [CANVAS_RULE_ANY_CHANGES_APPLIED_PROMPT_VALUE_NAME]: false,
  };
}

function normalizeCanvasRulePromptFields(
  fields: OrchestrationProject["fields"]
): CanvasRulePromptField[] {
  return fields.map((field) => ({
    name: field.name,
    type: field.type,
    initialValue: field.initialValue,
  }));
}

const REWARD_CANVAS_POLICY_RULE_EXCLUSION_IDS = new Set([
  "policy_canvases_must_have_editable_commit_code",
  "text_agent_actions_require_display_node",
]);

function filterCanvasRuleDefinitionsForRewardCanvas(
  rules: CanvasRuleDefinition[],
  isRewardCanvas: boolean
): CanvasRuleDefinition[] {
  if (!isRewardCanvas) {
    return rules;
  }

  return rules.filter(
    (rule) => !REWARD_CANVAS_POLICY_RULE_EXCLUSION_IDS.has(rule.id)
  );
}

function cloneCanvasRuleDefinitionsForPrompt(
  target: CanvasRuleTarget,
  sessionRules: SessionInferredRule[] = [],
  registryRules: readonly CanvasRuleDefinition[] = [],
  options: { isRewardCanvas?: boolean } = {}
): CanvasRuleDefinition[] {
  return filterCanvasRuleDefinitionsForRewardCanvas([
    ...getCanvasRuleDefinitionsForScope(registryRules, target, {
      checkMode: "rule_registry",
    }).map((rule) => ({ ...rule })),
    ...filterSessionInferredRulesForTarget(sessionRules, target).map((rule) => ({
      ...rule,
    })),
  ], Boolean(options.isRewardCanvas));
}

function getRegistryCanvasRuleDefinitionsForContext(args: {
  registryRules: readonly CanvasRuleDefinition[];
  target: CanvasRuleTarget;
  isRewardCanvas: boolean;
}): CanvasRuleDefinition[] {
  return filterCanvasRuleDefinitionsForRewardCanvas(
    getCanvasRuleDefinitionsForScope(args.registryRules, args.target, {
      checkMode: "rule_registry",
    }),
    args.isRewardCanvas
  );
}

function buildCanvasRulePromptMeta(args: {
  project: OrchestrationProject;
  daemonState: Record<string, unknown> | null;
}): {
  generalDescription: string;
  processDescription: string;
  currentBuildMeta: ReturnType<typeof buildCurrentBuildSnapshot>["meta"];
} {
  const processModel = readProcessModelSnapshot(args.daemonState);
  return {
    generalDescription:
      readDaemonStateString(args.daemonState, ["general_description"]) ||
      args.project.meta.policyIntent.trim(),
    processDescription:
      readDaemonStateString(args.daemonState, ["process_description"]) ||
      (processModel ? buildProcessDescriptionFromModel(processModel) : ""),
    currentBuildMeta: buildCurrentBuildSnapshot(args.project).meta,
  };
}

function collectCanvasRuleDocContexts(
  project: OrchestrationProject
): CanvasRuleDocContext[] {
  const contexts: CanvasRuleDocContext[] = [
    {
      docKey: "workflow",
      target: "workflow",
      canvasRole: "workflow canvas",
      canvasLabel: "workflow",
      stateFields: project.fields,
      doc: getProjectWorkflowCanvasDoc(project),
    },
    {
      docKey: "main_policy",
      target: "policy",
      canvasRole: "main policy canvas",
      canvasLabel: "policy",
      stateFields: project.fields,
      doc: getRuntimePolicyCanvasDoc(project.policyCanvases),
    },
    {
      docKey: "main_state",
      target: "state",
      canvasRole: "main state canvas",
      canvasLabel: "state",
      stateFields: project.fields,
      doc: project.statePolicyCanvases,
    },
  ];

  project.environmentPlayers.forEach((player, index) => {
    const labelPrefix = `environment agent ${index + 1}`;
    contexts.push({
      docKey: `environment_${index}_policy`,
      target: "policy",
      canvasRole: `${labelPrefix} policy canvas`,
      canvasLabel: `${labelPrefix} policy`,
      stateFields: player.fields,
      doc: player.policyCanvases,
    });
    contexts.push({
      docKey: `environment_${index}_state`,
      target: "state",
      canvasRole: `${labelPrefix} state canvas`,
      canvasLabel: `${labelPrefix} state`,
      stateFields: player.fields,
      doc: player.statePolicyCanvases,
    });
  });

  project.agentConnections.forEach((connection, index) => {
    const targetLabel =
      connection.targetAgentTitle.trim() ||
      connection.targetAgentId.trim() ||
      `target ${index + 1}`;
    const connectionTargetFields = Array.isArray(connection.targetFields)
      ? connection.targetFields
      : [];
    const targetFields = connectionTargetFields.length
      ? connectionTargetFields
      : createEmptyOrchestrationEnvironmentPlayer().fields;
    contexts.push({
      docKey: `agent_connection_${index}_source_policy`,
      target: "policy",
      canvasRole: `primary side of connection to ${targetLabel} policy canvas`,
      canvasLabel: `agent connection ${connection.id} source policy`,
      stateFields: project.fields,
      doc: connection.sourcePolicyCanvases,
    });
    contexts.push({
      docKey: `agent_connection_${index}_source_state`,
      target: "state",
      canvasRole: `primary side of connection to ${targetLabel} state canvas`,
      canvasLabel: `agent connection ${connection.id} source state`,
      stateFields: project.fields,
      doc: connection.sourceStatePolicyCanvases,
    });
    contexts.push({
      docKey: `agent_connection_${index}_source_reward`,
      target: "policy",
      isRewardCanvas: true,
      canvasRole: `source-to-target reward canvas for connection to ${targetLabel}`,
      canvasLabel: `agent connection ${connection.id} source reward`,
      stateFields: targetFields,
      doc: connection.sourceRewardCanvases,
    });
    contexts.push({
      docKey: `agent_connection_${index}_target_policy`,
      target: "policy",
      canvasRole: `target side of connection to ${targetLabel} policy canvas`,
      canvasLabel: `agent connection ${connection.id} target policy`,
      stateFields: targetFields,
      doc: connection.targetPolicyCanvases ?? connection.policyCanvases,
    });
    contexts.push({
      docKey: `agent_connection_${index}_target_state`,
      target: "state",
      canvasRole: `target side of connection to ${targetLabel} state canvas`,
      canvasLabel: `agent connection ${connection.id} target state`,
      stateFields: targetFields,
      doc: connection.targetStatePolicyCanvases,
    });
    contexts.push({
      docKey: `agent_connection_${index}_target_reward`,
      target: "policy",
      isRewardCanvas: true,
      canvasRole: `target-to-source reward canvas for connection to ${targetLabel}`,
      canvasLabel: `agent connection ${connection.id} target reward`,
      stateFields: project.fields,
      doc: connection.targetRewardCanvases,
    });
  });

  return contexts;
}

function updateProjectCanvasRuleDoc(
  project: OrchestrationProject,
  docKey: string,
  doc: OrchestrationProject["policyCanvases"]
): OrchestrationProject {
  if (docKey === "workflow") {
    return {
      ...project,
      workflowCanvases: getWorkflowOverviewCanvasDoc(doc),
      policyCanvases: getRuntimePolicyCanvasDoc(project.policyCanvases),
    };
  }

  if (docKey === "main_policy") {
    return {
      ...project,
      policyCanvases: getRuntimePolicyCanvasDoc(doc),
    };
  }

  if (docKey === "main_state") {
    return {
      ...project,
      statePolicyCanvases: doc,
    };
  }

  const connectionMatch = docKey.match(
    /^agent_connection_(\d+)_(source|target)_(policy|state|reward)$/
  );
  if (connectionMatch) {
    const index = Number(connectionMatch[1]);
    const side = connectionMatch[2];
    const kind = connectionMatch[3];
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= project.agentConnections.length
    ) {
      return project;
    }

    return {
      ...project,
      agentConnections: project.agentConnections.map((connection, connectionIndex) =>
        connectionIndex === index
          ? syncAgentConnectionDerivedPrompts({
              ...connection,
              ...(side === "source" && kind === "policy"
                ? { sourcePolicyCanvases: doc }
                : {}),
              ...(side === "source" && kind === "state"
                ? { sourceStatePolicyCanvases: doc }
                : {}),
              ...(side === "source" && kind === "reward"
                ? { sourceRewardCanvases: doc }
                : {}),
              ...(side === "target" && kind === "policy"
                ? { targetPolicyCanvases: doc, policyCanvases: doc }
                : {}),
              ...(side === "target" && kind === "state"
                ? { targetStatePolicyCanvases: doc }
                : {}),
              ...(side === "target" && kind === "reward"
                ? { targetRewardCanvases: doc }
                : {}),
            })
          : connection
      ),
    };
  }

  const environmentMatch = docKey.match(/^environment_(\d+)_(policy|state)$/);
  if (!environmentMatch) {
    return project;
  }

  const index = Number(environmentMatch[1]);
  if (!Number.isInteger(index) || index < 0 || index >= project.environmentPlayers.length) {
    return project;
  }

  const kind = environmentMatch[2];
  return {
    ...project,
    environmentPlayers: project.environmentPlayers.map((player, playerIndex) =>
      playerIndex !== index
        ? player
        : kind === "policy"
          ? {
              ...player,
              policyCanvases: doc,
            }
          : {
              ...player,
              statePolicyCanvases: doc,
            }
    ),
  };
}

function prepareCanvasRuleDetectionRequests(args: {
  project: OrchestrationProject;
  daemonState: Record<string, unknown> | null;
  sessionRules: SessionInferredRule[];
  registryRules: readonly CanvasRuleDefinition[];
}): PreparedCanvasRuleRequests {
  let nextProject = args.project;
  const appliedChanges: string[] = [];
  const requests: CanvasRuleDocRequest[] = [];
  const meta = buildCanvasRulePromptMeta(args);

  for (const context of collectCanvasRuleDocContexts(nextProject)) {
    const registryRulesForTarget = getRegistryCanvasRuleDefinitionsForContext({
      registryRules: args.registryRules,
      target: context.target,
      isRewardCanvas: Boolean(context.isRewardCanvas),
    });
    const inspection = inspectCanvasRuleViolationsForDoc(
      context.doc,
      context.stateFields,
      context.canvasLabel,
      registryRulesForTarget,
      context.target
    );
    nextProject = updateProjectCanvasRuleDoc(
      nextProject,
      context.docKey,
      inspection.doc
    );
    appliedChanges.push(
      ...inspection.canonicalizationChanges.map(
        (summary) => `${context.canvasRole}: ${summary}`
      ),
      ...inspection.suggestedRepairChanges.map(
        (summary) => `${context.canvasRole}: ${summary}`
      )
    );

    if (!inspection.doc) {
      continue;
    }

    requests.push({
      docKey: context.docKey,
      target: context.target,
      isRewardCanvas: context.isRewardCanvas,
      canvasRole: context.canvasRole,
      canvasLabel: context.canvasLabel,
      docSummary: summarizeCanvasDocForPrompt(inspection.doc),
      stateFields: normalizeCanvasRulePromptFields(context.stateFields),
      heuristicIssues: inspection.heuristicIssues.map((issue) => ({
        ruleId: issue.ruleId,
        summary: issue.summary,
        canvasId: issue.canvasId,
        canvasName: issue.canvasName,
        nodeId: issue.nodeId,
        edgeId: issue.edgeId,
        evidence: issue.evidence,
      })),
      rules: cloneCanvasRuleDefinitionsForPrompt(
        context.target,
        args.sessionRules,
        args.registryRules,
        { isRewardCanvas: Boolean(context.isRewardCanvas) }
      ),
    });
  }

  return {
    project: nextProject,
    bundle: {
      ...meta,
      requests,
    },
    appliedChanges,
  };
}

function normalizeCanvasRulePromptIssuesValue(
  value: unknown
): CanvasRulePromptIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const issues: CanvasRulePromptIssue[] = [];
  const dedupe = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const docKey = asString(record.docKey);
    const target =
      record.target === "workflow"
        ? "workflow"
        : record.target === "state"
          ? "state"
          : record.target === "policy"
            ? "policy"
            : null;
    const ruleId = asString(record.ruleId);
    const summary = asString(record.summary);
    if (!docKey || !target || !ruleId || !summary) {
      continue;
    }

    const issue: CanvasRulePromptIssue = {
      docKey,
      target,
      ruleId,
      summary,
      evidence: asString(record.evidence),
      canvasId: asString(record.canvasId) || undefined,
      canvasName: asString(record.canvasName) || undefined,
      nodeId: asString(record.nodeId) || undefined,
      edgeId: asString(record.edgeId) || undefined,
    };
    const dedupeKey = [
      issue.docKey,
      issue.target,
      issue.ruleId,
      issue.canvasId ?? "",
      issue.nodeId ?? "",
      issue.edgeId ?? "",
      issue.summary,
    ].join("::");
    if (dedupe.has(dedupeKey)) {
      continue;
    }
    dedupe.add(dedupeKey);
    issues.push(issue);
  }

  return issues;
}

function buildCanvasRuleRepairRequestsFromDetectedIssues(
  bundleValue: unknown,
  issues: CanvasRulePromptIssue[]
): CanvasRuleRepairRequestBundle {
  const bundle =
    bundleValue &&
    typeof bundleValue === "object" &&
    !Array.isArray(bundleValue) &&
    Array.isArray((bundleValue as { requests?: unknown }).requests)
      ? (bundleValue as CanvasRuleRequestBundle)
      : {
          generalDescription: "",
          processDescription: "",
          currentBuildMeta: buildCurrentBuildSnapshot(
            createEmptyOrchestrationProject()
          ).meta,
          requests: [],
        };

  const issuesByDocKey = new Map<string, CanvasRulePromptIssue[]>();
  for (const issue of issues) {
    const group = issuesByDocKey.get(issue.docKey) ?? [];
    group.push(issue);
    issuesByDocKey.set(issue.docKey, group);
  }

  return {
    generalDescription: bundle.generalDescription,
    processDescription: bundle.processDescription,
    currentBuildMeta: bundle.currentBuildMeta,
    requests: (bundle.requests ?? [])
      .map((request) => ({
        ...request,
        issues: issuesByDocKey.get(request.docKey) ?? [],
      }))
      .filter((request) => request.issues.length > 0),
  };
}

function normalizeCanvasRuleRepairEditGroupsValue(
  value: unknown
): CanvasRuleRepairEditGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const groups: CanvasRuleRepairEditGroup[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const docKey = asString(record.docKey);
    const target =
      record.target === "workflow"
        ? "workflow"
        : record.target === "state"
          ? "state"
          : record.target === "policy"
            ? "policy"
            : null;
    const edits = Array.isArray(record.canvasEdits)
      ? record.canvasEdits
          .map((edit) => normalizePlannerCanvasEdit(edit))
          .filter((edit): edit is OrchestrationCanvasEdit => edit !== null)
      : [];
    if (!docKey || !target) {
      continue;
    }

    groups.push({
      docKey,
      target,
      canvasEdits: edits,
      notes: asString(record.notes) || undefined,
    });
  }

  return groups;
}

function applyCanvasRuleRepairEditGroups(args: {
  project: OrchestrationProject;
  repairGroups: CanvasRuleRepairEditGroup[];
}): {
  project: OrchestrationProject;
  appliedChanges: string[];
} {
  let nextProject = args.project;
  const appliedChanges: string[] = [];

  for (const group of args.repairGroups) {
    const context = collectCanvasRuleDocContexts(nextProject).find(
      (candidate) =>
        candidate.docKey === group.docKey && candidate.target === group.target
    );
    if (!context) {
      continue;
    }

    const relevantEdits = group.canvasEdits.filter(
      (edit) => edit.target === context.target
    );
    if (relevantEdits.length === 0) {
      continue;
    }

    const applyResult = applyCanvasEdits(context.doc, relevantEdits);
    nextProject = updateProjectCanvasRuleDoc(
      nextProject,
      context.docKey,
      applyResult.doc ?? context.doc
    );
    appliedChanges.push(
      ...applyResult.appliedChanges.map(
        (summary) => `${context.canvasRole}: ${summary}`
      )
    );
  }

  return {
    project: nextProject,
    appliedChanges,
  };
}

function renderCanvasRulesForPrompt(
  target: CanvasRuleTarget,
  sessionRules: SessionInferredRule[] = [],
  registryRules: readonly CanvasRuleDefinition[] = []
): string {
  return cloneCanvasRuleDefinitionsForPrompt(target, sessionRules, registryRules)
    .map(
      (rule) =>
        `- ${rule.id}: ${rule.title}\n  Description: ${rule.description}\n  Repair: ${rule.repairGuidance}`
    )
    .join("\n");
}

function parseCanvasRuleIssueDetectionReply(args: {
  text: string;
  target: CanvasRuleTarget;
  sessionRules?: SessionInferredRule[];
  registryRules: readonly CanvasRuleDefinition[];
}): CanvasRuleModelIssue[] {
  const validRuleIds = new Set(
    cloneCanvasRuleDefinitionsForPrompt(
      args.target,
      args.sessionRules ?? [],
      args.registryRules
    ).map((rule) => rule.id)
  );
  const parsed = parseJsonObject<{
    issues?: Array<Record<string, unknown>>;
  }>(args.text);

  const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
  const dedupe = new Set<string>();

  return issues.flatMap((issue) => {
    const ruleId = asString(issue?.ruleId);
    if (!ruleId || !validRuleIds.has(ruleId)) {
      return [];
    }

    const normalized: CanvasRuleModelIssue = {
      ruleId,
      summary: asString(issue?.summary),
      evidence: asString(issue?.evidence),
      canvasId: asOptionalString(issue?.canvasId),
      canvasName: asOptionalString(issue?.canvasName),
      nodeId: asOptionalString(issue?.nodeId),
      edgeId: asOptionalString(issue?.edgeId),
    };

    if (!normalized.summary) {
      return [];
    }

    const key = [
      normalized.ruleId,
      normalized.canvasId ?? "",
      normalized.nodeId ?? "",
      normalized.edgeId ?? "",
      normalized.summary,
    ].join("|");
    if (dedupe.has(key)) {
      return [];
    }
    dedupe.add(key);
    return [normalized];
  });
}

function buildCanvasRuleIssueDetectionPrompt(args: {
  project: OrchestrationProject;
  daemonState: Record<string, unknown> | null;
  sessionRules: SessionInferredRule[];
  registryRules: readonly CanvasRuleDefinition[];
  target: CanvasRuleTarget;
  canvasRole: string;
  canvasLabel: string;
  docSummary: string;
  stateFields: OrchestrationProject["fields"];
  heuristicIssues: Array<{
    ruleId: string;
    summary: string;
    canvasId?: string;
    canvasName?: string;
    nodeId?: string;
    edgeId?: string;
    evidence?: string;
  }>;
}): string {
  const processModel = readProcessModelSnapshot(args.daemonState);
  const processDescription =
    readDaemonStateString(args.daemonState, ["process_description"]) ||
    (processModel ? buildProcessDescriptionFromModel(processModel) : "");
  const generalDescription =
    readDaemonStateString(args.daemonState, ["general_description"]) ||
    args.project.meta.policyIntent.trim();
  const stateFieldLines =
    args.stateFields.length > 0
      ? args.stateFields
          .map(
            (field) =>
              `- ${field.name} (${field.type}) initial=${field.initialValue || "null"}`
          )
          .join("\n")
      : "- (none)";
  const heuristicLines =
    args.heuristicIssues.length > 0
      ? args.heuristicIssues
          .map((issue) =>
            [
              `- ${issue.ruleId}: ${issue.summary}`,
              issue.canvasName || issue.canvasId
                ? `  canvas=${JSON.stringify(issue.canvasName || issue.canvasId)}`
                : "",
              issue.nodeId ? `  nodeId=${issue.nodeId}` : "",
              issue.edgeId ? `  edgeId=${issue.edgeId}` : "",
              issue.evidence ? `  evidence=${issue.evidence}` : "",
            ]
              .filter(Boolean)
              .join("\n")
          )
          .join("\n")
      : "- (none)";

  return [
    `Check the ${args.canvasRole} for rule issues.`,
    "Return JSON only.",
    "",
    "General description:",
    generalDescription || "(none)",
    "",
    "Draft-change constraints and preferences:",
    renderDraftChangeConstraintsContext({
      daemonState: args.daemonState,
      registryRules: args.registryRules,
      sessionRules: args.sessionRules,
      target: args.target,
    }),
    "",
    "Session-specific inferred rules:",
    renderSessionInferredRulesForPrompt(args.sessionRules, args.target),
    "",
    "Confirmed process description:",
    processDescription || "(none)",
    "",
    `State fields for the ${args.canvasLabel} canvas:`,
    stateFieldLines,
    "",
    "Canvas rule registry:",
    renderCanvasRulesForPrompt(
      args.target,
      args.sessionRules,
      args.registryRules
    ) || "- (none)",
    "",
    `Current ${args.canvasRole} summary:`,
    args.docSummary,
    "",
    "Heuristic hints from local analysis (non-authoritative):",
    heuristicLines,
    "",
    "Return strict JSON with this shape:",
    "{",
    '  "issues": [{ "ruleId": string, "summary": string, "evidence": string, "canvasId": string, "canvasName": string, "nodeId": string, "edgeId": string }]',
    "}",
    "",
    "Protocol:",
    "- Only report issues that genuinely violate one of the listed rule ids.",
    "- Use exact ids from the canvas summary whenever possible.",
    "- Leave optional ids empty when they are not identifiable from the canvas summary.",
    "- Return an empty issues array when the canvas is already compliant enough for this rule pass.",
  ].join("\n");
}

async function detectCanvasRuleIssuesForDocWithModel(args: {
  openai: OpenAI;
  project: OrchestrationProject;
  daemonState: Record<string, unknown> | null;
  sessionRules: SessionInferredRule[];
  registryRules: readonly CanvasRuleDefinition[];
  doc: OrchestrationProject["policyCanvases"];
  stateFields: OrchestrationProject["fields"];
  target: CanvasRuleTarget;
  canvasRole: string;
  canvasLabel: string;
}): Promise<{
  doc: OrchestrationProject["policyCanvases"];
  canonicalizationChanges: string[];
  heuristicIssues: Array<{
    ruleId: string;
    summary: string;
    canvasId?: string;
    canvasName?: string;
    nodeId?: string;
    edgeId?: string;
    evidence?: string;
  }>;
  modelIssues: CanvasRuleModelIssue[];
}> {
  const inspection = inspectCanvasRuleViolationsForDoc(
    args.doc,
    args.stateFields,
    args.canvasLabel,
    getCanvasRuleDefinitionsForScope(args.registryRules, args.target, {
      checkMode: "rule_registry",
    }),
    args.target
  );
  if (!inspection.doc) {
    return {
      doc: inspection.doc,
      canonicalizationChanges: [
        ...inspection.canonicalizationChanges,
        ...inspection.suggestedRepairChanges,
      ],
      heuristicIssues: inspection.heuristicIssues,
      modelIssues: [],
    };
  }

  const reply = await runPlannerPromptCompletion(
    args.openai,
    "You inspect a canvas against a supplied rule registry and report only real rule violations. Output JSON only.",
    buildCanvasRuleIssueDetectionPrompt({
      project: args.project,
      daemonState: args.daemonState,
      sessionRules: args.sessionRules,
      registryRules: args.registryRules,
      target: args.target,
      canvasRole: args.canvasRole,
      canvasLabel: args.canvasLabel,
      docSummary: summarizeCanvasDocForPrompt(inspection.doc),
      stateFields: args.stateFields,
      heuristicIssues: inspection.heuristicIssues,
    }),
    DAEMON_BUILDER_TOKEN_BUDGETS.canvasRuleIssueDetection
  );

  return {
    doc: inspection.doc,
    canonicalizationChanges: [
      ...inspection.canonicalizationChanges,
      ...inspection.suggestedRepairChanges,
    ],
    heuristicIssues: inspection.heuristicIssues,
    modelIssues: parseCanvasRuleIssueDetectionReply({
      text: reply,
      target: args.target,
      sessionRules: args.sessionRules,
      registryRules: args.registryRules,
    }),
  };
}

function buildCanvasRuleRepairPrompt(args: {
  project: OrchestrationProject;
  daemonState: Record<string, unknown> | null;
  sessionRules: SessionInferredRule[];
  registryRules: readonly CanvasRuleDefinition[];
  target: CanvasRuleTarget;
  canvasRole: string;
  canvasLabel: string;
  docSummary: string;
  stateFields: OrchestrationProject["fields"];
  issues: CanvasRuleModelIssue[];
  heuristicIssues: Array<{
    ruleId: string;
    summary: string;
    canvasId?: string;
    canvasName?: string;
    nodeId?: string;
    edgeId?: string;
    evidence?: string;
  }>;
}): string {
  const processModel = readProcessModelSnapshot(args.daemonState);
  const processDescription =
    readDaemonStateString(args.daemonState, ["process_description"]) ||
    (processModel ? buildProcessDescriptionFromModel(processModel) : "");
  const generalDescription =
    readDaemonStateString(args.daemonState, ["general_description"]) ||
    args.project.meta.policyIntent.trim();
  const buildMeta = buildCurrentBuildSnapshot(args.project).meta;
  const stateFieldLines =
    args.stateFields.length > 0
      ? args.stateFields
          .map(
            (field) =>
              `- ${field.name} (${field.type}) initial=${field.initialValue || "null"}`
          )
          .join("\n")
      : "- (none)";
  const issueLines =
    args.issues.length > 0
      ? args.issues
          .map(
            (issue) =>
              `- ${issue.ruleId}: ${issue.summary}${issue.evidence ? ` | evidence=${issue.evidence}` : ""}${issue.canvasName || issue.canvasId ? ` | canvas=${JSON.stringify(issue.canvasName || issue.canvasId)}` : ""}${issue.nodeId ? ` | nodeId=${issue.nodeId}` : ""}${issue.edgeId ? ` | edgeId=${issue.edgeId}` : ""}`
          )
          .join("\n")
      : "- (none)";
  const heuristicLines =
    args.heuristicIssues.length > 0
      ? args.heuristicIssues
          .map(
            (issue) =>
              `- ${issue.ruleId}: ${issue.summary}${issue.evidence ? ` | evidence=${issue.evidence}` : ""}`
          )
          .join("\n")
      : "- (none)";

  return [
    `Repair the ${args.canvasRole} by returning only structured canvas edits.`,
    "Return JSON only.",
    "",
    "Current draft meta:",
    JSON.stringify(buildMeta, null, 2),
    "",
    "General description:",
    generalDescription || "(none)",
    "",
    "Draft-change constraints and preferences:",
    renderDraftChangeConstraintsContext({
      daemonState: args.daemonState,
      registryRules: args.registryRules,
      sessionRules: args.sessionRules,
      target: args.target,
    }),
    "",
    "Session-specific inferred rules:",
    renderSessionInferredRulesForPrompt(args.sessionRules, args.target),
    "",
    "Confirmed process description:",
    processDescription || "(none)",
    "",
    `State fields for the ${args.canvasLabel} canvas:`,
    stateFieldLines,
    "",
    "Canvas rule registry:",
    renderCanvasRulesForPrompt(
      args.target,
      args.sessionRules,
      args.registryRules
    ) || "- (none)",
    "",
    `Current ${args.canvasRole} summary:`,
    args.docSummary,
    "",
    "Rule registry issues:",
    issueLines,
    "",
    "Heuristic hints from local analysis (non-authoritative):",
    heuristicLines,
    "",
    "Return strict JSON with this shape:",
    "{",
    '  "canvasEdits": [{ "target": "policy" | "state" | "workflow", "op": "add_canvas" | "rename_canvas" | "set_canvas_notes" | "set_active_canvas" | "add_node" | "insert_node_before" | "insert_node_after" | "update_node" | "delete_node" | "add_edge" | "update_edge" | "delete_edge", "canvasId": string, "canvasName": string, "nextName": string, "notes": string, "nodeKey": string, "nodeType": "start" | "condition" | "for" | "while" | "stage" | "prompt" | "code" | "tool_call" | "display" | "expand" | "build_default_primary_state_schema" | "build_default_environment_state_schema" | "build_initial_canvas_shape_materialization_requests" | "materialize_initial_canvas_structures" | "merge_materialized_initial_canvas_structures" | "prepare_canvas_rule_detection_requests" | "build_canvas_rule_repair_requests" | "apply_canvas_rule_repairs" | "prepare_canvas_rule_recheck_requests" | "finalize_canvas_rule_repair_pass" | "apply_structured_patch" | "scaffold_tools" | "sync_derived_prompts" | "repair_canvas_rules" | "finalize_assistant_reply" | "raise_error", "label": string, "x": number, "y": number, "data": object, "nodeRef": { "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "sourceRef": { "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "targetRef": { "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "edgeId": string, "sourceHandle": string | null, "edgeLabel": string }],',
    '  "notes": string',
    "}",
    "",
    "Protocol:",
    `- Set target=${JSON.stringify(args.target)} on every edit.`,
    "- Use the exact canvasId, node ids, and edge ids from the summary whenever possible.",
    "- Keep the repair minimal and do not rewrite unrelated labels or branches.",
    "- Prefer update_node, insert_node_before, insert_node_after, delete_edge, update_edge, add_node, and add_edge over broad canvas rebuilds.",
    "- For insert_node_before, nodeRef is the existing node to insert before and optional sourceRef limits the incoming edge to reroute. For insert_node_after, nodeRef is the existing node to insert after and optional targetRef limits the outgoing edge to reroute.",
    "- For a condition node missing TRUE/FALSE branches, first reuse obvious existing distinct targets when possible, then reconnect nearby disconnected branch-entry nodes when the layout strongly suggests they belong under that condition; if no reliable branch target exists, leave that branch unwired so it ends at the condition.",
    "- For prompt-like clarification gates, convert the original condition node into a prompt action, add a real condition node immediately after it, and reconnect the existing true/false branches.",
    '- For likely misclassified condition nodes with no real branching, convert them into action nodes with data.actionType="prompt".',
    '- For deterministic state-update prompt nodes, convert them into Code mode with data.actionType="code" while preserving executable backing, label, and wiring.',
    "- For state-field updates that require model judgment, such as updating a summary field from the current observation, keep the node as an ordinary Prompt/update node rather than Prompt transform.",
    '- Use prompt_transform on state canvases only when rewriting an existing local or state value for later consumption; set data.inputVariable to the source local or state field and data.outputVariable to the newly defined local, and do not use it as a direct state-field update node.',
    "- For policy authoring leakage, rewrite labels so they describe the runtime behavior of the target demo rather than setup/editing workflow text.",
    "- For workflow temporal-stage violations, preserve stage nodes and repair only the workflow map: add missing stage-to-stage edges, label back-edges as loop/return when helpful, and update broad stage labels into concrete temporal stages. Do not add policy/state/reward implementation details to workflow canvases.",
    "- For likely unnecessary order edges, remove them with delete_edge using the flagged edgeId.",
    "- For session-specific inferred rule violations, make the smallest structural change that brings the draft back into alignment with the active session rule while preserving unrelated structure.",
    "- Do not add or remove canvases unless that is truly required to perform the repair.",
    "- Return an empty canvasEdits array if no repair is needed.",
  ].join("\n");
}

async function repairCanvasRuleViolationsForDocWithModel(args: {
  openai: OpenAI;
  project: OrchestrationProject;
  daemonState: Record<string, unknown> | null;
  sessionRules: SessionInferredRule[];
  registryRules: readonly CanvasRuleDefinition[];
  doc: OrchestrationProject["policyCanvases"];
  stateFields: OrchestrationProject["fields"];
  target: CanvasRuleTarget;
  canvasRole: string;
  canvasLabel: string;
}): Promise<{
  doc: OrchestrationProject["policyCanvases"];
  appliedChanges: string[];
  violationsDetected: boolean;
  violationsRemaining: boolean;
  retryNeeded: boolean;
}> {
  const initialDetection = await detectCanvasRuleIssuesForDocWithModel({
    openai: args.openai,
    project: args.project,
    daemonState: args.daemonState,
    sessionRules: args.sessionRules,
    registryRules: args.registryRules,
    doc: args.doc,
    stateFields: args.stateFields,
    target: args.target,
    canvasRole: args.canvasRole,
    canvasLabel: args.canvasLabel,
  });
  let nextDoc = initialDetection.doc;
  const appliedChanges = [...initialDetection.canonicalizationChanges];
  const needsModelRepair = initialDetection.modelIssues.length > 0;

  if (nextDoc && needsModelRepair) {
    const repairReply = await runPlannerPromptCompletion(
      args.openai,
      "You repair canvas-rule violations for a canvas orchestration runtime. Return JSON only.",
      buildCanvasRuleRepairPrompt({
        project: args.project,
        daemonState: args.daemonState,
        sessionRules: args.sessionRules,
        registryRules: args.registryRules,
        target: args.target,
        canvasRole: args.canvasRole,
        canvasLabel: args.canvasLabel,
        docSummary: summarizeCanvasDocForPrompt(nextDoc),
        stateFields: args.stateFields,
        issues: initialDetection.modelIssues,
        heuristicIssues: initialDetection.heuristicIssues,
      }),
      DAEMON_BUILDER_TOKEN_BUDGETS.canvasRuleRepair
    );
    const parsedReply = parseCanvasRuleRepairReply(repairReply);
    const relevantEdits = parsedReply.canvasEdits.filter(
      (edit) => edit.target === args.target
    );
    const applyResult = applyCanvasEdits(nextDoc, relevantEdits);
    nextDoc = applyResult.doc ?? nextDoc;
    appliedChanges.push(...applyResult.appliedChanges);
  }

  const finalDetection = await detectCanvasRuleIssuesForDocWithModel({
    openai: args.openai,
    project: args.project,
    daemonState: args.daemonState,
    sessionRules: args.sessionRules,
    registryRules: args.registryRules,
    doc: nextDoc,
    stateFields: args.stateFields,
    target: args.target,
    canvasRole: args.canvasRole,
    canvasLabel: args.canvasLabel,
  });
  nextDoc = finalDetection.doc;
  appliedChanges.push(...finalDetection.canonicalizationChanges);

  return {
    doc: nextDoc,
    appliedChanges,
    violationsDetected:
      initialDetection.canonicalizationChanges.length > 0 ||
      initialDetection.modelIssues.length > 0 ||
      finalDetection.canonicalizationChanges.length > 0 ||
      finalDetection.modelIssues.length > 0,
    violationsRemaining: finalDetection.modelIssues.length > 0,
    retryNeeded:
      finalDetection.modelIssues.length > 0 && appliedChanges.length > 0,
  };
}

async function repairProjectCanvasRuleViolationsWithModel(args: {
  openai: OpenAI;
  project: OrchestrationProject;
  daemonState: Record<string, unknown> | null;
  runtimeConfig: DaemonRuntimeConfig;
}): Promise<{
  project: OrchestrationProject;
  appliedChanges: string[];
  violationsDetected: boolean;
  violationsRemaining: boolean;
  retryNeeded: boolean;
}> {
  let nextProject = args.project;
  const appliedChanges: string[] = [];
  let detectedViolations = false;
  let remainingViolations = false;
  const sessionRules = readSessionInferredRulesFromDaemonState(
    args.daemonState
  );

  const mainPolicyRepair = await repairCanvasRuleViolationsForDocWithModel({
    openai: args.openai,
    project: nextProject,
    daemonState: args.daemonState,
    sessionRules,
    registryRules: args.runtimeConfig.canvasRuleRegistry,
    doc: nextProject.policyCanvases,
    stateFields: nextProject.fields,
    target: "policy",
    canvasRole: "main policy canvas",
    canvasLabel: "policy",
  });
  nextProject = {
    ...nextProject,
    policyCanvases: mainPolicyRepair.doc,
  };
  detectedViolations =
    detectedViolations || mainPolicyRepair.violationsDetected;
  remainingViolations =
    remainingViolations || mainPolicyRepair.violationsRemaining;
  appliedChanges.push(...mainPolicyRepair.appliedChanges);

  const mainStateRepair = await repairCanvasRuleViolationsForDocWithModel({
    openai: args.openai,
    project: nextProject,
    daemonState: args.daemonState,
    sessionRules,
    registryRules: args.runtimeConfig.canvasRuleRegistry,
    doc: nextProject.statePolicyCanvases,
    stateFields: nextProject.fields,
    target: "state",
    canvasRole: "main state canvas",
    canvasLabel: "state",
  });
  nextProject = {
    ...nextProject,
    statePolicyCanvases: mainStateRepair.doc,
  };
  detectedViolations =
    detectedViolations || mainStateRepair.violationsDetected;
  remainingViolations =
    remainingViolations || mainStateRepair.violationsRemaining;
  appliedChanges.push(...mainStateRepair.appliedChanges);

  const environmentPlayers: OrchestrationProject["environmentPlayers"] = [];
  for (const [index, player] of nextProject.environmentPlayers.entries()) {
    const playerPrefix = `environment agent ${index + 1}`;
    const playerPolicyRepair = await repairCanvasRuleViolationsForDocWithModel({
      openai: args.openai,
      project: nextProject,
      daemonState: args.daemonState,
      sessionRules,
      registryRules: args.runtimeConfig.canvasRuleRegistry,
      doc: player.policyCanvases,
      stateFields: player.fields,
      target: "policy",
      canvasRole: `${playerPrefix} policy canvas`,
      canvasLabel: `${playerPrefix} policy`,
    });
    const playerAfterPolicy = {
      ...player,
      policyCanvases: playerPolicyRepair.doc,
    };
    detectedViolations =
      detectedViolations || playerPolicyRepair.violationsDetected;
    remainingViolations =
      remainingViolations || playerPolicyRepair.violationsRemaining;
    appliedChanges.push(...playerPolicyRepair.appliedChanges);

    const playerStateRepair = await repairCanvasRuleViolationsForDocWithModel({
      openai: args.openai,
      project: {
        ...nextProject,
        environmentPlayers: [...environmentPlayers, playerAfterPolicy],
      },
      daemonState: args.daemonState,
      sessionRules,
      registryRules: args.runtimeConfig.canvasRuleRegistry,
      doc: playerAfterPolicy.statePolicyCanvases,
      stateFields: playerAfterPolicy.fields,
      target: "state",
      canvasRole: `${playerPrefix} state canvas`,
      canvasLabel: `${playerPrefix} state`,
    });
    const repairedPlayer = {
      ...playerAfterPolicy,
      statePolicyCanvases: playerStateRepair.doc,
    };
    detectedViolations =
      detectedViolations || playerStateRepair.violationsDetected;
    remainingViolations =
      remainingViolations || playerStateRepair.violationsRemaining;
    appliedChanges.push(...playerStateRepair.appliedChanges);
    environmentPlayers.push(repairedPlayer);
  }

  nextProject = {
    ...nextProject,
    environmentPlayers,
  };

  return {
    project: nextProject,
    appliedChanges,
    violationsDetected: detectedViolations,
    violationsRemaining: remainingViolations,
    retryNeeded: remainingViolations && appliedChanges.length > 0,
  };
}

function buildPlannerPrompt(
  project: OrchestrationProject,
  messages: OrchestrationMessage[],
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null
): string {
  return [
    buildPlannerContextPrompt(project, messages, runtimeConfig, daemonState),
    "",
    "Return strict JSON with this shape:",
    ...buildPlannerJsonShapeLines(),
    "",
    ...buildPlannerProtocolLines(),
  ].join("\n");
}

function buildPlannerSubtreePrompt(
  project: OrchestrationProject,
  messages: OrchestrationMessage[],
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null,
  currentPlannerOutput: string
): string {
  return [
    buildPlannerContextPrompt(project, messages, runtimeConfig, daemonState),
    "",
    "Current structured planner output:",
    currentPlannerOutput || "(empty)",
    "",
    "Execute only the provided daemon policy subtree instructions.",
    "Return strict JSON with this shape:",
    ...buildPlannerJsonShapeLines(),
    "",
    ...buildPlannerProtocolLines(),
  ].join("\n");
}

function buildPlannerSubtreeExecutionAndExtractionPrompt(
  project: OrchestrationProject,
  messages: OrchestrationMessage[],
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null,
  currentPlannerOutput: string,
  promptPlan: StatePromptExtractionPlan | undefined,
  existingPromptValues: PromptValueSnapshot = {}
): string {
  const fields = normalizePlannerPromptExtractionFields(promptPlan);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const promptValuesJson =
    Object.keys(existingPromptValues).length > 0
      ? JSON.stringify(existingPromptValues, null, 2)
      : "(none)";
  const plannerShapeLines = buildPlannerJsonShapeLines();
  const plannerShape = plannerShapeLines
    .map((line, index) => {
      const isLast = index === plannerShapeLines.length - 1;
      return `  ${line}${isLast && fields.length > 0 ? "," : ""}`;
    })
    .join("\n");
  const extractionShape =
    fields.length > 0
      ? fields.map(
          (field) =>
            `  ${JSON.stringify(field.name)}: ${renderPlannerPromptExtractionFieldShape(field)}`
        ).join(",\n")
      : "";

  return [
    buildPlannerContextPrompt(project, messages, runtimeConfig, daemonState),
    "",
    "Current structured planner output:",
    currentPlannerOutput || "(empty)",
    "",
    "Previously extracted intermediate values (JSON):",
    promptValuesJson,
    "",
    "Execute only the provided daemon policy subtree instructions.",
    'Return exactly one JSON object with this shape and nothing else:',
    "{",
    '  "assistant_reply":',
    plannerShape,
    ...(extractionShape ? [extractionShape] : []),
    "}",
    "",
    '"assistant_reply" must itself be the main structured planner JSON output.',
    "Also extract the requested typed intermediate values for deterministic follow-up steps.",
    "Do not explain your work.",
    "",
    "Extraction rules:",
    extractionRules,
    "",
    ...buildPlannerProtocolLines(),
  ].join("\n");
}

function buildPlannerTransformPrompt(
  project: OrchestrationProject,
  messages: OrchestrationMessage[],
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null,
  currentPlannerOutput: string,
  instruction: string
): string {
  return [
    buildPlannerContextPrompt(project, messages, runtimeConfig, daemonState),
    "",
    "Current structured planner output:",
    currentPlannerOutput || "(empty)",
    "",
    "Transform the current structured planner output so it satisfies this instruction:",
    instruction,
    "",
    "Keep the same top-level JSON shape.",
    "Preserve non-message fields unless the instruction requires changing them.",
    "Return JSON only.",
  ].join("\n");
}

function buildPlannerExtractionPrompt(
  project: OrchestrationProject,
  messages: OrchestrationMessage[],
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null,
  promptPlan: StatePromptExtractionPlan | undefined,
  existingPromptValues: PromptValueSnapshot = {}
): string {
  const fields = normalizePlannerPromptExtractionFields(promptPlan);
  const extractionShape = renderPlannerPromptExtractionInstruction(fields);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const contextPrompt =
    typeof promptPlan?.context_prompt === "string" ? promptPlan.context_prompt.trim() : "";
  const promptValuesJson =
    Object.keys(existingPromptValues).length > 0
      ? JSON.stringify(existingPromptValues, null, 2)
      : "(none)";

  return [
    buildPlannerContextPrompt(project, messages, runtimeConfig, daemonState),
    "",
    "Previously extracted intermediate values (JSON):",
    promptValuesJson,
    "",
    ...(contextPrompt ? ["Focused subtree or node context:", contextPrompt, ""] : []),
    "Extract only the intermediate values needed for deterministic planner policy code.",
    "Do not return the final structured planner JSON.",
    "Use null for values that should not be set from this turn.",
    "",
    extractionShape,
    "",
    "Extraction rules:",
    extractionRules,
  ].join("\n");
}

async function runPlannerPromptCompletion(
  openai: OpenAI,
  systemPrompt: string | undefined,
  prompt: string,
  maxCompletionTokens = DAEMON_BUILDER_MAX_COMPLETION_TOKENS
): Promise<string> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];

  if (systemPrompt?.trim()) {
    messages.push({ role: "system", content: systemPrompt.trim() });
  }

  messages.push({ role: "user", content: prompt });

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    max_completion_tokens: maxCompletionTokens,
    messages,
  });

  return completion.choices[0]?.message?.content ?? "";
}

async function runPlannerPromptExtraction(
  openai: OpenAI,
  project: OrchestrationProject,
  messages: OrchestrationMessage[],
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null,
  promptPlan: StatePromptExtractionPlan | undefined,
  existingPromptValues: PromptValueSnapshot = {}
): Promise<PromptValueSnapshot | null> {
  const extractionReply = await runPlannerPromptCompletion(
    openai,
    undefined,
    buildPlannerExtractionPrompt(
      project,
      messages,
      runtimeConfig,
      daemonState,
      promptPlan,
      existingPromptValues
    )
  );

  return parsePlannerPromptExtractionReply(extractionReply, promptPlan);
}

async function runPlannerPromptSubtreeDecisionWithExtraction(
  openai: OpenAI,
  project: OrchestrationProject,
  messages: OrchestrationMessage[],
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null,
  subtreePrompt: string,
  promptPlan: StatePromptExtractionPlan | undefined,
  existingPromptValues: PromptValueSnapshot = {},
  currentPlannerOutput = ""
): Promise<{ output: string; promptValues: PromptValueSnapshot | null }> {
  const reply = await runPlannerPromptCompletion(
    openai,
    subtreePrompt,
    buildPlannerSubtreeExecutionAndExtractionPrompt(
      project,
      messages,
      runtimeConfig,
      daemonState,
      currentPlannerOutput,
      promptPlan,
      existingPromptValues
    )
  );

  return parsePlannerDecisionExtractionReply(reply, promptPlan);
}

function readQueuedRuntimeOperationAppliedChanges(
  value: unknown
): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function executePlannerRuntimeOperation(
  args: ExecutePlannerRuntimeOperationArgs
): Promise<{ output: string; promptValues?: PromptValueSnapshot | null }> {
  const { operation, message } = args.step;
  const plan = args.mutable.parsedPlan ?? args.parsePlannerText(args.incomingOutput);
  const runtimeDaemonState = deserializeDaemonStateSnapshot(
    args.runtimeConfig,
    args.mutable.currentState,
    args.canonicalCurrentBuild
  );

  if (operation === "raise_error") {
    throw new Error(
      (message?.trim() || args.incomingOutput.trim() || "Canvas runtime error").trim()
    );
  }

  if (operation === "build_default_primary_state_schema") {
    args.mutable.parsedPlan = plannerResultIsWorkflowReviewOnly(plan)
      ? plan
      : withDefaultPrimaryAgentStateSchema(plan, runtimeDaemonState);
    return {
      output: serializePlannerResult(args.mutable.parsedPlan),
    };
  }

  if (operation === "build_default_environment_state_schema") {
    args.mutable.parsedPlan = plannerResultIsWorkflowReviewOnly(plan)
      ? plan
      : withDefaultEnvironmentAgentStateSchemas(plan, runtimeDaemonState);
    return {
      output: serializePlannerResult(args.mutable.parsedPlan),
    };
  }

  if (operation === "build_initial_canvas_shape_materialization_requests") {
    const requests = buildInitialCanvasShapeMaterializationRequests({
      project: args.mutable.workflowProject,
      plan,
      daemonState: runtimeDaemonState,
    });
    return {
      output: args.incomingOutput,
      promptValues: {
        [INITIAL_CANVAS_SHAPE_MATERIALIZATION_REQUESTS_PROMPT_VALUE_NAME]:
          requests,
        [INITIAL_CANVAS_SHAPE_MATERIALIZATION_REQUESTS_EXIST_PROMPT_VALUE_NAME]:
          requests.length > 0,
      },
    };
  }

  if (operation === "materialize_initial_canvas_structures") {
    args.mutable.parsedPlan = await materializeInitialCanvasStructuresForPlan({
      openai: args.openai,
      project: args.mutable.workflowProject,
      plan,
      runtimeConfig: args.runtimeConfig,
      daemonState: runtimeDaemonState,
    });
    return {
      output: serializePlannerResult(args.mutable.parsedPlan),
    };
  }

  if (operation === "merge_materialized_initial_canvas_structures") {
    args.mutable.parsedPlan = mergeMaterializedInitialCanvasStructuresIntoPlan(
      plan,
      normalizeMaterializedInitialCanvasStructuresValue(
        args.promptValues[MATERIALIZED_INITIAL_CANVAS_STRUCTURES_PROMPT_VALUE_NAME]
      )
    );
    return {
      output: serializePlannerResult(args.mutable.parsedPlan),
    };
  }

  if (operation === "prepare_canvas_rule_detection_requests") {
    const prepared = prepareCanvasRuleDetectionRequests({
      project: args.mutable.workflowProject,
      daemonState: runtimeDaemonState,
      sessionRules: readSessionInferredRulesFromDaemonState(runtimeDaemonState),
      registryRules: args.runtimeConfig.canvasRuleRegistry,
    });
    args.mutable.workflowProject = prepared.project;
    return {
      output: args.incomingOutput,
      promptValues: {
        ...buildCanvasRuleRepairPassResetPromptValues(),
        [CANVAS_RULE_DETECTION_REQUESTS_PROMPT_VALUE_NAME]:
          prepared.bundle,
        [CANVAS_RULE_PREFLIGHT_CHANGES_APPLIED_PROMPT_VALUE_NAME]:
          prepared.appliedChanges.length > 0,
        [CANVAS_RULE_PREFLIGHT_CHANGE_SUMMARIES_PROMPT_VALUE_NAME]:
          prepared.appliedChanges,
      },
    };
  }

  if (operation === "build_canvas_rule_repair_requests") {
    const issues = normalizeCanvasRulePromptIssuesValue(
      args.promptValues[CANVAS_RULE_DETECTED_ISSUES_PROMPT_VALUE_NAME]
    );
    return {
      output: args.incomingOutput,
      promptValues: {
        [CANVAS_RULE_REPAIR_REQUESTS_PROMPT_VALUE_NAME]:
          buildCanvasRuleRepairRequestsFromDetectedIssues(
            args.promptValues[CANVAS_RULE_DETECTION_REQUESTS_PROMPT_VALUE_NAME],
            issues
          ),
      },
    };
  }

  if (operation === "apply_canvas_rule_repairs") {
    const applyResult = applyCanvasRuleRepairEditGroups({
      project: args.mutable.workflowProject,
      repairGroups: normalizeCanvasRuleRepairEditGroupsValue(
        args.promptValues[CANVAS_RULE_REPAIR_EDITS_PROMPT_VALUE_NAME]
      ),
    });
    args.mutable.workflowProject = applyResult.project;
    return {
      output: args.incomingOutput,
      promptValues: {
        [CANVAS_RULE_REPAIR_CHANGES_APPLIED_PROMPT_VALUE_NAME]:
          applyResult.appliedChanges.length > 0,
        [CANVAS_RULE_REPAIR_CHANGE_SUMMARIES_PROMPT_VALUE_NAME]:
          applyResult.appliedChanges,
      },
    };
  }

  if (operation === "prepare_canvas_rule_recheck_requests") {
    const prepared = prepareCanvasRuleDetectionRequests({
      project: args.mutable.workflowProject,
      daemonState: runtimeDaemonState,
      sessionRules: readSessionInferredRulesFromDaemonState(runtimeDaemonState),
      registryRules: args.runtimeConfig.canvasRuleRegistry,
    });
    args.mutable.workflowProject = prepared.project;
    const anyChangesApplied =
      readCanvasRulePromptBoolean(
        args.promptValues,
        CANVAS_RULE_PREFLIGHT_CHANGES_APPLIED_PROMPT_VALUE_NAME
      ) ||
      readCanvasRulePromptBoolean(
        args.promptValues,
        CANVAS_RULE_REPAIR_CHANGES_APPLIED_PROMPT_VALUE_NAME
      ) ||
      prepared.appliedChanges.length > 0;

    return {
      output: args.incomingOutput,
      promptValues: {
        [CANVAS_RULE_RECHECK_REQUESTS_PROMPT_VALUE_NAME]:
          prepared.bundle,
        [CANVAS_RULE_RECHECK_CHANGE_SUMMARIES_PROMPT_VALUE_NAME]:
          prepared.appliedChanges,
        [CANVAS_RULE_ANY_CHANGES_APPLIED_PROMPT_VALUE_NAME]:
          anyChangesApplied,
      },
    };
  }

  if (operation === "finalize_canvas_rule_repair_pass") {
    const detectedIssues = normalizeCanvasRulePromptIssuesValue(
      args.promptValues[CANVAS_RULE_DETECTED_ISSUES_PROMPT_VALUE_NAME]
    );
    const remainingIssues = normalizeCanvasRulePromptIssuesValue(
      args.promptValues[CANVAS_RULE_REMAINING_ISSUES_PROMPT_VALUE_NAME]
    );
    const preflightChanges = readCanvasRulePromptStringArray(
      args.promptValues,
      CANVAS_RULE_PREFLIGHT_CHANGE_SUMMARIES_PROMPT_VALUE_NAME
    );
    const repairChanges = readCanvasRulePromptStringArray(
      args.promptValues,
      CANVAS_RULE_REPAIR_CHANGE_SUMMARIES_PROMPT_VALUE_NAME
    );
    const recheckChanges = readCanvasRulePromptStringArray(
      args.promptValues,
      CANVAS_RULE_RECHECK_CHANGE_SUMMARIES_PROMPT_VALUE_NAME
    );
    const appliedChanges = dedupeCanvasRulePromptStringArray([
      ...preflightChanges,
      ...repairChanges,
      ...recheckChanges,
    ]);
    const violationsDetected =
      detectedIssues.length > 0 ||
      remainingIssues.length > 0 ||
      appliedChanges.length > 0;
    const violationsRemaining = remainingIssues.length > 0;
    const retryNeeded = violationsRemaining && appliedChanges.length > 0;

    if (appliedChanges.length > 0) {
      args.mutable.workflowAppliedChanges.push(...appliedChanges);
    }

    return {
      output: args.incomingOutput,
      promptValues: {
        canvas_rule_violations_detected: violationsDetected,
        canvas_rule_repairs_applied: appliedChanges.length > 0,
        canvas_rule_violations_remaining: violationsRemaining,
        canvas_rule_retry_needed: retryNeeded,
      },
    };
  }

  if (operation === "apply_structured_patch") {
    let planForPatch = plan;
    if (!args.graphRuntimeOperations.has("build_default_primary_state_schema")) {
      planForPatch = withDefaultPrimaryAgentStateSchema(
        planForPatch,
        runtimeDaemonState
      );
    }
    if (!args.graphRuntimeOperations.has("build_default_environment_state_schema")) {
      planForPatch = withDefaultEnvironmentAgentStateSchemas(
        planForPatch,
        runtimeDaemonState
      );
    }
    if (plannerResultNeedsInitialCanvasMaterialization(planForPatch)) {
      planForPatch = await materializeInitialCanvasStructuresForPlan({
        openai: args.openai,
        project: args.mutable.workflowProject,
        plan: planForPatch,
        runtimeConfig: args.runtimeConfig,
        daemonState: runtimeDaemonState,
      });
    }
    args.mutable.parsedPlan = planForPatch;
    const starterDefaults = await loadStarterAgentTemplateDefaults();
    args.mutable.patchResult = applyStructuredPlannerPatchToProject(
      args.mutable.workflowProject,
      planForPatch,
      runtimeDaemonState,
      starterDefaults
    );
    args.mutable.workflowProject = args.mutable.patchResult.project;
    args.mutable.workflowAppliedChanges.push(
      ...args.mutable.patchResult.appliedChanges
    );
    return {
      output: args.incomingOutput,
    };
  }

  if (operation === "scaffold_tools") {
    const scaffoldResult = await scaffoldPlannerToolsIntoProject({
      openai: args.openai,
      project: args.mutable.workflowProject,
      plan,
      runtimeConfig: args.runtimeConfig,
      daemonState: runtimeDaemonState,
    });
    args.mutable.workflowProject = scaffoldResult.project;
    args.mutable.workflowAppliedChanges.push(...scaffoldResult.appliedChanges);
    return {
      output: args.incomingOutput,
    };
  }

  if (operation === "repair_canvas_rules") {
    const repairResult = await repairProjectCanvasRuleViolationsWithModel({
      openai: args.openai,
      project: args.mutable.workflowProject,
      daemonState: runtimeDaemonState,
      runtimeConfig: args.runtimeConfig,
    });
    args.mutable.workflowProject = repairResult.project;
    if (repairResult.appliedChanges.length > 0) {
      args.mutable.workflowProject = syncDerivedPrompts(
        args.mutable.workflowProject
      );
      args.mutable.workflowAppliedChanges.push(...repairResult.appliedChanges);
    }

    return {
      output: args.incomingOutput,
      promptValues: {
        canvas_rule_violations_detected: repairResult.violationsDetected,
        canvas_rule_repairs_applied: repairResult.appliedChanges.length > 0,
        canvas_rule_violations_remaining: repairResult.violationsRemaining,
        canvas_rule_retry_needed: repairResult.retryNeeded,
      },
    };
  }

  if (operation === "finalize_assistant_reply") {
    const assistantMessage = finalizeAssistantReply(
      plan,
      args.mutable.workflowAppliedChanges
    );
    args.mutable.finalizedAssistantMessage = assistantMessage;
    args.mutable.parsedPlan = applyFinalizedAssistantReply(plan, assistantMessage);
    return {
      output: serializePlannerResult(args.mutable.parsedPlan),
      promptValues: {
        [FINALIZED_ASSISTANT_MESSAGE_PROMPT_VALUE_NAME]: assistantMessage,
      },
    };
  }

  args.mutable.workflowProject = syncDerivedPrompts(args.mutable.workflowProject);
  return {
    output: args.incomingOutput,
  };
}

export async function executeQueuedDaemonRuntimeOperationJob(
  input: AsyncDaemonRuntimeOperationJobInput
): Promise<AsyncRuntimeOperationCompletionPayload> {
  if (
    !canRuntimeOperationQueueAsAsync(input.step.operation) ||
    input.step.operation === "apply_structured_patch"
  ) {
    throw new Error(
      `Runtime operation "${input.step.operation}" must run synchronously.`
    );
  }

  const openai = new OpenAI({ apiKey: resolveOpenAiApiKey() });
  const runtimeConfig = input.runtimeConfig as unknown as DaemonRuntimeConfig;
  const mutable: PlannerRuntimeOperationMutableState = {
    workflowProject: input.workflowProject as unknown as OrchestrationProject,
    parsedPlan:
      (input.parsedPlan as unknown as PlannerResult | null | undefined) ?? null,
    patchResult:
      (input.patchResult as unknown as PlannerPatchApplicationResult | null | undefined) ??
      null,
    workflowAppliedChanges: readQueuedRuntimeOperationAppliedChanges(
      input.workflowAppliedChanges
    ),
    finalizedAssistantMessage:
      typeof input.finalizedAssistantMessage === "string"
        ? input.finalizedAssistantMessage
        : null,
    currentState: { ...input.currentState },
  };

  const parsePlannerText = (text: string): PlannerResult => {
    const plan = normalizePlannerResult(parseJsonObject<PlannerResult>(text));
    mutable.parsedPlan = plan;
    return plan;
  };

  const result = await executePlannerRuntimeOperation({
    openai,
    step: input.step,
    incomingOutput: input.incomingOutput,
    promptValues: input.promptValues,
    messages: input.messages as unknown as OrchestrationMessage[],
    runtimeConfig,
    canonicalCurrentBuild: input.canonicalCurrentBuild,
    mutable,
    parsePlannerText,
    graphRuntimeOperations: new Set<PolicyRuntimeOperationName>(),
  });

  return {
    kind: "airlab_runtime_operation_result",
    runtime: "daemon",
    operation: input.step.operation,
    output: result.output,
    promptValues: result.promptValues ?? null,
    contextSnapshot: {
      workflowProject: mutable.workflowProject,
      parsedPlan: mutable.parsedPlan,
      patchResult: mutable.patchResult,
      workflowAppliedChanges: mutable.workflowAppliedChanges,
      finalizedAssistantMessage: mutable.finalizedAssistantMessage,
      currentState: mutable.currentState,
    },
  };
}

registerDaemonRuntimeOperationExecutor(executeQueuedDaemonRuntimeOperationJob);

async function runPlanner(
  openai: OpenAI,
  project: OrchestrationProject,
  messages: OrchestrationMessage[],
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null,
  canvasTrace?: DaemonCanvasTraceEvent[]
): Promise<PlannerWorkflowResult> {
  const policyPlan = runtimeConfig.executionPlan.policy;
  const latestUserMessage = getLatestUserMessage(messages);
  const canonicalCurrentBuild = daemonState?.current_build ?? null;
  let daemonStateSnapshot = buildPlannerStateSnapshot(runtimeConfig, daemonState);
  const snapshotToDaemonState = (stateSnapshot: StateSnapshot) =>
    deserializeDaemonStateSnapshot(
      runtimeConfig,
      stateSnapshot,
      canonicalCurrentBuild
    );
  let currentDaemonState = snapshotToDaemonState(daemonStateSnapshot);
  const policyGraph = policyPlan.code_plan?.execution_graph;
  const graphRuntimeOperations = new Set<PolicyRuntimeOperationName>(
    (policyGraph?.steps ?? []).flatMap((step) =>
      step.type === "runtime_operation" ? [step.operation] : []
    )
  );
  const graphOwnsToolScaffolding =
    graphRuntimeOperations.has("scaffold_tools");
  const graphOwnsPromptSync =
    graphRuntimeOperations.has("sync_derived_prompts");
  const graphOwnsAssistantReplyFinalization =
    graphRuntimeOperations.has("finalize_assistant_reply");

  let workflowProject = project;
  let patchResult: PlannerPatchApplicationResult | null = null;
  const workflowAppliedChanges: string[] = [];
  let parsedPlan: PlannerResult | null = null;
  let fallbackMutatedProject = false;
  let finalizedAssistantMessage: string | null = null;
  let visibleAssistantMessage: string | null = null;
  let stageHandoff: PolicyStageHandoff | null = null;
  const appliedAsyncRuntimeOperationJobIds = new Set<string>();

  const parsePlannerText = (text: string): PlannerResult => {
    const plan = normalizePlannerResult(parseJsonObject<PlannerResult>(text));
    parsedPlan = plan;
    return plan;
  };

  let text: string;

  if (policyPlan.mode === "full_prompt" || !policyGraph) {
    text = await runPlannerPromptCompletion(
      openai,
      [
        `Configured daemon policy:\n${runtimeConfig.policyExecutionSystemPrompt.trim()}`,
        "You turn orchestration conversations into structured setup updates. Output JSON only.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      buildPlannerPrompt(project, messages, runtimeConfig, currentDaemonState)
    );
  } else {
    const graphResult = await runPolicyExecutionGraphWithHandlers({
      updatedState: daemonStateSnapshot,
      stateSchema: runtimeConfig.stateSchema,
      graph: policyGraph,
      onStep: (step) => appendDaemonCanvasTraceStep(canvasTrace, "policy", step),
      runFullPromptDecision: (currentState) =>
        runPlannerPromptCompletion(
          openai,
          runtimeConfig.policyExecutionSystemPrompt,
          buildPlannerPrompt(
            project,
            messages,
            runtimeConfig,
            snapshotToDaemonState(currentState)
          )
        ),
      runPromptSubtreeDecision: (currentState, subtreePrompt, currentPlannerOutput) =>
        runPlannerPromptCompletion(
          openai,
          subtreePrompt,
          buildPlannerSubtreePrompt(
            project,
            messages,
            runtimeConfig,
            snapshotToDaemonState(currentState),
            currentPlannerOutput
          )
        ),
      runPromptSubtreeDecisionWithExtraction: (
        currentState,
        subtreePrompt,
        promptPlan,
        existingPromptValues,
        currentPlannerOutput
      ) =>
        runPlannerPromptSubtreeDecisionWithExtraction(
          openai,
          project,
          messages,
          runtimeConfig,
          snapshotToDaemonState(currentState),
          subtreePrompt,
          promptPlan,
          existingPromptValues,
          currentPlannerOutput
        ),
      runPromptTransform: (
        currentState,
        incomingOutput,
        instruction
      ) =>
        runPlannerPromptCompletion(
          openai,
          undefined,
          buildPlannerTransformPrompt(
            project,
            messages,
            runtimeConfig,
            snapshotToDaemonState(currentState),
            incomingOutput,
            instruction
          )
        ),
      runPromptExtraction: (currentState, promptPlan, existingPromptValues) =>
        runPlannerPromptExtraction(
          openai,
          project,
          messages,
          runtimeConfig,
          snapshotToDaemonState(currentState),
          promptPlan,
          existingPromptValues
        ),
      runRuntimeOperation: async (step, incomingOutput, promptValues, currentState) => {
        const asyncJobResult = await runAsyncJobPolicyRuntimeStep({
          step,
          promptValues,
          onCompletedRuntimeOperationJob: async (jobId, result) => {
            if (
              result.runtime !== "daemon" ||
              appliedAsyncRuntimeOperationJobIds.has(jobId)
            ) {
              return;
            }
            const snapshot =
              result.contextSnapshot &&
              typeof result.contextSnapshot === "object" &&
              !Array.isArray(result.contextSnapshot)
                ? result.contextSnapshot
                : null;
            const nextState =
              snapshot?.currentState &&
              typeof snapshot.currentState === "object" &&
              !Array.isArray(snapshot.currentState)
                ? (snapshot.currentState as StateSnapshot)
                : null;
            if (!snapshot || !nextState) {
              return;
            }
            workflowProject =
              snapshot.workflowProject as unknown as OrchestrationProject;
            parsedPlan =
              (snapshot.parsedPlan as unknown as PlannerResult | null | undefined) ??
              null;
            patchResult =
              (snapshot.patchResult as unknown as PlannerPatchApplicationResult | null | undefined) ??
              null;
            workflowAppliedChanges.length = 0;
            workflowAppliedChanges.push(
              ...readQueuedRuntimeOperationAppliedChanges(
                snapshot.workflowAppliedChanges
              )
            );
            finalizedAssistantMessage =
              typeof snapshot.finalizedAssistantMessage === "string"
                ? snapshot.finalizedAssistantMessage
                : null;
            replacePlannerStateSnapshot(currentState, nextState);
            appliedAsyncRuntimeOperationJobIds.add(jobId);
          },
        });
        if (asyncJobResult) {
          return asyncJobResult;
        }

        if (
          step.execution_mode === "async" &&
          canRuntimeOperationQueueAsAsync(step.operation)
        ) {
          const queued = await queueRuntimeOperationJob({
            input: {
              kind: "daemon_runtime_operation",
              step,
              incomingOutput,
              promptValues,
              currentState,
              workflowProject,
              messages,
              runtimeConfig,
              canonicalCurrentBuild,
              parsedPlan,
              patchResult,
              workflowAppliedChanges: [...workflowAppliedChanges],
              finalizedAssistantMessage,
            },
          });
          return {
            output: incomingOutput,
            promptValues: buildAsyncRuntimeJobPromptValueUpdates(
              step.result_variable?.trim() || `${step.operation}_job`,
              queued
            ),
          };
        }

        const mutable: PlannerRuntimeOperationMutableState = {
          workflowProject,
          parsedPlan,
          patchResult,
          workflowAppliedChanges,
          finalizedAssistantMessage,
          currentState,
        };
        const result = await executePlannerRuntimeOperation({
          openai,
          step,
          incomingOutput,
          promptValues,
          messages,
          runtimeConfig,
          canonicalCurrentBuild,
          mutable,
          parsePlannerText,
          graphRuntimeOperations,
        });
        workflowProject = mutable.workflowProject;
        parsedPlan = mutable.parsedPlan;
        patchResult = mutable.patchResult;
        finalizedAssistantMessage = mutable.finalizedAssistantMessage;
        return result;
      },
      runDirectTool: buildDaemonRunDirectTool(runtimeConfig),
    });

    daemonStateSnapshot = graphResult.nextState;
    currentDaemonState = snapshotToDaemonState(daemonStateSnapshot);
    text = graphResult.output;
    visibleAssistantMessage = graphResult.visibleOutput.trim() || null;
    stageHandoff = graphResult.stageHandoff ?? null;
  }

  if (
    policyPlan.mode !== "full_prompt" &&
    policyGraph &&
    stageHandoff &&
    !parsedPlan &&
    !text.trim().startsWith("{")
  ) {
    const assistantMessage = visibleAssistantMessage ?? text.trim();
    const plan = normalizePlannerResult({
      assistantMessage,
      assistantReplyIntent: "report_review",
    } as PlannerResult);
    return {
      plan,
      project: workflowProject,
      appliedChanges: workflowAppliedChanges,
      effectiveGeneralDescription: resolveGeneralDescription(
        workflowProject,
        plan,
        currentDaemonState
      ),
      effectiveStatus: workflowProject.meta.status,
      assistantMessage,
      daemonState: currentDaemonState,
      stageHandoff,
    };
  }

  let plan = parsedPlan ?? parsePlannerText(text);
  parsedPlan = plan;

  if (
    !graphRuntimeOperations.has("build_default_primary_state_schema") &&
    !plannerResultIsWorkflowReviewOnly(plan)
  ) {
    plan = withDefaultPrimaryAgentStateSchema(plan, currentDaemonState);
    parsedPlan = plan;
  }

  if (
    !graphRuntimeOperations.has("build_default_environment_state_schema") &&
    !plannerResultIsWorkflowReviewOnly(plan)
  ) {
    plan = withDefaultEnvironmentAgentStateSchemas(plan, currentDaemonState);
    parsedPlan = plan;
  }

  if (
    !graphRuntimeOperations.has("materialize_initial_canvas_structures") &&
    plannerResultNeedsInitialCanvasMaterialization(plan)
  ) {
    plan = await materializeInitialCanvasStructuresForPlan({
      openai,
      project: workflowProject,
      plan,
      runtimeConfig,
      daemonState: currentDaemonState,
    });
    parsedPlan = plan;
  }

  if (!graphRuntimeOperations.has("apply_structured_patch")) {
    const starterDefaults = await loadStarterAgentTemplateDefaults();
    patchResult = applyStructuredPlannerPatchToProject(
      workflowProject,
      plan,
      currentDaemonState,
      starterDefaults
    );
    workflowProject = patchResult.project;
    workflowAppliedChanges.push(...patchResult.appliedChanges);
    fallbackMutatedProject = true;
  }

  if (!graphOwnsToolScaffolding) {
    const scaffoldResult = await scaffoldPlannerToolsIntoProject({
      openai,
      project: workflowProject,
      plan,
      runtimeConfig,
      daemonState: currentDaemonState,
    });
    workflowProject = scaffoldResult.project;
    workflowAppliedChanges.push(...scaffoldResult.appliedChanges);
    if (scaffoldResult.appliedChanges.length > 0) {
      fallbackMutatedProject = true;
    }
  }

  if (!graphOwnsPromptSync || fallbackMutatedProject) {
    workflowProject = syncDerivedPrompts(workflowProject);
  }

  if (!graphOwnsAssistantReplyFinalization) {
    finalizedAssistantMessage = finalizeAssistantReply(
      plan,
      workflowAppliedChanges
    );
    parsedPlan = applyFinalizedAssistantReply(plan, finalizedAssistantMessage);
  }

  const finalPlan = parsedPlan ?? plan;
  const assistantMessage =
    policyPlan.mode !== "full_prompt" && policyGraph
      ? visibleAssistantMessage ?? ""
      : finalizedAssistantMessage ?? finalPlan.assistantMessage.trim();
  if (policyPlan.mode !== "full_prompt" && policyGraph && !assistantMessage) {
    throw new Error(
      "The daemon primary policy canvas did not reach a Display node. Add a Display node for the assistant reply."
    );
  }
  const finalPatchResult =
    patchResult ??
    ({
      project: workflowProject,
      appliedChanges: [],
      effectiveGeneralDescription: resolveGeneralDescription(
        workflowProject,
        finalPlan,
        currentDaemonState
      ),
      effectiveStatus: workflowProject.meta.status,
    } satisfies PlannerPatchApplicationResult);
  const rawNextDaemonState =
    runtimeConfig.stateSchema.length > 0 ? currentDaemonState : daemonState;
  const nextDaemonState = reconcileDaemonStateWithProject({
    daemonState: rawNextDaemonState,
    project: workflowProject,
  });

  return {
    plan: finalPlan,
    project: workflowProject,
    appliedChanges: workflowAppliedChanges,
    effectiveGeneralDescription: finalPatchResult.effectiveGeneralDescription,
    effectiveStatus: finalPatchResult.effectiveStatus,
    assistantMessage,
    daemonState: nextDaemonState,
    stageHandoff,
  };
}

function buildToolPrompt(
  project: OrchestrationProject,
  requests: PlannerToolRequest[],
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null
): string {
  return [
    buildRuntimeContext(runtimeConfig, daemonState),
    "",
    "Draft-change constraints and preferences:",
    renderDraftChangeConstraintsContext({
      daemonState,
      registryRules: runtimeConfig.canvasRuleRegistry,
    }),
    "",
    "Project snapshot:",
    summarizeProjectForPrompt(project),
    "",
    "Synthesize concrete tool blueprints for these missing tooling capabilities:",
    JSON.stringify(requests, null, 2),
    "",
    "Return strict JSON of the form:",
    "{",
    '  "tools": [{',
    '    "capability": string,',
    '    "whenToCall": string,',
    '    "toolName": string,',
    '    "description": string,',
    '    "sourceType": "http" | "rss" | "page" | "web_search" | "knowledge_save" | "dataset_read",',
    '    "url": string,',
    '    "params": [{ "name": string, "type": "string" | "number" | "integer" | "boolean", "description": string }],',
    '    "promoteToKnowledge": boolean,',
    '    "saveTarget": "knowledge" | "dataset",',
    '    "datasetName": string,',
    '    "notes": string',
    "  }]",
    "}",
    "",
    "Protocol:",
    "- The configured daemon policy in the system message is authoritative.",
    "- Only use the supported runtime source types listed above.",
    "- If an external endpoint is not specified, you may scaffold a placeholder URL, but keep it concrete and minimal.",
    "- web_search tools should leave url empty and use query as the primary parameter; the runtime resolves Tavily, Brave, or SerpApi from server-side env vars.",
    "- knowledge_save tools should leave url empty.",
    "- dataset_read tools require datasetName and leave url empty; use them to look up stored records (they support query/limit and column-named filters at runtime). Avoid targeting the derived guideline_items dataset.",
    "- Keep toolName short, lowercase, and function-safe.",
    "- Notes should briefly explain any assumptions.",
    "- Output JSON only.",
  ].join("\n");
}

async function synthesizeTools(
  openai: OpenAI,
  project: OrchestrationProject,
  requests: PlannerToolRequest[],
  runtimeConfig: DaemonRuntimeConfig,
  daemonState: Record<string, unknown> | null
): Promise<ToolBlueprint[]> {
  if (requests.length === 0) {
    return [];
  }

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    max_completion_tokens: DAEMON_BUILDER_MAX_COMPLETION_TOKENS,
    messages: [
      {
        role: "system",
        content: [
          `Configured daemon policy:\n${runtimeConfig.policyExecutionSystemPrompt.trim()}`,
          "You create concrete tool blueprints for a canvas-based orchestration runtime. Output JSON only.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      {
        role: "user",
        content: buildToolPrompt(project, requests, runtimeConfig, daemonState),
      },
    ],
  });

  const text = completion.choices[0]?.message?.content ?? "";
  const parsed = parseJsonObject<{ tools?: Array<Partial<ToolBlueprint>> }>(text);
  const rawTools = Array.isArray(parsed?.tools) ? parsed.tools : [];

  return rawTools
    .map((tool, index) => {
      const fallbackRequest = requests[index];
      const toolName = asString(tool.toolName) || slugify(asString(tool.capability) || fallbackRequest?.capability || "new-tool").replace(/-/g, "_");
      const sourceType: ToolBlueprintSourceType =
        tool.sourceType === "rss" ||
        tool.sourceType === "page" ||
        tool.sourceType === "web_search" ||
        tool.sourceType === "knowledge_save" ||
        tool.sourceType === "dataset_read"
          ? tool.sourceType
          : "http";

      return {
        capability: asString(tool.capability) || fallbackRequest?.capability || "missing capability",
        whenToCall: asString(tool.whenToCall) || fallbackRequest?.whenToCall || "when the capability is needed",
        toolName,
        description:
          asString(tool.description) ||
          `Support the ${fallbackRequest?.capability || "requested"} capability.`,
        sourceType,
        url: sourceType === "web_search" ? "" : asString(tool.url) || fallbackRequest?.urlHint || "",
        params: Array.isArray(tool.params)
          ? tool.params
              .map((param) => ({
                name: asString(param?.name),
                type: normalizeToolParamType(param?.type),
                description: asString(param?.description),
              }))
              .filter((param) => param.name.length > 0)
          : fallbackRequest?.parameters ?? [],
        promoteToKnowledge: tool.promoteToKnowledge === true,
        saveTarget:
          tool.saveTarget === "dataset" ? "dataset" : fallbackRequest?.saveTarget ?? "knowledge",
        datasetName: asString(tool.datasetName) || fallbackRequest?.datasetName || "",
        notes: asString(tool.notes),
      } satisfies ToolBlueprint;
    })
    .filter((tool) => tool.toolName.trim().length > 0);
}

function readDaemonStateString(
  daemonState: Record<string, unknown> | null,
  keys: string[]
): string {
  if (!daemonState) {
    return "";
  }

  for (const key of keys) {
    const value = daemonState[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function readDaemonStateBoolean(
  daemonState: Record<string, unknown> | null,
  keys: string[]
): boolean | null {
  if (!daemonState) {
    return null;
  }

  for (const key of keys) {
    const value = daemonState[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      if (/^true$/i.test(value.trim())) {
        return true;
      }
      if (/^false$/i.test(value.trim())) {
        return false;
      }
    }
  }

  return null;
}

function readDaemonStateStringArray(
  daemonState: Record<string, unknown> | null,
  keys: string[]
): string[] {
  if (!daemonState) {
    return [];
  }

  for (const key of keys) {
    const value = daemonState[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) {
          return parsed
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter(Boolean);
        }
      } catch {
        return value
          .split("||")
          .map((item) => item.trim())
          .filter(Boolean);
      }
    }
  }

  return [];
}

interface ProcessModelPartSnapshot {
  label: string;
  description: string;
}

interface ProcessModelSnapshot {
  environment: ProcessModelPartSnapshot;
  agent: ProcessModelPartSnapshot;
  observation: ProcessModelPartSnapshot;
  reward: ProcessModelPartSnapshot;
  stateUpdate: ProcessModelPartSnapshot;
  policy: ProcessModelPartSnapshot;
  action: ProcessModelPartSnapshot;
  summary: string;
}

const PROCESS_MODEL_FIELD_KEYS = {
  environment: "process_environment_description",
  agent: "process_agent_description",
  observation: "process_observation_description",
  reward: "process_reward_description",
  stateUpdate: "process_state_update_description",
  policy: "process_policy_description",
  action: "process_action_description",
} as const;

function readProcessModelPart(
  raw: unknown,
  fallbackLabel: string
): ProcessModelPartSnapshot {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  return {
    label: asString(record.label) || fallbackLabel,
    description: asString(record.description),
  };
}

function mergeProcessModelPartWithStateField(
  raw: unknown,
  fallbackLabel: string,
  stateDescription: string
): ProcessModelPartSnapshot {
  const part = readProcessModelPart(raw, fallbackLabel);
  return {
    ...part,
    description: stateDescription || part.description,
  };
}

function readProcessModelSnapshot(
  daemonState: Record<string, unknown> | null
): ProcessModelSnapshot | null {
  if (!daemonState) {
    return null;
  }

  const raw = daemonState?.process_model;
  const hasRawModel = Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
  const hasStateFieldModel = Object.values(PROCESS_MODEL_FIELD_KEYS).some(
    (key) => asString(daemonState[key])
  );

  if (!hasRawModel && !hasStateFieldModel) {
    return null;
  }

  const record = hasRawModel ? (raw as Record<string, unknown>) : {};
  return {
    environment: mergeProcessModelPartWithStateField(
      record.environment,
      "Environment",
      asString(daemonState[PROCESS_MODEL_FIELD_KEYS.environment])
    ),
    agent: mergeProcessModelPartWithStateField(
      record.agent,
      "Agent",
      asString(daemonState[PROCESS_MODEL_FIELD_KEYS.agent])
    ),
    observation: mergeProcessModelPartWithStateField(
      record.observation,
      "Observation",
      asString(daemonState[PROCESS_MODEL_FIELD_KEYS.observation])
    ),
    reward: mergeProcessModelPartWithStateField(
      record.reward,
      "Reward",
      asString(daemonState[PROCESS_MODEL_FIELD_KEYS.reward])
    ),
    stateUpdate: mergeProcessModelPartWithStateField(
      record.state_update,
      "State Update",
      asString(daemonState[PROCESS_MODEL_FIELD_KEYS.stateUpdate])
    ),
    policy: mergeProcessModelPartWithStateField(
      record.policy,
      "Policy",
      asString(daemonState[PROCESS_MODEL_FIELD_KEYS.policy])
    ),
    action: mergeProcessModelPartWithStateField(
      record.action,
      "Action",
      asString(daemonState[PROCESS_MODEL_FIELD_KEYS.action])
    ),
    summary: asString(record.summary),
  };
}

function buildProcessDescriptionFromModel(model: ProcessModelSnapshot): string {
  return [
    `${model.agent.label}: ${model.agent.description}`,
    `${model.environment.label}: ${model.environment.description}`,
    `${model.observation.label}: ${model.observation.description}`,
    `${model.reward.label}: ${model.reward.description}`,
    model.stateUpdate.description
      ? `${model.stateUpdate.label}: ${model.stateUpdate.description}`
      : "",
    model.policy.description ? `${model.policy.label}: ${model.policy.description}` : "",
    `${model.action.label}: ${model.action.description}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function resolveGeneralDescription(
  project: OrchestrationProject,
  plan: PlannerResult,
  daemonState: Record<string, unknown> | null
): string {
  if (plan.generalDescription.trim()) {
    return plan.generalDescription.trim();
  }

  const derived = readDaemonStateString(daemonState, [
    "general_description",
    "generalDescription",
  ]);
  if (derived) {
    return derived;
  }

  return project.meta.policyIntent.trim();
}

function deriveDraftedArtifactsFromProject(
  project: OrchestrationProject,
  currentBuild: ReturnType<typeof buildCurrentBuildSnapshot>
): string[] {
  const draftedArtifacts: string[] = [];

  if (currentBuild.workflow.canvas_count > 0) {
    draftedArtifacts.push("workflow_canvas");
  }
  if (project.fields.length > 0) {
    draftedArtifacts.push("state_schema");
  }
  if (currentBuild.policy.canvas_count > 0) {
    draftedArtifacts.push("policy_canvas");
  }
  if (currentBuild.state_tracking.canvas_count > 0) {
    draftedArtifacts.push("state_canvas");
  }
  if (currentBuild.datasets.length > 0) {
    draftedArtifacts.push("datasets");
  }
  if (project.guidelines.length > 0) {
    draftedArtifacts.push("guidelines");
  }
  if (currentBuild.tools.length > 0) {
    draftedArtifacts.push("tools");
  }
  if (project.agentConnections.length > 0) {
    draftedArtifacts.push("agent_connections");
  }

  return draftedArtifacts;
}

function reconcileDaemonStateWithProject(args: {
  daemonState: Record<string, unknown> | null;
  project: OrchestrationProject;
  preserveWorkflowStage?: boolean;
}): Record<string, unknown> | null {
  if (!args.daemonState) {
    return args.daemonState;
  }

  const currentBuild = buildCurrentBuildSnapshot(args.project);
  const hasStructuredDraft = hasStructuredOrchestrationProject(args.project);

  // Keep canonical draft facts synchronized; routing fields stay canvas-owned.
  const reconciled = normalizeDaemonOpenQuestionsState({
    ...args.daemonState,
    current_build: currentBuild,
    structured_draft_exists: hasStructuredDraft,
    drafted_artifacts: deriveDraftedArtifactsFromProject(
      args.project,
      currentBuild
    ),
  });
  const preservedStage = args.preserveWorkflowStage
    ? reconciled[DAEMON_WORKFLOW_STAGE_FIELD_NAME]
    : null;
  return {
    ...reconciled,
    [DAEMON_WORKFLOW_STAGE_FIELD_NAME]: isDaemonWorkflowStageId(preservedStage)
      ? preservedStage
      : resolveDaemonWorkflowStageId(reconciled),
  };
}

function trimSentenceFragment(value: string): string {
  return value.trim().replace(/[.!?]+$/g, "");
}

function ensureSentence(value: string): string {
  const trimmed = trimSentenceFragment(value);
  return trimmed ? `${trimmed}.` : "";
}

function buildProcessAwarePolicySeed(args: {
  plan: PlannerResult;
  project: OrchestrationProject;
  generalDescription: string;
  daemonState: Record<string, unknown> | null;
}): PolicySeed {
  const processModel = readProcessModelSnapshot(args.daemonState);
  const processDescription = readDaemonStateString(args.daemonState, [
    "process_description",
  ]);
  const openQuestions = readDaemonStateStringArray(args.daemonState, [
    "process_open_questions",
  ]);
  const setupTitle = deriveSetupTitle(
    args.project,
    args.plan,
    args.generalDescription
  );
  const policySeed = args.plan.policySeed ?? null;

  const generalPrompt =
    policySeed?.generalPrompt?.trim() ||
    [
      `Help the user through ${args.generalDescription.trim()}.`,
      processModel
        ? [
            processModel.agent.description
              ? `The agent is ${trimSentenceFragment(processModel.agent.description)}.`
              : "",
            processModel.environment.description
              ? `It acts on ${trimSentenceFragment(processModel.environment.description)}.`
              : "",
            processModel.observation.description
              ? `It receives observations about ${trimSentenceFragment(processModel.observation.description)}.`
              : "",
            processModel.reward.description
              ? `It receives an overall reward signal from ${trimSentenceFragment(processModel.reward.description)}.`
              : "",
            processModel.stateUpdate.description
              ? `State update should ${trimSentenceFragment(processModel.stateUpdate.description)}.`
              : "",
            processModel.policy.description
              ? `Policy should ${trimSentenceFragment(processModel.policy.description)}.`
              : "",
            processModel.action.description
              ? `Actions should ${trimSentenceFragment(processModel.action.description)}.`
              : "",
          ]
            .filter(Boolean)
            .join(" ")
        : processDescription
          ? `Confirmed process: ${ensureSentence(processDescription)}`
          : "",
      "Stay consistent with the confirmed operating loop.",
    ]
      .filter(Boolean)
      .join(" ");

  const clarificationGate =
    policySeed?.clarificationGate?.trim() ||
    "the user's request, constraints, or required inputs are still unclear";

  const clarificationActions =
    policySeed?.clarificationActions?.length
      ? policySeed.clarificationActions
        : [
          openQuestions.length > 0
            ? `Ask one focused follow-up question that resolves the most important remaining uncertainty in the process: ${openQuestions[0]?.trim() ?? "clarify the missing detail"}. Include one concrete typical answer/default choice the user can accept or revise.`
            : "Ask one focused follow-up question about the user's goal, constraints, missing information, or success criteria. Include one concrete typical answer/default choice the user can accept or revise.",
          "Prefer clarifying the minimum missing detail before committing to a specific next step.",
        ];

  const executionActions =
    policySeed?.executionActions?.length
      ? policySeed.executionActions
      : [
          processModel?.observation.description
            ? `Interpret the latest observation about ${trimSentenceFragment(processModel.observation.description)}.`
            : "",
          processModel?.reward.description
            ? `Interpret the latest overall reward from ${trimSentenceFragment(processModel.reward.description)}.`
            : "",
          processModel?.stateUpdate.description
            ? `Update state so it ${trimSentenceFragment(processModel.stateUpdate.description)}.`
            : "",
          processModel?.policy.description
            ? `Apply policy so it ${trimSentenceFragment(processModel.policy.description)}.`
            : "",
          processModel?.action.description
            ? `Choose the next action so the agent can ${trimSentenceFragment(processModel.action.description)}.`
            : "",
          !processModel
            ? "Operate the target demo according to the confirmed process and current state."
            : "",
          "Keep the response grounded in the current state, summary, and recent events.",
        ].filter(Boolean);

  return {
    canvasName: policySeed?.canvasName?.trim() || "Main policy",
    generalPrompt,
    clarificationGate,
    clarificationActions,
    executionActions,
    responseRule:
      policySeed?.responseRule?.trim() ||
      `reply with the next best step for ${setupTitle} while staying consistent with the confirmed process`,
    notes:
    policySeed?.notes?.trim() ||
      "This initial policy canvas was seeded from the confirmed process model and broad target description.",
  };
}

function inferProcessSignalFieldType(
  description: string
): SuggestedField["type"] {
  const normalized = description.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return "string";
  }

  if (
    /\b(boolean|binary|flag|true false|yes no|whether)\b/.test(normalized)
  ) {
    return "boolean";
  }

  if (
    /\b(integer|whole number|count|step number|episode number|rank|index)\b/.test(
      normalized
    )
  ) {
    return "integer";
  }

  if (
    /\b(number|numeric|score|price|probability|confidence|percentage|percent|metric|amount|value|signal)\b/.test(
      normalized
    )
  ) {
    return "number";
  }

  if (
    /\b(json|object|dictionary|payload|record|schema|field set|field sets|fields|structured|attributes|metadata)\b/.test(
      normalized
    )
  ) {
    return "json";
  }

  if (
    /\b(list|array|sequence|series|set of|collection|multiple|many|batch|queue|stream)\b/.test(
      normalized
    )
  ) {
    return "string[]";
  }

  return "string";
}

function buildDefaultPrimaryAgentStateFields(
  processModel: ProcessModelSnapshot | null
): SuggestedField[] {
  const actionType = inferProcessSignalFieldType(
    processModel?.action.description ?? ""
  );
  const observationType = inferProcessSignalFieldType(
    processModel?.observation.description ?? ""
  );

  return createRequiredPrimaryAgentStateFieldSuggestions({
    observationType,
    actionType,
  });
}

function buildDefaultEnvironmentAgentStateFields(
  processModel: ProcessModelSnapshot | null
): SuggestedField[] {
  const primaryActionType = inferProcessSignalFieldType(
    processModel?.action.description ?? ""
  );
  const primaryObservationType = inferProcessSignalFieldType(
    processModel?.observation.description ?? ""
  );

  return createRequiredEnvironmentAgentStateFieldSuggestions({
    observationType: primaryActionType,
    actionType: primaryObservationType,
  });
}

function normalizeSuggestedFieldKey(name: string | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

function mergePlannerSuggestedFields(
  current: SuggestedField[],
  additions: SuggestedField[]
): SuggestedField[] {
  if (additions.length === 0) {
    return current;
  }

  const next = current.map((field) => ({ ...field }));
  const byKey = new Map(
    next.map((field, index) => [normalizeSuggestedFieldKey(field.name), index] as const)
  );

  for (const addition of additions) {
    const name = addition.name.trim();
    if (!name) {
      continue;
    }

    const key = normalizeSuggestedFieldKey(name);
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      next.push({
        ...addition,
        name,
      });
      byKey.set(key, next.length - 1);
      continue;
    }

    next[existingIndex] = {
      ...next[existingIndex],
      ...addition,
      name,
      initialValue:
        addition.initialValue?.trim() || next[existingIndex].initialValue || "null",
    };
  }

  return next;
}

function withDefaultPrimaryAgentStateSchema(
  plan: PlannerResult,
  daemonState: Record<string, unknown> | null
): PlannerResult {
  if (
    !plannerResultHasTargetDraftPatch(plan) ||
    plannerResultIsWorkflowReviewOnly(plan)
  ) {
    return plan;
  }

  return {
    ...plan,
    stateFields: mergePlannerSuggestedFields(
      buildDefaultPrimaryAgentStateFields(readProcessModelSnapshot(daemonState)),
      plan.stateFields
    ),
  };
}

function withDefaultEnvironmentAgentStateSchemas(
  plan: PlannerResult,
  daemonState: Record<string, unknown> | null
): PlannerResult {
  if (
    !plannerResultHasTargetDraftPatch(plan) ||
    plannerResultIsWorkflowReviewOnly(plan) ||
    (plan.environmentAgents.length === 0 && plan.agentConnections.length === 0)
  ) {
    return plan;
  }

  const defaultFields = buildDefaultEnvironmentAgentStateFields(
    readProcessModelSnapshot(daemonState)
  );

  return {
    ...plan,
    environmentAgents: plan.environmentAgents.map((seed) => ({
      ...seed,
      stateFields: mergePlannerSuggestedFields(defaultFields, seed.stateFields),
    })),
    agentConnections: plan.agentConnections.map((seed) => ({
      ...seed,
      stateFields: mergePlannerSuggestedFields(defaultFields, seed.stateFields),
    })),
  };
}

function resolveEnvironmentAgentSeeds(args: {
  plan: PlannerResult;
}): PlannerEnvironmentAgentSeed[] {
  return args.plan.environmentAgents;
}

function normalizePlannerSkillNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function createPlannerSkillConditionCanvasDoc(args: {
  skillName: string;
  phase: "start" | "termination";
  condition: string;
}): CanvasDoc {
  const canvasId = makeOrchestrationId();
  const startId = makeOrchestrationId();
  const conditionId = makeOrchestrationId();
  const phaseLabel = args.phase === "start" ? "Start" : "Termination";

  return {
    version: 2,
    activeId: canvasId,
    canvases: [
      {
        id: canvasId,
        name: `${args.skillName} ${phaseLabel.toLowerCase()} condition`,
        freeText:
          "This skill condition canvas must end with the Condition node. The runtime reads that final condition as true or false.",
        graph: {
          nodes: [
            {
              id: startId,
              type: "start",
              position: { x: 160, y: 60 },
              data: {
                label: `${phaseLabel} condition for ${args.skillName}.`,
              },
            },
            {
              id: conditionId,
              type: "condition",
              position: { x: 160, y: 220 },
              data: { label: args.condition },
            },
          ],
          edges: [
            {
              id: makeOrchestrationId(),
              source: startId,
              target: conditionId,
            },
          ],
        },
      },
    ],
  };
}

function buildPlannerSkillPolicySeed(args: {
  seed: PlannerSkillSeed;
  agentKind: "agent" | "environment";
  ownerTitle: string;
}): PolicySeed {
  const raw = args.seed.policySeed ?? null;
  const isEnvironment = args.agentKind === "environment";

  return {
    canvasName: raw?.canvasName?.trim() || `${args.seed.name} policy`,
    generalPrompt:
      raw?.generalPrompt?.trim() ||
      `Run the "${args.seed.name}" temporally extended action for ${args.ownerTitle}.`,
    clarificationGate:
      raw?.clarificationGate?.trim() ||
      `the "${args.seed.name}" skill lacks enough current state to choose its next action`,
    clarificationActions:
      raw?.clarificationActions?.length
        ? raw.clarificationActions
        : [
            `Ask for the missing detail needed to continue the "${args.seed.name}" skill, and include one concrete typical answer/default choice that can be accepted or revised.`,
          ],
    executionActions:
      raw?.executionActions?.length
        ? raw.executionActions
        : [
            `Use the current state and latest ingress values to continue the "${args.seed.name}" skill.`,
            isEnvironment
              ? "Produce the environment-side observation and reward for this skill step."
              : "Choose the owning agent's next action for this skill step.",
          ],
    responseRule:
      raw?.responseRule?.trim() ||
      (isEnvironment
        ? `return the environment response for the "${args.seed.name}" skill while preserving the environment reply contract`
        : `return the next action for the "${args.seed.name}" skill`),
    notes:
      raw?.notes?.trim() ||
      "This policy runs only while the temporally extended action is active.",
  };
}

function requireStarterPolicyCanvasDoc(
  starterDefaults: PrimarySourceTemplateDefaults | null | undefined,
  context: string
): CanvasDoc {
  const doc = cloneCanvasDoc(starterDefaults?.sourcePolicyCanvases);
  if (!doc || !hasCanvasContent(doc)) {
    throw new Error(
      `Starter agent policy canvas template is unavailable; cannot ${context}.`
    );
  }
  return doc;
}

function requireStarterStateCanvasDoc(
  starterDefaults: PrimarySourceTemplateDefaults | null | undefined,
  context: string
): CanvasDoc {
  const doc = cloneCanvasDoc(starterDefaults?.sourceStatePolicyCanvases);
  if (!doc || !hasCanvasContent(doc)) {
    throw new Error(
      `Starter agent state canvas template is unavailable; cannot ${context}.`
    );
  }
  return doc;
}

function requireStarterRewardCanvasDoc(
  starterDefaults: PrimarySourceTemplateDefaults | null | undefined,
  context: string
): CanvasDoc {
  const doc = cloneCanvasDoc(starterDefaults?.sourceRewardCanvases);
  if (!doc || !hasCanvasContent(doc)) {
    throw new Error(
      `Starter agent reward canvas template is unavailable; cannot ${context}.`
    );
  }
  return doc;
}

function renderStarterPolicySeedFallbackPrompt(seed: PolicySeed): string {
  return [
    seed.generalPrompt.trim(),
    seed.clarificationGate.trim()
      ? [
          `If ${seed.clarificationGate.trim()}:`,
          ...seed.clarificationActions
            .map((action) => action.trim())
            .filter(Boolean)
            .map((action) => `- ${action}`),
        ].join("\n")
      : "",
    seed.executionActions.length > 0
      ? [
          "Otherwise:",
          ...seed.executionActions
            .map((action) => action.trim())
            .filter(Boolean)
            .map((action) => `- ${action}`),
        ].join("\n")
      : "",
    seed.responseRule.trim() ? `Response rule: ${seed.responseRule.trim()}` : "",
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n\n");
}

function findStarterPolicyActiveCanvas(doc: CanvasDoc): CanvasEntry {
  const canvas =
    doc.canvases.find((entry) => entry.id === doc.activeId) ?? doc.canvases[0];
  if (!canvas) {
    throw new Error("Starter agent policy canvas template is malformed.");
  }
  return canvas;
}

function createStarterPolicyCanvasFromPolicySeed(args: {
  starterDefaults: PrimarySourceTemplateDefaults | null | undefined;
  seed: PolicySeed;
  context: string;
}): CanvasDoc {
  const doc = requireStarterPolicyCanvasDoc(
    args.starterDefaults,
    args.context
  );
  const canvas = findStarterPolicyActiveCanvas(doc);
  const startNode = findCanvasStartNode(canvas);
  const fallbackPrompt = canvas.graph.nodes.find(
    (node) => node.data?.starterFallback === true
  );
  const displayNode = canvas.graph.nodes.find(
    (node) =>
      node.type === "display" &&
      typeof node.data?.inputVariable === "string" &&
      node.data.inputVariable.trim() === PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME
  );

  if (!startNode || !fallbackPrompt || !displayNode) {
    throw new Error(
      `Starter agent policy canvas template is malformed; cannot ${args.context}.`
    );
  }

  canvas.name = args.seed.canvasName.trim() || canvas.name;
  canvas.freeText = args.seed.notes?.trim() || canvas.freeText;
  startNode.data = {
    ...startNode.data,
    label: args.seed.generalPrompt.trim() || startNode.data.label,
  };
  fallbackPrompt.data = {
    ...fallbackPrompt.data,
    label: renderStarterPolicySeedFallbackPrompt(args.seed),
  };

  return doc;
}

function createPolicyCanvasDocFromStarterTemplate(args: {
  starterDefaults: PrimarySourceTemplateDefaults | null | undefined;
  structure?: InitialCanvasStructure | null;
  seed: PolicySeed;
  context: string;
}): CanvasDoc {
  if (!args.structure) {
    return createStarterPolicyCanvasFromPolicySeed({
      starterDefaults: args.starterDefaults,
      seed: args.seed,
      context: args.context,
    });
  }

  const doc = applyInitialCanvasStructureToStarterCanvasDoc({
    starterCanvasDoc: requireStarterPolicyCanvasDoc(
      args.starterDefaults,
      args.context
    ),
    structure: args.structure,
    target: "policy",
    fallbackCanvasName: args.seed.canvasName,
    fallbackNotes: args.seed.notes ?? "",
  });

  if (!doc) {
    throw new Error(
      `Starter agent policy canvas template could not apply the initial structure; cannot ${args.context}.`
    );
  }

  return doc;
}

function createRewardCanvasDocFromSeed(args: {
  starterDefaults: PrimarySourceTemplateDefaults | null | undefined;
  structure?: InitialCanvasStructure | null;
  seed: PolicySeed;
  context: string;
}): CanvasDoc {
  if (args.structure) {
    const doc = applyInitialCanvasStructureToStarterCanvasDoc({
      starterCanvasDoc: requireStarterRewardCanvasDoc(
        args.starterDefaults,
        args.context
      ),
      structure: args.structure,
      target: "reward",
      fallbackCanvasName: args.seed.canvasName,
      fallbackNotes: args.seed.notes ?? "",
    });

    if (!doc) {
      throw new Error(
        `Starter agent reward canvas template could not apply the initial structure; cannot ${args.context}.`
      );
    }

    return doc;
  }

  const doc = requireStarterRewardCanvasDoc(args.starterDefaults, args.context);
  const canvas = findStarterPolicyActiveCanvas(doc);
  const startNode = findCanvasStartNode(canvas);
  const fallbackPrompt =
    canvas.graph.nodes.find((node) => node.data?.starterFallback === true) ??
    canvas.graph.nodes.find((node) => node.type === "prompt");

  if (!startNode || !fallbackPrompt) {
    throw new Error(
      `Starter agent reward canvas template is malformed; cannot ${args.context}.`
    );
  }

  canvas.name = args.seed.canvasName.trim() || canvas.name;
  canvas.freeText = args.seed.notes?.trim() || canvas.freeText;
  startNode.data = {
    ...startNode.data,
    label: args.seed.generalPrompt.trim() || startNode.data.label,
  };
  fallbackPrompt.data = {
    ...fallbackPrompt.data,
    label: renderStarterPolicySeedFallbackPrompt(args.seed),
  };

  return doc;
}

function createStateCanvasDocFromStarterTemplate(args: {
  starterDefaults: PrimarySourceTemplateDefaults | null | undefined;
  structure?: InitialCanvasStructure | null;
  fallbackCanvasName: string;
  fallbackNotes: string;
  context: string;
}): CanvasDoc {
  if (!args.structure) {
    return requireStarterStateCanvasDoc(args.starterDefaults, args.context);
  }

  const doc = applyInitialCanvasStructureToStarterCanvasDoc({
    starterCanvasDoc: requireStarterStateCanvasDoc(
      args.starterDefaults,
      args.context
    ),
    structure: args.structure,
    target: "state",
    fallbackCanvasName: args.fallbackCanvasName,
    fallbackNotes: args.fallbackNotes,
  });

  if (!doc) {
    throw new Error(
      `Starter agent state canvas template could not apply the initial structure; cannot ${args.context}.`
    );
  }

  return doc;
}

function createPlannerSkillFromSeed(args: {
  seed: PlannerSkillSeed;
  existing?: OrchestrationSkill;
  agentKind: "agent" | "environment";
  ownerTitle: string;
  starterDefaults?: PrimarySourceTemplateDefaults | null;
}): OrchestrationSkill {
  const name = args.seed.name.trim();
  const shouldReplaceAll = args.seed.replaceExisting === true;
  const shouldCreateStartCondition =
    shouldReplaceAll ||
    !args.existing?.startConditionCanvases ||
    args.seed.startCondition.trim().length > 0;
  const shouldCreatePolicy =
    shouldReplaceAll ||
    !args.existing?.policyCanvases ||
    !!args.seed.policySeed;
  const shouldCreateTerminationCondition =
    shouldReplaceAll ||
    !args.existing?.terminationConditionCanvases ||
    args.seed.terminationCondition.trim().length > 0;

  return {
    id: args.existing?.id ?? makeOrchestrationId(),
    name,
    startConditionCanvases: shouldCreateStartCondition
      ? createPlannerSkillConditionCanvasDoc({
          skillName: name,
          phase: "start",
          condition:
            args.seed.startCondition.trim() || "message contains __replace_me__",
        })
      : args.existing?.startConditionCanvases ?? null,
    policyPrompt: shouldCreatePolicy ? "" : args.existing?.policyPrompt ?? "",
    policyCanvases: shouldCreatePolicy
      ? createStarterPolicyCanvasFromPolicySeed({
          starterDefaults: args.starterDefaults,
          seed: buildPlannerSkillPolicySeed({
            seed: args.seed,
            agentKind: args.agentKind,
            ownerTitle: args.ownerTitle,
          }),
          context: `create policy canvas for skill "${name}"`,
        })
      : args.existing?.policyCanvases ?? null,
    terminationConditionCanvases: shouldCreateTerminationCondition
      ? createPlannerSkillConditionCanvasDoc({
          skillName: name,
          phase: "termination",
          condition:
            args.seed.terminationCondition.trim() ||
            "message contains __replace_me__",
        })
      : args.existing?.terminationConditionCanvases ?? null,
  };
}

function applyPlannerSkillSeedsToSkills(args: {
  currentSkills: OrchestrationSkill[];
  seeds: PlannerSkillSeed[];
  agentKind: "agent" | "environment";
  ownerTitle: string;
  starterDefaults?: PrimarySourceTemplateDefaults | null;
}): {
  skills: OrchestrationSkill[];
  addedCount: number;
  updatedCount: number;
} {
  if (args.seeds.length === 0) {
    return {
      skills: args.currentSkills,
      addedCount: 0,
      updatedCount: 0,
    };
  }

  const nextSkills = args.currentSkills.map((skill) => ({ ...skill }));
  const indexByName = new Map(
    nextSkills.map(
      (skill, index) => [normalizePlannerSkillNameKey(skill.name), index] as const
    )
  );
  let addedCount = 0;
  let updatedCount = 0;

  for (const seed of args.seeds) {
    const key = normalizePlannerSkillNameKey(seed.name);
    const existingIndex = indexByName.get(key);
    const existing =
      existingIndex === undefined ? undefined : nextSkills[existingIndex];
    const nextSkill = createPlannerSkillFromSeed({
      seed,
      existing,
      agentKind: args.agentKind,
      ownerTitle: args.ownerTitle,
      starterDefaults: args.starterDefaults,
    });

    if (existingIndex === undefined) {
      nextSkills.push(nextSkill);
      indexByName.set(key, nextSkills.length - 1);
      addedCount += 1;
    } else {
      nextSkills[existingIndex] = nextSkill;
      updatedCount += 1;
    }
  }

  return {
    skills: nextSkills,
    addedCount,
    updatedCount,
  };
}

function plannerAgentSkillSeedToSkillSeed(
  seed: PlannerAgentSkillSeed
): PlannerSkillSeed {
  return {
    target: "environment",
    name: seed.name,
    startCondition: seed.startCondition,
    terminationCondition: seed.terminationCondition,
    policySeed: seed.policySeed,
    replaceExisting: seed.replaceExisting,
  };
}

function findAgentSkillConnectionIndex(
  connections: OrchestrationAgentConnection[],
  seed: PlannerAgentSkillSeed
): number {
  const agentId = seed.agentId.trim();
  const workflowStageId = seed.workflowStageId?.trim() ?? "";
  return connections.findIndex((connection) => {
    if (
      workflowStageId &&
      (connection.workflowStageId ?? "").trim() !== workflowStageId
    ) {
      return false;
    }
    return (
      connection.targetAgentId.trim() === agentId ||
      (connection.targetAgentSharedId ?? "").trim() === agentId
    );
  });
}

function ensureAgentBindingForSkillSeed(args: {
  bindings: OrchestrationProject["agents"];
  seed: PlannerAgentSkillSeed;
}): {
  bindings: OrchestrationProject["agents"];
  index: number;
  added: boolean;
} {
  const agentId = args.seed.agentId.trim();
  const existingIndex = args.bindings.findIndex(
    (binding) => binding.id.trim() === agentId
  );
  if (existingIndex >= 0) {
    return { bindings: args.bindings, index: existingIndex, added: false };
  }

  const nextBinding: OrchestrationProject["agents"][number] = {
    id: agentId,
    templateId: STARTER_AGENT_TEMPLATE_ID,
    templateVersionId: STARTER_AGENT_TEMPLATE_VERSION_ID,
    title: args.seed.agentTitle?.trim() || agentId,
    roleContext: "",
    fieldOverrides: [],
    datasetOverrides: [],
    uploadedFileOverrides: [],
    skillOverrides: [],
    policyCanvasesOverride: null,
    statePolicyCanvasesOverride: null,
  };

  return {
    bindings: [...args.bindings, nextBinding],
    index: args.bindings.length,
    added: true,
  };
}

function applyPlannerAgentSkillSeeds(args: {
  project: OrchestrationProject;
  seeds: PlannerAgentSkillSeed[];
  starterDefaults?: PrimarySourceTemplateDefaults | null;
}): {
  project: OrchestrationProject;
  addedCount: number;
  updatedCount: number;
  addedBindingCount: number;
} {
  if (args.seeds.length === 0) {
    return {
      project: args.project,
      addedCount: 0,
      updatedCount: 0,
      addedBindingCount: 0,
    };
  }

  let nextProject = args.project;
  let nextConnections = [...nextProject.agentConnections];
  let nextBindings = [...nextProject.agents];
  let addedCount = 0;
  let updatedCount = 0;
  let addedBindingCount = 0;

  for (const seed of args.seeds) {
    const connectionIndex = findAgentSkillConnectionIndex(nextConnections, seed);
    const skillSeed = plannerAgentSkillSeedToSkillSeed(seed);
    if (connectionIndex >= 0) {
      const connection = nextConnections[connectionIndex];
      const skillResult = applyPlannerSkillSeedsToSkills({
        currentSkills: connection.targetSkills ?? [],
        seeds: [skillSeed],
        agentKind: "agent",
        ownerTitle:
          seed.agentTitle?.trim() ||
          connection.targetAgentTitle?.trim() ||
          seed.agentId,
        starterDefaults: args.starterDefaults,
      });
      nextConnections[connectionIndex] = syncAgentConnectionDerivedPrompts({
        ...connection,
        targetSkills: skillResult.skills,
      });
      addedCount += skillResult.addedCount;
      updatedCount += skillResult.updatedCount;
      continue;
    }

    const bindingResult = ensureAgentBindingForSkillSeed({
      bindings: nextBindings,
      seed,
    });
    nextBindings = bindingResult.bindings;
    if (bindingResult.added) {
      addedBindingCount += 1;
    }
    const binding = nextBindings[bindingResult.index];
    const skillResult = applyPlannerSkillSeedsToSkills({
      currentSkills: binding.skillOverrides ?? [],
      seeds: [skillSeed],
      agentKind: "agent",
      ownerTitle: seed.agentTitle?.trim() || binding.title || seed.agentId,
      starterDefaults: args.starterDefaults,
    });
    nextBindings[bindingResult.index] = {
      ...binding,
      title: binding.title || seed.agentTitle?.trim() || seed.agentId,
      skillOverrides: skillResult.skills,
    };
    addedCount += skillResult.addedCount;
    updatedCount += skillResult.updatedCount;
  }

  nextProject = {
    ...nextProject,
    agents: nextBindings,
    agentConnections: nextConnections,
  };

  return {
    project: nextProject,
    addedCount,
    updatedCount,
    addedBindingCount,
  };
}

function mergeOrchestrationSkillsByName(
  base: OrchestrationSkill[],
  additions: OrchestrationSkill[]
): OrchestrationSkill[] {
  const next = base.map((skill) => ({ ...skill }));
  const indexByName = new Map(
    next.map((skill, index) => [normalizePlannerSkillNameKey(skill.name), index])
  );
  for (const skill of additions) {
    const key = normalizePlannerSkillNameKey(skill.name);
    const existingIndex = indexByName.get(key);
    if (existingIndex === undefined) {
      next.push({ ...skill });
      indexByName.set(key, next.length - 1);
    } else {
      next[existingIndex] = { ...skill };
    }
  }
  return next;
}

function migrateLegacyTopLevelSkillsToAgentBinding(
  project: OrchestrationProject
): { project: OrchestrationProject; changed: boolean } {
  const legacySkills = project.skills ?? [];
  if (legacySkills.length === 0) {
    return { project, changed: false };
  }

  const agentId = (project.agentId || project.id).trim();
  const seed: PlannerAgentSkillSeed = {
    agentId,
    agentTitle: project.meta.title || "Workflow Agent",
    name: legacySkills[0]?.name || "Legacy skill migration",
    startCondition: "",
    terminationCondition: "",
  };
  const bindingResult = ensureAgentBindingForSkillSeed({
    bindings: project.agents ?? [],
    seed,
  });
  const nextBindings = bindingResult.bindings;
  const binding = nextBindings[bindingResult.index];
  nextBindings[bindingResult.index] = {
    ...binding,
    skillOverrides: mergeOrchestrationSkillsByName(
      binding.skillOverrides ?? [],
      legacySkills
    ),
  };

  return {
    project: {
      ...project,
      agents: nextBindings,
      skills: [],
    },
    changed: true,
  };
}

function plannerEnvironmentSkillSeedMatchesPlayer(
  seed: PlannerSkillSeed,
  player: OrchestrationProject["environmentPlayers"][number],
  index: number,
  totalPlayers: number
): boolean {
  if (seed.target !== "environment") {
    return false;
  }

  if (seed.environmentAgentId?.trim()) {
    return seed.environmentAgentId.trim() === player.id;
  }

  if (seed.environmentAgentIndex !== undefined) {
    return seed.environmentAgentIndex === index;
  }

  const title = normalizePlannerSkillNameKey(seed.environmentAgentTitle ?? "");
  if (title) {
    return (
      title === normalizePlannerSkillNameKey(`Environment Agent ${index + 1}`) ||
      title === normalizePlannerSkillNameKey(`Environment simulation ${index + 1}`)
    );
  }

  return totalPlayers === 1;
}

interface PlannerAgentTargetedEdit {
  agentTarget?: CanvasEditAgentTarget;
  agentConnectionId?: string;
  targetAgentId?: string;
  targetAgentTitle?: string;
  environmentAgentId?: string;
  environmentAgentIndex?: number;
  environmentAgentNumber?: number;
  environmentAgentTitle?: string;
  skillId?: string;
  skillName?: string;
  skillCanvas?: CanvasEditSkillCanvasTarget;
}

function plannerEditHasSkillSelector(edit: PlannerAgentTargetedEdit): boolean {
  return Boolean(edit.skillId?.trim() || edit.skillName?.trim());
}

function plannerEditHasEnvironmentSelector(edit: PlannerAgentTargetedEdit): boolean {
  return Boolean(
    edit.environmentAgentId?.trim() ||
      edit.environmentAgentIndex !== undefined ||
      edit.environmentAgentNumber !== undefined ||
      edit.environmentAgentTitle?.trim()
  );
}

function plannerEditHasAgentConnectionSelector(
  edit: PlannerAgentTargetedEdit
): boolean {
  const connectionEdit = edit as PlannerAgentTargetedEdit & {
    agentConnectionId?: string;
    targetAgentId?: string;
  };
  return Boolean(
    connectionEdit.agentConnectionId?.trim() ||
      connectionEdit.targetAgentId?.trim()
  );
}

function plannerEditTargetsPrimary(edit: PlannerAgentTargetedEdit): boolean {
  if (plannerEditHasSkillSelector(edit)) {
    return false;
  }
  if (plannerEditHasAgentConnectionSelector(edit)) {
    return false;
  }

  const target = edit.agentTarget ?? "primary";
  return target === "primary" || target === "both";
}

function plannerEditMatchesAgentConnection(
  edit: PlannerAgentTargetedEdit,
  connection: OrchestrationAgentConnection
): boolean {
  if (plannerEditHasSkillSelector(edit)) {
    return false;
  }

  const connectionEdit = edit as PlannerAgentTargetedEdit & {
    agentConnectionId?: string;
    targetAgentId?: string;
  };
  if (connectionEdit.agentConnectionId?.trim()) {
    return connectionEdit.agentConnectionId.trim() === connection.id;
  }
  if (connectionEdit.targetAgentId?.trim()) {
    return connectionEdit.targetAgentId.trim() === connection.targetAgentId;
  }
  return false;
}

function plannerEditMatchesEnvironmentPlayer(
  edit: PlannerAgentTargetedEdit,
  player: OrchestrationProject["environmentPlayers"][number],
  index: number,
  totalPlayers: number
): boolean {
  const target = edit.agentTarget ?? "primary";
  if (plannerEditHasSkillSelector(edit)) {
    return false;
  }

  if (target === "primary") {
    return false;
  }

  const hasEnvironmentSelector = plannerEditHasEnvironmentSelector(edit);
  if (target === "both" && !hasEnvironmentSelector) {
    return true;
  }

  if (edit.environmentAgentId?.trim()) {
    return edit.environmentAgentId.trim() === player.id;
  }

  if (edit.environmentAgentIndex !== undefined) {
    return edit.environmentAgentIndex === index;
  }

  if (edit.environmentAgentNumber !== undefined) {
    return Math.max(0, Math.trunc(edit.environmentAgentNumber) - 1) === index;
  }

  const title = normalizePlannerSkillNameKey(edit.environmentAgentTitle ?? "");
  if (title) {
    return (
      title === normalizePlannerSkillNameKey(`Environment Agent ${index + 1}`) ||
      title === normalizePlannerSkillNameKey(`Environment simulation ${index + 1}`)
    );
  }

  return target === "environment" && totalPlayers === 1;
}

function plannerEditTargetsPrimarySkill(edit: PlannerAgentTargetedEdit): boolean {
  if (!plannerEditHasSkillSelector(edit)) {
    return false;
  }

  const target = edit.agentTarget ?? "primary";
  return target === "primary" || target === "both";
}

function plannerEditMatchesEnvironmentPlayerSkill(
  edit: PlannerAgentTargetedEdit,
  player: OrchestrationProject["environmentPlayers"][number],
  index: number,
  totalPlayers: number
): boolean {
  if (!plannerEditHasSkillSelector(edit)) {
    return false;
  }

  const target = edit.agentTarget ?? "primary";
  if (target === "primary") {
    return false;
  }

  const hasEnvironmentSelector = plannerEditHasEnvironmentSelector(edit);
  if (target === "both" && !hasEnvironmentSelector) {
    return true;
  }

  if (edit.environmentAgentId?.trim()) {
    return edit.environmentAgentId.trim() === player.id;
  }

  if (edit.environmentAgentIndex !== undefined) {
    return edit.environmentAgentIndex === index;
  }

  if (edit.environmentAgentNumber !== undefined) {
    return Math.max(0, Math.trunc(edit.environmentAgentNumber) - 1) === index;
  }

  const title = normalizePlannerSkillNameKey(edit.environmentAgentTitle ?? "");
  if (title) {
    return (
      title === normalizePlannerSkillNameKey(`Environment Agent ${index + 1}`) ||
      title === normalizePlannerSkillNameKey(`Environment simulation ${index + 1}`)
    );
  }

  return target === "environment" && totalPlayers === 1;
}

function plannerEditMatchesSkill(
  edit: PlannerAgentTargetedEdit,
  skill: OrchestrationSkill
): boolean {
  if (edit.skillId?.trim()) {
    return edit.skillId.trim() === skill.id;
  }

  const skillName = normalizePlannerSkillNameKey(edit.skillName ?? "");
  return Boolean(skillName) && skillName === normalizePlannerSkillNameKey(skill.name);
}

function getPlannerSkillCanvasTarget(
  edit: PlannerAgentTargetedEdit
): CanvasEditSkillCanvasTarget {
  return edit.skillCanvas ?? "policy";
}

function applyCanvasEditsToSkill(
  skill: OrchestrationSkill,
  edits: OrchestrationCanvasEdit[]
): {
  skill: OrchestrationSkill;
  appliedCanvasCount: number;
} {
  let nextSkill = skill;
  let appliedCanvasCount = 0;

  const canvasTargets: CanvasEditSkillCanvasTarget[] = [
    "policy",
    "start_condition",
    "termination_condition",
  ];

  for (const canvasTarget of canvasTargets) {
    const matchingEdits = edits.filter(
      (edit) => getPlannerSkillCanvasTarget(edit) === canvasTarget
    );
    if (matchingEdits.length === 0) {
      continue;
    }

    const currentDoc =
      canvasTarget === "start_condition"
        ? nextSkill.startConditionCanvases
        : canvasTarget === "termination_condition"
          ? nextSkill.terminationConditionCanvases
          : nextSkill.policyCanvases;
    const result = applyCanvasEdits(currentDoc, matchingEdits);
    if (result.appliedChanges.length === 0) {
      continue;
    }

    appliedCanvasCount += 1;
    nextSkill =
      canvasTarget === "start_condition"
        ? { ...nextSkill, startConditionCanvases: result.doc }
        : canvasTarget === "termination_condition"
          ? { ...nextSkill, terminationConditionCanvases: result.doc }
          : { ...nextSkill, policyCanvases: result.doc };
  }

  return {
    skill: syncSkillDerivedPrompts(nextSkill),
    appliedCanvasCount,
  };
}

function applyPlannerToolPlacementsToSkill(
  skill: OrchestrationSkill,
  placements: PlannerToolPlacement[]
): {
  skill: OrchestrationSkill;
  appliedCanvasCount: number;
} {
  let nextSkill = skill;
  let appliedCanvasCount = 0;

  const canvasTargets: CanvasEditSkillCanvasTarget[] = [
    "policy",
    "start_condition",
    "termination_condition",
  ];

  for (const canvasTarget of canvasTargets) {
    const matchingPlacements = placements.filter(
      (placement) => getPlannerSkillCanvasTarget(placement) === canvasTarget
    );
    if (matchingPlacements.length === 0) {
      continue;
    }

    const currentDoc =
      canvasTarget === "start_condition"
        ? nextSkill.startConditionCanvases
        : canvasTarget === "termination_condition"
          ? nextSkill.terminationConditionCanvases
          : nextSkill.policyCanvases;
    const result = applyPlannerToolPlacementsToCanvasDoc({
      doc: currentDoc,
      placements: matchingPlacements,
    });
    if (result.appliedCount === 0) {
      continue;
    }

    appliedCanvasCount += 1;
    nextSkill =
      canvasTarget === "start_condition"
        ? { ...nextSkill, startConditionCanvases: result.doc }
        : canvasTarget === "termination_condition"
          ? { ...nextSkill, terminationConditionCanvases: result.doc }
          : { ...nextSkill, policyCanvases: result.doc };
  }

  return {
    skill: syncSkillDerivedPrompts(nextSkill),
    appliedCanvasCount,
  };
}

function cloneCanvasDoc(doc: CanvasDoc | null | undefined): CanvasDoc | null {
  return doc ? (JSON.parse(JSON.stringify(doc)) as CanvasDoc) : null;
}

function hasCanvasContent(doc: CanvasDoc | null | undefined): boolean {
  return Boolean(doc?.canvases?.length);
}

function readPrimarySourceTemplateDefaultsFromVersion(
  version: AgentTemplateVersion | null
): PrimarySourceTemplateDefaults | null {
  if (!version) {
    return null;
  }
  return {
    sourcePolicyPrompt: version.defaultPolicyPrompt,
    sourcePolicyCanvases: version.defaultPolicyCanvases,
    sourceStateUpdatePrompt: version.defaultStateUpdatePrompt,
    sourceStatePolicyCanvases: version.defaultStatePolicyCanvases,
    sourceRewardPrompt: version.defaultRewardPrompt,
    sourceRewardCanvases: version.defaultRewardCanvases,
  };
}

async function loadStarterAgentTemplateDefaults(
  supabase?: SupabaseClient | null
): Promise<PrimarySourceTemplateDefaults | null> {
  const version = await loadAgentTemplateVersion(STARTER_AGENT_TEMPLATE_VERSION_ID, {
    supabase: supabase ?? createSupabaseAdminClient(),
  }).catch((error) => {
    console.warn(
      "[general-orchestration-daemon] starter agent template version unavailable:",
      error instanceof Error ? error.message : error
    );
    return null;
  });

  return readPrimarySourceTemplateDefaultsFromVersion(version);
}

function ensurePrimaryLocalCanvasDefaults(args: {
  project: OrchestrationProject;
  defaults: PrimarySourceTemplateDefaults | null;
}): { project: OrchestrationProject; changed: boolean } {
  const patch: Partial<OrchestrationProject> = {};
  const defaultStateCanvases = cloneCanvasDoc(
    args.defaults?.sourceStatePolicyCanvases
  );
  const defaultPolicyCanvases = cloneCanvasDoc(
    args.defaults?.sourcePolicyCanvases
  );

  if (!hasCanvasContent(args.project.statePolicyCanvases) && defaultStateCanvases) {
    patch.statePolicyCanvases = defaultStateCanvases;
    if (
      !args.project.stateUpdatePrompt.trim() &&
      args.defaults?.sourceStateUpdatePrompt.trim()
    ) {
      patch.stateUpdatePrompt = args.defaults.sourceStateUpdatePrompt;
    }
  }

  if (!hasCanvasContent(args.project.policyCanvases) && defaultPolicyCanvases) {
    patch.policyCanvases = defaultPolicyCanvases;
    if (
      !args.project.policyPrompt.trim() &&
      args.defaults?.sourcePolicyPrompt.trim()
    ) {
      patch.policyPrompt = args.defaults.sourcePolicyPrompt;
    }
  }

  if (Object.keys(patch).length === 0) {
    return { project: args.project, changed: false };
  }

  return {
    project: syncDerivedPrompts({
      ...args.project,
      ...patch,
    }),
    changed: true,
  };
}

function readPrimarySourceDefaultsFromProject(
  project: OrchestrationProject,
  fallback: PrimarySourceTemplateDefaults | null
): PrimarySourceTemplateDefaults {
  return {
    sourcePolicyPrompt:
      project.policyPrompt.trim() || fallback?.sourcePolicyPrompt || "",
    sourcePolicyCanvases:
      hasCanvasContent(project.policyCanvases)
        ? project.policyCanvases
        : fallback?.sourcePolicyCanvases ?? null,
    sourceStateUpdatePrompt:
      project.stateUpdatePrompt.trim() ||
      fallback?.sourceStateUpdatePrompt ||
      "",
    sourceStatePolicyCanvases:
      hasCanvasContent(project.statePolicyCanvases)
        ? project.statePolicyCanvases
        : fallback?.sourceStatePolicyCanvases ?? null,
    sourceRewardPrompt: fallback?.sourceRewardPrompt || "",
    sourceRewardCanvases: fallback?.sourceRewardCanvases ?? null,
  };
}

function applyPrimarySourceTemplateDefaultsToConnection(
  connection: OrchestrationAgentConnection,
  defaults: PrimarySourceTemplateDefaults | null
): { connection: OrchestrationAgentConnection; changed: boolean } {
  if (!defaults) {
    return { connection, changed: false };
  }

  const patch: Partial<OrchestrationAgentConnection> = {};
  const shouldSeedState =
    !connection.sourceStatePolicyCanvases &&
    !connection.sourceStateUpdatePrompt.trim();
  const shouldSeedPolicy =
    !connection.sourcePolicyCanvases &&
    !connection.sourcePolicyPrompt.trim();
  const shouldSeedReward =
    !connection.sourceRewardCanvases &&
    !connection.sourceRewardPrompt.trim();

  if (shouldSeedState) {
    if (!hasCanvasContent(defaults.sourceStatePolicyCanvases)) {
      throw new Error(
        "Starter agent state canvas template is unavailable; cannot initialize blank primary per-connection state canvases."
      );
    }
    patch.sourceStatePolicyCanvases = cloneCanvasDoc(defaults.sourceStatePolicyCanvases);
    patch.sourceStateUpdatePrompt = defaults.sourceStateUpdatePrompt;
  }

  if (shouldSeedPolicy) {
    if (!hasCanvasContent(defaults.sourcePolicyCanvases)) {
      throw new Error(
        "Starter agent policy canvas template is unavailable; cannot initialize blank primary per-connection policy canvases."
      );
    }
    patch.sourcePolicyCanvases = cloneCanvasDoc(defaults.sourcePolicyCanvases);
    patch.sourcePolicyPrompt = defaults.sourcePolicyPrompt;
  }

  if (shouldSeedReward) {
    if (!hasCanvasContent(defaults.sourceRewardCanvases)) {
      throw new Error(
        "Starter agent reward canvas template is unavailable; cannot initialize blank primary per-connection reward canvases."
      );
    }
    patch.sourceRewardCanvases = cloneCanvasDoc(defaults.sourceRewardCanvases);
    patch.sourceRewardPrompt = defaults.sourceRewardPrompt;
  }

  if (Object.keys(patch).length === 0) {
    return { connection, changed: false };
  }

  return {
    connection: syncAgentConnectionDerivedPrompts({
      ...connection,
      ...patch,
    }),
    changed: true,
  };
}

async function materializePrimarySourceConnectionTemplateDefaults(args: {
  project: OrchestrationProject;
  supabase?: SupabaseClient | null;
}): Promise<{ project: OrchestrationProject; appliedChanges: string[] }> {
  const primaryAgentId = (args.project.agentId || args.project.id).trim();
  const supabase = args.supabase ?? createSupabaseAdminClient();
  const binding = args.project.agents.find(
    (agentBinding) => agentBinding.id.trim() === primaryAgentId
  );
  if (!binding && !hasStructuredOrchestrationProject(args.project)) {
    return { project: args.project, appliedChanges: [] };
  }
  const templateVersionId = binding?.templateVersionId.trim() ?? "";
  const version =
    binding && templateVersionId
      ? await loadAgentTemplateVersion(templateVersionId, {
          supabase,
        })
      : null;
  const defaults =
    readPrimarySourceTemplateDefaultsFromVersion(version) ??
    (binding ? null : await loadStarterAgentTemplateDefaults(supabase));

  const localResult = ensurePrimaryLocalCanvasDefaults({
    project: args.project,
    defaults,
  });
  const projectWithLocalDefaults = localResult.project;
  const connectionDefaults = readPrimarySourceDefaultsFromProject(
    projectWithLocalDefaults,
    defaults
  );

  let changed = localResult.changed;
  let connectionsChanged = false;
  const agentConnections = projectWithLocalDefaults.agentConnections.map(
    (connection) => {
      const result = applyPrimarySourceTemplateDefaultsToConnection(
        connection,
        connectionDefaults
      );
      connectionsChanged ||= result.changed;
      changed ||= result.changed;
      return result.connection;
    }
  );

  return changed
    ? {
        project: {
          ...projectWithLocalDefaults,
          agentConnections,
        },
        appliedChanges: [
          ...(localResult.changed
            ? ["initialized primary local canvases from the starter template"]
            : []),
          ...(connectionsChanged
            ? [
                "initialized blank primary per-connection canvases from the primary local defaults",
              ]
            : []),
        ],
      }
    : { project: args.project, appliedChanges: [] };
}

function createAgentConnectionFromSeed(args: {
  seed: PlannerAgentConnectionSeed;
  sourceAgentId: string;
  sourceTitle: string;
  generalDescription: string;
  existing?: OrchestrationAgentConnection;
  starterDefaults?: PrimarySourceTemplateDefaults | null;
}): OrchestrationAgentConnection {
  const targetDefaults = createEmptyOrchestrationEnvironmentPlayer();
  const existingTargetFields = Array.isArray(args.existing?.targetFields)
    ? args.existing.targetFields
    : [];
  const existingTargetSkills = Array.isArray(args.existing?.targetSkills)
    ? args.existing.targetSkills
    : [];
  const existingTargetDatasets = Array.isArray(args.existing?.targetDatasets)
    ? args.existing.targetDatasets
    : [];
  const existingTargetUploadedFiles = Array.isArray(
    args.existing?.targetUploadedFiles
  )
    ? args.existing.targetUploadedFiles
    : [];
  const targetTitle =
    args.seed.targetAgentTitle?.trim() ||
    args.existing?.targetAgentTitle.trim() ||
    args.seed.targetAgentId;
  const stagePrefix = args.seed.workflowStageName?.trim()
    ? `${args.seed.workflowStageName.trim()}: `
    : "";
  const purpose =
    args.seed.purpose?.trim() ||
    args.existing?.purpose.trim() ||
    `Pairwise interaction from ${args.sourceTitle} to ${targetTitle}.`;
  const sourcePolicySeed = {
    canvasName:
      args.seed.sourcePolicySeed?.canvasName?.trim() ||
      args.existing?.sourcePolicyCanvases?.canvases[0]?.name ||
      `${stagePrefix}Interaction with ${targetTitle}`,
    generalPrompt:
      args.seed.sourcePolicySeed?.generalPrompt?.trim() ||
      `Handle the pairwise interaction from agent ${args.sourceAgentId} to agent ${args.seed.targetAgentId} for ${args.generalDescription.trim() || args.sourceTitle}.`,
    clarificationGate:
      args.seed.sourcePolicySeed?.clarificationGate?.trim() ||
      "the interaction target, input, or expected output is unclear",
    clarificationActions:
      args.seed.sourcePolicySeed?.clarificationActions?.length
        ? args.seed.sourcePolicySeed.clarificationActions
        : [
            "Clarify the smallest missing detail before calling the target agent, and include one concrete typical answer/default choice that can be accepted or revised.",
          ],
    executionActions:
      args.seed.sourcePolicySeed?.executionActions?.length
        ? args.seed.sourcePolicySeed.executionActions
        : [
            `Prepare the request for target agent ${args.seed.targetAgentId}.`,
            "Use a Call Agent node when this interaction needs the target agent's response.",
            "Decide whether the pairwise task is complete. Use Terminate only when no future turns should occur.",
          ],
    responseRule:
      args.seed.sourcePolicySeed?.responseRule?.trim() ||
      "return the result of the pairwise interaction, and use Terminate only when the task is complete and no future turns should occur",
    notes:
      args.seed.sourcePolicySeed?.notes?.trim() ||
      `${purpose} This canvas is the source-side policy contract for one pairwise agent interaction.`,
  };
  const targetPolicySeed = {
    canvasName:
      args.seed.targetPolicySeed?.canvasName?.trim() ||
      args.existing?.targetPolicyCanvases?.canvases[0]?.name ||
      args.existing?.policyCanvases?.canvases[0]?.name ||
      `${stagePrefix}${targetTitle} policy`,
    generalPrompt:
      args.seed.targetPolicySeed?.generalPrompt?.trim() ||
      `Act as ${targetTitle} when responding to ${args.sourceTitle} in ${args.generalDescription.trim() || purpose}.`,
    clarificationGate:
      args.seed.targetPolicySeed?.clarificationGate?.trim() ||
      "the incoming request or target-agent role is unclear",
    clarificationActions:
      args.seed.targetPolicySeed?.clarificationActions?.length
        ? args.seed.targetPolicySeed.clarificationActions
        : [
            "Ask the primary/source agent for the smallest missing detail needed to respond from the target-agent role, and include one concrete typical answer/default choice that can be accepted or revised.",
          ],
    executionActions:
      args.seed.targetPolicySeed?.executionActions?.length
        ? args.seed.targetPolicySeed.executionActions
        : [
            `Interpret the latest request from ${args.sourceTitle}.`,
            `Respond as ${targetTitle}, preserving the target agent's role and state.`,
            "Do not describe the primary/source agent's orchestration policy unless the request explicitly asks for it.",
          ],
    responseRule:
      args.seed.targetPolicySeed?.responseRule?.trim() ||
      `return the next response as ${targetTitle}, not as ${args.sourceTitle}`,
    notes:
      args.seed.targetPolicySeed?.notes?.trim() ||
      `${purpose} This canvas controls the connected target agent's own behavior, not the source-side pairwise interaction policy.`,
  };
  const sourceRewardSeed = {
    canvasName:
      args.seed.sourceRewardSeed?.canvasName?.trim() ||
      args.existing?.sourceRewardCanvases?.canvases[0]?.name ||
      `Reward: ${stagePrefix}${args.sourceTitle} -> ${targetTitle}`,
    generalPrompt:
      args.seed.sourceRewardSeed?.generalPrompt?.trim() ||
      `Score the scalar reward delivered to ${targetTitle} after the latest action from ${args.sourceTitle} to ${targetTitle}. Use all project agent states plus latest_action as input.`,
    clarificationGate:
      args.seed.sourceRewardSeed?.clarificationGate?.trim() ||
      "the latest action, recipient objective, or relevant agent states are insufficient to score the recipient's reward",
    clarificationActions:
      args.seed.sourceRewardSeed?.clarificationActions?.length
        ? args.seed.sourceRewardSeed.clarificationActions
        : [
            "Return 0 when the reward cannot be determined from the available state and action.",
          ],
    executionActions:
      args.seed.sourceRewardSeed?.executionActions?.length
        ? args.seed.sourceRewardSeed.executionActions
        : [
            `Read latest_action as the action emitted by ${args.sourceTitle}.`,
            `Evaluate how that action affects ${targetTitle}'s current objective and state.`,
            "Use all_agent_states for context about the rest of the project.",
            "Return only a scalar numeric reward value for the recipient of latest_action.",
          ],
    responseRule:
      args.seed.sourceRewardSeed?.responseRule?.trim() ||
      `return only the scalar reward value received by ${targetTitle}`,
    notes:
      args.seed.sourceRewardSeed?.notes?.trim() ||
      `${purpose} This reward canvas evaluates ${args.sourceTitle}'s latest action as ${targetTitle}'s observation.`,
  };
  const targetRewardSeed = {
    canvasName:
      args.seed.targetRewardSeed?.canvasName?.trim() ||
      args.existing?.targetRewardCanvases?.canvases[0]?.name ||
      `Reward: ${stagePrefix}${targetTitle} -> ${args.sourceTitle}`,
    generalPrompt:
      args.seed.targetRewardSeed?.generalPrompt?.trim() ||
      `Score the scalar reward delivered to ${args.sourceTitle} after the latest action from ${targetTitle} to ${args.sourceTitle}. Use all project agent states plus latest_action as input.`,
    clarificationGate:
      args.seed.targetRewardSeed?.clarificationGate?.trim() ||
      "the latest action, recipient objective, or relevant agent states are insufficient to score the recipient's reward",
    clarificationActions:
      args.seed.targetRewardSeed?.clarificationActions?.length
        ? args.seed.targetRewardSeed.clarificationActions
        : [
            "Return 0 when the reward cannot be determined from the available state and action.",
          ],
    executionActions:
      args.seed.targetRewardSeed?.executionActions?.length
        ? args.seed.targetRewardSeed.executionActions
        : [
            `Read latest_action as the action emitted by ${targetTitle}.`,
            `Evaluate how that action affects ${args.sourceTitle}'s overall objective and state.`,
            "Use all_agent_states for context about the rest of the project.",
            "Return only a scalar numeric reward value for the recipient of latest_action.",
          ],
    responseRule:
      args.seed.targetRewardSeed?.responseRule?.trim() ||
      `return only the scalar reward value received by ${args.sourceTitle}`,
    notes:
      args.seed.targetRewardSeed?.notes?.trim() ||
      `${purpose} This reward canvas evaluates ${targetTitle}'s latest action as ${args.sourceTitle}'s observation.`,
  };
  const seededSourcePolicyCanvasDoc = hasCanvasContent(
    args.existing?.sourcePolicyCanvases
  )
    ? null
    : createPolicyCanvasDocFromStarterTemplate({
        starterDefaults: args.starterDefaults,
        structure: args.seed.sourceInitialPolicyCanvasStructure,
        seed: sourcePolicySeed,
        context: `create source policy canvas for connection "${targetTitle}"`,
      });
  const seededTargetPolicyCanvasDoc =
    hasCanvasContent(args.existing?.targetPolicyCanvases) ||
    hasCanvasContent(args.existing?.policyCanvases)
      ? null
      : createPolicyCanvasDocFromStarterTemplate({
          starterDefaults: args.starterDefaults,
          structure: args.seed.targetInitialPolicyCanvasStructure,
          seed: targetPolicySeed,
          context: `create target policy canvas for connection "${targetTitle}"`,
        });
  const seededSourceRewardCanvasDoc = hasCanvasContent(
    args.existing?.sourceRewardCanvases
  )
    ? null
    : createRewardCanvasDocFromSeed({
        starterDefaults: args.starterDefaults,
        structure: args.seed.sourceInitialRewardCanvasStructure,
        seed: sourceRewardSeed,
        context: `create source-to-target reward canvas for connection "${targetTitle}"`,
      });
  const seededTargetRewardCanvasDoc = hasCanvasContent(
    args.existing?.targetRewardCanvases
  )
    ? null
    : createRewardCanvasDocFromSeed({
        starterDefaults: args.starterDefaults,
        structure: args.seed.targetInitialRewardCanvasStructure,
        seed: targetRewardSeed,
        context: `create target-to-source reward canvas for connection "${targetTitle}"`,
      });
  const targetFields = ensureRequiredEnvironmentAgentStateFields(
    mergeSuggestedFields(
      existingTargetFields.length
        ? existingTargetFields
        : targetDefaults.fields,
      args.seed.stateFields,
      { protectedFieldNames: REQUIRED_ENVIRONMENT_AGENT_STATE_FIELD_NAMES }
    ),
    {
      observationType:
        args.seed.stateFields.find(
          (field) => field.name === PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME
        )?.type,
      actionType:
        args.seed.stateFields.find(
          (field) => field.name === PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME
        )?.type,
    }
  );
  const seededSourceStateCanvasDoc = hasCanvasContent(
    args.existing?.sourceStatePolicyCanvases
  )
    ? null
    : createStateCanvasDocFromStarterTemplate({
        starterDefaults: args.starterDefaults,
        structure: args.seed.sourceInitialStateCanvasStructure,
        fallbackCanvasName: `${args.sourceTitle} state extraction`,
        fallbackNotes:
          "The source-side state canvas should update source-agent state from the current source state and latest target-agent response.",
        context: `create source state canvas for connection "${targetTitle}"`,
      });
  const seededTargetStateCanvasDoc = hasCanvasContent(
    args.existing?.targetStatePolicyCanvases
  )
    ? null
    : createStateCanvasDocFromStarterTemplate({
        starterDefaults: args.starterDefaults,
        structure: args.seed.targetInitialStateCanvasStructure,
        fallbackCanvasName: `${targetTitle} state extraction`,
        fallbackNotes:
          "The connected target-agent state canvas should update target-agent state from the current target state and latest source-agent request.",
        context: `create target state canvas for connection "${targetTitle}"`,
      });
  const nextSourcePolicyCanvases =
    args.existing?.sourcePolicyCanvases ?? seededSourcePolicyCanvasDoc;
  const nextSourceStateCanvases =
    args.existing?.sourceStatePolicyCanvases ?? seededSourceStateCanvasDoc;
  const nextTargetPolicyCanvases =
    args.existing?.targetPolicyCanvases ??
    args.existing?.policyCanvases ??
    seededTargetPolicyCanvasDoc;
  const nextTargetStateCanvases =
    args.existing?.targetStatePolicyCanvases ??
    seededTargetStateCanvasDoc;
  const nextSourceRewardCanvases =
    args.existing?.sourceRewardCanvases ?? seededSourceRewardCanvasDoc;
  const nextTargetRewardCanvases =
    args.existing?.targetRewardCanvases ?? seededTargetRewardCanvasDoc;
  const seededSkills = applyPlannerSkillSeedsToSkills({
    currentSkills: existingTargetSkills.length > 0
      ? existingTargetSkills
      : targetDefaults.skills,
    seeds: args.seed.skills,
    agentKind: "environment",
    ownerTitle: targetTitle,
    starterDefaults: args.starterDefaults,
  }).skills;

  return syncAgentConnectionDerivedPrompts({
    ...(args.existing ??
      createEmptyOrchestrationAgentConnection({
        sourceAgentId: args.sourceAgentId,
        targetAgentId: args.seed.targetAgentId,
      })),
    workflowStageId:
      args.seed.workflowStageId ?? args.existing?.workflowStageId,
    workflowStageName:
      args.seed.workflowStageName ?? args.existing?.workflowStageName,
    targetAgentSharedId:
      args.seed.targetAgentSharedId ?? args.existing?.targetAgentSharedId,
    sourceAgentId: args.sourceAgentId,
    targetAgentId: args.seed.targetAgentId,
    targetAgentTitle: targetTitle,
    purpose,
    invocationMode: args.seed.invocationMode,
    sourcePolicyCanvases: nextSourcePolicyCanvases,
    sourceStatePolicyCanvases: nextSourceStateCanvases,
    sourceRewardCanvases: nextSourceRewardCanvases,
    targetPolicyCanvases: nextTargetPolicyCanvases,
    targetStatePolicyCanvases: nextTargetStateCanvases,
    targetRewardCanvases: nextTargetRewardCanvases,
    targetFields,
    targetSkills: seededSkills,
    targetDatasets: mergeSuggestedDatasets(
      existingTargetDatasets.length > 0
        ? existingTargetDatasets
        : targetDefaults.datasets,
      args.seed.datasets
    ),
    targetUploadedFiles:
      existingTargetUploadedFiles.length > 0
        ? existingTargetUploadedFiles
        : targetDefaults.uploadedFiles,
    policyCanvases: nextTargetPolicyCanvases,
  });
}

function createEnvironmentAgentFromSeed(args: {
  seed: PlannerEnvironmentAgentSeed;
  generalDescription: string;
  starterDefaults?: PrimarySourceTemplateDefaults | null;
}): OrchestrationProject["environmentPlayers"][number] {
  const defaults = createEmptyOrchestrationEnvironmentPlayer();
  const title = args.seed.title?.trim() || "Environment simulation";
  const purpose =
    args.seed.purpose?.trim() ||
    "Simulate the environment side of the target demo so the main agent can be tested in realistic scenarios.";
  const fields = ensureRequiredEnvironmentAgentStateFields(
    mergeSuggestedFields(defaults.fields, args.seed.stateFields, {
      protectedFieldNames: REQUIRED_ENVIRONMENT_AGENT_STATE_FIELD_NAMES,
    }),
    {
      observationType:
        args.seed.stateFields.find(
          (field) => field.name === PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME
        )?.type,
      actionType:
        args.seed.stateFields.find(
          (field) => field.name === PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME
        )?.type,
    }
  );
  const policySeed = {
    canvasName:
      args.seed.policySeed?.canvasName?.trim() || `${title} policy`,
    generalPrompt:
      args.seed.policySeed?.generalPrompt?.trim() ||
      `Simulate the environment for ${args.generalDescription.trim()} by producing coherent observations and rewards for the main agent.`,
    clarificationGate:
      args.seed.policySeed?.clarificationGate?.trim() ||
      "the environment simulation still lacks enough detail to respond coherently",
    clarificationActions:
      args.seed.policySeed?.clarificationActions?.length
        ? args.seed.policySeed.clarificationActions
        : [
            "Ask for the single missing simulation detail that blocks a coherent environment response, and include one concrete typical answer/default choice that can be accepted or revised.",
          ],
    executionActions:
      args.seed.policySeed?.executionActions?.length
        ? args.seed.policySeed.executionActions
        : [
            "Maintain a coherent simulated environment state.",
            "Produce the next observation for the main agent.",
            "Produce the next reward signal for the main agent.",
          ],
    responseRule:
      args.seed.policySeed?.responseRule?.trim() ||
      "reply with the simulated environment's next observation and reward while staying consistent with the environment state",
    notes:
      args.seed.policySeed?.notes?.trim() ||
      `${purpose} This environment agent is intended for simulation work.`,
  };
  const seededPolicyCanvasDoc = createPolicyCanvasDocFromStarterTemplate({
    starterDefaults: args.starterDefaults,
    structure: args.seed.initialPolicyCanvasStructure,
    seed: policySeed,
    context: `create policy canvas for environment agent "${title}"`,
  });
  const seededStateCanvasDoc = createStateCanvasDocFromStarterTemplate({
    starterDefaults: args.starterDefaults,
    structure: args.seed.initialStateCanvasStructure,
    fallbackCanvasName: "State extraction",
    fallbackNotes:
      "The environment-state canvas should update simulation state from the current environment-side state and latest source-agent action, preserving unchanged values unless the current state supports a change.",
    context: `create state canvas for environment agent "${title}"`,
  });

  const seededSkills = applyPlannerSkillSeedsToSkills({
    currentSkills: defaults.skills,
    seeds: args.seed.skills,
    agentKind: "environment",
    ownerTitle: title,
    starterDefaults: args.starterDefaults,
  }).skills;

  return syncEnvironmentPlayerDerivedPrompts({
    ...defaults,
    fields,
    skills: seededSkills,
    guidelines: defaults.guidelines,
    datasets: mergeSuggestedDatasets(defaults.datasets, args.seed.datasets),
    policyCanvases: seededPolicyCanvasDoc,
    statePolicyCanvases: seededStateCanvasDoc,
  });
}

function finalizeAssistantReply(
  plan: PlannerResult,
  workflowAppliedChanges: string[] = []
): string {
  const plannerReply = plan.assistantMessage.trim();
  const followUpQuestion = plan.triageQuestions.find((question) => question.trim().length > 0);

  if (
    plan.assistantReplyIntent === "report_update" &&
    workflowAppliedChanges.length === 0
  ) {
    return (
      followUpQuestion ||
      "I couldn't apply that update yet; the workflow did not record any draft changes."
    );
  }

  return plannerReply || followUpQuestion || "";
}

function applyFinalizedAssistantReply(
  plan: PlannerResult,
  assistantMessage: string
): PlannerResult {
  return {
    ...plan,
    assistantMessage,
  };
}


function serializePlannerResult(plan: PlannerResult): string {
  return JSON.stringify(plan);
}

function deriveSetupTitle(
  project: OrchestrationProject,
  plan: PlannerResult,
  generalDescription: string
): string {
  if (plan.setup?.title?.trim()) {
    return plan.setup.title.trim();
  }
  if (project.meta.title.trim() && project.meta.title.trim() !== "Untitled Setup") {
    return project.meta.title.trim();
  }
  if (generalDescription.trim()) {
    const words = generalDescription.trim().split(/\s+/).slice(0, 5).join(" ");
    return words.length > 0 ? words : "Untitled Setup";
  }
  return "Untitled Setup";
}

function normalizeToolMatchKey(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function sanitizePlannerToolFunctionName(raw: string): string {
  const collapsed = raw
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  if (!collapsed) {
    return "";
  }

  const prefixed = /^[a-z_]/.test(collapsed) ? collapsed : `tool_${collapsed}`;
  return prefixed.slice(0, 64);
}

function defaultToolNameForSourceType(sourceType: ToolBlueprintSourceType): string {
  if (sourceType === "web_search") return "search_web";
  if (sourceType === "page") return "fetch_page";
  if (sourceType === "rss") return "fetch_feed";
  if (sourceType === "knowledge_save") return "save_knowledge";
  if (sourceType === "dataset_read") return "read_dataset";
  return "call_tool";
}

function compileToolsForCanvasDoc(
  doc: OrchestrationProject["policyCanvases"]
): CompiledToolDef[] {
  return (
    compileCanvas(doc ?? { version: 2 as const, activeId: "", canvases: [] }).tools ?? []
  );
}

function readCompiledToolConfigString(
  tool: CompiledToolDef | null | undefined,
  key: string
): string {
  const config = tool?.config as Record<string, unknown> | undefined;
  const value = config?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function readCompiledToolConfigBoolean(
  tool: CompiledToolDef | null | undefined,
  key: string
): boolean {
  const config = tool?.config as Record<string, unknown> | undefined;
  return config?.[key] === true;
}

function paramsSchemaFromToolParams(params: ToolBlueprintParam[] | undefined): string {
  const usable = (params ?? []).filter((param) => param.name.trim().length > 0);
  if (usable.length === 0) {
    return "";
  }

  const properties = usable.reduce<Record<string, { type: string; description?: string }>>(
    (acc, param) => {
      acc[param.name.trim()] = {
        type: param.type,
        ...(param.description?.trim() ? { description: param.description.trim() } : {}),
      };
      return acc;
    },
    {}
  );

  return JSON.stringify(properties, null, 2);
}

function paramsSchemaFromCompiledTool(tool: CompiledToolDef | null | undefined): string {
  const properties = tool?.function.parameters.properties;
  return properties && Object.keys(properties).length > 0
    ? JSON.stringify(properties, null, 2)
    : "";
}

function compiledToolMatchesPlacementTool(
  compiledTool: CompiledToolDef,
  placementTool: PlannerToolPlacementTool
): boolean {
  if (compiledTool.config.sourceType !== placementTool.sourceType) {
    return false;
  }

  const requestedToolName = sanitizePlannerToolFunctionName(placementTool.toolName ?? "");
  if (requestedToolName && compiledTool.function.name === requestedToolName) {
    return true;
  }

  const requestedUrl = placementTool.url?.trim();
  if (
    requestedUrl &&
    readCompiledToolConfigString(compiledTool, "url") === requestedUrl
  ) {
    return true;
  }

  const requestedDataset = placementTool.datasetName?.trim();
  if (
    requestedDataset &&
    readCompiledToolConfigString(compiledTool, "datasetName") === requestedDataset
  ) {
    return true;
  }

  const capabilityKey = normalizeToolMatchKey(placementTool.capability);
  const toolNameKey = normalizeToolMatchKey(compiledTool.function.name);
  const descriptionKey = normalizeToolMatchKey(compiledTool.function.description);
  if (
    capabilityKey &&
    ((toolNameKey &&
      (toolNameKey.includes(capabilityKey) || capabilityKey.includes(toolNameKey))) ||
      descriptionKey.includes(capabilityKey))
  ) {
    return true;
  }

  return placementTool.sourceType === "web_search" && !requestedToolName;
}

function findMatchingCompiledTool(
  doc: OrchestrationProject["policyCanvases"],
  placementTool: PlannerToolPlacementTool
): CompiledToolDef | null {
  return (
    compileToolsForCanvasDoc(doc).find((compiledTool) =>
      compiledToolMatchesPlacementTool(compiledTool, placementTool)
    ) ?? null
  );
}

function buildToolPlacementNodeData(
  placement: PlannerToolPlacement,
  existingTool: CompiledToolDef | null
): Record<string, unknown> {
  const sourceType = placement.tool.sourceType;
  const toolName =
    existingTool?.function.name ||
    sanitizePlannerToolFunctionName(
      placement.tool.toolName ||
        placement.tool.capability ||
        defaultToolNameForSourceType(sourceType)
    ) ||
    defaultToolNameForSourceType(sourceType);
  const baseDescription =
    existingTool?.function.description?.trim() ||
    placement.tool.description?.trim() ||
    placement.tool.capability.trim() ||
    `Run the ${sourceType} tool.`;
  const querySource = placement.querySource?.trim();
  const querySourceLabel = querySource?.replace(/[_-]+/g, " ");
  const description =
    querySource && querySourceLabel
      ? normalizeToolMatchKey(baseDescription).includes(
          normalizeToolMatchKey(querySourceLabel)
        )
        ? baseDescription
        : `${baseDescription} Use ${querySourceLabel} as the input or query when applicable.`
      : baseDescription;
  const rawUrl =
    placement.tool.url?.trim() ||
    readCompiledToolConfigString(existingTool, "url") ||
    "";
  const paramsSchema =
    paramsSchemaFromToolParams(placement.tool.parameters) ||
    paramsSchemaFromCompiledTool(existingTool);
  const saveTarget =
    placement.tool.saveTarget ??
    (readCompiledToolConfigString(existingTool, "saveTarget") === "dataset"
      ? "dataset"
      : "knowledge");
  const datasetName =
    placement.tool.datasetName?.trim() ||
    readCompiledToolConfigString(existingTool, "datasetName");

  return {
    toolName,
    description,
    sourceType,
    url:
      sourceType === "web_search" ||
      sourceType === "knowledge_save" ||
      sourceType === "dataset_read"
        ? ""
        : rawUrl,
    paramsSchema,
    promoteToKnowledge:
      placement.tool.promoteToKnowledge === true ||
      readCompiledToolConfigBoolean(existingTool, "promoteToKnowledge"),
    saveTarget,
    datasetName,
    ...(querySource ? { querySource } : {}),
  };
}

function createCanvasEditForToolPlacement(
  doc: OrchestrationProject["policyCanvases"],
  placement: PlannerToolPlacement
): OrchestrationCanvasEdit {
  const existingTool = findMatchingCompiledTool(doc, placement.tool);
  return {
    target: placement.target,
    op: placement.placement === "after" ? "insert_node_after" : "insert_node_before",
    canvasId: placement.canvasId,
    canvasName: placement.canvasName,
    nodeType: "tool_call",
    label:
      placement.label?.trim() ||
      placement.tool.whenToCall.trim() ||
      `when ${placement.tool.capability.trim() || "this capability"} is needed`,
    data: buildToolPlacementNodeData(placement, existingTool),
    nodeRef: placement.anchorRef,
    sourceRef: placement.placement === "before" ? placement.sourceRef : undefined,
    targetRef: placement.placement === "after" ? placement.targetRef : undefined,
    sourceHandle: placement.sourceHandle,
    edgeLabel: placement.edgeLabel,
  };
}

function applyPlannerToolPlacementsToCanvasDoc(args: {
  doc: OrchestrationProject["policyCanvases"];
  placements: PlannerToolPlacement[];
}): {
  doc: OrchestrationProject["policyCanvases"];
  appliedCount: number;
} {
  let nextDoc = args.doc;
  let appliedCount = 0;

  for (const placement of args.placements) {
    const edit = createCanvasEditForToolPlacement(nextDoc, placement);
    const result = applyCanvasEdits(nextDoc, [edit]);
    nextDoc = result.doc;
    if (result.appliedChanges.length > 0) {
      appliedCount += 1;
    }
  }

  return {
    doc: nextDoc,
    appliedCount,
  };
}

function applyPlannerToolPlacementsToProject(
  project: OrchestrationProject,
  placements: PlannerToolPlacement[]
): {
  project: OrchestrationProject;
  appliedChanges: string[];
} {
  if (placements.length === 0) {
    return {
      project,
      appliedChanges: [],
    };
  }

  const primaryPlacements = placements.filter(plannerEditTargetsPrimary);
  const policyPlacements = primaryPlacements.filter(
    (placement) => placement.target === "policy"
  );
  const statePlacements = primaryPlacements.filter(
    (placement) => placement.target === "state"
  );
  let nextProject = project;
  const appliedChanges: string[] = [];

  if (policyPlacements.length > 0) {
    const result = applyPlannerToolPlacementsToCanvasDoc({
      doc: nextProject.policyCanvases,
      placements: policyPlacements,
    });
    nextProject = {
      ...nextProject,
      policyCanvases: result.doc,
    };
    if (result.appliedCount > 0) {
      appliedChanges.push(
        result.appliedCount === 1
          ? "placed a tool node in the policy canvas"
          : `placed ${result.appliedCount} tool nodes in the policy canvas`
      );
    }
  }

  if (statePlacements.length > 0) {
    const result = applyPlannerToolPlacementsToCanvasDoc({
      doc: nextProject.statePolicyCanvases,
      placements: statePlacements,
    });
    nextProject = {
      ...nextProject,
      statePolicyCanvases: result.doc,
    };
    if (result.appliedCount > 0) {
      appliedChanges.push(
        result.appliedCount === 1
          ? "placed a tool node in the state canvas"
          : `placed ${result.appliedCount} tool nodes in the state canvas`
      );
    }
  }

  const primarySkillPlacements = placements.filter(plannerEditTargetsPrimarySkill);
  if (primarySkillPlacements.length > 0) {
    let primarySkillCount = 0;
    nextProject = {
      ...nextProject,
      skills: (nextProject.skills ?? []).map((skill) => {
        const matchingPlacements = primarySkillPlacements.filter((placement) =>
          plannerEditMatchesSkill(placement, skill)
        );
        if (matchingPlacements.length === 0) {
          return skill;
        }

        const result = applyPlannerToolPlacementsToSkill(
          skill,
          matchingPlacements
        );
        if (result.appliedCanvasCount > 0) {
          primarySkillCount += 1;
        }
        return result.skill;
      }),
    };

    if (primarySkillCount > 0) {
      appliedChanges.push(
        primarySkillCount === 1
          ? "placed a tool node in a top-level legacy skill"
          : `placed tool nodes in ${primarySkillCount} top-level legacy skills`
      );
    }
  }

  const totalPlayers = nextProject.environmentPlayers.length;
  if (totalPlayers > 0) {
    let environmentPolicyCount = 0;
    let environmentStateCount = 0;
    let environmentSkillCount = 0;
    nextProject = {
      ...nextProject,
      environmentPlayers: nextProject.environmentPlayers.map((player, index) => {
        const environmentPlacements = placements.filter((placement) =>
          plannerEditMatchesEnvironmentPlayer(
            placement,
            player,
            index,
            totalPlayers
          )
        );
        const environmentSkillPlacements = placements.filter((placement) =>
          plannerEditMatchesEnvironmentPlayerSkill(
            placement,
            player,
            index,
            totalPlayers
          )
        );
        if (
          environmentPlacements.length === 0 &&
          environmentSkillPlacements.length === 0
        ) {
          return player;
        }

        let nextPlayer = player;
        const environmentPolicyPlacements = environmentPlacements.filter(
          (placement) => placement.target === "policy"
        );
        if (environmentPolicyPlacements.length > 0) {
          const result = applyPlannerToolPlacementsToCanvasDoc({
            doc: nextPlayer.policyCanvases,
            placements: environmentPolicyPlacements,
          });
          nextPlayer = {
            ...nextPlayer,
            policyCanvases: result.doc,
          };
          environmentPolicyCount += result.appliedCount;
        }

        const environmentStatePlacements = environmentPlacements.filter(
          (placement) => placement.target === "state"
        );
        if (environmentStatePlacements.length > 0) {
          const result = applyPlannerToolPlacementsToCanvasDoc({
            doc: nextPlayer.statePolicyCanvases,
            placements: environmentStatePlacements,
          });
          nextPlayer = {
            ...nextPlayer,
            statePolicyCanvases: result.doc,
          };
          environmentStateCount += result.appliedCount;
        }

        if (environmentSkillPlacements.length > 0) {
          nextPlayer = {
            ...nextPlayer,
            skills: (nextPlayer.skills ?? []).map((skill) => {
              const matchingPlacements = environmentSkillPlacements.filter(
                (placement) => plannerEditMatchesSkill(placement, skill)
              );
              if (matchingPlacements.length === 0) {
                return skill;
              }

              const result = applyPlannerToolPlacementsToSkill(
                skill,
                matchingPlacements
              );
              if (result.appliedCanvasCount > 0) {
                environmentSkillCount += 1;
              }
              return result.skill;
            }),
          };
        }

        return syncEnvironmentPlayerDerivedPrompts(nextPlayer);
      }),
    };

    if (environmentPolicyCount > 0) {
      appliedChanges.push(
        environmentPolicyCount === 1
          ? "placed a tool node in an environment-agent policy canvas"
          : `placed ${environmentPolicyCount} tool nodes in environment-agent policy canvases`
      );
    }
    if (environmentStateCount > 0) {
      appliedChanges.push(
        environmentStateCount === 1
          ? "placed a tool node in an environment-agent state canvas"
          : `placed ${environmentStateCount} tool nodes in environment-agent state canvases`
      );
    }
    if (environmentSkillCount > 0) {
      appliedChanges.push(
        environmentSkillCount === 1
          ? "placed a tool node in an environment-agent skill"
          : `placed tool nodes in ${environmentSkillCount} environment-agent skills`
      );
    }
  }

  return {
    project: nextProject,
    appliedChanges,
  };
}

function compiledToolCoversRequest(
  tool: CompiledToolDef,
  request: PlannerToolRequest
): boolean {
  if (tool.config.sourceType !== request.desiredSourceType) {
    return false;
  }

  const requestedDataset = request.datasetName?.trim();
  if (
    requestedDataset &&
    readCompiledToolConfigString(tool, "datasetName") !== requestedDataset
  ) {
    return false;
  }

  const requestedUrl = request.urlHint?.trim();
  if (
    requestedUrl &&
    request.desiredSourceType !== "web_search" &&
    request.desiredSourceType !== "knowledge_save" &&
    request.desiredSourceType !== "dataset_read" &&
    readCompiledToolConfigString(tool, "url") !== requestedUrl
  ) {
    return false;
  }

  if (request.desiredSourceType === "web_search") {
    return true;
  }

  if (requestedUrl || requestedDataset) {
    return true;
  }

  const capabilityKey = normalizeToolMatchKey(request.capability);
  if (!capabilityKey) {
    return true;
  }

  const toolNameKey = normalizeToolMatchKey(tool.function.name);
  const descriptionKey = normalizeToolMatchKey(tool.function.description);
  return (
    (toolNameKey &&
      (toolNameKey.includes(capabilityKey) || capabilityKey.includes(toolNameKey))) ||
    descriptionKey.includes(capabilityKey)
  );
}

function filterToolRequestsAlreadyCoveredByProject(
  project: OrchestrationProject,
  requests: PlannerToolRequest[]
): PlannerToolRequest[] {
  if (requests.length === 0) {
    return [];
  }

  const compiledTools = [
    ...compileToolsForCanvasDoc(getRuntimePolicyCanvasDoc(project.policyCanvases)),
    ...compileToolsForCanvasDoc(project.statePolicyCanvases),
    ...(project.skills ?? []).flatMap((skill) => [
      ...compileToolsForCanvasDoc(skill.policyCanvases),
      ...compileToolsForCanvasDoc(skill.startConditionCanvases),
      ...compileToolsForCanvasDoc(skill.terminationConditionCanvases),
    ]),
    ...project.environmentPlayers.flatMap((player) => [
      ...compileToolsForCanvasDoc(player.policyCanvases),
      ...compileToolsForCanvasDoc(player.statePolicyCanvases),
      ...(player.skills ?? []).flatMap((skill) => [
        ...compileToolsForCanvasDoc(skill.policyCanvases),
        ...compileToolsForCanvasDoc(skill.startConditionCanvases),
        ...compileToolsForCanvasDoc(skill.terminationConditionCanvases),
      ]),
    ]),
  ];
  if (compiledTools.length === 0) {
    return requests;
  }

  return requests.filter(
    (request) =>
      !compiledTools.some((tool) => compiledToolCoversRequest(tool, request))
  );
}

function applyWorkflowPlannerPatchOnly(args: {
  project: OrchestrationProject;
  plan: PlannerResult;
}): { project: OrchestrationProject; appliedChanges: string[] } {
  let nextProject = args.project;
  const appliedChanges: string[] = [];

  if (args.plan.workflowStages.length > 0) {
    const overviewEntry = createWorkflowCanvasEntry({
      canvasId: "workflow-overview",
      canvasName: WORKFLOW_OVERVIEW_CANVAS_NAME,
      stages: args.plan.workflowStages,
      project: nextProject,
    });
    if (overviewEntry) {
      const existingWorkflowDoc = getWorkflowOverviewCanvasDoc(
        nextProject.workflowCanvases ?? nextProject.policyCanvases
      );
      const workflowCanvasDoc = upsertWorkflowCanvasEntryInDoc(
        existingWorkflowDoc,
        overviewEntry
      );
      nextProject = {
        ...nextProject,
        workflowCanvases: workflowCanvasDoc,
        policyCanvases: getRuntimePolicyCanvasDoc(nextProject.policyCanvases),
      };
      appliedChanges.push(
        existingWorkflowDoc?.canvases.some(
          (canvas) => canvas.id === overviewEntry.id
        )
          ? "updated the workflow overview canvas"
          : "created the workflow overview canvas"
      );
    }
  }

  if (args.plan.workflowStagePartitions.length > 0) {
    let workflowCanvasDoc = getWorkflowOverviewCanvasDoc(
      nextProject.workflowCanvases ?? nextProject.policyCanvases
    );
    let createdCount = 0;
    let updatedCount = 0;

    for (const partition of args.plan.workflowStagePartitions) {
      const partitionEntry = createWorkflowStagePartitionCanvasEntry(
        partition,
        nextProject
      );
      if (!partitionEntry) {
        continue;
      }
      const existed = workflowCanvasDoc?.canvases.some(
        (canvas) => canvas.id === partitionEntry.id
      );
      workflowCanvasDoc = upsertWorkflowCanvasEntryInDoc(
        workflowCanvasDoc,
        partitionEntry
      );
      if (existed) {
        updatedCount += 1;
      } else {
        createdCount += 1;
      }
    }

    if (workflowCanvasDoc && (createdCount > 0 || updatedCount > 0)) {
      nextProject = {
        ...nextProject,
        workflowCanvases: workflowCanvasDoc,
        policyCanvases: getRuntimePolicyCanvasDoc(nextProject.policyCanvases),
      };
      if (createdCount > 0) {
        appliedChanges.push(
          createdCount === 1
            ? "created a stage workflow canvas"
            : `created ${createdCount} stage workflow canvases`
        );
      }
      if (updatedCount > 0) {
        appliedChanges.push(
          updatedCount === 1
            ? "updated a stage workflow canvas"
            : `updated ${updatedCount} stage workflow canvases`
        );
      }
    }
  }

  return {
    project: nextProject,
    appliedChanges,
  };
}

function applyStructuredPlannerPatchToProject(
  project: OrchestrationProject,
  plan: PlannerResult,
  daemonState: Record<string, unknown> | null,
  starterDefaults: PrimarySourceTemplateDefaults | null = null
): PlannerPatchApplicationResult {
  const legacySkillMigration = migrateLegacyTopLevelSkillsToAgentBinding(
    ensureDaemonConversationProject(project)
  );
  const baseProject = legacySkillMigration.project;
  const effectiveGeneralDescription = resolveGeneralDescription(
    baseProject,
    plan,
    daemonState
  );
  const effectiveStatus = plan.status.trim() || baseProject.meta.status;
  const hasTargetDraftPatch = plannerResultHasTargetDraftPatch(plan);

  if (!hasTargetDraftPatch || !isDaemonProcessReady(daemonState)) {
    return {
      project: ensureDaemonConversationProject({
        ...baseProject,
        meta: {
          ...baseProject.meta,
          status: effectiveStatus,
        },
      }),
      appliedChanges: [],
      effectiveGeneralDescription,
      effectiveStatus,
    };
  }

  if (plannerResultIsWorkflowReviewOnly(plan)) {
    const workflowResult = applyWorkflowPlannerPatchOnly({
      project: ensureDaemonConversationProject({
        ...baseProject,
        meta: {
          ...baseProject.meta,
          status: effectiveStatus,
        },
      }),
      plan,
    });

    return {
      project: workflowResult.project,
      appliedChanges: workflowResult.appliedChanges,
      effectiveGeneralDescription,
      effectiveStatus,
    };
  }

  let nextProject: OrchestrationProject = {
    ...baseProject,
    meta: {
      ...baseProject.meta,
      title: deriveSetupTitle(baseProject, plan, effectiveGeneralDescription),
      slug: slugify(
        plan.setup?.slug ||
          baseProject.meta.slug ||
          deriveSetupTitle(baseProject, plan, effectiveGeneralDescription)
      ),
      summary: plan.setup?.summary?.trim() || baseProject.meta.summary,
      policyIntent: effectiveGeneralDescription || baseProject.meta.policyIntent,
      status: effectiveStatus,
    },
  };
  const appliedChanges: string[] = legacySkillMigration.changed
    ? ["migrated top-level skills to an agent binding"]
    : [];

  if (plan.setup?.title?.trim()) {
    appliedChanges.push("updated the setup title");
  }
  if (plan.setup?.summary?.trim()) {
    appliedChanges.push("refined the setup summary");
  }
  if (effectiveGeneralDescription && !baseProject.meta.policyIntent.trim()) {
    appliedChanges.push("captured the general policy description");
  }

  const mergedFields = ensureRequiredPrimaryAgentStateFields(
    mergeSuggestedFields(nextProject.fields, plan.stateFields, {
      protectedFieldNames: REQUIRED_PRIMARY_AGENT_STATE_FIELD_NAMES,
    }),
    {
      observationType:
        findOrchestrationFieldByCanonicalName(
          nextProject.fields,
          PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME
        )?.type ??
        inferProcessSignalFieldType(
          readProcessModelSnapshot(daemonState)?.observation.description ?? ""
        ),
      actionType:
        findOrchestrationFieldByCanonicalName(
          nextProject.fields,
          PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME
        )?.type ??
        inferProcessSignalFieldType(
          readProcessModelSnapshot(daemonState)?.action.description ?? ""
        ),
    }
  );
  if (mergedFields.length !== nextProject.fields.length) {
    appliedChanges.push("expanded the state schema");
  }

  nextProject = {
    ...ensureDaemonConversationProject(nextProject),
    fields: mergedFields,
    datasets: mergeSuggestedDatasets(nextProject.datasets, plan.datasets),
  };

  if (
    nextProject.datasets.length !== baseProject.datasets.length &&
    plan.datasets.length > 0
  ) {
    appliedChanges.push("added dataset shapes");
  }

  if (plan.agentTemplateBindings.length > 0) {
    let addedBindingCount = 0;
    let updatedBindingCount = 0;
    const nextAgentBindings = [...nextProject.agents];
    const bindingIndexById = new Map(
      nextAgentBindings.map((binding, index) => [binding.id.trim(), index] as const)
    );

    for (const seed of plan.agentTemplateBindings) {
      const existingIndex = bindingIndexById.get(seed.agentId);
      const existing =
        existingIndex === undefined ? undefined : nextAgentBindings[existingIndex];
      const nextBinding: OrchestrationProject["agents"][number] = {
        id: seed.agentId,
        templateId: seed.templateId,
        templateVersionId: seed.templateVersionId,
        title: seed.title?.trim() || existing?.title || seed.agentId,
        roleContext: seed.roleContext?.trim() || existing?.roleContext || "",
        fieldOverrides: existing?.fieldOverrides ?? [],
        datasetOverrides: existing?.datasetOverrides ?? [],
        uploadedFileOverrides: existing?.uploadedFileOverrides ?? [],
        skillOverrides: existing?.skillOverrides ?? [],
        policyCanvasesOverride: existing?.policyCanvasesOverride ?? null,
        statePolicyCanvasesOverride: existing?.statePolicyCanvasesOverride ?? null,
      };

      if (existingIndex === undefined) {
        nextAgentBindings.push(nextBinding);
        bindingIndexById.set(seed.agentId, nextAgentBindings.length - 1);
        addedBindingCount += 1;
      } else {
        nextAgentBindings[existingIndex] = nextBinding;
        updatedBindingCount += 1;
      }
    }

    nextProject = {
      ...nextProject,
      agents: nextAgentBindings,
    };
    if (addedBindingCount > 0) {
      appliedChanges.push(
        addedBindingCount === 1
          ? "imported an agent template"
          : `imported ${addedBindingCount} agent templates`
      );
    }
    if (updatedBindingCount > 0) {
      appliedChanges.push(
        updatedBindingCount === 1
          ? "updated an agent template binding"
          : `updated ${updatedBindingCount} agent template bindings`
      );
    }
  }

  if (!nextProject.policyCanvases || plan.replacePolicyCanvas === true) {
    nextProject = {
      ...nextProject,
      policyCanvases: requireStarterPolicyCanvasDoc(
        starterDefaults,
        "initialize the primary policy canvas"
      ),
    };
    appliedChanges.push(
      plan.replacePolicyCanvas === true && project.policyCanvases
        ? "reseeded the policy canvas from the starter agent template"
        : "initialized the policy canvas from the starter agent template"
    );
  }

  if (!nextProject.statePolicyCanvases || plan.replaceStateCanvas === true) {
    nextProject = {
      ...nextProject,
      statePolicyCanvases: requireStarterStateCanvasDoc(
        starterDefaults,
        "initialize the primary state canvas"
      ),
    };
    appliedChanges.push(
      plan.replaceStateCanvas === true && project.statePolicyCanvases
        ? "reseeded the state canvas from the starter agent template"
        : "initialized the state canvas from the starter agent template"
    );
  }

  let policyCanvasEdits = plan.canvasEdits.filter(
    (edit) => edit.target === "policy" && plannerEditTargetsPrimary(edit)
  );
  const shouldApplyInitialPolicyStructure =
    !!effectiveGeneralDescription.trim() &&
    !!plan.initialPolicyCanvasStructure &&
    !!nextProject.policyCanvases &&
    (!baseProject.policyCanvases || plan.replacePolicyCanvas === true);

  if (shouldApplyInitialPolicyStructure && plan.initialPolicyCanvasStructure) {
    const policySeed = buildProcessAwarePolicySeed({
      plan,
      project: nextProject,
      generalDescription: effectiveGeneralDescription,
      daemonState,
    });
    const initialPolicyCanvasDoc = applyInitialCanvasStructureToStarterCanvasDoc({
      starterCanvasDoc: nextProject.policyCanvases,
      structure: plan.initialPolicyCanvasStructure,
      target: "policy",
      fallbackCanvasName: policySeed.canvasName || "Main policy",
      fallbackNotes: policySeed.notes,
    });

    if (initialPolicyCanvasDoc) {
      nextProject = {
        ...nextProject,
        policyCanvases: initialPolicyCanvasDoc,
      };
      appliedChanges.push(
        project.policyCanvases && plan.replacePolicyCanvas === true
          ? "applied the initial policy structure to the starter template"
          : "created the initial policy canvas from the starter template"
      );
      policyCanvasEdits = [];
    }
  }

  const shouldApplyInitialStateStructure =
    nextProject.fields.length > 0 &&
    !!plan.initialStateCanvasStructure &&
    !!nextProject.statePolicyCanvases &&
    (!baseProject.statePolicyCanvases || plan.replaceStateCanvas === true);
  let stateCanvasEdits = plan.canvasEdits.filter(
    (edit) => edit.target === "state" && plannerEditTargetsPrimary(edit)
  );

  if (shouldApplyInitialStateStructure && plan.initialStateCanvasStructure) {
    const initialStateCanvasDoc = applyInitialCanvasStructureToStarterCanvasDoc({
      starterCanvasDoc: nextProject.statePolicyCanvases,
      structure: plan.initialStateCanvasStructure,
      target: "state",
      fallbackCanvasName: "State extraction",
      fallbackNotes:
        "The right-hand editor controls the target runtime state schema. By default, this canvas should update state from the current state itself and preserve unchanged values unless the current state supports a change.",
    });

    if (initialStateCanvasDoc) {
      nextProject = {
        ...nextProject,
        statePolicyCanvases: initialStateCanvasDoc,
      };
      appliedChanges.push(
        project.statePolicyCanvases && plan.replaceStateCanvas === true
          ? "applied the initial state structure to the starter template"
          : "created the initial state canvas from the starter template"
      );
      stateCanvasEdits = [];
    }
  }

  if (plan.workflowStages.length > 0) {
    const overviewEntry = createWorkflowCanvasEntry({
      canvasId: "workflow-overview",
      canvasName: WORKFLOW_OVERVIEW_CANVAS_NAME,
      stages: plan.workflowStages,
      project: nextProject,
    });
    if (overviewEntry) {
      const existingWorkflowDoc = getWorkflowOverviewCanvasDoc(
        nextProject.workflowCanvases ?? nextProject.policyCanvases
      );
      const workflowCanvasDoc = upsertWorkflowCanvasEntryInDoc(
        existingWorkflowDoc,
        overviewEntry
      );
      nextProject = {
        ...nextProject,
        workflowCanvases: workflowCanvasDoc,
        policyCanvases: getRuntimePolicyCanvasDoc(nextProject.policyCanvases),
      };
      appliedChanges.push(
        existingWorkflowDoc?.canvases.some(
          (canvas) => canvas.id === overviewEntry.id
        )
          ? "updated the workflow overview canvas"
          : "created the workflow overview canvas"
      );
    }
  }

  if (plan.workflowStagePartitions.length > 0) {
    let workflowCanvasDoc = getWorkflowOverviewCanvasDoc(
      nextProject.workflowCanvases ?? nextProject.policyCanvases
    );
    let createdCount = 0;
    let updatedCount = 0;

    for (const partition of plan.workflowStagePartitions) {
      const partitionEntry = createWorkflowStagePartitionCanvasEntry(
        partition,
        nextProject
      );
      if (!partitionEntry) {
        continue;
      }
      const existed = workflowCanvasDoc?.canvases.some(
        (canvas) => canvas.id === partitionEntry.id
      );
      workflowCanvasDoc = upsertWorkflowCanvasEntryInDoc(
        workflowCanvasDoc,
        partitionEntry
      );
      if (existed) {
        updatedCount += 1;
      } else {
        createdCount += 1;
      }
    }

    if (workflowCanvasDoc && (createdCount > 0 || updatedCount > 0)) {
      nextProject = {
        ...nextProject,
        workflowCanvases: workflowCanvasDoc,
        policyCanvases: getRuntimePolicyCanvasDoc(nextProject.policyCanvases),
      };
      if (createdCount > 0) {
        appliedChanges.push(
          createdCount === 1
            ? "created a stage workflow canvas"
            : `created ${createdCount} stage workflow canvases`
        );
      }
      if (updatedCount > 0) {
        appliedChanges.push(
          updatedCount === 1
            ? "updated a stage workflow canvas"
            : `updated ${updatedCount} stage workflow canvases`
        );
      }
    }
  }

  if (plan.agentConnections.length > 0) {
    let addedConnectionCount = 0;
    let updatedConnectionCount = 0;
    const defaultSourceAgentId = nextProject.agentId || nextProject.id;
    const defaultSourceTitle = nextProject.meta.title || "Workflow Agent";
    const nextConnections = [...nextProject.agentConnections];
    const connectionKey = (connection: {
      workflowStageId?: string;
      sourceAgentId?: string;
      targetAgentId: string;
    }) =>
      [
        connection.workflowStageId?.trim() || "global",
        connection.sourceAgentId?.trim() || defaultSourceAgentId,
        connection.targetAgentId.trim(),
      ].join("::");
    const connectionIndexByTarget = new Map(
      nextConnections.map(
        (connection, index) => [connectionKey(connection), index] as const
      )
    );

    for (const seed of plan.agentConnections) {
      const seedConnectionKey = connectionKey(seed);
      const existingIndex = connectionIndexByTarget.get(seedConnectionKey);
      const existing =
        existingIndex === undefined ? undefined : nextConnections[existingIndex];
      const sourceAgentId =
        seed.sourceAgentId?.trim() ||
        existing?.sourceAgentId?.trim() ||
        defaultSourceAgentId;
      const sourceTitle =
        seed.sourceAgentTitle?.trim() ||
        defaultSourceTitle;
      const nextConnection = createAgentConnectionFromSeed({
        seed,
        sourceAgentId,
        sourceTitle,
        generalDescription: effectiveGeneralDescription,
        existing,
        starterDefaults,
      });

      if (existingIndex === undefined) {
        nextConnections.push(nextConnection);
        connectionIndexByTarget.set(seedConnectionKey, nextConnections.length - 1);
        addedConnectionCount += 1;
      } else {
        nextConnections[existingIndex] = nextConnection;
        updatedConnectionCount += 1;
      }
    }

    nextProject = {
      ...nextProject,
      agentConnections: nextConnections,
    };

    if (addedConnectionCount > 0) {
      appliedChanges.push(
        addedConnectionCount === 1
          ? "added an agent connection"
          : `added ${addedConnectionCount} agent connections`
      );
    }
    if (updatedConnectionCount > 0) {
      appliedChanges.push(
        updatedConnectionCount === 1
          ? "updated an agent connection"
          : `updated ${updatedConnectionCount} agent connections`
      );
    }
  }

  const legacyTopLevelAgentSkillSeeds: PlannerAgentSkillSeed[] = plan.skills
    .filter((skill) => skill.target === "primary")
    .map((skill) => ({
      agentId: nextProject.agentId || nextProject.id,
      agentTitle: nextProject.meta.title || "Workflow Agent",
      name: skill.name,
      startCondition: skill.startCondition,
      terminationCondition: skill.terminationCondition,
      policySeed: skill.policySeed,
      replaceExisting: skill.replaceExisting,
    }));
  const agentSkillSeeds = [
    ...plan.agentSkills,
    ...legacyTopLevelAgentSkillSeeds,
  ];
  if (agentSkillSeeds.length > 0) {
    const skillResult = applyPlannerAgentSkillSeeds({
      project: nextProject,
      seeds: agentSkillSeeds,
      starterDefaults,
    });
    nextProject = skillResult.project;
    if (skillResult.addedBindingCount > 0) {
      appliedChanges.push(
        skillResult.addedBindingCount === 1
          ? "created an agent binding for agent-scoped skills"
          : `created ${skillResult.addedBindingCount} agent bindings for agent-scoped skills`
      );
    }
    if (skillResult.addedCount > 0) {
      appliedChanges.push(
        skillResult.addedCount === 1
          ? "added an agent-scoped skill"
          : `added ${skillResult.addedCount} agent-scoped skills`
      );
    }
    if (skillResult.updatedCount > 0) {
      appliedChanges.push(
        skillResult.updatedCount === 1
          ? "updated an agent-scoped skill"
          : `updated ${skillResult.updatedCount} agent-scoped skills`
      );
    }
  }

  const environmentAgentSeeds = resolveEnvironmentAgentSeeds({
    plan,
  });

  if (environmentAgentSeeds.length > 0) {
    const newEnvironmentPlayers = environmentAgentSeeds.map((seed) =>
      createEnvironmentAgentFromSeed({
        seed,
        generalDescription: effectiveGeneralDescription,
        starterDefaults,
      })
    );

    nextProject = {
      ...nextProject,
      environmentPlayers: [
        ...nextProject.environmentPlayers,
        ...newEnvironmentPlayers,
      ],
    };

    appliedChanges.push(
      newEnvironmentPlayers.length === 1
        ? "created an environment agent for simulation"
        : `created ${newEnvironmentPlayers.length} environment agents for simulation`
    );
  }

  const environmentSkillSeeds = plan.skills.filter(
    (skill) => skill.target === "environment"
  );
  if (environmentSkillSeeds.length > 0 && nextProject.environmentPlayers.length > 0) {
    let addedCount = 0;
    let updatedCount = 0;
    const totalPlayers = nextProject.environmentPlayers.length;
    nextProject = {
      ...nextProject,
      environmentPlayers: nextProject.environmentPlayers.map((player, index) => {
        const matchingSeeds = environmentSkillSeeds.filter((seed) =>
          plannerEnvironmentSkillSeedMatchesPlayer(
            seed,
            player,
            index,
            totalPlayers
          )
        );
        if (matchingSeeds.length === 0) {
          return player;
        }

        const skillResult = applyPlannerSkillSeedsToSkills({
          currentSkills: player.skills ?? [],
          seeds: matchingSeeds,
          agentKind: "environment",
          ownerTitle: `Environment Agent ${index + 1}`,
          starterDefaults,
        });
        addedCount += skillResult.addedCount;
        updatedCount += skillResult.updatedCount;
        return syncEnvironmentPlayerDerivedPrompts({
          ...player,
          skills: skillResult.skills,
        });
      }),
    };

    if (addedCount > 0) {
      appliedChanges.push(
        addedCount === 1
          ? "added an environment-agent skill"
          : `added ${addedCount} environment-agent skills`
      );
    }
    if (updatedCount > 0) {
      appliedChanges.push(
        updatedCount === 1
          ? "updated an environment-agent skill"
          : `updated ${updatedCount} environment-agent skills`
      );
    }
  }

  const toolPlacementResult = applyPlannerToolPlacementsToProject(
    nextProject,
    plan.toolPlacements
  );
  nextProject = toolPlacementResult.project;
  appliedChanges.push(...toolPlacementResult.appliedChanges);

  if (nextProject.agentConnections.length > 0) {
    let connectionPolicyEditCount = 0;
    let connectionStateEditCount = 0;
    nextProject = {
      ...nextProject,
      agentConnections: nextProject.agentConnections.map((connection) => {
        const matchingPolicyEdits = plan.canvasEdits.filter(
          (edit) =>
            edit.target === "policy" &&
            plannerEditMatchesAgentConnection(edit, connection)
        );
        const matchingStateEdits = plan.canvasEdits.filter(
          (edit) =>
            edit.target === "state" &&
            plannerEditMatchesAgentConnection(edit, connection)
        );
        if (matchingPolicyEdits.length === 0 && matchingStateEdits.length === 0) {
          return connection;
        }

        const policyEditResult =
          matchingPolicyEdits.length > 0
            ? applyCanvasEdits(
                connection.targetPolicyCanvases ?? connection.policyCanvases,
                matchingPolicyEdits
              )
            : null;
        const stateEditResult =
          matchingStateEdits.length > 0
            ? applyCanvasEdits(
                connection.targetStatePolicyCanvases,
                matchingStateEdits
              )
            : null;
        if (
          (!policyEditResult ||
            policyEditResult.appliedChanges.length === 0) &&
          (!stateEditResult || stateEditResult.appliedChanges.length === 0)
        ) {
          return connection;
        }

        if (policyEditResult?.appliedChanges.length) {
          connectionPolicyEditCount += 1;
        }
        if (stateEditResult?.appliedChanges.length) {
          connectionStateEditCount += 1;
        }
        return syncAgentConnectionDerivedPrompts({
          ...connection,
          ...(policyEditResult?.appliedChanges.length
            ? {
                targetPolicyCanvases: policyEditResult.doc,
                policyCanvases: policyEditResult.doc,
              }
            : {}),
          ...(stateEditResult?.appliedChanges.length
            ? { targetStatePolicyCanvases: stateEditResult.doc }
            : {}),
        });
      }),
    };

    if (connectionPolicyEditCount > 0) {
      appliedChanges.push(
        connectionPolicyEditCount === 1
          ? "edited an agent-connection policy canvas"
          : `edited ${connectionPolicyEditCount} agent-connection policy canvases`
      );
    }
    if (connectionStateEditCount > 0) {
      appliedChanges.push(
        connectionStateEditCount === 1
          ? "edited an agent-connection state canvas"
          : `edited ${connectionStateEditCount} agent-connection state canvases`
      );
    }
  }

  if (nextProject.environmentPlayers.length > 0) {
    let environmentPolicyEditCount = 0;
    let environmentStateEditCount = 0;
    let environmentSkillEditCount = 0;
    const totalPlayers = nextProject.environmentPlayers.length;
    nextProject = {
      ...nextProject,
      environmentPlayers: nextProject.environmentPlayers.map((player, index) => {
        const matchingEdits = plan.canvasEdits.filter((edit) =>
          plannerEditMatchesEnvironmentPlayer(edit, player, index, totalPlayers)
        );
        const environmentSkillEdits = plan.canvasEdits.filter((edit) =>
          plannerEditMatchesEnvironmentPlayerSkill(
            edit,
            player,
            index,
            totalPlayers
          )
        );
        if (matchingEdits.length === 0 && environmentSkillEdits.length === 0) {
          return player;
        }

        let nextPlayer = player;
        const environmentPolicyEdits = matchingEdits.filter(
          (edit) => edit.target === "policy"
        );
        if (environmentPolicyEdits.length > 0) {
          const policyEditResult = applyCanvasEdits(
            nextPlayer.policyCanvases,
            environmentPolicyEdits
          );
          nextPlayer = {
            ...nextPlayer,
            policyCanvases: policyEditResult.doc,
          };
          if (policyEditResult.appliedChanges.length > 0) {
            environmentPolicyEditCount += 1;
          }
        }

        const environmentStateEdits = matchingEdits.filter(
          (edit) => edit.target === "state"
        );
        if (environmentStateEdits.length > 0) {
          const stateEditResult = applyCanvasEdits(
            nextPlayer.statePolicyCanvases,
            environmentStateEdits
          );
          nextPlayer = {
            ...nextPlayer,
            statePolicyCanvases: stateEditResult.doc,
          };
          if (stateEditResult.appliedChanges.length > 0) {
            environmentStateEditCount += 1;
          }
        }

        if (environmentSkillEdits.length > 0) {
          nextPlayer = {
            ...nextPlayer,
            skills: (nextPlayer.skills ?? []).map((skill) => {
              const matchingEdits = environmentSkillEdits.filter((edit) =>
                plannerEditMatchesSkill(edit, skill)
              );
              if (matchingEdits.length === 0) {
                return skill;
              }

              const skillEditResult = applyCanvasEditsToSkill(skill, matchingEdits);
              if (skillEditResult.appliedCanvasCount > 0) {
                environmentSkillEditCount += 1;
              }
              return skillEditResult.skill;
            }),
          };
        }

        return syncEnvironmentPlayerDerivedPrompts(nextPlayer);
      }),
    };

    if (environmentPolicyEditCount > 0) {
      appliedChanges.push(
        environmentPolicyEditCount === 1
          ? "edited an environment-agent policy canvas"
          : `edited ${environmentPolicyEditCount} environment-agent policy canvases`
      );
    }
    if (environmentStateEditCount > 0) {
      appliedChanges.push(
        environmentStateEditCount === 1
          ? "edited an environment-agent state canvas"
          : `edited ${environmentStateEditCount} environment-agent state canvases`
      );
    }
    if (environmentSkillEditCount > 0) {
      appliedChanges.push(
        environmentSkillEditCount === 1
          ? "edited an environment-agent skill canvas"
          : `edited ${environmentSkillEditCount} environment-agent skill canvases`
      );
    }
  }

  const primarySkillEdits = plan.canvasEdits.filter(plannerEditTargetsPrimarySkill);
  if (primarySkillEdits.length > 0) {
    let primarySkillEditCount = 0;
    nextProject = {
      ...nextProject,
      skills: (nextProject.skills ?? []).map((skill) => {
        const matchingEdits = primarySkillEdits.filter((edit) =>
          plannerEditMatchesSkill(edit, skill)
        );
        if (matchingEdits.length === 0) {
          return skill;
        }

        const skillEditResult = applyCanvasEditsToSkill(skill, matchingEdits);
        if (skillEditResult.appliedCanvasCount > 0) {
          primarySkillEditCount += 1;
        }
        return skillEditResult.skill;
      }),
    };

    if (primarySkillEditCount > 0) {
      appliedChanges.push(
        primarySkillEditCount === 1
          ? "edited a top-level legacy skill canvas"
          : `edited ${primarySkillEditCount} top-level legacy skill canvases`
      );
    }
  }

  if (policyCanvasEdits.length > 0) {
    const policyEditResult = applyCanvasEdits(
      nextProject.policyCanvases,
      policyCanvasEdits
    );
    nextProject = {
      ...nextProject,
      policyCanvases: policyEditResult.doc,
    };
    if (policyEditResult.appliedChanges.length > 0) {
      appliedChanges.push("edited the policy canvas");
    }
  }

  if (stateCanvasEdits.length > 0) {
    const stateEditResult = applyCanvasEdits(
      nextProject.statePolicyCanvases,
      stateCanvasEdits
    );
    nextProject = {
      ...nextProject,
      statePolicyCanvases: stateEditResult.doc,
    };
    if (stateEditResult.appliedChanges.length > 0) {
      appliedChanges.push("edited the state canvas");
    }
  }

  return {
    project: nextProject,
    appliedChanges,
    effectiveGeneralDescription,
    effectiveStatus,
  };
}

async function scaffoldPlannerToolsIntoProject(args: {
  openai: OpenAI;
  project: OrchestrationProject;
  plan: PlannerResult;
  runtimeConfig: DaemonRuntimeConfig;
  daemonState: Record<string, unknown> | null;
}): Promise<{
  project: OrchestrationProject;
  appliedChanges: string[];
}> {
  const uncoveredToolRequests = filterToolRequestsAlreadyCoveredByProject(
    args.project,
    args.plan.toolRequests
  );

  if (uncoveredToolRequests.length === 0) {
    return {
      project: args.project,
      appliedChanges: [],
    };
  }

  const toolBlueprints = await synthesizeTools(
    args.openai,
    args.project,
    uncoveredToolRequests,
    args.runtimeConfig,
    args.daemonState
  );
  if (toolBlueprints.length === 0) {
    return {
      project: args.project,
      appliedChanges: [],
    };
  }

  let datasets = args.project.datasets;
  for (const blueprint of toolBlueprints) {
    datasets = ensureDatasetForTool(datasets, blueprint);
  }

  const toolAppendResult = appendToolCanvases(
    getRuntimePolicyCanvasDoc(args.project.policyCanvases),
    toolBlueprints
  );

  const appliedChanges =
    toolAppendResult.addedToolNames.length > 0
      ? [
          `scaffolded tool capabilities: ${toolAppendResult.addedToolNames.join(", ")}`,
        ]
      : [];

  return {
    project: {
      ...args.project,
      datasets,
      policyCanvases: toolAppendResult.doc,
    },
    appliedChanges,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody;
    if (!body || !Array.isArray(body.messages) || !body.project) {
      return NextResponse.json(
        { error: "Expected `messages` and `project` in the request body." },
        { status: 400 }
      );
    }

    const messages = body.messages.filter(
      (message): message is OrchestrationMessage =>
        !!message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string"
    );
    const draftMessages = body.messages
      .filter(
        (message): message is OrchestrationMessage & { id?: string } =>
          !!message &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string"
      )
      .map((message) => ({
        id: typeof message.id === "string" && message.id.trim() ? message.id : makeOrchestrationId(),
        role: message.role,
        content: message.content,
      }));
    if (messages.length === 0) {
      return NextResponse.json(
        { error: "At least one chat message is required." },
        { status: 400 }
      );
    }

    const openai = new OpenAI({ apiKey: resolveOpenAiApiKey() });
    const runtimeConfig = await loadDaemonRuntimeConfig();
    const userUUID = await getRequestUserUUID();
    const supabase = userUUID ? createSupabaseAdminClient() : null;
    let persistedDaemonState: Record<string, unknown> | null = null;
    const requestDaemonState =
      body.daemonState &&
      typeof body.daemonState === "object" &&
      !Array.isArray(body.daemonState)
        ? normalizeDaemonOpenQuestionsState(
            body.daemonState as Record<string, unknown>
          )
        : null;

    if (supabase && userUUID && typeof body.draftId === "string" && body.draftId.trim()) {
      try {
        persistedDaemonState = await loadDaemonDraftState(
          supabase,
          userUUID,
          body.draftId.trim()
        );
        if (persistedDaemonState) {
          persistedDaemonState = normalizeDaemonOpenQuestionsState(
            persistedDaemonState
          );
        }
      } catch (loadStateError) {
        console.error(
          "[general-orchestration-daemon] failed to load persisted daemon state:",
          loadStateError
        );
      }
    }

    const startingDaemonState =
      requestDaemonState || persistedDaemonState
        ? {
            ...(persistedDaemonState ?? {}),
            ...(requestDaemonState ?? {}),
          }
        : null;
    const activeWorkflowStageForTurn =
      resolveDaemonWorkflowStageId(startingDaemonState);
    const project = ensureDaemonConversationProject(body.project);
    const canvasTrace: DaemonCanvasTraceEvent[] = [];

    const stateRuntimeConfig = scopeDaemonRuntimeConfigToWorkflowStage(
      runtimeConfig,
      startingDaemonState
    );
    const derivedDaemonState = await deriveDaemonConversationState(
      openai,
      stateRuntimeConfig,
      project,
      messages,
      startingDaemonState,
      canvasTrace
    );
    const daemonState = derivedDaemonState;
    const policyDaemonState = {
      ...(daemonState ?? {}),
      [DAEMON_WORKFLOW_STAGE_FIELD_NAME]: activeWorkflowStageForTurn,
    };
    const policyRuntimeConfig = scopeDaemonRuntimeConfigToWorkflowStage(
      runtimeConfig,
      policyDaemonState
    );
    const workflow = await runPlanner(
      openai,
      project,
      messages,
      policyRuntimeConfig,
      policyDaemonState,
      canvasTrace
    );
    const {
      project: workflowProject,
      appliedChanges: workflowAppliedChanges,
      assistantMessage: initialAssistantMessage,
      daemonState: nextDaemonState,
      stageHandoff,
    } = workflow;
    let nextProject = workflowProject;
    let responseDaemonState = nextDaemonState;
    const appliedChanges = [...workflowAppliedChanges];
    const assistantMessageParts = initialAssistantMessage.trim()
      ? [initialAssistantMessage.trim()]
      : [];
    const immediatePolicyMessages: OrchestrationMessage[] = [...messages];
    if (initialAssistantMessage.trim()) {
      immediatePolicyMessages.push({
        role: "assistant",
        content: initialAssistantMessage.trim(),
      });
    }
    const syncProjectAfterPolicyRun = async () => {
      const projectWithMigratedSourceCanvases =
        moveLegacyPrimaryCanvasDefaultsToSourceConnections(nextProject);
      if (projectWithMigratedSourceCanvases !== nextProject) {
        nextProject = projectWithMigratedSourceCanvases;
        appliedChanges.push(
          "moved legacy primary canvases into primary per-connection canvases"
        );
      }

      try {
        const materializedProject =
          await materializePrimarySourceConnectionTemplateDefaults({
            project: nextProject,
            supabase,
          });
        nextProject = materializedProject.project;
        appliedChanges.push(...materializedProject.appliedChanges);
      } catch (materializeError) {
        console.error(
          "[general-orchestration-daemon] failed to initialize primary source canvases from template:",
          materializeError
        );
      }
    };

    await syncProjectAfterPolicyRun();

    responseDaemonState = reconcileDaemonStateWithProject({
      daemonState: responseDaemonState,
      project: nextProject,
      preserveWorkflowStage: true,
    });
    let currentStageHandoff: PolicyStageHandoff | null = stageHandoff ?? null;
    responseDaemonState = applyPolicyStageHandoffToDaemonState(
      responseDaemonState,
      currentStageHandoff
    );

    let immediateStageHandoffs = 0;
    while (
      currentStageHandoff?.mode === "immediate" &&
      immediateStageHandoffs < MAX_IMMEDIATE_DAEMON_STAGE_HANDOFFS
    ) {
      immediateStageHandoffs += 1;
      const scopedImmediateRuntimeConfig = scopeDaemonRuntimeConfigToWorkflowStage(
        runtimeConfig,
        responseDaemonState
      );
      responseDaemonState = await executeImmediateDaemonStageState(
        openai,
        scopedImmediateRuntimeConfig,
        nextProject,
        responseDaemonState,
        canvasTrace
      );
      responseDaemonState = reconcileDaemonStateWithProject({
        daemonState: responseDaemonState,
        project: nextProject,
        preserveWorkflowStage: true,
      });
      appliedChanges.push(
        "executed immediate daemon workflow stage state transition"
      );

      const immediateWorkflow = await runPlanner(
        openai,
        nextProject,
        immediatePolicyMessages,
        scopedImmediateRuntimeConfig,
        responseDaemonState,
        canvasTrace
      );
      nextProject = immediateWorkflow.project;
      responseDaemonState = immediateWorkflow.daemonState;
      appliedChanges.push(...immediateWorkflow.appliedChanges);
      if (immediateWorkflow.assistantMessage.trim()) {
        const immediateAssistantMessage =
          immediateWorkflow.assistantMessage.trim();
        assistantMessageParts.push(immediateAssistantMessage);
        immediatePolicyMessages.push({
          role: "assistant",
          content: immediateAssistantMessage,
        });
      }

      await syncProjectAfterPolicyRun();
      responseDaemonState = reconcileDaemonStateWithProject({
        daemonState: responseDaemonState,
        project: nextProject,
        preserveWorkflowStage: true,
      });
      currentStageHandoff = immediateWorkflow.stageHandoff ?? null;
      responseDaemonState = applyPolicyStageHandoffToDaemonState(
        responseDaemonState,
        currentStageHandoff
      );
    }

    if (currentStageHandoff?.mode === "immediate") {
      appliedChanges.push(
        "stopped immediate daemon workflow stage handoff chain at safety limit"
      );
    }

    const assistantMessage = assistantMessageParts.join("\n\n");

    const persistedAssistantMessageId =
      typeof body.assistantMessageId === "string" && body.assistantMessageId.trim()
        ? body.assistantMessageId.trim()
        : makeOrchestrationId();

    await writeDaemonCanvasTraceLog({
      runtimeConfig,
      draftId:
        typeof body.draftId === "string" && body.draftId.trim()
          ? body.draftId.trim()
          : undefined,
      assistantMessageId: persistedAssistantMessageId,
      projectBefore: project,
      projectAfter: nextProject,
      latestUserMessage: getLatestUserMessage(messages),
      assistantMessage,
      appliedChanges,
      canvasTrace,
    });

    let responseProject = nextProject;
    if (userUUID && typeof body.draftId === "string" && body.draftId.trim()) {
      try {
        const savedDraft = await saveDaemonDraft({
          supabase: supabase ?? createSupabaseAdminClient(),
          userUUID,
          draftId: body.draftId.trim(),
          project: nextProject,
          daemonState: responseDaemonState,
          interactionMode: normalizeRequestInteractionMode(body.interactionMode),
          messages: [
            ...draftMessages,
            {
              id: persistedAssistantMessageId,
              role: "assistant",
              content: assistantMessage,
            },
          ],
        });
        if (savedDraft?.project) {
          responseProject = savedDraft.project;
        }
      } catch (persistError) {
        console.error("[general-orchestration-daemon] failed to persist draft:", persistError);
      }
    }

    return NextResponse.json({
      assistantMessage,
      project: responseProject,
      daemonState: responseDaemonState,
      appliedChanges,
      canvasTrace,
    });
  } catch (error) {
    console.error("[general-orchestration-daemon] route error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "General Orchestration Daemon failed to process the request.",
      },
      { status: 500 }
    );
  }
}
