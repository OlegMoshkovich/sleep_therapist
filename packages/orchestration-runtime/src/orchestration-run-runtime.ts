import OpenAI from "openai";

import { compileCanvas } from "@airlab/canvas-compiler/compiler";
import type { CanvasDoc, CompiledToolDef } from "@airlab/canvas-compiler/types";
import type {
  ToolDispatchConfig,
  ToolDispatchContext,
  ToolDispatchResult,
} from "@airlab/canvas-compiler/tool-types";
import type {
  FieldType,
  HybridExecutionPlan,
  PromptValueSnapshot,
  RuntimeStateField,
  StatePromptExtractionField,
  StatePromptExtractionPlan,
  StateSnapshot,
} from "@airlab/canvas-planner/canvas-hybrid-runtime";
import type { PolicyExecutionGraphRuntimeArgs } from "./policy-execution-graph-runtime";
import type {
  OrchestrationField,
  OrchestrationFieldType,
} from "@airlab/orchestration-core/general-orchestration";
import { runAsyncJobPolicyRuntimeStep } from "./async-job-policy-runtime";
import {
  buildAsyncRuntimeJobPromptValueUpdates,
  isAsyncRuntimeJobResult,
} from "./async-job-runtime";
import { extractFirstJsonObject } from "./json-object-extraction";

export type { StateSnapshot } from "@airlab/canvas-planner/canvas-hybrid-runtime";

export type OrchestrationRunToolDispatchExecutor = (
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  context?: ToolDispatchContext
) => Promise<ToolDispatchResult>;

let orchestrationRunOpenAiModel = "";
let orchestrationRunToolDispatchExecutor:
  | OrchestrationRunToolDispatchExecutor
  | null = null;

export function registerOrchestrationRunOpenAiModel(model: string): void {
  orchestrationRunOpenAiModel = model.trim();
}

export function registerOrchestrationRunToolDispatchExecutor(
  executor: OrchestrationRunToolDispatchExecutor | null
): void {
  orchestrationRunToolDispatchExecutor = executor;
}

function getOrchestrationRunOpenAiModel(): string {
  if (!orchestrationRunOpenAiModel) {
    throw new Error("Orchestration run OpenAI model has not been registered.");
  }
  return orchestrationRunOpenAiModel;
}

async function dispatchOrchestrationRunTool(
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  context?: ToolDispatchContext
): Promise<ToolDispatchResult> {
  if (!orchestrationRunToolDispatchExecutor) {
    throw new Error(
      "Orchestration run tool dispatch executor has not been registered."
    );
  }
  return orchestrationRunToolDispatchExecutor(config, args, context);
}

export interface OrchestrationRunRuntimeConfigBase {
  stateSchema: RuntimeStateField[];
  stateUpdateSystemPrompt: string;
  policyExecutionSystemPrompt: string;
  expandSystemPromptsByKey: Record<string, string>;
  toolsByName: Record<string, CompiledToolDef>;
  executionPlan: HybridExecutionPlan;
}

export function normalizeExpandKey(label: string): string {
  return label.trim().toLowerCase().replace(/[_\s]+/g, " ");
}

function extractCanvasGeneralPromptsFromPolicy(
  policyPrompt: string
): Record<string, string> {
  const promptsByKey: Record<string, string> = {};
  const pattern =
    /###\s*Canvas:\s*([^\n]+)[\s\S]*?General-purpose prompt:\s*([\s\S]*?)(?:\nFlow:|\n###\s*Canvas:|$)/gi;
  const matches = policyPrompt.matchAll(pattern);

  for (const match of matches) {
    const canvasName = match[1]?.trim() ?? "";
    const generalPrompt = match[2]?.trim() ?? "";
    if (!canvasName || !generalPrompt) {
      continue;
    }
    promptsByKey[normalizeExpandKey(canvasName)] = generalPrompt;
  }

  return promptsByKey;
}

