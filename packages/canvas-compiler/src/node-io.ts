import { parseExplicitLocalValueConditionLabel } from "@airlab/canvas-core/lib/canvas-condition-labels";
import {
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
} from "@airlab/canvas-core/lib/canvas-flow-values";
import { normalizePromptOutputFields } from "@airlab/canvas-core/components/canvas/prompt-output-fields";
import { getCanvasNodeDeclaredInputFields } from "./node-declared-inputs";
import { getNodeActionSubtype, isPromptLikeNode } from "@airlab/canvas-core/components/canvas/action-subtype";
import { getCanvasNodeDeclaredOutputFields } from "@airlab/canvas-core/components/canvas/node-declared-outputs";
import {
  isAsyncJobRuntimeOperation,
  readAsyncJobSourceVariable,
} from "@airlab/canvas-core/lib/canvas-async-job-config";
import {
  getRuntimeOperationKindFromNode,
  type CanvasEdgeRecord,
  type CanvasIoEdge,
  type CanvasDoc,
  type CanvasNode,
  type CanvasNodeRecord,
} from "./types";
import { nodeHasExecutableCodeSource } from "@airlab/canvas-core/lib/canvas-node-code-script";
import { collectAvailableCanvasLocalFields } from "@airlab/canvas-core/lib/canvas-local-dataflow";

export interface NodeIoField {
  name: string;
  type: string;
  origin?: string;
}

export interface NodeIoShape {
  inputs: NodeIoField[];
  outputs: NodeIoField[];
}

export interface NodeConnectedDataFlowShape {
  incoming: NodeIoField[];
  outgoing: NodeIoField[];
}

export interface PromptGroupIoGroup {
  phase: "policy" | "state";
  nodeIds: string[];
}

export type EdgeIoEndpoint =
  | { kind: "node"; nodeId: string }
  | ({ kind: "prompt_group" } & PromptGroupIoGroup);

function readActionType(node: CanvasNode): string {
  return getNodeActionSubtype(node);
}

function displayNodeLabel(node: CanvasNode): string {
  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  if (label) {
    return label;
  }

  return node.type?.trim() || "node";
}

function normalizeFieldType(raw: unknown): string {
  return raw === "integer" ||
    raw === "boolean" ||
    raw === "string[]" ||
    raw === "number" ||
    raw === "json"
    ? raw
    : "string";
}

function parseToolParameterInputs(node: CanvasNode): NodeIoField[] {
  const raw =
    typeof node.data?.paramsSchema === "string" ? node.data.paramsSchema.trim() : "";
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, { type?: unknown }>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }

    return Object.entries(parsed)
      .map(([name, fragment]) => ({
        name: name.trim(),
        type: normalizeFieldType(fragment?.type),
        origin: "tool parameter",
      }))
      .filter((field) => field.name.length > 0);
  } catch {
    return [];
  }
}

function parseAsyncJobRuntimeOperationInputs(node: CanvasNode): NodeIoField[] {
  const runtimeOperation = getRuntimeOperationKindFromNode(node);
  if (!runtimeOperation || !isAsyncJobRuntimeOperation(runtimeOperation)) {
    return [];
  }
  const variableName = readAsyncJobSourceVariable(node.data);
  if (!variableName) {
    return [];
  }
  return [
    {
      name: variableName,
      type: "json",
      origin: "async job reference",
    },
  ];
}

function isToolCallNode(node: CanvasNode): boolean {
  return node.type === "tool_call" || readActionType(node) === "tool_call";
}

function isTypeScriptCodeNode(node: CanvasNode): boolean {
  return node.type === "code" && nodeHasExecutableCodeSource(node);
}

function getDisplayInputVariableName(node: CanvasNode): string | null {
  if (readActionType(node) !== "display") {
    return null;
  }

  const displayType = node.data?.displayType === "video" ? "video" : "text";
  const videoUrl =
    typeof node.data?.videoUrl === "string" ? node.data.videoUrl.trim() : "";
  if (displayType === "video" && videoUrl) {
    return null;
  }

  const raw =
    typeof node.data?.inputVariable === "string"
      ? node.data.inputVariable.trim()
      : "";
  return raw || CARRIED_OUTPUT_PROMPT_VALUE_NAME;
}

function nodeDeclaresLocalInput(node: CanvasNode, name: string): boolean {
  return getCanvasNodeDeclaredInputFields(node).some(
    (field) => field.name === name
  );
}

