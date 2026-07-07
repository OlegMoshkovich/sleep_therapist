import { compileCanvas } from "@airlab/canvas-compiler/compiler";
import { compileStateExtractionPrompt } from "@airlab/canvas-compiler/stateCompiler";
import type {
  CanvasDoc,
  CanvasEdgeRecord,
  CanvasEntry,
  CanvasNodeRecord,
} from "@airlab/canvas-compiler/types";
import { normalizeCanvasDoc } from "@airlab/canvas-compiler/types";
import { NODE_EXECUTABLE_CODE_OPS_DATA_KEY } from "@airlab/canvas-core/lib/canvas-node-code-ops";
import {
  NODE_EXECUTABLE_CODE_LANGUAGE_DATA_KEY,
  NODE_EXECUTABLE_CODE_LOCAL_OUTPUTS_DATA_KEY,
  NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY,
} from "@airlab/canvas-core/lib/canvas-node-code-script";
import { NODE_LOCAL_INPUTS_DATA_KEY } from "@airlab/canvas-core/lib/canvas-node-local-fields";
import type {
  SimulationPlayerDataset,
  SimulationPlayerDatasetColumn,
  SimulationPlayerDatasetColumnType,
  SimulationPlayerDatasetRecord,
} from "@airlab/canvas-core/components/setup/dataset-schema";
import { autoTagCanvasActionSubtypes } from "@airlab/canvas-rules/canvas-code-action-autotag";
import type { RuntimeStateField } from "@airlab/canvas-planner/canvas-hybrid-runtime";
// Type-only import: interaction-protocol.ts imports value constants from this
// module, so importing values back would create a runtime cycle.
import type { InteractionProtocolConfig } from "./interaction-protocol";
import { collectCanvasRuleDiagnosticsForDoc } from "@airlab/canvas-rules/canvas-rule-diagnostics";
import type { CanvasRuleDefinition } from "@airlab/canvas-core/lib/canvas-rule-registry";
import { parseConditionLabel } from "@airlab/canvas-planner/canvas-structural-planner";
import {
  CONVERSATION_SUMMARY_FIELD_NAME,
  DEFAULT_CONVERSATION_MEMORY_LIMIT,
  LEGACY_NEW_CONVERSATIONS_FIELD_NAME,
  NEW_EVENTS_FIELD_NAME,
} from "@airlab/canvas-core/lib/conversation-memory";
import {
  AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME,
  AGENT_LATEST_REWARD_PROMPT_VALUE_NAME,
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
} from "@airlab/canvas-core/lib/canvas-flow-values";
import {
  splitProjectDatasets,
} from "./external-episodes";
import { collectAvailableCanvasLocalValueNames } from "@airlab/canvas-core/lib/canvas-local-dataflow";

const MEMORY_OVER_LIMIT_LOCAL_NAME = "memory_over_limit";

export type OrchestrationFieldType =
  | "string"
  | "integer"
  | "boolean"
  | "string[]"
  | "number"
  | "json";

export const ORCHESTRATION_FIELD_TYPES: OrchestrationFieldType[] = [
  "string",
  "integer",
  "boolean",
  "string[]",
  "number",
  "json",
];

export const PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME = "agent_latest_observation";
export const PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME = "agent_latest_reward";
export const PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME = "agent_latest_action";
const LEGACY_ENVIRONMENT_LATEST_OBSERVATION_FIELD_NAME =
  "environment_latest_observation";
const LEGACY_ENVIRONMENT_LATEST_ACTION_FIELD_NAME = "environment_latest_action";
export const REQUIRED_PRIMARY_AGENT_STATE_FIELD_NAMES = [
  CONVERSATION_SUMMARY_FIELD_NAME,
  NEW_EVENTS_FIELD_NAME,
  PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
  PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
] as const;
export const REQUIRED_ENVIRONMENT_AGENT_STATE_FIELD_NAMES = [
  CONVERSATION_SUMMARY_FIELD_NAME,
  NEW_EVENTS_FIELD_NAME,
  PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
  PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
] as const;

const LATEST_OBSERVATION_AND_REWARD_EVENT_LABEL =
  "Add agent_latest_observation and agent_latest_reward to new_events.";

export interface OrchestrationField {
  id: string;
  name: string;
  type: OrchestrationFieldType;
  initialValue: string;
}

export interface OrchestrationGuidelineBlock {
  id: string;
  topic: string;
  content: string;
  problem: string;
  recommendation: string;
}

export interface OrchestrationUploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  bucket?: string;
  path?: string;
  url?: string;
  isObjectUrl?: boolean;
  uploaded_by_email?: string | null;
  uploaded_by_uuid?: string;
  uploaded_at?: string;
}

export interface OrchestrationSkill {
  id: string;
  name: string;
  startConditionCanvases: CanvasDoc | null;
  policyPrompt: string;
  policyCanvases: CanvasDoc | null;
  terminationConditionCanvases: CanvasDoc | null;
}

export interface OrchestrationProjectMeta {
  title: string;
  slug: string;
  summary: string;
  policyIntent: string;
  status: string;
}

export interface OrchestrationEnvironmentPlayer {
  id: string;
  fields: OrchestrationField[];
  stateUpdatePrompt: string;
  policyPrompt: string;
  policyCanvases: CanvasDoc | null;
  statePolicyCanvases: CanvasDoc | null;
  skills: OrchestrationSkill[];
  guidelines: OrchestrationGuidelineBlock[];
  datasets: SimulationPlayerDataset[];
  uploadedFiles: OrchestrationUploadedFile[];
}

export type OrchestrationAgentConnectionInvocationMode = "sync" | "async";

export interface OrchestrationAgentConnection {
  id: string;
  /** Optional workflow stage this pairwise connection belongs to. */
  workflowStageId?: string;
  workflowStageName?: string;
  /**
   * Stable identity for the target agent across multiple stage-scoped
   * connections. targetAgentId may be stage-scoped for runtime selection.
   */
  targetAgentSharedId?: string;
  /**
   * Stable ID for the agent represented by this draft. For daemon-created
   * drafts this is persisted separately from the database row id so other
   * agents can reference it before or after publication.
   */
  sourceAgentId: string;
  /** ID of another daemon-created agent this agent is allowed to interact with. */
  targetAgentId: string;
  /** Optional display label for the target agent ID. */
  targetAgentTitle: string;
  /** Short description of what this pairwise interaction is for. */
  purpose: string;
  invocationMode: OrchestrationAgentConnectionInvocationMode;
  /** How the source agent behaves in this specific relationship. */
  sourcePolicyPrompt: string;
  sourcePolicyCanvases: CanvasDoc | null;
  sourceStateUpdatePrompt: string;
  sourceStatePolicyCanvases: CanvasDoc | null;
  /** How reward is assigned to the target after sourceAgentId acts. */
  sourceRewardPrompt: string;
  sourceRewardCanvases: CanvasDoc | null;
  /** How the target agent behaves in this specific relationship. */
  targetPolicyPrompt: string;
  targetPolicyCanvases: CanvasDoc | null;
  targetStateUpdatePrompt: string;
  targetStatePolicyCanvases: CanvasDoc | null;
  /** How reward is assigned to the source after targetAgentId acts. */
  targetRewardPrompt: string;
  targetRewardCanvases: CanvasDoc | null;
  /** Target-agent reusable/default config for this connected agent. */
  targetFields: OrchestrationField[];
  targetSkills: OrchestrationSkill[];
  targetDatasets: SimulationPlayerDataset[];
  targetUploadedFiles: OrchestrationUploadedFile[];
  /**
   * Legacy ambiguous connection policy. During migration this is kept for old
   * drafts and serialized compatibility, but new UI/runtime paths use the
   * explicit source/target participant policy fields above.
   */
  policyPrompt: string;
  policyCanvases: CanvasDoc | null;
}

export interface OrchestrationProjectAgentBinding {
  /** Project-local handle for this agent inside the project graph. */
  id: string;
  /** Reusable catalog template identity. */
  templateId: string;
  /** Exact catalog version used by this project binding. */
  templateVersionId: string;
  /** Optional project-specific display alias. */
  title: string;
  /** Project-specific role/context layered on top of the template defaults. */
  roleContext: string;
  fieldOverrides: OrchestrationField[];
  datasetOverrides: SimulationPlayerDataset[];
  uploadedFileOverrides: OrchestrationUploadedFile[];
  skillOverrides: OrchestrationSkill[];
  policyCanvasesOverride: CanvasDoc | null;
  statePolicyCanvasesOverride: CanvasDoc | null;
}

export interface OrchestrationProject {
  id: string;
  /** Stable multi-agent ecosystem id for this daemon-created target agent. */
  agentId: string;
  meta: OrchestrationProjectMeta;
  fields: OrchestrationField[];
  stateUpdatePrompt: string;
  policyPrompt: string;
  workflowCanvases: CanvasDoc | null;
  policyCanvases: CanvasDoc | null;
  statePolicyCanvases: CanvasDoc | null;
  skills: OrchestrationSkill[];
  guidelines: OrchestrationGuidelineBlock[];
  /** The primary agent's own datasets, edited in the primary agent's card. */
  datasets: SimulationPlayerDataset[];
  /**
   * Draft-wide shared datasets. Every agent (primary and environment) resolves
   * dataset names against its own datasets first, then falls back to these.
   */
  sharedDatasets: SimulationPlayerDataset[];
  uploadedFiles: OrchestrationUploadedFile[];
  /**
   * Catalog-backed project agents. This is additive during migration: legacy
   * top-level primary-agent fields and environmentPlayers still hydrate/save.
   */
  agents: OrchestrationProjectAgentBinding[];
  /**
   * Pairwise interaction contracts from this primary agent to other agents.
   * Each connection can carry participant-specific project behavior for both
   * sourceAgentId -> targetAgentId and targetAgentId -> sourceAgentId.
   */
  agentConnections: OrchestrationAgentConnection[];
  environmentPlayers: OrchestrationEnvironmentPlayer[];
  /**
   * Editable interaction-protocol strings the simulate/live-session routes
   * inject around the canvases. Draft load/create paths materialize seed
   * defaults here so run routes can require explicit, visible contract fields.
   */
  interactionProtocol?: InteractionProtocolConfig;
}

export interface OrchestrationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SuggestedField {
  name: string;
  type: OrchestrationFieldType;
  initialValue?: string;
}

export interface SuggestedGuideline {
  topic: string;
  content?: string;
  problem?: string;
  recommendation?: string;
}

export type OrchestrationGuidelineEditOp =
  | "clear_all"
  | "replace_all"
  | "delete"
  | "upsert";

export interface OrchestrationGuidelineEdit {
  op: OrchestrationGuidelineEditOp;
  topic?: string;
  content?: string;
  problem?: string;
  recommendation?: string;
  guidelines?: SuggestedGuideline[];
}

export interface SuggestedDatasetColumn {
  name: string;
  type: SimulationPlayerDatasetColumnType;
}

export interface SuggestedDataset {
  name: string;
  notes?: string;
  columns: SuggestedDatasetColumn[];
  exampleRecords?: Array<Record<string, unknown>>;
}

export type ToolBlueprintSourceType =
  | "http"
  | "rss"
  | "page"
  | "web_search"
  | "knowledge_save"
  | "dataset_read";

export interface ToolBlueprintParam {
  name: string;
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
}

export interface ToolBlueprint {
  capability: string;
  whenToCall: string;
  toolName: string;
  description: string;
  sourceType: ToolBlueprintSourceType;
  url?: string;
  params?: ToolBlueprintParam[];
  promoteToKnowledge?: boolean;
  saveTarget?: "knowledge" | "dataset";
  datasetName?: string;
  notes?: string;
}

export type CanvasEditTarget = "policy" | "state" | "workflow";
export type CanvasEditAgentTarget = "primary" | "environment" | "both";
export type CanvasEditSkillCanvasTarget =
  | "policy"
  | "start_condition"
  | "termination_condition";

export interface OrchestrationCanvasNodeRef {
  nodeKey?: string;
  id?: string;
  type?: string;
  actionType?: string;
  labelEquals?: string;
  labelContains?: string;
  toolName?: string;
}

export type OrchestrationCanvasEditOp =
  | "add_canvas"
  | "rename_canvas"
  | "set_canvas_notes"
  | "set_active_canvas"
  | "add_node"
  | "insert_node_before"
  | "insert_node_after"
  | "update_node"
  | "delete_node"
  | "add_edge"
  | "update_edge"
  | "delete_edge";

export interface OrchestrationCanvasEdit {
  target: CanvasEditTarget;
  op: OrchestrationCanvasEditOp;
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
  canvasId?: string;
  canvasName?: string;
  nextName?: string;
  notes?: string;
  nodeKey?: string;
  nodeType?: string;
  label?: string;
  x?: number;
  y?: number;
  data?: Record<string, unknown>;
  nodeRef?: OrchestrationCanvasNodeRef;
  sourceRef?: OrchestrationCanvasNodeRef;
  targetRef?: OrchestrationCanvasNodeRef;
  edgeId?: string;
  sourceHandle?: string | null;
  edgeLabel?: string;
}

export interface PolicySeed {
  canvasName: string;
  generalPrompt: string;
  clarificationGate: string;
  clarificationActions: string[];
  executionActions: string[];
  responseRule: string;
  notes?: string;
}

export const DEFAULT_POLICY_CLARIFICATION_GATE_LABEL =
  "the user's request, constraints, or required inputs are still unclear";

const DEFAULT_POLICY_SEED: PolicySeed = {
  canvasName: "Main policy",
  generalPrompt:
    "Collaboratively shape the target demo policy from the current state. Keep the editable setup on the right synchronized with what the user says.",
  clarificationGate: DEFAULT_POLICY_CLARIFICATION_GATE_LABEL,
  clarificationActions: [
    "Ask one focused follow-up question about goals, constraints, or success criteria.",
    "Prefer narrowing ambiguity before committing to detailed policy logic.",
  ],
  executionActions: [
    "Apply the current policy, state schema, datasets, and guidelines.",
    "Reflect meaningful new requirements back into the editable setup.",
  ],
  responseRule: "reply with the next best step and keep the system coherent",
  notes:
    "The daemon should keep policy, state, and datasets aligned. By default, policy should read the current state, especially summary and new_events, rather than a separate raw transcript. After deciding on the assistant reply, write that finalized assistant turn into new_events inside the policy execution flow. If a capability is missing, scaffold it rather than ignoring it.",
};

const PROMPTISH_CLARIFICATION_GATE_PREFIX =
  /^(proceed|continue|respond|reply|act|apply|use|follow|maintain|produce|simulate|help|guide|keep|ask|clarify)\b/i;

