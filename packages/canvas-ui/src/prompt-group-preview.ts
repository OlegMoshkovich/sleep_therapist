import { hasConversationMemoryFieldNames } from "@airlab/canvas-core/lib/conversation-memory";
import { CARRIED_OUTPUT_PROMPT_VALUE_NAME } from "@airlab/canvas-core/lib/canvas-flow-values";
import type { StatePromptExtractionField } from "@airlab/canvas-planner/canvas-hybrid-runtime";
import type { StructuralPromptGroup } from "@airlab/canvas-planner/canvas-structural-planner";
import {
  getNodeActionSubtype,
  isPromptLikeNode,
} from "@airlab/canvas-core/components/canvas/action-subtype";
import { buildCanvasSubtreeText } from "@airlab/canvas-compiler/compiler";
import { normalizePromptOutputFields } from "@airlab/canvas-core/components/canvas/prompt-output-fields";
import {
  compileStateExtractionSubtreePrompt,
  type StateExtractionField,
} from "@airlab/canvas-compiler/stateCompiler";
import {
  describePromptGroupIo,
  type NodeIoField,
} from "@airlab/canvas-compiler/node-io";
import type {
  CanvasDoc,
  CanvasEntry,
  CanvasInspectorContext,
  CanvasNode,
  CanvasNodeRecord,
  CanvasStateSchemaField,
} from "./types";
import type { Edge } from "@xyflow/react";

export interface PromptGroupInspectorPreview {
  stepType: "prompt_subtree_decision" | "prompt_subtree_update" | "prompt_extract";
  systemPrompt: string | null;
  userPrompt: string;
  inputs: NodeIoField[];
  outputs: NodeIoField[];
  outputFields: StatePromptExtractionField[];
  nodes: Array<{ id: string; type: string; label: string }>;
}

export interface PromptTransformInspectorPreview {
  stepType: "prompt_transform" | "prompt_extract";
  systemPrompt: string | null;
  userPrompt: string;
}

const PREVIEW_CARRIED_OUTPUT = `<reserved local variable ${CARRIED_OUTPUT_PROMPT_VALUE_NAME}>`;
const PREVIEW_STRUCTURED_PLANNER_OUTPUT =
  "<current structured planner output>";

function readPromptTransformInputVariable(node: CanvasNodeRecord): string {
  const inputVariable =
    typeof node.data?.inputVariable === "string"
      ? node.data.inputVariable.trim()
      : "";
  return inputVariable || CARRIED_OUTPUT_PROMPT_VALUE_NAME;
}

function readPromptTransformOutputVariable(node: CanvasNodeRecord): string {
  const outputVariable =
    typeof node.data?.outputVariable === "string"
      ? node.data.outputVariable.trim()
      : "";
  return outputVariable || CARRIED_OUTPUT_PROMPT_VALUE_NAME;
}

function renderPromptTransformInputPreview(inputVariable: string): string {
  return inputVariable === CARRIED_OUTPUT_PROMPT_VALUE_NAME
    ? PREVIEW_CARRIED_OUTPUT
    : `<local or state value ${inputVariable}>`;
}

function buildPromptSegmentEntry(
  entry: CanvasEntry,
  rootNodeId: string,
  nodeIds: string[]
): CanvasEntry | null {
  const start = entry.graph.nodes.find((node) => node.type === "start");
  if (!start || nodeIds.length === 0) {
    return null;
  }

  const nodeIdSet = new Set(nodeIds);
  const incomingByTarget = new Map<string, number>();
  for (const edge of entry.graph.edges) {
    if (!nodeIdSet.has(edge.source) || !nodeIdSet.has(edge.target)) {
      continue;
    }
    incomingByTarget.set(edge.target, (incomingByTarget.get(edge.target) ?? 0) + 1);
  }

  const segmentRootIds = nodeIds.filter((nodeId) => (incomingByTarget.get(nodeId) ?? 0) === 0);
  const nodes = entry.graph.nodes
    .filter((node) => node.id === start.id || nodeIdSet.has(node.id))
    .map((node) => ({
      ...node,
      data: { ...node.data },
    }));

  const edges = entry.graph.edges
    .filter(
      (edge) =>
        (nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target)) ||
        (edge.source === start.id &&
          (nodeIdSet.has(rootNodeId)
            ? (rootNodeId === start.id
                ? nodeIdSet.has(edge.target)
                : edge.target === rootNodeId)
            : nodeIdSet.has(edge.target)))
    )
    .map((edge) => ({ ...edge }));

  for (const segmentRootId of segmentRootIds) {
    if (
      segmentRootId !== start.id &&
      !edges.some((edge) => edge.source === start.id && edge.target === segmentRootId)
    ) {
      edges.unshift({
        id: `segment-start-${entry.id}-${segmentRootId}`,
        source: start.id,
        target: segmentRootId,
      });
    }
  }

  return {
    ...entry,
    graph: {
      nodes,
      edges,
    },
  };
}

function mapStateFields(
  fields: CanvasStateSchemaField[] | undefined
): StateExtractionField[] {
  return (fields ?? []).map((field) => ({
    name: field.fieldName,
    type: field.type,
    initialValue: field.initialValue,
  }));
}

function usesConversationMemoryState(
  stateSchema: CanvasStateSchemaField[] | undefined
): boolean {
  return hasConversationMemoryFieldNames(
    (stateSchema ?? []).map((field) => field.fieldName)
  );
}

function parsePreviewStateValue(field: CanvasStateSchemaField): unknown {
  const raw = field.initialValue.trim();
  if (field.type === "string") {
    return raw;
  }

  if (field.type === "boolean") {
    if (/^true$/i.test(raw)) return true;
    if (/^false$/i.test(raw)) return false;
    return null;
  }

  if (field.type === "integer" || field.type === "number") {
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
      return Number(raw);
    }
    return null;
  }

  if (field.type === "string[]" || field.type === "json") {
    if (!raw) {
      return field.type === "string[]" ? [] : null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return raw;
}

function buildPreviewStateSnapshot(
  stateSchema: CanvasStateSchemaField[] | undefined
): Record<string, unknown> {
  return (stateSchema ?? []).reduce<Record<string, unknown>>((acc, field) => {
    acc[field.fieldName] = parsePreviewStateValue(field);
    return acc;
  }, {});
}

function renderPreviewStateJson(stateSchema: CanvasStateSchemaField[] | undefined): string {
  return JSON.stringify(buildPreviewStateSnapshot(stateSchema), null, 2);
}

function collectPromptGroupOutputFields(
  entry: CanvasEntry,
  nodeIds: string[]
): StatePromptExtractionField[] {
  const nodeById = new Map(entry.graph.nodes.map((node) => [node.id, node]));
  const fieldsByName = new Map<string, StatePromptExtractionField>();

  for (const nodeId of nodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) {
      continue;
    }
    for (const field of normalizePromptOutputFields(node.data?.promptOutputFields)) {
      fieldsByName.set(field.name, {
        name: field.name,
        type: field.type,
        instruction: field.instruction,
      });
    }
  }

  return Array.from(fieldsByName.values());
}

