import { compileCanvas } from "@airlab/canvas-compiler/compiler";
import { getNodeActionSubtype } from "@airlab/canvas-core/components/canvas/action-subtype";
import { extractFirstJsonObject } from "./json-object-extraction";
import type { CanvasDoc, CanvasEntry } from "@airlab/canvas-compiler/types";
import {
  AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME,
} from "@airlab/canvas-core/lib/canvas-flow-values";

export type FieldType = "string" | "integer" | "boolean" | "string[]" | "number" | "json";
export type StateSnapshot = Record<string, string>;

export interface RuntimeStateField {
  fieldName: string;
  type: FieldType;
  initialValue: string;
}

export type ExecutionMode = "full_prompt" | "code" | "hybrid";

export type ConditionPlan =
  | { kind: "always" }
  | { kind: "all"; conditions: ConditionPlan[] }
  | { kind: "any"; conditions: ConditionPlan[] }
  | { kind: "not"; condition: ConditionPlan }
  | { kind: "field_empty"; field: string }
  | { kind: "field_not_empty"; field: string }
  | { kind: "field_equals"; field: string; value: string | number | boolean }
  | { kind: "field_not_equals"; field: string; value: string | number | boolean }
  | { kind: "field_includes"; field: string; value: string }
  | { kind: "field_matches_regex"; field: string; pattern: string; flags?: string }
  | { kind: "field_gt"; field: string; value: number }
  | { kind: "field_gte"; field: string; value: number }
  | { kind: "field_lt"; field: string; value: number }
  | { kind: "field_lte"; field: string; value: number }
  | { kind: "prompt_value_empty"; name: string }
  | { kind: "prompt_value_not_empty"; name: string }
  | { kind: "prompt_value_equals"; name: string; value: string | number | boolean }
  | { kind: "prompt_value_not_equals"; name: string; value: string | number | boolean }
  | { kind: "prompt_value_includes"; name: string; value: string }
  | { kind: "prompt_value_matches_regex"; name: string; pattern: string; flags?: string }
  | { kind: "message_contains"; value: string }
  | { kind: "message_matches_regex"; pattern: string; flags?: string };

export type StateValueSource =
  | { kind: "constant"; value: string | number | boolean | null | string[] }
  | { kind: "prompt_variable"; name: string }
  | { kind: "current_build_snapshot" }
  | { kind: "conversation_turns" }
  | { kind: "latest_user_turn" }
  | { kind: "latest_assistant_turn" }
  | { kind: "latest_observation_event" }
  | { kind: "latest_observation_and_reward_event" }
  | { kind: "latest_primary_action_event" }
  | { kind: "agent_latest_observation" }
  | { kind: "extract_age" }
  | { kind: "extract_gender" }
  | { kind: "regex_capture"; pattern: string; flags?: string; group?: number }
  | { kind: "boolean_from_regex"; pattern: string; flags?: string };

export interface StatePromptExtractionField {
  name: string;
  type: FieldType;
  instruction: string;
}

export interface StatePromptExtractionPlan {
  fields: StatePromptExtractionField[];
  context_prompt?: string;
}

export interface StateCodeRuntimeContext {
  conversationTurns?: string[];
  latestUserTurn?: string;
  latestAssistantTurn?: string;
  latestObservationEvent?: unknown;
  latestObservationAndRewardEvent?: unknown;
  latestPrimaryActionEvent?: unknown;
}

export type StateCodeOperation =
  | { kind: "set_field"; field: string; source: StateValueSource; only_if_empty?: boolean }
  | { kind: "set_local"; name: string; source: StateValueSource; only_if_empty?: boolean }
  | { kind: "clear_field"; field: string }
  | {
      kind: "append_list_item";
      field: string;
      value?: string;
      source?: StateValueSource;
      unique?: boolean;
    };

export interface StateCodeRule {
  when: ConditionPlan;
  ops: StateCodeOperation[];
  stop?: boolean;
}

export interface CanvasExecutionSourceNodeRef {
  canvasId: string;
  nodeId: string;
}

export interface StateExecutionGraphStepBase {
  id: string;
  when?: ConditionPlan;
  else_step_id?: string | null;
  sourceNodeRefs?: CanvasExecutionSourceNodeRef[];
}

export interface StateCodeExecutionStep extends StateExecutionGraphStepBase {
  type: "code";
  rules: StateCodeRule[];
  output_variable?: string | null;
  output_object_field_names?: string[] | null;
  language?: "dsl" | "typescript" | null;
  script_source?: string | null;
  next_step_id?: string | null;
  on_match_step_id?: string | null;
  on_no_match_step_id?: string | null;
  on_error_step_id?: string | null;
}

export interface StatePromptExtractExecutionStep extends StateExecutionGraphStepBase {
  type: "prompt_extract";
  prompt_extraction_plan: StatePromptExtractionPlan;
  next_step_id?: string | null;
  on_value_step_id?: string | null;
  on_empty_step_id?: string | null;
}

export interface StateToolCallExecutionStep extends StateExecutionGraphStepBase {
  type: "tool_call";
  tool_name: string;
  result_variable?: string;
  input_object_variables?: string[];
  input_prompt_value_names?: string[] | null;
  next_step_id?: string | null;
  on_error_step_id?: string | null;
}

export interface StatePromptSubtreeUpdateExecutionStep extends StateExecutionGraphStepBase {
  type: "prompt_subtree_update";
  subtree_prompt: string;
  preserve_field_names?: string[] | null;
  next_step_id?: string | null;
}

export interface StatePromptTransformExecutionStep extends StateExecutionGraphStepBase {
  type: "prompt_transform";
  instruction: string;
  input_variable?: string | null;
  output_variable?: string | null;
  next_step_id?: string | null;
}

export interface StateFullPromptUpdateExecutionStep extends StateExecutionGraphStepBase {
  type: "full_prompt_update";
  next_step_id?: string | null;
}

export interface StateEndExecutionStep extends StateExecutionGraphStepBase {
  type: "end";
  message?: string;
  terminates_interaction?: boolean;
}