function looksLikePromptishClarificationGate(label: string): boolean {
  const trimmed = label.trim().replace(/[.!?]+$/g, "").trim();
  if (!trimmed) {
    return false;
  }

  const normalized = trimmed.toLowerCase();
  if (/(^|[\s,(])(if|when|whether|unless)\b/.test(normalized)) {
    return false;
  }

  if (
    /^(is|are|has|have|one or more|summary plus|prompt\s+\S+\s+(is|has)|[a-z0-9_]+\s+(is|has))\b/.test(
      normalized
    )
  ) {
    return false;
  }

  return (
    normalized.startsWith("by default") ||
    normalized.includes(" by default") ||
    PROMPTISH_CLARIFICATION_GATE_PREFIX.test(trimmed)
  );
}

export function normalizePolicySeedClarificationGate(
  label: string | null | undefined,
  fallbackLabel = DEFAULT_POLICY_CLARIFICATION_GATE_LABEL
): {
  gateLabel: string;
  prefacePromptLabel: string | null;
} {
  const trimmed = label?.trim() ?? "";
  const normalizedFallback = fallbackLabel.trim() || DEFAULT_POLICY_CLARIFICATION_GATE_LABEL;
  if (!trimmed) {
    return {
      gateLabel: normalizedFallback,
      prefacePromptLabel: null,
    };
  }

  if (!looksLikePromptishClarificationGate(trimmed)) {
    return {
      gateLabel: trimmed,
      prefacePromptLabel: null,
    };
  }

  return {
    gateLabel: normalizedFallback,
    prefacePromptLabel: trimmed,
  };
}

function base36Id(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function makeOrchestrationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : base36Id();
}

export function createConversationMemoryFields(): OrchestrationField[] {
  return [
    {
      id: makeOrchestrationId(),
      name: CONVERSATION_SUMMARY_FIELD_NAME,
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: NEW_EVENTS_FIELD_NAME,
      type: "json",
      initialValue: "[]",
    },
  ];
}

export function createRequiredPrimaryAgentStateFieldSuggestions(args?: {
  observationType?: OrchestrationFieldType;
  actionType?: OrchestrationFieldType;
}): SuggestedField[] {
  return [
    {
      name: PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
      type: args?.observationType ?? "string",
      initialValue: "",
    },
    {
      name: PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
      type: "number",
      initialValue: "null",
    },
    {
      name: PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
      type: args?.actionType ?? "string",
      initialValue: "",
    },
  ];
}

export function createRequiredEnvironmentAgentStateFieldSuggestions(args?: {
  observationType?: OrchestrationFieldType;
  actionType?: OrchestrationFieldType;
}): SuggestedField[] {
  return createRequiredPrimaryAgentStateFieldSuggestions(args);
}

export function normalizeLatestInteractionStateFields(
  fields: OrchestrationField[]
): OrchestrationField[] {
  const canonicalNames = new Set(
    fields.map((field) => normalizeKey(field.name)).filter(Boolean)
  );

  return fields.flatMap((field) => {
    const normalizedName = normalizeKey(field.name);
    if (
      normalizedName === normalizeKey(PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME)
    ) {
      return [
        {
          ...field,
          name: PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
          type: "number",
          initialValue: field.initialValue.trim() || "null",
        },
      ];
    }

    if (
      normalizedName ===
      normalizeKey(LEGACY_ENVIRONMENT_LATEST_OBSERVATION_FIELD_NAME)
    ) {
      return canonicalNames.has(
        normalizeKey(PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME)
      )
        ? []
        : [
            {
              ...field,
              name: PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
            },
          ];
    }

    if (
      normalizedName === normalizeKey(LEGACY_ENVIRONMENT_LATEST_ACTION_FIELD_NAME)
    ) {
      return canonicalNames.has(
        normalizeKey(PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME)
      )
        ? []
        : [
            {
              ...field,
              name: PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
            },
          ];
    }

    return [field];
  });
}

export function ensureConversationMemoryFields(
  fields: OrchestrationField[]
): OrchestrationField[] {
  const normalizedLatestFields = normalizeLatestInteractionStateFields(fields);
  const nextFields = normalizedLatestFields.filter(
    (field) => normalizeKey(field.name) !== normalizeKey(LEGACY_NEW_CONVERSATIONS_FIELD_NAME)
  );
  const normalizedNames = new Set(
    nextFields.map((field) => normalizeKey(field.name)).filter(Boolean)
  );

  if (!normalizedNames.has(normalizeKey(CONVERSATION_SUMMARY_FIELD_NAME))) {
    nextFields.unshift({
      id: makeOrchestrationId(),
      name: CONVERSATION_SUMMARY_FIELD_NAME,
      type: "string",
      initialValue: "",
    });
  }

  if (!normalizedNames.has(normalizeKey(NEW_EVENTS_FIELD_NAME))) {
    const insertIndex = nextFields.findIndex(
      (field) => normalizeKey(field.name) === normalizeKey(CONVERSATION_SUMMARY_FIELD_NAME)
    );
    nextFields.splice(insertIndex >= 0 ? insertIndex + 1 : 0, 0, {
      id: makeOrchestrationId(),
      name: NEW_EVENTS_FIELD_NAME,
      type: "json",
      initialValue: "[]",
    });
  }

  return nextFields;
}

export function ensureRequiredPrimaryAgentStateFields(
  fields: OrchestrationField[],
  args?: {
    observationType?: OrchestrationFieldType;
    actionType?: OrchestrationFieldType;
  }
): OrchestrationField[] {
  const withConversationMemory = ensureConversationMemoryFields(fields);
  return mergeSuggestedFields(
    withConversationMemory,
    createRequiredPrimaryAgentStateFieldSuggestions(args)
  );
}

export function ensureRequiredEnvironmentAgentStateFields(
  fields: OrchestrationField[],
  args?: {
    observationType?: OrchestrationFieldType;
    actionType?: OrchestrationFieldType;
  }
): OrchestrationField[] {
  const withConversationMemory = ensureConversationMemoryFields(fields);
  return mergeSuggestedFields(
    withConversationMemory,
    createRequiredEnvironmentAgentStateFieldSuggestions(args)
  );
}

export function findOrchestrationFieldByCanonicalName(
  fields: OrchestrationField[],
  canonicalFieldName: string
): OrchestrationField | undefined {
  return fields.find(
    (field) => field.name.trim().toLowerCase() === canonicalFieldName
  );
}

export function getMissingInteractionFieldIssues(
  fields: OrchestrationField[],
  ...fieldNames: string[]
): string[] {
  return fieldNames.flatMap((fieldName) => {
    const field = findOrchestrationFieldByCanonicalName(fields, fieldName);
    return field ? [] : [`The required state field "${fieldName}" is missing.`];
  });
}

export function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || "untitled-setup";
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]+/g, " ");
}