function renderPromptExtractionFieldShape(field: StatePromptExtractionField): string {
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

function compareCanvasNodesByVisualOrder(
  left: CanvasNodeRecord,
  right: CanvasNodeRecord
): number {
  const yDelta = left.position.y - right.position.y;
  if (Math.abs(yDelta) > 12) {
    return yDelta;
  }

  const xDelta = left.position.x - right.position.x;
  if (Math.abs(xDelta) > 12) {
    return xDelta;
  }

  return left.id.localeCompare(right.id);
}

function orderPromptGroupNodeIdsByVisualPosition(
  entry: CanvasEntry,
  nodeIds: string[]
): string[] {
  const requestedIds = new Set(nodeIds);
  const nodes = entry.graph.nodes
    .filter((node) => requestedIds.has(node.id))
    .sort(compareCanvasNodesByVisualOrder);

  return nodes.map((node) => node.id);
}

function renderPromptExtractionInstruction(fields: StatePromptExtractionField[]): string {
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

function sanitizePromptValueName(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function isToolCallNode(node: CanvasNodeRecord): boolean {
  return getNodeActionSubtype(node) === "tool_call";
}

function resolvePromptGroupPreviewRootNodeId(
  group: StructuralPromptGroup
): string | undefined {
  return group.nodeIds.includes(group.rootNodeId) ? group.rootNodeId : undefined;
}

function parseToolParameterNames(node: CanvasNodeRecord): string[] {
  const rawSchema =
    typeof node.data?.paramsSchema === "string" ? node.data.paramsSchema.trim() : "";
  if (!rawSchema) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawSchema);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }

    return Object.keys(parsed as Record<string, unknown>).filter(
      (key) => key.trim().length > 0
    );
  } catch {
    return [];
  }
}

function inferToolFunctionName(node: CanvasNodeRecord): string {
  const explicitName =
    typeof node.data?.toolName === "string" ? node.data.toolName.trim() : "";
  if (explicitName) {
    return explicitName;
  }

  const label = typeof node.data?.label === "string" ? node.data.label.trim() : "";
  return label || node.id;
}

function buildToolParentContributionVariableName(
  parentNode: CanvasNodeRecord,
  toolNode: CanvasNodeRecord
): string {
  if (isToolCallNode(parentNode)) {
    return inferToolFunctionName(parentNode) || sanitizePromptValueName(parentNode.id);
  }

  return sanitizePromptValueName(`tool_inputs_${toolNode.id}_${parentNode.id}`);
}

function buildToolContributionInstruction(
  toolNode: CanvasNodeRecord,
  parentNode: CanvasNodeRecord
): string {
  const toolName = inferToolFunctionName(toolNode);
  const parameterNames = parseToolParameterNames(toolNode);
  const parameterText =
    parameterNames.length > 0
      ? parameterNames.map((name) => JSON.stringify(name)).join(", ")
      : "(no declared parameters)";
  const parentLabel =
    typeof parentNode.data?.label === "string" ? parentNode.data.label.trim() : "";

  return [
    `From this node alone${parentLabel ? ` (${parentLabel})` : ""}, extract only the tool input fields you can determine for tool "${toolName}".`,
    `Allowed keys: ${parameterText}.`,
    "Return a JSON object containing only the keys this node can confidently supply.",
    "If this node cannot supply any tool inputs, return {}.",
    "Do not invent keys outside the allowed set.",
  ].join(" ");
}

function isJoinNode(entry: CanvasEntry, nodeId: string): boolean {
  return entry.graph.edges.filter((edge) => edge.target === nodeId).length > 1;
}

function getDirectJoinToolTarget(
  entry: CanvasEntry,
  node: CanvasNodeRecord
): CanvasNodeRecord | null {
  const nodeById = new Map(entry.graph.nodes.map((candidate) => [candidate.id, candidate]));
  const candidates = entry.graph.edges
    .filter((edge) => edge.source === node.id)
    .map((edge) => nodeById.get(edge.target))
    .filter((candidate): candidate is CanvasNodeRecord => {
      if (!candidate) {
        return false;
      }

      return isToolCallNode(candidate) && isJoinNode(entry, candidate.id);
    });

  return candidates.length === 1 ? candidates[0] : null;
}

function buildNodeOnlyPrompt(
  entry: CanvasEntry,
  nodeId: string,
  promptContextDoc?: CanvasDoc
): string {
  const isolatedEntry = buildPromptSegmentEntry(entry, nodeId, [nodeId]) ?? entry;
  const isolatedDoc: CanvasDoc = {
    version: 2,
    activeId: entry.id,
    canvases: [isolatedEntry],
  };

  return buildCanvasSubtreeText(isolatedDoc, entry.id, nodeId, promptContextDoc);
}