export type StateExecutionGraphStep =
  | StateCodeExecutionStep
  | StatePromptExtractExecutionStep
  | StateToolCallExecutionStep
  | StatePromptSubtreeUpdateExecutionStep
  | StatePromptTransformExecutionStep
  | StateFullPromptUpdateExecutionStep
  | StateEndExecutionStep;

export interface StateExecutionGraph {
  entry_step_id: string;
  steps: StateExecutionGraphStep[];
  max_steps?: number;
}

export interface StateCodePlan {
  rules: StateCodeRule[];
  prompt_extraction_plan?: StatePromptExtractionPlan;
  execution_graph?: StateExecutionGraph;
  fallback_to_prompt_when_no_rule_matches?: boolean;
}

export type PolicyCodeAction =
  | {
      kind: "display";
      message?: string;
      input_variable?: string;
      display_type?: "text" | "video";
      video_url?: string;
    }
  | { kind: "expand"; label: string }
  | { kind: "use_prompt" };

export interface PolicyCodeRule {
  when: ConditionPlan;
  ops?: StateCodeOperation[];
  action?: PolicyCodeAction | null;
  stop?: boolean;
}

export interface PolicyExecutionGraphStepBase {
  id: string;
  when?: ConditionPlan;
  else_step_id?: string | null;
  sourceNodeRefs?: CanvasExecutionSourceNodeRef[];
}

export interface PolicyCodeExecutionStep extends PolicyExecutionGraphStepBase {
  type: "code";
  rules: PolicyCodeRule[];
  default_action?: PolicyCodeAction;
  output_variable?: string | null;
  output_object_field_names?: string[] | null;
  language?: "dsl" | "typescript" | null;
  script_source?: string | null;
  next_step_id?: string | null;
  on_match_step_id?: string | null;
  on_no_match_step_id?: string | null;
  on_use_prompt_step_id?: string | null;
  on_error_step_id?: string | null;
}

export interface PolicyPromptExtractExecutionStep extends PolicyExecutionGraphStepBase {
  type: "prompt_extract";
  prompt_extraction_plan: StatePromptExtractionPlan;
  next_step_id?: string | null;
  on_value_step_id?: string | null;
  on_empty_step_id?: string | null;
}

export interface PolicyToolCallExecutionStep extends PolicyExecutionGraphStepBase {
  type: "tool_call";
  tool_name: string;
  result_variable?: string;
  input_object_variables?: string[];
  input_prompt_value_names?: string[] | null;
  next_step_id?: string | null;
  on_error_step_id?: string | null;
}

export interface PolicyPromptSubtreeDecisionExecutionStep extends PolicyExecutionGraphStepBase {
  type: "prompt_subtree_decision";
  subtree_prompt: string;
  output_variable?: string | null;
  prompt_extraction_plan?: StatePromptExtractionPlan;
  next_step_id?: string | null;
}

export interface PolicyPromptTransformExecutionStep extends PolicyExecutionGraphStepBase {
  type: "prompt_transform";
  instruction: string;
  input_variable?: string | null;
  output_variable?: string | null;
  next_step_id?: string | null;
}

export interface PolicyFullPromptDecisionExecutionStep extends PolicyExecutionGraphStepBase {
  type: "full_prompt_decision";
  next_step_id?: string | null;
}

export type PolicyRuntimeOperationName =
  | "read_async_job"
  | "await_async_job"
  | "build_default_primary_state_schema"
  | "build_default_environment_state_schema"
  | "build_initial_canvas_shape_materialization_requests"
  | "materialize_initial_canvas_structures"
  | "merge_materialized_initial_canvas_structures"
  | "prepare_canvas_rule_detection_requests"
  | "build_canvas_rule_repair_requests"
  | "apply_canvas_rule_repairs"
  | "prepare_canvas_rule_recheck_requests"
  | "finalize_canvas_rule_repair_pass"
  | "apply_structured_patch"
  | "scaffold_tools"
  | "sync_derived_prompts"
  | "repair_canvas_rules"
  | "finalize_assistant_reply"
  | "terminate_external_connection"
  | "raise_error";

export interface PolicyRuntimeOperationExecutionStep
  extends PolicyExecutionGraphStepBase {
  type: "runtime_operation";
  operation: PolicyRuntimeOperationName;
  message?: string | null;
  execution_mode?: "sync" | "async" | null;
  job_source_variable?: string | null;
  result_variable?: string | null;
  timeout_ms?: number | null;
  poll_interval_ms?: number | null;
  next_step_id?: string | null;
}

export type PolicyStageHandoffMode = "next_turn" | "immediate";

export interface PolicyStageHandoff {
  mode: PolicyStageHandoffMode;
  next_stage_id?: string | null;
  next_stage_name?: string | null;
}

export interface PolicyEndExecutionStep extends PolicyExecutionGraphStepBase {
  type: "end";
  message?: string;
  terminates_interaction?: boolean;
  stage_handoff?: PolicyStageHandoff | null;
}

export type PolicyExecutionGraphStep =
  | PolicyCodeExecutionStep
  | PolicyPromptExtractExecutionStep
  | PolicyToolCallExecutionStep
  | PolicyPromptSubtreeDecisionExecutionStep
  | PolicyPromptTransformExecutionStep
  | PolicyFullPromptDecisionExecutionStep
  | PolicyRuntimeOperationExecutionStep
  | PolicyEndExecutionStep;

export interface PolicyExecutionGraph {
  entry_step_id: string;
  steps: PolicyExecutionGraphStep[];
  max_steps?: number;
}

export interface PolicyCodePlan {
  rules: PolicyCodeRule[];
  default_action?: PolicyCodeAction;
  execution_graph?: PolicyExecutionGraph;
}

export interface PhaseExecutionPlan<TCodePlan> {
  mode: ExecutionMode;
  code_plan?: TCodePlan;
  reason?: string;
}

export interface HybridExecutionPlan {
  state: PhaseExecutionPlan<StateCodePlan>;
  policy: PhaseExecutionPlan<PolicyCodePlan>;
}

export interface ExecuteStateCodePlanResult {
  nextState: StateSnapshot;
  nextPromptValues: PromptValueSnapshot;
  matchedAnyRule: boolean;
}