function titleCaseFromSlug(value: string): string {
  return value
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function truncatePromptText(value: string, maxLength = 220): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export const WORKFLOW_OVERVIEW_CANVAS_NAME = "Overall Workflow";
export const WORKFLOW_OVERVIEW_CANVAS_MARKER = "airlab:workflow-overview";
const WORKFLOW_STAGE_HANDLE_SLOT_PATTERNS = [
  [2],
  [1, 3],
  [0, 2, 4],
  [0, 1, 3, 4],
  [0, 1, 2, 3, 4],
];

export type WorkflowStageTransitionDirection = "forward" | "loop";

export interface WorkflowStageEdgeHandleAssignment {
  sourceHandle: string;
  targetHandle: string;
  isLoopReturn: boolean;
}

export function getWorkflowStageHandleSlot(
  ordinal: number,
  total: number
): number {
  const slotPattern =
    WORKFLOW_STAGE_HANDLE_SLOT_PATTERNS[
      Math.min(Math.max(total, 1), WORKFLOW_STAGE_HANDLE_SLOT_PATTERNS.length) -
        1
    ] ?? WORKFLOW_STAGE_HANDLE_SLOT_PATTERNS.at(-1) ?? [2];
  return slotPattern[Math.max(0, ordinal) % slotPattern.length] ?? 2;
}

export function getWorkflowStageSourceHandleId(
  direction: WorkflowStageTransitionDirection,
  slot: number
): string {
  return direction === "loop"
    ? `workflow-loop-${slot}`
    : `workflow-next-${slot}`;
}

export function getWorkflowStageTargetHandleId(
  direction: WorkflowStageTransitionDirection,
  slot: number
): string {
  return direction === "loop"
    ? `workflow-loop-target-${slot}`
    : `workflow-previous-${slot}`;
}

export function getWorkflowStageEdgeHandleAssignments(
  edges: Array<Pick<CanvasEdgeRecord, "source" | "target">>,
  stageIndexByNodeId: Map<string, number>
): Map<number, WorkflowStageEdgeHandleAssignment> {
  const records: Array<{
    index: number;
    source: string;
    target: string;
    direction: WorkflowStageTransitionDirection;
  }> = [];

  edges.forEach((edge, index) => {
    const sourceIndex = stageIndexByNodeId.get(edge.source);
    const targetIndex = stageIndexByNodeId.get(edge.target);
    if (typeof sourceIndex !== "number" || typeof targetIndex !== "number") {
      return;
    }

    records.push({
      index,
      source: edge.source,
      target: edge.target,
      direction: targetIndex <= sourceIndex ? "loop" : "forward",
    });
  });

  const countBySourceGroup = new Map<string, number>();
  const countByTargetGroup = new Map<string, number>();
  for (const record of records) {
    const sourceGroup = `${record.source}\u0000${record.direction}`;
    const targetGroup = `${record.target}\u0000${record.direction}`;
    countBySourceGroup.set(
      sourceGroup,
      (countBySourceGroup.get(sourceGroup) ?? 0) + 1
    );
    countByTargetGroup.set(
      targetGroup,
      (countByTargetGroup.get(targetGroup) ?? 0) + 1
    );
  }

  const seenBySourceGroup = new Map<string, number>();
  const seenByTargetGroup = new Map<string, number>();
  const assignments = new Map<number, WorkflowStageEdgeHandleAssignment>();
  for (const record of records) {
    const sourceGroup = `${record.source}\u0000${record.direction}`;
    const targetGroup = `${record.target}\u0000${record.direction}`;
    const sourceOrdinal = seenBySourceGroup.get(sourceGroup) ?? 0;
    const targetOrdinal = seenByTargetGroup.get(targetGroup) ?? 0;
    seenBySourceGroup.set(sourceGroup, sourceOrdinal + 1);
    seenByTargetGroup.set(targetGroup, targetOrdinal + 1);

    const sourceSlot = getWorkflowStageHandleSlot(
      sourceOrdinal,
      countBySourceGroup.get(sourceGroup) ?? 1
    );
    const targetSlot = getWorkflowStageHandleSlot(
      targetOrdinal,
      countByTargetGroup.get(targetGroup) ?? 1
    );

    assignments.set(record.index, {
      sourceHandle: getWorkflowStageSourceHandleId(
        record.direction,
        sourceSlot
      ),
      targetHandle: getWorkflowStageTargetHandleId(
        record.direction,
        targetSlot
      ),
      isLoopReturn: record.direction === "loop",
    });
  }

  return assignments;
}

function isWorkflowStageSourceHandle(value: string | null | undefined): boolean {
  return (
    value == null ||
    value === "workflow-next" ||
    value === "workflow-loop" ||
    /^workflow-(next|loop)-\d+$/.test(value)
  );
}

function isWorkflowStageTargetHandle(value: string | null | undefined): boolean {
  return (
    value == null ||
    value === "workflow-previous" ||
    value === "workflow-loop-target" ||
    /^workflow-(previous|loop-target)-\d+$/.test(value)
  );
}

export function isWorkflowOverviewCanvasEntry(canvas: CanvasEntry): boolean {
  return (
    normalizeKey(canvas.name) === normalizeKey(WORKFLOW_OVERVIEW_CANVAS_NAME) ||
    (canvas.freeText ?? "").includes(WORKFLOW_OVERVIEW_CANVAS_MARKER) ||
    canvas.graph.nodes.some(
      (node) =>
        node.data?.workflowOverview === true ||
        node.data?.runtimeRole === "workflow_overview"
    )
  );
}

function normalizeWorkflowOverviewCanvasEntry(canvas: CanvasEntry): CanvasEntry {
  if (!isWorkflowOverviewCanvasEntry(canvas)) {
    return canvas;
  }

  const normalizedNodes = canvas.graph.nodes.map((node) =>
    typeof node.data?.workflowStageId === "string" ||
    typeof node.data?.workflowStageName === "string" ||
    node.id.startsWith("workflow-stage-")
      ? { ...node, type: "stage" }
      : node
  );
  const stageNodeIds = new Set(
    normalizedNodes
      .filter((node) => node.type === "stage")
      .map((node) => node.id)
  );
  const stageIndexByNodeId = new Map(
    normalizedNodes
      .filter((node) => stageNodeIds.has(node.id))
      .sort(
        (left, right) =>
          left.position.x - right.position.x ||
          left.position.y - right.position.y
      )
      .map((node, index) => [node.id, index] as const)
  );
  const handleAssignments = getWorkflowStageEdgeHandleAssignments(
    canvas.graph.edges,
    stageIndexByNodeId
  );

  return {
    ...canvas,
    graph: {
      ...canvas.graph,
      nodes: normalizedNodes,
      edges: canvas.graph.edges.map((edge, index) => {
        if (!stageNodeIds.has(edge.source) || !stageNodeIds.has(edge.target)) {
          return edge;
        }

        const assignment = handleAssignments.get(index);
        if (!assignment) {
          return edge;
        }

        return {
          ...edge,
          sourceHandle: isWorkflowStageSourceHandle(edge.sourceHandle)
            ? assignment.sourceHandle
            : edge.sourceHandle,
          targetHandle: isWorkflowStageTargetHandle(edge.targetHandle)
            ? assignment.targetHandle
            : edge.targetHandle,
          label: assignment.isLoopReturn
            ? edge.label ?? "loop / return"
            : edge.label,
        };
      }),
    },
  };
}

export function getWorkflowOverviewCanvasDoc(
  doc: CanvasDoc | null | undefined
): CanvasDoc | null {
  const canvases = (doc?.canvases ?? [])
    .filter(isWorkflowOverviewCanvasEntry)
    .map(normalizeWorkflowOverviewCanvasEntry);
  if (canvases.length === 0) {
    return null;
  }
  const activeCanvas =
    canvases.find((canvas) => canvas.id === doc?.activeId) ?? canvases[0];
  return {
    version: doc?.version ?? 2,
    activeId: activeCanvas?.id ?? "",
    canvases,
  };
}

export function getRuntimePolicyCanvasDoc(
  doc: CanvasDoc | null | undefined
): CanvasDoc | null {
  if (!doc) {
    return null;
  }
  const canvases = doc.canvases.filter(
    (canvas) => !isWorkflowOverviewCanvasEntry(canvas)
  );
  if (canvases.length === 0) {
    return null;
  }
  const activeCanvas =
    canvases.find((canvas) => canvas.id === doc.activeId) ?? canvases[0];
  return {
    ...doc,
    activeId: activeCanvas?.id ?? "",
    canvases,
  };
}

export function getProjectWorkflowCanvasDoc(
  project: Pick<OrchestrationProject, "workflowCanvases" | "policyCanvases">
): CanvasDoc | null {
  return (
    getWorkflowOverviewCanvasDoc(project.workflowCanvases) ??
    getWorkflowOverviewCanvasDoc(project.policyCanvases)
  );
}

export function upsertWorkflowOverviewCanvasDoc(
  policyDoc: CanvasDoc | null | undefined,
  workflowDoc: CanvasDoc | null | undefined
): CanvasDoc | null {
  const runtimeCanvases = (policyDoc?.canvases ?? []).filter(
    (canvas) => !isWorkflowOverviewCanvasEntry(canvas)
  );
  const workflowCanvases = (workflowDoc?.canvases ?? []).filter(
    isWorkflowOverviewCanvasEntry
  ).map(normalizeWorkflowOverviewCanvasEntry);
  const canvases = [...runtimeCanvases, ...workflowCanvases];
  if (canvases.length === 0) {
    return null;
  }
  const runtimeActive = runtimeCanvases.find(
    (canvas) => canvas.id === policyDoc?.activeId
  );
  const activeCanvas =
    runtimeActive ??
    canvases.find((canvas) => canvas.id === policyDoc?.activeId) ??
    runtimeCanvases[0] ??
    workflowCanvases[0] ??
    canvases[0];

  return {
    version: policyDoc?.version ?? workflowDoc?.version ?? 2,
    activeId: activeCanvas?.id ?? "",
    canvases,
  };
}

export function createEmptyOrchestrationProject(): OrchestrationProject {
  return {
    id: makeOrchestrationId(),
    meta: {
      title: "Untitled Setup",
      slug: "untitled-setup",
      summary: "",
      policyIntent: "",
      status: "Waiting for a general description.",
    },
    fields: createConversationMemoryFields(),
    agentId: makeOrchestrationId(),
    stateUpdatePrompt: "",
    policyPrompt: "",
    workflowCanvases: null,
    policyCanvases: null,
    statePolicyCanvases: null,
    skills: [],
    guidelines: [],
    datasets: [],
    sharedDatasets: [],
    uploadedFiles: [],
    agents: [],
    agentConnections: [],
    environmentPlayers: [],
  };
}

export function createEmptyOrchestrationAgentConnection(args: {
  sourceAgentId: string;
  targetAgentId?: string;
  targetAgentTitle?: string;
  purpose?: string;
  invocationMode?: OrchestrationAgentConnectionInvocationMode;
  sourcePolicyCanvases?: CanvasDoc | null;
  sourcePolicyPrompt?: string;
  sourceStatePolicyCanvases?: CanvasDoc | null;
  sourceStateUpdatePrompt?: string;
  sourceRewardCanvases?: CanvasDoc | null;
  sourceRewardPrompt?: string;
  targetPolicyCanvases?: CanvasDoc | null;
  targetPolicyPrompt?: string;
  targetStatePolicyCanvases?: CanvasDoc | null;
  targetStateUpdatePrompt?: string;
  targetRewardCanvases?: CanvasDoc | null;
  targetRewardPrompt?: string;
  targetFields?: OrchestrationField[];
  targetSkills?: OrchestrationSkill[];
  targetDatasets?: SimulationPlayerDataset[];
  targetUploadedFiles?: OrchestrationUploadedFile[];
  policyCanvases?: CanvasDoc | null;
  policyPrompt?: string;
}): OrchestrationAgentConnection {
  const targetDefaults = createEmptyOrchestrationEnvironmentPlayer();
  return {
    id: makeOrchestrationId(),
    sourceAgentId: args.sourceAgentId.trim(),
    targetAgentId: args.targetAgentId?.trim() ?? "",
    targetAgentTitle: args.targetAgentTitle?.trim() ?? "",
    purpose: args.purpose?.trim() ?? "",
    invocationMode: args.invocationMode ?? "sync",
    sourcePolicyPrompt: args.sourcePolicyPrompt?.trim() ?? "",
    sourcePolicyCanvases: args.sourcePolicyCanvases ?? null,
    sourceStateUpdatePrompt: args.sourceStateUpdatePrompt?.trim() ?? "",
    sourceStatePolicyCanvases: args.sourceStatePolicyCanvases ?? null,
    sourceRewardPrompt: args.sourceRewardPrompt?.trim() ?? "",
    sourceRewardCanvases: args.sourceRewardCanvases ?? null,
    targetPolicyPrompt: args.targetPolicyPrompt?.trim() ?? "",
    targetPolicyCanvases: args.targetPolicyCanvases ?? null,
    targetStateUpdatePrompt: args.targetStateUpdatePrompt?.trim() ?? "",
    targetStatePolicyCanvases: args.targetStatePolicyCanvases ?? null,
    targetRewardPrompt: args.targetRewardPrompt?.trim() ?? "",
    targetRewardCanvases: args.targetRewardCanvases ?? null,
    targetFields: args.targetFields ?? targetDefaults.fields,
    targetSkills: args.targetSkills ?? targetDefaults.skills,
    targetDatasets: args.targetDatasets ?? targetDefaults.datasets,
    targetUploadedFiles: args.targetUploadedFiles ?? targetDefaults.uploadedFiles,
    policyPrompt: args.policyPrompt?.trim() ?? "",
    policyCanvases: args.policyCanvases ?? null,
  };
}

export function createEmptyOrchestrationEnvironmentPlayer(): OrchestrationEnvironmentPlayer {
  return {
    id: makeOrchestrationId(),
    fields: ensureRequiredEnvironmentAgentStateFields(createConversationMemoryFields()),
    stateUpdatePrompt: "",
    policyPrompt: "",
    policyCanvases: null,
    statePolicyCanvases: null,
    skills: [],
    guidelines: [],
    datasets: [],
    uploadedFiles: [],
  };
}

export const GUIDELINE_ITEMS_DATASET_NAME = "guideline_items";

function normalizeDatasetName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isGuidelineItemsDatasetName(value: string): boolean {
  return normalizeDatasetName(value) === GUIDELINE_ITEMS_DATASET_NAME;
}

export function buildGuidelineItemText(
  guideline: Pick<
    OrchestrationGuidelineBlock,
    "topic" | "content" | "problem" | "recommendation"
  >
): string {
  const firstField = guideline.content.trim() || guideline.topic.trim();
  const problem = guideline.problem.trim();
  const recommendation = guideline.recommendation.trim();
  let text = firstField;

  if (problem) {
    text = text
      ? `${text}\n\n Problem description: ${problem}`
      : `Problem description: ${problem}`;
  }

  if (recommendation) {
    text = text
      ? `${text}\n\n Recommendation: ${recommendation}`
      : `Recommendation: ${recommendation}`;
  }

  return text.trim();
}

export function createGuidelineItemsDataset(
  guidelines: OrchestrationGuidelineBlock[],
  makeId: () => string
): SimulationPlayerDataset | null {
  const records = guidelines
    .map((guideline) => buildGuidelineItemText(guideline))
    .filter((item) => item.length > 0);

  if (records.length === 0) {
    return null;
  }

  const columnId = makeId();
  return {
    id: makeId(),
    name: GUIDELINE_ITEMS_DATASET_NAME,
    notes:
      "Derived text items from legacy guideline blocks. Each row concatenates the main content, problem description, and recommendation.",
    columns: [{ id: columnId, name: "text", type: "string" }],
    records: records.map((item) => ({
      id: makeId(),
      values: {
        [columnId]: item,
      },
    })),
  };
}

export function materializeGuidelineItemsDataset(
  datasets: SimulationPlayerDataset[],
  guidelines: OrchestrationGuidelineBlock[],
  makeId: () => string
): SimulationPlayerDataset[] {
  if (guidelines.length === 0) {
    return datasets;
  }

  const nextDataset = createGuidelineItemsDataset(guidelines, makeId);
  const preserved = datasets.filter(
    (dataset) => !isGuidelineItemsDatasetName(dataset.name)
  );

  return nextDataset ? [...preserved, nextDataset] : preserved;
}

export function materializeProjectGuidelineItems(project: OrchestrationProject): OrchestrationProject {
  return {
    ...project,
    guidelines: [],
    // Draft-level guidelines become a shared dataset so every agent can read
    // them; each environment player's guidelines stay on that player's own
    // datasets.
    sharedDatasets: materializeGuidelineItemsDataset(
      Array.isArray(project.sharedDatasets) ? project.sharedDatasets : [],
      Array.isArray(project.guidelines) ? project.guidelines : [],
      makeOrchestrationId
    ),
    environmentPlayers: Array.isArray(project.environmentPlayers)
      ? project.environmentPlayers.map((player) => ({
          ...player,
          guidelines: [],
          datasets: materializeGuidelineItemsDataset(
            Array.isArray(player.datasets) ? player.datasets : [],
            Array.isArray(player.guidelines) ? player.guidelines : [],
            makeOrchestrationId
          ),
        }))
      : [],
  };
}

function createNode(
  type: CanvasNodeRecord["type"],
  x: number,
  y: number,
  label: string,
  extra: Record<string, unknown> = {}
): CanvasNodeRecord {
  return {
    id: makeOrchestrationId(),
    type,
    position: { x, y },
    data: {
      label,
      ...extra,
    },
  };
}

function createEdge(
  source: string,
  target: string,
  sourceHandle?: string | null
): CanvasEdgeRecord {
  return {
    id: makeOrchestrationId(),
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
  };
}

function buildStateIngressAppendNodeData(label: string): Record<string, unknown> {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/\+/g, " and ")
    .replace(/[.!?]+$/g, "")
    .replace(/[_\s-]+/g, " ");
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

function buildMemorySizeCodeNodeData(): Record<string, unknown> {
  return {
    actionType: "code",
    actionTypeSource: "auto",
    [NODE_EXECUTABLE_CODE_LANGUAGE_DATA_KEY]: "typescript",
    [NODE_EXECUTABLE_CODE_LOCAL_OUTPUTS_DATA_KEY]: [
      {
        name: MEMORY_OVER_LIMIT_LOCAL_NAME,
        type: "boolean",
      },
    ],
    [NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY]: [
      "const textLength = (value: unknown): number => {",
      "  if (value === null || value === undefined) return 0;",
      "  if (typeof value === \"string\") return value.length;",
      "  return JSON.stringify(value).length;",
      "};",
      "",
      "const memoryLength =",
      "  textLength(ctx.state.summary) +",
      "  textLength(ctx.state.new_events);",
      "",
      "return {",
      "  setLocals: {",
      `    ${MEMORY_OVER_LIMIT_LOCAL_NAME}: memoryLength > ${DEFAULT_CONVERSATION_MEMORY_LIMIT},`,
      "  },",
      "};",
    ].join("\n"),
  };
}

export function normalizeStateIngressAppendNodes(
  doc: CanvasDoc | null,
  fields: OrchestrationField[]
): CanvasDoc | null {
  if (!doc) {
    return doc;
  }

  const hasPrimaryRewardField = fields.some(
    (field) =>
      normalizeKey(field.name) ===
      normalizeKey(PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME)
  );
  let changed = false;

  const canvases = doc.canvases.map((canvas) => {
    let canvasChanged = false;
    const nodes = canvas.graph.nodes.map((node) => {
      const label = String(node.data?.label ?? "").trim();
      const normalized = label
        .toLowerCase()
        .replace(/\+/g, " and ")
        .replace(/[.!?]+$/g, "")
        .replace(/[_\s-]+/g, " ");
      const nextLabel =
        hasPrimaryRewardField &&
        (normalized === "add latest observation event to new events" ||
          normalized === "add latest observation and reward turn to new events" ||
          normalized === "add latest observation and reward event to new events" ||
          normalized === "add latest observation reward turn to new events" ||
          normalized === "add latest observation reward event to new events")
          ? LATEST_OBSERVATION_AND_REWARD_EVENT_LABEL
          : label;
      const isManagedAppend =
        normalized === "add agent latest observation and agent latest reward to new events" ||
        normalized === "add latest observation event to new events" ||
        normalized === "add latest observation and reward turn to new events" ||
        normalized === "add latest observation and reward event to new events" ||
        normalized === "add latest observation reward turn to new events" ||
        normalized === "add latest observation reward event to new events" ||
        normalized === "add latest primary agent action turn to new events" ||
        normalized === "add latest primary agent action event to new events" ||
        normalized === "add latest primary action turn to new events" ||
        normalized === "add latest primary action event to new events";

      if (!isManagedAppend) {
        return node;
      }

      const nextData: { label: string } & Record<string, unknown> = {
        ...node.data,
        label: nextLabel,
        ...buildStateIngressAppendNodeData(nextLabel),
      };
      delete nextData.nonEditable;
      delete nextData.nonEditableReason;
      if (
        node.type === "code" &&
        nextLabel === label &&
        JSON.stringify(nextData) === JSON.stringify(node.data)
      ) {
        return node;
      }

      changed = true;
      canvasChanged = true;
      return {
        ...node,
        type: "code",
        data: nextData,
      };
    });

    return canvasChanged
      ? {
          ...canvas,
          graph: {
            ...canvas.graph,
            nodes,
          },
        }
      : canvas;
  });

  return changed
    ? {
        ...doc,
        canvases,
      }
    : doc;
}

export function createStateCanvas(
  fields: OrchestrationField[],
  meta: OrchestrationProjectMeta,
  focus?: string,
  options?: {
    latestTurnLabel?: string;
    latestTurnDescription?: string;
  }
): CanvasDoc {
  const fieldsWithConversationMemory = ensureConversationMemoryFields(fields);
  const title = meta.title.trim() || "the target demo";
  const latestTurnLabel =
    options?.latestTurnLabel?.trim() ||
    LATEST_OBSERVATION_AND_REWARD_EVENT_LABEL;
  const latestTurnDescription =
    options?.latestTurnDescription?.trim() ||
    "append agent_latest_observation and agent_latest_reward into new_events";
  const focusLine = focus?.trim()
    ? `Pay extra attention to ${focus.trim()}.`
    : "Update only values that the current state actually supports changing.";
  const fieldLine =
    fieldsWithConversationMemory.length > 0
      ? `Track the structured runtime state for ${title}.`
      : `Propose a structured state shape for ${title} as the conversation clarifies it.`;

  const start = createNode(
    "start",
    200,
    40,
    `${fieldLine}\n${focusLine}\nUse the current state as the default input. summary stores condensed past context, and new_events stores the recent unsummarized events as a list of { action, observation, reward } objects. Preserve previous values when the user is still undecided.`
  );
  const appendLatestUserTurn = createNode(
    "code",
    200,
    190,
    latestTurnLabel,
    buildStateIngressAppendNodeData(latestTurnLabel)
  );
  const summaryGate = createNode(
    "code",
    200,
    350,
    `Measure whether summary plus new_events exceeds ${DEFAULT_CONVERSATION_MEMORY_LIMIT} characters.`,
    buildMemorySizeCodeNodeData()
  );
  const memoryOverLimitGate = createNode(
    "condition",
    200,
    510,
    `${MEMORY_OVER_LIMIT_LOCAL_NAME} is true`
  );
  const summarizeAction = createNode(
    "prompt",
    20,
    680,
    "Update summary with a concise summary of summary plus new_events."
  );
  const clearRecentAction = createNode(
    "code",
    20,
    850,
    "Set new_events to empty list.",
    {
      actionType: "code",
      actionTypeSource: "auto",
    }
  );
  const preserveAction = createNode(
    "prompt",
    390,
    680,
    "Use only the current state to update the remaining fields. Leave unchanged values untouched and only fill fields supported by the current state."
  );

  const entry: CanvasEntry = {
    id: makeOrchestrationId(),
    name: "State extraction",
    freeText:
      `The right-hand editor controls the target runtime state schema. By default, this canvas should update state from the current state itself: ${latestTurnDescription}, summarize into summary when needed, and then update the remaining fields from state. The assistant turn should be appended later by the policy canvas after the final reply is decided.`,
    graph: {
      nodes: [
        start,
        appendLatestUserTurn,
        summaryGate,
        memoryOverLimitGate,
        summarizeAction,
        clearRecentAction,
        preserveAction,
      ],
      edges: [
        createEdge(start.id, appendLatestUserTurn.id),
        createEdge(appendLatestUserTurn.id, summaryGate.id),
        createEdge(summaryGate.id, memoryOverLimitGate.id),
        createEdge(memoryOverLimitGate.id, summarizeAction.id, "true"),
        createEdge(memoryOverLimitGate.id, preserveAction.id, "false"),
        createEdge(summarizeAction.id, clearRecentAction.id),
        createEdge(clearRecentAction.id, preserveAction.id),
      ],
    },
  };

  return {
    version: 2,
    activeId: entry.id,
    canvases: [entry],
  };
}

function paramsSchemaFromBlueprint(
  params: ToolBlueprintParam[] | undefined
): string {
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

function createToolCanvas(blueprint: ToolBlueprint): CanvasEntry {
  const start = createNode(
    "start",
    200,
    40,
    `Use this canvas when the system needs the ${blueprint.capability.trim()} capability.`
  );
  const toolNode = createNode(
    "tool_call",
    200,
    230,
    blueprint.whenToCall.trim() || `when ${blueprint.capability.trim()} is needed`,
    {
      toolName: blueprint.toolName.trim(),
      description: blueprint.description.trim(),
      sourceType: blueprint.sourceType,
      url: blueprint.url?.trim() ?? "",
      paramsSchema: paramsSchemaFromBlueprint(blueprint.params),
      promoteToKnowledge: blueprint.promoteToKnowledge === true,
      saveTarget: blueprint.saveTarget ?? "knowledge",
      datasetName: blueprint.datasetName?.trim() ?? "",
    }
  );
  return {
    id: makeOrchestrationId(),
    name:
      blueprint.capability.trim() ||
      titleCaseFromSlug(blueprint.toolName.trim() || "new-tool"),
    freeText: blueprint.notes?.trim() ?? "",
    graph: {
      nodes: [start, toolNode],
      edges: [createEdge(start.id, toolNode.id)],
    },
  };
}

export function appendToolCanvases(
  doc: CanvasDoc | null,
  blueprints: ToolBlueprint[]
) {
  const nextCanvases = [...(doc?.canvases ?? [])];
  const seenToolNames = new Set(
    (compileCanvas(doc ?? { version: 2, activeId: "", canvases: [] }).tools ?? []).map((tool) =>
      tool.function.name.trim().toLowerCase()
    )
  );
  const addedToolNames: string[] = [];

  for (const blueprint of blueprints) {
    const toolName = blueprint.toolName.trim().toLowerCase();
    if (!toolName || seenToolNames.has(toolName)) {
      continue;
    }

    seenToolNames.add(toolName);
    nextCanvases.push(createToolCanvas(blueprint));
    addedToolNames.push(blueprint.toolName.trim());
  }

  if (nextCanvases.length === 0) {
    return {
      doc: doc,
      addedToolNames,
    };
  }

  return {
    doc: {
      version: 2 as const,
      activeId: doc?.activeId || nextCanvases[0].id,
      canvases: nextCanvases,
    },
    addedToolNames,
  };
}

const SUPPORTED_CANVAS_NODE_TYPES = new Set<string>([
  "start",
  "condition",
  "for",
  "while",
  "stage",
  "prompt",
  "code",
  "tool_call",
  "call_agent",
  "display",
  "expand",
  "yield",
  "continue",
  "terminate_stage",
  "terminate_stage_immediate",
  "terminate",
  "read_async_job",
  "await_async_job",
  "build_default_primary_state_schema",
  "build_default_environment_state_schema",
  "build_initial_canvas_shape_materialization_requests",
  "materialize_initial_canvas_structures",
  "merge_materialized_initial_canvas_structures",
  "prepare_canvas_rule_detection_requests",
  "build_canvas_rule_repair_requests",
  "apply_canvas_rule_repairs",
  "prepare_canvas_rule_recheck_requests",
  "finalize_canvas_rule_repair_pass",
  "apply_structured_patch",
  "scaffold_tools",
  "sync_derived_prompts",
  "repair_canvas_rules",
  "finalize_assistant_reply",
]);

function cloneCanvasNode(node: CanvasNodeRecord): CanvasNodeRecord {
  return {
    ...node,
    position: { ...node.position },
    data: { ...node.data },
  };
}

function cloneCanvasEdge(edge: CanvasEdgeRecord): CanvasEdgeRecord {
  const nextEdge = { ...edge } as CanvasEdgeRecord & { kind?: unknown };
  delete nextEdge.kind;
  return nextEdge;
}

function cloneCanvasEntry(entry: CanvasEntry): CanvasEntry {
  return {
    ...entry,
    graph: {
      nodes: entry.graph.nodes.map(cloneCanvasNode),
      edges: entry.graph.edges.map(cloneCanvasEdge),
    },
  };
}

function cloneCanvasDoc(doc: CanvasDoc | null): CanvasDoc | null {
  if (!doc) {
    return null;
  }

  return {
    ...doc,
    canvases: doc.canvases.map(cloneCanvasEntry),
  };
}

function createEmptyCanvasDoc(): CanvasDoc {
  return {
    version: 2,
    activeId: "",
    canvases: [],
  };
}

function normalizeCanvasNodeType(value: string | undefined): CanvasNodeRecord["type"] {
  const trimmed = value?.trim() ?? "";
  return SUPPORTED_CANVAS_NODE_TYPES.has(trimmed) ? trimmed : "prompt";
}

function createCanvasNodeFromEdit(
  canvas: CanvasEntry,
  edit: OrchestrationCanvasEdit,
  fallbackPosition?: { x: number; y: number }
): CanvasNodeRecord {
  const nodeType = normalizeCanvasNodeType(edit.nodeType);
  const defaultPosition = fallbackPosition ?? defaultCanvasNodePosition(canvas);
  const nodeLabel =
    edit.label ??
    (typeof edit.data?.label === "string" ? edit.data.label : undefined) ??
    defaultCanvasNodeLabel(nodeType);

  return {
    id: makeOrchestrationId(),
    type: nodeType,
    position: {
      x: typeof edit.x === "number" ? edit.x : defaultPosition.x,
      y: typeof edit.y === "number" ? edit.y : defaultPosition.y,
    },
    data: {
      label: nodeLabel,
      ...(nodeType === "display"
        ? {
            displayType: "text",
            inputVariable: CARRIED_OUTPUT_PROMPT_VALUE_NAME,
          }
        : {}),
      ...sanitizeCanvasDataPatch(edit.data),
    },
  };
}

function addCanvasEdgeIfMissing(
  canvas: CanvasEntry,
  source: string,
  target: string,
  options?: {
    sourceHandle?: string | null;
    label?: string;
  }
): boolean {
  const sourceHandle = options?.sourceHandle ?? null;
  const existing = canvas.graph.edges.find(
    (edge) =>
      edge.source === source &&
      edge.target === target &&
      (edge.sourceHandle ?? null) === sourceHandle
  );

  if (existing) {
    if (options?.label !== undefined) {
      existing.label = options.label;
    }
    return false;
  }

  const edge = createEdge(source, target, sourceHandle);
  if (options?.label !== undefined) {
    edge.label = options.label;
  }
  canvas.graph.edges.push(edge);
  return true;
}

function defaultCanvasNodeLabel(type: CanvasNodeRecord["type"]): string {
  if (type === "start") {
    return "Start";
  }
  if (type === "condition") {
    return "condition";
  }
  if (type === "for") {
    return "Repeat the body.";
  }
  if (type === "while") {
    return "condition?";
  }
  if (type === "stage") {
    return "Stage: new workflow stage";
  }
  if (type === "tool_call") {
    return "when this tool should be called";
  }
  if (type === "call_agent") {
    return "when another agent should be called";
  }
  if (type === "display") {
    return "display output";
  }
  if (type === "expand") {
    return "Subtree";
  }
  if (type === "terminate") {
    return "Terminate interaction";
  }
  if (type === "yield") {
    return "End turn";
  }
  if (type === "continue") {
    return "Continue";
  }
  if (type === "terminate_stage") {
    return "Terminate stage";
  }
  if (type === "terminate_stage_immediate") {
    return "Terminate stage and move immediately";
  }
  if (type === "read_async_job") {
    return "Load the latest status for a previously queued async job into local variables.";
  }
  if (type === "await_async_job") {
    return "Poll a previously queued async job until it finishes or the timeout elapses.";
  }
  if (type === "build_default_primary_state_schema") {
    return "Build the default primary-agent state schema before planner extras are merged.";
  }
  if (type === "build_default_environment_state_schema") {
    return "Build the default environment-agent state schemas before planner extras are merged.";
  }
  if (type === "build_initial_canvas_shape_materialization_requests") {
    return "Build the local initial-canvas-shape materialization requests from the current structured planner patch without changing the carried planner JSON.";
  }
  if (type === "materialize_initial_canvas_structures") {
    return "If the structured planner patch still contains abstract initial canvas shapes, ask a model to materialize them into concrete InitialCanvasStructure IR before patch application.";
  }
  if (type === "merge_materialized_initial_canvas_structures") {
    return "Merge the local materialized InitialCanvasStructure IR back into the carried structured planner patch.";
  }
  if (type === "prepare_canvas_rule_detection_requests") {
    return "Inspect the current draft canvases in code, canonicalize them, and build local model-detection requests for the canvas-rule repair pass.";
  }
  if (type === "build_canvas_rule_repair_requests") {
    return "Build local canvas-rule repair requests from the detected issues and the current inspected canvas summaries.";
  }
  if (type === "apply_canvas_rule_repairs") {
    return "Apply the local model-proposed canvas-rule repair edits to the inspected draft canvases.";
  }
  if (type === "prepare_canvas_rule_recheck_requests") {
    return "Re-inspect the repaired draft canvases in code, canonicalize them again if needed, and build local recheck requests for the final canvas-rule pass.";
  }
  if (type === "finalize_canvas_rule_repair_pass") {
    return "Publish the canvas-rule repair pass results, merge any repair summary into the carried planner reply, and expose whether another visible retry pass is still needed.";
  }
  if (type === "apply_structured_patch") {
    return "Apply the structured planner patch to the target draft.";
  }
  if (type === "scaffold_tools") {
    return "Synthesize requested tools, add needed dataset hooks, and append tool canvases.";
  }
  if (type === "sync_derived_prompts") {
    return "Recompile the draft's derived prompts after structural edits.";
  }
  if (type === "repair_canvas_rules") {
    return "Check the draft for canvas-rule violations, ask a model for the needed structured repairs, apply those repairs in code, and report whether another repair pass is still needed.";
  }
  if (type === "finalize_assistant_reply") {
    return "Finalize the visible assistant reply from reply intent plus the real applied changes.";
  }
  return "Action";
}

function sanitizeCanvasDataValue(value: unknown): unknown {
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
      .map((item) => sanitizeCanvasDataValue(item))
      .filter((item) => item !== undefined);
  }

  if (typeof value === "object") {
    return Object.entries(value).reduce<Record<string, unknown>>((acc, [key, entry]) => {
      const sanitized = sanitizeCanvasDataValue(entry);
      if (sanitized !== undefined) {
        acc[key] = sanitized;
      }
      return acc;
    }, {});
  }

  return undefined;
}

function sanitizeCanvasDataPatch(
  data: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!data) {
    return {};
  }

  return Object.entries(data).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (key === "label") {
      return acc;
    }

    const sanitized = sanitizeCanvasDataValue(value);
    if (sanitized !== undefined) {
      acc[key] = sanitized;
    }
    return acc;
  }, {});
}