function nodeImplicitlyConsumesCarriedOutput(node: CanvasNode): boolean {
  return (
    node.type === "expand" ||
    getRuntimeOperationKindFromNode(node) !== null
  );
}

function nodeConsumesCarriedOutput(node: CanvasNode): boolean {
  return (
    nodeImplicitlyConsumesCarriedOutput(node) ||
    nodeDeclaresLocalInput(node, CARRIED_OUTPUT_PROMPT_VALUE_NAME)
  );
}

function promptTransformWritesCarriedOutput(node: CanvasNode): boolean {
  if (readActionType(node) !== "prompt_transform") {
    return false;
  }

  const outputVariable =
    typeof node.data?.outputVariable === "string"
      ? node.data.outputVariable.trim()
      : "";
  return !outputVariable || outputVariable === CARRIED_OUTPUT_PROMPT_VALUE_NAME;
}

function nodeMayProduceCarriedOutput(node: CanvasNode): boolean {
  if (node.type === "expand") {
    return true;
  }

  if (isToolCallNode(node)) {
    return true;
  }

  const actionType = readActionType(node);
  if (isTypeScriptCodeNode(node)) {
    return true;
  }
  if (promptTransformWritesCarriedOutput(node) || actionType === "display") {
    return true;
  }

  if (getRuntimeOperationKindFromNode(node) !== null) {
    return true;
  }

  return (
    isPromptLikeNode(node) &&
    actionType !== "display" &&
    actionType !== "prompt_transform"
  );
}