export interface ExecutePolicyCodePlanResult {
  nextState: StateSnapshot;
  nextPromptValues: PromptValueSnapshot;
  action: PolicyCodeAction | null;
  matchedAnyRule: boolean;
}

export type PromptValueSnapshot = Record<string, unknown>;

export function defaultHybridExecutionPlan(): HybridExecutionPlan {
  return {
    state: { mode: "full_prompt", reason: "default fallback" },
    policy: { mode: "full_prompt", reason: "default fallback" },
  };
}

function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/[_\s]+/g, " ");
}

function toStateString(value: unknown, type: FieldType): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (type === "boolean") {
    if (typeof value === "boolean") {
      return value ? "Yes" : "";
    }
    if (typeof value === "string") {
      return /^(yes|true|1)$/i.test(value.trim()) ? "Yes" : "";
    }
    return "";
  }

  if (type === "string[]") {
    if (Array.isArray(value)) {
      return value
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0)
        .join(", ");
    }
    return typeof value === "string" ? value.trim() : String(value);
  }

  if (type === "integer" || type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return typeof value === "string" ? value.trim() : "";
  }

  if (type === "json") {
    if (typeof value === "string") {
      return value.trim();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return typeof value === "string" ? value.trim() : String(value);
}

function regexMatch(text: string, pattern: string, flags?: string): RegExpMatchArray | null {
  try {
    return text.match(new RegExp(pattern, flags));
  } catch {
    return null;
  }
}

function extractAgeFromText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const patterns = [
    /\b(\d{1,3})\s*(?:years?\s*old|yo|y\/o)\b/i,
    /\bage\s*(?:is|:)?\s*(\d{1,3})\b/i,
    /^\D*(\d{1,3})\D*$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const age = Number(match?.[1]);
    if (Number.isInteger(age) && age >= 0 && age <= 120) {
      return String(age);
    }
  }

  return null;
}

function extractGenderFromText(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (/\b(male|man|boy)\b/.test(normalized)) {
    return "male";
  }
  if (/\b(female|woman|girl)\b/.test(normalized)) {
    return "female";
  }
  if (/\b(nonbinary|non-binary|other|trans|transgender)\b/.test(normalized)) {
    return "other";
  }

  return null;
}

function findFieldType(stateSchema: RuntimeStateField[], fieldName: string): FieldType {
  return (
    stateSchema.find((field) => normalizeKey(field.fieldName) === normalizeKey(fieldName))?.type ??
    "string"
  );
}