function normalizeCanvasMatchText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function mapOrchestrationFieldsToRuntimeStateSchema(
  fields: OrchestrationField[]
): RuntimeStateField[] {
  return fields.map((field) => ({
    fieldName: field.name,
    type: field.type,
    initialValue: field.initialValue,
  }));
}

function collectAvailableCanvasPromptValueNames(
  nodes: CanvasNodeRecord[],
  edges: CanvasEdgeRecord[],
  nodeId: string
): string[] {
  return collectAvailableCanvasLocalValueNames({
    nodes,
    edges,
    nodeId,
  });
}

export interface CanvasRuleHeuristicIssue {
  ruleId: string;
  summary: string;
  canvasId?: string;
  canvasName?: string;
  nodeId?: string;
  edgeId?: string;
  evidence?: string;
}

function canonicalizeCanvasRuleDoc(
  doc: CanvasDoc,
  stateFields: OrchestrationField[],
  canvasLabel: string
): {
  doc: CanvasDoc;
  appliedChanges: string[];
  heuristicIssues: CanvasRuleHeuristicIssue[];
} {
  let nextDoc = normalizeCanvasDoc(doc) ?? doc;
  const appliedChanges: string[] = [];
  const heuristicIssues: CanvasRuleHeuristicIssue[] = [];

  if (nextDoc !== doc) {
    appliedChanges.push(`normalized ${canvasLabel} canvas nodes`);
    heuristicIssues.push({
      ruleId: "canvas_docs_should_be_normalized",
      summary: `normalized ${canvasLabel} canvas nodes`,
    });
  }

  const taggedDoc =
    autoTagCanvasActionSubtypes(
      nextDoc,
      stateFields.map((field) => ({
        fieldName: field.name,
        type: field.type,
        initialValue: field.initialValue,
      }))
    ) ?? nextDoc;
  if (taggedDoc !== nextDoc) {
    nextDoc = taggedDoc;
    appliedChanges.push(`normalized ${canvasLabel} code/prompt node modes`);
    heuristicIssues.push({
      ruleId: "code_nodes_must_have_executable_backing",
      summary: `normalized ${canvasLabel} code/prompt node modes`,
    });
  }

  if (/state/i.test(canvasLabel)) {
    const normalizedStateIngressDoc =
      normalizeStateIngressAppendNodes(nextDoc, stateFields) ?? nextDoc;
    if (normalizedStateIngressDoc !== nextDoc) {
      nextDoc = normalizedStateIngressDoc;
      appliedChanges.push(`normalized ${canvasLabel} state ingress append node`);
      heuristicIssues.push({
        ruleId: "deterministic_state_updates_should_use_code_nodes",
        summary: `normalized ${canvasLabel} state ingress append node`,
      });
    }
  }

  return {
    doc: nextDoc,
    appliedChanges,
    heuristicIssues,
  };
}

function canvasRuleIsActive(
  rules: readonly CanvasRuleDefinition[] | undefined,
  ruleId: string
): boolean {
  return !rules || rules.some((rule) => rule.id === ruleId);
}

function simulateCanvasRuleRepairs(
  doc: CanvasDoc,
  stateFields: OrchestrationField[],
  canvasLabel: string,
  rules?: readonly CanvasRuleDefinition[]
): {
  doc: CanvasDoc;
  appliedChanges: string[];
  heuristicIssues: CanvasRuleHeuristicIssue[];
} {
  let nextDoc = doc;
  const appliedChanges: string[] = [];
  const heuristicIssues: CanvasRuleHeuristicIssue[] = [];

  if (canvasRuleIsActive(rules, "condition_nodes_must_be_real_conditions")) {
    const conditionRepair = repairLikelyPromptConditionNodes(
      nextDoc,
      stateFields,
      canvasLabel
    );
    if (conditionRepair.doc !== nextDoc) {
      nextDoc = conditionRepair.doc;
    }
    appliedChanges.push(...conditionRepair.appliedChanges);
    heuristicIssues.push(
      ...conditionRepair.appliedChanges.map((summary) => ({
        ruleId: "condition_nodes_must_be_real_conditions",
        summary,
      }))
    );
  }

  if (canvasRuleIsActive(rules, "clarification_gates_must_split_prompt_and_branch")) {
    const promptishGateRepair = repairPromptishClarificationGateConditions(
      nextDoc,
      canvasLabel
    );
    if (promptishGateRepair.doc !== nextDoc) {
      nextDoc = promptishGateRepair.doc;
    }
    appliedChanges.push(...promptishGateRepair.appliedChanges);
    heuristicIssues.push(
      ...promptishGateRepair.appliedChanges.map((summary) => ({
        ruleId: "clarification_gates_must_split_prompt_and_branch",
        summary,
      }))
    );
  }

  if (canvasRuleIsActive(rules, "if_conditions_must_have_distinct_true_false_branches")) {
    const branchRepair = repairMalformedConditionBranching(
      nextDoc,
      canvasLabel
    );
    if (branchRepair.doc !== nextDoc) {
      nextDoc = branchRepair.doc;
    }
    appliedChanges.push(...branchRepair.appliedChanges);
    heuristicIssues.push(
      ...branchRepair.appliedChanges.map((summary) => ({
        ruleId: "if_conditions_must_have_distinct_true_false_branches",
        summary,
      }))
    );
  }

  if (canvasRuleIsActive(rules, "policy_nodes_must_describe_runtime_behavior")) {
    const authoringLeakRepair = repairSeededPolicyAuthoringLeakage(
      nextDoc,
      canvasLabel
    );
    if (authoringLeakRepair.doc !== nextDoc) {
      nextDoc = authoringLeakRepair.doc;
    }
    appliedChanges.push(...authoringLeakRepair.appliedChanges);
    heuristicIssues.push(
      ...authoringLeakRepair.appliedChanges.map((summary) => ({
        ruleId: "policy_nodes_must_describe_runtime_behavior",
        summary,
      }))
    );
  }

  return {
    doc: nextDoc,
    appliedChanges,
    heuristicIssues,
  };
}

export interface CanvasRuleDocInspection {
  doc: CanvasDoc | null;
  canonicalizationChanges: string[];
  suggestedRepairChanges: string[];
  heuristicIssues: CanvasRuleHeuristicIssue[];
  violationsDetected: boolean;
  remainingViolations: number;
}

export function inspectCanvasRuleViolationsForDoc(
  doc: CanvasDoc | null,
  stateFields: OrchestrationField[],
  canvasLabel: string,
  rules?: readonly CanvasRuleDefinition[],
  target?: "policy" | "state" | "workflow"
): CanvasRuleDocInspection {
  if (!doc) {
    return {
      doc,
      canonicalizationChanges: [],
      suggestedRepairChanges: [],
      heuristicIssues: [],
      violationsDetected: false,
      remainingViolations: 0,
    };
  }

  const canonicalized = canonicalizeCanvasRuleDoc(doc, stateFields, canvasLabel);
  const stateSchema = mapOrchestrationFieldsToRuntimeStateSchema(stateFields);
  const simulatedRepairs = simulateCanvasRuleRepairs(
    canonicalized.doc,
    stateFields,
    canvasLabel,
    rules
  );
  const inspectedDoc = simulatedRepairs.doc;
  const sharedRuleDiagnostics = collectCanvasRuleDiagnosticsForDoc(
    inspectedDoc,
    stateSchema,
    rules,
    target
  );
  const remainingViolations =
    sharedRuleDiagnostics.length;

  return {
    doc: inspectedDoc,
    canonicalizationChanges: canonicalized.appliedChanges,
    suggestedRepairChanges: simulatedRepairs.appliedChanges,
    heuristicIssues: [
      ...canonicalized.heuristicIssues,
      ...simulatedRepairs.heuristicIssues,
      ...sharedRuleDiagnostics.map((diagnostic) => ({
        ruleId: diagnostic.ruleId,
        summary: diagnostic.summary,
        canvasId: diagnostic.canvasId,
        canvasName: diagnostic.canvasName,
        nodeId: diagnostic.nodeId,
        edgeId: diagnostic.edgeId,
        evidence: diagnostic.evidence,
      })),
    ],
    violationsDetected:
      canonicalized.appliedChanges.length > 0 ||
      simulatedRepairs.appliedChanges.length > 0 ||
      remainingViolations > 0,
    remainingViolations,
  };
}

