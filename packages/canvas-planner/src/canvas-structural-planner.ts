import {
  type ConditionPlan,
  type CanvasExecutionSourceNodeRef,
  type HybridExecutionPlan,
  type PhaseExecutionPlan,
  type PolicyCodePlan,
  type PolicyExecutionGraph,
  type PolicyExecutionGraphStep,
  type PolicyRuntimeOperationName,
  type PolicyStageHandoff,
  type RuntimeStateField,
  type StateCodeOperation,
  type StateCodePlan,
  type StateExecutionGraph,
  type StateExecutionGraphStep,
  type StatePromptExtractionField,
} from "./canvas-hybrid-runtime";
import { buildCanvasSubtreeText } from "@airlab/canvas-compiler/compiler";
import {
  getNodeActionSubtype,
  isPromptLikeNode,
} from "@airlab/canvas-core/components/canvas/action-subtype";
import { normalizePromptOutputFields } from "@airlab/canvas-core/components/canvas/prompt-output-fields";
import { compileStateExtractionSubtreePrompt } from "@airlab/canvas-compiler/stateCompiler";
import {
  getRuntimeOperationKindFromNode,
  normalizeCanvasDoc,
  type CanvasDoc,
  type CanvasEdgeRecord,
  type CanvasEntry,
  type CanvasNodeRecord,
} from "@airlab/canvas-compiler/types";
import { readExplicitNodeExecutableStateCodeOps } from "@airlab/canvas-core/lib/canvas-node-code-ops";
import {
  CANVAS_CODE_NODE_ERROR_PROMPT_VALUE_NAME,
  CANVAS_TOOL_CALL_ERROR_PROMPT_VALUE_NAME,
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
} from "@airlab/canvas-core/lib/canvas-flow-values";
import { readNodeExecutableCodeSource } from "@airlab/canvas-core/lib/canvas-node-code-script";
import { parseExplicitLocalValueConditionLabel } from "@airlab/canvas-core/lib/canvas-condition-labels";
import {
  collectAvailableLocalFields,
  collectAvailableLocalValueNames,
} from "@airlab/canvas-core/lib/canvas-local-dataflow";
import {
  canRuntimeOperationQueueAsAsync,
  getAsyncRuntimeOperationResultVariableFallback,
  isAsyncJobRuntimeOperation,
  readAsyncJobPollIntervalMs,
  readAsyncJobResultVariable,
  readAsyncJobSourceVariable,
  readAsyncJobTimeoutMs,
  readCanvasAsyncExecutionMode,
} from "@airlab/canvas-core/lib/canvas-async-job-config";

type PolicyPhasePlan = PhaseExecutionPlan<PolicyCodePlan>;
type StatePhasePlan = PhaseExecutionPlan<StateCodePlan>;

interface StructuralPlanningArgs {
  stateSchema: RuntimeStateField[];
  stateCanvasDoc: CanvasDoc | null;
  policyCanvasDoc: CanvasDoc | null;
}

interface GraphMaps {
  byId: Map<string, CanvasNodeRecord>;
  outgoing: Map<string, CanvasEdgeRecord[]>;
  incoming: Map<string, CanvasEdgeRecord[]>;
}

interface PolicyLowerContext {
  doc: CanvasDoc;
  stateSchema: RuntimeStateField[];
  steps: PolicyExecutionGraphStep[];
  nextId: number;
  deterministicCanvasMemo: Map<string, boolean>;
  sharedNodeMemo: Map<string, LoweringContinuation>;
  promptGroups: StructuralPromptGroup[];
  recordedPromptGroupKeys: Set<string>;
}

interface StateLowerContext {
  doc: CanvasDoc;
  stateSchema: RuntimeStateField[];
  steps: StateExecutionGraphStep[];
  nextId: number;
  deterministicCanvasMemo: Map<string, boolean>;
  sharedNodeMemo: Map<string, LoweringContinuation>;
  promptGroups: StructuralPromptGroup[];
  recordedPromptGroupKeys: Set<string>;
}

interface LoweringContinuation {
  stepId: string | null;
  coveredNodeKeys: Set<string>;
}

export interface StructuralPromptGroup {
  phase: "policy" | "state";
  canvasId: string;
  rootNodeId: string;
  nodeIds: string[];
}

interface FlexibleSubtreeStats {
  nodeCount: number;
  hardStructuralCount: number;
  promptLikeCount: number;
  explicitOutputCount: number;
}

interface PromptSegment {
  rootNodeId: string;
  nodeIds: string[];
  boundaryTargetIds: string[];
}

interface SelectedPromptSegment extends PromptSegment {
  prompt: string;
  outputFields: StatePromptExtractionField[];
}

const POLICY_PROMPT_COLLAPSE_SOFT_MAX_CHARS = 1800;
const POLICY_PROMPT_COLLAPSE_MEDIUM_MAX_CHARS = 2600;
const POLICY_PROMPT_COLLAPSE_HARD_MAX_CHARS = 4200;
const STATE_PROMPT_COLLAPSE_SOFT_MAX_CHARS = 1800;
const STATE_PROMPT_COLLAPSE_MEDIUM_MAX_CHARS = 2600;
const STATE_PROMPT_COLLAPSE_HARD_MAX_CHARS = 4200;
const REQUEST_ROUTING_STATE_FIELD_NAMES = [
  "user_requests",
  "user_edit_requests",
  "user_tooling_requests",
  "user_skill_requests",
  "user_environment_agent_requests",
  "process_open_questions",
  "process_ready",
];

function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/[_\s]+/g, " ");
}

function inferStatePromptPreserveFieldNames(
  prompt: string
): string[] | undefined {
  const normalized = normalizeKey(prompt);
  const asksToPreserveRequestRouting =
    normalized.includes(normalizeKey("Do not update or reclassify user_requests")) ||
    normalized.includes(normalizeKey("Preserve those fields exactly"));
  const ownsRequestRouting =
    normalized.includes(
      normalizeKey("Also update process_description, session_rules, user_requests")
    ) ||
    normalized.includes(normalizeKey("sole owner of request routing"));

  return asksToPreserveRequestRouting && !ownsRequestRouting
    ? REQUEST_ROUTING_STATE_FIELD_NAMES
    : undefined;
}

function statePromptPreserveFieldsData(
  prompt: string
): { preserve_field_names?: string[] } {
  const preserveFieldNames = inferStatePromptPreserveFieldNames(prompt);
  return preserveFieldNames ? { preserve_field_names: preserveFieldNames } : {};
}