function unknownAsComparableValue(value: unknown): string | number | boolean | string[] | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function fieldAsComparableValue(
  state: StateSnapshot,
  stateSchema: RuntimeStateField[],
  fieldName: string
): string | number | boolean | string[] | null {
  const type = findFieldType(stateSchema, fieldName);
  const raw = state[fieldName] ?? "";
  const trimmed = raw.trim();

  if (!trimmed) {
    return type === "string[]" ? [] : null;
  }

  if (type === "boolean") {
    return /^(yes|true|1)$/i.test(trimmed);
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
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "boolean" || typeof parsed === "number") {
        return parsed;
      }
      if (typeof parsed === "string") {
        return parsed.trim() || null;
      }
      if (Array.isArray(parsed)) {
        return parsed.every((item) => typeof item === "string")
          ? parsed.map((item) => item.trim()).filter((item) => item.length > 0)
          : JSON.stringify(parsed);
      }
      if (parsed && typeof parsed === "object") {
        return JSON.stringify(parsed);
      }
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function decodeStateValueSourceField(
  state: StateSnapshot,
  stateSchema: RuntimeStateField[],
  fieldName: string
): unknown {
  const type = findFieldType(stateSchema, fieldName);
  const raw = state[fieldName] ?? "";
  const trimmed = raw.trim();

  if (!trimmed) {
    return type === "string[]" ? [] : null;
  }

  if (type === "boolean") {
    return /^(yes|true|1)$/i.test(trimmed);
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

function promptValueAsComparableValue(
  promptValues: PromptValueSnapshot,
  name: string
): string | number | boolean | string[] | null {
  for (const [key, value] of Object.entries(promptValues)) {
    if (normalizeKey(key) === normalizeKey(name)) {
      return unknownAsComparableValue(value);
    }
  }

  return null;
}

function resolveAgentLatestObservation(promptValues: PromptValueSnapshot): string {
  const value = promptValueAsComparableValue(
    promptValues,
    AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME
  );
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value === null || value === undefined ? "" : String(value);
}

function evaluateCondition(
  condition: ConditionPlan | undefined,
  state: StateSnapshot,
  stateSchema: RuntimeStateField[],
  promptValues: PromptValueSnapshot = {}
): boolean {
  if (!condition) {
    return false;
  }

  const latestUserMessage = resolveAgentLatestObservation(promptValues);

  switch (condition.kind) {
    case "always":
      return true;
    case "all":
      return condition.conditions.every((entry) =>
        evaluateCondition(entry, state, stateSchema, promptValues)
      );
    case "any":
      return condition.conditions.some((entry) =>
        evaluateCondition(entry, state, stateSchema, promptValues)
      );
    case "not":
      return !evaluateCondition(condition.condition, state, stateSchema, promptValues);
    case "field_empty": {
      const value = String(state[condition.field] ?? "").trim();
      return value.length === 0;
    }
    case "field_not_empty": {
      const value = String(state[condition.field] ?? "").trim();
      return value.length > 0;
    }
    case "field_equals": {
      const value = fieldAsComparableValue(state, stateSchema, condition.field);
      return String(value ?? "").toLowerCase() === String(condition.value).toLowerCase();
    }
    case "field_not_equals": {
      const value = fieldAsComparableValue(state, stateSchema, condition.field);
      return String(value ?? "").toLowerCase() !== String(condition.value).toLowerCase();
    }
    case "field_includes": {
      const value = fieldAsComparableValue(state, stateSchema, condition.field);
      if (Array.isArray(value)) {
        return value.some((entry) => normalizeKey(entry) === normalizeKey(condition.value));
      }
      return String(value ?? "").toLowerCase().includes(condition.value.toLowerCase());
    }
    case "field_matches_regex": {
      const value = String(state[condition.field] ?? "");
      return regexMatch(value, condition.pattern, condition.flags) !== null;
    }
    case "field_gt":
    case "field_gte":
    case "field_lt":
    case "field_lte": {
      const value = fieldAsComparableValue(state, stateSchema, condition.field);
      const numeric = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numeric)) {
        return false;
      }
      if (condition.kind === "field_gt") return numeric > condition.value;
      if (condition.kind === "field_gte") return numeric >= condition.value;
      if (condition.kind === "field_lt") return numeric < condition.value;
      return numeric <= condition.value;
    }
    case "prompt_value_empty": {
      const value = promptValueAsComparableValue(promptValues, condition.name);
      if (Array.isArray(value)) {
        return value.length === 0;
      }
      return String(value ?? "").trim().length === 0;
    }
    case "prompt_value_not_empty": {
      const value = promptValueAsComparableValue(promptValues, condition.name);
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return String(value ?? "").trim().length > 0;
    }
    case "prompt_value_equals": {
      const value = promptValueAsComparableValue(promptValues, condition.name);
      return String(value ?? "").toLowerCase() === String(condition.value).toLowerCase();
    }
    case "prompt_value_not_equals": {
      const value = promptValueAsComparableValue(promptValues, condition.name);
      return String(value ?? "").toLowerCase() !== String(condition.value).toLowerCase();
    }
    case "prompt_value_includes": {
      const value = promptValueAsComparableValue(promptValues, condition.name);
      if (Array.isArray(value)) {
        return value.some((entry) => normalizeKey(entry) === normalizeKey(condition.value));
      }
      return String(value ?? "").toLowerCase().includes(condition.value.toLowerCase());
    }
    case "prompt_value_matches_regex": {
      const value = promptValueAsComparableValue(promptValues, condition.name);
      return regexMatch(String(value ?? ""), condition.pattern, condition.flags) !== null;
    }
    case "message_contains":
      return latestUserMessage.toLowerCase().includes(condition.value.toLowerCase());
    case "message_matches_regex":
      return regexMatch(latestUserMessage, condition.pattern, condition.flags) !== null;
    default:
      return false;
  }
}

export function evaluateStateCondition(
  condition: ConditionPlan | undefined,
  state: StateSnapshot,
  stateSchema: RuntimeStateField[],
  promptValues: PromptValueSnapshot = {}
): boolean {
  return evaluateCondition(condition, state, stateSchema, promptValues);
}

function resolveStateValueSource(
  source: StateValueSource,
  state: StateSnapshot,
  stateSchema: RuntimeStateField[],
  promptValues: PromptValueSnapshot = {},
  runtimeContext: StateCodeRuntimeContext = {}
): unknown {
  const latestUserMessage = resolveAgentLatestObservation(promptValues);

  switch (source.kind) {
    case "constant":
      return source.value;
    case "prompt_variable":
      return promptValueAsComparableValue(promptValues, source.name);
    case "current_build_snapshot":
      return decodeStateValueSourceField(state, stateSchema, "current_build");
    case "conversation_turns":
      return runtimeContext.conversationTurns ?? [];
    case "latest_user_turn":
      return runtimeContext.latestUserTurn ?? null;
    case "latest_assistant_turn":
      return runtimeContext.latestAssistantTurn ?? null;
    case "latest_observation_event":
      return runtimeContext.latestObservationEvent ?? null;
    case "latest_observation_and_reward_event":
      return runtimeContext.latestObservationAndRewardEvent ?? null;
    case "latest_primary_action_event":
      return runtimeContext.latestPrimaryActionEvent ?? null;
    case "agent_latest_observation":
      return latestUserMessage.trim();
    case "extract_age":
      return extractAgeFromText(latestUserMessage);
    case "extract_gender":
      return extractGenderFromText(latestUserMessage);
    case "regex_capture": {
      const match = regexMatch(latestUserMessage, source.pattern, source.flags);
      if (!match) {
        return null;
      }
      return match[source.group ?? 1] ?? null;
    }
    case "boolean_from_regex":
      return regexMatch(latestUserMessage, source.pattern, source.flags) !== null;
    default:
      return null;
  }
}

function applyStateCodeOperations(
  nextState: StateSnapshot,
  ops: StateCodeOperation[],
  stateSchema: RuntimeStateField[],
  promptValues: PromptValueSnapshot = {},
  runtimeContext: StateCodeRuntimeContext = {}
): PromptValueSnapshot {
  let nextPromptValues = { ...promptValues };

  for (const op of ops) {
    if (op.kind === "set_local") {
      if (op.only_if_empty) {
        const currentValue = promptValueAsComparableValue(nextPromptValues, op.name);
        if (
          (Array.isArray(currentValue) && currentValue.length > 0) ||
          (!Array.isArray(currentValue) && String(currentValue ?? "").trim().length > 0)
        ) {
          continue;
        }
      }

      nextPromptValues = {
        ...nextPromptValues,
        [op.name]: resolveStateValueSource(
          op.source,
          nextState,
          stateSchema,
          nextPromptValues,
          runtimeContext
        ),
      };
      continue;
    }

    const fieldType = findFieldType(stateSchema, op.field);

    if (op.kind === "clear_field") {
      nextState[op.field] = fieldType === "json" ? "[]" : "";
      continue;
    }

    if (op.kind === "append_list_item") {
      if (fieldType === "json") {
        let existingJsonItems: unknown[] = [];
        const rawExisting = String(nextState[op.field] ?? "").trim();
        if (rawExisting) {
          try {
            const parsed = JSON.parse(rawExisting);
            existingJsonItems = Array.isArray(parsed) ? parsed : [];
          } catch {
            existingJsonItems = [];
          }
        }

        const rawItems =
          op.source !== undefined
            ? resolveStateValueSource(
                op.source,
                nextState,
                stateSchema,
                nextPromptValues,
                runtimeContext
              )
            : op.value;
        const nextItems = Array.isArray(rawItems) ? rawItems : [rawItems];

        for (const candidate of nextItems) {
          if (candidate === null || candidate === undefined) {
            continue;
          }

          const normalizedCandidate =
            typeof candidate === "string"
              ? candidate.trim()
              : candidate;
          if (
            normalizedCandidate === "" ||
            (typeof normalizedCandidate === "object" &&
              !Array.isArray(normalizedCandidate) &&
              Object.keys(normalizedCandidate as Record<string, unknown>).length === 0)
          ) {
            continue;
          }

          if (
            !op.unique ||
            !existingJsonItems.some(
              (entry) => JSON.stringify(entry) === JSON.stringify(normalizedCandidate)
            )
          ) {
            existingJsonItems.push(normalizedCandidate);
          }
        }

        nextState[op.field] = JSON.stringify(existingJsonItems);
        continue;
      }

      const existing = String(nextState[op.field] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      const rawItems =
        op.source !== undefined
          ? resolveStateValueSource(
              op.source,
              nextState,
              stateSchema,
              nextPromptValues,
              runtimeContext
            )
          : op.value;
      const nextItems = Array.isArray(rawItems) ? rawItems : [rawItems];

      for (const candidate of nextItems) {
        const item = String(candidate ?? "").trim();
        if (!item) {
          continue;
        }
        if (!op.unique || !existing.some((entry) => normalizeKey(entry) === normalizeKey(item))) {
          existing.push(item);
        }
      }
      nextState[op.field] = existing.join(", ");
      continue;
    }

    if (op.kind === "set_field") {
      if (op.only_if_empty && String(nextState[op.field] ?? "").trim().length > 0) {
        continue;
      }

      const resolvedValueWithContext = resolveStateValueSource(
        op.source,
        nextState,
        stateSchema,
        nextPromptValues,
        runtimeContext
      );
      nextState[op.field] = toStateString(resolvedValueWithContext, fieldType);
    }
  }

  return nextPromptValues;
}

export function executeStateCodePlan(
  plan: StateCodePlan | undefined,
  currentState: StateSnapshot,
  stateSchema: RuntimeStateField[],
  promptValues: PromptValueSnapshot = {},
  runtimeContext: StateCodeRuntimeContext = {}
): ExecuteStateCodePlanResult {
  if (!plan) {
    return {
      nextState: currentState,
      nextPromptValues: promptValues,
      matchedAnyRule: false,
    };
  }

  const nextState = { ...currentState };
  let nextPromptValues = { ...promptValues };
  let matchedAnyRule = false;

  for (const rule of plan.rules ?? []) {
    if (
      !evaluateCondition(
        rule.when,
        nextState,
        stateSchema,
        nextPromptValues
      )
    ) {
      continue;
    }

    matchedAnyRule = true;
    nextPromptValues = applyStateCodeOperations(
      nextState,
      rule.ops ?? [],
      stateSchema,
      nextPromptValues,
      runtimeContext
    );

    if (rule.stop) {
      break;
    }
  }

  return { nextState, nextPromptValues, matchedAnyRule };
}

export function executePolicyCodePlan(
  plan: PolicyCodePlan | undefined,
  updatedState: StateSnapshot,
  stateSchema: RuntimeStateField[],
  promptValues: PromptValueSnapshot = {},
  runtimeContext: StateCodeRuntimeContext = {}
): ExecutePolicyCodePlanResult {
  if (!plan) {
    return {
      nextState: updatedState,
      nextPromptValues: promptValues,
      action: null,
      matchedAnyRule: false,
    };
  }

  const nextState = { ...updatedState };
  let nextPromptValues = { ...promptValues };
  let matchedAnyRule = false;

  for (const rule of plan.rules ?? []) {
    if (
      !evaluateCondition(
        rule.when,
        nextState,
        stateSchema,
        nextPromptValues
      )
    ) {
      continue;
    }

    matchedAnyRule = true;
    nextPromptValues = applyStateCodeOperations(
      nextState,
      rule.ops ?? [],
      stateSchema,
      nextPromptValues,
      runtimeContext
    );

    if (rule.action !== undefined && rule.action !== null) {
      return {
        nextState,
        nextPromptValues,
        action: rule.action,
        matchedAnyRule: true,
      };
    }

    if (rule.stop) {
      break;
    }
  }

  return {
    nextState,
    nextPromptValues,
    action: matchedAnyRule ? null : plan.default_action ?? null,
    matchedAnyRule,
  };
}

export function renderPolicyActionMessage(
  template: string,
  state: StateSnapshot,
  promptValues: PromptValueSnapshot = {}
): string {
  return template.replace(/\{([^}]+)\}/g, (_, rawKey: string) => {
    const key = rawKey.trim();
    const promptValue = promptValues[key];
    if (state[key] !== undefined) {
      return state[key] ?? "";
    }
    if (promptValue === null || promptValue === undefined) {
      return "";
    }
    if (typeof promptValue === "string") {
      return promptValue;
    }
    return JSON.stringify(promptValue);
  });
}

function summarizeCanvasEntry(entry: CanvasEntry): string {
  const nodeLines = entry.graph.nodes.map((node) => {
    const actionSubtype = getNodeActionSubtype(node);
    const actionType =
      node.type === "prompt" && actionSubtype !== "prompt"
        ? ` (${actionSubtype})`
        : node.type === "action" && typeof node.data?.actionType === "string"
          ? ` (${node.data.actionType})`
          : "";
    const runtimeOperationType =
      node.type === "read_async_job" ||
      node.type === "await_async_job" ||
      node.type === "apply_structured_patch" ||
      node.type === "build_initial_canvas_shape_materialization_requests" ||
      node.type === "materialize_initial_canvas_structures" ||
      node.type === "merge_materialized_initial_canvas_structures" ||
      node.type === "prepare_canvas_rule_detection_requests" ||
      node.type === "build_canvas_rule_repair_requests" ||
      node.type === "apply_canvas_rule_repairs" ||
      node.type === "prepare_canvas_rule_recheck_requests" ||
      node.type === "finalize_canvas_rule_repair_pass" ||
      node.type === "scaffold_tools" ||
      node.type === "sync_derived_prompts" ||
      node.type === "repair_canvas_rules" ||
      node.type === "finalize_assistant_reply" ||
      node.type === "raise_error"
        ? ` (${node.type})`
        : "";
    const label =
      actionSubtype === "display"
        ? node.data?.displayType === "video"
          ? String(node.data?.videoUrl ?? node.data?.label ?? "").trim() || "video"
          : String(node.data?.inputVariable ?? "carried_output").trim() || "carried_output"
        : String(node.data?.label ?? "").trim();
    return `- ${node.id}: ${node.type}${runtimeOperationType || actionType} :: ${label}`;
  });
  const edgeLines = entry.graph.edges.map((edge) => {
    const via = edge.sourceHandle ? ` [${edge.sourceHandle}]` : "";
    return `- ${edge.source}${via} -> ${edge.target}`;
  });

  return [
    `Canvas: ${entry.name || entry.id}`,
    "Nodes:",
    nodeLines.length > 0 ? nodeLines.join("\n") : "- (none)",
    "Edges:",
    edgeLines.length > 0 ? edgeLines.join("\n") : "- (none)",
  ].join("\n");
}

function summarizeCanvasDoc(doc: CanvasDoc | null): string {
  if (!doc || doc.canvases.length === 0) {
    return "(no canvas)";
  }
  return doc.canvases.map((entry) => summarizeCanvasEntry(entry)).join("\n\n");
}

function summarizeCompiledTools(doc: CanvasDoc | null): string {
  if (!doc) {
    return "- (none)";
  }

  const tools = compileCanvas(doc).tools ?? [];
  if (tools.length === 0) {
    return "- (none)";
  }

  return tools
    .map((tool) => {
      const description = tool.function.description ? `; description=${tool.function.description}` : "";
      return `- ${tool.function.name}: sourceType=${tool.config.sourceType}; url=${tool.config.url}${description}`;
    })
    .join("\n");
}

export function buildExecutionPlannerPrompt(args: {
  stateSchema: RuntimeStateField[];
  stateUpdatePrompt: string;
  policyExecutionPrompt: string;
  stateCanvasDoc: CanvasDoc | null;
  policyCanvasDoc: CanvasDoc | null;
  expandLabels: string[];
}): string {
  const stateSchemaText = args.stateSchema
    .map((field) => `- ${field.fieldName}: ${field.type} (initial: ${field.initialValue || "empty"})`)
    .join("\n");

  const expandLabelsText =
    args.expandLabels.length > 0 ? args.expandLabels.map((label) => `- ${label}`).join("\n") : "- (none)";

  return `You are an execution planner for a deterministic chat runtime.

The existing system already knows how to compile state and policy canvases into prompts. Do not rewrite or improve those prompts. Your job is only to decide whether each phase should run as:
- "full_prompt": keep using the already-compiled prompt
- "code": run deterministically using the supported JSON DSL with no prompt call for that phase
- "hybrid": use a bounded execution graph that can alternate between deterministic code, prompt extraction, and full state-prompt updates when needed

Important rules:
- Prefer "full_prompt" unless the logic is clearly deterministic.
- Use "code" only when the behavior can be represented exactly with the supported DSL.
- Use "hybrid" when some branches are deterministic but bounded prompt extraction, prompt transformation, or state update calls are still needed.
- For state, use "hybrid" when a bounded execution graph can combine deterministic \`code\` / \`tool_call\` / \`end\` steps with focused \`prompt_extract\`, \`prompt_transform\`, or \`prompt_subtree_update\` steps.
- If a state branch needs broad fallback to the compiled state prompt or cannot be expressed as bounded graph steps, choose \`full_prompt\` for the whole state phase.
- For state code mode, prefer returning \`execution_graph\` inside \`code_plan\`.
- For policy hybrid mode, prefer returning \`execution_graph\` inside \`code_plan\`.
- In a state execution graph, you may use \`code\`, \`prompt_extract\`, \`tool_call\`, \`prompt_transform\`, \`prompt_subtree_update\`, \`full_prompt_update\`, and \`end\` steps.
- In a policy execution graph, you may alternate between \`code\`, \`prompt_extract\`, \`tool_call\`, \`prompt_transform\`, \`full_prompt_decision\`, \`runtime_operation\`, and \`end\` steps.
- Use \`prompt_extract\` when the model should return intermediate values that later code steps consume.
- Use \`tool_call\` when a canvas tool should be executed directly by the runtime without an OpenAI tool call. This is especially appropriate for direct page retrieval tools.
- Use \`full_prompt_decision\` when the existing compiled policy prompt should produce an internal policy decision text. It must flow into a later DISPLAY step to become visible to the user.
- Use policy \`prompt_transform\` when a node should run as a model call over a local prompt value or state value instead of raw code. This is the right fit for \`prompt_transform\` action nodes and similar "rewrite / format / condense an existing value" behavior.
- Use state \`prompt_transform\` only when a state-canvas node should rewrite, summarize, format, or condense an existing local or state value for later steps. Ordinary state-field updates, including updating a summary field from the current observation, should stay as state prompt-update steps or prompt extraction plus code.
- Use \`runtime_operation\` when the policy graph should apply deterministic server-side post-processing to the reserved local variable \`carried_output\`, such as building default seeded schemas, applying a structured patch, scaffolding tools, recompiling derived prompts, repairing safe canvas-rule issues, or finalizing the assistant reply that a later DISPLAY step will publish.
- In compiled policy prompts, EXPAND nodes are already replaced with the referenced subtree they point to.
- A DISPLAY step is the only policy-graph step that publishes visible output to the user. Prompts, transforms, tools, runtime operations, ordinary code, and end steps only produce internal local values unless their result reaches DISPLAY.
- A Terminate canvas node is not an end-of-turn marker. It means the current task is complete and the whole live session or pairwise interaction must stop with no future turns.
- If a DISPLAY node follows a \`tool_call\`, show the tool output to the user.
- If a DISPLAY node follows a prompt-producing step such as \`prompt_transform\`, \`full_prompt_decision\`, or \`expand\`, show the local value that step produced. For prompt_transform, use its explicit \`output_variable\` when set; otherwise use legacy \`carried_output\`.
- TOOL CALL or open-ended medical / research reasoning should usually stay "full_prompt" or "hybrid".
- If you need prompt fallback inside policy code, use the action { "kind": "use_prompt" }.
- If a policy branch should intentionally run one referenced subtree as its own prompt step, use { "kind": "expand", "label": "<existing label>" }.
- More generally, when a policy node or subtree cannot be represented exactly as direct code or \`tool_call\`, prefer a prompt-producing step (\`prompt_transform\`, \`full_prompt_decision\`, or \`expand\`) instead of forcing a lossy deterministic encoding.
- Return JSON only.

Supported condition DSL:
- always
- all / any / not
- field_empty / field_not_empty
- field_equals / field_not_equals
- field_includes
- field_matches_regex
- field_gt / field_gte / field_lt / field_lte
- prompt_value_empty / prompt_value_not_empty
- prompt_value_equals / prompt_value_not_equals
- prompt_value_includes
- prompt_value_matches_regex
- message_contains
- message_matches_regex

Supported state code ops:
- set_field with sources:
  - constant
  - prompt_variable
- agent_latest_observation
  - extract_age
  - extract_gender
  - regex_capture
  - boolean_from_regex
- set_local with the same supported sources as set_field
- clear_field
- append_list_item with either a literal value or a source

Supported prompt extraction plan:
- prompt_extraction_plan.fields[]
- Each field needs:
  - name
  - type
  - instruction
- Use this when the model should extract an intermediate value for deterministic code to use later.

Supported state execution graph:
- code_plan.execution_graph
- It must be bounded with:
  - entry_step_id
  - max_steps
  - steps[]
- Supported step types:
  - code
  - prompt_extract
  - tool_call
  - prompt_transform
  - prompt_subtree_update
  - full_prompt_update
  - end
- Each step may also include:
  - when
  - else_step_id
- code steps support:
  - rules
  - next_step_id
  - on_match_step_id
  - on_no_match_step_id
- tool_call steps support:
  - tool_name
  - result_variable
  - next_step_id
  - on_error_step_id
- A state tool_call step may only use a compiled tool listed below. It executes the tool directly and stores the result in \`result_variable\`.
- prompt_transform steps support:
  - instruction
  - input_variable
  - output_variable
  - next_step_id
- State prompt_transform steps read \`input_variable\` (default \`carried_output\`) from local values or current state fields, run a model call, and define \`output_variable\` with the transformed result. When \`output_variable\` is omitted, keep legacy behavior by updating \`carried_output\`. They do not directly update state fields.
- prompt_subtree_update and full_prompt_update steps support:
  - next_step_id
- If any state branch would need broad prompt reasoning outside a bounded graph step, choose \`full_prompt\` for state instead.

Supported policy execution graph:
- code_plan.execution_graph
- It must be bounded with:
  - entry_step_id
  - max_steps
  - steps[]
- Supported step types:
  - code
  - prompt_extract
  - tool_call
  - prompt_transform
  - full_prompt_decision
  - runtime_operation
  - end
- Each step may also include:
  - when
  - else_step_id
- code steps support:
  - rules
  - default_action
  - next_step_id
  - on_match_step_id
  - on_no_match_step_id
  - on_use_prompt_step_id
- Each policy code rule may include:
  - when
  - optional ops
  - optional action
  - optional stop
- Policy code steps may mutate state deterministically using the same ops DSL as state code, and later policy steps see that updated state.
- prompt_extract steps support:
  - prompt_extraction_plan
  - next_step_id
  - on_value_step_id
  - on_empty_step_id
- tool_call steps support:
  - tool_name
  - result_variable
  - next_step_id
  - on_error_step_id
- A policy tool_call step may only use a compiled tool listed below. It executes the tool directly, stores the structured result in \`result_variable\`, and also writes a normalized string version into the reserved local variable \`carried_output\`.
- When a policy \`tool_call\` fetches external content, prefer setting \`on_error_step_id\` to an explicit recovery step that displays a user-facing error such as "There was an error in fetching.".
- prompt_transform steps support:
  - instruction
  - input_variable
  - output_variable
  - next_step_id
- prompt_transform steps read \`input_variable\` (default \`carried_output\`) from local values or current state fields, run a model call, and define \`output_variable\` with the transformed assistant reply. When \`output_variable\` is omitted, keep legacy behavior by updating \`carried_output\`.
- If a \`prompt_transform\` action node follows a tool call or another prompt-producing node, prefer representing it as a \`prompt_transform\` step instead of leaving it as prompt text alone.
- full_prompt_decision steps support:
  - next_step_id
- full_prompt_decision steps call the existing compiled policy prompt and produce internal decision text. The result is written into \`carried_output\` and must flow to DISPLAY if it should be visible.
- runtime_operation steps support:
  - operation
  - next_step_id
  - optional message
- For queueable runtime operations, you may also set:
  - execution_mode
  - result_variable
- Use \`execution_mode: "async"\` only for substantive runtime work that can safely resume later. Keep \`read_async_job\`, \`await_async_job\`, \`apply_structured_patch\`, and \`raise_error\` synchronous.
- For async-job runtime operations, you may also set:
  - job_source_variable
  - result_variable
  - optional timeout_ms
  - optional poll_interval_ms
- Supported policy runtime operations include \`read_async_job\`, \`await_async_job\`, \`build_default_primary_state_schema\`, \`build_default_environment_state_schema\`, \`build_initial_canvas_shape_materialization_requests\`, \`materialize_initial_canvas_structures\`, \`merge_materialized_initial_canvas_structures\`, \`prepare_canvas_rule_detection_requests\`, \`build_canvas_rule_repair_requests\`, \`apply_canvas_rule_repairs\`, \`prepare_canvas_rule_recheck_requests\`, \`finalize_canvas_rule_repair_pass\`, \`apply_structured_patch\`, \`scaffold_tools\`, \`sync_derived_prompts\`, \`repair_canvas_rules\`, \`finalize_assistant_reply\`, \`terminate_external_connection\`, and \`raise_error\`.
- Use \`raise_error\` when the graph should abort immediately with an explicit runtime error message instead of silently continuing down an impossible branch.
- runtime_operation steps run deterministic post-processing over the current \`carried_output\` value while keeping that reserved local variable available for later \`prompt_transform\` or \`end\` steps.
- end steps may optionally include:
  - message
- Use \`terminates_interaction: true\` on an \`end\` step only for a Terminate canvas node. That flag means the interaction is permanently over for this session/connection with no future turns, not merely that the current turn's graph is done.
- If an \`end\` step has a \`message\`, that rendered template becomes internal graph output only; it is not visible unless a DISPLAY step has already published output.
- The policy action \`display\` is reserved for lowering actual canvas Display nodes. Do not use it for ordinary Code nodes, branching, or loop routing. Action \`expand\` produces internal carried text that must flow to DISPLAY if it should be visible.
- A policy code rule may omit \`action\` when it only needs to mutate state and continue.
- If a code step returns \`use_prompt\`, continue with \`on_use_prompt_step_id\` or \`next_step_id\`.
- If you use prompt steps in the graph, the policy mode should be "hybrid".

Supported policy code actions:
- display (reserved for lowered canvas Display nodes)
- expand
- use_prompt

Return JSON with this shape:
{
  "state": {
    "mode": "full_prompt" | "code",
    "reason": "short explanation",
    "code_plan": {
      "execution_graph": {
        "entry_step_id": "apply-rules",
        "max_steps": 4,
        "steps": [
          {
            "id": "apply-rules",
            "type": "code",
            "rules": [
              {
                "when": { "kind": "message_matches_regex", "pattern": "\\\\bsearch\\\\b", "flags": "i" },
                "ops": [
                  {
                    "kind": "set_field",
                    "field": "search_requested",
                    "source": { "kind": "constant", "value": true }
                  }
                ]
              }
            ],
            "next_step_id": "end"
          },
          {
            "id": "end",
            "type": "end"
          }
        ]
      }
    }
  },
  "policy": {
    "mode": "full_prompt" | "code" | "hybrid",
    "reason": "short explanation",
    "code_plan": {
      "execution_graph": {
        "entry_step_id": "check-known-branches",
        "max_steps": 5,
        "steps": [
          {
            "id": "check-known-branches",
            "type": "code",
            "rules": [
              {
                "when": { "kind": "field_equals", "field": "search_requested", "value": true },
                "action": { "kind": "display" }
              }
            ],
            "default_action": { "kind": "use_prompt" },
            "on_match_step_id": "fetch-search-results",
            "on_use_prompt_step_id": "fallback-policy-prompt"
          },
          {
            "id": "fetch-search-results",
            "type": "tool_call",
            "tool_name": "fetch_search_results",
            "result_variable": "search_results",
            "next_step_id": "format-search-results",
            "on_error_step_id": "fetch-error"
          },
          {
            "id": "format-search-results",
            "type": "prompt_transform",
            "instruction": "Return only paper titles",
            "next_step_id": "show-search-results"
          },
          {
            "id": "show-search-results",
            "type": "end"
          },
          {
            "id": "fetch-error",
            "type": "end",
            "message": "There was an error in fetching."
          },
          {
            "id": "fallback-policy-prompt",
            "type": "full_prompt_decision"
          }
        ]
      }
    }
  }
}

State schema:
${stateSchemaText}

Available expansion labels:
${expandLabelsText}

Existing compiled state update prompt:
${args.stateUpdatePrompt}

State canvas summary:
${summarizeCanvasDoc(args.stateCanvasDoc)}

State canvas tools:
${summarizeCompiledTools(args.stateCanvasDoc)}

Existing compiled policy prompt:
${args.policyExecutionPrompt}

Policy canvas summary:
${summarizeCanvasDoc(args.policyCanvasDoc)}

Policy canvas tools:
${summarizeCompiledTools(args.policyCanvasDoc)}`;
}

function normalizeExecutionMode(value: unknown): ExecutionMode {
  return value === "code" || value === "hybrid" ? value : "full_prompt";
}

function parseStateCodePlan(raw: unknown): StateCodePlan | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const plan = raw as Record<string, unknown>;
  return {
    rules: Array.isArray(plan.rules) ? (plan.rules as StateCodeRule[]) : [],
    prompt_extraction_plan:
      plan.prompt_extraction_plan && typeof plan.prompt_extraction_plan === "object"
        ? (plan.prompt_extraction_plan as StatePromptExtractionPlan)
        : undefined,
    execution_graph:
      plan.execution_graph && typeof plan.execution_graph === "object"
        ? (plan.execution_graph as StateExecutionGraph)
        : undefined,
    fallback_to_prompt_when_no_rule_matches:
      typeof plan.fallback_to_prompt_when_no_rule_matches === "boolean"
        ? plan.fallback_to_prompt_when_no_rule_matches
        : undefined,
  };
}