function repairMalformedConditionBranching(
  doc: CanvasDoc,
  canvasLabel: string
): {
  doc: CanvasDoc;
  appliedChanges: string[];
} {
  const appliedChanges: string[] = [];
  let changed = false;

  const canvases = doc.canvases.map((canvas) => {
    let canvasChanged = false;
    const nextNodes = canvas.graph.nodes.slice();
    let nextEdges = canvas.graph.edges.slice();

    for (const node of canvas.graph.nodes) {
      if (node.type !== "condition") {
        continue;
      }

      const outgoingEdges = nextEdges.filter((edge) => edge.source === node.id);
      const trueEdges = outgoingEdges.filter((edge) => edge.sourceHandle === "true");
      const falseEdges = outgoingEdges.filter((edge) => edge.sourceHandle === "false");
      const extraEdges = outgoingEdges.filter(
        (edge) => edge.sourceHandle !== "true" && edge.sourceHandle !== "false"
      );
      const trueTarget = trueEdges[0]?.target ?? null;
      const falseTarget = falseEdges[0]?.target ?? null;
      const hasExpectedShape =
        trueEdges.length === 1 &&
        falseEdges.length === 1 &&
        extraEdges.length === 0 &&
        trueTarget !== null &&
        falseTarget !== null &&
        trueTarget !== falseTarget;

      if (hasExpectedShape) {
        continue;
      }

      const distinctTargets: string[] = [];
      const pushTarget = (targetId: string | undefined | null) => {
        if (!targetId || targetId === node.id || distinctTargets.includes(targetId)) {
          return;
        }
        distinctTargets.push(targetId);
      };

      pushTarget(trueTarget);
      pushTarget(falseTarget);
      for (const edge of outgoingEdges) {
        pushTarget(edge.target);
      }

      const inferredTargets = inferNearbyDisconnectedConditionBranchTargets({
        nodes: nextNodes,
        edges: nextEdges,
        conditionNode: node,
        excludedTargetIds: distinctTargets,
      });

      let resolvedTrueTarget: string | null =
        trueTarget ?? distinctTargets[0] ?? null;
      let resolvedFalseTarget: string | null =
        falseTarget ??
        distinctTargets.find((targetId) => targetId !== resolvedTrueTarget) ??
        null;

      if (resolvedTrueTarget === resolvedFalseTarget) {
        resolvedFalseTarget =
          distinctTargets.find((targetId) => targetId !== resolvedTrueTarget) ?? null;
      }

      if (!resolvedTrueTarget) {
        resolvedTrueTarget = inferredTargets.trueTarget;
      }

      if (
        (!resolvedFalseTarget || resolvedFalseTarget === resolvedTrueTarget) &&
        inferredTargets.falseTarget &&
        inferredTargets.falseTarget !== resolvedTrueTarget
      ) {
        resolvedFalseTarget = inferredTargets.falseTarget;
      }

      if (
        (!resolvedTrueTarget || resolvedTrueTarget === resolvedFalseTarget) &&
        inferredTargets.trueTarget &&
        inferredTargets.trueTarget !== resolvedFalseTarget
      ) {
        resolvedTrueTarget = inferredTargets.trueTarget;
      }

      if (
        (!resolvedFalseTarget || resolvedFalseTarget === resolvedTrueTarget) &&
        inferredTargets.trueTarget &&
        inferredTargets.trueTarget !== resolvedTrueTarget &&
        !distinctTargets.includes(inferredTargets.trueTarget)
      ) {
        resolvedFalseTarget = inferredTargets.trueTarget;
      }

      const usedDisconnectedTargets = inferredTargets.usedTargetIds.filter(
        (targetId) =>
          targetId === resolvedTrueTarget || targetId === resolvedFalseTarget
      );
      nextEdges = nextEdges.filter((edge) => edge.source !== node.id);
      if (resolvedTrueTarget) {
        nextEdges.push(createEdge(node.id, resolvedTrueTarget, "true"));
      }
      if (resolvedFalseTarget && resolvedFalseTarget !== resolvedTrueTarget) {
        nextEdges.push(createEdge(node.id, resolvedFalseTarget, "false"));
      }
      canvasChanged = true;
      changed = true;

      const label =
        typeof node.data?.label === "string" && node.data.label.trim()
          ? node.data.label.trim()
          : node.id;
      appliedChanges.push(
        usedDisconnectedTargets.length > 0
            ? `repaired malformed TRUE/FALSE wiring for condition "${label}" on the ${canvasLabel} canvas by reconnecting nearby disconnected branch entry nodes`
            : `repaired malformed TRUE/FALSE wiring for condition "${label}" on the ${canvasLabel} canvas`
      );
    }

    if (!canvasChanged) {
      return canvas;
    }

    return {
      ...canvas,
      graph: {
        ...canvas.graph,
        nodes: nextNodes,
        edges: nextEdges,
      },
    };
  });

  if (!changed) {
    return {
      doc,
      appliedChanges: [],
    };
  }

  return {
    doc: {
      ...doc,
      canvases,
    },
    appliedChanges,
  };
}

const CONDITION_BRANCH_INFERENCE_HORIZONTAL_OFFSET = 320;
const CONDITION_BRANCH_INFERENCE_VERTICAL_OFFSET = 170;
const CONDITION_BRANCH_INFERENCE_SIDE_TOLERANCE = 80;
const CONDITION_BRANCH_INFERENCE_MAX_SCORE = 640;

function inferNearbyDisconnectedConditionBranchTargets(args: {
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
  conditionNode: CanvasNodeRecord;
  excludedTargetIds: string[];
}): {
  trueTarget: string | null;
  falseTarget: string | null;
  usedTargetIds: string[];
} {
  const incomingCount = new Map<string, number>();
  for (const edge of args.edges) {
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }

  const candidateNodes = args.nodes.filter((candidate) => {
    if (candidate.id === args.conditionNode.id || candidate.type === "start") {
      return false;
    }

    if (args.excludedTargetIds.includes(candidate.id)) {
      return false;
    }

    if ((incomingCount.get(candidate.id) ?? 0) !== 0) {
      return false;
    }

    return candidate.position.y >= args.conditionNode.position.y + 40;
  });

  const scoreCandidate = (
    candidate: CanvasNodeRecord,
    branch: "true" | "false"
  ): number => {
    const expectedX =
      args.conditionNode.position.x +
      (branch === "true"
        ? -CONDITION_BRANCH_INFERENCE_HORIZONTAL_OFFSET
        : CONDITION_BRANCH_INFERENCE_HORIZONTAL_OFFSET);
    const expectedY =
      args.conditionNode.position.y + CONDITION_BRANCH_INFERENCE_VERTICAL_OFFSET;
    const horizontalDistance = Math.abs(candidate.position.x - expectedX);
    const verticalDistance = Math.abs(candidate.position.y - expectedY);
    const onWrongSide =
      branch === "true"
        ? candidate.position.x >
          args.conditionNode.position.x + CONDITION_BRANCH_INFERENCE_SIDE_TOLERANCE
        : candidate.position.x <
          args.conditionNode.position.x - CONDITION_BRANCH_INFERENCE_SIDE_TOLERANCE;
    return (
      horizontalDistance +
      verticalDistance +
      (onWrongSide ? 260 : 0)
    );
  };

  const pickBestCandidate = (
    branch: "true" | "false",
    excludedIds: string[]
  ): CanvasNodeRecord | null => {
    const ranked = candidateNodes
      .filter((candidate) => !excludedIds.includes(candidate.id))
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(candidate, branch),
      }))
      .filter((entry) => entry.score <= CONDITION_BRANCH_INFERENCE_MAX_SCORE)
      .sort((left, right) => left.score - right.score);

    return ranked[0]?.candidate ?? null;
  };

  const trueCandidate = pickBestCandidate("true", []);
  const falseCandidate = pickBestCandidate("false", trueCandidate ? [trueCandidate.id] : []);
  const usedTargetIds = [trueCandidate?.id, falseCandidate?.id].filter(
    (value): value is string => typeof value === "string"
  );

  return {
    trueTarget: trueCandidate?.id ?? null,
    falseTarget: falseCandidate?.id ?? null,
    usedTargetIds,
  };
}

function repairPromptishClarificationGateConditions(
  doc: CanvasDoc,
  canvasLabel: string
): {
  doc: CanvasDoc;
  appliedChanges: string[];
} {
  if (!/policy/i.test(canvasLabel)) {
    return {
      doc,
      appliedChanges: [],
    };
  }

  const appliedChanges: string[] = [];
  let changed = false;

  const canvases = doc.canvases.map((canvas) => {
    let canvasChanged = false;
    let nextNodes = canvas.graph.nodes.slice();
    let nextEdges = canvas.graph.edges.slice();

    for (const node of canvas.graph.nodes) {
      if (node.type !== "condition") {
        continue;
      }

      const rawLabel = typeof node.data?.label === "string" ? node.data.label : "";
      const normalizedGate = normalizePolicySeedClarificationGate(rawLabel);
      const prefacePromptLabel = normalizedGate.prefacePromptLabel;
      if (!prefacePromptLabel) {
        continue;
      }

      const outgoingEdges = nextEdges.filter((edge) => edge.source === node.id);
      const trueEdge =
        outgoingEdges.find((edge) => edge.sourceHandle === "true") ?? null;
      const falseEdge =
        outgoingEdges.find((edge) => edge.sourceHandle === "false") ?? null;
      if (!trueEdge || !falseEdge) {
        continue;
      }

      canvasChanged = true;
      changed = true;

      const repairedGate = createNode(
        "condition",
        node.position.x,
        node.position.y + 160,
        normalizedGate.gateLabel
      );
      nextNodes = nextNodes.map((existingNode) =>
        existingNode.id === node.id
          ? {
              ...existingNode,
              type: "prompt",
              data: {
                ...existingNode.data,
                label: prefacePromptLabel,
                actionType: "prompt",
                actionTypeSource: "auto",
              },
            }
          : existingNode
      );
      nextNodes.push(repairedGate);
      nextEdges = nextEdges.map((edge) =>
        edge.source === node.id
          ? {
              ...edge,
              source: repairedGate.id,
            }
          : edge
      );
      nextEdges.push(createEdge(node.id, repairedGate.id));
      appliedChanges.push(
        `split prompt-like clarification gate "${rawLabel.trim() || node.id}" into a prompt action plus a real condition on the ${canvasLabel} canvas`
      );
    }

    if (!canvasChanged) {
      return canvas;
    }

    return {
      ...canvas,
      graph: {
        ...canvas.graph,
        nodes: nextNodes,
        edges: nextEdges,
      },
    };
  });

  if (!changed) {
    return {
      doc,
      appliedChanges: [],
    };
  }

  return {
    doc: {
      ...doc,
      canvases,
    },
    appliedChanges,
  };
}

function repairLikelyPromptConditionNodes(
  doc: CanvasDoc,
  fields: OrchestrationField[],
  canvasLabel: string
): {
  doc: CanvasDoc;
  appliedChanges: string[];
} {
  const stateSchema = mapOrchestrationFieldsToRuntimeStateSchema(fields);
  const appliedChanges: string[] = [];
  let changed = false;

  const canvases = doc.canvases.map((canvas) => {
    const outgoing = new Map<string, CanvasEdgeRecord[]>();
    for (const edge of canvas.graph.edges) {
      const group = outgoing.get(edge.source) ?? [];
      group.push(edge);
      outgoing.set(edge.source, group);
    }

    let canvasChanged = false;
    const nodes = canvas.graph.nodes.map((node) => {
      if (node.type !== "condition") {
        return node;
      }

      const availablePromptValueNames = collectAvailableCanvasPromptValueNames(
        canvas.graph.nodes,
        canvas.graph.edges,
        node.id
      );
      const parsedCondition = parseConditionLabel(
        typeof node.data?.label === "string" ? node.data.label : "",
        stateSchema,
        availablePromptValueNames
      );
      const outgoingEdges = outgoing.get(node.id) ?? [];
      const trueEdge = outgoingEdges.find((edge) => edge.sourceHandle === "true") ?? null;
      const falseEdge = outgoingEdges.find((edge) => edge.sourceHandle === "false") ?? null;

      const looksLikeMisclassifiedPrompt =
        parsedCondition === null &&
        !trueEdge &&
        !falseEdge &&
        outgoingEdges.length <= 1;

      if (!looksLikeMisclassifiedPrompt) {
        return node;
      }

      changed = true;
      canvasChanged = true;
      appliedChanges.push(
        `converted likely misclassified condition "${typeof node.data?.label === "string" && node.data.label.trim() ? node.data.label.trim() : node.id}" into a prompt action on the ${canvasLabel} canvas`
      );
      return {
        ...node,
        type: "prompt",
        data: {
          ...node.data,
          actionType: "prompt",
          actionTypeSource: "auto",
        },
      };
    });

    const edges = !canvasChanged
      ? canvas.graph.edges
      : canvas.graph.edges.map((edge) => {
          const sourceNode = nodes.find((node) => node.id === edge.source);
          if (!sourceNode || sourceNode.type !== "prompt" || edge.sourceHandle == null) {
            return edge;
          }
          const nextEdge = { ...edge };
          delete nextEdge.sourceHandle;
          return nextEdge;
        });

    if (!canvasChanged) {
      return canvas;
    }

    return {
      ...canvas,
      graph: {
        ...canvas.graph,
        nodes,
        edges,
      },
    };
  });

  if (!changed) {
    return { doc, appliedChanges: [] };
  }

  return {
    doc: {
      ...doc,
      canvases,
    },
    appliedChanges,
  };
}

function repairSeededPolicyAuthoringLeakage(
  doc: CanvasDoc,
  canvasLabel: string
): {
  doc: CanvasDoc;
  appliedChanges: string[];
} {
  if (!/policy/i.test(canvasLabel)) {
    return {
      doc,
      appliedChanges: [],
    };
  }

  const appliedChanges: string[] = [];
  let changed = false;

  const canvases = doc.canvases.map((canvas) => {
    let canvasChanged = false;
    const nodes = canvas.graph.nodes.map((node) => {
      const rawLabel = typeof node.data?.label === "string" ? node.data.label : "";
      const trimmedLabel = rawLabel.trim();
      if (!trimmedLabel) {
        return node;
      }

      let nextLabel: string | null = null;

      if (
        node.type === "condition" &&
        (/^one or more open questions about .+ remain unresolved$/i.test(trimmedLabel) ||
          /^important operating details for .+ remain unresolved$/i.test(trimmedLabel))
      ) {
        nextLabel = "the user's request, constraints, or required inputs are still unclear";
      } else if (
        node.type === "start" &&
        trimmedLabel.includes("Keep the editable setup")
      ) {
        nextLabel = trimmedLabel.replace(
          /\s*Keep the editable setup[^.]*\./i,
          " Stay consistent with the confirmed operating loop."
        );
      } else if (
        (node.type === "action" || node.type === "prompt") &&
        trimmedLabel.includes("Reflect concrete decisions back into the editable setup")
      ) {
        nextLabel = trimmedLabel.replace(
          /\n?Reflect concrete decisions back into the editable setup, including state fields, datasets, and canvases\./i,
          "\nKeep the response grounded in the current state, summary, and recent events."
        );
      } else if (
        (node.type === "action" || node.type === "prompt") &&
        trimmedLabel.includes("keep the editable setup aligned with the confirmed process")
      ) {
        nextLabel = trimmedLabel.replace(
          /and keep the editable setup aligned with the confirmed process/gi,
          "while staying consistent with the confirmed process"
        );
      }

      if (nextLabel === null || nextLabel === trimmedLabel) {
        return node;
      }

      changed = true;
      canvasChanged = true;
      appliedChanges.push(
        `rewrote leaked authoring text in policy node "${trimmedLabel.slice(0, 80)}${trimmedLabel.length > 80 ? "..." : ""}"`
      );
      return {
        ...node,
        data: {
          ...node.data,
          label: nextLabel.trim(),
        },
      };
    });

    if (!canvasChanged) {
      return canvas;
    }

    return {
      ...canvas,
      graph: {
        ...canvas.graph,
        nodes,
        edges: canvas.graph.edges,
      },
    };
  });

  if (!changed) {
    return {
      doc,
      appliedChanges: [],
    };
  }

  return {
    doc: {
      ...doc,
      canvases,
    },
    appliedChanges,
  };
}

function nodeMatchesCanvasRef(
  node: CanvasNodeRecord,
  ref: OrchestrationCanvasNodeRef
): boolean {
  if (ref.id?.trim() && node.id === ref.id.trim()) {
    return true;
  }

  const actionType = normalizeCanvasMatchText(
    typeof node.data.actionType === "string" ? node.data.actionType : undefined
  );
  const expectedType = normalizeCanvasMatchText(ref.type);
  if (
    expectedType &&
    normalizeCanvasMatchText(node.type) !== expectedType &&
    actionType !== expectedType
  ) {
    return false;
  }

  const expectedActionType = normalizeCanvasMatchText(ref.actionType);
  if (expectedActionType && actionType !== expectedActionType) {
    return false;
  }

  const label = typeof node.data.label === "string" ? node.data.label.trim() : "";
  const labelEquals = ref.labelEquals?.trim();
  if (labelEquals && label !== labelEquals) {
    return false;
  }

  const labelContains = normalizeCanvasMatchText(ref.labelContains);
  if (labelContains && !normalizeCanvasMatchText(label).includes(labelContains)) {
    return false;
  }

  const toolName = normalizeCanvasMatchText(
    typeof node.data.toolName === "string" ? node.data.toolName : undefined
  );
  const expectedToolName = normalizeCanvasMatchText(ref.toolName);
  if (expectedToolName && toolName !== expectedToolName) {
    return false;
  }

  return Boolean(
    expectedType ||
      expectedActionType ||
      labelEquals ||
      labelContains ||
      expectedToolName
  );
}