function extractCanvasPolicyPromptsFromPolicy(
  policyPrompt: string
): Record<string, string> {
  const promptsByKey: Record<string, string> = {};
  const pattern = /###\s*Canvas:\s*([^\n]+)\n([\s\S]*?)(?=\n###\s*Canvas:|$)/gi;
  const matches = policyPrompt.matchAll(pattern);

  for (const match of matches) {
    const canvasName = match[1]?.trim() ?? "";
    const canvasPrompt = match[2]?.trim() ?? "";
    if (!canvasName || !canvasPrompt) {
      continue;
    }
    promptsByKey[normalizeExpandKey(canvasName)] = canvasPrompt;
  }

  return promptsByKey;
}

export function buildExpandSystemPromptsByKey(args: {
  policyCanvasDoc: CanvasDoc | null;
  policyPrompt: string;
}): Record<string, string> {
  const compiledPolicyPrompt = args.policyCanvasDoc
    ? compileCanvas(args.policyCanvasDoc).output
    : args.policyPrompt;
  const promptsByCanvasName =
    extractCanvasPolicyPromptsFromPolicy(compiledPolicyPrompt);
  const generalPromptsByCanvasName =
    extractCanvasGeneralPromptsFromPolicy(compiledPolicyPrompt);
  const promptsByKey: Record<string, string> = {};
  const orderedCanvases = args.policyCanvasDoc?.canvases ?? [];

  for (const canvas of orderedCanvases) {
    const canvasKey = normalizeExpandKey(canvas.name);
    const prompt =
      promptsByCanvasName[canvasKey] ?? generalPromptsByCanvasName[canvasKey];
    if (prompt) {
      promptsByKey[canvasKey] = prompt;
    }
  }

  const legacyExpandLabels = Array.from(
    new Set(
      orderedCanvases.flatMap((canvas) =>
        canvas.graph.nodes
          .map((node) =>
            node.type === "expand" && typeof node.data?.label === "string"
              ? node.data.label.trim()
              : ""
          )
          .filter((label) => label.length > 0)
      )
    )
  );
  const secondaryCanvases = orderedCanvases.slice(1);
  let secondaryIndex = 0;

  for (const label of legacyExpandLabels) {
    const labelKey = normalizeExpandKey(label);
    if (promptsByKey[labelKey]) {
      continue;
    }

    const fallbackCanvas = secondaryCanvases[secondaryIndex];
    if (!fallbackCanvas) {
      break;
    }

    const fallbackKey = normalizeExpandKey(fallbackCanvas.name);
    const fallbackPrompt =
      promptsByCanvasName[fallbackKey] ?? generalPromptsByCanvasName[fallbackKey];
    if (!fallbackPrompt) {
      continue;
    }

    promptsByKey[labelKey] = fallbackPrompt;
    secondaryIndex += 1;
  }

  return {
    ...promptsByCanvasName,
    ...promptsByKey,
  };
}

export function compileToolsByName(
  ...docs: Array<CanvasDoc | null>
): Record<string, CompiledToolDef> {
  const toolsByName = new Map<string, CompiledToolDef>();

  for (const doc of docs) {
    if (!doc) {
      continue;
    }

    for (const tool of compileCanvas(doc).tools ?? []) {
      const name = tool.function.name.trim();
      if (!name) {
        continue;
      }
      toolsByName.set(name, tool);
    }
  }

  return Object.fromEntries(toolsByName.entries());
}

export function replaceStateSnapshot(
  target: StateSnapshot,
  next: StateSnapshot
): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, next);
}

export function normalizeStateValueForBlock(
  value: unknown,
  type: OrchestrationFieldType
): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (type === "boolean") {
    if (typeof value === "boolean") {
      return value ? "Yes" : "";
    }
    if (typeof value === "string") {
      return /^(true|yes)$/i.test(value.trim()) ? "Yes" : "";
    }
    return "";
  }

  if (type === "string[]") {
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === "string" ? item.trim() : String(item)))
        .filter((item) => item.length > 0)
        .join(", ");
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
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
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === "string") {
      return value.trim();
    }
    return "";
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

export function buildInitialStateSnapshot(
  fields: OrchestrationField[]
): StateSnapshot {
  return fields.reduce<StateSnapshot>((acc, field) => {
    acc[field.name] = normalizeStateValueForBlock(field.initialValue, field.type);
    return acc;
  }, {});
}