function renderPolicyDecisionExtractionInstruction(
  fields: StatePromptExtractionField[]
): string {
  const lines = [
    '  "assistant_reply": string',
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

function buildGenericPolicySubtreePrompt(
  context: CanvasInspectorContext,
  outputFields: StatePromptExtractionField[]
): string {
  const stateJson = renderPreviewStateJson(context.stateSchema);
  const promptValuesJson = "(none)";
  const sections: string[] = [];

  if (usesConversationMemoryState(context.stateSchema)) {
    sections.push(
      "Current conversation state (JSON):",
      stateJson,
      ""
    );

    if (outputFields.length > 0) {
      sections.push(
        "Previously extracted intermediate values (JSON):",
        promptValuesJson,
        "",
        "Now execute only the provided policy subtree instructions using only the current state above.",
        'Return the main policy subtree output in "assistant_reply".',
        "Also extract the requested typed intermediate values for deterministic follow-up steps.",
        "Do not explain your work.",
        "",
        renderPolicyDecisionExtractionInstruction(outputFields),
        "",
        "Extraction rules:",
        outputFields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      );
      return sections.join("\n");
    }

    sections.push(
      "Now execute only the provided policy subtree instructions using only the current state above and return only the assistant message body or the exact triage summary format."
    );
    return sections.join("\n");
  }

  sections.push(
    "Conversation history:",
    "<runtime conversation history>",
    "",
    "Updated patient state (JSON):",
    stateJson,
    ""
  );

  if (outputFields.length > 0) {
    sections.push(
      "Previously extracted intermediate values (JSON):",
      promptValuesJson,
      "",
      "Now execute only the provided policy subtree instructions.",
      'Return the main policy subtree output in "assistant_reply".',
      "Also extract the requested typed intermediate values for deterministic follow-up steps.",
      "Do not explain your work.",
      "",
      renderPolicyDecisionExtractionInstruction(outputFields),
      "",
      "Extraction rules:",
      outputFields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
    );
    return sections.join("\n");
  }

  sections.push(
    "Now execute only the provided policy subtree instructions and return only the assistant message body or the exact triage summary format."
  );
  return sections.join("\n");
}

function buildPrimaryAgentPolicySubtreePrompt(
  context: CanvasInspectorContext,
  outputFields: StatePromptExtractionField[]
): string {
  const stateJson = renderPreviewStateJson(context.stateSchema);
  const promptValuesJson = "(none)";
  const actionInstruction =
    "Decide the assistant's next visible reply or tool-directed action.";

  if (outputFields.length === 0) {
    return [
      "Current primary-agent state (JSON):",
      stateJson,
      "",
      "Current ingress/local values (JSON):",
      promptValuesJson,
      "",
      "Current carried output:",
      PREVIEW_CARRIED_OUTPUT,
      "",
      "Now execute only the provided policy subtree instructions.",
      actionInstruction,
    ].join("\n");
  }

  const extractionRules = outputFields
    .map((field) => `- ${field.name}: ${field.instruction}`)
    .join("\n");

  return [
    "Policy flow instructions:",
    actionInstruction,
    "",
    "Current primary-agent state (JSON):",
    stateJson,
    "",
    "Current ingress/local values (JSON):",
    promptValuesJson,
    "",
    "Current carried output:",
    PREVIEW_CARRIED_OUTPUT,
    "",
    "Execute only the provided policy subtree instructions.",
    "Return the assistant reply plus any extracted intermediate values.",
    "",
    renderPolicyDecisionExtractionInstruction(outputFields),
    "",
    "Extraction rules:",
    extractionRules,
  ].join("\n");
}

function buildPrimaryAgentPolicyExtractionPrompt(
  context: CanvasInspectorContext,
  contextPrompt: string,
  outputFields: StatePromptExtractionField[]
): string {
  const policyExecutionSystemPrompt =
    context.policyExecutionSystemPrompt?.trim() ||
    "Decide the assistant's next visible reply or tool-directed action.";
  const extractionRules =
    outputFields.length > 0
      ? outputFields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";

  return [
    "Policy flow instructions:",
    policyExecutionSystemPrompt,
    "",
    "Current primary-agent state (JSON):",
    renderPreviewStateJson(context.stateSchema),
    "",
    "Current ingress/local values (JSON):",
    "(none)",
    "",
    ...(contextPrompt ? ["Focused subtree or node context:", contextPrompt, ""] : []),
    "Extract only the intermediate values needed for deterministic policy code.",
    "Do not return the final assistant response.",
    "Use null for values that should not be set from the current ingress/local values.",
    "",
    renderPromptExtractionInstruction(outputFields),
    "",
    "Extraction rules:",
    extractionRules,
  ].join("\n");
}

function buildPrimaryAgentPolicyTransformPrompt(
  context: CanvasInspectorContext,
  instruction: string,
  inputVariable: string,
  outputVariable: string
): string {
  return [
    "Current primary-agent state (JSON):",
    renderPreviewStateJson(context.stateSchema),
    "",
    "Current ingress/local values (JSON):",
    "(none)",
    "",
    `Current input value "${inputVariable}":`,
    renderPromptTransformInputPreview(inputVariable),
    "",
    "Transformation instruction:",
    instruction,
    "",
    `Store the transformed result as local variable "${outputVariable}".`,
    "Return only the transformed primary-agent action or message.",
  ].join("\n");
}

function buildGenericStateSubtreePrompt(context: CanvasInspectorContext): string {
  const stateJson = renderPreviewStateJson(context.stateSchema);
  const sections: string[] = [];

  if (usesConversationMemoryState(context.stateSchema)) {
    sections.push(
      "Current conversation state (JSON):",
      stateJson,
      "",
      "Now execute only the provided state subtree instructions.",
      "Use only the current state above.",
      "Return only the full updated state JSON object and nothing else."
    );
    return sections.join("\n");
  }

  sections.push(
    "Conversation history:",
    "<runtime conversation history without the latest user message>",
    "",
    "Previous known state (JSON):",
    stateJson,
    "",
    "Latest user message:",
    "<latest user message>",
    "",
    "Now execute only the provided state subtree instructions.",
    "Return only the full updated state JSON object and nothing else."
  );
  return sections.join("\n");
}

function buildGenericStateExtractionPrompt(
  context: CanvasInspectorContext,
  contextPrompt: string,
  outputFields: StatePromptExtractionField[]
): string {
  const stateUpdateSystemPrompt =
    context.stateUpdateSystemPrompt?.trim() || "<configured state update system prompt>";
  const stateJson = renderPreviewStateJson(context.stateSchema);
  const promptValuesJson = "(none)";
  const extractionRules =
    outputFields.length > 0
      ? outputFields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const sections: string[] = [];

  sections.push("State flow instructions:", stateUpdateSystemPrompt, "");

  if (usesConversationMemoryState(context.stateSchema)) {
    sections.push(
      "Current conversation state (JSON):",
      stateJson,
      "",
      "Previously extracted intermediate values (JSON):",
      promptValuesJson,
      "",
      `Focused subtree or node context:\n${contextPrompt}`,
      "",
      "Extract only the intermediate values needed for deterministic state code.",
      "Use only the current state above.",
      "Do not return the final updated state object.",
      "Use null for values that should not be set from this state.",
      "",
      renderPromptExtractionInstruction(outputFields),
      "",
      "Extraction rules:",
      extractionRules
    );
    return sections.join("\n");
  }

  sections.push(
    "Conversation history:",
    "<runtime conversation history without the latest user message>",
    "",
    "Previous known state (JSON):",
    stateJson,
    "",
    "Latest user message:",
    "<latest user message>",
    "",
    "Previously extracted intermediate values (JSON):",
    promptValuesJson,
    "",
    `Focused subtree or node context:\n${contextPrompt}`,
    "",
    "Extract only the intermediate values needed for deterministic state code.",
    "Do not return the final updated state object.",
    "Use null for values that should not be set from this message.",
    "",
    renderPromptExtractionInstruction(outputFields),
    "",
    "Extraction rules:",
    extractionRules
  );
  return sections.join("\n");
}

function buildPrimaryAgentStateSubtreePrompt(context: CanvasInspectorContext): string {
  return [
    "Current primary-agent state (JSON):",
    renderPreviewStateJson(context.stateSchema),
    "",
    "Current ingress/local values (JSON):",
    "(none)",
    "",
    "Now execute only the provided state subtree instructions.",
    "Return only the full updated state JSON object and nothing else.",
  ].join("\n");
}

function buildPrimaryAgentStateExtractionPrompt(
  context: CanvasInspectorContext,
  contextPrompt: string,
  outputFields: StatePromptExtractionField[]
): string {
  const stateUpdateSystemPrompt =
    context.stateUpdateSystemPrompt?.trim() || "<configured state update system prompt>";
  const extractionRules =
    outputFields.length > 0
      ? outputFields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";

  return [
    "State flow instructions:",
    stateUpdateSystemPrompt,
    "",
    "Current primary-agent state (JSON):",
    renderPreviewStateJson(context.stateSchema),
    "",
    "Current ingress/local values (JSON):",
    "(none)",
    "",
    ...(contextPrompt ? ["Focused subtree or node context:", contextPrompt, ""] : []),
    "Extract only the intermediate values needed for deterministic state code.",
    "Do not return the final updated state object.",
    "Use null for values that should not be set from the current ingress/local values.",
    "",
    renderPromptExtractionInstruction(outputFields),
    "",
    "Extraction rules:",
    extractionRules,
  ].join("\n");
}

function buildGenericPolicyExtractionPrompt(
  context: CanvasInspectorContext,
  contextPrompt: string,
  outputFields: StatePromptExtractionField[]
): string {
  const policyExecutionSystemPrompt =
    context.policyExecutionSystemPrompt?.trim() ||
    "<configured policy execution system prompt>";
  const stateJson = renderPreviewStateJson(context.stateSchema);
  const promptValuesJson = "(none)";
  const extractionRules =
    outputFields.length > 0
      ? outputFields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const sections: string[] = [];

  sections.push(
    "Policy flow instructions:",
    policyExecutionSystemPrompt,
    ""
  );

  if (usesConversationMemoryState(context.stateSchema)) {
    sections.push(
      "Current conversation state (JSON):",
      stateJson,
      "",
      "Previously extracted intermediate values (JSON):",
      promptValuesJson,
      "",
      ...(contextPrompt ? ["Focused subtree or node context:", contextPrompt, ""] : []),
      "Extract only the intermediate values needed for deterministic policy code.",
      "Use only the current state above.",
      "Do not return the final assistant response.",
      "Use null for values that should not be set from this state.",
      "",
      renderPromptExtractionInstruction(outputFields),
      "",
      "Extraction rules:",
      extractionRules
    );
    return sections.join("\n");
  }

  sections.push(
    "Conversation history:",
    "<runtime conversation history>",
    "",
    "Updated patient state (JSON):",
    stateJson,
    "",
    "Latest user message:",
    "<latest user message>",
    "",
    "Previously extracted intermediate values (JSON):",
    promptValuesJson,
    "",
    ...(contextPrompt ? ["Focused subtree or node context:", contextPrompt, ""] : []),
    "Extract only the intermediate values needed for deterministic policy code.",
    "Do not return the final assistant response.",
    "Use null for values that should not be set from this message.",
    "",
    renderPromptExtractionInstruction(outputFields),
    "",
    "Extraction rules:",
    extractionRules
  );
  return sections.join("\n");
}

function buildGenericPolicyTransformPrompt(
  context: CanvasInspectorContext,
  instruction: string,
  inputVariable: string,
  outputVariable: string
): string {
  const stateJson = renderPreviewStateJson(context.stateSchema);
  const sections: string[] = [];

  if (usesConversationMemoryState(context.stateSchema)) {
    sections.push(
      "Current conversation state (JSON):",
      stateJson,
      "",
      `Current input value "${inputVariable}":`,
      renderPromptTransformInputPreview(inputVariable),
      "",
      `Transform the current "${inputVariable}" value so it satisfies this instruction:`,
      instruction,
      "",
      "Use only the current state above.",
      `Store the transformed result as local variable "${outputVariable}".`,
      "Return only the transformed assistant message body.",
      "Do not mention these instructions.",
      "Do not explain your work.",
      "Do not add any extra wrapper text."
    );
    return sections.join("\n");
  }

  sections.push(
    "Conversation history:",
    "<runtime conversation history>",
    "",
    "Updated patient state (JSON):",
    stateJson,
    "",
    `Current input value "${inputVariable}":`,
    renderPromptTransformInputPreview(inputVariable),
    "",
    `Transform the current "${inputVariable}" value so it satisfies this instruction:`,
    instruction,
    "",
    `Store the transformed result as local variable "${outputVariable}".`,
    "Return only the transformed assistant message body.",
    "Do not mention these instructions.",
    "Do not explain your work.",
    "Do not add any extra wrapper text."
  );
  return sections.join("\n");
}

function buildDaemonRuntimeContext(context: CanvasInspectorContext): string {
  const stateSchemaLines =
    (context.stateSchema ?? []).length > 0
      ? (context.stateSchema ?? [])
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
    renderPreviewStateJson(context.stateSchema),
    "",
    "Note:",
    "current_build inside daemon state is the canonical server-generated snapshot of the live draft.",
  ].join("\n");
}

function buildDaemonPlannerJsonShapeLines(): string[] {
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
    '  "stateFields": [{ "name": string, "type": "string" | "integer" | "boolean" | "string[]" | "number" | "json", "initialValue": string }],',
    '  "datasets": [{ "name": string, "notes": string, "columns": [{ "name": string, "type": "string" | "url" | "string[]" | "integer" | "number" | "boolean" }], "exampleRecords": object[] }],',
    '  "agentConnections": [{ "targetAgentId": string, "targetAgentTitle": string, "purpose": string, "invocationMode": "sync" | "async", "stateFields": [{ "name": string, "type": "string" | "integer" | "boolean" | "string[]" | "number" | "json", "initialValue": string }], "datasets": [{ "name": string, "notes": string, "columns": [{ "name": string, "type": "string" | "url" | "string[]" | "integer" | "number" | "boolean" }], "exampleRecords": object[] }], "skills": [{ "name": string, "startCondition": string, "terminationCondition": string, "policySeed": { "canvasName": string, "generalPrompt": string, "clarificationGate": string, "clarificationActions": string[], "executionActions": string[], "responseRule": string, "notes": string }, "replaceExisting": boolean }], "stateFocus": string, "sourcePolicySeed": { "canvasName": string, "generalPrompt": string, "clarificationGate": string, "clarificationActions": string[], "executionActions": string[], "responseRule": string, "notes": string }, "sourceInitialPolicyCanvasShape": { "canvasName": string, "notes": string, "startLabel": string, "overview": string, "steps": CanvasShapeStep[] } | null, "sourceInitialPolicyCanvasStructure": { "canvasName": string, "notes": string, "startLabel": string, "steps": InitialCanvasStep[] } | null, "targetPolicySeed": { "canvasName": string, "generalPrompt": string, "clarificationGate": string, "clarificationActions": string[], "executionActions": string[], "responseRule": string, "notes": string }, "targetInitialPolicyCanvasShape": { "canvasName": string, "notes": string, "startLabel": string, "overview": string, "steps": CanvasShapeStep[] } | null, "targetInitialPolicyCanvasStructure": { "canvasName": string, "notes": string, "startLabel": string, "steps": InitialCanvasStep[] } | null, "targetInitialStateCanvasShape": { "canvasName": string, "notes": string, "startLabel": string, "overview": string, "steps": CanvasShapeStep[] } | null, "targetInitialStateCanvasStructure": { "canvasName": string, "notes": string, "startLabel": string, "steps": InitialCanvasStep[] } | null }],',
    '  "skills": [{ "target": "primary", "name": string, "startCondition": string, "terminationCondition": string, "policySeed": { "canvasName": string, "generalPrompt": string, "clarificationGate": string, "clarificationActions": string[], "executionActions": string[], "responseRule": string, "notes": string }, "replaceExisting": boolean }],',
    '  "triageQuestions": string[],',
    '  "stateFocus": string,',
    '  "toolRequests": [{ "capability": string, "whenToCall": string, "desiredSourceType": "http" | "rss" | "page" | "web_search" | "knowledge_save" | "dataset_read", "urlHint": string, "saveTarget": "knowledge" | "dataset", "datasetName": string, "parameters": [{ "name": string, "type": "string" | "number" | "integer" | "boolean", "description": string }] }],',
    '  "toolPlacements": [{ "target": "policy" | "state", "agentTarget": "primary" | "environment" | "both", "environmentAgentId": string, "environmentAgentIndex": number, "environmentAgentNumber": number, "environmentAgentTitle": string, "skillId": string, "skillName": string, "skillCanvas": "policy" | "start_condition" | "termination_condition", "placement": "before" | "after", "canvasId": string, "canvasName": string, "anchorRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "sourceRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "targetRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "sourceHandle": string | null, "edgeLabel": string, "label": string, "querySource": string, "tool": { "capability": string, "whenToCall": string, "toolName": string, "description": string, "sourceType": "http" | "rss" | "page" | "web_search" | "knowledge_save" | "dataset_read", "url": string, "parameters": [{ "name": string, "type": "string" | "number" | "integer" | "boolean", "description": string }], "promoteToKnowledge": boolean, "saveTarget": "knowledge" | "dataset", "datasetName": string } }],',
    '  "canvasEdits": [{ "target": "policy" | "state", "agentTarget": "primary" | "environment" | "both", "environmentAgentId": string, "environmentAgentIndex": number, "environmentAgentNumber": number, "environmentAgentTitle": string, "skillId": string, "skillName": string, "skillCanvas": "policy" | "start_condition" | "termination_condition", "op": "add_canvas" | "rename_canvas" | "set_canvas_notes" | "set_active_canvas" | "add_node" | "insert_node_before" | "insert_node_after" | "update_node" | "delete_node" | "add_edge" | "update_edge" | "delete_edge", "canvasId": string, "canvasName": string, "nextName": string, "notes": string, "nodeKey": string, "nodeType": "start" | "condition" | "for" | "while" | "stage" | "prompt" | "code" | "tool_call" | "display" | "expand" | "yield" | "continue" | "terminate_stage" | "terminate_stage_immediate" | "read_async_job" | "await_async_job" | "build_default_primary_state_schema" | "build_default_environment_state_schema" | "build_initial_canvas_shape_materialization_requests" | "materialize_initial_canvas_structures" | "merge_materialized_initial_canvas_structures" | "apply_structured_patch" | "scaffold_tools" | "sync_derived_prompts" | "repair_canvas_rules" | "finalize_assistant_reply" | "raise_error", "label": string, "x": number, "y": number, "data": object, "nodeRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "sourceRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "targetRef": { "nodeKey": string, "id": string, "type": string, "actionType": string, "labelEquals": string, "labelContains": string, "toolName": string }, "edgeId": string, "sourceHandle": string | null, "edgeLabel": string }],',
    '  "replacePolicyCanvas": boolean,',
    '  "replaceStateCanvas": boolean',
    "}",
  ];
}