function buildGraphMaps(entry: CanvasEntry): GraphMaps {
  const byId = new Map(entry.graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, CanvasEdgeRecord[]>();
  const incoming = new Map<string, CanvasEdgeRecord[]>();
  for (const edge of entry.graph.edges) {
    const arr = outgoing.get(edge.source) ?? [];
    arr.push(edge);
    outgoing.set(edge.source, arr);
    const incomingArr = incoming.get(edge.target) ?? [];
    incomingArr.push(edge);
    incoming.set(edge.target, incomingArr);
  }
  return { byId, outgoing, incoming };
}

function findCanvasByLabel(doc: CanvasDoc, label: string): CanvasEntry | null {
  const targetKey = normalizeKey(label);
  return doc.canvases.find((canvas) => normalizeKey(canvas.name || canvas.id) === targetKey) ?? null;
}

function getStartNode(entry: CanvasEntry): CanvasNodeRecord | null {
  return entry.graph.nodes.find((node) => node.type === "start") ?? null;
}

function getStartTargets(entry: CanvasEntry): string[] {
  const start = getStartNode(entry);
  if (!start) {
    return [];
  }
  const { outgoing } = buildGraphMaps(entry);
  return (outgoing.get(start.id) ?? []).map((edge) => edge.target);
}

function getSequentialTargets(entry: CanvasEntry, nodeId: string): string[] {
  const { outgoing } = buildGraphMaps(entry);
  return (outgoing.get(nodeId) ?? []).map((edge) => edge.target);
}

function isCallErrorEdge(edge: CanvasEdgeRecord): boolean {
  const handle = typeof edge.sourceHandle === "string" ? edge.sourceHandle.trim().toLowerCase() : "";
  if (handle === "error" || handle === "failure" || handle === "fallback") {
    return true;
  }

  const label = typeof edge.label === "string" ? edge.label.trim().toLowerCase() : "";
  return label === "error" || label === "failure" || label === "fallback" || label === "fail";
}

function getCallNodeTargets(entry: CanvasEntry, nodeId: string): {
  successTargets: string[];
  errorTarget: string | null;
} {
  const { outgoing } = buildGraphMaps(entry);
  const edges = outgoing.get(nodeId) ?? [];
  const errorEdge = edges.find(isCallErrorEdge) ?? null;
  return {
    successTargets: edges.filter((edge) => !isCallErrorEdge(edge)).map((edge) => edge.target),
    errorTarget: errorEdge?.target ?? null,
  };
}

function getConditionTargets(entry: CanvasEntry, nodeId: string): {
  trueTarget: string | null;
  falseTarget: string | null;
  hasUnexpectedEdges: boolean;
} {
  const { outgoing } = buildGraphMaps(entry);
  const edges = outgoing.get(nodeId) ?? [];
  // A branch is identified by the source handle the edge leaves from
  // ("true"/"false"). Seed graphs and edges authored before handles existed
  // instead encode the branch in the edge label, so fall back to that.
  const branchKey = (edge: CanvasEdgeRecord): "true" | "false" | null => {
    if (edge.sourceHandle === "true" || edge.sourceHandle === "false") {
      return edge.sourceHandle;
    }
    const label = typeof edge.label === "string" ? edge.label.trim().toLowerCase() : "";
    return label === "true" || label === "false" ? label : null;
  };
  let trueEdge = edges.find((edge) => branchKey(edge) === "true") ?? null;
  let falseEdge = edges.find((edge) => branchKey(edge) === "false") ?? null;
  // Tolerate a single handle-less edge by treating it as the one missing branch.
  // Users sometimes draw a branch by dragging from the node body instead of the
  // true/false port, which leaves an edge with no sourceHandle. As long as one
  // branch handle is present and exactly one such plain edge exists, fill the
  // empty branch slot with it rather than rejecting the whole graph.
  if (Boolean(trueEdge) !== Boolean(falseEdge)) {
    const plainEdges = edges.filter((edge) => branchKey(edge) === null);
    if (plainEdges.length === 1) {
      if (!trueEdge) {
        trueEdge = plainEdges[0];
      } else {
        falseEdge = plainEdges[0];
      }
    }
  }
  const handledIds = new Set(
    [trueEdge?.id, falseEdge?.id].filter((value): value is string => typeof value === "string")
  );
  return {
    trueTarget: trueEdge?.target ?? null,
    falseTarget: falseEdge?.target ?? null,
    hasUnexpectedEdges: edges.some((edge) => !handledIds.has(edge.id)),
  };
}

function getLoopTargets(entry: CanvasEntry, nodeId: string): {
  bodyTarget: string | null;
  doneTarget: string | null;
  hasUnexpectedEdges: boolean;
} {
  const { outgoing } = buildGraphMaps(entry);
  const edges = outgoing.get(nodeId) ?? [];
  let bodyEdge =
    edges.find((edge) => edge.sourceHandle === "body") ??
    edges.find((edge) => edge.sourceHandle === "true") ??
    null;
  let doneEdge =
    edges.find((edge) => edge.sourceHandle === "done") ??
    edges.find((edge) => edge.sourceHandle === "false") ??
    null;
  // See getConditionTargets: tolerate one handle-less edge as the missing branch.
  if (Boolean(bodyEdge) !== Boolean(doneEdge)) {
    const plainEdges = edges.filter((edge) => !edge.sourceHandle);
    if (plainEdges.length === 1) {
      if (!bodyEdge) {
        bodyEdge = plainEdges[0];
      } else {
        doneEdge = plainEdges[0];
      }
    }
  }
  const handledIds = new Set(
    [bodyEdge?.id, doneEdge?.id].filter((value): value is string => typeof value === "string")
  );
  return {
    bodyTarget: bodyEdge?.target ?? null,
    doneTarget: doneEdge?.target ?? null,
    hasUnexpectedEdges: edges.some((edge) => !handledIds.has(edge.id)),
  };
}

function readLoopMaxIterations(node: Pick<CanvasNodeRecord, "data">): number {
  const raw = node.data?.maxIterations;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1
    ? Math.min(Math.trunc(raw), 12)
    : 3;
}

function sanitizeToolFunctionName(raw: string): string {
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

function inferToolFunctionName(node: CanvasNodeRecord): string {
  const explicitName = typeof node.data?.toolName === "string" ? node.data.toolName.trim() : "";
  if (explicitName) {
    return sanitizeToolFunctionName(explicitName);
  }

  const label = typeof node.data?.label === "string" ? node.data.label.trim() : "";
  return label ? sanitizeToolFunctionName(label) : "";
}

function sanitizePromptValueName(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function buildCanvasNodeKey(canvasId: string, nodeId: string): string {
  return `${canvasId}:${nodeId}`;
}

function parseCanvasNodeKey(key: string): CanvasExecutionSourceNodeRef | null {
  const separator = key.lastIndexOf(":");
  if (separator <= 0 || separator >= key.length - 1) {
    return null;
  }

  return {
    canvasId: key.slice(0, separator),
    nodeId: key.slice(separator + 1),
  };
}

function sourceNodeRefsFromKeys(
  keys: Iterable<string> | null | undefined
): CanvasExecutionSourceNodeRef[] | undefined {
  if (!keys) {
    return undefined;
  }

  const refs: CanvasExecutionSourceNodeRef[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const ref = parseCanvasNodeKey(key);
    if (!ref) {
      continue;
    }
    const refKey = `${ref.canvasId}:${ref.nodeId}`;
    if (seen.has(refKey)) {
      continue;
    }
    seen.add(refKey);
    refs.push(ref);
  }

  return refs.length > 0 ? refs : undefined;
}

function canvasNodeKeysForNodeIds(
  entry: CanvasEntry,
  nodeIds: Iterable<string>
): string[] {
  return Array.from(nodeIds, (nodeId) => buildCanvasNodeKey(entry.id, nodeId));
}

function createLoweringContinuation(
  stepId: string | null,
  coveredNodeKeys: Iterable<string> = []
): LoweringContinuation {
  return {
    stepId,
    coveredNodeKeys: new Set(coveredNodeKeys),
  };
}

function extendLoweringContinuation(
  continuation: LoweringContinuation,
  stepId: string | null,
  coveredNodeKeys: Iterable<string>
): LoweringContinuation {
  const nextCoveredNodeKeys = new Set(continuation.coveredNodeKeys);
  for (const key of coveredNodeKeys) {
    nextCoveredNodeKeys.add(key);
  }
  return {
    stepId,
    coveredNodeKeys: nextCoveredNodeKeys,
  };
}

function intersectCoveredNodeKeys(
  left: Set<string>,
  right: Set<string>
): Set<string> {
  const shared = new Set<string>();
  for (const key of left) {
    if (right.has(key)) {
      shared.add(key);
    }
  }
  return shared;
}

function buildSharedNodeMemoKey(
  entry: CanvasEntry,
  nodeId: string,
  continuation: LoweringContinuation
): string {
  const covered = Array.from(continuation.coveredNodeKeys).sort().join(",");
  return `${entry.id}:${nodeId}:${continuation.stepId ?? "__end__"}:${covered}`;
}

function continuationCoversNode(
  continuation: LoweringContinuation,
  entry: CanvasEntry,
  nodeId: string
): boolean {
  return continuation.coveredNodeKeys.has(buildCanvasNodeKey(entry.id, nodeId));
}

function collectReachableNodeKeys(entry: CanvasEntry, nodeId: string): Set<string> {
  const maps = buildGraphMaps(entry);
  const visited = new Set<string>();
  const visit = (targetId: string) => {
    const key = buildCanvasNodeKey(entry.id, targetId);
    if (visited.has(key) || !maps.byId.has(targetId)) {
      return;
    }
    visited.add(key);
    for (const edge of maps.outgoing.get(targetId) ?? []) {
      visit(edge.target);
    }
  };

  visit(nodeId);
  return visited;
}

function collectReachableNodeIds(entry: CanvasEntry, nodeId: string): string[] {
  const prefix = `${entry.id}:`;
  return Array.from(collectReachableNodeKeys(entry, nodeId))
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

function collectReachableFilteredNodeIds(
  entry: CanvasEntry,
  nodeId: string,
  includeNode: (node: CanvasNodeRecord) => boolean
): string[] {
  const maps = buildGraphMaps(entry);
  return collectReachableNodeIds(entry, nodeId).filter((reachableNodeId) => {
    const reachableNode = maps.byId.get(reachableNodeId);
    return Boolean(reachableNode && includeNode(reachableNode));
  });
}

function recordPromptGroup(
  phase: StructuralPromptGroup["phase"],
  entry: CanvasEntry,
  rootNodeId: string,
  groups: StructuralPromptGroup[],
  seenKeys: Set<string>,
  explicitNodeIds?: string[]
) {
  const nodeIds =
    explicitNodeIds && explicitNodeIds.length > 0
      ? Array.from(
          new Set(explicitNodeIds.filter((nodeId) => nodeId.trim().length > 0))
        )
      : collectReachableNodeIds(entry, rootNodeId);
  if (nodeIds.length <= 1) {
    return;
  }

  const normalizedNodeIds = [...nodeIds].sort();
  const groupKey = `${phase}:${entry.id}:${rootNodeId}:${normalizedNodeIds.join(",")}`;
  if (seenKeys.has(groupKey)) {
    return;
  }

  seenKeys.add(groupKey);
  groups.push({
    phase,
    canvasId: entry.id,
    rootNodeId,
    nodeIds,
  });
}

function isPolicyCollapsedPromptGroupMember(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord
): boolean {
  if (isPromptLikeNode(node)) {
    const actionType = readNodeActionType(node);
    if (
      actionType === "code" ||
      actionType === "display" ||
      actionType === "tool_call" ||
      getPolicyRuntimeOperation(node)
    ) {
      return false;
    }
    if (
      actionType === "prompt" ||
      actionType === "prompt_transform" ||
      nodeHasPromptOutputFields(node)
    ) {
      return true;
    }
    if (getDirectToolTarget(entry, node)) {
      return true;
    }
    return !resolveNodeExecutableStateCodeOps(node, ctx.stateSchema);
  }

  if (node.type === "condition") {
    const condition = parseConditionLabel(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    return !condition || getConditionTargets(entry, node.id).hasUnexpectedEdges;
  }

  return false;
}

function isStateCollapsedPromptGroupMember(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord
): boolean {
  if (isPromptLikeNode(node)) {
    const actionType = readNodeActionType(node);
    if (
      actionType === "code" ||
      actionType === "display" ||
      actionType === "tool_call" ||
      getStateRuntimeOperation(node)
    ) {
      return false;
    }
    if (
      actionType === "prompt" ||
      actionType === "prompt_transform" ||
      nodeHasPromptOutputFields(node)
    ) {
      return true;
    }
    if (getDirectToolTarget(entry, node)) {
      return true;
    }
    return !resolveNodeExecutableStateCodeOps(node, ctx.stateSchema);
  }

  if (node.type === "condition") {
    const condition = parseConditionLabel(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    return !condition || getConditionTargets(entry, node.id).hasUnexpectedEdges;
  }

  return false;
}

function collectPolicyCollapsedPromptNodeIds(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  rootNodeId: string
): string[] {
  return collectReachableFilteredNodeIds(entry, rootNodeId, (candidate) =>
    isPolicyCollapsedPromptGroupMember(ctx, entry, candidate)
  );
}

function collectStateCollapsedPromptNodeIds(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  rootNodeId: string
): string[] {
  return collectReachableFilteredNodeIds(entry, rootNodeId, (candidate) =>
    isStateCollapsedPromptGroupMember(ctx, entry, candidate)
  );
}

function resolveCollapsedPromptRootNodeId(
  rootNodeId: string,
  nodeIds: string[]
): string | undefined {
  return nodeIds.includes(rootNodeId) ? rootNodeId : undefined;
}

function buildPolicyCollapsedSubtreePrompt(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  rootNodeId: string,
  nodeIds?: string[]
): string {
  const collapsedNodeIds = nodeIds ?? collectPolicyCollapsedPromptNodeIds(ctx, entry, rootNodeId);
  const segmentEntry = buildPromptSegmentEntry(entry, rootNodeId, collapsedNodeIds);
  if (!segmentEntry) {
    return buildPolicyNodeOnlyPrompt(ctx, entry, rootNodeId);
  }
  const effectiveRootNodeId = resolveCollapsedPromptRootNodeId(
    rootNodeId,
    collapsedNodeIds
  );

  const segmentDoc: CanvasDoc = {
    ...ctx.doc,
    activeId: entry.id,
    canvases: [segmentEntry],
  };
  return buildCanvasSubtreeText(segmentDoc, entry.id, effectiveRootNodeId, ctx.doc);
}

function buildStateCollapsedSubtreePrompt(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  rootNodeId: string,
  nodeIds?: string[]
): string {
  const collapsedNodeIds = nodeIds ?? collectStateCollapsedPromptNodeIds(ctx, entry, rootNodeId);
  const segmentEntry = buildPromptSegmentEntry(entry, rootNodeId, collapsedNodeIds);
  if (!segmentEntry) {
    return buildStateNodeOnlyPrompt(ctx, entry, rootNodeId);
  }
  const effectiveRootNodeId = resolveCollapsedPromptRootNodeId(
    rootNodeId,
    collapsedNodeIds
  );

  const segmentDoc: CanvasDoc = {
    ...ctx.doc,
    activeId: entry.id,
    canvases: [segmentEntry],
  };
  return compileStateExtractionSubtreePrompt(
    segmentDoc,
    mapStatePromptFields(ctx.stateSchema),
    entry.id,
    effectiveRootNodeId,
    ctx.doc
  );
}

function canAbsorbContinuationIntoCanvasSubtree(
  entry: CanvasEntry,
  nodeId: string,
  continuation: LoweringContinuation
): boolean {
  if (continuation.coveredNodeKeys.size === 0) {
    return true;
  }

  const reachable = collectReachableNodeKeys(entry, nodeId);
  for (const key of continuation.coveredNodeKeys) {
    if (key.startsWith(`${entry.id}:`) && !reachable.has(key)) {
      return false;
    }
  }
  return true;
}

function uniqueTargetIds(values: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
  }
  return Array.from(seen);
}

function isNodeReachableFrom(
  entry: CanvasEntry,
  sourceId: string,
  targetId: string,
  visited: Set<string> = new Set()
): boolean {
  if (sourceId === targetId) {
    return true;
  }
  if (visited.has(sourceId)) {
    return false;
  }
  visited.add(sourceId);

  const { outgoing } = buildGraphMaps(entry);
  for (const edge of outgoing.get(sourceId) ?? []) {
    if (edge.target === targetId) {
      return true;
    }
    if (isNodeReachableFrom(entry, edge.target, targetId, visited)) {
      return true;
    }
  }
  return false;
}

function pruneBoundaryTargetIds(
  entry: CanvasEntry,
  values: Iterable<string | null | undefined>
): string[] {
  const targets = uniqueTargetIds(values);
  return targets.filter(
    (targetId) =>
      !targets.some(
        (candidateId) =>
          candidateId !== targetId &&
          isNodeReachableFrom(entry, candidateId, targetId)
      )
  );
}

function buildSegmentPath(
  path: Set<string>,
  entry: CanvasEntry,
  nodeIds: string[]
): Set<string> {
  const nextPath = new Set(path);
  for (const nodeId of nodeIds) {
    nextPath.add(buildCanvasNodeKey(entry.id, nodeId));
  }
  return nextPath;
}

function buildPromptSegmentEntry(
  entry: CanvasEntry,
  rootNodeId: string,
  nodeIds: string[]
): CanvasEntry | null {
  const start = getStartNode(entry);
  if (!start || nodeIds.length === 0) {
    return null;
  }

  const nodeIdSet = new Set(nodeIds);
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
          (rootNodeId === start.id
            ? nodeIdSet.has(edge.target)
            : edge.target === rootNodeId))
    )
    .map((edge) => ({ ...edge }));

  if (
    rootNodeId !== start.id &&
    !edges.some((edge) => edge.source === start.id && edge.target === rootNodeId)
  ) {
    edges.unshift({
      id: `segment-start-${entry.id}-${rootNodeId}`,
      source: start.id,
      target: rootNodeId,
    });
  }

  return {
    ...entry,
    graph: {
      nodes,
      edges,
    },
  };
}

function getIncomingEdges(entry: CanvasEntry, nodeId: string): CanvasEdgeRecord[] {
  return buildGraphMaps(entry).incoming.get(nodeId) ?? [];
}

function isJoinNode(entry: CanvasEntry, nodeId: string): boolean {
  return getIncomingEdges(entry, nodeId).length > 1;
}

function getDirectSequencedSourceNodes(
  entry: CanvasEntry,
  nodeId: string
): CanvasNodeRecord[] {
  const maps = buildGraphMaps(entry);
  return (maps.incoming.get(nodeId) ?? [])
    .map((edge) => maps.byId.get(edge.source))
    .filter((node): node is CanvasNodeRecord => Boolean(node));
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
    return Object.keys(parsed as Record<string, unknown>).filter((key) => key.trim().length > 0);
  } catch {
    return [];
  }
}

function buildToolParentContributionVariableName(
  parentNode: CanvasNodeRecord,
  toolNode: CanvasNodeRecord
): string {
  if (isToolCallNode(parentNode)) {
    const resultName =
      readToolResultVariableName(parentNode) ?? inferToolFunctionName(parentNode).trim();
    return resultName || sanitizePromptValueName(parentNode.id);
  }

  return sanitizePromptValueName(`tool_inputs_${toolNode.id}_${parentNode.id}`);
}

function buildToolContributionInstruction(
  toolNode: CanvasNodeRecord,
  parentNode: CanvasNodeRecord
): string {
  const toolName = inferToolFunctionName(toolNode).trim() || String(toolNode.data?.label ?? "tool");
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

function collectAvailablePromptValueNames(
  entry: CanvasEntry,
  nodeId: string
): string[] {
  return collectAvailableLocalValueNames(entry, nodeId);
}

function getToolJoinInputVariables(
  entry: CanvasEntry,
  toolNode: CanvasNodeRecord
): string[] {
  return getDirectSequencedSourceNodes(entry, toolNode.id)
    .map((parentNode) => buildToolParentContributionVariableName(parentNode, toolNode));
}

function getDirectToolTarget(
  entry: CanvasEntry,
  node: CanvasNodeRecord
): CanvasNodeRecord | null {
  const maps = buildGraphMaps(entry);
  const candidates = (maps.outgoing.get(node.id) ?? [])
    .map((edge) => maps.byId.get(edge.target))
    .filter((candidate): candidate is CanvasNodeRecord => {
      if (!candidate) {
        return false;
      }
      return isToolCallNode(candidate);
    });

  if (candidates.length !== 1) {
    return null;
  }

  return candidates[0] ?? null;
}

function getToolInputObjectVariables(
  entry: CanvasEntry,
  node: CanvasNodeRecord
): string[] | undefined {
  const variables = getToolJoinInputVariables(entry, node);
  return variables.length > 0 ? variables : undefined;
}

function getToolJoinOutputFieldNames(
  toolNode: CanvasNodeRecord
): string[] | undefined {
  const names = parseToolParameterNames(toolNode);
  return names.length > 0 ? names : undefined;
}

function getToolInputPromptValueNames(
  entry: CanvasEntry,
  toolNode: CanvasNodeRecord
): string[] | undefined {
  const allowedNames = new Set(parseToolParameterNames(toolNode));
  if (allowedNames.size === 0) {
    return undefined;
  }

  const names = new Set<string>();
  for (const field of collectAvailableLocalFields(entry, toolNode.id)) {
    const fieldName = field.name.trim();
    if (fieldName && allowedNames.has(fieldName)) {
      names.add(fieldName);
    }
  }

  return names.size > 0 ? Array.from(names) : undefined;
}

function inferAsyncJobSourceVariableFromDirectInputs(
  entry: CanvasEntry,
  node: CanvasNodeRecord
): string | undefined {
  const candidates = new Set<string>();

  const fieldNames = new Set(
    collectAvailableLocalFields(entry, node.id)
      .map((field) => field.name.trim())
      .filter((name) => name.length > 0)
  );

  for (const fieldName of fieldNames) {
    if (fieldName.endsWith("_job_id")) {
      const baseName = fieldName.slice(0, -"_job_id".length).trim();
      if (baseName) {
        candidates.add(baseName);
      }
      continue;
    }

    if (fieldNames.has(`${fieldName}_job_id`)) {
      candidates.add(fieldName);
    }
  }

  return candidates.size === 1 ? Array.from(candidates)[0] : undefined;
}

function isToolCallNode(node: CanvasNodeRecord): boolean {
  return readNodeActionType(node) === "tool_call";
}

function isCallAgentNode(node: CanvasNodeRecord): boolean {
  return node.type === "call_agent";
}

function isRunnableCallNode(node: CanvasNodeRecord): boolean {
  return isToolCallNode(node) || isCallAgentNode(node);
}

function readCallAgentTargetAgentId(node: CanvasNodeRecord): string {
  return typeof node.data?.targetAgentId === "string"
    ? node.data.targetAgentId.trim()
    : "";
}

function readCallAgentType(node: CanvasNodeRecord): string {
  const raw =
    typeof node.data?.callAgentType === "string"
      ? node.data.callAgentType.trim()
      : "";
  return raw || "default";
}

function nodeHasRunnableAgentCall(node: CanvasNodeRecord): boolean {
  return isCallAgentNode(node) && readCallAgentTargetAgentId(node).length > 0;
}

function inferCallAgentToolName(node: CanvasNodeRecord): string {
  const targetAgentId = readCallAgentTargetAgentId(node);
  const normalizedTarget =
    targetAgentId.replace(/[^\w.:-]+/g, "_").replace(/^_+|_+$/g, "") ||
    "unknown";
  const callAgentType = readCallAgentType(node);
  if (callAgentType === "external_agent") {
    return `airie.external_agent.${normalizedTarget}`;
  }
  if (callAgentType === "openclaw") {
    return "airie.openclaw.run";
  }
  if (callAgentType === "hermes") {
    return "airie.hermes.run";
  }
  return `airie.external_connection.${normalizedTarget}`;
}

function readCallAgentResultVariableName(node: CanvasNodeRecord): string {
  return readToolResultVariableName(node) ?? "base_agent_result";
}

function readTerminateExternalConnectionId(node: CanvasNodeRecord): string | null {
  const value =
    typeof node.data?.externalConnectionId === "string"
      ? node.data.externalConnectionId.trim()
      : "";
  return value || null;
}

function isStageTerminalNode(node: CanvasNodeRecord): boolean {
  return (
    node.type === "terminate_stage" ||
    node.type === "terminate_stage_immediate"
  );
}

function isStageContinueNode(node: CanvasNodeRecord): boolean {
  return node.type === "continue";
}

function readStageHandoffString(
  node: CanvasNodeRecord,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = node.data?.[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function buildPolicyStageHandoff(
  node: CanvasNodeRecord,
  mode: PolicyStageHandoff["mode"]
): PolicyStageHandoff {
  return {
    mode,
    next_stage_id: readStageHandoffString(node, [
      "nextStageId",
      "next_stage_id",
      "stageId",
      "stage_id",
    ]),
    next_stage_name: readStageHandoffString(node, [
      "nextStageName",
      "next_stage_name",
      "stageName",
      "stage_name",
    ]),
  };
}

const INTERNAL_RUNTIME_TOOL_NAMES = new Set([
  "run_target_simulation",
  "airie_assistant_status",
  "airie_capability_catalog",
  "openclaw_email_connect",
  "airie_email_connect",
  "openclaw_email_draft",
  "airie_email_draft",
  "openclaw_email_send",
  "airie_email_send_approved",
  "inbox_zero_agent",
  "airie_inbox_zero_delegate",
  "airie_external_connection_inbox_zero",
  "airie_external_agent_inbox_zero",
  "airie_connected_agent_inbox_zero",
  "openclaw_gateway",
  "airie_openclaw_run",
  "hermes_workflow_agent",
  "airie_hermes_run",
  "recipes_provider",
  "airie_recipes_missing",
]);

function isInternalRuntimeToolName(toolName: string): boolean {
  return INTERNAL_RUNTIME_TOOL_NAMES.has(toolName.trim());
}

function nodeHasRunnableTool(node: CanvasNodeRecord): boolean {
  if (!isToolCallNode(node)) {
    return false;
  }

  const toolName = inferToolFunctionName(node);
  if (!toolName) {
    return false;
  }
  if (isInternalRuntimeToolName(toolName)) {
    return true;
  }

  const sourceType = typeof node.data?.sourceType === "string" ? node.data.sourceType.trim() : "http";
  const url = typeof node.data?.url === "string" ? node.data.url.trim() : "";
  if (sourceType === "knowledge_save") {
    const saveTarget = node.data?.saveTarget === "dataset" ? "dataset" : "knowledge";
    const datasetName =
      typeof node.data?.datasetName === "string" ? node.data.datasetName.trim() : "";
    return saveTarget === "dataset" ? datasetName.length > 0 : true;
  }
  if (sourceType === "dataset_read") {
    const datasetName =
      typeof node.data?.datasetName === "string" ? node.data.datasetName.trim() : "";
    return datasetName.length > 0;
  }
  if (sourceType === "web_search") {
    return true;
  }
  return url.length > 0;
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

function parseLiteralValue(rawValue: string): string | number | boolean {
  const trimmed = rawValue.trim();
  if (/^(true|yes)$/i.test(trimmed)) {
    return true;
  }
  if (/^(false|no)$/i.test(trimmed)) {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : trimmed;
  }
  return trimmed.replace(/^["'`]+|["'`]+$/g, "");
}

function parsePromptValueCondition(
  name: string,
  rest: string
): ConditionPlan | null {
  if (/^is\s+true$/i.test(rest) || /^equals\s+true$/i.test(rest)) {
    return { kind: "prompt_value_equals", name, value: true };
  }
  if (/^is\s+false$/i.test(rest) || /^equals\s+false$/i.test(rest)) {
    return { kind: "prompt_value_equals", name, value: false };
  }
  if (/^is\s+empty$/i.test(rest)) {
    return { kind: "prompt_value_empty", name };
  }
  if (/^is\s+not\s+empty$/i.test(rest) || /^not\s+empty$/i.test(rest)) {
    return { kind: "prompt_value_not_empty", name };
  }

  const containsMatch = rest.match(/^(?:contains|includes)\s+(.+)$/i);
  if (containsMatch) {
    return {
      kind: "prompt_value_includes",
      name,
      value: containsMatch[1].trim().replace(/^["'`]+|["'`]+$/g, ""),
    };
  }

  const equalsMatch = rest.match(/^(?:is|equals)\s+(.+)$/i);
  if (equalsMatch) {
    const rawValue = equalsMatch[1].trim().replace(/^["'`]+|["'`]+$/g, "");
    return {
      kind: "prompt_value_equals",
      name,
      value:
        /^true$/i.test(rawValue) ? true : /^false$/i.test(rawValue) ? false : rawValue,
    };
  }

  return null;
}

function parseStateFieldCondition(
  fieldName: string,
  rest: string
): ConditionPlan | null {
  if (/^is\s+true$/i.test(rest) || /^equals\s+true$/i.test(rest)) {
    return { kind: "field_equals", field: fieldName, value: true };
  }
  if (/^is\s+false$/i.test(rest) || /^equals\s+false$/i.test(rest)) {
    return { kind: "field_equals", field: fieldName, value: false };
  }
  if (/^is\s+empty$/i.test(rest)) {
    return { kind: "field_empty", field: fieldName };
  }
  if (/^is\s+not\s+empty$/i.test(rest) || /^not\s+empty$/i.test(rest)) {
    return { kind: "field_not_empty", field: fieldName };
  }

  const containsMatch = rest.match(/^(?:contains|includes)\s+(.+)$/i);
  if (containsMatch) {
    return {
      kind: "field_includes",
      field: fieldName,
      value: containsMatch[1].trim().replace(/^["'`]+|["'`]+$/g, ""),
    };
  }

  const equalsMatch = rest.match(/^(?:is|equals)\s+(.+)$/i);
  if (equalsMatch) {
    return {
      kind: "field_equals",
      field: fieldName,
      value: parseLiteralValue(equalsMatch[1]),
    };
  }

  return null;
}

function findMatchingNamePrefix(
  label: string,
  names: string[]
): { name: string; prefix: string } | null {
  let best: { name: string; prefix: string } | null = null;

  for (const name of names) {
    const prefix = matchFieldPrefix(label, name);
    if (!prefix) {
      continue;
    }
    if (!best || prefix.length > best.prefix.length) {
      best = { name, prefix };
    }
  }

  return best;
}

interface ConditionLabelAnalysis {
  condition: ConditionPlan | null;
  ambiguousPromptName?: string;
  ambiguousStateField?: string;
}

function analyzeConditionLabel(
  label: string,
  stateSchema: RuntimeStateField[],
  availablePromptValueNames: string[] = []
): ConditionLabelAnalysis {
  const trimmed = label.trim();
  if (!trimmed) {
    return { condition: null };
  }

  const explicitLocalValueCondition =
    parseExplicitLocalValueConditionLabel(trimmed);
  if (explicitLocalValueCondition) {
    return {
      condition: parsePromptValueCondition(
        explicitLocalValueCondition.name,
        explicitLocalValueCondition.rest
      ),
    };
  }

  const messageContains = trimmed.match(/^message\s+contains\s+(.+)$/i);
  if (messageContains) {
    return {
      condition: {
        kind: "message_contains",
        value: messageContains[1].trim().replace(/^["'`]+|["'`]+$/g, ""),
      },
    };
  }

  const promptMatch = findMatchingNamePrefix(trimmed, availablePromptValueNames);
  const stateMatch = (() => {
    let best: { fieldName: string; prefix: string } | null = null;
    for (const field of stateSchema) {
      const prefix = matchFieldPrefix(trimmed, field.fieldName);
      if (!prefix) {
        continue;
      }
      if (!best || prefix.length > best.prefix.length) {
        best = { fieldName: field.fieldName, prefix };
      }
    }
    return best;
  })();

  if (promptMatch && stateMatch) {
    return {
      condition: null,
      ambiguousPromptName: promptMatch.name,
      ambiguousStateField: stateMatch.fieldName,
    };
  }

  if (promptMatch) {
    return {
      condition: parsePromptValueCondition(
        promptMatch.name,
        trimmed.slice(promptMatch.prefix.length).trim()
      ),
    };
  }

  if (stateMatch) {
    return {
      condition: parseStateFieldCondition(
        stateMatch.fieldName,
        trimmed.slice(stateMatch.prefix.length).trim()
      ),
    };
  }

  return { condition: null };
}

export function parseConditionLabel(
  label: string,
  stateSchema: RuntimeStateField[],
  availablePromptValueNames: string[] = []
): ConditionPlan | null {
  return analyzeConditionLabel(label, stateSchema, availablePromptValueNames).condition;
}

export function getConditionLabelIssue(
  label: string,
  stateSchema: RuntimeStateField[],
  availablePromptValueNames: string[] = []
): string | null {
  const analysis = analyzeConditionLabel(
    label,
    stateSchema,
    availablePromptValueNames
  );
  if (!analysis.ambiguousPromptName || !analysis.ambiguousStateField) {
    return null;
  }

  return `Condition is ambiguous: "${analysis.ambiguousPromptName}" matches both the local/runtime output "${analysis.ambiguousPromptName}" and the state field "${analysis.ambiguousStateField}". Rename one of them or write "prompt ${analysis.ambiguousPromptName} …" explicitly.`;
}

export function parseStateActionLabel(
  label: string,
  stateSchema: RuntimeStateField[]
): StateCodeOperation[] | null {
  const trimmed = label.trim();
  if (!trimmed) {
    return null;
  }

  const setLocalMatch = trimmed.match(
    /^set\s+local(?:\s+variable)?\s+([A-Za-z_][A-Za-z0-9_]*)\s+to\s+(.+)$/i
  );
  if (setLocalMatch) {
    return [
      {
        kind: "set_local",
        name: setLocalMatch[1],
        source: {
          kind: "constant",
          value: parseLiteralValue(setLocalMatch[2]),
        },
      },
    ];
  }

  for (const field of stateSchema) {
    const fieldPrefix = matchFieldPrefix(trimmed.replace(/^set\s+/i, ""), field.fieldName);
    const fieldName = field.fieldName;

    if (/^clear\s+/i.test(trimmed)) {
      const rest = trimmed.replace(/^clear\s+/i, "");
      if (matchFieldPrefix(rest, fieldName)) {
        return [{ kind: "clear_field", field: fieldName }];
      }
    }

    if (/^set\s+/i.test(trimmed) && fieldPrefix) {
      const remainder = trimmed.replace(/^set\s+/i, "").slice(fieldPrefix.length).trim();
      const valueMatch = remainder.match(/^to\s+(.+)$/i);
      if (valueMatch) {
        if (
          normalizeKey(fieldName) === "new events" &&
          normalizeKey(valueMatch[1].trim().replace(/[.!?]+$/g, "")) === "empty list"
        ) {
          return [
            {
              kind: "set_field",
              field: fieldName,
              source: { kind: "constant", value: [] },
            },
          ];
        }

        const normalizedTarget = normalizeKey(fieldName);
        const normalizedValue = normalizeKey(
          valueMatch[1].trim().replace(/[.!?]+$/g, "")
        );
        if (
          normalizedTarget === "current build" &&
          (normalizedValue === "current build" ||
            normalizedValue === "canonical current build" ||
            normalizedValue === "canonical current_build" ||
            normalizedValue === "server current build" ||
            normalizedValue === "server generated current build")
        ) {
          return [
            {
              kind: "set_field",
              field: fieldName,
              source: { kind: "current_build_snapshot" },
            },
          ];
        }

        return [
          {
            kind: "set_field",
            field: fieldName,
            source: { kind: "constant", value: parseLiteralValue(valueMatch[1]) },
          },
        ];
      }
    }

    const addMatch = trimmed.match(/^add\s+(.+)\s+to\s+(.+)$/i);
    if (addMatch) {
      const targetField = addMatch[2].trim();
      if (normalizeKey(targetField) !== normalizeKey(fieldName)) {
        continue;
      }

      const rawValue = addMatch[1].trim();
      const normalizedRawValue = normalizeKey(rawValue.replace(/[.!?]+$/g, ""));

      if (
        normalizedRawValue === "latest user turn" ||
        normalizedRawValue === "agent latest observation and agent latest reward" ||
        normalizedRawValue === "agent latest observation + agent latest reward" ||
        normalizedRawValue === "agent latest observation reward" ||
        normalizedRawValue === "latest observation event" ||
        normalizedRawValue === "latest observation and reward turn" ||
        normalizedRawValue === "latest observation + reward turn" ||
        normalizedRawValue === "latest observation reward turn" ||
        normalizedRawValue === "latest observation and reward event" ||
        normalizedRawValue === "latest observation + reward event" ||
        normalizedRawValue === "latest observation reward event" ||
        normalizedRawValue === "latest primary agent action turn" ||
        normalizedRawValue === "latest primary-agent action turn" ||
        normalizedRawValue === "latest primary action turn" ||
        normalizedRawValue === "latest primary agent action event" ||
        normalizedRawValue === "latest primary-agent action event" ||
        normalizedRawValue === "latest primary action event"
      ) {
        return [
          {
            kind: "append_list_item",
            field: fieldName,
            source:
              normalizedRawValue === "latest user turn"
                ? { kind: "latest_user_turn" }
                : normalizedRawValue.includes("primary")
                  ? { kind: "latest_primary_action_event" }
                  : normalizedRawValue.includes("agent latest observation")
                    ? { kind: "latest_observation_and_reward_event" }
                  : normalizedRawValue === "latest observation event"
                    ? { kind: "latest_observation_event" }
                    : { kind: "latest_observation_and_reward_event" },
          },
        ];
      }

      if (normalizedRawValue === "latest assistant turn") {
        return [
          {
            kind: "append_list_item",
            field: fieldName,
            source: { kind: "latest_assistant_turn" },
          },
        ];
      }

      if (
        normalizedRawValue === "conversation transcript turns" ||
        normalizedRawValue === "conversation turns" ||
        normalizedRawValue === "transcript turns"
      ) {
        return [
          {
            kind: "append_list_item",
            field: fieldName,
            source: { kind: "conversation_turns" },
          },
        ];
      }

      const isQuoted = /^["'`].*["'`]$/.test(rawValue);
      if (!isQuoted) {
        continue;
      }

      return [
        {
          kind: "append_list_item",
          field: fieldName,
          value: rawValue.replace(/^["'`]+|["'`]+$/g, ""),
          unique: true,
        },
      ];
    }
  }

  return null;
}

function resolveNodeExecutableStateCodeOps(
  node: Pick<CanvasNodeRecord, "data">,
  stateSchema: RuntimeStateField[]
): StateCodeOperation[] | null {
  return (
    readExplicitNodeExecutableStateCodeOps(node, stateSchema) ??
    parseStateActionLabel(String(node.data?.label ?? ""), stateSchema)
  );
}

function readNodeExecutableTypeScriptSource(
  node: Pick<CanvasNodeRecord, "data">
): string {
  return readNodeExecutableCodeSource(node);
}

function readNodePromptOutputFields(
  node: Pick<CanvasNodeRecord, "data">
): StatePromptExtractionField[] {
  return normalizePromptOutputFields(node.data?.promptOutputFields).map((field) => ({
    name: field.name,
    type: field.type,
    instruction: field.instruction,
  }));
}

function nodeHasPromptOutputFields(node: Pick<CanvasNodeRecord, "data">): boolean {
  return readNodePromptOutputFields(node).length > 0;
}

function readToolResultVariableName(
  node: Pick<CanvasNodeRecord, "data">
): string | undefined {
  const resultVariable =
    typeof node.data?.resultVariable === "string"
      ? node.data.resultVariable.trim()
      : "";
  return resultVariable.length > 0 ? resultVariable : undefined;
}

function readPromptTransformInputVariableName(
  node: Pick<CanvasNodeRecord, "data">
): string {
  const inputVariable =
    typeof node.data?.inputVariable === "string"
      ? node.data.inputVariable.trim()
      : "";
  return inputVariable.length > 0
    ? inputVariable
    : CARRIED_OUTPUT_PROMPT_VALUE_NAME;
}

function readPromptTransformOutputVariableName(
  node: Pick<CanvasNodeRecord, "data">
): string | undefined {
  const outputVariable =
    typeof node.data?.outputVariable === "string"
      ? node.data.outputVariable.trim()
      : "";
  return outputVariable.length > 0 ? outputVariable : undefined;
}

function readNodeActionType(node: Pick<CanvasNodeRecord, "type" | "data">): string {
  return getNodeActionSubtype(node);
}

function isPromptOrCodeNode(node: Pick<CanvasNodeRecord, "type" | "data">): boolean {
  return node.type === "action" || node.type === "prompt" || node.type === "code";
}

function isDisplayNode(node: Pick<CanvasNodeRecord, "type" | "data">): boolean {
  return node.type === "display" || readNodeActionType(node) === "display";
}

function isPolicyPromptSegmentEligibleNode(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord
): boolean {
  if (!isPromptLikeNode(node)) {
    return false;
  }

  const actionType = readNodeActionType(node);
  if (
    actionType === "code" ||
    actionType === "display" ||
    actionType === "prompt_transform" ||
    actionType === "tool_call"
  ) {
    return false;
  }
  if (getPolicyRuntimeOperation(node)) {
    return false;
  }
  if (getDirectToolTarget(entry, node)) {
    return false;
  }
  if (actionType === "prompt") {
    return true;
  }
  return !resolveNodeExecutableStateCodeOps(node, ctx.stateSchema);
}

function isStatePromptSegmentEligibleNode(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord
): boolean {
  if (!isPromptLikeNode(node)) {
    return false;
  }

  const actionType = readNodeActionType(node);
  if (
    actionType === "code" ||
    actionType === "display" ||
    actionType === "prompt_transform" ||
    actionType === "tool_call"
  ) {
    return false;
  }
  if (getStateRuntimeOperation(node)) {
    return false;
  }
  if (getDirectToolTarget(entry, node)) {
    return false;
  }
  if (actionType === "prompt") {
    return true;
  }
  return !resolveNodeExecutableStateCodeOps(node, ctx.stateSchema);
}

function collectPromptSegmentOutputFields(
  entry: CanvasEntry,
  nodeIds: string[]
): StatePromptExtractionField[] {
  const maps = buildGraphMaps(entry);
  const byName = new Map<string, StatePromptExtractionField>();

  for (const nodeId of nodeIds) {
    const node = maps.byId.get(nodeId);
    if (!node) {
      continue;
    }
    for (const field of readNodePromptOutputFields(node)) {
      if (!field.name.trim()) {
        continue;
      }
      byName.set(field.name, field);
    }
  }

  return Array.from(byName.values());
}

// A prompt flow is rooted either at a real eligible node or at a virtual
// Start root whose direct eligible children become the sibling roots.
function collectPromptFlowSegment(
  entry: CanvasEntry,
  rootNodeId: string,
  isEligible: (node: CanvasNodeRecord) => boolean
): PromptSegment | null {
  const start = getStartNode(entry);
  const maps = buildGraphMaps(entry);
  const isVirtualStartRoot = Boolean(start && rootNodeId === start.id);
  const rootIds = isVirtualStartRoot ? getStartTargets(entry) : [rootNodeId];
  const virtualStart = isVirtualStartRoot ? start : null;

  if (rootIds.length === 0) {
    return null;
  }

  if (isVirtualStartRoot) {
    if (rootIds.length <= 1) {
      return null;
    }

    for (const rootId of rootIds) {
      const root = maps.byId.get(rootId);
      if (!root || !isEligible(root)) {
        return null;
      }
      const incoming = maps.incoming.get(rootId) ?? [];
      if (
        !virtualStart ||
        incoming.length !== 1 ||
        incoming[0]?.source !== virtualStart.id
      ) {
        return null;
      }
    }
  } else {
    const root = maps.byId.get(rootNodeId);
    if (!root || !isEligible(root)) {
      return null;
    }
  }

  const included = new Set<string>();
  const boundaryTargetIds = new Set<string>();

  const visit = (nodeId: string) => {
    if (included.has(nodeId)) {
      return;
    }
    included.add(nodeId);

    for (const edge of maps.outgoing.get(nodeId) ?? []) {
      const target = maps.byId.get(edge.target);
      if (!target) {
        continue;
      }
      if (edge.sourceHandle) {
        boundaryTargetIds.add(target.id);
        continue;
      }
      if (isJoinNode(entry, target.id)) {
        boundaryTargetIds.add(target.id);
        continue;
      }
      if (!isEligible(target)) {
        boundaryTargetIds.add(target.id);
        continue;
      }
      visit(target.id);
    }
  };

  for (const rootId of rootIds) {
    visit(rootId);
  }

  const nodeIds = Array.from(included);
  if (nodeIds.length <= 1) {
    return null;
  }

  return {
    rootNodeId: isVirtualStartRoot && virtualStart ? virtualStart.id : rootNodeId,
    nodeIds,
    boundaryTargetIds: pruneBoundaryTargetIds(entry, boundaryTargetIds),
  };
}

function buildPolicyPromptSegmentPrompt(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  segment: PromptSegment
): string {
  const segmentEntry = buildPromptSegmentEntry(
    entry,
    segment.rootNodeId,
    segment.nodeIds
  );
  if (!segmentEntry) {
    return buildPolicyNodeOnlyPrompt(ctx, entry, segment.rootNodeId);
  }

  const segmentDoc: CanvasDoc = {
    ...ctx.doc,
    activeId: entry.id,
    canvases: [segmentEntry],
  };
  return buildCanvasSubtreeText(
    segmentDoc,
    entry.id,
    segment.rootNodeId,
    ctx.doc
  );
}

function buildStatePromptSegmentPrompt(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  segment: PromptSegment
): string {
  const segmentEntry = buildPromptSegmentEntry(
    entry,
    segment.rootNodeId,
    segment.nodeIds
  );
  if (!segmentEntry) {
    return buildStateNodeOnlyPrompt(ctx, entry, segment.rootNodeId);
  }

  const segmentDoc: CanvasDoc = {
    ...ctx.doc,
    activeId: entry.id,
    canvases: [segmentEntry],
  };
  return compileStateExtractionSubtreePrompt(
    segmentDoc,
    mapStatePromptFields(ctx.stateSchema),
    entry.id,
    segment.rootNodeId,
    ctx.doc
  );
}

function selectPolicyPromptSegment(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  rootNodeId: string
): SelectedPromptSegment | null {
  const segment = collectPromptFlowSegment(entry, rootNodeId, (node) =>
    isPolicyPromptSegmentEligibleNode(ctx, entry, node)
  );
  if (!segment) {
    return null;
  }

  const prompt = buildPolicyPromptSegmentPrompt(ctx, entry, segment);
  if (prompt.length >= POLICY_PROMPT_COLLAPSE_HARD_MAX_CHARS) {
    return null;
  }

  return {
    ...segment,
    prompt,
    outputFields: collectPromptSegmentOutputFields(entry, segment.nodeIds),
  };
}

function selectPolicyStartPromptSegment(
  ctx: PolicyLowerContext,
  entry: CanvasEntry
): SelectedPromptSegment | null {
  const start = getStartNode(entry);
  if (!start) {
    return null;
  }

  const segment = collectPromptFlowSegment(entry, start.id, (node) =>
    isPolicyPromptSegmentEligibleNode(ctx, entry, node)
  );
  if (!segment) {
    return null;
  }

  const prompt = buildPolicyPromptSegmentPrompt(ctx, entry, segment);
  if (prompt.length >= POLICY_PROMPT_COLLAPSE_HARD_MAX_CHARS) {
    return null;
  }

  return {
    ...segment,
    prompt,
    outputFields: collectPromptSegmentOutputFields(entry, segment.nodeIds),
  };
}

function selectStatePromptSegment(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  rootNodeId: string
): SelectedPromptSegment | null {
  const segment = collectPromptFlowSegment(entry, rootNodeId, (node) =>
    isStatePromptSegmentEligibleNode(ctx, entry, node)
  );
  if (!segment) {
    return null;
  }

  const prompt = buildStatePromptSegmentPrompt(ctx, entry, segment);
  if (prompt.length >= STATE_PROMPT_COLLAPSE_HARD_MAX_CHARS) {
    return null;
  }

  return {
    ...segment,
    prompt,
    outputFields: collectPromptSegmentOutputFields(entry, segment.nodeIds),
  };
}

function selectStateStartPromptSegment(
  ctx: StateLowerContext,
  entry: CanvasEntry
): SelectedPromptSegment | null {
  const start = getStartNode(entry);
  if (!start) {
    return null;
  }

  const segment = collectPromptFlowSegment(entry, start.id, (node) =>
    isStatePromptSegmentEligibleNode(ctx, entry, node)
  );
  if (!segment) {
    return null;
  }

  const prompt = buildStatePromptSegmentPrompt(ctx, entry, segment);
  if (prompt.length >= STATE_PROMPT_COLLAPSE_HARD_MAX_CHARS) {
    return null;
  }

  return {
    ...segment,
    prompt,
    outputFields: collectPromptSegmentOutputFields(entry, segment.nodeIds),
  };
}

function pushPolicyStep(
  ctx: PolicyLowerContext,
  prefix: string,
  step: { type: PolicyExecutionGraphStep["type"] } & Record<string, unknown>,
  sourceNodeKeys?: Iterable<string>
): string {
  const id = `${prefix}-${ctx.nextId++}`;
  ctx.steps.push({
    id,
    ...step,
    sourceNodeRefs: sourceNodeRefsFromKeys(sourceNodeKeys),
  } as PolicyExecutionGraphStep);
  return id;
}

function pushStateStep(
  ctx: StateLowerContext,
  prefix: string,
  step: { type: StateExecutionGraphStep["type"] } & Record<string, unknown>,
  sourceNodeKeys?: Iterable<string>
): string {
  const id = `${prefix}-${ctx.nextId++}`;
  ctx.steps.push({
    id,
    ...step,
    sourceNodeRefs: sourceNodeRefsFromKeys(sourceNodeKeys),
  } as StateExecutionGraphStep);
  return id;
}

function appendPolicyStepSourceNodeKeys(
  ctx: PolicyLowerContext,
  stepId: string | null,
  sourceNodeKeys: Iterable<string>
): void {
  if (!stepId) {
    return;
  }
  const refs = sourceNodeRefsFromKeys(sourceNodeKeys);
  if (!refs) {
    return;
  }
  const step = ctx.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    return;
  }
  const seen = new Set(
    (step.sourceNodeRefs ?? []).map((ref) => `${ref.canvasId}:${ref.nodeId}`)
  );
  const additions = refs.filter((ref) => {
    const key = `${ref.canvasId}:${ref.nodeId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  if (additions.length > 0) {
    step.sourceNodeRefs = [...(step.sourceNodeRefs ?? []), ...additions];
  }
}

function appendStateStepSourceNodeKeys(
  ctx: StateLowerContext,
  stepId: string | null,
  sourceNodeKeys: Iterable<string>
): void {
  if (!stepId) {
    return;
  }
  const refs = sourceNodeRefsFromKeys(sourceNodeKeys);
  if (!refs) {
    return;
  }
  const step = ctx.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    return;
  }
  const seen = new Set(
    (step.sourceNodeRefs ?? []).map((ref) => `${ref.canvasId}:${ref.nodeId}`)
  );
  const additions = refs.filter((ref) => {
    const key = `${ref.canvasId}:${ref.nodeId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  if (additions.length > 0) {
    step.sourceNodeRefs = [...(step.sourceNodeRefs ?? []), ...additions];
  }
}

function mapStatePromptFields(stateSchema: RuntimeStateField[]) {
  return stateSchema.map((field) => ({
    name: field.fieldName,
    type: field.type,
    initialValue: field.initialValue,
  }));
}

function buildStateSubtreePrompt(
  ctx: StateLowerContext,
  entryId: string,
  nodeId?: string
): string {
  return compileStateExtractionSubtreePrompt(
    ctx.doc,
    mapStatePromptFields(ctx.stateSchema),
    entryId,
    nodeId
  );
}

function buildIsolatedEntryForNode(
  entry: CanvasEntry,
  nodeId: string
): CanvasEntry | null {
  const start = getStartNode(entry);
  const node = entry.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!start || !node || node.type === "start") {
    return null;
  }

  const isolatedStart: CanvasNodeRecord = {
    ...start,
    data: { ...start.data },
  };
  const isolatedNode: CanvasNodeRecord = {
    ...node,
    data: { ...node.data },
  };
  const isolatedEdge: CanvasEdgeRecord = {
    id: `isolated-${entry.id}-${node.id}`,
    source: isolatedStart.id,
    target: isolatedNode.id,
  };

  return {
    ...entry,
    graph: {
      nodes: [isolatedStart, isolatedNode],
      edges: [isolatedEdge],
    },
  };
}

function buildPolicyNodeOnlyPrompt(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  nodeId: string
): string {
  const isolatedEntry = buildIsolatedEntryForNode(entry, nodeId);
  if (!isolatedEntry) {
    return buildCanvasSubtreeText(ctx.doc, entry.id, nodeId);
  }

  const isolatedDoc: CanvasDoc = {
    ...ctx.doc,
    activeId: entry.id,
    canvases: [isolatedEntry],
  };
  return buildCanvasSubtreeText(isolatedDoc, entry.id, nodeId, ctx.doc);
}

function buildStateNodeOnlyPrompt(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  nodeId: string
): string {
  const isolatedEntry = buildIsolatedEntryForNode(entry, nodeId);
  if (!isolatedEntry) {
    return buildStateSubtreePrompt(ctx, entry.id, nodeId);
  }

  const isolatedDoc: CanvasDoc = {
    ...ctx.doc,
    activeId: entry.id,
    canvases: [isolatedEntry],
  };
  return compileStateExtractionSubtreePrompt(
    isolatedDoc,
    mapStatePromptFields(ctx.stateSchema),
    entry.id,
    nodeId,
    ctx.doc
  );
}

function describePolicyBranchTarget(
  entry: CanvasEntry,
  nodeId: string | null | undefined
): string {
  if (!nodeId) {
    return "end the current policy flow";
  }

  const node = entry.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return "continue to the next policy step";
  }

  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  if (label) {
    return `${node.type} node "${label}"`;
  }
  return `${node.type} node`;
}

function buildPolicyConditionExtractionInstruction(
  entry: CanvasEntry,
  node: CanvasNodeRecord,
  trueTarget: string | null,
  falseTarget: string | null
): string {
  const label = String(node.data.label ?? "").trim();
  const trueBranch = describePolicyBranchTarget(entry, trueTarget);
  const falseBranch = describePolicyBranchTarget(entry, falseTarget);

  return [
    `Evaluate whether this policy condition should take its TRUE branch right now: ${label || "(unlabeled condition)"}.`,
    `Return true when the workflow should follow the TRUE branch toward ${trueBranch}.`,
    `Return false when it should follow the FALSE branch toward ${falseBranch}.`,
    "Base the decision on the current state, current_build, recent conversation context, and any previously extracted local values.",
  ].join(" ");
}

function buildPolicyConditionExtractionContextPrompt(
  entry: CanvasEntry,
  node: CanvasNodeRecord,
  trueTarget: string | null,
  falseTarget: string | null
): string {
  const label = String(node.data.label ?? "").trim();
  const trueBranch = describePolicyBranchTarget(entry, trueTarget);
  const falseBranch = describePolicyBranchTarget(entry, falseTarget);

  return [
    "Evaluate exactly one policy IF node as a boolean routing decision.",
    `Canvas: ${entry.name || entry.id}.`,
    `Condition: ${label || "(unlabeled condition)"}.`,
    `TRUE branch: ${trueBranch}.`,
    `FALSE branch: ${falseBranch}.`,
    "Use the latest user message, current assistant state, current local values, and prior carried output.",
    "Return only the requested JSON object. Do not answer the user.",
  ].join("\n");
}

function buildStateConditionExtractionInstruction(
  entry: CanvasEntry,
  node: CanvasNodeRecord,
  trueTarget: string | null,
  falseTarget: string | null
): string {
  const label = String(node.data.label ?? "").trim();
  const trueBranch = describePolicyBranchTarget(entry, trueTarget);
  const falseBranch = describePolicyBranchTarget(entry, falseTarget);

  return [
    `Evaluate whether this state condition should take its TRUE branch right now: ${label || "(unlabeled condition)"}.`,
    `Return true when the workflow should follow the TRUE branch toward ${trueBranch}.`,
    `Return false when it should follow the FALSE branch toward ${falseBranch}.`,
    "Base the decision on the current state, the latest input, current_build, and any previously extracted local values.",
  ].join(" ");
}

function mergeFlexibleSubtreeStats(
  ...parts: FlexibleSubtreeStats[]
): FlexibleSubtreeStats {
  return parts.reduce(
    (acc, part) => ({
      nodeCount: acc.nodeCount + part.nodeCount,
      hardStructuralCount: acc.hardStructuralCount + part.hardStructuralCount,
      promptLikeCount: acc.promptLikeCount + part.promptLikeCount,
      explicitOutputCount: acc.explicitOutputCount + part.explicitOutputCount,
    }),
    {
      nodeCount: 0,
      hardStructuralCount: 0,
      promptLikeCount: 0,
      explicitOutputCount: 0,
    }
  );
}

function collectPolicyFlexibleSubtreeStats(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  nodeId: string | null | undefined,
  visitingCanvases: Set<string>,
  path: Set<string>
): FlexibleSubtreeStats {
  if (!nodeId) {
    return { nodeCount: 0, hardStructuralCount: 0, promptLikeCount: 0, explicitOutputCount: 0 };
  }

  const maps = buildGraphMaps(entry);
  const node = maps.byId.get(nodeId);
  if (!node) {
    return { nodeCount: 0, hardStructuralCount: 0, promptLikeCount: 0, explicitOutputCount: 0 };
  }

  const pathKey = `${entry.id}:${nodeId}`;
  if (path.has(pathKey)) {
    return { nodeCount: 0, hardStructuralCount: 0, promptLikeCount: 0, explicitOutputCount: 0 };
  }
  const nextPath = new Set(path);
  nextPath.add(pathKey);

  let current: FlexibleSubtreeStats = {
    nodeCount: 1,
    hardStructuralCount: 0,
    promptLikeCount: 0,
    explicitOutputCount: 0,
  };

  if (nodeHasPromptOutputFields(node)) {
    current.hardStructuralCount += 1;
    current.explicitOutputCount += 1;
  } else if (isRunnableCallNode(node) || getPolicyRuntimeOperation(node)) {
    current.hardStructuralCount += 1;
  } else if (node.type === "condition" || node.type === "while") {
    const parsed = parseConditionLabel(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    const targets =
      node.type === "condition"
        ? getConditionTargets(entry, node.id)
        : (() => {
            const loopTargets = getLoopTargets(entry, node.id);
            return {
              trueTarget: loopTargets.bodyTarget,
              falseTarget: loopTargets.doneTarget,
              hasUnexpectedEdges: loopTargets.hasUnexpectedEdges,
            };
          })();
    if (parsed && !targets.hasUnexpectedEdges) {
      current.hardStructuralCount += 1;
    } else {
      current.promptLikeCount += 1;
    }
  } else if (node.type === "for") {
    current.hardStructuralCount += 1;
  } else if (
    node.type === "terminate" ||
    isStageTerminalNode(node) ||
    isStageContinueNode(node)
  ) {
    current.hardStructuralCount += 1;
  } else if (isDisplayNode(node)) {
    current.hardStructuralCount += 1;
  } else if (isPromptOrCodeNode(node)) {
    const actionType = readNodeActionType(node);
    if (actionType === "code") {
      current.hardStructuralCount += 1;
    } else if (
      actionType !== "prompt" &&
      resolveNodeExecutableStateCodeOps(node, ctx.stateSchema)
    ) {
      current.hardStructuralCount += 1;
    } else if (actionType === "prompt_transform") {
      current.promptLikeCount += 1;
    } else {
      current.promptLikeCount += 1;
    }
  }

  if (node.type === "expand") {
    const target = findCanvasByLabel(ctx.doc, node.data.label ?? "");
    if (target && !visitingCanvases.has(target.id)) {
      const nextVisiting = new Set(visitingCanvases);
      nextVisiting.add(target.id);
      const startTargets = getStartTargets(target);
      current = mergeFlexibleSubtreeStats(
        current,
        ...startTargets.map((targetId) =>
          collectPolicyFlexibleSubtreeStats(
            ctx,
            target,
            targetId,
            nextVisiting,
            new Set()
          )
        )
      );
    }
  }

  const nextTargets =
    node.type === "terminate" ||
    isStageTerminalNode(node) ||
    isStageContinueNode(node)
      ? []
      : node.type === "for" || node.type === "while"
      ? (() => {
          const loopTargets = getLoopTargets(entry, node.id);
          return [loopTargets.bodyTarget, loopTargets.doneTarget].filter(
            (value): value is string => Boolean(value)
          );
        })()
      : isRunnableCallNode(node)
        ? [
            ...getCallNodeTargets(entry, node.id).successTargets,
            ...(getCallNodeTargets(entry, node.id).errorTarget
              ? [getCallNodeTargets(entry, node.id).errorTarget]
              : []),
          ]
        : getSequentialTargets(entry, node.id);
  return mergeFlexibleSubtreeStats(
    current,
    ...nextTargets.map((targetId) =>
      collectPolicyFlexibleSubtreeStats(
        ctx,
        entry,
        targetId,
        visitingCanvases,
        nextPath
      )
    )
  );
}

function collectStateFlexibleSubtreeStats(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  nodeId: string | null | undefined,
  visitingCanvases: Set<string>,
  path: Set<string>
): FlexibleSubtreeStats {
  if (!nodeId) {
    return { nodeCount: 0, hardStructuralCount: 0, promptLikeCount: 0, explicitOutputCount: 0 };
  }

  const maps = buildGraphMaps(entry);
  const node = maps.byId.get(nodeId);
  if (!node) {
    return { nodeCount: 0, hardStructuralCount: 0, promptLikeCount: 0, explicitOutputCount: 0 };
  }

  const pathKey = `${entry.id}:${nodeId}`;
  if (path.has(pathKey)) {
    return { nodeCount: 0, hardStructuralCount: 0, promptLikeCount: 0, explicitOutputCount: 0 };
  }
  const nextPath = new Set(path);
  nextPath.add(pathKey);

  let current: FlexibleSubtreeStats = {
    nodeCount: 1,
    hardStructuralCount: 0,
    promptLikeCount: 0,
    explicitOutputCount: 0,
  };

  if (nodeHasPromptOutputFields(node)) {
    current.hardStructuralCount += 1;
    current.explicitOutputCount += 1;
  } else if (isToolCallNode(node) || getStateRuntimeOperation(node)) {
    current.hardStructuralCount += 1;
  } else if (node.type === "condition" || node.type === "while") {
    const parsed = parseConditionLabel(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    const targets =
      node.type === "condition"
        ? getConditionTargets(entry, node.id)
        : (() => {
            const loopTargets = getLoopTargets(entry, node.id);
            return {
              trueTarget: loopTargets.bodyTarget,
              falseTarget: loopTargets.doneTarget,
              hasUnexpectedEdges: loopTargets.hasUnexpectedEdges,
            };
          })();
    if (parsed && !targets.hasUnexpectedEdges) {
      current.hardStructuralCount += 1;
    } else {
      current.promptLikeCount += 1;
    }
  } else if (node.type === "for") {
    current.hardStructuralCount += 1;
  } else if (
    node.type === "terminate" ||
    isStageTerminalNode(node) ||
    isStageContinueNode(node)
  ) {
    current.hardStructuralCount += 1;
  } else if (isDisplayNode(node)) {
    current.hardStructuralCount += 1;
  } else if (isPromptOrCodeNode(node)) {
    const actionType = readNodeActionType(node);
    if (actionType === "code") {
      current.hardStructuralCount += 1;
    } else if (actionType === "tool_call" || getStateRuntimeOperation(node)) {
      current.hardStructuralCount += 1;
    } else if (
      actionType !== "prompt" &&
      resolveNodeExecutableStateCodeOps(node, ctx.stateSchema)
    ) {
      current.hardStructuralCount += 1;
    } else {
      current.promptLikeCount += 1;
    }
  }

  if (node.type === "expand") {
    const target = findCanvasByLabel(ctx.doc, node.data.label ?? "");
    if (target && !visitingCanvases.has(target.id)) {
      const nextVisiting = new Set(visitingCanvases);
      nextVisiting.add(target.id);
      const startTargets = getStartTargets(target);
      current = mergeFlexibleSubtreeStats(
        current,
        ...startTargets.map((targetId) =>
          collectStateFlexibleSubtreeStats(
            ctx,
            target,
            targetId,
            nextVisiting,
            new Set()
          )
        )
      );
    }
  }

  const nextTargets =
    node.type === "terminate" ||
    isStageTerminalNode(node) ||
    isStageContinueNode(node)
      ? []
      : node.type === "for" || node.type === "while"
      ? (() => {
          const loopTargets = getLoopTargets(entry, node.id);
          return [loopTargets.bodyTarget, loopTargets.doneTarget].filter(
            (value): value is string => Boolean(value)
          );
        })()
      : getSequentialTargets(entry, node.id);
  return mergeFlexibleSubtreeStats(
    current,
    ...nextTargets.map((targetId) =>
      collectStateFlexibleSubtreeStats(
        ctx,
        entry,
        targetId,
        visitingCanvases,
        nextPath
      )
    )
  );
}

function shouldCollapseFlexiblePolicySubtreeToPrompt(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  nodeId: string
): boolean {
  const promptLength = buildCanvasSubtreeText(ctx.doc, entry.id, nodeId).length;
  const stats = collectPolicyFlexibleSubtreeStats(ctx, entry, nodeId, new Set(), new Set());

  if (stats.explicitOutputCount > 0) {
    return false;
  }
  if (stats.hardStructuralCount === 0) {
    return true;
  }
  if (promptLength >= POLICY_PROMPT_COLLAPSE_HARD_MAX_CHARS) {
    return false;
  }
  if (stats.nodeCount <= 4 && promptLength <= 2200) {
    return true;
  }
  if (
    promptLength <= POLICY_PROMPT_COLLAPSE_SOFT_MAX_CHARS &&
    stats.promptLikeCount >= Math.max(2, stats.hardStructuralCount)
  ) {
    return true;
  }
  if (
    promptLength <= POLICY_PROMPT_COLLAPSE_MEDIUM_MAX_CHARS &&
    stats.promptLikeCount >= stats.hardStructuralCount * 2
  ) {
    return true;
  }
  return false;
}

function shouldCollapseFlexibleStateSubtreeToPrompt(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  nodeId: string
): boolean {
  const promptLength = buildStateSubtreePrompt(ctx, entry.id, nodeId).length;
  const stats = collectStateFlexibleSubtreeStats(ctx, entry, nodeId, new Set(), new Set());

  if (stats.explicitOutputCount > 0) {
    return false;
  }
  if (stats.hardStructuralCount === 0) {
    return true;
  }
  if (promptLength >= STATE_PROMPT_COLLAPSE_HARD_MAX_CHARS) {
    return false;
  }
  if (stats.nodeCount <= 4 && promptLength <= 2200) {
    return true;
  }
  if (
    promptLength <= STATE_PROMPT_COLLAPSE_SOFT_MAX_CHARS &&
    stats.promptLikeCount >= Math.max(2, stats.hardStructuralCount)
  ) {
    return true;
  }
  if (
    promptLength <= STATE_PROMPT_COLLAPSE_MEDIUM_MAX_CHARS &&
    stats.promptLikeCount >= stats.hardStructuralCount * 2
  ) {
    return true;
  }
  return false;
}

function lowerPolicyTargetsInOrder(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  targetIds: string[],
  continuation: LoweringContinuation,
  path: Set<string>
): LoweringContinuation {
  const orderedTargets = Array.from(new Set(targetIds));
  let current = continuation;

  for (let index = orderedTargets.length - 1; index >= 0; index -= 1) {
    const targetId = orderedTargets[index];
    if (!targetId || continuationCoversNode(current, entry, targetId)) {
      continue;
    }
    current = lowerPolicyNode(ctx, entry, targetId, current, path);
  }

  return current;
}

function lowerStateTargetsInOrder(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  targetIds: string[],
  continuation: LoweringContinuation,
  path: Set<string>
): LoweringContinuation {
  const orderedTargets = Array.from(new Set(targetIds));
  let current = continuation;

  for (let index = orderedTargets.length - 1; index >= 0; index -= 1) {
    const targetId = orderedTargets[index];
    if (!targetId || continuationCoversNode(current, entry, targetId)) {
      continue;
    }
    current = lowerStateNode(ctx, entry, targetId, current, path);
  }

  return current;
}

function lowerPolicyConditionViaPrompt(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord,
  trueTarget: string | null,
  falseTarget: string | null,
  continuation: LoweringContinuation,
  nextPath: Set<string>
): LoweringContinuation {
  const trueFlow = trueTarget
    ? lowerPolicyNode(ctx, entry, trueTarget, continuation, nextPath)
    : continuation.stepId
      ? continuation
      : createLoweringContinuation(
          pushPolicyStep(ctx, "policy-end", { type: "end" }),
          continuation.coveredNodeKeys
        );
  const falseFlow = falseTarget
    ? lowerPolicyNode(ctx, entry, falseTarget, continuation, nextPath)
    : continuation.stepId
      ? continuation
      : createLoweringContinuation(
          pushPolicyStep(ctx, "policy-end", { type: "end" }),
          continuation.coveredNodeKeys
        );
  const conditionFailureStepId = pushPolicyStep(ctx, "policy-condition-error", {
    type: "end",
    message: `Could not evaluate policy condition as true or false: ${node.data.label ?? "(unlabeled condition)"}`,
  }, [buildCanvasNodeKey(entry.id, node.id)]);
  const promptValueName = `model_condition_${ctx.nextId}_result`;
  const branchStepId = pushPolicyStep(ctx, "policy-model-branch", {
    type: "code",
    rules: [
      {
        when: {
          kind: "prompt_value_equals",
          name: promptValueName,
          value: true,
        },
      },
    ],
    on_match_step_id: trueFlow.stepId ?? pushPolicyStep(ctx, "policy-end", { type: "end" }),
    on_no_match_step_id: falseFlow.stepId ?? pushPolicyStep(ctx, "policy-end", { type: "end" }),
  }, [buildCanvasNodeKey(entry.id, node.id)]);

  const stepId = pushPolicyStep(ctx, "policy-model-condition", {
    type: "prompt_extract",
    prompt_extraction_plan: {
      context_prompt: buildPolicyConditionExtractionContextPrompt(
        entry,
        node,
        trueTarget,
        falseTarget
      ),
      fields: [
        {
          name: promptValueName,
          type: "boolean",
          instruction: buildPolicyConditionExtractionInstruction(
            entry,
            node,
            trueTarget,
            falseTarget
          ),
        },
      ],
    },
    on_value_step_id: branchStepId,
    on_empty_step_id: conditionFailureStepId,
  }, [buildCanvasNodeKey(entry.id, node.id)]);

  const guaranteedCoverage = intersectCoveredNodeKeys(
    trueFlow.coveredNodeKeys,
    falseFlow.coveredNodeKeys
  );
  guaranteedCoverage.add(buildCanvasNodeKey(entry.id, node.id));
  return extendLoweringContinuation(continuation, stepId, guaranteedCoverage);
}

function lowerStateConditionViaPrompt(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord,
  trueTarget: string | null,
  falseTarget: string | null,
  continuation: LoweringContinuation,
  nextPath: Set<string>
): LoweringContinuation {
  const trueFlow = trueTarget
    ? lowerStateNode(ctx, entry, trueTarget, continuation, nextPath)
    : continuation.stepId
      ? continuation
      : createLoweringContinuation(
          pushStateStep(ctx, "state-end", { type: "end" }),
          continuation.coveredNodeKeys
        );
  const falseFlow = falseTarget
    ? lowerStateNode(ctx, entry, falseTarget, continuation, nextPath)
    : continuation.stepId
      ? continuation
      : createLoweringContinuation(
          pushStateStep(ctx, "state-end", { type: "end" }),
          continuation.coveredNodeKeys
        );
  const conditionFailureStepId = pushStateStep(ctx, "state-condition-error", {
    type: "end",
    message: `Could not evaluate state condition as true or false: ${node.data.label ?? "(unlabeled condition)"}`,
  }, [buildCanvasNodeKey(entry.id, node.id)]);
  const promptValueName = `condition_${ctx.nextId}_result`;
  const branchStepId = pushStateStep(ctx, "state-branch", {
    type: "code",
    rules: [
      {
        when: {
          kind: "prompt_value_equals",
          name: promptValueName,
          value: true,
        },
        ops: [],
      },
    ],
    on_match_step_id: trueFlow.stepId ?? pushStateStep(ctx, "state-end", { type: "end" }),
    on_no_match_step_id: falseFlow.stepId ?? pushStateStep(ctx, "state-end", { type: "end" }),
  }, [buildCanvasNodeKey(entry.id, node.id)]);

  const stepId = pushStateStep(ctx, "state-prompt-extract-condition", {
    type: "prompt_extract",
    prompt_extraction_plan: {
      fields: [
        {
          name: promptValueName,
          type: "boolean",
          instruction: buildStateConditionExtractionInstruction(
            entry,
            node,
            trueTarget,
            falseTarget
          ),
        },
      ],
    },
    on_value_step_id: branchStepId,
    on_empty_step_id: conditionFailureStepId,
  }, [buildCanvasNodeKey(entry.id, node.id)]);

  const guaranteedCoverage = intersectCoveredNodeKeys(
    trueFlow.coveredNodeKeys,
    falseFlow.coveredNodeKeys
  );
  guaranteedCoverage.add(buildCanvasNodeKey(entry.id, node.id));
  return extendLoweringContinuation(continuation, stepId, guaranteedCoverage);
}

function lowerPolicyForNode(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord,
  bodyTarget: string | null,
  doneTarget: string | null,
  continuation: LoweringContinuation,
  nextPath: Set<string>
): LoweringContinuation {
  const doneFlow = doneTarget
    ? lowerPolicyNode(ctx, entry, doneTarget, continuation, nextPath)
    : ensurePolicyContinuationStep(ctx, continuation);
  let current = doneFlow;

  if (bodyTarget) {
    const maxIterations = readLoopMaxIterations(node);
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      current = lowerPolicyNode(ctx, entry, bodyTarget, current, nextPath);
    }
  }

  return extendLoweringContinuation(current, current.stepId, [
    buildCanvasNodeKey(entry.id, node.id),
  ]);
}

function lowerStateForNode(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord,
  bodyTarget: string | null,
  doneTarget: string | null,
  continuation: LoweringContinuation,
  nextPath: Set<string>
): LoweringContinuation {
  const doneFlow = doneTarget
    ? lowerStateNode(ctx, entry, doneTarget, continuation, nextPath)
    : ensureStateContinuationStep(ctx, continuation);
  let current = doneFlow;

  if (bodyTarget) {
    const maxIterations = readLoopMaxIterations(node);
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      current = lowerStateNode(ctx, entry, bodyTarget, current, nextPath);
    }
  }

  return extendLoweringContinuation(current, current.stepId, [
    buildCanvasNodeKey(entry.id, node.id),
  ]);
}

function lowerPolicyWhileNode(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord,
  condition: ConditionPlan,
  bodyTarget: string | null,
  doneTarget: string | null,
  continuation: LoweringContinuation,
  nextPath: Set<string>
): LoweringContinuation {
  const doneFlow = doneTarget
    ? lowerPolicyNode(ctx, entry, doneTarget, continuation, nextPath)
    : ensurePolicyContinuationStep(ctx, continuation);
  let current = doneFlow;
  const maxIterations = readLoopMaxIterations(node);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const bodyFlow = bodyTarget
      ? lowerPolicyNode(ctx, entry, bodyTarget, current, nextPath)
      : current;
    const guaranteedCoverage = intersectCoveredNodeKeys(
      bodyFlow.coveredNodeKeys,
      doneFlow.coveredNodeKeys
    );
    guaranteedCoverage.add(buildCanvasNodeKey(entry.id, node.id));
    current = extendLoweringContinuation(
      doneFlow,
      pushPolicyStep(ctx, "policy-while", {
        type: "code",
        rules: [{ when: condition }],
        on_match_step_id:
          bodyFlow.stepId ?? pushPolicyStep(ctx, "policy-end", { type: "end" }),
        on_no_match_step_id:
          doneFlow.stepId ?? pushPolicyStep(ctx, "policy-end", { type: "end" }),
      }, [buildCanvasNodeKey(entry.id, node.id)]),
      guaranteedCoverage
    );
  }

  return current;
}

function lowerStateWhileNode(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord,
  condition: ConditionPlan,
  bodyTarget: string | null,
  doneTarget: string | null,
  continuation: LoweringContinuation,
  nextPath: Set<string>
): LoweringContinuation {
  const doneFlow = doneTarget
    ? lowerStateNode(ctx, entry, doneTarget, continuation, nextPath)
    : ensureStateContinuationStep(ctx, continuation);
  let current = doneFlow;
  const maxIterations = readLoopMaxIterations(node);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const bodyFlow = bodyTarget
      ? lowerStateNode(ctx, entry, bodyTarget, current, nextPath)
      : current;
    const guaranteedCoverage = intersectCoveredNodeKeys(
      bodyFlow.coveredNodeKeys,
      doneFlow.coveredNodeKeys
    );
    guaranteedCoverage.add(buildCanvasNodeKey(entry.id, node.id));
    current = extendLoweringContinuation(
      doneFlow,
      pushStateStep(ctx, "state-while", {
        type: "code",
        rules: [{ when: condition, ops: [] }],
        on_match_step_id:
          bodyFlow.stepId ?? pushStateStep(ctx, "state-end", { type: "end" }),
        on_no_match_step_id:
          doneFlow.stepId ?? pushStateStep(ctx, "state-end", { type: "end" }),
      }, [buildCanvasNodeKey(entry.id, node.id)]),
      guaranteedCoverage
    );
  }

  return current;
}

function lowerFlexiblePolicyPromptNode(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord,
  continuation: LoweringContinuation
): LoweringContinuation {
  const nextStepId = continuation.stepId;
  const nodeKey = buildCanvasNodeKey(entry.id, node.id);
  const outputFields = readNodePromptOutputFields(node);
  if (outputFields.length > 0) {
    const stepId = pushPolicyStep(ctx, "policy-prompt-outputs", {
      type: "prompt_extract",
      prompt_extraction_plan: {
        context_prompt: buildPolicyNodeOnlyPrompt(ctx, entry, node.id),
        fields: outputFields,
      },
      next_step_id: nextStepId ?? undefined,
    }, [nodeKey]);
    return extendLoweringContinuation(continuation, stepId, [nodeKey]);
  }

  const directToolTarget = getDirectToolTarget(entry, node);
  if (directToolTarget) {
    const stepId = pushPolicyStep(ctx, "policy-prompt-tool-inputs", {
      type: "prompt_extract",
      prompt_extraction_plan: {
        context_prompt: buildPolicyNodeOnlyPrompt(ctx, entry, node.id),
        fields: [
          {
            name: buildToolParentContributionVariableName(node, directToolTarget),
            type: "json",
            instruction: buildToolContributionInstruction(directToolTarget, node),
          },
        ],
      },
      next_step_id: nextStepId ?? undefined,
    }, [nodeKey]);
    return extendLoweringContinuation(continuation, stepId, [nodeKey]);
  }

  if (
    continuation.coveredNodeKeys.size === 0 &&
    shouldCollapseFlexiblePolicySubtreeToPrompt(ctx, entry, node.id) &&
    canAbsorbContinuationIntoCanvasSubtree(entry, node.id, continuation)
  ) {
    const collapsedNodeIds = collectPolicyCollapsedPromptNodeIds(ctx, entry, node.id);
    recordPromptGroup(
      "policy",
      entry,
      node.id,
      ctx.promptGroups,
      ctx.recordedPromptGroupKeys,
      collapsedNodeIds
    );
    const stepId = pushPolicyStep(ctx, "policy-prompt-subtree", {
      type: "prompt_subtree_decision",
      subtree_prompt: buildPolicyCollapsedSubtreePrompt(
        ctx,
        entry,
        node.id,
        collapsedNodeIds
      ),
      next_step_id: nextStepId ?? undefined,
    }, canvasNodeKeysForNodeIds(entry, collapsedNodeIds));
    return extendLoweringContinuation(
      continuation,
      stepId,
      collectReachableNodeKeys(entry, node.id)
    );
  }

  const stepId = pushPolicyStep(ctx, "policy-prompt-node", {
    type: "prompt_subtree_decision",
    subtree_prompt: buildPolicyNodeOnlyPrompt(ctx, entry, node.id),
    next_step_id: nextStepId ?? undefined,
  }, [nodeKey]);
  return extendLoweringContinuation(continuation, stepId, [nodeKey]);
}

function lowerFlexibleStatePromptNode(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  node: CanvasNodeRecord,
  continuation: LoweringContinuation
): LoweringContinuation {
  const nextStepId = continuation.stepId;
  const nodeKey = buildCanvasNodeKey(entry.id, node.id);
  const outputFields = readNodePromptOutputFields(node);
  if (outputFields.length > 0) {
    const stepId = pushStateStep(ctx, "state-prompt-outputs", {
      type: "prompt_extract",
      prompt_extraction_plan: {
        context_prompt: buildStateNodeOnlyPrompt(ctx, entry, node.id),
        fields: outputFields,
      },
      next_step_id: nextStepId ?? undefined,
    }, [nodeKey]);
    return extendLoweringContinuation(continuation, stepId, [nodeKey]);
  }

  const directToolTarget = getDirectToolTarget(entry, node);
  if (directToolTarget) {
    const stepId = pushStateStep(ctx, "state-prompt-tool-inputs", {
      type: "prompt_extract",
      prompt_extraction_plan: {
        context_prompt: buildStateNodeOnlyPrompt(ctx, entry, node.id),
        fields: [
          {
            name: buildToolParentContributionVariableName(node, directToolTarget),
            type: "json",
            instruction: buildToolContributionInstruction(directToolTarget, node),
          },
        ],
      },
      next_step_id: nextStepId ?? undefined,
    }, [nodeKey]);
    return extendLoweringContinuation(continuation, stepId, [nodeKey]);
  }

  if (
    continuation.coveredNodeKeys.size === 0 &&
    shouldCollapseFlexibleStateSubtreeToPrompt(ctx, entry, node.id) &&
    canAbsorbContinuationIntoCanvasSubtree(entry, node.id, continuation)
  ) {
    const collapsedNodeIds = collectStateCollapsedPromptNodeIds(ctx, entry, node.id);
    recordPromptGroup(
      "state",
      entry,
      node.id,
      ctx.promptGroups,
      ctx.recordedPromptGroupKeys,
      collapsedNodeIds
    );
    const subtreePrompt = buildStateCollapsedSubtreePrompt(
      ctx,
      entry,
      node.id,
      collapsedNodeIds
    );
    const stepId = pushStateStep(ctx, "state-prompt-subtree", {
      type: "prompt_subtree_update",
      subtree_prompt: subtreePrompt,
      ...statePromptPreserveFieldsData(subtreePrompt),
      next_step_id: nextStepId ?? undefined,
    }, canvasNodeKeysForNodeIds(entry, collapsedNodeIds));
    return extendLoweringContinuation(
      continuation,
      stepId,
      collectReachableNodeKeys(entry, node.id)
    );
  }

  const nodePrompt = buildStateNodeOnlyPrompt(ctx, entry, node.id);
  const stepId = pushStateStep(ctx, "state-prompt-node", {
    type: "prompt_subtree_update",
    subtree_prompt: nodePrompt,
    ...statePromptPreserveFieldsData(nodePrompt),
    next_step_id: nextStepId ?? undefined,
  }, [nodeKey]);
  return extendLoweringContinuation(continuation, stepId, [nodeKey]);
}

function inferPolicyPromptMode(steps: PolicyExecutionGraphStep[]): "code" | "hybrid" {
  return steps.some(
    (step) =>
      step.type === "prompt_transform" ||
      step.type === "prompt_subtree_decision" ||
      step.type === "full_prompt_decision" ||
      step.type === "prompt_extract"
  )
    ? "hybrid"
    : "code";
}

function getPolicyRuntimeOperation(
  node: CanvasNodeRecord
): PolicyRuntimeOperationName | null {
  return getRuntimeOperationKindFromNode(node);
}

function getStateRuntimeOperation(
  node: CanvasNodeRecord
): PolicyRuntimeOperationName | null {
  return getRuntimeOperationKindFromNode(node);
}

function inferStatePromptMode(steps: StateExecutionGraphStep[]): "code" | "hybrid" {
  return steps.some(
    (step) =>
      step.type === "prompt_transform" ||
      step.type === "prompt_subtree_update" ||
      step.type === "full_prompt_update" ||
      step.type === "prompt_extract"
  )
    ? "hybrid"
    : "code";
}

function buildNonRunnableToolMessage(node: CanvasNodeRecord): string {
  const label = String(node.data?.label ?? "").trim();
  const toolName = inferToolFunctionName(node).trim();
  const descriptor = toolName
    ? `tool "${toolName}"`
    : label
      ? `tool node "${label}"`
      : "tool node";

  return `This workflow references ${descriptor}, but it is not runnable yet because its tool configuration is incomplete. Configure the tool before running this branch.`;
}

function buildUnsupportedPolicyShapeMessage(args: {
  entry: CanvasEntry;
  node?: CanvasNodeRecord | null;
  reason: string;
}): string {
  const canvasName = args.entry.name.trim() || "Unnamed canvas";
  const nodeLabel =
    typeof args.node?.data?.label === "string" ? args.node.data.label.trim() : "";
  const nodeDescriptor = args.node
    ? nodeLabel
      ? `${args.node.type} node "${nodeLabel}"`
      : `${args.node.type} node`
    : "canvas";

  return `This policy workflow cannot run structurally because ${args.reason} in ${nodeDescriptor} of "${canvasName}". Fix the canvas graph before running this branch.`;
}

function buildUnsupportedStateShapeMessage(args: {
  entry: CanvasEntry;
  node?: CanvasNodeRecord | null;
  reason: string;
}): string {
  const canvasName = args.entry.name.trim() || "Unnamed canvas";
  const nodeLabel =
    typeof args.node?.data?.label === "string" ? args.node.data.label.trim() : "";
  const nodeDescriptor = args.node
    ? nodeLabel
      ? `${args.node.type} node "${nodeLabel}"`
      : `${args.node.type} node`
    : "canvas";

  return `This state workflow cannot run structurally because ${args.reason} in ${nodeDescriptor} of "${canvasName}". Fix the canvas graph before running this branch.`;
}

function canLowerPolicyCanvasDeterministically(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  visiting: Set<string> = new Set()
): boolean {
  const cached = ctx.deterministicCanvasMemo.get(entry.id);
  if (cached !== undefined) {
    return cached;
  }

  if (visiting.has(entry.id)) {
    return true;
  }

  visiting.add(entry.id);
  const maps = buildGraphMaps(entry);
  const targets = getStartTargets(entry);
  const result =
    targets.length === 0
      ? true
      : targets.every((target) =>
          canLowerPolicyNodeDeterministically(ctx, entry, target, maps, visiting, new Set())
        );

  ctx.deterministicCanvasMemo.set(entry.id, result);
  visiting.delete(entry.id);
  return result;
}

function canLowerPolicyNodeDeterministically(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  nodeId: string,
  maps: GraphMaps,
  visitingCanvases: Set<string>,
  path: Set<string>
): boolean {
  const node = maps.byId.get(nodeId);
  if (!node) {
    return false;
  }

  const pathKey = `${entry.id}:${nodeId}`;
  if (path.has(pathKey)) {
    return true;
  }
  const nextPath = new Set(path);
  nextPath.add(pathKey);

  if (node.type === "condition") {
    const conditionIssue = getConditionLabelIssue(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    if (conditionIssue) {
      return false;
    }
    const targets = getConditionTargets(entry, node.id);
    if (targets.hasUnexpectedEdges) {
      return false;
    }
    return [targets.trueTarget, targets.falseTarget]
      .filter((value): value is string => typeof value === "string")
      .every((target) =>
        canLowerPolicyNodeDeterministically(ctx, entry, target, maps, visitingCanvases, nextPath)
      );
  }

  if (
    node.type === "terminate" ||
    node.type === "yield" ||
    isStageTerminalNode(node) ||
    isStageContinueNode(node)
  ) {
    return true;
  }

  if (node.type === "while") {
    const conditionIssue = getConditionLabelIssue(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    if (conditionIssue) {
      return false;
    }
    const condition = parseConditionLabel(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    const targets = getLoopTargets(entry, node.id);
    if (!condition || targets.hasUnexpectedEdges) {
      return false;
    }
    return [targets.bodyTarget, targets.doneTarget]
      .filter((value): value is string => typeof value === "string")
      .every((target) =>
        canLowerPolicyNodeDeterministically(ctx, entry, target, maps, visitingCanvases, nextPath)
      );
  }

  if (node.type === "for") {
    const targets = getLoopTargets(entry, node.id);
    if (targets.hasUnexpectedEdges) {
      return false;
    }
    return [targets.bodyTarget, targets.doneTarget]
      .filter((value): value is string => typeof value === "string")
      .every((target) =>
        canLowerPolicyNodeDeterministically(ctx, entry, target, maps, visitingCanvases, nextPath)
      );
  }

  if (node.type === "expand") {
    const target = findCanvasByLabel(ctx.doc, node.data.label ?? "");
    if (!target || !canLowerPolicyCanvasDeterministically(ctx, target, visitingCanvases)) {
      return false;
    }
  } else if (isDisplayNode(node)) {
    // supported
  } else if (isRunnableCallNode(node)) {
    // Non-runnable calls still lower structurally as explicit error paths.
    const targets = getCallNodeTargets(entry, node.id);
    const targetIds = [
      ...targets.successTargets,
      ...(targets.errorTarget ? [targets.errorTarget] : []),
    ];
    if (targetIds.length === 0) {
      return true;
    }
    return targetIds.every((target) =>
      canLowerPolicyNodeDeterministically(ctx, entry, target, maps, visitingCanvases, nextPath)
    );
  } else if (getPolicyRuntimeOperation(node)) {
    // supported
  } else if (isPromptOrCodeNode(node)) {
    // generic actions can still lower structurally via prompt_subtree_decision
  } else {
    return false;
  }

  const nextTargets = getSequentialTargets(entry, node.id);
  if (nextTargets.length > 1) {
    return true;
  }
  if (nextTargets.length === 0) {
    return true;
  }

  return canLowerPolicyNodeDeterministically(
    ctx,
    entry,
    nextTargets[0],
    maps,
    visitingCanvases,
    nextPath
  );
}

function canLowerStateCanvasDeterministically(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  visiting: Set<string> = new Set()
): boolean {
  const cached = ctx.deterministicCanvasMemo.get(entry.id);
  if (cached !== undefined) {
    return cached;
  }

  if (visiting.has(entry.id)) {
    return true;
  }

  visiting.add(entry.id);
  const maps = buildGraphMaps(entry);
  const targets = getStartTargets(entry);
  const result = targets.length === 0
    ? true
    : targets.every((target) =>
        canLowerStateNodeDeterministically(ctx, entry, target, maps, visiting, new Set())
      );

  ctx.deterministicCanvasMemo.set(entry.id, result);
  visiting.delete(entry.id);
  return result;
}

function canLowerStateNodeDeterministically(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  nodeId: string,
  maps: GraphMaps,
  visitingCanvases: Set<string>,
  path: Set<string>
): boolean {
  const node = maps.byId.get(nodeId);
  if (!node) {
    return false;
  }

  const pathKey = `${entry.id}:${nodeId}`;
  if (path.has(pathKey)) {
    return true;
  }
  const nextPath = new Set(path);
  nextPath.add(pathKey);

  if (node.type === "condition") {
    const conditionIssue = getConditionLabelIssue(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    if (conditionIssue) {
      return false;
    }
    const condition = parseConditionLabel(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    const targets = getConditionTargets(entry, node.id);
    if (targets.hasUnexpectedEdges) {
      return true;
    }
    if (!condition) {
      return false;
    }
    return [targets.trueTarget, targets.falseTarget]
      .filter((value): value is string => typeof value === "string")
      .every((target) =>
        canLowerStateNodeDeterministically(ctx, entry, target, maps, visitingCanvases, nextPath)
      );
  }

  if (node.type === "terminate" || isStageTerminalNode(node) || isStageContinueNode(node)) {
    return true;
  }

  if (node.type === "while") {
    const conditionIssue = getConditionLabelIssue(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    if (conditionIssue) {
      return false;
    }
    const condition = parseConditionLabel(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    const targets = getLoopTargets(entry, node.id);
    if (!condition || targets.hasUnexpectedEdges) {
      return false;
    }
    return [targets.bodyTarget, targets.doneTarget]
      .filter((value): value is string => typeof value === "string")
      .every((target) =>
        canLowerStateNodeDeterministically(ctx, entry, target, maps, visitingCanvases, nextPath)
      );
  }

  if (node.type === "for") {
    const targets = getLoopTargets(entry, node.id);
    if (targets.hasUnexpectedEdges) {
      return false;
    }
    return [targets.bodyTarget, targets.doneTarget]
      .filter((value): value is string => typeof value === "string")
      .every((target) =>
        canLowerStateNodeDeterministically(ctx, entry, target, maps, visitingCanvases, nextPath)
      );
  }

  if (node.type === "expand") {
    const target = findCanvasByLabel(ctx.doc, node.data.label ?? "");
    if (!target) {
      return true;
    }
    if (!canLowerStateCanvasDeterministically(ctx, target, visitingCanvases)) {
      return false;
    }
  } else if (isDisplayNode(node)) {
    return false;
  } else if (isToolCallNode(node)) {
    if (!nodeHasRunnableTool(node)) {
      return true;
    }
  } else if (isPromptOrCodeNode(node)) {
    if (readNodeActionType(node) === "tool_call") {
      if (!nodeHasRunnableTool(node)) {
        return true;
      }
    } else if (readNodeActionType(node) === "prompt") {
      return false;
    } else if (nodeHasPromptOutputFields(node)) {
      // Explicit node outputs lower through prompt_extract steps.
    } else {
      if (!resolveNodeExecutableStateCodeOps(node, ctx.stateSchema)) {
        return false;
      }
    }
  } else {
    return false;
  }

  const nextTargets = getSequentialTargets(entry, node.id);
  if (nextTargets.length > 1) {
    return true;
  }
  if (nextTargets.length === 0) {
    return true;
  }

  return canLowerStateNodeDeterministically(
    ctx,
    entry,
    nextTargets[0],
    maps,
    visitingCanvases,
    nextPath
  );
}

function ensurePolicyContinuationStep(
  ctx: PolicyLowerContext,
  continuation: LoweringContinuation
): LoweringContinuation {
  if (continuation.stepId) {
    return continuation;
  }
  return createLoweringContinuation(
    pushPolicyStep(ctx, "policy-end", { type: "end" }),
    continuation.coveredNodeKeys
  );
}

function ensureStateContinuationStep(
  ctx: StateLowerContext,
  continuation: LoweringContinuation
): LoweringContinuation {
  if (continuation.stepId) {
    return continuation;
  }
  return createLoweringContinuation(
    pushStateStep(ctx, "state-end", { type: "end" }),
    continuation.coveredNodeKeys
  );
}

function lowerPolicyCanvas(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  continuation: LoweringContinuation,
  path: Set<string>
): LoweringContinuation {
  const targets = getStartTargets(entry);
  if (targets.length === 0) {
    return ensurePolicyContinuationStep(ctx, continuation);
  }
  const selectedSegment = selectPolicyStartPromptSegment(ctx, entry);
  if (selectedSegment) {
    const segmentPath = buildSegmentPath(path, entry, selectedSegment.nodeIds);
    const boundaryFlow = lowerPolicyTargetsInOrder(
      ctx,
      entry,
      selectedSegment.boundaryTargetIds,
      continuation,
      segmentPath
    );
    recordPromptGroup(
      "policy",
      entry,
      selectedSegment.rootNodeId,
      ctx.promptGroups,
      ctx.recordedPromptGroupKeys,
      selectedSegment.nodeIds
    );
    const stepId = pushPolicyStep(ctx, "policy-prompt-subtree", {
      type: "prompt_subtree_decision",
      subtree_prompt: selectedSegment.prompt,
      prompt_extraction_plan:
        selectedSegment.outputFields.length > 0
          ? { fields: selectedSegment.outputFields }
          : undefined,
      next_step_id: boundaryFlow.stepId ?? undefined,
    }, canvasNodeKeysForNodeIds(entry, selectedSegment.nodeIds));
    return extendLoweringContinuation(
      boundaryFlow,
      stepId,
      selectedSegment.nodeIds.map((nodeId) => buildCanvasNodeKey(entry.id, nodeId))
    );
  }
  return lowerPolicyTargetsInOrder(ctx, entry, targets, continuation, path);
}

function lowerPolicyNode(
  ctx: PolicyLowerContext,
  entry: CanvasEntry,
  nodeId: string,
  continuation: LoweringContinuation,
  path: Set<string>
): LoweringContinuation {
  const maps = buildGraphMaps(entry);
  const node = maps.byId.get(nodeId);
  if (!node) {
    return ensurePolicyContinuationStep(ctx, continuation);
  }

  const sharedNodeMemoKey = isJoinNode(entry, nodeId)
    ? buildSharedNodeMemoKey(entry, nodeId, continuation)
    : null;
  if (sharedNodeMemoKey) {
    const existing = ctx.sharedNodeMemo.get(sharedNodeMemoKey);
    if (existing) {
      return existing;
    }
  }
  const finish = (result: LoweringContinuation): LoweringContinuation => {
    if (sharedNodeMemoKey && result.stepId) {
      ctx.sharedNodeMemo.set(sharedNodeMemoKey, result);
    }
    return result;
  };

  const pathKey = buildCanvasNodeKey(entry.id, nodeId);
  if (path.has(pathKey)) {
    return finish(extendLoweringContinuation(
      continuation,
      pushPolicyStep(ctx, "policy-graph-error", {
        type: "end",
        message: buildUnsupportedPolicyShapeMessage({
          entry,
          node,
          reason: "the graph contains a cycle that cannot be lowered safely",
        }),
      }, [pathKey]),
      [pathKey]
    ));
  }
  const nextPath = new Set(path);
  nextPath.add(pathKey);

  if (node.type === "terminate") {
    const externalConnectionId = readTerminateExternalConnectionId(node);
    const endStepId = pushPolicyStep(
      ctx,
      "policy-terminate",
      {
        type: "end",
        terminates_interaction: externalConnectionId ? false : true,
      },
      [pathKey]
    );
    const stepId = externalConnectionId
      ? pushPolicyStep(
          ctx,
          "policy-terminate-external-connection",
          {
            type: "runtime_operation",
            operation: "terminate_external_connection",
            message: externalConnectionId,
            next_step_id: endStepId,
          },
          [pathKey]
        )
      : endStepId;
    return finish(
      extendLoweringContinuation(
        continuation,
        stepId,
        [pathKey]
      )
    );
  }

  if (node.type === "yield") {
    const message =
      typeof node.data?.label === "string" && node.data.label.trim()
        ? node.data.label.trim()
        : undefined;
    return finish(
      extendLoweringContinuation(
        continuation,
        pushPolicyStep(
          ctx,
          "policy-yield",
          {
            type: "end",
            message,
            terminates_interaction: false,
          },
          [pathKey]
        ),
        [pathKey]
      )
    );
  }

  if (isStageContinueNode(node)) {
    return finish(
      extendLoweringContinuation(
        continuation,
        pushPolicyStep(
          ctx,
          "policy-continue-stage",
          {
            type: "end",
            terminates_interaction: false,
          },
          [pathKey]
        ),
        [pathKey]
      )
    );
  }

  if (isStageTerminalNode(node)) {
    return finish(
      extendLoweringContinuation(
        continuation,
        pushPolicyStep(
          ctx,
          node.type === "terminate_stage_immediate"
            ? "policy-terminate-stage-immediate"
            : "policy-terminate-stage",
          {
            type: "end",
            terminates_interaction: false,
            stage_handoff: buildPolicyStageHandoff(
              node,
              node.type === "terminate_stage_immediate"
                ? "immediate"
                : "next_turn"
            ),
          },
          [pathKey]
        ),
        [pathKey]
      )
    );
  }

  if (node.type === "condition") {
    const conditionIssue = getConditionLabelIssue(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    if (conditionIssue) {
      return finish(extendLoweringContinuation(
        continuation,
        pushPolicyStep(ctx, "policy-graph-error", {
          type: "end",
          message: buildUnsupportedPolicyShapeMessage({
            entry,
            node,
            reason: conditionIssue,
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }

    const condition = parseConditionLabel(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    const { trueTarget, falseTarget, hasUnexpectedEdges } = getConditionTargets(entry, node.id);
    if (hasUnexpectedEdges) {
      return finish(extendLoweringContinuation(
        continuation,
        pushPolicyStep(ctx, "policy-graph-error", {
          type: "end",
          message: buildUnsupportedPolicyShapeMessage({
            entry,
            node,
            reason: "the condition node does not have the expected true/false branch shape",
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }

    if (!condition) {
      return finish(lowerPolicyConditionViaPrompt(
        ctx,
        entry,
        node,
        trueTarget,
        falseTarget,
        continuation,
        nextPath
      ));
    }

    const trueFlow = trueTarget
      ? lowerPolicyNode(ctx, entry, trueTarget, continuation, nextPath)
      : ensurePolicyContinuationStep(ctx, continuation);
    const falseFlow = falseTarget
      ? lowerPolicyNode(ctx, entry, falseTarget, continuation, nextPath)
      : ensurePolicyContinuationStep(ctx, continuation);
    const guaranteedCoverage = intersectCoveredNodeKeys(
      trueFlow.coveredNodeKeys,
      falseFlow.coveredNodeKeys
    );
    guaranteedCoverage.add(pathKey);

    return finish(extendLoweringContinuation(
      continuation,
      pushPolicyStep(ctx, "policy-branch", {
        type: "code",
        rules: [{ when: condition }],
        on_match_step_id: trueFlow.stepId ?? pushPolicyStep(ctx, "policy-end", { type: "end" }),
        on_no_match_step_id: falseFlow.stepId ?? pushPolicyStep(ctx, "policy-end", { type: "end" }),
      }, [pathKey]),
      guaranteedCoverage
    ));
  }

  if (node.type === "for") {
    const { bodyTarget, doneTarget, hasUnexpectedEdges } = getLoopTargets(entry, node.id);
    if (hasUnexpectedEdges) {
      return finish(extendLoweringContinuation(
        continuation,
        pushPolicyStep(ctx, "policy-graph-error", {
          type: "end",
          message: buildUnsupportedPolicyShapeMessage({
            entry,
            node,
            reason: "the for node does not have the expected body/done branch shape",
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }

    return finish(
      lowerPolicyForNode(
        ctx,
        entry,
        node,
        bodyTarget,
        doneTarget,
        continuation,
        nextPath
      )
    );
  }

  if (node.type === "while") {
    const conditionIssue = getConditionLabelIssue(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    if (conditionIssue) {
      return finish(extendLoweringContinuation(
        continuation,
        pushPolicyStep(ctx, "policy-graph-error", {
          type: "end",
          message: buildUnsupportedPolicyShapeMessage({
            entry,
            node,
            reason: conditionIssue,
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }

    const condition = parseConditionLabel(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    const { bodyTarget, doneTarget, hasUnexpectedEdges } = getLoopTargets(entry, node.id);
    if (!condition || hasUnexpectedEdges) {
      return finish(extendLoweringContinuation(
        continuation,
        pushPolicyStep(ctx, "policy-graph-error", {
          type: "end",
          message: buildUnsupportedPolicyShapeMessage({
            entry,
            node,
            reason: !condition
              ? "the while node uses a condition that cannot be lowered structurally"
              : "the while node does not have the expected body/done branch shape",
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }

    return finish(
      lowerPolicyWhileNode(
        ctx,
        entry,
        node,
        condition,
        bodyTarget,
        doneTarget,
        continuation,
        nextPath
      )
    );
  }

  if (node.type === "expand") {
    const targetCanvas = findCanvasByLabel(ctx.doc, node.data.label ?? "");
    if (!targetCanvas) {
      return finish(extendLoweringContinuation(
        continuation,
        pushPolicyStep(ctx, "policy-graph-error", {
          type: "end",
          message: buildUnsupportedPolicyShapeMessage({
            entry,
            node,
            reason: "the expand node points to a missing subcanvas",
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }

    const nextFlow = lowerPolicyTargetsInOrder(
      ctx,
      entry,
      getSequentialTargets(entry, node.id),
      continuation,
      nextPath
    );
    const expandedFlow = lowerPolicyCanvas(ctx, targetCanvas, nextFlow, nextPath);
    appendPolicyStepSourceNodeKeys(ctx, expandedFlow.stepId, [pathKey]);
    return finish(
      extendLoweringContinuation(
        expandedFlow,
        expandedFlow.stepId,
        [pathKey]
      )
    );
  }

  if (isPolicyPromptSegmentEligibleNode(ctx, entry, node)) {
    const selectedSegment = selectPolicyPromptSegment(ctx, entry, node.id);
    if (selectedSegment) {
      const segmentPath = buildSegmentPath(path, entry, selectedSegment.nodeIds);
      const boundaryFlow = lowerPolicyTargetsInOrder(
        ctx,
        entry,
        selectedSegment.boundaryTargetIds,
        continuation,
        segmentPath
      );
      recordPromptGroup(
        "policy",
        entry,
        selectedSegment.rootNodeId,
        ctx.promptGroups,
        ctx.recordedPromptGroupKeys,
        selectedSegment.nodeIds
      );
      const stepId = pushPolicyStep(ctx, "policy-prompt-subtree", {
        type: "prompt_subtree_decision",
        subtree_prompt: selectedSegment.prompt,
        prompt_extraction_plan:
          selectedSegment.outputFields.length > 0
            ? { fields: selectedSegment.outputFields }
            : undefined,
        next_step_id: boundaryFlow.stepId ?? undefined,
      }, canvasNodeKeysForNodeIds(entry, selectedSegment.nodeIds));
      return finish(
        extendLoweringContinuation(
          boundaryFlow,
          stepId,
          selectedSegment.nodeIds.map((segmentNodeId) =>
            buildCanvasNodeKey(entry.id, segmentNodeId)
          )
        )
      );
    }
  }

  const callTargets = isRunnableCallNode(node) ? getCallNodeTargets(entry, node.id) : null;
  const nextTargetIds = callTargets?.successTargets ?? getSequentialTargets(entry, node.id);
  const nextFlow = lowerPolicyTargetsInOrder(
    ctx,
    entry,
    nextTargetIds,
    continuation,
    nextPath
  );
  const ensuredNextFlow = ensurePolicyContinuationStep(ctx, nextFlow);

  if (isToolCallNode(node) || isCallAgentNode(node)) {
    const isRunnable = isToolCallNode(node)
      ? nodeHasRunnableTool(node)
      : nodeHasRunnableAgentCall(node);
    if (!isRunnable) {
      return finish(extendLoweringContinuation(
        continuation,
        pushPolicyStep(ctx, "policy-tool-config-error", {
          type: "end",
          message: buildNonRunnableToolMessage(node),
        }, [pathKey]),
        [pathKey]
      ));
    }
    const toolName = isToolCallNode(node)
      ? inferToolFunctionName(node)
      : inferCallAgentToolName(node);
    const resultVariable = isToolCallNode(node)
      ? readToolResultVariableName(node)
      : readCallAgentResultVariableName(node);
    const errorFlow = callTargets?.errorTarget
      ? lowerPolicyNode(ctx, entry, callTargets.errorTarget, continuation, nextPath)
      : createLoweringContinuation(
          pushPolicyStep(ctx, "policy-fetch-error", {
            type: "end",
            message:
              "Sorry — I couldn't complete that step because one of my tools failed. Please try again in a moment.",
          }, [pathKey]),
          [pathKey]
        );
    return finish(extendLoweringContinuation(
      nextFlow,
      pushPolicyStep(ctx, "policy-tool", {
        type: "tool_call",
        tool_name: toolName,
        result_variable: resultVariable,
        input_object_variables: getToolInputObjectVariables(entry, node),
        input_prompt_value_names: getToolInputPromptValueNames(entry, node),
        next_step_id: ensuredNextFlow.stepId ?? undefined,
        on_error_step_id: errorFlow.stepId ?? undefined,
      }, [pathKey]),
      [pathKey]
    ));
  }

  if (isPromptOrCodeNode(node)) {
    const actionType = readNodeActionType(node);
    if (
      actionType !== "prompt" &&
      actionType !== "display" &&
      actionType !== "prompt_transform" &&
      actionType !== "tool_call" &&
      !nodeHasPromptOutputFields(node)
    ) {
      const directToolTarget = getDirectToolTarget(entry, node);
      const scriptSource = readNodeExecutableTypeScriptSource(node);
      if (scriptSource) {
        return finish(extendLoweringContinuation(
          nextFlow,
          pushPolicyStep(ctx, "policy-code-script", {
            type: "code",
            rules: [],
            output_variable: directToolTarget
              ? buildToolParentContributionVariableName(node, directToolTarget)
              : undefined,
            output_object_field_names: directToolTarget
              ? getToolJoinOutputFieldNames(directToolTarget)
              : undefined,
            language: "typescript",
            script_source: scriptSource,
            on_match_step_id: ensuredNextFlow.stepId ?? undefined,
            on_error_step_id: pushPolicyStep(ctx, "policy-script-error", {
              type: "end",
              message: `This policy workflow hit a TypeScript code-node error: {${CANVAS_CODE_NODE_ERROR_PROMPT_VALUE_NAME}}`,
            }, [pathKey]),
          }, [pathKey]),
          [pathKey]
        ));
      }

      const ops = resolveNodeExecutableStateCodeOps(node, ctx.stateSchema);
      if (ops) {
        return finish(extendLoweringContinuation(
          nextFlow,
          pushPolicyStep(ctx, "policy-code", {
            type: "code",
            rules: [{ when: { kind: "always" }, ops }],
            output_variable: directToolTarget
              ? buildToolParentContributionVariableName(node, directToolTarget)
              : undefined,
            output_object_field_names: directToolTarget
              ? getToolJoinOutputFieldNames(directToolTarget)
              : undefined,
            on_match_step_id: ensuredNextFlow.stepId ?? undefined,
          }, [pathKey]),
          [pathKey]
        ));
      }
    }
  }

  if (
    isPromptOrCodeNode(node) &&
    nodeHasPromptOutputFields(node) &&
    readNodeActionType(node) !== "display" &&
    readNodeActionType(node) !== "tool_call"
  ) {
    return finish(lowerFlexiblePolicyPromptNode(ctx, entry, node, nextFlow));
  }

  if (isDisplayNode(node)) {
    const directToolTarget = getDirectToolTarget(entry, node);
    const displayType = node.data.displayType === "video" ? "video" : "text";
    const inputVariable =
      typeof node.data.inputVariable === "string" && node.data.inputVariable.trim()
        ? node.data.inputVariable.trim()
        : CARRIED_OUTPUT_PROMPT_VALUE_NAME;
    const videoUrl =
      typeof node.data.videoUrl === "string" ? node.data.videoUrl.trim() : "";
    return finish(extendLoweringContinuation(
      nextFlow,
      pushPolicyStep(ctx, "policy-display", {
        type: "code",
        rules: [
          {
            when: { kind: "always" },
            action: {
              kind: "display",
              display_type: displayType,
              input_variable: inputVariable,
              ...(displayType === "video" && videoUrl
                ? { video_url: videoUrl }
                : {}),
            },
          },
        ],
        output_variable: directToolTarget
          ? buildToolParentContributionVariableName(node, directToolTarget)
          : undefined,
        on_match_step_id: ensuredNextFlow.stepId ?? undefined,
      }, [pathKey]),
      [pathKey]
    ));
  }

  if (isPromptOrCodeNode(node) && readNodeActionType(node) === "prompt_transform") {
    const instruction = String(node.data.label ?? "").trim();
    if (!instruction) {
      const ensuredContinuation = ensurePolicyContinuationStep(ctx, nextFlow);
      return finish(
        extendLoweringContinuation(ensuredContinuation, ensuredContinuation.stepId, [
          pathKey,
        ])
      );
    }
    const directToolTarget = getDirectToolTarget(entry, node);
    if (directToolTarget) {
      return finish(extendLoweringContinuation(
        nextFlow,
        pushPolicyStep(ctx, "policy-prompt-tool-inputs", {
          type: "prompt_extract",
          prompt_extraction_plan: {
            context_prompt: buildPolicyNodeOnlyPrompt(ctx, entry, node.id),
            fields: [
              {
                name: buildToolParentContributionVariableName(node, directToolTarget),
                type: "json",
                instruction: buildToolContributionInstruction(directToolTarget, node),
              },
            ],
          },
          next_step_id: nextFlow.stepId ?? undefined,
        }, [pathKey]),
        [pathKey]
      ));
    }
    return finish(extendLoweringContinuation(
      nextFlow,
      pushPolicyStep(ctx, "policy-transform", {
        type: "prompt_transform",
        instruction,
        input_variable: readPromptTransformInputVariableName(node),
        output_variable: readPromptTransformOutputVariableName(node),
        next_step_id: ensuredNextFlow.stepId ?? undefined,
      }, [pathKey]),
      [pathKey]
    ));
  }

  const runtimeOperation = getPolicyRuntimeOperation(node);
  if (runtimeOperation) {
    const runtimeOperationMessage =
      runtimeOperation === "raise_error" &&
      typeof node.data?.label === "string" &&
      node.data.label.trim()
        ? node.data.label.trim()
        : undefined;
    const runtimeOperationExecutionMode =
      canRuntimeOperationQueueAsAsync(runtimeOperation) &&
      readCanvasAsyncExecutionMode(node.data) === "async"
        ? "async"
        : undefined;
    const explicitAsyncJobSourceVariable = isAsyncJobRuntimeOperation(runtimeOperation)
      ? readAsyncJobSourceVariable(node.data)
      : "";
    const asyncJobSourceVariable = isAsyncJobRuntimeOperation(runtimeOperation)
      ? explicitAsyncJobSourceVariable ||
        inferAsyncJobSourceVariableFromDirectInputs(entry, node) ||
        ""
      : "";
    const asyncJobResultVariable = isAsyncJobRuntimeOperation(runtimeOperation)
      ? readAsyncJobResultVariable(node.data)
      : runtimeOperationExecutionMode === "async"
        ? readAsyncJobResultVariable(
            node.data,
            getAsyncRuntimeOperationResultVariableFallback(runtimeOperation)
          )
        : "";
    return finish(extendLoweringContinuation(
      nextFlow,
      pushPolicyStep(ctx, "policy-runtime-operation", {
        type: "runtime_operation",
        operation: runtimeOperation,
        message: runtimeOperationMessage,
        execution_mode: runtimeOperationExecutionMode,
        job_source_variable: asyncJobSourceVariable || undefined,
        result_variable: asyncJobResultVariable || undefined,
        timeout_ms:
          runtimeOperation === "await_async_job"
            ? readAsyncJobTimeoutMs(node.data)
            : undefined,
        poll_interval_ms:
          runtimeOperation === "await_async_job"
            ? readAsyncJobPollIntervalMs(node.data)
            : undefined,
        next_step_id: ensuredNextFlow.stepId ?? undefined,
      }, [pathKey]),
      [pathKey]
    ));
  }

  return finish(lowerFlexiblePolicyPromptNode(ctx, entry, node, nextFlow));
}

function lowerStateCanvas(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  continuation: LoweringContinuation,
  path: Set<string>
): LoweringContinuation {
  const targets = getStartTargets(entry);
  if (targets.length === 0) {
    return ensureStateContinuationStep(ctx, continuation);
  }
  const selectedSegment = selectStateStartPromptSegment(ctx, entry);
  if (selectedSegment) {
    const segmentPath = buildSegmentPath(path, entry, selectedSegment.nodeIds);
    const boundaryFlow = lowerStateTargetsInOrder(
      ctx,
      entry,
      selectedSegment.boundaryTargetIds,
      continuation,
      segmentPath
    );
    recordPromptGroup(
      "state",
      entry,
      selectedSegment.rootNodeId,
      ctx.promptGroups,
      ctx.recordedPromptGroupKeys,
      selectedSegment.nodeIds
    );
    const stepId = pushStateStep(ctx, "state-prompt-subtree", {
      type:
        selectedSegment.outputFields.length > 0
          ? "prompt_extract"
          : "prompt_subtree_update",
      ...(selectedSegment.outputFields.length > 0
        ? {
            prompt_extraction_plan: {
              context_prompt: selectedSegment.prompt,
              fields: selectedSegment.outputFields,
            },
          }
        : {
            subtree_prompt: selectedSegment.prompt,
            ...statePromptPreserveFieldsData(selectedSegment.prompt),
          }),
      next_step_id: boundaryFlow.stepId ?? undefined,
    }, canvasNodeKeysForNodeIds(entry, selectedSegment.nodeIds));
    return extendLoweringContinuation(
      boundaryFlow,
      stepId,
      selectedSegment.nodeIds.map((nodeId) => buildCanvasNodeKey(entry.id, nodeId))
    );
  }
  return lowerStateTargetsInOrder(ctx, entry, targets, continuation, path);
}

function lowerStateNode(
  ctx: StateLowerContext,
  entry: CanvasEntry,
  nodeId: string,
  continuation: LoweringContinuation,
  path: Set<string>
): LoweringContinuation {
  const maps = buildGraphMaps(entry);
  const node = maps.byId.get(nodeId);
  if (!node) {
    return ensureStateContinuationStep(ctx, continuation);
  }

  const sharedNodeMemoKey = isJoinNode(entry, nodeId)
    ? buildSharedNodeMemoKey(entry, nodeId, continuation)
    : null;
  if (sharedNodeMemoKey) {
    const existing = ctx.sharedNodeMemo.get(sharedNodeMemoKey);
    if (existing) {
      return existing;
    }
  }
  const finish = (result: LoweringContinuation): LoweringContinuation => {
    if (sharedNodeMemoKey && result.stepId) {
      ctx.sharedNodeMemo.set(sharedNodeMemoKey, result);
    }
    return result;
  };

  const pathKey = buildCanvasNodeKey(entry.id, nodeId);
  if (path.has(pathKey)) {
    return finish(extendLoweringContinuation(
      continuation,
      pushStateStep(ctx, "state-error", {
        type: "end",
        message: buildUnsupportedStateShapeMessage({
          entry,
          node,
          reason: "the graph loops back on itself",
        }),
      }, [pathKey]),
      [pathKey]
    ));
  }
  const nextPath = new Set(path);
  nextPath.add(pathKey);

  if (node.type === "terminate") {
    return finish(
      extendLoweringContinuation(
        continuation,
        pushStateStep(
          ctx,
          "state-terminate",
          {
            type: "end",
            terminates_interaction: true,
          },
          [pathKey]
        ),
        [pathKey]
      )
    );
  }

  if (node.type === "yield" || isStageTerminalNode(node) || isStageContinueNode(node)) {
    return finish(extendLoweringContinuation(
      continuation,
      pushStateStep(ctx, "state-error", {
        type: "end",
        message: buildUnsupportedStateShapeMessage({
          entry,
          node,
          reason: "End Turn, Continue, and stage termination nodes are only valid in policy canvases",
        }),
      }, [pathKey]),
      [pathKey]
    ));
  }

  if (node.type === "condition") {
    const conditionIssue = getConditionLabelIssue(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    if (conditionIssue) {
      return finish(extendLoweringContinuation(
        continuation,
        pushStateStep(ctx, "state-error", {
          type: "end",
          message: buildUnsupportedStateShapeMessage({
            entry,
            node,
            reason: conditionIssue,
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }

    const condition = parseConditionLabel(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    const { trueTarget, falseTarget, hasUnexpectedEdges } = getConditionTargets(entry, node.id);
    if (hasUnexpectedEdges) {
      return finish(extendLoweringContinuation(
        continuation,
        pushStateStep(ctx, "state-error", {
          type: "end",
          message: buildUnsupportedStateShapeMessage({
            entry,
            node,
            reason: "its condition wiring is malformed",
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }
    if (!condition) {
      return finish(lowerStateConditionViaPrompt(
        ctx,
        entry,
        node,
        trueTarget,
        falseTarget,
        continuation,
        nextPath
      ));
    }

    const trueFlow = trueTarget
      ? lowerStateNode(ctx, entry, trueTarget, continuation, nextPath)
      : ensureStateContinuationStep(ctx, continuation);
    const falseFlow = falseTarget
      ? lowerStateNode(ctx, entry, falseTarget, continuation, nextPath)
      : ensureStateContinuationStep(ctx, continuation);
    const guaranteedCoverage = intersectCoveredNodeKeys(
      trueFlow.coveredNodeKeys,
      falseFlow.coveredNodeKeys
    );
    guaranteedCoverage.add(pathKey);

    return finish(extendLoweringContinuation(
      continuation,
      pushStateStep(ctx, "state-branch", {
        type: "code",
        rules: [{ when: condition, ops: [] }],
        on_match_step_id: trueFlow.stepId ?? pushStateStep(ctx, "state-end", { type: "end" }),
        on_no_match_step_id: falseFlow.stepId ?? pushStateStep(ctx, "state-end", { type: "end" }),
      }, [pathKey]),
      guaranteedCoverage
    ));
  }

  if (node.type === "for") {
    const { bodyTarget, doneTarget, hasUnexpectedEdges } = getLoopTargets(entry, node.id);
    if (hasUnexpectedEdges) {
      return finish(extendLoweringContinuation(
        continuation,
        pushStateStep(ctx, "state-error", {
          type: "end",
          message: buildUnsupportedStateShapeMessage({
            entry,
            node,
            reason: "its for-node wiring is malformed",
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }

    return finish(
      lowerStateForNode(
        ctx,
        entry,
        node,
        bodyTarget,
        doneTarget,
        continuation,
        nextPath
      )
    );
  }

  if (node.type === "while") {
    const conditionIssue = getConditionLabelIssue(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    if (conditionIssue) {
      return finish(extendLoweringContinuation(
        continuation,
        pushStateStep(ctx, "state-error", {
          type: "end",
          message: buildUnsupportedStateShapeMessage({
            entry,
            node,
            reason: conditionIssue,
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }

    const condition = parseConditionLabel(
      node.data.label ?? "",
      ctx.stateSchema,
      collectAvailablePromptValueNames(entry, node.id)
    );
    const { bodyTarget, doneTarget, hasUnexpectedEdges } = getLoopTargets(entry, node.id);
    if (!condition || hasUnexpectedEdges) {
      return finish(extendLoweringContinuation(
        continuation,
        pushStateStep(ctx, "state-error", {
          type: "end",
          message: buildUnsupportedStateShapeMessage({
            entry,
            node,
            reason: !condition
              ? "its while condition cannot be lowered structurally"
              : "its while-node wiring is malformed",
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }

    return finish(
      lowerStateWhileNode(
        ctx,
        entry,
        node,
        condition,
        bodyTarget,
        doneTarget,
        continuation,
        nextPath
      )
    );
  }

  if (node.type === "expand") {
    const targetCanvas = findCanvasByLabel(ctx.doc, node.data.label ?? "");
    if (!targetCanvas) {
      return finish(extendLoweringContinuation(
        continuation,
        pushStateStep(ctx, "state-error", {
          type: "end",
          message: buildUnsupportedStateShapeMessage({
            entry,
            node,
            reason: "it expands into a missing subcanvas",
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }

    const nextFlow = lowerStateTargetsInOrder(
      ctx,
      entry,
      getSequentialTargets(entry, node.id),
      continuation,
      nextPath
    );
    const expandedFlow = lowerStateCanvas(ctx, targetCanvas, nextFlow, nextPath);
    appendStateStepSourceNodeKeys(ctx, expandedFlow.stepId, [pathKey]);
    return finish(
      extendLoweringContinuation(expandedFlow, expandedFlow.stepId, [pathKey])
    );
  }

  if (isStatePromptSegmentEligibleNode(ctx, entry, node)) {
    const selectedSegment = selectStatePromptSegment(ctx, entry, node.id);
    if (selectedSegment) {
      const segmentPath = buildSegmentPath(path, entry, selectedSegment.nodeIds);
      const boundaryFlow = lowerStateTargetsInOrder(
        ctx,
        entry,
        selectedSegment.boundaryTargetIds,
        continuation,
        segmentPath
      );
      recordPromptGroup(
        "state",
        entry,
        selectedSegment.rootNodeId,
        ctx.promptGroups,
        ctx.recordedPromptGroupKeys,
        selectedSegment.nodeIds
      );
      const stepId =
        selectedSegment.outputFields.length > 0
            ? pushStateStep(ctx, "state-prompt-outputs", {
                type: "prompt_extract",
                prompt_extraction_plan: {
                  context_prompt: selectedSegment.prompt,
                  fields: selectedSegment.outputFields,
                },
                next_step_id: boundaryFlow.stepId ?? undefined,
              }, canvasNodeKeysForNodeIds(entry, selectedSegment.nodeIds))
            : pushStateStep(ctx, "state-prompt-subtree", {
                type: "prompt_subtree_update",
                subtree_prompt: selectedSegment.prompt,
                ...statePromptPreserveFieldsData(selectedSegment.prompt),
                next_step_id: boundaryFlow.stepId ?? undefined,
              }, canvasNodeKeysForNodeIds(entry, selectedSegment.nodeIds));
      return finish(
        extendLoweringContinuation(
          boundaryFlow,
          stepId,
          selectedSegment.nodeIds.map((segmentNodeId) =>
            buildCanvasNodeKey(entry.id, segmentNodeId)
          )
        )
      );
    }
  }

  if (isDisplayNode(node)) {
    return finish(extendLoweringContinuation(
      continuation,
      pushStateStep(ctx, "state-error", {
        type: "end",
        message: buildUnsupportedStateShapeMessage({
          entry,
          node,
          reason: "Display nodes are only valid in policy canvases",
        }),
      }, [pathKey]),
      [pathKey]
    ));
  }

  const toolCallTargets = isToolCallNode(node) ? getCallNodeTargets(entry, node.id) : null;
  const nextTargetIds = toolCallTargets?.successTargets ?? getSequentialTargets(entry, node.id);
  const nextFlow = lowerStateTargetsInOrder(
    ctx,
    entry,
    nextTargetIds,
    continuation,
    nextPath
  );
  const ensuredNextFlow = ensureStateContinuationStep(ctx, nextFlow);

  if (isToolCallNode(node)) {
    if (!nodeHasRunnableTool(node)) {
      return finish(extendLoweringContinuation(
        continuation,
        pushStateStep(ctx, "state-error", {
          type: "end",
          message: buildNonRunnableToolMessage(node),
        }, [pathKey]),
        [pathKey]
      ));
    }
    const errorFlow = toolCallTargets?.errorTarget
      ? lowerStateNode(ctx, entry, toolCallTargets.errorTarget, continuation, nextPath)
      : createLoweringContinuation(
          pushStateStep(ctx, "state-end", {
            type: "end",
            message: `This state workflow hit a tool-call error: {${CANVAS_TOOL_CALL_ERROR_PROMPT_VALUE_NAME}}`,
          }, [pathKey]),
          [pathKey]
        );
    return finish(extendLoweringContinuation(
      nextFlow,
      pushStateStep(ctx, "state-tool", {
        type: "tool_call",
        tool_name: inferToolFunctionName(node),
        result_variable: readToolResultVariableName(node),
        input_object_variables: getToolInputObjectVariables(entry, node),
        input_prompt_value_names: getToolInputPromptValueNames(entry, node),
        next_step_id: ensuredNextFlow.stepId ?? undefined,
        on_error_step_id: errorFlow.stepId ?? undefined,
      }, [pathKey]),
      [pathKey]
    ));
  }

  if (isPromptOrCodeNode(node) && readNodeActionType(node) === "prompt_transform") {
    const instruction = String(node.data.label ?? "").trim();
    if (!instruction) {
      const ensuredContinuation = ensureStateContinuationStep(ctx, nextFlow);
      return finish(
        extendLoweringContinuation(ensuredContinuation, ensuredContinuation.stepId, [
          pathKey,
        ])
      );
    }
    const directToolTarget = getDirectToolTarget(entry, node);
    if (directToolTarget) {
      return finish(extendLoweringContinuation(
        nextFlow,
        pushStateStep(ctx, "state-prompt-tool-inputs", {
          type: "prompt_extract",
          prompt_extraction_plan: {
            context_prompt: buildStateNodeOnlyPrompt(ctx, entry, node.id),
            fields: [
              {
                name: buildToolParentContributionVariableName(node, directToolTarget),
                type: "json",
                instruction: buildToolContributionInstruction(directToolTarget, node),
              },
            ],
          },
          next_step_id: nextFlow.stepId ?? undefined,
        }, [pathKey]),
        [pathKey]
      ));
    }
    return finish(extendLoweringContinuation(
      nextFlow,
      pushStateStep(ctx, "state-transform", {
        type: "prompt_transform",
        instruction,
        input_variable: readPromptTransformInputVariableName(node),
        output_variable: readPromptTransformOutputVariableName(node),
        next_step_id: ensuredNextFlow.stepId ?? undefined,
      }, [pathKey]),
      [pathKey]
    ));
  }

  if (isPromptOrCodeNode(node)) {
    if (getStateRuntimeOperation(node)) {
      return finish(extendLoweringContinuation(
        continuation,
        pushStateStep(ctx, "state-error", {
          type: "end",
          message: buildUnsupportedStateShapeMessage({
            entry,
            node,
            reason: "state canvases do not support policy runtime-operation nodes",
          }),
        }, [pathKey]),
        [pathKey]
      ));
    }
    const actionType = readNodeActionType(node);
    if (actionType === "prompt" || nodeHasPromptOutputFields(node)) {
      return finish(lowerFlexibleStatePromptNode(ctx, entry, node, nextFlow));
    }
    const directToolTarget = getDirectToolTarget(entry, node);
    const scriptSource = readNodeExecutableTypeScriptSource(node);
    if (scriptSource) {
      return finish(extendLoweringContinuation(
        nextFlow,
        pushStateStep(ctx, "state-code-script", {
          type: "code",
          rules: [],
          output_variable: directToolTarget
            ? buildToolParentContributionVariableName(node, directToolTarget)
            : undefined,
          output_object_field_names: directToolTarget
            ? getToolJoinOutputFieldNames(directToolTarget)
            : undefined,
          language: "typescript",
          script_source: scriptSource,
          on_match_step_id: ensuredNextFlow.stepId ?? undefined,
          on_error_step_id: pushStateStep(ctx, "state-end", {
            type: "end",
            message: `This state workflow hit a TypeScript code-node error: {${CANVAS_CODE_NODE_ERROR_PROMPT_VALUE_NAME}}`,
          }, [pathKey]),
        }, [pathKey]),
        [pathKey]
      ));
    }
    const ops = resolveNodeExecutableStateCodeOps(node, ctx.stateSchema);
    if (ops) {
      return finish(extendLoweringContinuation(
        nextFlow,
        pushStateStep(ctx, "state-code", {
          type: "code",
          rules: [{ when: { kind: "always" }, ops }],
          output_variable: directToolTarget
            ? buildToolParentContributionVariableName(node, directToolTarget)
            : undefined,
          output_object_field_names: directToolTarget
            ? getToolJoinOutputFieldNames(directToolTarget)
            : undefined,
          on_match_step_id: ensuredNextFlow.stepId ?? undefined,
        }, [pathKey]),
        [pathKey]
      ));
    }
  }

  return finish(lowerFlexibleStatePromptNode(ctx, entry, node, nextFlow));
}

function buildStructuralPolicyPlan(
  stateSchema: RuntimeStateField[],
  doc: CanvasDoc | null
): PolicyPhasePlan {
  const normalizedDoc = normalizeCanvasDoc(doc);
  if (!normalizedDoc || normalizedDoc.canvases.length === 0) {
    return { mode: "full_prompt", reason: "no policy canvas available" };
  }

  const rootCanvas = normalizedDoc.canvases[0] ?? null;
  if (!rootCanvas) {
    return { mode: "full_prompt", reason: "missing root policy canvas" };
  }

  const ctx: PolicyLowerContext = {
    doc: normalizedDoc,
    stateSchema,
    steps: [],
    nextId: 1,
    deterministicCanvasMemo: new Map(),
    sharedNodeMemo: new Map(),
    promptGroups: [],
    recordedPromptGroupKeys: new Set(),
  };
  const entryFlow = lowerPolicyCanvas(ctx, rootCanvas, createLoweringContinuation(null), new Set());
  const executionGraph: PolicyExecutionGraph = {
    entry_step_id: entryFlow.stepId ?? pushPolicyStep(ctx, "policy-end", { type: "end" }),
    max_steps: Math.min(Math.max(ctx.steps.length + 2, 4), 64),
    steps: ctx.steps,
  };

  return {
    mode: inferPolicyPromptMode(ctx.steps),
    reason: "structurally lowered from policy canvas with prompt subtrees only where direct execution is not exact",
    code_plan: { rules: [], execution_graph: executionGraph },
  };
}

function buildStructuralStatePlan(
  stateSchema: RuntimeStateField[],
  doc: CanvasDoc | null
): StatePhasePlan {
  const normalizedDoc = normalizeCanvasDoc(doc);
  if (!normalizedDoc || normalizedDoc.canvases.length === 0) {
    return { mode: "full_prompt", reason: "no state canvas available" };
  }

  const rootCanvas = normalizedDoc.canvases[0] ?? null;
  if (!rootCanvas) {
    return { mode: "full_prompt", reason: "missing root state canvas" };
  }

  const ctx: StateLowerContext = {
    doc: normalizedDoc,
    stateSchema,
    steps: [],
    nextId: 1,
    deterministicCanvasMemo: new Map(),
    sharedNodeMemo: new Map(),
    promptGroups: [],
    recordedPromptGroupKeys: new Set(),
  };
  const entryFlow = lowerStateCanvas(ctx, rootCanvas, createLoweringContinuation(null), new Set());
  const executionGraph: StateExecutionGraph = {
    entry_step_id: entryFlow.stepId ?? pushStateStep(ctx, "state-end", { type: "end" }),
    max_steps: Math.min(Math.max(ctx.steps.length + 2, 4), 64),
    steps: ctx.steps,
  };

  return {
    mode: inferStatePromptMode(ctx.steps),
    reason: "structurally lowered from state canvas with prompt subtrees only where direct execution is not exact",
    code_plan: { rules: [], execution_graph: executionGraph },
  };
}

export function buildStructuralExecutionPlan(args: StructuralPlanningArgs): HybridExecutionPlan {
  return {
    state: buildStructuralStatePlan(args.stateSchema, args.stateCanvasDoc),
    policy: buildStructuralPolicyPlan(args.stateSchema, args.policyCanvasDoc),
  };
}

export function collectStructuralPromptGroups(
  args: StructuralPlanningArgs
): StructuralPromptGroup[] {
  const groups: StructuralPromptGroup[] = [];

  const normalizedPolicyDoc = normalizeCanvasDoc(args.policyCanvasDoc);
  if (normalizedPolicyDoc && normalizedPolicyDoc.canvases.length > 0) {
    const rootCanvas = normalizedPolicyDoc.canvases[0] ?? null;
    if (rootCanvas) {
      const ctx: PolicyLowerContext = {
        doc: normalizedPolicyDoc,
        stateSchema: args.stateSchema,
        steps: [],
        nextId: 1,
        deterministicCanvasMemo: new Map(),
        sharedNodeMemo: new Map(),
        promptGroups: groups,
        recordedPromptGroupKeys: new Set(),
      };
      lowerPolicyCanvas(ctx, rootCanvas, createLoweringContinuation(null), new Set());
    }
  }

  const normalizedStateDoc = normalizeCanvasDoc(args.stateCanvasDoc);
  if (normalizedStateDoc && normalizedStateDoc.canvases.length > 0) {
    const rootCanvas = normalizedStateDoc.canvases[0] ?? null;
    if (rootCanvas) {
      const ctx: StateLowerContext = {
        doc: normalizedStateDoc,
        stateSchema: args.stateSchema,
        steps: [],
        nextId: 1,
        deterministicCanvasMemo: new Map(),
        sharedNodeMemo: new Map(),
        promptGroups: groups,
        recordedPromptGroupKeys: new Set(),
      };
      lowerStateCanvas(ctx, rootCanvas, createLoweringContinuation(null), new Set());
    }
  }

  return groups;
}