export function toJsonStateValue(
  value: string,
  type: OrchestrationFieldType
): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return type === "string[]" ? [] : null;
  }

  if (type === "boolean") {
    return /^(yes|true)$/i.test(trimmed);
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
      .filter(Boolean);
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

export function renderStateJson(
  state: StateSnapshot,
  fields: OrchestrationField[]
): string {
  const payload = fields.reduce<Record<string, unknown>>((acc, field) => {
    acc[field.name] = toJsonStateValue(state[field.name] ?? "", field.type);
    return acc;
  }, {});

  return JSON.stringify(payload, null, 2);
}

export function buildRuntimeStateSchema(
  fields: OrchestrationField[]
): RuntimeStateField[] {
  return fields.map((field) => ({
    fieldName: field.name,
    type: field.type,
    initialValue: field.initialValue,
  }));
}

function normalizePromptExtractionFieldType(value: unknown): FieldType {
  return value === "integer" ||
    value === "boolean" ||
    value === "string[]" ||
    value === "number" ||
    value === "json"
    ? value
    : "string";
}

export function normalizePromptExtractionFields(
  promptPlan: StatePromptExtractionPlan | undefined
): StatePromptExtractionField[] {
  if (!promptPlan || !Array.isArray(promptPlan.fields)) {
    return [];
  }

  return promptPlan.fields
    .map((field) => ({
      name: typeof field?.name === "string" ? field.name.trim() : "",
      type: normalizePromptExtractionFieldType(field?.type),
      instruction:
        typeof field?.instruction === "string" ? field.instruction.trim() : "",
    }))
    .filter((field) => field.name.length > 0 && field.instruction.length > 0);
}

export function renderPromptExtractionFieldShape(
  field: StatePromptExtractionField
): string {
  switch (field.type) {
    case "boolean":
      return "boolean | null";
    case "integer":
      return "integer | null";
    case "number":
      return "number | null";
    case "string[]":
      return "string[] | null";
    case "json":
      return "json | null";
    case "string":
    default:
      return "string | null";
  }
}

export function renderPromptExtractionInstruction(
  fields: StatePromptExtractionField[]
): string {
  const lines =
    fields.length > 0
      ? fields.map(
          (field) =>
            `  ${JSON.stringify(field.name)}: ${renderPromptExtractionFieldShape(field)}`
        )
      : ["  ..."];

  return [
    "Return exactly a JSON object of this form and nothing else:",
    "{",
    lines.join(",\n"),
    "}",
  ].join("\n");
}

export function renderPolicyDecisionExtractionInstruction(
  fields: StatePromptExtractionField[],
  assistantReplyShape: "string" | { kind: "json"; shape: string } = "string"
): string {
  const assistantReplyLine =
    typeof assistantReplyShape === "object"
      ? `  "assistant_reply": ${assistantReplyShape.shape}`
      : '  "assistant_reply": string';
  const lines = [
    assistantReplyLine,
    ...fields.map(
      (field) =>
        `  ${JSON.stringify(field.name)}: ${renderPromptExtractionFieldShape(field)}`
    ),
  ];

  return [
    "Return exactly a JSON object of this form and nothing else:",
    "{",
    lines.join(",\n"),
    "}",
  ].join("\n");
}

export function normalizePromptExtractionValue(
  rawValue: unknown,
  type: FieldType
): unknown {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }

  if (type === "boolean") {
    if (typeof rawValue === "boolean") {
      return rawValue;
    }
    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim().toLowerCase();
      if (trimmed === "true" || trimmed === "yes") return true;
      if (trimmed === "false" || trimmed === "no") return false;
    }
    return null;
  }

  if (type === "integer") {
    const numeric =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string"
          ? Number.parseInt(rawValue.trim(), 10)
          : Number.NaN;
    return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
  }

  if (type === "number") {
    const numeric =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string"
          ? Number(rawValue.trim())
          : Number.NaN;
    return Number.isFinite(numeric) ? numeric : null;
  }

  if (type === "string[]") {
    if (Array.isArray(rawValue)) {
      return rawValue
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0);
    }

    const text = String(rawValue).trim();
    return text.length > 0 ? [text] : [];
  }

  if (type === "json") {
    if (
      typeof rawValue === "boolean" ||
      typeof rawValue === "number" ||
      typeof rawValue === "string" ||
      Array.isArray(rawValue) ||
      (rawValue !== null && typeof rawValue === "object")
    ) {
      if (typeof rawValue !== "string") {
        return rawValue;
      }

      const text = rawValue.trim();
      if (!text) {
        return null;
      }

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }

    return null;
  }

  const text = String(rawValue).trim();
  return text.length > 0 ? text : null;
}