function resolveCanvasEntryIndex(
  doc: CanvasDoc,
  edit: Pick<OrchestrationCanvasEdit, "canvasId" | "canvasName">
): number {
  const canvasId = edit.canvasId?.trim();
  if (canvasId) {
    return doc.canvases.findIndex((canvas) => canvas.id === canvasId);
  }

  const canvasName = normalizeKey(edit.canvasName ?? "");
  if (canvasName) {
    return doc.canvases.findIndex(
      (canvas) => normalizeKey(canvas.name) === canvasName
    );
  }

  if (doc.activeId) {
    const activeIndex = doc.canvases.findIndex((canvas) => canvas.id === doc.activeId);
    if (activeIndex !== -1) {
      return activeIndex;
    }
  }

  return doc.canvases.length > 0 ? 0 : -1;
}

function canvasMatchesEditRefs(
  canvas: CanvasEntry,
  aliases: Map<string, string>,
  edit: OrchestrationCanvasEdit
): boolean {
  const refs = [edit.nodeRef, edit.sourceRef, edit.targetRef].filter(
    (ref): ref is OrchestrationCanvasNodeRef => ref !== undefined
  );

  if (refs.length > 0) {
    return refs.every((ref) => resolveCanvasNode(canvas, aliases, ref));
  }

  const edgeId = edit.edgeId?.trim();
  return Boolean(edgeId && canvas.graph.edges.some((edge) => edge.id === edgeId));
}

function resolveCanvasEntryIndexForEdit(
  doc: CanvasDoc,
  aliases: Map<string, string>,
  edit: OrchestrationCanvasEdit,
  preferredIndex: number
): number {
  if (edit.canvasId?.trim() || edit.canvasName?.trim()) {
    return preferredIndex;
  }

  if (
    preferredIndex !== -1 &&
    canvasMatchesEditRefs(doc.canvases[preferredIndex]!, aliases, edit)
  ) {
    return preferredIndex;
  }

  const matchingIndexes = doc.canvases
    .map((canvas, index) => (canvasMatchesEditRefs(canvas, aliases, edit) ? index : -1))
    .filter((index) => index !== -1);

  return matchingIndexes.length === 1 ? matchingIndexes[0]! : preferredIndex;
}

function resolveCanvasNode(
  canvas: CanvasEntry,
  aliases: Map<string, string>,
  ref: OrchestrationCanvasNodeRef | undefined
): CanvasNodeRecord | null {
  if (!ref) {
    return null;
  }

  const aliasId = ref.nodeKey?.trim() ? aliases.get(ref.nodeKey.trim()) : undefined;
  if (aliasId) {
    return canvas.graph.nodes.find((node) => node.id === aliasId) ?? null;
  }

  const directId = ref.id?.trim();
  if (directId) {
    return canvas.graph.nodes.find((node) => node.id === directId) ?? null;
  }

  return canvas.graph.nodes.find((node) => nodeMatchesCanvasRef(node, ref)) ?? null;
}

function resolveCanvasEdge(
  canvas: CanvasEntry,
  aliases: Map<string, string>,
  edit: Pick<
    OrchestrationCanvasEdit,
    "edgeId" | "sourceRef" | "targetRef" | "sourceHandle"
  >
): CanvasEdgeRecord | null {
  const directEdgeId = edit.edgeId?.trim();
  if (directEdgeId) {
    return canvas.graph.edges.find((edge) => edge.id === directEdgeId) ?? null;
  }

  const sourceNode = resolveCanvasNode(canvas, aliases, edit.sourceRef);
  const targetNode = resolveCanvasNode(canvas, aliases, edit.targetRef);
  if (!sourceNode || !targetNode) {
    return null;
  }

  const matches = canvas.graph.edges.filter((edge) => {
    if (edge.source !== sourceNode.id || edge.target !== targetNode.id) {
      return false;
    }
    if (
      edit.sourceHandle !== undefined &&
      (edge.sourceHandle ?? null) !== (edit.sourceHandle ?? null)
    ) {
      return false;
    }
    return true;
  });

  return matches.length === 1 ? matches[0] : null;
}

function defaultCanvasNodePosition(canvas: CanvasEntry): { x: number; y: number } {
  if (canvas.graph.nodes.length === 0) {
    return { x: 200, y: 120 };
  }

  const maxY = Math.max(...canvas.graph.nodes.map((node) => node.position.y));
  return { x: 200, y: maxY + 160 };
}

export function applyCanvasEdits(
  doc: CanvasDoc | null,
  edits: OrchestrationCanvasEdit[]
): {
  doc: CanvasDoc | null;
  appliedChanges: string[];
} {
  if (edits.length === 0) {
    return {
      doc,
      appliedChanges: [],
    };
  }

  const nextDoc = cloneCanvasDoc(doc) ?? createEmptyCanvasDoc();
  const aliases = new Map<string, string>();
  const appliedChanges: string[] = [];

  for (const edit of edits) {
    if (edit.op === "add_canvas") {
      const existingIndex = resolveCanvasEntryIndex(nextDoc, edit);
      if (existingIndex !== -1) {
        const existing = nextDoc.canvases[existingIndex];
        if (edit.notes?.trim()) {
          existing.freeText = edit.notes.trim();
        }
        if (!nextDoc.activeId) {
          nextDoc.activeId = existing.id;
        }
        continue;
      }

      const entry: CanvasEntry = {
        id: makeOrchestrationId(),
        name: edit.canvasName?.trim() || `Canvas ${nextDoc.canvases.length + 1}`,
        freeText: edit.notes?.trim() ?? "",
        graph: {
          nodes: [],
          edges: [],
        },
      };
      nextDoc.canvases.push(entry);
      if (!nextDoc.activeId) {
        nextDoc.activeId = entry.id;
      }
      appliedChanges.push(`added canvas "${entry.name}"`);
      continue;
    }

    let canvasIndex = resolveCanvasEntryIndex(nextDoc, edit);
    if (canvasIndex === -1 && edit.op === "add_node" && edit.canvasName?.trim()) {
      const entry: CanvasEntry = {
        id: makeOrchestrationId(),
        name: edit.canvasName.trim(),
        freeText: "",
        graph: {
          nodes: [],
          edges: [],
        },
      };
      nextDoc.canvases.push(entry);
      if (!nextDoc.activeId) {
        nextDoc.activeId = entry.id;
      }
      canvasIndex = nextDoc.canvases.length - 1;
      appliedChanges.push(`added canvas "${entry.name}"`);
    }
    canvasIndex = resolveCanvasEntryIndexForEdit(nextDoc, aliases, edit, canvasIndex);

    if (canvasIndex === -1) {
      continue;
    }

    const canvas = nextDoc.canvases[canvasIndex];

    if (edit.op === "rename_canvas") {
      const nextName = edit.nextName?.trim();
      if (nextName && nextName !== canvas.name) {
        canvas.name = nextName;
        appliedChanges.push(`renamed canvas to "${nextName}"`);
      }
      continue;
    }

    if (edit.op === "set_canvas_notes") {
      const notes = edit.notes?.trim() ?? "";
      if (notes !== canvas.freeText) {
        canvas.freeText = notes;
        appliedChanges.push(`updated notes for "${canvas.name}"`);
      }
      continue;
    }

    if (edit.op === "set_active_canvas") {
      if (nextDoc.activeId !== canvas.id) {
        nextDoc.activeId = canvas.id;
        appliedChanges.push(`focused canvas "${canvas.name}"`);
      }
      continue;
    }

    if (edit.op === "add_node") {
      const node = createCanvasNodeFromEdit(canvas, edit);
      canvas.graph.nodes.push(node);
      if (edit.nodeKey?.trim()) {
        aliases.set(edit.nodeKey.trim(), node.id);
      }
      appliedChanges.push(`added a ${node.type} node to "${canvas.name}"`);
      continue;
    }

    if (edit.op === "insert_node_before") {
      const anchorNode = resolveCanvasNode(canvas, aliases, edit.nodeRef);
      const sourceNode = edit.sourceRef
        ? resolveCanvasNode(canvas, aliases, edit.sourceRef)
        : null;
      if (!anchorNode || (edit.sourceRef && !sourceNode)) {
        continue;
      }

      const matchingEdges = canvas.graph.edges.filter((edge) => {
        if (edge.target !== anchorNode.id) {
          return false;
        }
        if (sourceNode && edge.source !== sourceNode.id) {
          return false;
        }
        if (
          edit.sourceHandle !== undefined &&
          (edge.sourceHandle ?? null) !== (edit.sourceHandle ?? null)
        ) {
          return false;
        }
        return true;
      });
      const fallbackPosition = {
        x: anchorNode.position.x,
        y: anchorNode.position.y - 160,
      };
      const node = createCanvasNodeFromEdit(canvas, edit, fallbackPosition);
      canvas.graph.nodes.push(node);
      if (edit.nodeKey?.trim()) {
        aliases.set(edit.nodeKey.trim(), node.id);
      }

      if (matchingEdges.length > 0) {
        const removedEdgeIds = new Set(matchingEdges.map((edge) => edge.id));
        canvas.graph.edges = canvas.graph.edges.filter(
          (edge) => !removedEdgeIds.has(edge.id)
        );
        for (const edge of matchingEdges) {
          addCanvasEdgeIfMissing(canvas, edge.source, node.id, {
            sourceHandle: edge.sourceHandle,
            label: edge.label,
          });
        }
      } else if (sourceNode) {
        addCanvasEdgeIfMissing(canvas, sourceNode.id, node.id, {
          sourceHandle: edit.sourceHandle,
          label: edit.edgeLabel,
        });
      }

      addCanvasEdgeIfMissing(canvas, node.id, anchorNode.id, {
        label: edit.edgeLabel,
      });
      appliedChanges.push(`inserted a ${node.type} node before a node in "${canvas.name}"`);
      continue;
    }

    if (edit.op === "insert_node_after") {
      const anchorNode = resolveCanvasNode(canvas, aliases, edit.nodeRef);
      const targetNode = edit.targetRef
        ? resolveCanvasNode(canvas, aliases, edit.targetRef)
        : null;
      if (!anchorNode || (edit.targetRef && !targetNode)) {
        continue;
      }

      const matchingEdges = canvas.graph.edges.filter((edge) => {
        if (edge.source !== anchorNode.id) {
          return false;
        }
        if (targetNode && edge.target !== targetNode.id) {
          return false;
        }
        if (
          edit.sourceHandle !== undefined &&
          (edge.sourceHandle ?? null) !== (edit.sourceHandle ?? null)
        ) {
          return false;
        }
        return true;
      });
      const fallbackPosition = {
        x: anchorNode.position.x,
        y: anchorNode.position.y + 160,
      };
      const node = createCanvasNodeFromEdit(canvas, edit, fallbackPosition);
      canvas.graph.nodes.push(node);
      if (edit.nodeKey?.trim()) {
        aliases.set(edit.nodeKey.trim(), node.id);
      }

      if (matchingEdges.length > 0) {
        const removedEdgeIds = new Set(matchingEdges.map((edge) => edge.id));
        canvas.graph.edges = canvas.graph.edges.filter(
          (edge) => !removedEdgeIds.has(edge.id)
        );
        for (const edge of matchingEdges) {
          addCanvasEdgeIfMissing(canvas, anchorNode.id, node.id, {
            sourceHandle: edge.sourceHandle,
            label: edge.label,
          });
          addCanvasEdgeIfMissing(canvas, node.id, edge.target, {
            label: edge.label,
          });
        }
      } else {
        addCanvasEdgeIfMissing(canvas, anchorNode.id, node.id, {
          sourceHandle: edit.sourceHandle,
          label: edit.edgeLabel,
        });
        if (targetNode) {
          addCanvasEdgeIfMissing(canvas, node.id, targetNode.id);
        }
      }

      appliedChanges.push(`inserted a ${node.type} node after a node in "${canvas.name}"`);
      continue;
    }

    if (edit.op === "update_node") {
      const node = resolveCanvasNode(canvas, aliases, edit.nodeRef);
      if (!node) {
        continue;
      }

      const nextData = {
        ...node.data,
        ...sanitizeCanvasDataPatch(edit.data),
      };
      if (edit.label !== undefined) {
        nextData.label = edit.label;
      }

      const nextType = edit.nodeType ? normalizeCanvasNodeType(edit.nodeType) : node.type;
      if (nextType === "display") {
        nextData.displayType =
          nextData.displayType === "video" ? "video" : "text";
        if (
          typeof nextData.inputVariable !== "string" ||
          !nextData.inputVariable.trim()
        ) {
          nextData.inputVariable = CARRIED_OUTPUT_PROMPT_VALUE_NAME;
        }
      }
      node.type = nextType;
      node.position = {
        x: typeof edit.x === "number" ? edit.x : node.position.x,
        y: typeof edit.y === "number" ? edit.y : node.position.y,
      };
      node.data = nextData;
      appliedChanges.push(`updated a node in "${canvas.name}"`);
      continue;
    }

    if (edit.op === "delete_node") {
      const node = resolveCanvasNode(canvas, aliases, edit.nodeRef);
      if (!node) {
        continue;
      }

      canvas.graph.nodes = canvas.graph.nodes.filter((candidate) => candidate.id !== node.id);
      canvas.graph.edges = canvas.graph.edges.filter(
        (edge) => edge.source !== node.id && edge.target !== node.id
      );
      appliedChanges.push(`removed a node from "${canvas.name}"`);
      continue;
    }

    if (edit.op === "add_edge") {
      const sourceNode = resolveCanvasNode(canvas, aliases, edit.sourceRef);
      const targetNode = resolveCanvasNode(canvas, aliases, edit.targetRef);
      if (!sourceNode || !targetNode) {
        continue;
      }

      const existing = canvas.graph.edges.find(
        (edge) =>
          edge.source === sourceNode.id &&
          edge.target === targetNode.id &&
          (edge.sourceHandle ?? null) === (edit.sourceHandle ?? null)
      );
      if (existing) {
        if (edit.edgeLabel !== undefined) {
          existing.label = edit.edgeLabel;
        }
        continue;
      }

      const edge = createEdge(
        sourceNode.id,
        targetNode.id,
        edit.sourceHandle ?? undefined
      );
      if (edit.edgeLabel !== undefined) {
        edge.label = edit.edgeLabel;
      }
      canvas.graph.edges.push(edge);
      appliedChanges.push(`connected nodes in "${canvas.name}"`);
      continue;
    }

    if (edit.op === "update_edge") {
      const edge = resolveCanvasEdge(canvas, aliases, edit);
      if (!edge) {
        continue;
      }

      let changed = false;
      if (edit.edgeLabel !== undefined && edge.label !== edit.edgeLabel) {
        edge.label = edit.edgeLabel;
        changed = true;
      }

      if (changed) {
        appliedChanges.push(`updated a connection in "${canvas.name}"`);
      }
      continue;
    }

    if (edit.op === "delete_edge") {
      const before = canvas.graph.edges.length;
      canvas.graph.edges = canvas.graph.edges.filter((edge) => {
        if (edit.edgeId?.trim()) {
          return edge.id !== edit.edgeId.trim();
        }

        const sourceNode = resolveCanvasNode(canvas, aliases, edit.sourceRef);
        const targetNode = resolveCanvasNode(canvas, aliases, edit.targetRef);
        if (!sourceNode || !targetNode) {
          return true;
        }

        return !(
          edge.source === sourceNode.id &&
          edge.target === targetNode.id &&
          (edit.sourceHandle === undefined ||
            (edge.sourceHandle ?? null) === (edit.sourceHandle ?? null))
        );
      });
      if (canvas.graph.edges.length !== before) {
        appliedChanges.push(`removed a connection from "${canvas.name}"`);
      }
    }
  }

  if (nextDoc.canvases.length === 0) {
    return {
      doc: null,
      appliedChanges,
    };
  }

  if (!nextDoc.activeId) {
    nextDoc.activeId = nextDoc.canvases[0].id;
  }

  return {
    doc: nextDoc,
    appliedChanges,
  };
}

function syncCanvasRuleRepairsForDoc(
  doc: CanvasDoc | null,
  stateFields: OrchestrationField[],
  canvasLabel: string,
  rules?: readonly CanvasRuleDefinition[],
  target?: "policy" | "state" | "workflow"
): {
  doc: CanvasDoc | null;
  appliedChanges: string[];
  remainingViolations: number;
} {
  if (!doc) {
    return {
      doc,
      appliedChanges: [],
      remainingViolations: 0,
    };
  }

  const canonicalized = canonicalizeCanvasRuleDoc(doc, stateFields, canvasLabel);
  const stateSchema = mapOrchestrationFieldsToRuntimeStateSchema(stateFields);
  let nextDoc = canonicalized.doc;
  const appliedChanges: string[] = [...canonicalized.appliedChanges];

  const simulatedRepairs = simulateCanvasRuleRepairs(
    nextDoc,
    stateFields,
    canvasLabel,
    rules
  );
  nextDoc = simulatedRepairs.doc;
  appliedChanges.push(...simulatedRepairs.appliedChanges);

  const remainingViolations = collectCanvasRuleDiagnosticsForDoc(
    nextDoc,
    stateSchema,
    rules,
    target
  ).length;

  return {
    doc: nextDoc,
    appliedChanges,
    remainingViolations,
  };
}