function buildDaemonPlannerProtocolLines(): string[] {
  return [
    "Protocol:",
    "- The configured daemon policy in the system message is authoritative. This section only describes output format and deterministic patch mechanics.",
    "- current_build inside daemon state is the canonical server-generated snapshot of the live draft.",
    "- CanvasShapeStep may be one of: { kind: \"phase\", title: string, purpose: string, actionTypeHint?: \"prompt\" | \"code\" | \"prompt_transform\" | \"display\" }, { kind: \"decision\", question: string, whenTrue: CanvasShapeStep[], whenFalse: CanvasShapeStep[] }, or { kind: \"for\" | \"while\", title: string, purpose: string, maxIterations?: integer, body: CanvasShapeStep[] }.",
    "- InitialCanvasStep may be one of: { kind: \"prompt\" | \"code\" | \"display\", label: string, actionType?: \"prompt\" | \"code\" | \"prompt_transform\" | \"display\", displayType?: \"text\" | \"video\", inputVariable?: string, outputVariable?: string, videoUrl?: string }, { kind: \"condition\", label: string, whenTrue: InitialCanvasStep[], whenFalse: InitialCanvasStep[] }, { kind: \"for\" | \"while\", label: string, maxIterations?: integer, body: InitialCanvasStep[] }, { kind: \"yield\", label?: string }, { kind: \"continue\", label?: string }, or { kind: \"terminate_stage\" | \"terminate_stage_immediate\", label?: string, nextStageId?: string, nextStageName?: string }. Direct InitialCanvasStructure fields are still accepted as a compatibility fallback, but shape fields are preferred.",
    "- Canvas node refs may identify nodes by id, nodeKey, type, actionType, labelEquals, labelContains, or toolName.",
    "- A new node may set nodeKey so later sourceRef, targetRef, or nodeRef values in the same patch can reference it.",
    "- insert_node_before and insert_node_after splice one new node around a referenced node; nodeRef is the existing anchor. For insert_node_before, optional sourceRef limits the incoming edge to reroute. For insert_node_after, optional targetRef limits the outgoing edge to reroute.",
    "- toolPlacements are normalized into tool_call node insertion edits. querySource is copied into the placed tool node data when provided.",
    "- update_edge can change an existing edge's kind or label; delete_edge plus add_edge can rewire endpoints.",
    "- for and while nodes are bounded control nodes. Set data.maxIterations to a small positive integer. while labels must use the normal condition syntax, and use sourceHandle=body for the repeat branch plus sourceHandle=done for the exit branch.",
    "- Tool source types must be one of: http, rss, page, web_search, knowledge_save, dataset_read.",
    "- Display nodes use nodeType=\"display\". For text display, set data.displayType=\"text\" and data.inputVariable to a local value or state field name. For video display, set data.displayType=\"video\" and data.videoUrl.",
    "- In policy canvases, Display nodes are the only nodes that publish visible output.",
    "- Output JSON only.",
  ];
}