export function parseStatePromptExtractionReply(
  text: string,
  promptPlan: StatePromptExtractionPlan | undefined
): PromptValueSnapshot | null {
  const fields = normalizePromptExtractionFields(promptPlan);
  if (fields.length === 0) {
    return null;
  }

  const objectText = extractFirstJsonObject(text);
  if (!objectText) {
    if (fields.length === 1 && fields[0]?.type === "boolean") {
      const trimmed = text.trim().replace(/^`+|`+$/g, "").trim();
      if (/^(true|yes|1)$/i.test(trimmed)) {
        return { [fields[0].name]: true };
      }
      if (/^(false|no|0)$/i.test(trimmed)) {
        return { [fields[0].name]: false };
      }
    }
    return null;
  }

  try {
    const parsed = JSON.parse(objectText) as Record<string, unknown>;
    return fields.reduce<PromptValueSnapshot>((acc, field) => {
      acc[field.name] = normalizePromptExtractionValue(
        parsed[field.name],
        field.type
      );
      return acc;
    }, {});
  } catch {
    return null;
  }
}

function normalizeAssistantReplyValue(rawValue: unknown): string {
  if (typeof rawValue === "string") {
    return rawValue.trim();
  }
  if (rawValue === null || rawValue === undefined) {
    return "";
  }
  try {
    return JSON.stringify(rawValue);
  } catch {
    return String(rawValue);
  }
}

export function parsePolicyDecisionExtractionReply(
  text: string,
  promptPlan: StatePromptExtractionPlan | undefined
): { assistantReply: string; promptValues: PromptValueSnapshot | null } {
  const objectText = extractFirstJsonObject(text);
  if (!objectText) {
    return {
      assistantReply: text.trim(),
      promptValues: parseStatePromptExtractionReply(text, promptPlan),
    };
  }

  try {
    const parsed = JSON.parse(objectText) as Record<string, unknown>;
    const fields = normalizePromptExtractionFields(promptPlan);
    const promptValues =
      fields.length > 0
        ? fields.reduce<PromptValueSnapshot>((acc, field) => {
            acc[field.name] = normalizePromptExtractionValue(
              parsed[field.name],
              field.type
            );
            return acc;
          }, {})
        : null;

    return {
      assistantReply: normalizeAssistantReplyValue(parsed.assistant_reply),
      promptValues,
    };
  } catch {
    return {
      assistantReply: text.trim(),
      promptValues: null,
    };
  }
}

export function parseStateUpdateReply(
  text: string,
  fields: OrchestrationField[],
  fallbackState: StateSnapshot
): StateSnapshot {
  const objectText = extractFirstJsonObject(text);
  if (!objectText) {
    return fallbackState;
  }

  try {
    const parsed = JSON.parse(objectText) as Record<string, unknown>;
    return fields.reduce<StateSnapshot>((acc, field) => {
      const rawValue = parsed[field.name];
      acc[field.name] =
        rawValue === undefined
          ? fallbackState[field.name] ?? ""
          : normalizeStateValueForBlock(rawValue, field.type);
      return acc;
    }, {});
  } catch {
    return fallbackState;
  }
}