export function repairProjectCanvasRuleViolations(
  project: OrchestrationProject
): {
  project: OrchestrationProject;
  appliedChanges: string[];
  violationsDetected: boolean;
  violationsRemaining: boolean;
  retryNeeded: boolean;
} {
  let nextProject = project;
  const appliedChanges: string[] = [];
  let detectedViolations = false;
  let remainingViolations = 0;

  const syncMainPolicy = syncCanvasRuleRepairsForDoc(
    nextProject.policyCanvases,
    nextProject.fields,
    "policy",
    undefined,
    "policy"
  );
  nextProject = {
    ...nextProject,
    policyCanvases: syncMainPolicy.doc,
  };
  if (syncMainPolicy.appliedChanges.length > 0 || syncMainPolicy.remainingViolations > 0) {
    detectedViolations = true;
  }
  appliedChanges.push(...syncMainPolicy.appliedChanges);
  remainingViolations += syncMainPolicy.remainingViolations;

  const syncMainState = syncCanvasRuleRepairsForDoc(
    nextProject.statePolicyCanvases,
    nextProject.fields,
    "state",
    undefined,
    "state"
  );
  nextProject = {
    ...nextProject,
    statePolicyCanvases: syncMainState.doc,
  };
  if (syncMainState.appliedChanges.length > 0 || syncMainState.remainingViolations > 0) {
    detectedViolations = true;
  }
  appliedChanges.push(...syncMainState.appliedChanges);
  remainingViolations += syncMainState.remainingViolations;

  nextProject = {
    ...nextProject,
    agentConnections: nextProject.agentConnections.map((connection) => {
      const syncSourcePolicy = syncCanvasRuleRepairsForDoc(
        connection.sourcePolicyCanvases,
        nextProject.fields,
        `${connection.id} source participant policy`,
        undefined,
        "policy"
      );
      const syncSourceState = syncCanvasRuleRepairsForDoc(
        connection.sourceStatePolicyCanvases,
        nextProject.fields,
        `${connection.id} source participant state`,
        undefined,
        "state"
      );
      const syncTargetPolicy = syncCanvasRuleRepairsForDoc(
        connection.targetPolicyCanvases ?? connection.policyCanvases,
        nextProject.fields,
        `${connection.id} target participant policy`,
        undefined,
        "policy"
      );
      const syncTargetState = syncCanvasRuleRepairsForDoc(
        connection.targetStatePolicyCanvases,
        nextProject.fields,
        `${connection.id} target participant state`,
        undefined,
        "state"
      );

      if (
        syncSourcePolicy.appliedChanges.length > 0 ||
        syncSourcePolicy.remainingViolations > 0 ||
        syncSourceState.appliedChanges.length > 0 ||
        syncSourceState.remainingViolations > 0 ||
        syncTargetPolicy.appliedChanges.length > 0 ||
        syncTargetPolicy.remainingViolations > 0 ||
        syncTargetState.appliedChanges.length > 0 ||
        syncTargetState.remainingViolations > 0
      ) {
        detectedViolations = true;
      }

      appliedChanges.push(
        ...syncSourcePolicy.appliedChanges,
        ...syncSourceState.appliedChanges,
        ...syncTargetPolicy.appliedChanges,
        ...syncTargetState.appliedChanges
      );
      remainingViolations +=
        syncSourcePolicy.remainingViolations +
        syncSourceState.remainingViolations +
        syncTargetPolicy.remainingViolations +
        syncTargetState.remainingViolations;

      return {
        ...connection,
        sourcePolicyCanvases: syncSourcePolicy.doc,
        sourceStatePolicyCanvases: syncSourceState.doc,
        targetPolicyCanvases: syncTargetPolicy.doc,
        targetStatePolicyCanvases: syncTargetState.doc,
        policyCanvases: syncTargetPolicy.doc,
      };
    }),
    environmentPlayers: nextProject.environmentPlayers.map((player) => {
      const syncPolicy = syncCanvasRuleRepairsForDoc(
        player.policyCanvases,
        player.fields,
        `${player.id} policy`,
        undefined,
        "policy"
      );
      const syncState = syncCanvasRuleRepairsForDoc(
        player.statePolicyCanvases,
        player.fields,
        `${player.id} state`,
        undefined,
        "state"
      );

      if (
        syncPolicy.appliedChanges.length > 0 ||
        syncPolicy.remainingViolations > 0 ||
        syncState.appliedChanges.length > 0 ||
        syncState.remainingViolations > 0
      ) {
        detectedViolations = true;
      }

      appliedChanges.push(...syncPolicy.appliedChanges, ...syncState.appliedChanges);
      remainingViolations +=
        syncPolicy.remainingViolations + syncState.remainingViolations;

      return {
        ...player,
        policyCanvases: syncPolicy.doc,
        statePolicyCanvases: syncState.doc,
      };
    }),
  };

  return {
    project: nextProject,
    appliedChanges,
    violationsDetected: detectedViolations,
    violationsRemaining: remainingViolations > 0,
    retryNeeded: remainingViolations > 0 && appliedChanges.length > 0,
  };
}

export function syncDerivedPrompts(
  project: OrchestrationProject
): OrchestrationProject {
  const fields = normalizeLatestInteractionStateFields(project.fields);
  const runtimePolicyCanvases = getRuntimePolicyCanvasDoc(project.policyCanvases);
  const workflowCanvases = getProjectWorkflowCanvasDoc(project);
  return {
    ...project,
    fields,
    workflowCanvases,
    policyCanvases: runtimePolicyCanvases,
    agentConnections: project.agentConnections.map((connection) =>
      syncAgentConnectionDerivedPrompts({
        ...connection,
        targetFields: normalizeLatestInteractionStateFields(
          connection.targetFields
        ),
      })
    ),
    environmentPlayers: project.environmentPlayers.map((player) =>
      syncEnvironmentPlayerDerivedPrompts({
        ...player,
        fields: normalizeLatestInteractionStateFields(player.fields),
      })
    ),
    policyPrompt: runtimePolicyCanvases
      ? compileCanvas(runtimePolicyCanvases).output
      : project.policyPrompt,
    skills: (project.skills ?? []).map(syncSkillDerivedPrompts),
    stateUpdatePrompt: project.statePolicyCanvases
      ? compileStateExtractionPrompt(project.statePolicyCanvases, fields)
      : project.stateUpdatePrompt,
  };
}

export function syncAgentConnectionDerivedPrompts(
  connection: OrchestrationAgentConnection
): OrchestrationAgentConnection {
  const targetPolicyCanvases =
    connection.targetPolicyCanvases ?? connection.policyCanvases;
  const targetPolicyPrompt = targetPolicyCanvases
    ? compileCanvas(targetPolicyCanvases).output
    : connection.targetPolicyPrompt || connection.policyPrompt;
  return {
    ...connection,
    sourcePolicyPrompt: connection.sourcePolicyCanvases
      ? compileCanvas(connection.sourcePolicyCanvases).output
      : connection.sourcePolicyPrompt,
    sourceRewardPrompt: connection.sourceRewardCanvases
      ? compileCanvas(connection.sourceRewardCanvases).output
      : connection.sourceRewardPrompt,
    sourceStateUpdatePrompt: connection.sourceStateUpdatePrompt,
    targetPolicyPrompt,
    targetRewardPrompt: connection.targetRewardCanvases
      ? compileCanvas(connection.targetRewardCanvases).output
      : connection.targetRewardPrompt,
    targetStateUpdatePrompt: connection.targetStateUpdatePrompt,
    policyPrompt: targetPolicyPrompt,
    policyCanvases: targetPolicyCanvases,
  };
}

export function syncEnvironmentPlayerDerivedPrompts(
  player: OrchestrationEnvironmentPlayer
): OrchestrationEnvironmentPlayer {
  return {
    ...player,
    policyPrompt: player.policyCanvases
      ? compileCanvas(player.policyCanvases).output
      : player.policyPrompt,
    skills: (player.skills ?? []).map(syncSkillDerivedPrompts),
    stateUpdatePrompt: player.statePolicyCanvases
      ? compileStateExtractionPrompt(player.statePolicyCanvases, player.fields)
      : player.stateUpdatePrompt,
  };
}

export function syncSkillDerivedPrompts(
  skill: OrchestrationSkill
): OrchestrationSkill {
  return {
    ...skill,
    policyPrompt: skill.policyCanvases
      ? compileCanvas(skill.policyCanvases).output
      : skill.policyPrompt,
  };
}

export function mergeSuggestedFields(
  current: OrchestrationField[],
  suggestions: SuggestedField[],
  options?: { protectedFieldNames?: readonly string[] }
): OrchestrationField[] {
  if (suggestions.length === 0) {
    return current;
  }

  const protectedKeys = new Set(
    (options?.protectedFieldNames ?? []).map((name) => normalizeKey(name))
  );
  const next = [...current];
  const byKey = new Map(
    next.map((field, index) => [normalizeKey(field.name), index] as const)
  );

  for (const suggestion of suggestions) {
    const name = suggestion.name.trim();
    if (!name) {
      continue;
    }

    const key = normalizeKey(name);
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      next.push({
        id: makeOrchestrationId(),
        name,
        type: suggestion.type,
        initialValue: suggestion.initialValue?.trim() ?? "null",
      });
      byKey.set(key, next.length - 1);
      continue;
    }

    const existing = next[existingIndex];
    const isProtected = protectedKeys.has(key);
    next[existingIndex] = {
      ...existing,
      name: isProtected ? existing.name : name,
      type: isProtected ? existing.type : suggestion.type,
      initialValue:
        suggestion.initialValue?.trim() || existing.initialValue || "null",
    };
  }

  return next;
}

export function mergeSuggestedGuidelines(
  current: OrchestrationGuidelineBlock[],
  suggestions: SuggestedGuideline[]
): OrchestrationGuidelineBlock[] {
  if (suggestions.length === 0) {
    return current;
  }

  const next = [...current];
  const byKey = new Map(
    next.map((guideline, index) => [normalizeKey(guideline.topic), index] as const)
  );

  for (const suggestion of suggestions) {
    const topic = suggestion.topic.trim();
    if (!topic) {
      continue;
    }

    const key = normalizeKey(topic);
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      next.push({
        id: makeOrchestrationId(),
        topic,
        content: suggestion.content?.trim() ?? "",
        problem: suggestion.problem?.trim() ?? "",
        recommendation: suggestion.recommendation?.trim() ?? "",
      });
      byKey.set(key, next.length - 1);
      continue;
    }

    next[existingIndex] = {
      ...next[existingIndex],
      topic,
      content: suggestion.content?.trim() ?? next[existingIndex].content,
      problem: suggestion.problem?.trim() ?? next[existingIndex].problem,
      recommendation:
        suggestion.recommendation?.trim() ?? next[existingIndex].recommendation,
    };
  }

  return next;
}

export function applyGuidelineEdits(
  current: OrchestrationGuidelineBlock[],
  edits: OrchestrationGuidelineEdit[]
): {
  guidelines: OrchestrationGuidelineBlock[];
  appliedChanges: string[];
} {
  if (edits.length === 0) {
    return {
      guidelines: current,
      appliedChanges: [],
    };
  }

  let next = [...current];
  const appliedChanges: string[] = [];

  for (const edit of edits) {
    if (edit.op === "clear_all") {
      if (next.length > 0) {
        next = [];
        appliedChanges.push("cleared guideline blocks");
      }
      continue;
    }

    if (edit.op === "replace_all") {
      next = mergeSuggestedGuidelines([], edit.guidelines ?? []);
      appliedChanges.push("replaced guideline blocks");
      continue;
    }

    if (edit.op === "delete") {
      const topic = edit.topic?.trim();
      if (!topic) {
        continue;
      }
      const before = next.length;
      next = next.filter(
        (guideline) => normalizeKey(guideline.topic) !== normalizeKey(topic)
      );
      if (next.length !== before) {
        appliedChanges.push(`removed guideline "${topic}"`);
      }
      continue;
    }

    if (edit.op === "upsert") {
      const topic = edit.topic?.trim();
      if (!topic) {
        continue;
      }

      const before = next.length;
      next = mergeSuggestedGuidelines(next, [
        {
          topic,
          content: edit.content,
          problem: edit.problem,
          recommendation: edit.recommendation,
        },
      ]);
      appliedChanges.push(
        next.length !== before
          ? `added guideline "${topic}"`
          : `updated guideline "${topic}"`
      );
    }
  }

  return {
    guidelines: next,
    appliedChanges,
  };
}

function stringifyRecordValue(
  value: unknown,
  type: SimulationPlayerDatasetColumnType
): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (type === "string[]") {
    return Array.isArray(value) ? value.map((item) => String(item)).join(", ") : String(value);
  }

  if (type === "boolean") {
    return typeof value === "boolean" ? String(value) : String(value).trim();
  }

  return String(value);
}

function createDatasetFromSuggestion(
  suggestion: SuggestedDataset
): SimulationPlayerDataset {
  const columns = suggestion.columns
    .filter((column) => column.name.trim().length > 0)
    .map<SimulationPlayerDatasetColumn>((column) => ({
      id: makeOrchestrationId(),
      name: column.name.trim(),
      type: column.type,
    }));

  const safeColumns =
    columns.length > 0
      ? columns
      : [
          {
            id: makeOrchestrationId(),
            name: "value",
            type: "string" as const,
          },
        ];

  const records = (suggestion.exampleRecords ?? []).map<SimulationPlayerDatasetRecord>(
    (record) => ({
      id: makeOrchestrationId(),
      values: safeColumns.reduce<Record<string, string>>((acc, column) => {
        acc[column.id] = stringifyRecordValue(record[column.name], column.type);
        return acc;
      }, {}),
    })
  );

  return {
    id: makeOrchestrationId(),
    name: suggestion.name.trim(),
    notes: suggestion.notes?.trim() ?? "",
    columns: safeColumns,
    records,
  };
}

export function mergeSuggestedDatasets(
  current: SimulationPlayerDataset[],
  suggestions: SuggestedDataset[]
): SimulationPlayerDataset[] {
  if (suggestions.length === 0) {
    return current;
  }

  const next = [...current];
  const byKey = new Map(
    next.map((dataset, index) => [normalizeKey(dataset.name), index] as const)
  );

  for (const suggestion of suggestions) {
    const datasetName = suggestion.name.trim();
    if (!datasetName) {
      continue;
    }

    const key = normalizeKey(datasetName);
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      next.push(createDatasetFromSuggestion(suggestion));
      byKey.set(key, next.length - 1);
      continue;
    }

    const existing = next[existingIndex];
    const columns = [...existing.columns];
    const columnIndexByKey = new Map(
      columns.map((column, index) => [normalizeKey(column.name), index] as const)
    );

    for (const suggestedColumn of suggestion.columns) {
      const columnName = suggestedColumn.name.trim();
      if (!columnName) {
        continue;
      }

      const columnKey = normalizeKey(columnName);
      const columnIndex = columnIndexByKey.get(columnKey);
      if (columnIndex === undefined) {
        columns.push({
          id: makeOrchestrationId(),
          name: columnName,
          type: suggestedColumn.type,
        });
        columnIndexByKey.set(columnKey, columns.length - 1);
      } else {
        columns[columnIndex] = {
          ...columns[columnIndex],
          name: columnName,
          type: suggestedColumn.type,
        };
      }
    }

    let records = existing.records;
    if (records.length === 0 && (suggestion.exampleRecords?.length ?? 0) > 0) {
      records = (suggestion.exampleRecords ?? []).map((record) => ({
        id: makeOrchestrationId(),
        values: columns.reduce<Record<string, string>>((acc, column) => {
          acc[column.id] = stringifyRecordValue(record[column.name], column.type);
          return acc;
        }, {}),
      }));
    }

    next[existingIndex] = {
      ...existing,
      name: datasetName,
      notes: suggestion.notes?.trim() || existing.notes,
      columns,
      records,
    };
  }

  return next;
}

export function ensureDatasetForTool(
  current: SimulationPlayerDataset[],
  blueprint: ToolBlueprint
): SimulationPlayerDataset[] {
  const targetsDataset =
    (blueprint.sourceType === "knowledge_save" && blueprint.saveTarget === "dataset") ||
    blueprint.sourceType === "dataset_read";
  if (!targetsDataset || !blueprint.datasetName?.trim()) {
    return current;
  }

  const datasetName = blueprint.datasetName.trim();
  const exists = current.some(
    (dataset) => normalizeKey(dataset.name) === normalizeKey(datasetName)
  );
  if (exists) {
    return current;
  }

  return [
    ...current,
    {
      id: makeOrchestrationId(),
      name: datasetName,
      notes: `Created automatically for tool ${blueprint.toolName.trim()}.`,
      columns: [
        {
          id: makeOrchestrationId(),
          name: "entry",
          type: "string",
        },
      ],
      records: [],
    },
  ];
}