function inferPromptConditionType(label: string): string | null {
  const explicitLocalValueCondition =
    parseExplicitLocalValueConditionLabel(label);
  if (!explicitLocalValueCondition) {
    return null;
  }

  const rest = explicitLocalValueCondition.rest;
  if (
    /^is\s+true$/i.test(rest) ||
    /^equals\s+true$/i.test(rest) ||
    /^is\s+false$/i.test(rest) ||
    /^equals\s+false$/i.test(rest)
  ) {
    return "boolean";
  }

  const equalsMatch = rest.match(/^(?:is|equals)\s+(.+)$/i);
  if (equalsMatch) {
    const rawValue = equalsMatch[1].trim().replace(/^["'`]+|["'`]+$/g, "");
    if (/^-?\d+$/.test(rawValue)) {
      return "integer";
    }
    if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) {
      return "number";
    }
    return "string";
  }

  if (/^(?:contains|includes)\s+(.+)$/i.test(rest)) {
    return "string";
  }

  return "unknown";
}

function inferConditionValueType(rest: string): string {
  if (
    /^is\s+true$/i.test(rest) ||
    /^equals\s+true$/i.test(rest) ||
    /^is\s+false$/i.test(rest) ||
    /^equals\s+false$/i.test(rest)
  ) {
    return "boolean";
  }

  const equalsMatch = rest.match(/^(?:is|equals)\s+(.+)$/i);
  if (equalsMatch) {
    const rawValue = equalsMatch[1].trim().replace(/^["'`]+|["'`]+$/g, "");
    if (/^-?\d+$/.test(rawValue)) {
      return "integer";
    }
    if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) {
      return "number";
    }
    return "string";
  }

  if (/^(?:contains|includes)\s+(.+)$/i.test(rest)) {
    return "string";
  }

  return "unknown";
}

function matchFieldPrefix(label: string, fieldName: string): string | null {
  const variants = Array.from(
    new Set([
      fieldName.trim(),
      fieldName.trim().replace(/_/g, " "),
      fieldName.trim().replace(/\s+/g, "_"),
    ])
  ).filter((value) => value.length > 0);

  for (const variant of variants) {
    const pattern = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = label.match(new RegExp(`^${pattern}\\b`, "i"));
    if (match) {
      return match[0];
    }
  }

  return null;
}

function normalizeCanvasName(value: string): string {
  return value.trim().toLowerCase();
}

function findCanvasByLabel(doc: CanvasDoc | undefined, label: string) {
  if (!doc) {
    return null;
  }

  const normalizedLabel = normalizeCanvasName(label);
  return (
    doc.canvases.find(
      (canvas) => normalizeCanvasName(canvas.name) === normalizedLabel
    ) ?? null
  );
}

function getDeclaredOutputFields(
  node: Pick<CanvasNode, "type" | "data">
): NodeIoField[] {
  return getCanvasNodeDeclaredOutputFields(node).map((field) => ({
    name: field.name,
    type: field.type,
    origin: field.origin,
  }));
}

function collectExpandSubcanvasStructuredOutputs(
  doc: CanvasDoc,
  label: string,
  visitedCanvasNames: Set<string> = new Set()
): NodeIoField[] {
  const canvas = findCanvasByLabel(doc, label);
  if (!canvas) {
    return [];
  }

  const canvasKey = normalizeCanvasName(canvas.name);
  if (!canvasKey || visitedCanvasNames.has(canvasKey)) {
    return [];
  }

  const nextVisited = new Set(visitedCanvasNames);
  nextVisited.add(canvasKey);
  const outputs: NodeIoField[] = [];

  for (const node of canvas.graph.nodes) {
    outputs.push(...getDeclaredOutputFields(node));

    if (node.type !== "expand") {
      continue;
    }

    const nestedLabel =
      typeof node.data?.label === "string" ? node.data.label.trim() : "";
    if (!nestedLabel) {
      continue;
    }

    outputs.push(
      ...collectExpandSubcanvasStructuredOutputs(doc, nestedLabel, nextVisited)
    );
  }

  return dedupeFields(outputs);
}

function getStructuredNodeOutputs(
  node: CanvasNode,
  doc?: CanvasDoc
): NodeIoField[] {
  const directOutputs = getDeclaredOutputFields(node);
  if (node.type !== "expand" || !doc) {
    return directOutputs;
  }

  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  if (!label) {
    return directOutputs;
  }

  return dedupeFields([
    ...directOutputs,
    ...collectExpandSubcanvasStructuredOutputs(doc, label),
  ]);
}

function getNodeOutputs(node: CanvasNode, doc?: CanvasDoc): NodeIoField[] {
  return dedupeFields(getStructuredNodeOutputs(node, doc));
}

function collectAvailableOutputFields(
  nodes: CanvasNode[],
  edges: CanvasIoEdge[],
  nodeId: string
): NodeIoField[] {
  const availableFields = collectAvailableCanvasLocalFields({
    nodes: nodes as unknown as CanvasNodeRecord[],
    edges: edges as unknown as CanvasEdgeRecord[],
    nodeId,
  });
  return availableFields.map((field) => ({
    ...field,
    origin: `available before this node (${field.origin})`,
  }));
}

function parseConditionInputs(
  node: CanvasNode,
  availableUpstreamOutputs: NodeIoField[]
): NodeIoField[] {
  if (node.type !== "condition" && node.type !== "while") {
    return [];
  }

  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  const explicitLocalValueCondition =
    parseExplicitLocalValueConditionLabel(label);
  if (!explicitLocalValueCondition) {
    const upstreamMatch = availableUpstreamOutputs.find((field) => {
      const prefix = matchFieldPrefix(label, field.name);
      return prefix && inferConditionValueType(label.slice(prefix.length).trim()) !== "unknown";
    });

    if (!upstreamMatch) {
      return [];
    }

    return [
      {
        name: upstreamMatch.name,
        type: upstreamMatch.type,
        origin: upstreamMatch.origin ?? "condition",
      },
    ];
  }

  return [
    {
      name: explicitLocalValueCondition.name,
      type: inferPromptConditionType(label) ?? "unknown",
      origin: "condition",
    },
  ];
}

function dedupeFields(fields: NodeIoField[]): NodeIoField[] {
  const seen = new Set<string>();
  const deduped: NodeIoField[] = [];

  for (const field of fields) {
    const key = `${field.name}::${field.type}::${field.origin ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(field);
  }

  return deduped;
}

export function describeNodeIo(
  nodes: CanvasNode[],
  edges: CanvasIoEdge[],
  node: CanvasNode,
  doc?: CanvasDoc
): NodeIoShape {
  const availableOutputs = collectAvailableOutputFields(nodes, edges, node.id);
  const declaredInputs = getCanvasNodeDeclaredInputFields(node);
  const structuredInputs =
    node.type === "condition" || node.type === "while"
      ? parseConditionInputs(node, availableOutputs)
      : [];
  const displayInputVariable = getDisplayInputVariableName(node);
  const implicitInputs = !displayInputVariable && nodeImplicitlyConsumesCarriedOutput(node)
    ? [
        {
          name: CARRIED_OUTPUT_PROMPT_VALUE_NAME,
          type: "string",
          origin: `from reserved local variable ${CARRIED_OUTPUT_PROMPT_VALUE_NAME}`,
        },
      ]
    : [];

  const directInputs =
    isToolCallNode(node)
      ? parseToolParameterInputs(node)
      : parseAsyncJobRuntimeOperationInputs(node);

  return {
    inputs: dedupeFields([
      ...implicitInputs,
      ...declaredInputs,
      ...structuredInputs,
      ...directInputs,
    ]),
    outputs: dedupeFields(getNodeOutputs(node, doc)),
  };
}

function collectPromptGroupOutputFields(
  nodes: CanvasNode[],
  nodeIds: string[]
): NodeIoField[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const fieldsByName = new Map<string, NodeIoField>();

  for (const nodeId of nodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) {
      continue;
    }

    for (const field of normalizePromptOutputFields(node.data?.promptOutputFields)) {
      fieldsByName.set(field.name, {
        name: field.name,
        type: field.type,
        origin: "local output",
      });
    }
  }

  return Array.from(fieldsByName.values());
}

function collectPromptGroupInputs(
  nodes: CanvasNode[],
  _edges: CanvasIoEdge[],
  group: PromptGroupIoGroup
): NodeIoField[] {
  const outputs: NodeIoField[] = [];

  for (const nodeId of group.nodeIds) {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      continue;
    }
    outputs.push(...getCanvasNodeDeclaredInputFields(node));
  }

  return dedupeFields(outputs);
}

export function describePromptGroupIo(
  nodes: CanvasNode[],
  edges: CanvasIoEdge[],
  group: PromptGroupIoGroup
): NodeIoShape {
  const explicitOutputs = collectPromptGroupOutputFields(nodes, group.nodeIds);
  const outputs =
    group.phase === "policy" || (group.phase === "state" && explicitOutputs.length === 0)
      ? dedupeFields([
          {
            name: CARRIED_OUTPUT_PROMPT_VALUE_NAME,
            type: group.phase === "state" ? "json" : "string",
            origin: `reserved local variable ${CARRIED_OUTPUT_PROMPT_VALUE_NAME}`,
          },
          ...explicitOutputs,
        ])
      : explicitOutputs;

  return {
    inputs: collectPromptGroupInputs(nodes, edges, group),
    outputs,
  };
}

function endpointLabel(nodes: CanvasNode[], endpoint: EdgeIoEndpoint): string {
  if (endpoint.kind === "prompt_group") {
    return "combined prompt";
  }

  const node = nodes.find((candidate) => candidate.id === endpoint.nodeId);
  return node ? displayNodeLabel(node) : "node";
}

function getEndpointStructuredOutputs(
  nodes: CanvasNode[],
  endpoint: EdgeIoEndpoint,
  doc?: CanvasDoc
): NodeIoField[] {
  if (endpoint.kind === "prompt_group") {
    return collectPromptGroupOutputFields(nodes, endpoint.nodeIds);
  }

  const node = nodes.find((candidate) => candidate.id === endpoint.nodeId) ?? null;
  return node ? getStructuredNodeOutputs(node, doc) : [];
}

function endpointCanSupplyCarriedOutput(
  nodes: CanvasNode[],
  endpoint: EdgeIoEndpoint
): boolean {
  if (endpoint.kind === "prompt_group") {
    return describePromptGroupIo(nodes, [], endpoint).outputs.some(
      (field) => field.name === CARRIED_OUTPUT_PROMPT_VALUE_NAME
    );
  }

  const node = nodes.find((candidate) => candidate.id === endpoint.nodeId) ?? null;
  return node ? nodeMayProduceCarriedOutput(node) : false;
}

function endpointCarriedOutputType(
  nodes: CanvasNode[],
  endpoint: EdgeIoEndpoint,
  doc?: CanvasDoc
): string {
  if (endpoint.kind === "prompt_group") {
    return (
      describePromptGroupIo(nodes, [], endpoint).outputs.find(
        (field) => field.name === CARRIED_OUTPUT_PROMPT_VALUE_NAME
      )?.type ?? "string"
    );
  }

  const node = nodes.find((candidate) => candidate.id === endpoint.nodeId) ?? null;
  return node
    ? getNodeOutputs(node, doc).find(
        (field) => field.name === CARRIED_OUTPUT_PROMPT_VALUE_NAME
      )?.type ?? "string"
    : "string";
}

function endpointConsumesPromptValues(
  nodes: CanvasNode[],
  endpoint: EdgeIoEndpoint
): boolean {
  if (endpoint.kind === "prompt_group") {
    return true;
  }

  const node = nodes.find((candidate) => candidate.id === endpoint.nodeId) ?? null;
  if (!node) {
    return false;
  }

  if (node.type === "condition" || node.type === "while") {
    return false;
  }

  if (isToolCallNode(node)) {
    return true;
  }

  if (node.type === "expand") {
    return true;
  }

  const actionType = readActionType(node);
  return (
    (isPromptLikeNode(node) || node.type === "code") &&
    actionType !== "display" &&
    actionType !== "prompt_transform" &&
    (actionType !== "code" || isTypeScriptCodeNode(node))
  );
}

function endpointConsumesCarriedOutput(
  nodes: CanvasNode[],
  endpoint: EdgeIoEndpoint
): boolean {
  if (endpoint.kind === "prompt_group") {
    return false;
  }

  const node = nodes.find((candidate) => candidate.id === endpoint.nodeId) ?? null;
  return node ? nodeConsumesCarriedOutput(node) : false;
}

export function describeEdgeDataFlow(args: {
  nodes: CanvasNode[];
  source: EdgeIoEndpoint;
  target: EdgeIoEndpoint;
  doc?: CanvasDoc;
}): NodeIoField[] {
  const sourceName = endpointLabel(args.nodes, args.source);
  const sourceStructuredOutputs = getEndpointStructuredOutputs(
    args.nodes,
    args.source,
    args.doc
  );
  const flowedFields: NodeIoField[] = [];

  if (
    endpointConsumesCarriedOutput(args.nodes, args.target) &&
    endpointCanSupplyCarriedOutput(args.nodes, args.source)
  ) {
    flowedFields.push({
      name: CARRIED_OUTPUT_PROMPT_VALUE_NAME,
      type: endpointCarriedOutputType(args.nodes, args.source, args.doc),
      origin: `from ${sourceName}`,
    });
  }

  const target = args.target;

  if (target.kind === "node") {
    const targetNode =
      args.nodes.find((candidate) => candidate.id === target.nodeId) ?? null;

    if (targetNode?.type === "condition" || targetNode?.type === "while") {
      const requiredFields = parseConditionInputs(targetNode, sourceStructuredOutputs);
      const sourceNames = new Set(sourceStructuredOutputs.map((field) => field.name));
      flowedFields.push(
        ...requiredFields
          .filter((field) => sourceNames.has(field.name))
          .map((field) => ({
            ...field,
            origin: `from ${sourceName}`,
          }))
      );
    } else {
      const declaredNames = new Set(
        getCanvasNodeDeclaredInputFields(targetNode ?? { data: { label: "" } }).map(
          (field) => field.name
        )
      );
      flowedFields.push(
        ...sourceStructuredOutputs
          .filter((field) => declaredNames.has(field.name))
          .map((field) => ({
            ...field,
            origin: `from ${sourceName}`,
          }))
      );
    }
  } else if (endpointConsumesPromptValues(args.nodes, target)) {
    flowedFields.push(
      ...sourceStructuredOutputs.map((field) => ({
        ...field,
        origin: `from ${sourceName}`,
      }))
    );
  }

  return dedupeFields(flowedFields);
}

export function describeNodeConnectedDataFlow(args: {
  nodes: CanvasNode[];
  edges: CanvasIoEdge[];
  node: CanvasNode;
  doc?: CanvasDoc;
}): NodeConnectedDataFlowShape {
  const incoming: NodeIoField[] = [];
  const outgoing: NodeIoField[] = [];

  for (const edge of args.edges) {
    if (edge.target === args.node.id) {
      incoming.push(
        ...describeEdgeDataFlow({
          nodes: args.nodes,
          source: { kind: "node", nodeId: edge.source },
          target: { kind: "node", nodeId: edge.target },
          doc: args.doc,
        })
      );
    }

    if (edge.source === args.node.id) {
      const targetLabel = endpointLabel(args.nodes, {
        kind: "node",
        nodeId: edge.target,
      });
      outgoing.push(
        ...describeEdgeDataFlow({
          nodes: args.nodes,
          source: { kind: "node", nodeId: edge.source },
          target: { kind: "node", nodeId: edge.target },
          doc: args.doc,
        }).map((field) => ({
          name: field.name,
          type: field.type,
          origin: `to ${targetLabel}`,
        }))
      );
    }
  }

  return {
    incoming: dedupeFields(incoming),
    outgoing: dedupeFields(outgoing),
  };
}