function buildDaemonPolicyExtractionPrompt(
  context: CanvasInspectorContext,
  contextPrompt: string,
  outputFields: StatePromptExtractionField[]
): string {
  const extractionRules =
    outputFields.length > 0
      ? outputFields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";

  return [
    buildDaemonRuntimeContext(context),
    "",
    "Current structured planner output:",
    PREVIEW_STRUCTURED_PLANNER_OUTPUT,
    "",
    "Previously extracted intermediate values (JSON):",
    "(none)",
    "",
    ...(contextPrompt ? ["Focused subtree or node context:", contextPrompt, ""] : []),
    "Extract only the intermediate values needed for deterministic planner policy code.",
    "Do not return the final structured planner JSON.",
    "Use null for values that should not be set from this turn.",
    "",
    renderPromptExtractionInstruction(outputFields),
    "",
    "Extraction rules:",
    extractionRules,
  ].join("\n");
}

function buildDaemonPolicyTransformPrompt(
  context: CanvasInspectorContext,
  instruction: string,
  inputVariable: string,
  outputVariable: string
): string {
  return [
    buildDaemonRuntimeContext(context),
    "",
    `Current input value "${inputVariable}":`,
    inputVariable === CARRIED_OUTPUT_PROMPT_VALUE_NAME
      ? PREVIEW_STRUCTURED_PLANNER_OUTPUT
      : renderPromptTransformInputPreview(inputVariable),
    "",
    `Transform the current "${inputVariable}" value so it satisfies this instruction:`,
    instruction,
    "",
    `Store the transformed result as local variable "${outputVariable}".`,
    "Keep the same top-level JSON shape.",
    "Preserve non-message fields unless the instruction requires changing them.",
    "Return JSON only.",
  ].join("\n");
}