function parsePolicyCodePlan(raw: unknown): PolicyCodePlan | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const plan = raw as Record<string, unknown>;
  return {
    rules: Array.isArray(plan.rules) ? (plan.rules as PolicyCodeRule[]) : [],
    execution_graph:
      plan.execution_graph && typeof plan.execution_graph === "object"
        ? (plan.execution_graph as PolicyExecutionGraph)
        : undefined,
    default_action:
      plan.default_action && typeof plan.default_action === "object"
        ? (plan.default_action as PolicyCodeAction)
        : undefined,
  };
}

export function parseExecutionPlannerReply(text: string): HybridExecutionPlan | null {
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const state = parsed.state && typeof parsed.state === "object"
      ? (parsed.state as Record<string, unknown>)
      : {};
    const policy = parsed.policy && typeof parsed.policy === "object"
      ? (parsed.policy as Record<string, unknown>)
      : {};

    return {
      state: {
        mode: normalizeExecutionMode(state.mode),
        reason: typeof state.reason === "string" ? state.reason : undefined,
        code_plan: parseStateCodePlan(state.code_plan),
      },
      policy: {
        mode: normalizeExecutionMode(policy.mode),
        reason: typeof policy.reason === "string" ? policy.reason : undefined,
        code_plan: parsePolicyCodePlan(policy.code_plan),
      },
    };
  } catch {
    return null;
  }
}