export async function runPrompt(
  openai: OpenAI,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<string> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (systemPrompt.trim()) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({ role: "user", content: userPrompt });

  const completion = await openai.chat.completions.create({
    model: getOrchestrationRunOpenAiModel(),
    max_completion_tokens: maxTokens,
    messages,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "";
}

export function formatPromptValuesJson(
  promptValues?: PromptValueSnapshot
): string {
  return promptValues && Object.keys(promptValues).length > 0
    ? JSON.stringify(promptValues, null, 2)
    : "(none)";
}

function parseToolInputContribution(
  value: unknown
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buildDirectToolArgs(
  tool: CompiledToolDef,
  inputContributions: unknown[] | undefined
): Record<string, unknown> {
  const allowedKeys = new Set(
    Object.keys(tool.function.parameters?.properties ?? {})
  );
  const merged: Record<string, unknown> = {};

  for (const contribution of inputContributions ?? []) {
    const parsed = parseToolInputContribution(contribution);
    if (!parsed) {
      continue;
    }

    for (const [key, value] of Object.entries(parsed)) {
      if (allowedKeys.size > 0 && !allowedKeys.has(key)) {
        continue;
      }
      merged[key] = value;
    }
  }

  return merged;
}

function getToolResultVariableName(
  toolName: string,
  resultVariable: string | undefined
): string {
  const normalized = resultVariable?.trim();
  return normalized && normalized.length > 0 ? normalized : toolName;
}

export async function runDirectCanvasTool(args: {
  toolsByName: Record<string, CompiledToolDef>;
  toolName: string;
  resultVariable?: string;
  inputContributions?: unknown[];
  /**
   * Caller-supplied dispatch identity (setupTable/setupId/userId, callbacks).
   * Without it, tools that persist or read setup-row data (knowledge_save,
   * dataset_read) fail with a context error while pure fetch tools still work.
   */
  dispatchContext?: Omit<ToolDispatchContext, "toolName">;
}): Promise<PromptValueSnapshot> {
  const normalizedToolName = args.toolName.trim();
  const tool = args.toolsByName[normalizedToolName];
  if (!tool) {
    throw new Error(`No compiled tool found for "${normalizedToolName}".`);
  }

  const toolArgs = buildDirectToolArgs(tool, args.inputContributions);
  const result = await dispatchOrchestrationRunTool(tool.config, toolArgs, {
    awaitOpenClawCompletion: true,
    ...args.dispatchContext,
    toolName: normalizedToolName,
  });

  if (!result.ok) {
    throw new Error(
      `Direct tool "${normalizedToolName}" failed: ${result.error ?? "Unknown error"}.`
    );
  }

  if (isAsyncRuntimeJobResult(result.data)) {
    return buildAsyncRuntimeJobPromptValueUpdates(
      getToolResultVariableName(normalizedToolName, args.resultVariable),
      result.data,
      tool.config.asyncContinuationPolicy
    );
  }

  return {
    [getToolResultVariableName(normalizedToolName, args.resultVariable)]:
      result.data ?? "",
  };
}

export function createPolicyRuntimeOperationHandler(messages: {
  raiseErrorFallback: string;
  unsupportedOperation: (operation: string) => string;
}): NonNullable<PolicyExecutionGraphRuntimeArgs["runRuntimeOperation"]> {
  return async (step, incomingOutput, promptValues, currentState) => {
    const asyncJobResult = await runAsyncJobPolicyRuntimeStep({
      step,
      promptValues,
      onCompletedRuntimeOperationJob: async (_jobId, result) => {
        if (result.runtime !== "chat") {
          return;
        }
        const nextState =
          result.contextSnapshot &&
          typeof result.contextSnapshot === "object" &&
          !Array.isArray(result.contextSnapshot) &&
          result.contextSnapshot.currentState &&
          typeof result.contextSnapshot.currentState === "object" &&
          !Array.isArray(result.contextSnapshot.currentState)
            ? (result.contextSnapshot.currentState as StateSnapshot)
            : null;
        if (nextState) {
          replaceStateSnapshot(currentState, nextState);
        }
      },
    });
    if (asyncJobResult) {
      return asyncJobResult;
    }

    if (
      step.operation === "sync_derived_prompts" ||
      step.operation === "finalize_assistant_reply"
    ) {
      return {
        output: incomingOutput,
        promptValues,
      };
    }

    if (step.operation === "raise_error") {
      throw new Error(
        typeof step.message === "string" && step.message.trim()
          ? step.message.trim()
          : messages.raiseErrorFallback
      );
    }

    throw new Error(messages.unsupportedOperation(step.operation));
  };
}