function buildDaemonPolicySubtreePrompt(
  context: CanvasInspectorContext,
  outputFields: StatePromptExtractionField[]
): string {
  const base = [buildDaemonRuntimeContext(context), ""];

  if (outputFields.length === 0) {
    return [
      ...base,
      "Current structured planner output:",
      PREVIEW_STRUCTURED_PLANNER_OUTPUT,
      "",
      "Execute only the provided daemon policy subtree instructions.",
      "Return strict JSON with this shape:",
      ...buildDaemonPlannerJsonShapeLines(),
      "",
      ...buildDaemonPlannerProtocolLines(),
    ].join("\n");
  }

  const plannerShapeLines = buildDaemonPlannerJsonShapeLines();
  const plannerShape = plannerShapeLines
    .map((line, index) => {
      const isLast = index === plannerShapeLines.length - 1;
      return `  ${line}${isLast ? "," : ""}`;
    })
    .join("\n");
  const extractionShape = outputFields
    .map(
      (field) =>
        `  ${JSON.stringify(field.name)}: ${renderPromptExtractionFieldShape(field)}`
    )
    .join(",\n");
  const extractionRules = outputFields
    .map((field) => `- ${field.name}: ${field.instruction}`)
    .join("\n");

  return [
    ...base,
    "Current structured planner output:",
    PREVIEW_STRUCTURED_PLANNER_OUTPUT,
    "",
    "Previously extracted intermediate values (JSON):",
    "(none)",
    "",
    "Execute only the provided daemon policy subtree instructions.",
    'Return exactly one JSON object with this shape and nothing else:',
    "{",
    '  "assistant_reply":',
    plannerShape,
    extractionShape,
    "}",
    "",
    '"assistant_reply" must itself be the main structured planner JSON output.',
    "Also extract the requested typed intermediate values for deterministic follow-up steps.",
    "Do not explain your work.",
    "",
    "Extraction rules:",
    extractionRules,
    "",
    ...buildDaemonPlannerProtocolLines(),
  ].join("\n");
}