export function summarizeTools(doc: CanvasDoc | null): string[] {
  return (compileCanvas(doc ?? { version: 2, activeId: "", canvases: [] }).tools ?? []).map(
    (tool) => tool.function.name
  );
}

function buildCurrentBuildCanvasSnapshot(doc: CanvasDoc | null) {
  if (!doc || doc.canvases.length === 0) {
    return {
      active_canvas_id: null,
      canvas_count: 0,
      canvases: [],
    };
  }

  return {
    active_canvas_id: doc.activeId || null,
    canvas_count: doc.canvases.length,
    canvases: doc.canvases.map((canvas) => ({
      id: canvas.id,
      name: canvas.name,
      notes: canvas.freeText || "",
      node_count: canvas.graph.nodes.length,
      edge_count: canvas.graph.edges.length,
      nodes: canvas.graph.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        label: typeof node.data.label === "string" ? node.data.label : "",
        action_type:
          typeof node.data.actionType === "string" ? node.data.actionType : undefined,
        tool_name:
          typeof node.data.toolName === "string" ? node.data.toolName : undefined,
        source_type:
          typeof node.data.sourceType === "string" ? node.data.sourceType : undefined,
      })),
      edges: canvas.graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        source_handle: edge.sourceHandle ?? null,
        label: edge.label ?? "",
      })),
    })),
  };
}

export function buildCurrentBuildSnapshot(project: OrchestrationProject) {
  const runtimePolicyCanvases = getRuntimePolicyCanvasDoc(project.policyCanvases);
  const compiledTools =
    compileCanvas(runtimePolicyCanvases ?? { version: 2, activeId: "", canvases: [] }).tools ?? [];
  const workflowCanvases = getProjectWorkflowCanvasDoc(project);
  const primarySplit = splitProjectDatasets(project.datasets);
  const sharedSplit = splitProjectDatasets(
    Array.isArray(project.sharedDatasets) ? project.sharedDatasets : []
  );
  const authoredDatasets = primarySplit.authoredDatasets;
  const sharedAuthoredDatasets = sharedSplit.authoredDatasets;
  // Bootstrap episodes live on the shared tier; the primary-tier arm only
  // covers drafts that predate the relocation.
  const bootstrapDatasets = [
    ...sharedSplit.bootstrapDatasets,
    ...primarySplit.bootstrapDatasets,
  ];
  const summarizeBootstrapRecords = (dataset: SimulationPlayerDataset) =>
    dataset.records.slice(0, 5).map((record) => ({
      id: record.id,
      values: dataset.columns.reduce<Record<string, string>>((acc, column) => {
        const value = record.values[column.id] ?? "";
        acc[column.name] = truncatePromptText(value, 1600);
        return acc;
      }, {}),
    }));

  const fields = normalizeLatestInteractionStateFields(project.fields);
  const structuralGaps: string[] = [];
  if (fields.length === 0) {
    structuralGaps.push("state_schema_empty");
  }
  if (!runtimePolicyCanvases || runtimePolicyCanvases.canvases.length === 0) {
    structuralGaps.push("policy_canvas_missing");
  }
  if (!project.statePolicyCanvases || project.statePolicyCanvases.canvases.length === 0) {
    structuralGaps.push("state_canvas_missing");
  }

  return {
    meta: {
      agent_id: project.agentId || project.id,
      title: project.meta.title || null,
      slug: project.meta.slug || null,
      summary: project.meta.summary || null,
      policy_intent: project.meta.policyIntent || null,
      status: project.meta.status || null,
    },
    state_schema: {
      field_count: fields.length,
      fields: fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
        initial_value: field.initialValue,
      })),
    },
    workflow: buildCurrentBuildCanvasSnapshot(workflowCanvases),
    policy: buildCurrentBuildCanvasSnapshot(runtimePolicyCanvases),
    state_tracking: buildCurrentBuildCanvasSnapshot(project.statePolicyCanvases),
    skills: project.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      start_condition_canvas_count:
        skill.startConditionCanvases?.canvases.length ?? 0,
      policy_canvas_count: skill.policyCanvases?.canvases.length ?? 0,
      termination_condition_canvas_count:
        skill.terminationConditionCanvases?.canvases.length ?? 0,
    })),
    guidelines: project.guidelines.map((guideline) => ({
      id: guideline.id,
      topic: guideline.topic,
      content: guideline.content,
      problem: guideline.problem,
      recommendation: guideline.recommendation,
    })),
    datasets: authoredDatasets.map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      notes: dataset.notes,
      record_count: dataset.records.length,
      columns: dataset.columns.map((column) => ({
        id: column.id,
        name: column.name,
        type: column.type,
      })),
    })),
    shared_datasets: sharedAuthoredDatasets.map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      notes: dataset.notes,
      record_count: dataset.records.length,
      columns: dataset.columns.map((column) => ({
        id: column.id,
        name: column.name,
        type: column.type,
      })),
    })),
    bootstrap_datasets: bootstrapDatasets.map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      notes: dataset.notes,
      record_count: dataset.records.length,
      columns: dataset.columns.map((column) => ({
        id: column.id,
        name: column.name,
        type: column.type,
      })),
      sample_records: summarizeBootstrapRecords(dataset),
    })),
    agents: {
      count: project.agents.length,
      bindings: project.agents.map((agent) => ({
        id: agent.id,
        template_id: agent.templateId,
        template_version_id: agent.templateVersionId,
        title: agent.title || null,
        has_role_context: agent.roleContext.trim().length > 0,
        field_override_count: agent.fieldOverrides.length,
        dataset_override_count: agent.datasetOverrides.length,
        skill_override_count: agent.skillOverrides?.length ?? 0,
        policy_canvas_override_count:
          agent.policyCanvasesOverride?.canvases.length ?? 0,
        state_canvas_override_count:
          agent.statePolicyCanvasesOverride?.canvases.length ?? 0,
      })),
    },
    agent_connections: {
      count: project.agentConnections.length,
      connections: project.agentConnections.map((connection) => ({
        id: connection.id,
        source_agent_id: connection.sourceAgentId || project.agentId || project.id,
        target_agent_id: connection.targetAgentId,
        target_agent_title: connection.targetAgentTitle || null,
        purpose: connection.purpose || null,
        workflow_stage_id: connection.workflowStageId || null,
        workflow_stage_name: connection.workflowStageName || null,
        target_agent_shared_id: connection.targetAgentSharedId || null,
        invocation_mode: connection.invocationMode,
        target_field_count: Array.isArray(connection.targetFields)
          ? connection.targetFields.length
          : 0,
        target_dataset_count: Array.isArray(connection.targetDatasets)
          ? connection.targetDatasets.length
          : 0,
        target_skill_count: Array.isArray(connection.targetSkills)
          ? connection.targetSkills.length
          : 0,
        source_policy_canvas_count:
          connection.sourcePolicyCanvases?.canvases.length ?? 0,
        source_state_canvas_count:
          connection.sourceStatePolicyCanvases?.canvases.length ?? 0,
        target_policy_canvas_count:
          (connection.targetPolicyCanvases ?? connection.policyCanvases)?.canvases
            .length ?? 0,
        target_state_canvas_count:
          connection.targetStatePolicyCanvases?.canvases.length ?? 0,
      })),
    },
    tools: compiledTools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description ?? "",
      source_type: tool.config.sourceType,
      save_target:
        tool.config.sourceType === "knowledge_save" ? tool.config.saveTarget ?? "knowledge" : null,
      dataset_name:
        tool.config.sourceType === "knowledge_save" ? tool.config.datasetName ?? null : null,
      url: tool.config.sourceType === "knowledge_save" ? "" : tool.config.url,
    })),
    structural_gaps: structuralGaps,
  };
}

export function hasStructuredOrchestrationProject(
  project: OrchestrationProject
): boolean {
  const nonMemoryFields = project.fields.filter((field) => {
    const normalized = field.name.trim().toLowerCase().replace(/[_\s-]+/g, " ");
    return normalized !== CONVERSATION_SUMMARY_FIELD_NAME &&
      normalized !== NEW_EVENTS_FIELD_NAME.replace(/_/g, " ") &&
      normalized !== LEGACY_NEW_CONVERSATIONS_FIELD_NAME.replace(/_/g, " ");
  });
  const { authoredDatasets } = splitProjectDatasets([
    ...project.datasets,
    ...(Array.isArray(project.sharedDatasets) ? project.sharedDatasets : []),
  ]);

  return (
    project.agents.length > 0 ||
    project.agentConnections.length > 0 ||
    nonMemoryFields.length > 0 ||
    project.skills.length > 0 ||
    project.guidelines.length > 0 ||
    authoredDatasets.length > 0 ||
    !!getRuntimePolicyCanvasDoc(project.policyCanvases)?.canvases.length ||
    !!project.statePolicyCanvases?.canvases.length
  );
}

function summarizeCanvasNode(node: CanvasNodeRecord): string {
  const label =
    typeof node.data.label === "string"
      ? truncatePromptText(node.data.label, 180)
      : "";
  const parts = [`id=${node.id}`, `type=${node.type}`];
  if (label) {
    parts.push(`label=${JSON.stringify(label)}`);
  }
  if (typeof node.data.actionType === "string" && node.data.actionType.trim()) {
    parts.push(`actionType=${node.data.actionType.trim()}`);
  }
  if (typeof node.data.toolName === "string" && node.data.toolName.trim()) {
    parts.push(`toolName=${node.data.toolName.trim()}`);
  }
  if (typeof node.data.sourceType === "string" && node.data.sourceType.trim()) {
    parts.push(`sourceType=${node.data.sourceType.trim()}`);
  }
  return `- ${parts.join(" | ")}`;
}

function summarizeCanvasEdge(edge: CanvasEdgeRecord): string {
  const parts = [`id=${edge.id}`, `${edge.source} -> ${edge.target}`];
  if (edge.sourceHandle) {
    parts.push(`handle=${edge.sourceHandle}`);
  }
  if (edge.label?.trim()) {
    parts.push(`label=${JSON.stringify(edge.label.trim())}`);
  }
  return `- ${parts.join(" | ")}`;
}

export function summarizeCanvasDocForPrompt(doc: CanvasDoc | null): string {
  if (!doc || doc.canvases.length === 0) {
    return "- (none yet)";
  }

  return doc.canvases
    .map((canvas) => {
      const notes = canvas.freeText.trim();
      const nodeLines =
        canvas.graph.nodes.length > 0
          ? canvas.graph.nodes.map(summarizeCanvasNode).join("\n")
          : "- (no nodes yet)";
      const edgeLines =
        canvas.graph.edges.length > 0
          ? canvas.graph.edges.map(summarizeCanvasEdge).join("\n")
          : "- (no edges yet)";

      return [
        `Canvas ${JSON.stringify(canvas.name || canvas.id)} (id=${canvas.id})${
          doc.activeId === canvas.id ? " [active]" : ""
        }`,
        notes ? `Notes: ${truncatePromptText(notes, 240)}` : "Notes: (none)",
        "Nodes:",
        nodeLines,
        "Edges:",
        edgeLines,
      ].join("\n");
    })
    .join("\n\n");
}

export function summarizeProjectForPrompt(
  project: OrchestrationProject
): string {
  const fields =
    project.fields.length > 0
      ? project.fields
          .map(
            (field) =>
              `- ${field.name} (${field.type}) initial=${field.initialValue || "null"}`
          )
          .join("\n")
      : "- (none yet)";

  const guidelines =
    project.guidelines.length > 0
      ? project.guidelines
          .map((guideline) => {
            const parts = [
              guideline.topic && `topic=${guideline.topic}`,
              guideline.content && `content=${guideline.content}`,
              guideline.problem && `problem=${guideline.problem}`,
              guideline.recommendation &&
                `recommendation=${guideline.recommendation}`,
            ].filter(Boolean);
            return `- ${parts.join(" | ")}`;
          })
          .join("\n")
      : "- (none yet)";

  const datasets =
    project.datasets.length > 0
      ? project.datasets
          .map((dataset) => {
            const columns =
              dataset.columns.length > 0
                ? dataset.columns
                    .map((column) => `${column.name}:${column.type}`)
                    .join(", ")
                : "(no columns)";
            return `- ${dataset.name} [${columns}]`;
          })
          .join("\n")
      : "- (none yet)";

  const tools =
    summarizeTools(getRuntimePolicyCanvasDoc(project.policyCanvases)).length > 0
      ? summarizeTools(getRuntimePolicyCanvasDoc(project.policyCanvases))
          .map((toolName) => `- ${toolName}`)
          .join("\n")
      : "- (none yet)";

  const skills =
    project.skills.length > 0
      ? project.skills.map((skill) => `- ${skill.name}`).join("\n")
      : "- (none yet)";

  const agents =
    project.agents.length > 0
      ? project.agents
          .map((agent) => {
            const title = agent.title.trim() ? `, title=${agent.title.trim()}` : "";
            const context = agent.roleContext.trim()
              ? `, roleContext=${truncatePromptText(agent.roleContext.trim(), 120)}`
              : "";
            const skillOverrides = agent.skillOverrides ?? [];
            const skills = skillOverrides.length
              ? `, skills=${skillOverrides.map((skill) => skill.name).join(", ")}`
              : "";
            return `- ${agent.id} (templateId=${agent.templateId}, templateVersionId=${agent.templateVersionId}${title}${context}${skills})`;
          })
          .join("\n")
      : "- (none yet)";

  const agentConnections =
    project.agentConnections.length > 0
      ? project.agentConnections
          .map((connection) => {
            const targetLabel =
              connection.targetAgentTitle.trim() ||
              connection.targetAgentId.trim() ||
              "unknown target";
            const purpose = connection.purpose.trim()
              ? `, purpose=${connection.purpose.trim()}`
              : "";
            const workflowStage = connection.workflowStageName?.trim()
              ? `, workflowStage=${connection.workflowStageName.trim()}`
              : connection.workflowStageId?.trim()
                ? `, workflowStageId=${connection.workflowStageId.trim()}`
                : "";
            const sharedAgent = connection.targetAgentSharedId?.trim()
              ? `, targetAgentSharedId=${connection.targetAgentSharedId.trim()}`
              : "";
            const sourcePolicyCanvasCount =
              connection.sourcePolicyCanvases?.canvases.length ?? 0;
            const sourceStateCanvasCount =
              connection.sourceStatePolicyCanvases?.canvases.length ?? 0;
            const targetPolicyCanvasCount =
              (connection.targetPolicyCanvases ?? connection.policyCanvases)
                ?.canvases.length ?? 0;
            const targetStateCanvasCount =
              connection.targetStatePolicyCanvases?.canvases.length ?? 0;
            return `- ${connection.sourceAgentId || project.agentId || project.id} -> ${targetLabel} (connectionId=${connection.id}, targetAgentId=${connection.targetAgentId || "unset"}${sharedAgent}${workflowStage}, sourcePolicyCanvases=${sourcePolicyCanvasCount}, sourceStateCanvases=${sourceStateCanvasCount}, targetPolicyCanvases=${targetPolicyCanvasCount}, targetStateCanvases=${targetStateCanvasCount}, mode=${connection.invocationMode}${purpose})`;
          })
          .join("\n")
      : "- (none yet)";

  return [
    `Agent ID: ${project.agentId || project.id}`,
    `Title: ${project.meta.title || "Untitled Setup"}`,
    `Slug: ${project.meta.slug || "untitled-setup"}`,
    `Summary: ${project.meta.summary || "(empty)"}`,
    `Policy intent: ${project.meta.policyIntent || "(unset)"}`,
    `Status: ${project.meta.status || "(unset)"}`,
    "",
    "State fields:",
    fields,
    "",
    "Datasets:",
    datasets,
    "",
    "Guidelines:",
    guidelines,
    "",
    "Current tools:",
    tools,
    "",
    "Top-level skills:",
    skills,
    "",
    "Project agents:",
    agents,
    "",
    "Agent connections:",
    agentConnections,
    "",
    "Workflow canvas details:",
    summarizeCanvasDocForPrompt(getProjectWorkflowCanvasDoc(project)),
    "",
    "Policy canvas details:",
    summarizeCanvasDocForPrompt(getRuntimePolicyCanvasDoc(project.policyCanvases)),
    "",
    "State canvas details:",
    summarizeCanvasDocForPrompt(project.statePolicyCanvases),
  ].join("\n");
}