function buildPromptGroupNodes(
  entry: CanvasEntry,
  nodeIds: string[]
): Array<{ id: string; type: string; label: string }> {
  const nodeById = new Map(entry.graph.nodes.map((node) => [node.id, node]));
  return nodeIds
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is CanvasNodeRecord => Boolean(node))
    .map((node) => ({
      id: node.id,
      type: node.type,
      label: typeof node.data?.label === "string" ? node.data.label.trim() : "",
    }));
}

export function buildPromptGroupInspectorPreview(args: {
  group: StructuralPromptGroup;
  entry: CanvasEntry;
  inspectorContext: CanvasInspectorContext;
  promptContextDoc?: CanvasDoc;
}): PromptGroupInspectorPreview | null {
  const { group, entry, inspectorContext, promptContextDoc } = args;
  const orderedNodeIds = orderPromptGroupNodeIdsByVisualPosition(entry, group.nodeIds);
  const previewRootNodeId =
    resolvePromptGroupPreviewRootNodeId(group) ?? orderedNodeIds[0];
  if (!previewRootNodeId) {
    return null;
  }

  const segmentEntry = buildPromptSegmentEntry(
    entry,
    previewRootNodeId,
    orderedNodeIds
  );
  if (!segmentEntry) {
    return null;
  }

  const segmentDoc: CanvasDoc = {
    version: 2,
    activeId: entry.id,
    canvases: [segmentEntry],
  };
  const outputFields = collectPromptGroupOutputFields(entry, orderedNodeIds);
  const stateFields = mapStateFields(inspectorContext.stateSchema);
  const nodes = buildPromptGroupNodes(entry, orderedNodeIds);
  const io = describePromptGroupIo(
    entry.graph.nodes as unknown as CanvasNode[],
    entry.graph.edges as unknown as Edge[],
    {
      phase: group.phase,
      nodeIds: orderedNodeIds,
    }
  );

  if (group.phase === "policy") {
    const systemPrompt = buildCanvasSubtreeText(
      segmentDoc,
      entry.id,
      previewRootNodeId,
      promptContextDoc
    );
    const userPrompt =
      inspectorContext.runtimeProfile === "daemon"
        ? buildDaemonPolicySubtreePrompt(inspectorContext, outputFields)
        : inspectorContext.runtimeProfile === "primary_agent"
          ? buildPrimaryAgentPolicySubtreePrompt(inspectorContext, outputFields)
        : buildGenericPolicySubtreePrompt(inspectorContext, outputFields);

    return {
      stepType: "prompt_subtree_decision",
      systemPrompt,
      userPrompt,
      inputs: io.inputs,
      outputs: io.outputs,
      outputFields,
      nodes,
    };
  }

  const contextPrompt = compileStateExtractionSubtreePrompt(
    segmentDoc,
    stateFields,
    entry.id,
    previewRootNodeId,
    promptContextDoc
  );
  if (outputFields.length > 0) {
    return {
      stepType: "prompt_extract",
      systemPrompt: null,
      userPrompt:
        inspectorContext.runtimeProfile === "primary_agent"
          ? buildPrimaryAgentStateExtractionPrompt(
              inspectorContext,
              contextPrompt,
              outputFields
            )
          : buildGenericStateExtractionPrompt(
              inspectorContext,
              contextPrompt,
              outputFields
            ),
      inputs: io.inputs,
      outputs: io.outputs,
      outputFields,
      nodes,
    };
  }

  return {
    stepType: "prompt_subtree_update",
    systemPrompt: contextPrompt,
    userPrompt:
      inspectorContext.runtimeProfile === "primary_agent"
        ? buildPrimaryAgentStateSubtreePrompt(inspectorContext)
        : buildGenericStateSubtreePrompt(inspectorContext),
    inputs: io.inputs,
    outputs: io.outputs,
    outputFields,
    nodes,
  };
}

function buildStateNodeOnlyPrompt(
  entry: CanvasEntry,
  nodeId: string,
  stateFields: StateExtractionField[],
  promptContextDoc?: CanvasDoc
): string {
  const isolatedEntry = buildPromptSegmentEntry(entry, nodeId, [nodeId]) ?? entry;
  const isolatedDoc: CanvasDoc = {
    version: 2,
    activeId: entry.id,
    canvases: [isolatedEntry],
  };

  return compileStateExtractionSubtreePrompt(
    isolatedDoc,
    stateFields,
    entry.id,
    nodeId,
    promptContextDoc
  );
}

export function buildPromptNodeInspectorPreview(args: {
  node: CanvasNodeRecord;
  entry: CanvasEntry;
  inspectorContext: CanvasInspectorContext;
  promptContextDoc?: CanvasDoc;
}): PromptGroupInspectorPreview | null {
  const { node, entry, inspectorContext, promptContextDoc } = args;
  const phase = inspectorContext.executionPhase;
  if (!phase || !isPromptLikeNode(node)) {
    return null;
  }

  const actionType = getNodeActionSubtype(node);
  if (
    actionType === "code" ||
    actionType === "display" ||
    actionType === "tool_call" ||
    actionType === "prompt_transform"
  ) {
    return null;
  }

  const outputFields = collectPromptGroupOutputFields(entry, [node.id]);
  const joinToolTarget = getDirectJoinToolTarget(entry, node);
  if (actionType !== "prompt" && outputFields.length === 0 && !joinToolTarget) {
    return null;
  }

  const io = describePromptGroupIo(
    entry.graph.nodes as unknown as CanvasNode[],
    entry.graph.edges as unknown as Edge[],
    {
      phase,
      nodeIds: [node.id],
    }
  );
  const nodes = buildPromptGroupNodes(entry, [node.id]);

  if (phase === "policy") {
    if (outputFields.length > 0) {
      const contextPrompt = buildNodeOnlyPrompt(entry, node.id, promptContextDoc);
      return {
        stepType: "prompt_extract",
        systemPrompt: null,
        userPrompt:
          inspectorContext.runtimeProfile === "daemon"
            ? buildDaemonPolicyExtractionPrompt(
                inspectorContext,
                contextPrompt,
                outputFields
              )
            : inspectorContext.runtimeProfile === "primary_agent"
              ? buildPrimaryAgentPolicyExtractionPrompt(
                  inspectorContext,
                  contextPrompt,
                  outputFields
                )
            : buildGenericPolicyExtractionPrompt(
                inspectorContext,
                contextPrompt,
                outputFields
              ),
        inputs: io.inputs,
        outputs: io.outputs,
        outputFields,
        nodes,
      };
    }

    if (joinToolTarget) {
      const toolFields: StatePromptExtractionField[] = [
        {
          name: buildToolParentContributionVariableName(node, joinToolTarget),
          type: "json",
          instruction: buildToolContributionInstruction(joinToolTarget, node),
        },
      ];
      const contextPrompt = buildNodeOnlyPrompt(entry, node.id, promptContextDoc);
      return {
        stepType: "prompt_extract",
        systemPrompt: null,
        userPrompt:
          inspectorContext.runtimeProfile === "daemon"
            ? buildDaemonPolicyExtractionPrompt(
                inspectorContext,
                contextPrompt,
                toolFields
              )
            : inspectorContext.runtimeProfile === "primary_agent"
              ? buildPrimaryAgentPolicyExtractionPrompt(
                  inspectorContext,
                  contextPrompt,
                  toolFields
                )
            : buildGenericPolicyExtractionPrompt(
                inspectorContext,
                contextPrompt,
                toolFields
              ),
        inputs: io.inputs,
        outputs: io.outputs,
        outputFields: toolFields,
        nodes,
      };
    }

    return {
      stepType: "prompt_subtree_decision",
      systemPrompt: buildNodeOnlyPrompt(entry, node.id, promptContextDoc),
      userPrompt:
        inspectorContext.runtimeProfile === "daemon"
          ? buildDaemonPolicySubtreePrompt(inspectorContext, [])
          : inspectorContext.runtimeProfile === "primary_agent"
            ? buildPrimaryAgentPolicySubtreePrompt(inspectorContext, [])
          : buildGenericPolicySubtreePrompt(inspectorContext, []),
      inputs: io.inputs,
      outputs: io.outputs,
      outputFields: [],
      nodes,
    };
  }

  const stateFields = mapStateFields(inspectorContext.stateSchema);
  const contextPrompt = buildStateNodeOnlyPrompt(
    entry,
    node.id,
    stateFields,
    promptContextDoc
  );

  if (outputFields.length > 0) {
    return {
      stepType: "prompt_extract",
      systemPrompt: null,
      userPrompt:
        inspectorContext.runtimeProfile === "primary_agent"
          ? buildPrimaryAgentStateExtractionPrompt(
              inspectorContext,
              contextPrompt,
              outputFields
            )
          : buildGenericStateExtractionPrompt(
              inspectorContext,
              contextPrompt,
              outputFields
            ),
      inputs: io.inputs,
      outputs: io.outputs,
      outputFields,
      nodes,
    };
  }

  if (joinToolTarget) {
    const toolFields: StatePromptExtractionField[] = [
      {
        name: buildToolParentContributionVariableName(node, joinToolTarget),
        type: "json",
        instruction: buildToolContributionInstruction(joinToolTarget, node),
      },
    ];
    return {
      stepType: "prompt_extract",
      systemPrompt: null,
      userPrompt:
        inspectorContext.runtimeProfile === "primary_agent"
          ? buildPrimaryAgentStateExtractionPrompt(
              inspectorContext,
              contextPrompt,
              toolFields
            )
          : buildGenericStateExtractionPrompt(
              inspectorContext,
              contextPrompt,
              toolFields
            ),
      inputs: io.inputs,
      outputs: io.outputs,
      outputFields: toolFields,
      nodes,
    };
  }

  return {
    stepType: "prompt_subtree_update",
    systemPrompt: contextPrompt,
    userPrompt:
      inspectorContext.runtimeProfile === "primary_agent"
        ? buildPrimaryAgentStateSubtreePrompt(inspectorContext)
        : buildGenericStateSubtreePrompt(inspectorContext),
    inputs: io.inputs,
    outputs: io.outputs,
    outputFields: [],
    nodes,
  };
}

export function buildPromptTransformInspectorPreview(args: {
  node: CanvasNodeRecord;
  entry: CanvasEntry;
  inspectorContext: CanvasInspectorContext;
  promptContextDoc?: CanvasDoc;
}): PromptTransformInspectorPreview | null {
  const { node, entry, inspectorContext, promptContextDoc } = args;
  if (
    inspectorContext.executionPhase &&
    inspectorContext.executionPhase !== "policy"
  ) {
    return null;
  }

  if (
    getNodeActionSubtype(node) !== "prompt_transform"
  ) {
    return null;
  }

  const instruction = typeof node.data?.label === "string" ? node.data.label.trim() : "";
  if (!instruction) {
    return null;
  }
  const inputVariable = readPromptTransformInputVariable(node);
  const outputVariable = readPromptTransformOutputVariable(node);

  const joinToolTarget = getDirectJoinToolTarget(entry, node);
  if (joinToolTarget) {
    const outputFields: StatePromptExtractionField[] = [
      {
        name: buildToolParentContributionVariableName(node, joinToolTarget),
        type: "json",
        instruction: buildToolContributionInstruction(joinToolTarget, node),
      },
    ];
    const contextPrompt = buildNodeOnlyPrompt(entry, node.id, promptContextDoc);

    return {
      stepType: "prompt_extract",
      systemPrompt: null,
      userPrompt:
        inspectorContext.runtimeProfile === "daemon"
          ? buildDaemonPolicyExtractionPrompt(
              inspectorContext,
              contextPrompt,
              outputFields
            )
          : inspectorContext.runtimeProfile === "primary_agent"
            ? buildPrimaryAgentPolicyExtractionPrompt(
                inspectorContext,
                contextPrompt,
                outputFields
              )
          : buildGenericPolicyExtractionPrompt(
              inspectorContext,
              contextPrompt,
              outputFields
            ),
    };
  }

  return {
    stepType: "prompt_transform",
    systemPrompt: null,
    userPrompt:
      inspectorContext.runtimeProfile === "daemon"
        ? buildDaemonPolicyTransformPrompt(
            inspectorContext,
            instruction,
            inputVariable,
            outputVariable
          )
        : inspectorContext.runtimeProfile === "primary_agent"
          ? buildPrimaryAgentPolicyTransformPrompt(
              inspectorContext,
              instruction,
              inputVariable,
              outputVariable
            )
        : buildGenericPolicyTransformPrompt(
            inspectorContext,
            instruction,
            inputVariable,
            outputVariable
          ),
  };
}
