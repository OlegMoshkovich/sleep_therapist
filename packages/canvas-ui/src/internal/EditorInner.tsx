"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  Background,
  Controls,
  ControlButton,
  ViewportPortal,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  MarkerType,
  type Edge,
  type NodeProps,
  type Connection,
  type OnConnect,
  type OnNodeDrag,
  type OnEdgesChange,
  type OnNodesChange,
  useNodes,
  useNodesInitialized,
  getSmoothStepPath,
  ConnectionLineType,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type {
  CanvasDoc,
  CanvasEdgeRecord,
  CanvasEntry,
  CanvasFireSignal,
  CanvasGraph,
  CanvasInspectorContext,
  CanvasNode,
  CanvasOnChange,
  CompilerFn,
  NodeKindDef,
} from "../types";
import {
  isCanvasNodeNonEditable,
  normalizeCanvasDoc,
} from "../types";
import { uid } from "./id";
import {
  describeEdgeDataFlow,
  describeNodeIo,
  type EdgeIoEndpoint,
  type NodeIoField,
} from "@airlab/canvas-compiler/node-io";
import { collectCanvasNodeWarnings } from "@airlab/canvas-rules/node-warnings";
import { readExplicitNodeExecutableStateCodeOps } from "@airlab/canvas-core/lib/canvas-node-code-ops";
import {
  readNodeCodeLocalOutputFields,
  readNodeExecutableCodeSource,
} from "@airlab/canvas-core/lib/canvas-node-code-script";
import {
  collectStructuralPromptGroups,
  parseStateActionLabel,
  type StructuralPromptGroup,
} from "@airlab/canvas-planner/canvas-structural-planner";
import type {
  RuntimeStateField,
  StateCodeOperation,
  StateValueSource,
} from "@airlab/canvas-planner/canvas-hybrid-runtime";
import {
  buildPromptGroupInspectorPreview,
  buildPromptNodeInspectorPreview,
  buildPromptTransformInspectorPreview,
} from "../prompt-group-preview";
import {
  getNodeActionSubtype,
  isPromptLikeNode,
} from "@airlab/canvas-core/components/canvas/action-subtype";

interface WorkingCanvas {
  id: string;
  name: string;
  nodes: CanvasNode[];
  edges: Edge[];
  freeText: string;
}

// ----- Runtime trace animation (CanvasFireSignal) ----------------------------

type FireEdgeState = "done" | "active";

function computeExactFirePath(
  nodes: CanvasNode[],
  activeCanvasId: string | undefined,
  exactNodeRefs: CanvasFireSignal["exactNodeRefs"] | undefined
): string[] | null {
  if (!exactNodeRefs || exactNodeRefs.length === 0) {
    return null;
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const path: string[] = [];
  let previousRefKey: string | null = null;
  for (const ref of exactNodeRefs) {
    if (
      ref.canvasId &&
      activeCanvasId &&
      ref.canvasId !== activeCanvasId
    ) {
      continue;
    }
    if (!nodeIds.has(ref.nodeId)) {
      continue;
    }
    const refKey = `${ref.canvasId ?? activeCanvasId ?? ""}:${ref.nodeId}`;
    if (refKey === previousRefKey) {
      continue;
    }
    previousRefKey = refKey;
    path.push(ref.nodeId);
  }

  return path.length > 0 ? path : null;
}

function pickExactFireCanvasId(
  canvases: WorkingCanvas[],
  exactNodeRefs: CanvasFireSignal["exactNodeRefs"] | undefined
): string | null {
  if (!exactNodeRefs || exactNodeRefs.length === 0) {
    return null;
  }

  const canvasIds = new Set(canvases.map((canvas) => canvas.id));
  for (const ref of exactNodeRefs) {
    if (ref.canvasId && canvasIds.has(ref.canvasId)) {
      return ref.canvasId;
    }
  }

  return null;
}

function findDirectFireEdgeIds(
  edges: Edge[],
  sourceNodeId: string,
  targetNodeId: string
): string[] {
  const direct = edges.find(
    (edge) => edge.source === sourceNodeId && edge.target === targetNodeId
  );
  return direct ? [direct.id] : [];
}

// Sample questions for the document-grounded RAG (Corpus B1) example. Shown in
// the inspector when that canvas is active so the demo is self-explanatory. The
// first group should retrieve from the seeded Larkfield/Halcyon corpus; the
// control should NOT (the relevance gate evaluates false). Seed the corpus with
// `npm run corpus:seed` — see scripts/corpus-samples/README.md.
const CORPUS_DEMO_QUESTIONS: { grounded: string[]; control: string } = {
  grounded: [
    "How long can the Halcyon M3 fly on one charge?",
    "How fast is a battery swap on the M3?",
    "How many PTO days do Larkfield employees get?",
    "What's the response target on the Aurora support tier?",
    "What happens when the M3 loses its control link?",
    "What's the per diem for field deployments outside the EU?",
  ],
  control: "What's the capital of France?",
};

// True when the active canvas contains the corpus retrieval tool — i.e. it is
// the RAG example, however it was loaded (tab switch or the "RAG example"
// button). Matches the { server: "corpus", tool: "search_documents" } binding.
function isCorpusCanvasNodes(nodes: CanvasNode[]): boolean {
  return nodes.some((n) => {
    const d = (n.data ?? {}) as { toolName?: string; ref?: { server?: string } };
    return d.ref?.server === "corpus" || d.toolName === "search_documents";
  });
}

function formatLoweredCodeValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
}

function formatLoweredCodeSource(source: StateValueSource): string {
  switch (source.kind) {
    case "constant":
      return formatLoweredCodeValue(source.value);
    case "prompt_variable":
      return `local ${source.name}`;
    case "current_build_snapshot":
      return "current_build";
    case "conversation_turns":
      return "conversation_turns";
    case "latest_user_turn":
      return "latest_user_turn";
    case "latest_assistant_turn":
      return "latest_assistant_turn";
    case "latest_observation_event":
      return "latest_observation_event";
    case "latest_observation_and_reward_event":
      return "latest_observation_and_reward_event";
    case "latest_primary_action_event":
      return "latest_primary_action_event";
    case "agent_latest_observation":
      return "agent_latest_observation";
    case "extract_age":
      return "extract_age(agent_latest_observation)";
    case "extract_gender":
      return "extract_gender(agent_latest_observation)";
    case "regex_capture":
      return `regex_capture(${JSON.stringify(source.pattern)})`;
    case "boolean_from_regex":
      return `boolean_from_regex(${JSON.stringify(source.pattern)})`;
    default:
      return "";
  }
}

function describeLoweredCodeOperation(op: StateCodeOperation): string {
  switch (op.kind) {
    case "set_field":
      return `${op.field} = ${formatLoweredCodeSource(op.source)}${
        op.only_if_empty ? " if empty" : ""
      }`;
    case "set_local":
      return `local ${op.name} = ${formatLoweredCodeSource(op.source)}${
        op.only_if_empty ? " if empty" : ""
      }`;
    case "clear_field":
      return `clear ${op.field}`;
    case "append_list_item":
      return `${op.field}.append(${
        op.source ? formatLoweredCodeSource(op.source) : formatLoweredCodeValue(op.value ?? null)
      })${op.unique ? " unique" : ""}`;
    default:
      return JSON.stringify(op);
  }
}

interface PromptGroupBound {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
  group: StructuralPromptGroup;
}

interface PromptGroupCollapsedEdge {
  id: string;
  source: { kind: "node"; id: string } | { kind: "group"; key: string };
  target: { kind: "node"; id: string } | { kind: "group"; key: string };
  rawEdgeIds: string[];
}

interface EditorInnerProps<TOutput> {
  nodeKinds: NodeKindDef[];
  compile: CompilerFn<TOutput>;
  doc: CanvasDoc | null;
  onChange: (next: CanvasOnChange<TOutput>) => void;
  seedDoc?: CanvasDoc;
  inspectorContext?: CanvasInspectorContext;
  /** Extra tabs appended to the inspector panel (e.g. a State schema editor). */
  inspectorExtraTabs?: { id: string; label: string; content: ReactNode }[];
  /**
   * When true, the canvas + inspector row is given a constant height that fills
   * from below the toolbars to the bottom of the viewport, rather than a fixed
   * inline height that varies with the inspector's content. Used inside the
   * full-screen-ish config overlay.
   */
  fillHeight?: boolean;
  /**
   * Optional decorative label. When set, a dashed frame is drawn around the
   * canvas surface with this text as a corner tag (e.g. "Moved into the
   * weights" for a trained agent version). Purely visual; non-interactive.
   */
  graphTag?: string;
  /**
   * When this changes, animate the exact runtime-reported canvas node refs.
   * Null/undefined disables it; signals without exact refs do not animate.
   */
  fireSignal?: CanvasFireSignal | null;
}

function isControlStructureKind(kind: Pick<NodeKindDef, "kind">): boolean {
  return kind.kind === "condition" || kind.kind === "for" || kind.kind === "while";
}

function fallbackNodeDimensions(node: CanvasNode): { width: number; height: number } {
  switch (node.type) {
    case "start":
      return { width: 156, height: 54 };
    case "condition":
    case "while":
      return { width: 210, height: 72 };
    case "for":
      return { width: 210, height: 84 };
    case "tool_call":
      return { width: 240, height: 84 };
    default:
      return { width: 240, height: 88 };
  }
}

function promptGroupKey(group: StructuralPromptGroup): string {
  return `${group.phase}:${group.canvasId}:${group.rootNodeId}:${[...group.nodeIds].sort().join(",")}`;
}

function pickPromptGroupOutputNode(
  group: StructuralPromptGroup,
  nodes: CanvasNode[],
  edges: Edge[]
): CanvasNode | null {
  const memberIds = new Set(group.nodeIds);
  const members = group.nodeIds
    .map((nodeId) => nodes.find((node) => node.id === nodeId) ?? null)
    .filter((node): node is CanvasNode => Boolean(node));
  if (members.length === 0) {
    return null;
  }

  const terminalMembers = members.filter(
    (node) => !edges.some((edge) => edge.source === node.id && memberIds.has(edge.target))
  );
  const candidates = terminalMembers.length > 0 ? terminalMembers : members;

  return [...candidates].sort((a, b) => {
    const yDelta = b.position.y - a.position.y;
    if (Math.abs(yDelta) > 4) return yDelta;
    return b.position.x - a.position.x;
  })[0] ?? null;
}

function pickPromptGroupInputNode(
  group: StructuralPromptGroup,
  nodes: CanvasNode[],
  edges: Edge[]
): CanvasNode | null {
  const memberIds = new Set(group.nodeIds);
  const members = group.nodeIds
    .map((nodeId) => nodes.find((node) => node.id === nodeId) ?? null)
    .filter((node): node is CanvasNode => Boolean(node));
  if (members.length === 0) {
    return null;
  }

  const rootMember = members.find((node) => node.id === group.rootNodeId);
  if (rootMember) {
    return rootMember;
  }

  const entryMembers = members.filter(
    (node) => !edges.some((edge) => edge.target === node.id && memberIds.has(edge.source))
  );
  const candidates = entryMembers.length > 0 ? entryMembers : members;

  return [...candidates].sort((a, b) => {
    const yDelta = a.position.y - b.position.y;
    if (Math.abs(yDelta) > 4) return yDelta;
    return a.position.x - b.position.x;
  })[0] ?? null;
}

function nodeCenter(
  node: CanvasNode,
  nodesInitialized: boolean
): { x: number; y: number } {
  const rect = nodeRect(node, nodesInitialized);
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function isNodeVisuallyBeforePromptGroupInput(
  node: CanvasNode,
  group: StructuralPromptGroup,
  nodes: CanvasNode[],
  edges: Edge[]
): boolean {
  const inputNode = pickPromptGroupInputNode(group, nodes, edges);
  if (!inputNode || inputNode.id === node.id) {
    return false;
  }

  const nodePoint = nodeCenter(node, true);
  const inputPoint = nodeCenter(inputNode, true);
  const verticalDelta = nodePoint.y - inputPoint.y;
  if (verticalDelta < -12) {
    return true;
  }
  if (Math.abs(verticalDelta) <= 12 && nodePoint.x < inputPoint.x - 12) {
    return true;
  }

  return false;
}

function prependNodeToPromptGroup(
  node: CanvasNode,
  group: StructuralPromptGroup,
  nodes: CanvasNode[],
  edges: Edge[]
): Edge[] {
  const inputNode = pickPromptGroupInputNode(group, nodes, edges);
  if (!inputNode || inputNode.id === node.id) {
    return edges;
  }

  const memberIds = new Set(group.nodeIds);
  const incomingBoundaryIdsToMove = new Set(
    edges
      .filter(
        (edge) =>
          edge.target === inputNode.id &&
          edge.source !== node.id &&
          !memberIds.has(edge.source)
      )
      .map((edge) => edge.id)
  );
  const nextEdges = edges.map((edge) =>
    incomingBoundaryIdsToMove.has(edge.id)
      ? {
          ...edge,
          target: node.id,
        }
      : edge
  );
  const alreadyConnected = nextEdges.some(
    (edge) =>
      edge.source === node.id &&
      edge.target === inputNode.id &&
      (edge.sourceHandle ?? null) === null
  );
  if (alreadyConnected) {
    return nextEdges;
  }

  const internalEdge = {
    id: uid("e"),
    source: node.id,
    target: inputNode.id,
    sourceHandle: null,
    markerEnd: markerEndForEdge(),
  } as Edge;

  return [...nextEdges, internalEdge];
}

function orderPromptGroupMemberNodes(
  group: StructuralPromptGroup,
  nodes: CanvasNode[],
  edges: Edge[]
): CanvasNode[] {
  const memberIds = new Set(group.nodeIds);
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const members = group.nodeIds
    .map((nodeId) => byId.get(nodeId) ?? null)
    .filter((candidate): candidate is CanvasNode => Boolean(candidate));
  if (members.length <= 1) {
    return members;
  }

  const inputNode = pickPromptGroupInputNode(group, nodes, edges);
  if (!inputNode) {
    return [...members].sort((left, right) => {
      const leftCenter = nodeCenter(left, true);
      const rightCenter = nodeCenter(right, true);
      const yDelta = leftCenter.y - rightCenter.y;
      if (Math.abs(yDelta) > 12) return yDelta;
      return leftCenter.x - rightCenter.x;
    });
  }

  const ordered: CanvasNode[] = [];
  const visited = new Set<string>();
  let current: CanvasNode | null = inputNode;
  while (current && !visited.has(current.id)) {
    ordered.push(current);
    visited.add(current.id);
    const nextEdge = edges
      .filter(
        (edge) =>
          edge.source === current?.id &&
          memberIds.has(edge.target) &&
          (edge.sourceHandle ?? null) === null &&
          !visited.has(edge.target)
      )
      .sort((left, right) => {
        const leftNode = byId.get(left.target);
        const rightNode = byId.get(right.target);
        if (!leftNode || !rightNode) {
          return left.target.localeCompare(right.target);
        }
        const leftCenter = nodeCenter(leftNode, true);
        const rightCenter = nodeCenter(rightNode, true);
        const yDelta = leftCenter.y - rightCenter.y;
        if (Math.abs(yDelta) > 12) return yDelta;
        return leftCenter.x - rightCenter.x;
      })[0];
    current = nextEdge ? byId.get(nextEdge.target) ?? null : null;
  }

  const remaining = members
    .filter((member) => !visited.has(member.id))
    .sort((left, right) => {
      const leftCenter = nodeCenter(left, true);
      const rightCenter = nodeCenter(right, true);
      const yDelta = leftCenter.y - rightCenter.y;
      if (Math.abs(yDelta) > 12) return yDelta;
      return leftCenter.x - rightCenter.x;
    });

  return [...ordered, ...remaining];
}

function fallbackPromptGroupStep(node: CanvasNode): { x: number; y: number } {
  const rect = nodeRect(node, true);
  return { x: 0, y: Math.max(112, rect.height + 36) };
}

function promptGroupSlotStep(orderedMembers: CanvasNode[]): { x: number; y: number } {
  if (orderedMembers.length >= 2) {
    const beforeLast = orderedMembers[orderedMembers.length - 2]!;
    const last = orderedMembers[orderedMembers.length - 1]!;
    const dx = last.position.x - beforeLast.position.x;
    const dy = last.position.y - beforeLast.position.y;
    if (Math.hypot(dx, dy) >= 24) {
      return { x: dx, y: dy };
    }
  }

  return fallbackPromptGroupStep(orderedMembers[orderedMembers.length - 1]!);
}

function layoutNodesForPromptGroupPrepend(
  node: CanvasNode,
  group: StructuralPromptGroup,
  nodes: CanvasNode[],
  edges: Edge[]
): CanvasNode[] {
  const orderedMembers = orderPromptGroupMemberNodes(group, nodes, edges).filter(
    (member) => member.id !== node.id
  );
  if (orderedMembers.length === 0) {
    return nodes;
  }

  const step = promptGroupSlotStep(orderedMembers);
  const placements = new Map<string, CanvasNode["position"]>();
  placements.set(node.id, { ...orderedMembers[0]!.position });
  orderedMembers.forEach((member, index) => {
    const nextSlot = orderedMembers[index + 1]?.position ?? {
      x: member.position.x + step.x,
      y: member.position.y + step.y,
    };
    placements.set(member.id, { ...nextSlot });
  });

  return nodes.map((candidate) => {
    const position = placements.get(candidate.id);
    return position ? { ...candidate, position } : candidate;
  }) as CanvasNode[];
}

function isPromptGroupEligibleDropNode(node: CanvasNode): boolean {
  if (!isPromptLikeNode(node) || isEditorNodeNonEditable(node)) {
    return false;
  }

  const actionType = getNodeActionSubtype(node);
  return (
    actionType === "default" ||
    actionType === "prompt" ||
    actionType === "prompt_transform"
  );
}

function findPromptGroupDropTarget(
  node: CanvasNode,
  groups: StructuralPromptGroup[],
  nodes: CanvasNode[],
  edges: Edge[]
): StructuralPromptGroup | null {
  const candidateGroups = groups.filter((group) => !group.nodeIds.includes(node.id));
  if (candidateGroups.length === 0) {
    return null;
  }

  const nodeById = new Map(nodes.map((entry) => [entry.id, entry]));
  const bounds = computePromptGroupBounds(candidateGroups, nodeById, true);
  if (bounds.length === 0) {
    return null;
  }

  const rect = nodeRect(node, true);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const containingBounds = bounds.filter(
    (bound) =>
      centerX >= bound.x &&
      centerX <= bound.x + bound.width &&
      centerY >= bound.y &&
      centerY <= bound.y + bound.height
  );
  if (containingBounds.length === 0) {
    return null;
  }

  containingBounds.sort((left, right) => {
    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    if (leftArea !== rightArea) return leftArea - rightArea;
    return promptGroupKey(left.group).localeCompare(promptGroupKey(right.group));
  });

  const dropTarget = containingBounds[0]?.group ?? null;
  if (!dropTarget) {
    return null;
  }

  const outputNode = pickPromptGroupOutputNode(dropTarget, nodes, edges);
  return outputNode && outputNode.id !== node.id ? dropTarget : null;
}

function computeNodeIdBounds(
  nodeIds: string[],
  nodeById: Map<string, CanvasNode>
): { x: number; y: number; width: number; height: number } | null {
  const members = nodeIds
    .map((nodeId) => nodeById.get(nodeId) ?? null)
    .filter((node): node is CanvasNode => Boolean(node));
  if (members.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const member of members) {
    const rect = nodeRect(member, true);
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }

  const horizontalPad = 28;
  const verticalPad = 24;
  return {
    x: minX - horizontalPad,
    y: minY - verticalPad,
    width: maxX - minX + horizontalPad * 2,
    height: maxY - minY + verticalPad * 2,
  };
}

function findPromptGroupLeaveTarget(
  node: CanvasNode,
  groups: StructuralPromptGroup[],
  nodes: CanvasNode[]
): StructuralPromptGroup | null {
  const containingGroups = groups.filter((group) => group.nodeIds.includes(node.id));
  if (containingGroups.length === 0) {
    return null;
  }

  const nodeById = new Map(nodes.map((entry) => [entry.id, entry]));
  const rect = nodeRect(node, true);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;

  for (const group of containingGroups) {
    const remainingNodeIds = group.nodeIds.filter((nodeId) => nodeId !== node.id);
    const bounds = computeNodeIdBounds(remainingNodeIds, nodeById);
    if (!bounds) {
      continue;
    }

    const insideRemainingGroup =
      centerX >= bounds.x &&
      centerX <= bounds.x + bounds.width &&
      centerY >= bounds.y &&
      centerY <= bounds.y + bounds.height;
    if (!insideRemainingGroup) {
      return group;
    }
  }

  return null;
}

function reconnectEdgesAroundPromptGroupMember(
  nodeId: string,
  group: StructuralPromptGroup,
  edges: Edge[]
): Edge[] {
  const memberIds = new Set(group.nodeIds);
  const incomingFromGroup = edges.filter(
    (edge) => edge.target === nodeId && memberIds.has(edge.source)
  );
  const outgoingToGroup = edges.filter(
    (edge) => edge.source === nodeId && memberIds.has(edge.target)
  );
  const outgoingBoundary = edges.filter(
    (edge) => edge.source === nodeId && !memberIds.has(edge.target)
  );
  const incomingBoundary = edges.filter(
    (edge) => edge.target === nodeId && !memberIds.has(edge.source)
  );
  const removedInternalIds = new Set(
    [...incomingFromGroup, ...outgoingToGroup].map((edge) => edge.id)
  );

  let nextEdges = edges.filter((edge) => !removedInternalIds.has(edge.id));

  if (incomingFromGroup.length > 0) {
    const source = incomingFromGroup[0]!.source;
    const outgoingBoundaryIds = new Set(outgoingBoundary.map((edge) => edge.id));
    nextEdges = nextEdges.map((edge) => {
      if (!outgoingBoundaryIds.has(edge.id)) {
        return edge;
      }
      return {
        ...edge,
        source,
        sourceHandle: null,
        markerEnd: markerEndForEdge(),
      } as Edge;
    });
  }

  if (outgoingToGroup.length > 0) {
    const target = outgoingToGroup[0]!.target;
    const incomingBoundaryIds = new Set(incomingBoundary.map((edge) => edge.id));
    nextEdges = nextEdges.map((edge) => {
      if (!incomingBoundaryIds.has(edge.id)) {
        return edge;
      }
      return {
        ...edge,
        target,
      };
    });
  }

  const syntheticEdges: Edge[] = [];
  for (const incoming of incomingFromGroup) {
    for (const outgoing of outgoingToGroup) {
      if (incoming.source === outgoing.target) {
        continue;
      }
      syntheticEdges.push({
        id: uid("e"),
        source: incoming.source,
        target: outgoing.target,
        sourceHandle: null,
        markerEnd: markerEndForEdge(),
      } as Edge);
    }
  }

  const existingKeys = new Set(
    nextEdges.map(
      (edge) =>
        `${edge.source}->${edge.target}:${edge.sourceHandle ?? ""}:${
          edge.targetHandle ?? ""
        }`
    )
  );
  const dedupedSynthetic = syntheticEdges.filter((edge) => {
    const key = `${edge.source}->${edge.target}:${edge.sourceHandle ?? ""}:${
      edge.targetHandle ?? ""
    }`;
    if (existingKeys.has(key)) {
      return false;
    }
    existingKeys.add(key);
    return true;
  });

  return [...nextEdges, ...dedupedSynthetic];
}

function movePromptGroupMemberToBeginning(
  node: CanvasNode,
  group: StructuralPromptGroup,
  nodes: CanvasNode[],
  edges: Edge[]
): { nodes: CanvasNode[]; edges: Edge[] } {
  const remainingNodeIds = group.nodeIds.filter((nodeId) => nodeId !== node.id);
  if (remainingNodeIds.length === 0) {
    return { nodes, edges };
  }

  const groupWithoutNode = {
    ...group,
    nodeIds: remainingNodeIds,
    rootNodeId:
      group.rootNodeId === node.id
        ? remainingNodeIds[0] ?? group.rootNodeId
        : group.rootNodeId,
  };
  const reconnectedEdges = reconnectEdgesAroundPromptGroupMember(
    node.id,
    group,
    edges
  );

  const nextNodes = layoutNodesForPromptGroupPrepend(
    node,
    groupWithoutNode,
    nodes,
    reconnectedEdges
  );

  return {
    nodes: nextNodes,
    edges: prependNodeToPromptGroup(
      node,
      groupWithoutNode,
      nextNodes,
      reconnectedEdges
    ),
  };
}

function nodeRect(
  node: CanvasNode,
  nodesInitialized: boolean
): { x: number; y: number; width: number; height: number } {
  const fallback = fallbackNodeDimensions(node);
  const width =
    node.measured?.width ??
    node.width ??
    (nodesInitialized ? fallback.width : fallback.width);
  const height =
    node.measured?.height ??
    node.height ??
    (nodesInitialized ? fallback.height : fallback.height);

  return {
    x: node.position.x,
    y: node.position.y,
    width,
    height,
  };
}

function computePromptGroupBounds(
  groups: StructuralPromptGroup[],
  nodeById: Map<string, CanvasNode>,
  nodesInitialized: boolean
): PromptGroupBound[] {
  return groups
    .map((group) => {
      const members = group.nodeIds
        .map((nodeId) => nodeById.get(nodeId))
        .filter((node): node is CanvasNode => Boolean(node));

      if (members.length <= 1) {
        return null;
      }

      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      for (const node of members) {
        const rect = nodeRect(node, nodesInitialized);
        minX = Math.min(minX, rect.x);
        minY = Math.min(minY, rect.y);
        maxX = Math.max(maxX, rect.x + rect.width);
        maxY = Math.max(maxY, rect.y + rect.height);
      }

      if (
        !Number.isFinite(minX) ||
        !Number.isFinite(minY) ||
        !Number.isFinite(maxX) ||
        !Number.isFinite(maxY)
      ) {
        return null;
      }

      let leftPad = 28;
      let rightPad = 28;
      let topPad = 24;
      let bottomPad = 24;
      const memberIds = new Set(group.nodeIds);
      const gapMargin = 8;

      const rangesOverlap = (
        startA: number,
        endA: number,
        startB: number,
        endB: number
      ) => startA < endB && endA > startB;

      for (const [nodeId, node] of nodeById.entries()) {
        if (memberIds.has(nodeId)) {
          continue;
        }

        const rect = nodeRect(node, nodesInitialized);
        const rectRight = rect.x + rect.width;
        const rectBottom = rect.y + rect.height;

        if (rangesOverlap(rect.y, rectBottom, minY, maxY)) {
          if (rectRight <= minX) {
            leftPad = Math.min(
              leftPad,
              Math.max(0, minX - rectRight - gapMargin)
            );
          }
          if (rect.x >= maxX) {
            rightPad = Math.min(
              rightPad,
              Math.max(0, rect.x - maxX - gapMargin)
            );
          }
        }

        if (rangesOverlap(rect.x, rectRight, minX, maxX)) {
          if (rectBottom <= minY) {
            topPad = Math.min(
              topPad,
              Math.max(0, minY - rectBottom - gapMargin)
            );
          }
          if (rect.y >= maxY) {
            bottomPad = Math.min(
              bottomPad,
              Math.max(0, rect.y - maxY - gapMargin)
            );
          }
        }
      }

      return {
        key: promptGroupKey(group),
        x: minX - leftPad,
        y: minY - topPad,
        width: maxX - minX + leftPad + rightPad,
        height: maxY - minY + topPad + bottomPad,
        count: members.length,
        group,
      };
    })
    .filter((bound): bound is PromptGroupBound => bound !== null);
}

function compareCanvasNodeRecordsByVisualOrder(
  left: Pick<CanvasNode, "id" | "position">,
  right: Pick<CanvasNode, "id" | "position">
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

function orderPromptGroupNodeIdsForCompiler(
  entry: CanvasEntry,
  group: StructuralPromptGroup
): string[] {
  const memberIds = new Set(group.nodeIds);
  const orderedNodeIds = entry.graph.nodes
    .filter((node) => memberIds.has(node.id))
    .sort(compareCanvasNodeRecordsByVisualOrder)
    .map((node) => node.id);

  if (!memberIds.has(group.rootNodeId)) {
    return orderedNodeIds;
  }

  return [
    group.rootNodeId,
    ...orderedNodeIds.filter((nodeId) => nodeId !== group.rootNodeId),
  ];
}

function promptGroupCompilerEdgeKey(edge: CanvasEdgeRecord): string {
  return [
    edge.source,
    edge.target,
    edge.sourceHandle ?? "",
    edge.label ?? "",
  ].join("\u0000");
}

function dedupeCompilerEdges(edges: CanvasEdgeRecord[]): CanvasEdgeRecord[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = promptGroupCompilerEdgeKey(edge);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeEntryPromptGroupsForCompiler(
  entry: CanvasEntry,
  groups: StructuralPromptGroup[]
): CanvasEntry {
  const entryGroups = groups.filter((group) => group.canvasId === entry.id);
  if (entryGroups.length === 0) {
    return entry;
  }

  let edges = entry.graph.edges.map((edge) => ({ ...edge }));
  const nodeById = new Map(entry.graph.nodes.map((node) => [node.id, node]));

  for (const group of entryGroups) {
    const orderedNodeIds = orderPromptGroupNodeIdsForCompiler(entry, group);
    if (orderedNodeIds.length <= 1) {
      continue;
    }

    const memberIds = new Set(orderedNodeIds);
    const orderedIndexById = new Map(
      orderedNodeIds.map((nodeId, index) => [nodeId, index] as const)
    );
    const firstNodeId = orderedNodeIds[0]!;
    const lastNodeId = orderedNodeIds[orderedNodeIds.length - 1]!;
    const nextEdges: CanvasEdgeRecord[] = [];
    const isControlFlowSource = (nodeId: string) => {
      const nodeType = nodeById.get(nodeId)?.type;
      return (
        nodeType === "condition" ||
        nodeType === "for" ||
        nodeType === "while" ||
        nodeType === "tool_call" ||
        nodeType === "call_agent"
      );
    };
    const isProtectedBranchEdge = (edge: CanvasEdgeRecord) =>
      memberIds.has(edge.source) &&
      memberIds.has(edge.target) &&
      isControlFlowSource(edge.source) &&
      (edge.sourceHandle === "true" ||
        edge.sourceHandle === "false" ||
        edge.sourceHandle === "body" ||
        edge.sourceHandle === "done" ||
        edge.sourceHandle === "success" ||
        edge.sourceHandle === "error");
    const protectedBranchEdges = edges.filter(isProtectedBranchEdge);
    const protectedBranchTargetIds = new Set(
      protectedBranchEdges.map((edge) => edge.target)
    );
    const branchTargetsBySource = new Map<string, string[]>();
    for (const edge of protectedBranchEdges) {
      const targets = branchTargetsBySource.get(edge.source) ?? [];
      targets.push(edge.target);
      branchTargetsBySource.set(edge.source, targets);
    }

    for (const edge of edges) {
      const sourceInGroup = memberIds.has(edge.source);
      const targetInGroup = memberIds.has(edge.target);

      if (sourceInGroup && targetInGroup) {
        if (isProtectedBranchEdge(edge)) {
          nextEdges.push(edge);
        }
        continue;
      }

      if (!sourceInGroup && targetInGroup) {
        nextEdges.push({ ...edge, target: firstNodeId });
        continue;
      }

      if (sourceInGroup && !targetInGroup) {
        nextEdges.push({
          ...edge,
          source: lastNodeId,
          sourceHandle: null,
        });
        continue;
      }

      nextEdges.push(edge);
    }

    for (let index = 0; index < orderedNodeIds.length - 1; index += 1) {
      const source = orderedNodeIds[index]!;
      const target = orderedNodeIds[index + 1]!;
      if (isControlFlowSource(source) || protectedBranchTargetIds.has(target)) {
        continue;
      }
      nextEdges.push({
        id: `compiler-prompt-group:${promptGroupKey(group)}:${index}`,
        source,
        target,
        sourceHandle: null,
      });
    }

    for (const [source, targets] of branchTargetsBySource) {
      const targetIndexes = targets
        .map((target) => orderedIndexById.get(target) ?? -1)
        .filter((index) => index >= 0);
      if (targetIndexes.length === 0) {
        continue;
      }

      const continuation = orderedNodeIds[Math.max(...targetIndexes) + 1];
      if (!continuation || protectedBranchTargetIds.has(continuation)) {
        continue;
      }

      for (const target of targets) {
        nextEdges.push({
          id: `compiler-prompt-group:${promptGroupKey(group)}:${source}:${target}:continuation`,
          source: target,
          target: continuation,
          sourceHandle: null,
        });
      }
    }

    edges = dedupeCompilerEdges(nextEdges);
  }

  return {
    ...entry,
    graph: {
      ...entry.graph,
      edges,
    },
  };
}

function collectPromptGroupsForCompiler(
  doc: CanvasDoc,
  inspectorContext: CanvasInspectorContext | undefined
): StructuralPromptGroup[] {
  const phase = inspectorContext?.executionPhase;
  if (!phase) {
    return [];
  }

  const stateSchema = (inspectorContext?.stateSchema ?? []).map((field) => ({
    fieldName: field.fieldName,
    type: field.type,
    initialValue: field.initialValue,
  }));

  const groups = collectStructuralPromptGroups({
    stateSchema,
    policyCanvasDoc: phase === "policy" ? doc : null,
    stateCanvasDoc: phase === "state" ? doc : null,
  }).filter((group) => group.phase === phase);

  return doc.canvases.flatMap((entry) =>
    filterRenderablePromptGroups(
      groups.filter((group) => group.canvasId === entry.id),
      entry.graph.edges as unknown as Edge[]
    )
  );
}

function normalizePromptGroupsForCompiler(
  doc: CanvasDoc,
  groups: StructuralPromptGroup[]
): CanvasDoc {
  if (groups.length === 0) {
    return doc;
  }

  return {
    ...doc,
    canvases: doc.canvases.map((entry) =>
      normalizeEntryPromptGroupsForCompiler(entry, groups)
    ),
  };
}

function buildPromptGroupCollapsedEdges(
  groups: StructuralPromptGroup[],
  edges: Edge[],
  nodes: CanvasNode[]
): { hiddenEdgeIds: Set<string>; collapsedEdges: PromptGroupCollapsedEdge[] } {
  if (groups.length === 0 || edges.length === 0) {
    return { hiddenEdgeIds: new Set(), collapsedEdges: [] };
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sortedGroups = [...groups].sort((a, b) => b.nodeIds.length - a.nodeIds.length);
  const nodeToGroupKey = new Map<string, string>();
  for (const group of sortedGroups) {
    const key = promptGroupKey(group);
    for (const nodeId of group.nodeIds) {
      if (!nodeToGroupKey.has(nodeId)) {
        nodeToGroupKey.set(nodeId, key);
      }
    }
  }

  const hiddenEdgeIds = new Set<string>();
  const collapsedByKey = new Map<string, PromptGroupCollapsedEdge>();

  for (const edge of edges) {
    const sourceNode = nodeById.get(edge.source);
    if (
      sourceNode &&
      (sourceNode.type === "condition" ||
        sourceNode.type === "for" ||
        sourceNode.type === "while")
    ) {
      continue;
    }

    const sourceGroupKey = nodeToGroupKey.get(edge.source) ?? null;
    const targetGroupKey = nodeToGroupKey.get(edge.target) ?? null;
    if (!sourceGroupKey && !targetGroupKey) {
      continue;
    }

    hiddenEdgeIds.add(edge.id);

    if (sourceGroupKey && targetGroupKey && sourceGroupKey === targetGroupKey) {
      continue;
    }

    const sourceEndpoint = sourceGroupKey
      ? ({ kind: "group", key: sourceGroupKey } as const)
      : ({ kind: "node", id: edge.source } as const);
    const targetEndpoint = targetGroupKey
      ? ({ kind: "group", key: targetGroupKey } as const)
      : ({ kind: "node", id: edge.target } as const);
    const collapsedKey = `${sourceEndpoint.kind === "group" ? `g:${sourceEndpoint.key}` : `n:${sourceEndpoint.id}`}->${targetEndpoint.kind === "group" ? `g:${targetEndpoint.key}` : `n:${targetEndpoint.id}`}`;
    const existing = collapsedByKey.get(collapsedKey);

    if (!existing) {
      collapsedByKey.set(collapsedKey, {
        id: collapsedKey,
        source: sourceEndpoint,
        target: targetEndpoint,
        rawEdgeIds: [edge.id],
      });
      continue;
    }

    collapsedByKey.set(collapsedKey, {
      ...existing,
      rawEdgeIds: [...existing.rawEdgeIds, edge.id],
    });
  }

  return {
    hiddenEdgeIds,
    collapsedEdges: Array.from(collapsedByKey.values()),
  };
}

function pruneNestedPromptGroups(
  groups: StructuralPromptGroup[]
): StructuralPromptGroup[] {
  if (groups.length <= 1) {
    return groups;
  }

  const sortedGroups = [...groups].sort((left, right) => {
    if (right.nodeIds.length !== left.nodeIds.length) {
      return right.nodeIds.length - left.nodeIds.length;
    }
    return promptGroupKey(left).localeCompare(promptGroupKey(right));
  });

  const keptKeys = new Set<string>();
  const keptNodeSets: Array<Set<string>> = [];

  for (const group of sortedGroups) {
    const nodeSet = new Set(group.nodeIds);
    const isNested = keptNodeSets.some((candidate) =>
      Array.from(nodeSet).every((nodeId) => candidate.has(nodeId))
    );
    if (isNested) {
      continue;
    }

    keptKeys.add(promptGroupKey(group));
    keptNodeSets.push(nodeSet);
  }

  return groups.filter((group) => keptKeys.has(promptGroupKey(group)));
}

function filterRenderablePromptGroups(
  groups: StructuralPromptGroup[],
  edges: Edge[]
): StructuralPromptGroup[] {
  if (groups.length === 0 || edges.length === 0) {
    return groups;
  }

  let nextGroups = pruneNestedPromptGroups(groups);

  while (true) {
    const invalidGroupKeys = new Set<string>();
    const sortedGroups = [...nextGroups].sort((a, b) => b.nodeIds.length - a.nodeIds.length);
    const groupByKey = new Map(
      sortedGroups.map((group) => [promptGroupKey(group), group] as const)
    );
    const nodeToGroupKey = new Map<string, string>();
    for (const group of sortedGroups) {
      const key = promptGroupKey(group);
      for (const nodeId of group.nodeIds) {
        if (!nodeToGroupKey.has(nodeId)) {
          nodeToGroupKey.set(nodeId, key);
        }
      }
    }

    for (const group of sortedGroups) {
      const key = promptGroupKey(group);
      const memberIds = new Set(group.nodeIds);
      const internalIncomingCount = new Map<string, number>();
      for (const nodeId of group.nodeIds) {
        internalIncomingCount.set(nodeId, 0);
      }

      for (const edge of edges) {
        if (memberIds.has(edge.source) && memberIds.has(edge.target)) {
          internalIncomingCount.set(
            edge.target,
            (internalIncomingCount.get(edge.target) ?? 0) + 1
          );
        }
      }

      const entryRootIds = new Set(
        group.nodeIds.filter((nodeId) => (internalIncomingCount.get(nodeId) ?? 0) === 0)
      );
      const externalEntrySources = new Set<string>();

      for (const edge of edges) {
        if (!memberIds.has(edge.target) || memberIds.has(edge.source)) {
          continue;
        }
        if (!entryRootIds.has(edge.target)) {
          invalidGroupKeys.add(key);
          break;
        }
        externalEntrySources.add(edge.source);
      }

      if (externalEntrySources.size > 1) {
        invalidGroupKeys.add(key);
      }
    }

    const directionsByPair = new Map<string, Set<"forward" | "reverse">>();
    for (const edge of edges) {
      const sourceGroupKey = nodeToGroupKey.get(edge.source) ?? null;
      const targetGroupKey = nodeToGroupKey.get(edge.target) ?? null;
      if (!sourceGroupKey && !targetGroupKey) {
        continue;
      }
      if (sourceGroupKey && invalidGroupKeys.has(sourceGroupKey)) {
        continue;
      }
      if (targetGroupKey && invalidGroupKeys.has(targetGroupKey)) {
        continue;
      }
      if (sourceGroupKey && targetGroupKey && sourceGroupKey === targetGroupKey) {
        continue;
      }

      const sourceEndpoint = sourceGroupKey ? `g:${sourceGroupKey}` : `n:${edge.source}`;
      const targetEndpoint = targetGroupKey ? `g:${targetGroupKey}` : `n:${edge.target}`;
      const pairKey =
        sourceEndpoint < targetEndpoint
          ? `${sourceEndpoint}::${targetEndpoint}`
          : `${targetEndpoint}::${sourceEndpoint}`;
      const direction = sourceEndpoint < targetEndpoint ? "forward" : "reverse";
      const directions = directionsByPair.get(pairKey) ?? new Set<"forward" | "reverse">();
      directions.add(direction);
      directionsByPair.set(pairKey, directions);
    }

    for (const [pairKey, directions] of directionsByPair.entries()) {
      if (directions.size < 2) {
        continue;
      }
      for (const endpoint of pairKey.split("::")) {
        if (!endpoint.startsWith("g:")) {
          continue;
        }
        const groupKey = endpoint.slice(2);
        if (groupByKey.has(groupKey)) {
          invalidGroupKeys.add(groupKey);
        }
      }
    }

    if (invalidGroupKeys.size === 0) {
      return nextGroups;
    }

    const filteredGroups = nextGroups.filter(
      (group) => !invalidGroupKeys.has(promptGroupKey(group))
    );
    if (filteredGroups.length === nextGroups.length) {
      return nextGroups;
    }
    nextGroups = filteredGroups;
  }
}

function anchorBetweenRects(
  sourceRect: { x: number; y: number; width: number; height: number },
  targetRect: { x: number; y: number; width: number; height: number }
) {
  const sourceCenterX = sourceRect.x + sourceRect.width / 2;
  const sourceCenterY = sourceRect.y + sourceRect.height / 2;
  const targetCenterX = targetRect.x + targetRect.width / 2;
  const targetCenterY = targetRect.y + targetRect.height / 2;
  const dx = targetCenterX - sourceCenterX;
  const dy = targetCenterY - sourceCenterY;

  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) {
      return {
        sourceX: sourceRect.x + sourceRect.width,
        sourceY: sourceCenterY,
        sourcePosition: Position.Right,
        targetX: targetRect.x,
        targetY: targetCenterY,
        targetPosition: Position.Left,
      };
    }

    return {
      sourceX: sourceRect.x,
      sourceY: sourceCenterY,
      sourcePosition: Position.Left,
      targetX: targetRect.x + targetRect.width,
      targetY: targetCenterY,
      targetPosition: Position.Right,
    };
  }

  if (dy >= 0) {
    return {
      sourceX: sourceCenterX,
      sourceY: sourceRect.y + sourceRect.height,
      sourcePosition: Position.Bottom,
      targetX: targetCenterX,
      targetY: targetRect.y,
      targetPosition: Position.Top,
    };
  }

  return {
    sourceX: sourceCenterX,
    sourceY: sourceRect.y,
    sourcePosition: Position.Top,
    targetX: targetCenterX,
    targetY: targetRect.y + targetRect.height,
    targetPosition: Position.Bottom,
  };
}

function PromptGroupOverlays({
  groups,
  collapsedEdges,
  selectedGroupKey,
  selectedCollapsedEdgeId,
  onSelectGroup,
  onSelectCollapsedEdge,
}: {
  groups: StructuralPromptGroup[];
  collapsedEdges: PromptGroupCollapsedEdge[];
  selectedGroupKey?: string | null;
  selectedCollapsedEdgeId: string | null;
  onSelectGroup?: (group: StructuralPromptGroup) => void;
  onSelectCollapsedEdge: (edgeId: string) => void;
}) {
  const flowNodes = useNodes<CanvasNode>();
  const nodesInitialized = useNodesInitialized();
  const nodeById = useMemo(
    () => new Map(flowNodes.map((node) => [node.id, node])),
    [flowNodes]
  );

  const bounds = useMemo(
    () => computePromptGroupBounds(groups, nodeById, nodesInitialized),
    [groups, nodeById, nodesInitialized]
  );
  const boundByKey = useMemo(
    () => new Map(bounds.map((bound) => [bound.key, bound])),
    [bounds]
  );
  const overlayPaths = useMemo(() => {
    return collapsedEdges
      .map((edge) => {
        const sourceRect =
          edge.source.kind === "group"
            ? boundByKey.get(edge.source.key)
            : (() => {
                const node = nodeById.get(edge.source.id);
                return node ? nodeRect(node, nodesInitialized) : null;
              })();
        const targetRect =
          edge.target.kind === "group"
            ? boundByKey.get(edge.target.key)
            : (() => {
                const node = nodeById.get(edge.target.id);
                return node ? nodeRect(node, nodesInitialized) : null;
              })();

        if (!sourceRect || !targetRect) {
          return null;
        }

        const anchors = anchorBetweenRects(sourceRect, targetRect);
        // borderRadius:0 → sharp orthogonal polyline (matches the edge style).
        const [path] = getSmoothStepPath({ ...anchors, borderRadius: 0 });
        return {
          id: edge.id,
          path,
        };
      })
      .filter((entry): entry is { id: string; path: string } => entry !== null);
  }, [boundByKey, collapsedEdges, nodeById, nodesInitialized]);

  if (bounds.length === 0) {
    return null;
  }

  return (
    <ViewportPortal>
      <svg
        width={1}
        height={1}
        style={{
          position: "absolute",
          inset: 0,
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
        <defs>
          <marker
            id="prompt-group-data-arrow"
            markerWidth="10"
            markerHeight="10"
            refX="9"
            refY="5"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b6b63" />
          </marker>
        </defs>
        {bounds.map((bound) => {
          const selected = selectedGroupKey === bound.key;
          return (
            <g key={bound.key}>
              <rect
                x={bound.x}
                y={bound.y}
                width={bound.width}
                height={bound.height}
                rx={8}
                fill={selected ? "rgba(194, 97, 31, 0.08)" : "rgba(255, 255, 255, 0.02)"}
                stroke={selected ? "#c2611f" : "#9a8f78"}
                strokeWidth={selected ? 2.2 : 1.5}
                strokeDasharray="8 6"
                style={{ pointerEvents: "all", cursor: "pointer" }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectGroup?.(bound.group);
                }}
              />
              <text
                x={bound.x + 12}
                y={bound.y + 16}
                fill={selected ? "#9a4c18" : "#6f6859"}
                fontSize={10}
                fontFamily="monospace"
                letterSpacing={1.2}
                style={{ pointerEvents: "none" }}
              >
                COMBINED PROMPT · {bound.count} NODES
              </text>
            </g>
          );
        })}
        {overlayPaths.map((edge) => (
          <g key={edge.id}>
            <path
              d={edge.path}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              style={{ pointerEvents: "stroke", cursor: "pointer" }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onSelectCollapsedEdge(edge.id);
              }}
            />
            <path
              d={edge.path}
              fill="none"
              stroke={selectedCollapsedEdgeId === edge.id ? "#2f2f2f" : "#6b6b63"}
              strokeWidth={selectedCollapsedEdgeId === edge.id ? 2.4 : 1.8}
              strokeOpacity={0.9}
              markerEnd="url(#prompt-group-data-arrow)"
            />
          </g>
        ))}
      </svg>
    </ViewportPortal>
  );
}

// ── Mapping between wire format and working state ──────────────────────────

function isEditorNodeNonEditable(node: CanvasNode | null | undefined): boolean {
  if (!node) {
    return false;
  }

  return isCanvasNodeNonEditable(node);
}

function getRuntimeManagedNodeInfo(node: CanvasNode | null | undefined): {
  title: string;
  templateId?: string;
  reason: string;
  writes?: string;
  placement?: string;
} | null {
  if (!node) {
    return null;
  }

  const reason =
    typeof node.data?.nonEditableReason === "string"
      ? node.data.nonEditableReason.trim()
      : "";
  return reason
    ? {
        title: "Runtime-managed node",
        reason,
      }
    : null;
}

function applyEditorNodeInteractivity(node: CanvasNode): CanvasNode {
  if (isEditorNodeNonEditable(node)) {
    if (
      node.draggable === false &&
      node.deletable === false &&
      node.connectable !== false
    ) {
      return node;
    }

    return {
      ...node,
      draggable: false,
      deletable: false,
    };
  }

  if (
    node.draggable === false ||
    node.deletable === false ||
    node.connectable === false
  ) {
    const nextNode = { ...node };
    delete nextNode.draggable;
    delete nextNode.deletable;
    delete nextNode.connectable;
    return nextNode;
  }

  return node;
}

function graphToWorking(entry: CanvasEntry): WorkingCanvas {
  return {
    id: entry.id,
    name: entry.name,
    freeText: entry.freeText ?? "",
    nodes: entry.graph.nodes.map((node) => {
      const workingNode = {
        ...node,
        data: { ...(node.data ?? {}), label: node.data?.label ?? "" },
      } as CanvasNode;

      return applyEditorNodeInteractivity(workingNode);
    }),
    edges: entry.graph.edges.map((e) => ({
      ...e,
      markerEnd: markerEndForEdge(),
    })) as Edge[],
  };
}

function workingToDoc(canvases: WorkingCanvas[], activeId: string): CanvasDoc {
  return {
    version: 2,
    activeId: activeId || canvases[0]?.id || "",
    canvases: canvases.map((c) => ({
      id: c.id,
      name: c.name,
      freeText: c.freeText ?? "",
      graph: {
        nodes: c.nodes.map((n) => ({
          id: n.id,
          type: n.type ?? "",
          position: n.position,
          data: { ...(n.data ?? {}), label: n.data?.label ?? "" },
        })),
        edges: c.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? null,
          targetHandle: e.targetHandle ?? null,
          label: typeof e.label === "string" ? e.label : undefined,
        })),
      },
    })),
  };
}

function compactEdgeForComparison(edge: Edge): CanvasEdgeRecord {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    label: typeof edge.label === "string" ? edge.label : undefined,
  };
}

function areNodeArraysGraphEquivalent(
  left: CanvasNode[],
  right: CanvasNode[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftNode = left[index];
    const rightNode = right[index];
    if (!leftNode || !rightNode) {
      return false;
    }
    if (
      leftNode.id !== rightNode.id ||
      leftNode.type !== rightNode.type ||
      leftNode.position.x !== rightNode.position.x ||
      leftNode.position.y !== rightNode.position.y ||
      JSON.stringify(leftNode.data ?? {}) !== JSON.stringify(rightNode.data ?? {})
    ) {
      return false;
    }
  }

  return true;
}

function areEdgeArraysGraphEquivalent(left: Edge[], right: Edge[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftEdge = left[index];
    const rightEdge = right[index];
    if (!leftEdge || !rightEdge) {
      return false;
    }
    if (
      JSON.stringify(compactEdgeForComparison(leftEdge)) !==
      JSON.stringify(compactEdgeForComparison(rightEdge))
    ) {
      return false;
    }
  }

  return true;
}

// ── Blank-graph builder ────────────────────────────────────────────────────

/**
 * For a fresh canvas, auto-insert one instance of each `singleton: true` kind
 * so callers don't have to seed a "Start" node manually.
 */
function makeBlankGraph(nodeKinds: NodeKindDef[]): CanvasGraph {
  const singletons = nodeKinds.filter((k) => k.singleton);
  return {
    nodes: singletons.map((k, idx) => ({
      id: k.kind,
      type: k.kind,
      position: { x: 40, y: 40 + idx * 100 },
      data: { label: k.defaultLabel, ...(k.defaultData ?? {}) },
    })),
    edges: [],
  };
}

function normalizeDoc(doc: CanvasDoc | null): CanvasDoc | null {
  const normalized = normalizeCanvasDoc(doc);
  if (!normalized || !Array.isArray(normalized.canvases) || normalized.canvases.length === 0) {
    return null;
  }
  return normalized;
}

function nodeHasEditablePromptOutputs(node: CanvasNode | null): boolean {
  if (!node || !isPromptLikeNode(node)) {
    return false;
  }

  const actionType = getNodeActionSubtype(node);

  return (
    actionType === "prompt" ||
    actionType === "default" ||
    actionType === "prompt_transform"
  );
}

function describeSelectedNodeKind(node: CanvasNode | null): string {
  if (!node) {
    return "";
  }

  const subtype = getNodeActionSubtype(node);
  if (node.type === "prompt" && subtype !== "prompt") {
    return `prompt / ${subtype}`;
  }
  return node.type;
}

function isWorkflowStageNode(node: CanvasNode | null): boolean {
  return node?.type === "stage";
}

function getInspectorIoLabels(node: CanvasNode | null) {
  if (isWorkflowStageNode(node)) {
    return {
      inputs: "Inputs (consumed materials)",
      outputs: "Outputs (produced materials)",
      noInputs: "No consumed materials detected for this stage.",
      noOutputs: "No produced materials detected for this stage.",
    };
  }

  return {
    inputs: "Inputs (consumed locals)",
    outputs: "Outputs (declared locals)",
    noInputs: "No consumed locals detected for this node.",
    noOutputs:
      "No declared locals yet. Add prompt output fields or a tool result variable to expose one.",
  };
}

function markerEndForEdge() {
  return { type: MarkerType.ArrowClosed };
}

const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true };

function renderIoFieldCards(fields: NodeIoField[]) {
  return (
    <div className="space-y-2 mt-2">
      {fields.map((field) => (
        <div
          key={`${field.name}:${field.type}:${field.origin ?? ""}`}
          className="border border-[#c0bdb0] rounded bg-[#e0dccc] px-2 py-1.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-mono text-gray-800 break-all">{field.name}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-widest text-gray-600 font-sans border border-[#c0bdb0] rounded bg-[#d6d3c4] px-1.5 py-0.5">
              {field.type}
            </span>
          </div>
          {field.origin && (
            <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
              {field.origin}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function makeInitialCanvases(args: {
  doc: CanvasDoc | null;
  seedDoc?: CanvasDoc;
  nodeKinds: NodeKindDef[];
}): { canvases: WorkingCanvas[]; activeId: string } {
  const source = normalizeDoc(args.doc) ?? normalizeDoc(args.seedDoc ?? null);
  if (source && source.canvases.length > 0) {
    const canvases = source.canvases.map((entry) => graphToWorking(entry));
    const activeId =
      canvases.find((c) => c.id === source.activeId)?.id ?? canvases[0].id;
    return { canvases, activeId };
  }
  const first: WorkingCanvas = {
    id: uid("canvas"),
    name: "Main",
    freeText: "",
    nodes: makeBlankGraph(args.nodeKinds).nodes as CanvasNode[],
    edges: [],
  };
  return { canvases: [first], activeId: first.id };
}

// ── Component ──────────────────────────────────────────────────────────────

export function EditorInner<TOutput>({
  nodeKinds,
  compile,
  doc: docProp,
  onChange,
  seedDoc,
  inspectorContext,
  inspectorExtraTabs,
  fillHeight,
  graphTag,
  fireSignal,
}: EditorInnerProps<TOutput>) {
  // Stable index of kinds keyed by `kind` for O(1) lookups.
  const kindByKey = useMemo(() => {
    const map = new Map<string, NodeKindDef>();
    for (const k of nodeKinds) map.set(k.kind, k);
    return map;
  }, [nodeKinds]);

  // React Flow nodeTypes is just the components keyed by kind.
  const nodeTypes = useMemo(() => {
    const out: Record<string, ComponentType<NodeProps<CanvasNode>>> = {};
    for (const k of nodeKinds) out[k.kind] = k.component;
    return out;
  }, [nodeKinds]);

  const initial = useMemo(
    () =>
      makeInitialCanvases({
        doc: docProp,
        seedDoc,
        nodeKinds,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [canvases, setCanvases] = useState<WorkingCanvas[]>(initial.canvases);
  const [activeId, setActiveId] = useState<string>(initial.activeId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPromptGroupKey, setSelectedPromptGroupKey] = useState<string | null>(null);
  const [selectedCollapsedEdgeId, setSelectedCollapsedEdgeId] = useState<string | null>(null);
  const [promptGroupConnectTargetId, setPromptGroupConnectTargetId] = useState<string>("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<string>("inspector");
  const [canvasFullscreen, setCanvasFullscreen] = useState(false);
  // The node + canvas-action toolbar is collapsible to reclaim space; starts
  // collapsed so the canvas gets the room (expand via the TOOLS header).
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [isControlStructureMenuOpen, setIsControlStructureMenuOpen] = useState(false);
  const [copiedQuestion, setCopiedQuestion] = useState<string | null>(null);
  const controlStructureMenuRef = useRef<HTMLDivElement | null>(null);
  // Only one surface (inline OR fullscreen) is mounted at a time.
  const canvasSurfaceRef = useRef<HTMLDivElement | null>(null);
  // The canvas + inspector row, and its measured fill height (see effect below).
  const canvasBodyRef = useRef<HTMLDivElement | null>(null);
  const [fillRowHeight, setFillRowHeight] = useState<number | null>(null);

  const active = canvases.find((c) => c.id === activeId) ?? canvases[0];

  // Bounding box (in flow coordinates) of the active canvas's nodes, padded.
  // Used to draw the decorative `graphTag` frame inside the viewport so it pans
  // and zooms together with the graph.
  const graphFrame = useMemo(() => {
    if (!graphTag || !active || active.nodes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of active.nodes as CanvasNode[]) {
      const r = nodeRect(n, true);
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.width);
      maxY = Math.max(maxY, r.y + r.height);
    }
    const pad = 56;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }, [graphTag, active]);

  // In fillHeight mode, give the canvas + inspector row a CONSTANT height that
  // spans from its top (just below the toolbars) to the bottom of the viewport,
  // minus the overlay's bottom gap. This is measured rather than derived from a
  // flex chain so the height never depends on the inspector tab's content — the
  // canvas stays the same size whether the inspector shows one line or a long
  // schema. Recomputed on viewport resize (the only thing that moves the row's
  // top, e.g. when the toolbar wraps).
  useEffect(() => {
    if (!fillHeight) {
      setFillRowHeight(null);
      return;
    }
    const el = canvasBodyRef.current;
    if (!el || typeof window === "undefined") return;
    let raf = 0;
    const BOTTOM_GAP = 36; // 16px overlay inset + 20px modal-body bottom padding
    const recompute = () => {
      const top = el.getBoundingClientRect().top;
      setFillRowHeight(Math.max(260, Math.round(window.innerHeight - top - BOTTOM_GAP)));
    };
    // Measure after layout settles so the toolbars have their final height.
    raf = requestAnimationFrame(recompute);
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    window.addEventListener("resize", onResize);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    ro?.observe(document.body);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [fillHeight]);

  // Let Escape exit the fullscreen canvas overlay.
  useEffect(() => {
    if (!canvasFullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setCanvasFullscreen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvasFullscreen]);

  useEffect(() => {
    if (!isControlStructureMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (
        controlStructureMenuRef.current &&
        target instanceof Node &&
        !controlStructureMenuRef.current.contains(target)
      ) {
        setIsControlStructureMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isControlStructureMenuOpen]);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const compileRef = useRef(compile);
  useEffect(() => {
    compileRef.current = compile;
  }, [compile]);

  // Remember the most recent emitted doc so external prop updates don't
  // clobber our in-flight edits.
  const lastEmittedDocRef = useRef<string>(JSON.stringify(docProp ?? null));
  const firstEmitRef = useRef(true);

  // Debounced propagation of the current doc + compiler output.
  useEffect(() => {
    if (firstEmitRef.current) {
      firstEmitRef.current = false;
      return;
    }
    const handle = setTimeout(() => {
      const nextDoc = workingToDoc(canvases, activeId);
      const nextDocString = JSON.stringify(nextDoc);
      if (nextDocString === lastEmittedDocRef.current) {
        return;
      }
      const compilerGroups = collectPromptGroupsForCompiler(nextDoc, inspectorContext);
      const compilerDoc = normalizePromptGroupsForCompiler(nextDoc, compilerGroups);
      const result = compileRef.current(compilerDoc);
      lastEmittedDocRef.current = nextDocString;
      onChangeRef.current({ doc: nextDoc, result });
    }, 150);
    return () => clearTimeout(handle);
  }, [canvases, activeId, inspectorContext]);

  // Re-hydrate when the parent sends a genuinely new doc.
  useEffect(() => {
    const incoming = normalizeDoc(docProp);
    if (!incoming) return;
    const incomingStr = JSON.stringify(incoming);
    if (incomingStr === lastEmittedDocRef.current) return;
    const rehydrated = incoming.canvases.map((entry) => graphToWorking(entry));
    lastEmittedDocRef.current = incomingStr;
    firstEmitRef.current = true;
    setCanvases(rehydrated);
    setActiveId(
      rehydrated.find((c) => c.id === incoming.activeId)?.id ?? rehydrated[0].id
    );
    setSelectedId(null);
    setSelectedPromptGroupKey(null);
    setSelectedCollapsedEdgeId(null);
  }, [docProp]);

  // ── Mutations scoped to the active canvas ────────────────────────────────

  const patchActive = useCallback(
    (updater: (c: WorkingCanvas) => WorkingCanvas) => {
      setCanvases((cs) => {
        let changed = false;
        const nextCanvases = cs.map((c) => {
          if (c.id !== activeId) {
            return c;
          }
          const nextCanvas = updater(c);
          if (nextCanvas !== c) {
            changed = true;
          }
          return nextCanvas;
        });

        return changed ? nextCanvases : cs;
      });
    },
    [activeId]
  );

  const handleNodesChange = useCallback<OnNodesChange<CanvasNode>>(
    (changes) => {
      patchActive((c) => {
        const writableChanges = changes.filter((change) => {
          if (change.type === "dimensions" || change.type === "select") {
            return false;
          }
          const id = "id" in change ? change.id : "";
          const node = c.nodes.find((candidate) => candidate.id === id);
          if (!isEditorNodeNonEditable(node)) {
            return true;
          }

          return change.type !== "remove" && change.type !== "position";
        });
        if (writableChanges.length === 0) {
          return c;
        }
        const nodes = applyNodeChanges(writableChanges, c.nodes) as CanvasNode[];
        if (areNodeArraysGraphEquivalent(c.nodes, nodes)) {
          return c;
        }
        return {
          ...c,
          nodes,
        };
      });
    },
    [patchActive]
  );

  const handleEdgesChange = useCallback<OnEdgesChange<Edge>>(
    (changes) => {
      patchActive((c) => {
        const writableChanges = changes.filter(
          (change) => change.type !== "select"
        );
        if (writableChanges.length === 0) {
          return c;
        }
        const edges = applyEdgeChanges(writableChanges, c.edges);
        if (areEdgeArraysGraphEquivalent(c.edges, edges)) {
          return c;
        }
        return {
          ...c,
          edges,
        };
      });
    },
    [patchActive]
  );

  const handleConnect = useCallback<OnConnect>(
    (connection: Connection) => {
      patchActive((c) => {
        const sourceNode = c.nodes.find((n) => n.id === connection.source);
        const kind = sourceNode ? kindByKey.get(sourceNode.type ?? "") : null;
        const handle = kind?.sourceHandles?.find(
          (h) => h.id === connection.sourceHandle
        );
        const nextEdge = {
          ...connection,
          id: uid("e"),
          label: handle?.label,
          markerEnd: markerEndForEdge(),
        } as Edge;
        return {
          ...c,
          edges: addEdge(nextEdge, c.edges),
        };
      });
    },
    [patchActive, kindByKey]
  );

  function addNode(kind: NodeKindDef) {
    const id = uid(kind.kind);
    if (
      kind.singleton &&
      (active?.nodes ?? []).some((n) => n.type === kind.kind)
    ) {
      return;
    }
    patchActive((c) => ({
      ...c,
      nodes: [
        ...c.nodes,
        {
          id,
          type: kind.kind,
          position: { x: 360, y: 80 + c.nodes.length * 24 },
          data: { label: kind.defaultLabel, ...(kind.defaultData ?? {}) },
        } as CanvasNode,
      ],
    }));
    setSelectedCollapsedEdgeId(null);
    setSelectedId(id);
    setIsControlStructureMenuOpen(false);
  }

  function deleteCollapsedEdge(edgeId: string | null): boolean {
    if (!edgeId) {
      return false;
    }

    const collapsedEdge =
      selectedCollapsedEdge?.edge.id === edgeId
        ? selectedCollapsedEdge.edge
        : promptGroupEdgePresentation.collapsedEdges.find((edge) => edge.id === edgeId) ?? null;
    if (!collapsedEdge) {
      return false;
    }

    const rawEdgeIds = new Set(collapsedEdge.rawEdgeIds);
    patchActive((c) => ({
      ...c,
      edges: c.edges.filter((edge) => !rawEdgeIds.has(edge.id)),
    }));
    setSelectedId(null);
    setSelectedPromptGroupKey(null);
    setSelectedCollapsedEdgeId(null);
    return true;
  }

  function deleteSelected() {
    if (deleteCollapsedEdge(selectedCollapsedEdgeId)) {
      return;
    }

    if (!selectedId) return;
    const selectedNodeForDelete =
      active?.nodes.find((node) => node.id === selectedId) ?? null;
    if (isEditorNodeNonEditable(selectedNodeForDelete)) return;
    patchActive((c) => ({
      ...c,
      edges: c.edges.filter(
        (e) => e.source !== selectedId && e.target !== selectedId && e.id !== selectedId
      ),
      nodes: c.nodes.filter((n) => n.id !== selectedId),
    }));
    setSelectedId(null);
    setSelectedPromptGroupKey(null);
    setSelectedCollapsedEdgeId(null);
  }

  function connectSelectedPromptGroupToTarget() {
    if (
      !selectedPromptGroup ||
      !selectedPromptGroupOutputNode ||
      !promptGroupConnectTargetId
    ) {
      return;
    }

    const memberIds = new Set(selectedPromptGroup.nodeIds);
    if (memberIds.has(promptGroupConnectTargetId)) {
      return;
    }

    const edgeId = uid("e");
    patchActive((c) => {
      const sourceExists = c.nodes.some((node) => node.id === selectedPromptGroupOutputNode.id);
      const targetExists = c.nodes.some((node) => node.id === promptGroupConnectTargetId);
      if (!sourceExists || !targetExists) {
        return c;
      }

      const alreadyExists = c.edges.some(
        (edge) =>
          edge.source === selectedPromptGroupOutputNode.id &&
          edge.target === promptGroupConnectTargetId
      );
      if (alreadyExists) {
        return c;
      }

      const nextEdge = {
        id: edgeId,
        source: selectedPromptGroupOutputNode.id,
        target: promptGroupConnectTargetId,
        sourceHandle: null,
        markerEnd: markerEndForEdge(),
      } as Edge;

      return {
        ...c,
        edges: addEdge(nextEdge, c.edges),
      };
    });
    setSelectedId(null);
    setSelectedCollapsedEdgeId(null);
    setSelectedPromptGroupKey(promptGroupKey(selectedPromptGroup));
  }

  // Load one of the seedDoc's example canvases into the active canvas. Index 0
  // is the default ("Load example"); higher indices back the named example
  // buttons (e.g. the RAG / Corpus example). Falls back to a blank graph for
  // hosts that didn't pass a seed.
  function loadSeedCanvas(index: number) {
    const seedCanvas = normalizeDoc(seedDoc ?? null)?.canvases[index];
    const fallback = makeBlankGraph(nodeKinds);
    const nextNodes = (seedCanvas?.graph.nodes ?? fallback.nodes).map((node) => {
      const workingNode = {
        ...node,
        data: { ...(node.data ?? {}), label: node.data?.label ?? "" },
      } as CanvasNode;

      return applyEditorNodeInteractivity(workingNode);
    });
    const nextEdges = (seedCanvas?.graph.edges ?? fallback.edges).map((e) => ({
      ...e,
      markerEnd: { type: MarkerType.ArrowClosed },
    })) as Edge[];
    patchActive((c) => ({
      ...c,
      nodes: nextNodes,
      edges: nextEdges,
    }));
    setSelectedId(null);
    setSelectedPromptGroupKey(null);
    setSelectedCollapsedEdgeId(null);
  }

  function resetActive() {
    loadSeedCanvas(0);
  }

  // ── Canvas (tab) management ──────────────────────────────────────────────

  function addCanvas() {
    const id = uid("canvas");
    const name = `Canvas ${canvases.length + 1}`;
    const blank = makeBlankGraph(nodeKinds);
    setCanvases((cs) => [
      ...cs,
      {
        id,
        name,
        freeText: "",
        nodes: blank.nodes as CanvasNode[],
        edges: [],
      },
    ]);
    setActiveId(id);
    setSelectedId(null);
    setSelectedPromptGroupKey(null);
    setSelectedCollapsedEdgeId(null);
    setRenamingId(id);
  }

  function removeCanvas(id: string) {
    setCanvases((cs) => {
      if (cs.length <= 1) return cs;
      const filtered = cs.filter((c) => c.id !== id);
      if (id === activeId) {
        setActiveId(filtered[0].id);
        setSelectedId(null);
        setSelectedPromptGroupKey(null);
        setSelectedCollapsedEdgeId(null);
      }
      return filtered;
    });
  }

  function renameCanvas(id: string, name: string) {
    setCanvases((cs) => cs.map((c) => (c.id === id ? { ...c, name } : c)));
  }

  function selectCanvas(id: string) {
    if (id === activeId) return;
    setActiveId(id);
    setSelectedId(null);
    setSelectedPromptGroupKey(null);
    setSelectedCollapsedEdgeId(null);
  }

  // ── Inspector helpers ────────────────────────────────────────────────────

  const isCorpusCanvas = useMemo(
    () => isCorpusCanvasNodes(active?.nodes ?? []),
    [active]
  );

  const liveDoc = useMemo(() => workingToDoc(canvases, activeId), [canvases, activeId]);
  const selectedNode = active?.nodes.find((n) => n.id === selectedId) ?? null;
  const selectedEdge = active?.edges.find((e) => e.id === selectedId) ?? null;
  const selectedNodeNonEditable = isEditorNodeNonEditable(selectedNode);
  const selectedRuntimeManagedNodeInfo = getRuntimeManagedNodeInfo(selectedNode);
  const selectedKind = selectedNode ? kindByKey.get(selectedNode.type ?? "") : null;
  const selectedNodeIoLabels = getInspectorIoLabels(selectedNode);
  const selectedNodeIo = useMemo(() => {
    if (!active || !selectedNode) {
      return null;
    }

    return describeNodeIo(active.nodes, active.edges, selectedNode, liveDoc);
  }, [active, liveDoc, selectedNode]);
  const hideOutputSummaryCards = nodeHasEditablePromptOutputs(selectedNode);

  function updateSelectedNodeLabel(label: string) {
    if (!selectedNode || selectedNodeNonEditable) return;
    patchActive((c) => ({
      ...c,
      nodes: c.nodes.map((n) =>
        n.id === selectedNode.id ? { ...n, data: { ...n.data, label } } : n
      ),
    }));
  }

  function updateSelectedNodeData(patch: Partial<CanvasNode["data"]>) {
    if (!selectedNode || selectedNodeNonEditable) return;
    patchActive((c) => ({
      ...c,
      nodes: c.nodes.map((n) =>
        n.id === selectedNode.id ? { ...n, data: { ...n.data, ...patch } } : n
      ),
    }));
  }

  function updateSelectedEdgeLabel(label: string) {
    if (!selectedEdge) return;
    patchActive((c) => ({
      ...c,
      edges: c.edges.map((e) => (e.id === selectedEdge.id ? { ...e, label } : e)),
    }));
  }

  function updateFreeText(text: string) {
    patchActive((c) => ({ ...c, freeText: text }));
  }

  const compilerPromptGroups = useMemo(
    () => collectPromptGroupsForCompiler(liveDoc, inspectorContext),
    [inspectorContext, liveDoc]
  );
  const compilerDoc = useMemo(
    () => normalizePromptGroupsForCompiler(liveDoc, compilerPromptGroups),
    [compilerPromptGroups, liveDoc]
  );

  // Live compiler preview, derived from current working state (not debounced).
  const preview = useMemo(() => {
    return compile(compilerDoc).preview ?? "";
  }, [compilerDoc, compile]);

  // Combined-prompt overlay disabled: the dashed group box rendered above the
  // nodes (pointerEvents: "all") and intercepted drags, so nodes inside a group
  // couldn't be moved. Emptying the visual groups removes the overlay, the
  // collapsed edges, and the edge-hiding, leaving every node individually
  // draggable. Compilation still groups prompts via `compilerPromptGroups`
  // (used by `compilerDoc` above), so the generated prompt is unaffected.
  const promptGroups = useMemo<typeof compilerPromptGroups>(() => [], []);
  const promptGroupEdgePresentation = useMemo(
    () =>
      active
        ? buildPromptGroupCollapsedEdges(promptGroups, active.edges, active.nodes)
        : { hiddenEdgeIds: new Set<string>(), collapsedEdges: [] },
    [active, promptGroups]
  );
  const visibleEdges = useMemo(
    () =>
      active
        ? active.edges.filter(
            (edge) => !promptGroupEdgePresentation.hiddenEdgeIds.has(edge.id)
          )
        : [],
    [active, promptGroupEdgePresentation]
  );

  // ----- Runtime trace animation --------------------------------------------
  // `fireStep` is the index of the currently-lit node along `firePath`; nodes
  // before it are "done", the one at it is "active" (pulsing). When the walk
  // finishes we set fireStep === firePath.length so every node reads as done
  // and nothing pulses. We read nodes through a ref so the driving effect
  // re-runs on a new turn signal or when an exact trace is shown on a different
  // canvas tab, not on unrelated canvas edits.
  const [firePath, setFirePath] = useState<string[]>([]);
  const [fireStep, setFireStep] = useState(-1);
  const [fireReal, setFireReal] = useState<Set<string>>(() => new Set());
  const fireNodesRef = useRef<CanvasNode[]>([]);
  const autoSelectedFireSignalIdRef = useRef<string | null>(null);
  fireNodesRef.current = active?.nodes ?? [];
  const fireGraphSignature = useMemo(() => {
    if (!active) {
      return "";
    }
    const nodeIds = active.nodes.map((node) => node.id).join("|");
    const edgeIds = active.edges
      .map((edge) => `${edge.id}:${edge.source}:${edge.target}`)
      .join("|");
    return `${active.id}:${nodeIds}:${edgeIds}`;
  }, [active]);

  useEffect(() => {
    if (!fireSignal?.id) {
      autoSelectedFireSignalIdRef.current = null;
      return;
    }
    if (autoSelectedFireSignalIdRef.current === fireSignal.id) {
      return;
    }

    const tracedCanvasId = pickExactFireCanvasId(
      canvases,
      fireSignal.exactNodeRefs
    );
    if (!tracedCanvasId) {
      return;
    }

    autoSelectedFireSignalIdRef.current = fireSignal.id;
    if (tracedCanvasId === activeId) {
      return;
    }

    setActiveId(tracedCanvasId);
    setSelectedId(null);
    setSelectedPromptGroupKey(null);
    setSelectedCollapsedEdgeId(null);
  }, [activeId, canvases, fireSignal?.exactNodeRefs, fireSignal?.id]);

  useEffect(() => {
    if (!fireSignal?.id) {
      setFirePath([]);
      setFireReal(new Set());
      setFireStep(-1);
      return;
    }
    const nodes = fireNodesRef.current;
    const path = computeExactFirePath(
      nodes,
      active?.id,
      fireSignal.exactNodeRefs
    );
    if (!path || path.length === 0) {
      setFirePath([]);
      setFireReal(new Set());
      setFireStep(-1);
      return;
    }
    setFirePath(path);
    setFireReal(new Set(path));
    setFireStep(0);
    let step = 0;
    const iv = setInterval(() => {
      step += 1;
      setFireStep(step >= path.length ? path.length : step);
      if (step >= path.length) clearInterval(iv);
    }, 700);
    return () => clearInterval(iv);
    // Re-run for new turns, canvas switches, or graph rehydration; refs keep
    // label/position edits from restarting the animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, fireGraphSignature, fireSignal?.id]);

  const fireNodeClass = useMemo(() => {
    const map = new Map<string, string>();
    if (firePath.length === 0 || fireStep < 0) return map;
    firePath.forEach((id, i) => {
      const classes: string[] = [];
      if (i < fireStep) classes.push("rf-fire-done");
      else if (i === fireStep) classes.push("rf-fire-active");
      if (fireReal.has(id)) classes.push("rf-fire-real");
      if (classes.length > 0) map.set(id, classes.join(" "));
    });
    return map;
  }, [firePath, fireStep, fireReal]);

  const fireEdgeStateById = useMemo(() => {
    const states = new Map<string, FireEdgeState>();
    if (firePath.length < 2 || fireStep < 0) return states;

    const lastSegmentIndex = firePath.length - 2;
    const activeSegmentIndex = Math.min(fireStep, lastSegmentIndex);
    const completedSegmentCount = Math.min(fireStep, firePath.length - 1);

    for (let i = 0; i <= activeSegmentIndex; i += 1) {
      const routeEdgeIds = findDirectFireEdgeIds(
        visibleEdges,
        firePath[i],
        firePath[i + 1]
      );
      const state: FireEdgeState =
        i < completedSegmentCount || fireStep >= firePath.length ? "done" : "active";
      for (const edgeId of routeEdgeIds) {
        states.set(edgeId, state);
      }
    }

    return states;
  }, [firePath, fireStep, visibleEdges]);

  const fireNodes = useMemo(() => {
    if (!active) return [];
    if (fireNodeClass.size === 0) return active.nodes;
    return active.nodes.map((node) => {
      const extra = fireNodeClass.get(node.id);
      return extra
        ? {
            ...node,
            className: [node.className, extra].filter(Boolean).join(" "),
            style: {
              ...(node.style ?? {}),
              boxShadow: extra.includes("rf-fire-active")
                ? "0 0 0 4px #0f766e, 0 0 22px rgba(15, 118, 110, 0.6)"
                : "0 0 0 3px rgba(194, 97, 31, 0.75)",
              borderRadius: 10,
            },
          }
        : node;
    });
  }, [active, fireNodeClass]);

  const fireEdges = useMemo<Edge[]>(() => {
    // Render every edge as a polyline (orthogonal "step") instead of a bezier
    // curve. ReactFlow controlled edges keep their own `type`, so set it here.
    return visibleEdges.map((edge) => {
      const fireState = fireEdgeStateById.get(edge.id);
      if (!fireState) {
        return { ...edge, type: "step" };
      }

      const color = fireState === "active" ? "#0f766e" : "#c2611f";
      return {
        ...edge,
        type: "step",
        animated: true,
        className: [edge.className, "rf-fire-edge"].filter(Boolean).join(" "),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: fireState === "active" ? 28 : 22,
          height: fireState === "active" ? 28 : 22,
        },
        style: {
          ...(edge.style ?? {}),
          stroke: color,
          strokeWidth: fireState === "active" ? 8 : 5,
          filter:
            fireState === "active"
              ? "drop-shadow(0 0 7px rgba(15, 118, 110, 0.55))"
              : "drop-shadow(0 0 4px rgba(194, 97, 31, 0.35))",
        },
        labelStyle: {
          ...(edge.labelStyle ?? {}),
          fill: color,
          fontWeight: 800,
        },
        zIndex: fireState === "active" ? 25 : 20,
      };
    });
  }, [visibleEdges, fireEdgeStateById]);

  const handleNodeDragStop = useCallback<OnNodeDrag<CanvasNode>>(
    (_event, node) => {
      if (!isPromptGroupEligibleDropNode(node)) {
        return;
      }

      patchActive((c) => {
        const nodes = c.nodes.map((candidate) =>
          candidate.id === node.id
            ? {
                ...candidate,
                position: node.position,
                measured: node.measured ?? candidate.measured,
                width: node.width ?? candidate.width,
                height: node.height ?? candidate.height,
              }
            : candidate
        ) as CanvasNode[];
        const droppedNode = nodes.find((candidate) => candidate.id === node.id) ?? null;
        if (!droppedNode) {
          return c;
        }

        const containingGroup = promptGroups.find((group) =>
          group.nodeIds.includes(droppedNode.id)
        );
        if (
          containingGroup &&
          isNodeVisuallyBeforePromptGroupInput(
            droppedNode,
            containingGroup,
            nodes,
            c.edges
          )
        ) {
          const reorderResult = movePromptGroupMemberToBeginning(
            droppedNode,
            containingGroup,
            nodes,
            c.edges
          );
          return {
            ...c,
            nodes: reorderResult.nodes,
            edges: reorderResult.edges,
          };
        }

        const leaveTargetGroup = findPromptGroupLeaveTarget(
          droppedNode,
          promptGroups,
          nodes
        );
        if (leaveTargetGroup) {
          return {
            ...c,
            nodes,
            edges: reconnectEdgesAroundPromptGroupMember(
              droppedNode.id,
              leaveTargetGroup,
              c.edges
            ),
          };
        }

        const targetGroup = findPromptGroupDropTarget(
          droppedNode,
          promptGroups,
          nodes,
          c.edges
        );
        if (!targetGroup) {
          return { ...c, nodes };
        }

        const outputNode = pickPromptGroupOutputNode(targetGroup, nodes, c.edges);
        if (!outputNode || outputNode.id === droppedNode.id) {
          return { ...c, nodes };
        }

        if (
          isNodeVisuallyBeforePromptGroupInput(
            droppedNode,
            targetGroup,
            nodes,
            c.edges
          )
        ) {
          const nextNodes = layoutNodesForPromptGroupPrepend(
            droppedNode,
            targetGroup,
            nodes,
            c.edges
          );
          return {
            ...c,
            nodes: nextNodes,
            edges: prependNodeToPromptGroup(
              droppedNode,
              targetGroup,
              nextNodes,
              c.edges
            ),
          };
        }

        const memberIds = new Set(targetGroup.nodeIds);
        const boundaryEdgeIdsToMove = new Set(
          c.edges
            .filter(
              (edge) =>
                edge.source === outputNode.id &&
                edge.target !== droppedNode.id &&
                !memberIds.has(edge.target)
            )
            .map((edge) => edge.id)
        );

        const internalEdge = {
          id: uid("e"),
          source: outputNode.id,
          target: droppedNode.id,
          sourceHandle: null,
          markerEnd: markerEndForEdge(),
        } as Edge;

        const nextEdges = [
          ...c.edges
            .filter((edge) => !(edge.source === outputNode.id && edge.target === droppedNode.id))
            .map((edge) => {
              if (!boundaryEdgeIdsToMove.has(edge.id)) {
                return edge;
              }
              return {
                ...edge,
                source: droppedNode.id,
                sourceHandle: null,
                markerEnd: markerEndForEdge(),
              } as Edge;
            }),
          internalEdge,
        ];

        return {
          ...c,
          nodes,
          edges: nextEdges,
        };
      });
      setSelectedId(node.id);
      setSelectedPromptGroupKey(null);
      setSelectedCollapsedEdgeId(null);
    },
    [patchActive, promptGroups]
  );
  const selectedPromptGroup = useMemo(
    () =>
      selectedPromptGroupKey
        ? promptGroups.find((group) => promptGroupKey(group) === selectedPromptGroupKey) ?? null
        : null,
    [promptGroups, selectedPromptGroupKey]
  );
  const selectedPromptGroupOutputNode = useMemo(
    () =>
      active && selectedPromptGroup
        ? pickPromptGroupOutputNode(selectedPromptGroup, active.nodes, active.edges)
        : null,
    [active, selectedPromptGroup]
  );
  const promptGroupConnectTargets = useMemo(() => {
    if (!active || !selectedPromptGroup) {
      return [];
    }

    const memberIds = new Set(selectedPromptGroup.nodeIds);
    return active.nodes.filter(
      (node) =>
        !memberIds.has(node.id) &&
        node.id !== selectedPromptGroupOutputNode?.id &&
        node.type !== "start"
    );
  }, [active, selectedPromptGroup, selectedPromptGroupOutputNode]);
  useEffect(() => {
    if (!selectedPromptGroup) {
      if (promptGroupConnectTargetId) {
        setPromptGroupConnectTargetId("");
      }
      return;
    }

    if (
      promptGroupConnectTargetId &&
      promptGroupConnectTargets.some((node) => node.id === promptGroupConnectTargetId)
    ) {
      return;
    }

    setPromptGroupConnectTargetId(promptGroupConnectTargets[0]?.id ?? "");
  }, [promptGroupConnectTargetId, promptGroupConnectTargets, selectedPromptGroup]);
  const promptGroupByKey = useMemo(
    () => new Map(promptGroups.map((group) => [promptGroupKey(group), group])),
    [promptGroups]
  );
  const activeEntryRecord = useMemo(() => {
    if (!active) {
      return null;
    }

    return {
      id: active.id,
      name: active.name,
      freeText: active.freeText,
      graph: {
        nodes: active.nodes.map((node) => ({
          id: node.id,
          type: node.type ?? "",
          position: node.position,
          data: { ...(node.data ?? {}), label: node.data?.label ?? "" },
        })),
        edges: active.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? null,
          targetHandle: edge.targetHandle ?? null,
          label: typeof edge.label === "string" ? edge.label : undefined,
        })),
      },
    };
  }, [active]);
  const selectedPromptGroupPreview = useMemo(() => {
    if (!activeEntryRecord || !selectedPromptGroup) {
      return null;
    }

    return buildPromptGroupInspectorPreview({
      group: selectedPromptGroup,
      entry: activeEntryRecord,
      inspectorContext: inspectorContext ?? {},
      promptContextDoc: liveDoc,
    });
  }, [activeEntryRecord, inspectorContext, liveDoc, selectedPromptGroup]);
  const selectedPromptTransformPreview = useMemo(() => {
    if (
      !activeEntryRecord ||
      !selectedNode ||
      getNodeActionSubtype(selectedNode) !== "prompt_transform"
    ) {
      return null;
    }

    return buildPromptTransformInspectorPreview({
      node: {
        id: selectedNode.id,
        type: selectedNode.type ?? "",
        position: selectedNode.position,
        data: { ...(selectedNode.data ?? {}), label: selectedNode.data?.label ?? "" },
      },
      entry: activeEntryRecord,
      inspectorContext: inspectorContext ?? {},
      promptContextDoc: liveDoc,
    });
  }, [activeEntryRecord, inspectorContext, liveDoc, selectedNode]);
  const selectedPromptNodePreview = useMemo(() => {
    if (!activeEntryRecord || !selectedNode) {
      return null;
    }

    const phase = inspectorContext?.executionPhase;
    if (!phase) {
      return null;
    }

    const belongsToCombinedPrompt = promptGroups.some(
      (group) =>
        group.phase === phase &&
        group.canvasId === activeEntryRecord.id &&
        group.nodeIds.length > 1 &&
        group.nodeIds.includes(selectedNode.id)
    );
    if (belongsToCombinedPrompt) {
      return null;
    }

    return buildPromptNodeInspectorPreview({
      node: {
        id: selectedNode.id,
        type: selectedNode.type ?? "",
        position: selectedNode.position,
        data: { ...(selectedNode.data ?? {}), label: selectedNode.data?.label ?? "" },
      },
      entry: activeEntryRecord,
      inspectorContext: inspectorContext ?? {},
      promptContextDoc: liveDoc,
    });
  }, [activeEntryRecord, inspectorContext, liveDoc, promptGroups, selectedNode]);
  const selectedLoweredCodePreview = useMemo(() => {
    if (
      !selectedNode ||
      getNodeActionSubtype(selectedNode) !== "code"
    ) {
      return null;
    }

    const stateSchema: RuntimeStateField[] = (
      inspectorContext?.stateSchema ?? []
    ).map((field) => ({
      fieldName: field.fieldName,
      type: field.type,
      initialValue: field.initialValue,
    }));
    const ops =
      readExplicitNodeExecutableStateCodeOps(selectedNode, stateSchema) ??
      parseStateActionLabel(String(selectedNode.data?.label ?? ""), stateSchema);
    const scriptSource = readNodeExecutableCodeSource(selectedNode);
    const declaredLocalOutputs = readNodeCodeLocalOutputFields(selectedNode);
    const phase = inspectorContext?.executionPhase ?? "state";

    return {
      phase,
      ops,
      scriptSource,
      declaredLocalOutputs,
      lines: ops ? ops.map(describeLoweredCodeOperation) : [],
      stepJson: scriptSource
        ? JSON.stringify(
            {
              type: "code",
              language: "typescript",
              script_source: "(full TypeScript source shown above)",
              declared_local_outputs: declaredLocalOutputs,
            },
            null,
            2
          )
        : ops
        ? JSON.stringify(
            {
              type: "code",
              rules: [{ when: { kind: "always" }, ops }],
            },
            null,
            2
          )
        : null,
    };
  }, [inspectorContext, selectedNode]);
  const collapsedEdgeDetails = useMemo(() => {
    if (!active) {
      return [];
    }

    return promptGroupEdgePresentation.collapsedEdges
      .map((edge) => {
        const source: EdgeIoEndpoint | null =
          edge.source.kind === "group"
            ? (() => {
                const group = promptGroupByKey.get(edge.source.key);
                return group
                  ? {
                      kind: "prompt_group" as const,
                      phase: group.phase,
                      nodeIds: group.nodeIds,
                    }
                  : null;
              })()
            : { kind: "node" as const, nodeId: edge.source.id };
        const target: EdgeIoEndpoint | null =
          edge.target.kind === "group"
            ? (() => {
                const group = promptGroupByKey.get(edge.target.key);
                return group
                  ? {
                      kind: "prompt_group" as const,
                      phase: group.phase,
                      nodeIds: group.nodeIds,
                    }
                  : null;
              })()
            : { kind: "node" as const, nodeId: edge.target.id };

        if (!source || !target) {
          return null;
        }

        const dataFlow = describeEdgeDataFlow({
          nodes: active.nodes,
          source,
          target,
          doc: liveDoc,
        });

        return {
          edge,
          source,
          target,
          dataFlow,
        };
      })
      .filter(
        (
          detail
        ): detail is {
          edge: PromptGroupCollapsedEdge;
          source: EdgeIoEndpoint;
          target: EdgeIoEndpoint;
          dataFlow: NodeIoField[];
        } => detail !== null
      );
  }, [active, liveDoc, promptGroupByKey, promptGroupEdgePresentation.collapsedEdges]);
  const selectedCollapsedEdge = useMemo(
    () =>
      selectedCollapsedEdgeId
        ? collapsedEdgeDetails.find((detail) => detail.edge.id === selectedCollapsedEdgeId) ?? null
        : null,
    [collapsedEdgeDetails, selectedCollapsedEdgeId]
  );
  const deleteSelectedRef = useRef(deleteSelected);
  deleteSelectedRef.current = deleteSelected;

  useEffect(() => {
    if (!selectedId && !selectedCollapsedEdgeId) {
      return;
    }

    function handleDeleteKey(event: KeyboardEvent) {
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }

      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName.toLowerCase();
        if (
          target.isContentEditable ||
          tag === "input" ||
          tag === "textarea" ||
          tag === "select"
        ) {
          return;
        }
      }

      event.preventDefault();
      deleteSelectedRef.current();
    }

    window.addEventListener("keydown", handleDeleteKey);
    return () => window.removeEventListener("keydown", handleDeleteKey);
  }, [selectedId, selectedCollapsedEdgeId]);

  const selectedEdgeDataFlow = useMemo(() => {
    if (!active || !selectedEdge) {
      return [];
    }

    return describeEdgeDataFlow({
      nodes: active.nodes,
      source: { kind: "node", nodeId: selectedEdge.source },
      target: { kind: "node", nodeId: selectedEdge.target },
      doc: liveDoc,
    });
  }, [active, liveDoc, selectedEdge]);
  const nodeWarnings = useMemo(
    () =>
      active && inspectorContext?.stateSchema
        ? collectCanvasNodeWarnings(
            active.nodes,
            active.edges,
            inspectorContext.stateSchema.map((field) => ({
              fieldName: field.fieldName,
              type: field.type,
              initialValue: field.initialValue,
            }))
          )
        : [],
    [active, inspectorContext]
  );
  const selectedNodeWarnings = useMemo(
    () =>
      selectedNode
        ? nodeWarnings.filter((warning) => warning.nodeId === selectedNode.id)
        : [],
    [nodeWarnings, selectedNode]
  );

  const toolbarKinds = nodeKinds.filter((k) => !k.hideFromToolbar);
  const controlStructureKinds = toolbarKinds.filter(isControlStructureKind);
  const directToolbarKinds = toolbarKinds.filter((k) => !isControlStructureKind(k));

  if (!active) {
    return (
      <div className="p-4 text-sm text-gray-600 font-serif">
        No canvases. <button onClick={addCanvas} className="underline">Create one</button>.
      </div>
    );
  }

  const inspector = selectedKind?.inspector ?? {};
  const resolveInspectorValue = <T,>(
    value: T | ((data: CanvasNode["data"]) => T) | undefined,
    fallback: T
  ): T => {
    if (typeof value === "function") {
      return (value as (data: CanvasNode["data"]) => T)(selectedNode?.data ?? { label: "" });
    }
    return value ?? fallback;
  };
  const labelTitle = resolveInspectorValue(inspector.labelTitle, "Label");
  const helpText = resolveInspectorValue(inspector.helpText, undefined);
  const textareaRows = resolveInspectorValue(inspector.textareaRows, 3);
  const showLabelField = resolveInspectorValue(inspector.showLabelField, true);
  const describeNodeLabelById = (nodeId: string) => {
    const node = active.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return nodeId;
    }
    const label =
      typeof node.data?.label === "string" ? node.data.label.trim() : "";
    return label || node.type || node.id;
  };
  const describeCollapsedEndpointLabel = (
    endpoint: PromptGroupCollapsedEdge["source"] | PromptGroupCollapsedEdge["target"]
  ) => {
    if (endpoint.kind === "group") {
      return "Combined prompt";
    }

    return describeNodeLabelById(endpoint.id);
  };

  const renderCanvasSurface = (fullscreen: boolean) => (
    <div
      ref={canvasSurfaceRef}
      className={
        fullscreen
          ? "rf-canvas-surface relative min-h-[32rem] flex-1 overflow-hidden rounded border border-[#c8c4b4] bg-[#f3f1e6]"
          : fillHeight
            ? "rf-canvas-surface relative block flex-1 min-h-[320px] overflow-hidden rounded border border-[#c8c4b4] bg-[#f3f1e6] lg:h-full"
            : "rf-canvas-surface relative hidden lg:block flex-1 min-h-[300px] h-[360px] overflow-hidden rounded border border-[#c8c4b4] bg-[#f3f1e6]"
      }
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen || undefined}
    >
      <ReactFlow
        key={`${active.id}-${fullscreen ? "full" : "inline"}`}
        nodes={fireNodes}
        edges={fireEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeDragStop={handleNodeDragStop}
        nodeTypes={nodeTypes}
        connectionLineType={ConnectionLineType.Step}
        fitView={fillHeight || fullscreen}
        fitViewOptions={{ padding: 0.2 }}
        proOptions={REACT_FLOW_PRO_OPTIONS}
        onNodeClick={(_, n) => {
          setSelectedCollapsedEdgeId(null);
          setSelectedPromptGroupKey(null);
          setSelectedId(n.id);
        }}
        onEdgeClick={(_, e) => {
          setSelectedCollapsedEdgeId(null);
          setSelectedPromptGroupKey(null);
          setSelectedId(e.id);
        }}
        onPaneClick={() => {
          setSelectedId(null);
          setSelectedPromptGroupKey(null);
          setSelectedCollapsedEdgeId(null);
        }}
      >
        <PromptGroupOverlays
          groups={promptGroups}
          collapsedEdges={collapsedEdgeDetails.map((detail) => detail.edge)}
          selectedGroupKey={selectedPromptGroupKey}
          selectedCollapsedEdgeId={selectedCollapsedEdgeId}
          onSelectGroup={(group) => {
            setSelectedId(null);
            setSelectedCollapsedEdgeId(null);
            setSelectedPromptGroupKey(promptGroupKey(group));
          }}
          onSelectCollapsedEdge={(edgeId) => {
            setSelectedId(null);
            setSelectedPromptGroupKey(null);
            setSelectedCollapsedEdgeId(edgeId);
          }}
        />
        <Background />
        <Controls showInteractive={false} position="top-right" orientation="vertical">
          <ControlButton
            onClick={() => setCanvasFullscreen((v) => !v)}
            title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
              </svg>
            )}
          </ControlButton>
        </Controls>
        {graphTag && graphFrame && (
          <ViewportPortal>
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                left: graphFrame.x,
                top: graphFrame.y,
                width: graphFrame.w,
                height: graphFrame.h,
                pointerEvents: "none",
              }}
            >
              <div className="h-full w-full rounded-2xl border-2 border-dashed border-[#c2611f]/70" />
              <span className="absolute -top-3 left-5 whitespace-nowrap rounded bg-[#c2611f] px-2.5 py-1 text-[11px] font-sans uppercase tracking-widest text-white">
                {graphTag}
              </span>
            </div>
          </ViewportPortal>
        )}
      </ReactFlow>
    </div>
  );

  const renderEditorWorkspace = (fullscreen: boolean) => (
    <div className={fullscreen ? "flex h-full min-h-0 flex-col gap-4" : "flex flex-col gap-4"}>
      {/* Canvas tabs */}
      <div className={`${fullscreen ? "flex" : "hidden lg:flex"} flex-wrap items-center gap-1 border-b border-[#c8c4b4] pb-1`}>
        {canvases.map((c) => {
          const isActive = c.id === activeId;
          const isRenaming = renamingId === c.id;
          return (
            <div
              key={c.id}
              className={`group flex items-center gap-1 px-3 py-1.5 rounded-t border-b-2 cursor-pointer text-xs font-sans uppercase tracking-widest ${
                isActive
                  ? "bg-[#f3f1e6] border-gray-900 text-gray-900"
                  : "bg-transparent border-transparent text-gray-500 hover:text-gray-800"
              }`}
              onClick={() => selectCanvas(c.id)}
              onDoubleClick={() => setRenamingId(c.id)}
              title="Double-click to rename"
            >
              {isRenaming ? (
                <input
                  autoFocus
                  value={c.name}
                  onChange={(e) => renameCanvas(c.id, e.target.value)}
                  onBlur={() => setRenamingId(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "Escape") {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="bg-transparent border-b border-gray-500 outline-none text-xs font-sans uppercase tracking-widest px-1 w-32"
                />
              ) : (
                <span>{c.name || "Untitled"}</span>
              )}
              {canvases.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeCanvas(c.id);
                  }}
                  className="opacity-40 hover:opacity-100 hover:text-red-600 ml-1"
                  aria-label={`Remove ${c.name}`}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={addCanvas}
          className="px-3 py-1.5 text-xs font-sans uppercase tracking-widest text-gray-600 hover:text-gray-900 hover:bg-[#eceadd] rounded-t"
          title="Add canvas"
        >
          + Canvas
        </button>
        <span className="ml-auto text-[10px] font-sans uppercase tracking-widest text-gray-400">
          {canvases.length} canvas{canvases.length === 1 ? "" : "es"}
        </span>
      </div>

      {/* Toolbar — a collapsible accordion wrapping the node + canvas action rows */}
      <div className={`${fullscreen ? "flex" : "hidden lg:flex"} flex-col gap-2`}>
        <button
          type="button"
          onClick={() => setToolbarOpen((o) => !o)}
          aria-expanded={toolbarOpen}
          className="flex items-center gap-1.5 self-start -ml-1 rounded px-1.5 py-1 text-[10px] font-sans uppercase tracking-widest text-gray-600 hover:text-gray-900 hover:bg-[#eceadd]"
        >
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform ${toolbarOpen ? "rotate-90" : ""}`}
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          Tools
        </button>
        {toolbarOpen && (
          <div className="flex flex-col gap-2">
            {/* Node toolbar (row 1) — add-node buttons + Delete selected */}
            <div className="flex flex-wrap items-center gap-2">
        {controlStructureKinds.length > 0 && (
          <div className="relative" ref={controlStructureMenuRef}>
            <button
              type="button"
              onClick={() => setIsControlStructureMenuOpen((open) => !open)}
              className="text-xs font-sans uppercase tracking-widest px-3 py-2 border border-amber-500 text-amber-900 bg-amber-50 hover:bg-amber-100 rounded"
              aria-haspopup="menu"
              aria-expanded={isControlStructureMenuOpen}
            >
              + Control structure
            </button>
            {isControlStructureMenuOpen && (
              <div
                className="absolute left-0 top-full z-20 mt-2 min-w-[14rem] rounded border border-[#c8c4b4] bg-[#f7f4e8] p-2 shadow-xl"
                role="menu"
              >
                <div className="mb-2 px-2 text-[10px] font-sans uppercase tracking-widest text-gray-500">
                  Choose node type
                </div>
                <div className="space-y-1">
                  {controlStructureKinds.map((k) => (
                    <button
                      key={k.kind}
                      type="button"
                      onClick={() => addNode(k)}
                      className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-xs font-sans uppercase tracking-widest text-gray-700 hover:bg-[#ece7d6]"
                      role="menuitem"
                    >
                      <span>{k.toolbarLabel.replace(/^\+\s*/, "")}</span>
                      <span className="font-mono text-[10px] lowercase tracking-normal text-gray-500">
                        {k.kind}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {directToolbarKinds.map((k) => (
          <button
            key={k.kind}
            type="button"
            onClick={() => addNode(k)}
            className={k.toolbarClassName}
          >
            {k.toolbarLabel}
          </button>
        ))}
        <div className="w-px h-6 bg-[#c8c4b4] mx-1" />
        <button
          type="button"
          disabled={
            (!selectedId && !selectedCollapsedEdgeId) ||
            (Boolean(selectedNode) && selectedNodeNonEditable)
          }
          onClick={deleteSelected}
          className="text-xs font-sans uppercase tracking-widest px-3 py-2 border border-gray-400 text-gray-700 bg-transparent hover:bg-gray-100 rounded disabled:opacity-40"
        >
          Delete selected
        </button>
      </div>

            {/* Canvas-level actions (row 2) — Load example + Reset canvas */}
            <div className="flex flex-wrap items-center gap-2">
        {seedDoc?.canvases[0] && (
          <button
            type="button"
            onClick={resetActive}
            className="text-xs font-sans uppercase tracking-widest px-3 py-2 border border-emerald-500 text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded"
            title="Replace this canvas with the example chain"
          >
            Load example
          </button>
        )}
        {seedDoc?.canvases[1] && (
          <button
            type="button"
            onClick={() => loadSeedCanvas(1)}
            className="text-xs font-sans uppercase tracking-widest px-3 py-2 border border-sky-500 text-sky-800 bg-sky-50 hover:bg-sky-100 rounded"
            title="Replace this canvas with the document-grounded RAG (Corpus B1) example"
          >
            RAG example
          </button>
        )}
        {seedDoc?.canvases[2] && (
          <button
            type="button"
            onClick={() => loadSeedCanvas(2)}
            className="text-xs font-sans uppercase tracking-widest px-3 py-2 border border-violet-500 text-violet-800 bg-violet-50 hover:bg-violet-100 rounded"
            title="Replace this canvas with the persistent memory (knowledge graph) example"
          >
            Memory example
          </button>
        )}
        {seedDoc?.canvases[3] && (
          <button
            type="button"
            onClick={() => loadSeedCanvas(3)}
            className="text-xs font-sans uppercase tracking-widest px-3 py-2 border border-amber-500 text-amber-800 bg-amber-50 hover:bg-amber-100 rounded"
            title="Replace this canvas with the Playwright browser example (drives a real Chromium; local/self-hosted only)"
          >
            Browser example
          </button>
        )}
        <button
          type="button"
          onClick={resetActive}
          className="text-xs font-sans uppercase tracking-widest px-3 py-2 border border-gray-400 text-gray-600 bg-transparent hover:bg-gray-100 rounded"
        >
          Reset canvas
        </button>
            </div>
          </div>
        )}
      </div>

      {/* Canvas + inspector */}
      <div
        ref={!fullscreen && fillHeight ? canvasBodyRef : undefined}
        className={fullscreen ? "rf-canvas-body flex min-h-0 flex-1 flex-col gap-4 lg:flex-row" : "rf-canvas-body flex flex-col gap-4 lg:flex-row"}
        style={!fullscreen && fillHeight && fillRowHeight ? { height: fillRowHeight } : undefined}
      >
        {renderCanvasSurface(fullscreen)}

        <aside
          className={
            fullscreen
              ? "w-full lg:w-80 lg:max-w-[24rem] shrink-0 overflow-auto rounded border border-[#c8c4b4] bg-[#dddacb] p-4 space-y-3"
              : fillHeight
                ? "w-full lg:w-72 h-full overflow-auto shrink-0 rounded border border-[#c8c4b4] bg-[#dddacb] p-4 space-y-3"
                : "w-full lg:w-72 lg:h-[360px] lg:overflow-auto shrink-0 rounded border border-[#c8c4b4] bg-[#dddacb] p-4 space-y-3"
          }
        >
          <div className="flex flex-wrap items-center gap-1 border-b border-[#c0bdb0] pb-2">
            {[
              ["inspector", "Inspector"],
              ["compiler", "Compiler"],
              ["notes", "Notes"],
              ...(inspectorExtraTabs ?? []).map((t) => [t.id, t.label] as const),
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setInspectorTab(id)}
                className={`text-[10px] uppercase tracking-widest font-sans px-2 py-1 rounded ${
                  inspectorTab === id
                    ? "bg-[#cbc9ba] text-gray-900"
                    : "text-gray-500 hover:text-gray-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {inspectorTab === "inspector" && (
          <div className="space-y-3">
          {selectedPromptGroup && selectedPromptGroupPreview ? (
            <>
              <p className="text-xs text-gray-500 font-serif">
                Selected combined prompt ·{" "}
                <span className="font-mono">{selectedPromptGroup.phase}</span>
              </p>
              <p className="text-[11px] font-serif text-gray-500 leading-relaxed">
                This dotted region is lowered as a single{" "}
                <span className="font-medium font-mono">
                  {selectedPromptGroupPreview.stepType}
                </span>{" "}
                step.
              </p>
              <div className="space-y-2 rounded border border-[#c0bdb0] bg-[#e0dccc] px-3 py-2">
                <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                  Connections
                </p>
                <p className="text-[11px] font-serif text-gray-600 leading-relaxed">
                  Output:{" "}
                  <span className="font-mono">
                    {selectedPromptGroupOutputNode
                      ? describeNodeLabelById(selectedPromptGroupOutputNode.id)
                      : "(none)"}
                  </span>
                </p>
                <select
                  value={promptGroupConnectTargetId}
                  onChange={(event) => setPromptGroupConnectTargetId(event.target.value)}
                  className="w-full rounded border border-[#c0bdb0] bg-[#cbc8b8] px-2 py-1.5 text-xs font-serif text-gray-800 focus:outline-none focus:border-gray-500"
                >
                  {promptGroupConnectTargets.length === 0 ? (
                    <option value="">No target nodes</option>
                  ) : (
                    promptGroupConnectTargets.map((node) => (
                      <option key={node.id} value={node.id}>
                        {describeNodeLabelById(node.id)}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  disabled={!selectedPromptGroupOutputNode || !promptGroupConnectTargetId}
                  onClick={connectSelectedPromptGroupToTarget}
                  className="w-full rounded border border-gray-500 px-3 py-1.5 text-[10px] font-sans uppercase tracking-widest text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                >
                  Connect
                </button>
              </div>
              <div className="space-y-3 pt-2 border-t border-[#c0bdb0]">
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                    Inputs (consumed locals)
                  </p>
                  {selectedPromptGroupPreview.inputs.length > 0 ? (
                    renderIoFieldCards(selectedPromptGroupPreview.inputs)
                  ) : (
                    <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                      No consumed locals detected for this combined prompt.
                    </p>
                  )}
                </div>

                <div>
                  <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                    Outputs (declared locals)
                  </p>
                  {selectedPromptGroupPreview.outputs.length > 0 ? (
                    renderIoFieldCards(selectedPromptGroupPreview.outputs)
                  ) : (
                    <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                      No declared locals detected for this combined prompt.
                    </p>
                  )}
                </div>

                <div>
                  <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                    Included nodes
                  </p>
                  <div className="space-y-2 mt-2">
                    {selectedPromptGroupPreview.nodes.map((node) => (
                      <div
                        key={node.id}
                        className="border border-[#c0bdb0] rounded bg-[#e0dccc] px-2 py-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-mono text-gray-800">{node.id}</span>
                          <span className="shrink-0 text-[10px] uppercase tracking-widest text-gray-600 font-sans border border-[#c0bdb0] rounded bg-[#d6d3c4] px-1.5 py-0.5">
                            {node.type}
                          </span>
                        </div>
                        {node.label && (
                          <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
                            {node.label}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                    System prompt
                  </p>
                  {selectedPromptGroupPreview.systemPrompt ? (
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-[#c0bdb0] bg-[#d6d3c4] px-3 py-2 text-[11px] leading-relaxed text-gray-800">
{selectedPromptGroupPreview.systemPrompt}
                    </pre>
                  ) : (
                    <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                      No separate system prompt. This grouped step inlines its subtree context into the user prompt instead.
                    </p>
                  )}
                </div>

                <div>
                  <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                    User prompt
                  </p>
                  <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded border border-[#c0bdb0] bg-[#d6d3c4] px-3 py-2 text-[11px] leading-relaxed text-gray-800">
{selectedPromptGroupPreview.userPrompt}
                  </pre>
                </div>
              </div>
            </>
          ) : selectedCollapsedEdge ? (
            <>
              <p className="text-xs text-gray-500 font-serif">Selected combined edge</p>
              <p className="text-[11px] font-serif text-gray-500 leading-relaxed">
                {describeCollapsedEndpointLabel(selectedCollapsedEdge.edge.source)} →{" "}
                {describeCollapsedEndpointLabel(selectedCollapsedEdge.edge.target)}
              </p>
              <p className="text-[11px] font-serif text-gray-500 leading-relaxed">
                This visual edge represents {selectedCollapsedEdge.edge.rawEdgeIds.length} folded
                edge{selectedCollapsedEdge.edge.rawEdgeIds.length === 1 ? "" : "s"} around a
                combined prompt region.
              </p>
              <button
                type="button"
                onClick={() => deleteCollapsedEdge(selectedCollapsedEdge.edge.id)}
                className="w-full rounded border border-red-300 bg-red-50 px-3 py-2 text-xs font-sans uppercase tracking-widest text-red-700 hover:bg-red-100"
              >
                Delete combined edge
              </button>
              <div className="space-y-3 pt-2 border-t border-[#c0bdb0]">
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                    Available locals
                  </p>
                  {selectedCollapsedEdge.dataFlow.length > 0 ? (
                    renderIoFieldCards(selectedCollapsedEdge.dataFlow)
                  ) : (
                    <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                      No local variables are definitely available at this point.
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : selectedNode ? (
            <>
              <p className="text-xs text-gray-500 font-serif">
                Selected node ·{" "}
                <span className="font-mono">{describeSelectedNodeKind(selectedNode)}</span>
              </p>
              {selectedPromptTransformPreview && (
                <div className="space-y-3 pt-2 border-t border-[#c0bdb0]">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                      Underlying model call
                    </p>
                    <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                      This node lowers as a single{" "}
                      <span className="font-medium font-mono">
                        {selectedPromptTransformPreview.stepType}
                      </span>{" "}
                      step.
                    </p>
                  </div>

                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                      System prompt
                    </p>
                    {selectedPromptTransformPreview.systemPrompt ? (
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-[#c0bdb0] bg-[#d6d3c4] px-3 py-2 text-[11px] leading-relaxed text-gray-800">
{selectedPromptTransformPreview.systemPrompt}
                      </pre>
                    ) : (
                      <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                        No separate system prompt. This node&apos;s runtime call inlines its context into the user prompt instead.
                      </p>
                    )}
                  </div>

                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                      User prompt
                    </p>
                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded border border-[#c0bdb0] bg-[#d6d3c4] px-3 py-2 text-[11px] leading-relaxed text-gray-800">
{selectedPromptTransformPreview.userPrompt}
                    </pre>
                  </div>
                </div>
              )}
              {selectedPromptNodePreview && (
                <div className="space-y-3 pt-2 border-t border-[#c0bdb0]">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                      Underlying model call
                    </p>
                    <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                      This node lowers as a single{" "}
                      <span className="font-medium font-mono">
                        {selectedPromptNodePreview.stepType}
                      </span>{" "}
                      step.
                    </p>
                  </div>

                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                      System prompt
                    </p>
                    {selectedPromptNodePreview.systemPrompt ? (
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-[#c0bdb0] bg-[#d6d3c4] px-3 py-2 text-[11px] leading-relaxed text-gray-800">
{selectedPromptNodePreview.systemPrompt}
                      </pre>
                    ) : (
                      <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                        No separate system prompt. This node&apos;s runtime call inlines its context into the user prompt instead.
                      </p>
                    )}
                  </div>

                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                      User prompt
                    </p>
                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded border border-[#c0bdb0] bg-[#d6d3c4] px-3 py-2 text-[11px] leading-relaxed text-gray-800">
{selectedPromptNodePreview.userPrompt}
                    </pre>
                  </div>
                </div>
              )}
              {selectedNodeNonEditable && (
                <div className="rounded border border-slate-300 bg-slate-100 px-3 py-2 text-[11px] font-serif leading-relaxed text-slate-700">
                  <p>
                    This node is managed by the runtime and is read-only.
                  </p>
                  {selectedRuntimeManagedNodeInfo ? (
                    <div className="mt-2 space-y-1">
                      <p className="font-sans text-[10px] uppercase tracking-widest text-slate-500">
                        {selectedRuntimeManagedNodeInfo.title}
                      </p>
                      {selectedRuntimeManagedNodeInfo.templateId ? (
                        <p>
                          Template:{" "}
                          <span className="font-mono">
                            {selectedRuntimeManagedNodeInfo.templateId}
                          </span>
                        </p>
                      ) : null}
                      <p>{selectedRuntimeManagedNodeInfo.reason}</p>
                      {selectedRuntimeManagedNodeInfo.writes ? (
                        <p>
                          Writes:{" "}
                          <span className="font-mono">
                            {selectedRuntimeManagedNodeInfo.writes}
                          </span>
                        </p>
                      ) : null}
                      {selectedRuntimeManagedNodeInfo.placement ? (
                        <p>{selectedRuntimeManagedNodeInfo.placement}</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
              {helpText && (
                <p className="text-[11px] font-serif text-gray-500 leading-relaxed">{helpText}</p>
              )}
              {selectedNodeWarnings.length > 0 && (
                <div className="space-y-2">
                  {selectedNodeWarnings.map((warning, index) => (
                    <div
                      key={`${warning.nodeId}:${index}:${warning.message}`}
                      className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] font-serif leading-relaxed text-rose-900"
                    >
                      {warning.message}
                    </div>
                  ))}
                </div>
              )}
              {selectedNodeIo && (
                <div className="space-y-3 pt-2 border-t border-[#c0bdb0]">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                      {selectedNodeIoLabels.inputs}
                    </p>
                    {selectedNodeIo.inputs.length > 0 ? (
                      renderIoFieldCards(selectedNodeIo.inputs)
                    ) : (
                      <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                        {selectedNodeIoLabels.noInputs}
                      </p>
                    )}
                  </div>

                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                      {selectedNodeIoLabels.outputs}
                    </p>
                    {hideOutputSummaryCards ? (
                      selectedNodeIo.outputs.length > 0 ? (
                        <div className="mt-1 space-y-2">
                          <p className="text-[11px] font-serif text-gray-500 leading-relaxed">
                            Editable below in <span className="font-medium">Local output fields</span>.
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {selectedNodeIo.outputs.map((field) => (
                              <span
                                key={`${field.name}:${field.type}:${field.origin ?? ""}`}
                                className="inline-flex items-center gap-1 rounded border border-[#c0bdb0] bg-[#e0dccc] px-2 py-1 text-[10px] text-gray-700"
                              >
                                <span className="font-mono text-gray-800">{field.name}</span>
                                <span className="uppercase tracking-widest text-gray-500">
                                  {field.type}
                                </span>
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                          Editable below in <span className="font-medium">Local output fields</span>.
                        </p>
                      )
                    ) : selectedNodeIo.outputs.length > 0 ? (
                      renderIoFieldCards(selectedNodeIo.outputs)
                    ) : (
                      <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                        {selectedNodeIoLabels.noOutputs}
                      </p>
                    )}
                  </div>
                </div>
              )}
              {selectedLoweredCodePreview && (
                <div className="space-y-3 pt-2 border-t border-[#c0bdb0]">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                      Lowered code
                    </p>
                    <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                      This node lowers as a deterministic{" "}
                      <span className="font-medium font-mono">code</span> step in the{" "}
                      <span className="font-medium">
                        {selectedLoweredCodePreview.phase}
                      </span>{" "}
                      execution graph.
                    </p>
                  </div>

                  {(selectedLoweredCodePreview.lines.length > 0 ||
                    !selectedLoweredCodePreview.scriptSource) && (
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                        Deterministic ops
                      </p>
                      {selectedLoweredCodePreview.lines.length > 0 ? (
                        <div className="mt-2 space-y-1.5">
                          {selectedLoweredCodePreview.lines.map((line, index) => (
                            <div
                              key={`${index}:${line}`}
                              className="rounded border border-[#c0bdb0] bg-[#e0dccc] px-3 py-2 text-[11px] font-mono leading-relaxed text-gray-800"
                            >
                              {line}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                          The current label does not parse into a supported deterministic
                          code rule, so this node will not lower to a concrete code step
                          from its present text.
                        </p>
                      )}
                    </div>
                  )}

                  {selectedLoweredCodePreview.scriptSource && (
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                        Code
                      </p>
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre rounded border border-[#c0bdb0] bg-[#d6d3c4] px-3 py-2 text-[11px] leading-relaxed text-gray-800">
{selectedLoweredCodePreview.scriptSource}
                      </pre>
                    </div>
                  )}

                  {selectedLoweredCodePreview.stepJson && (
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                        Lowered step fragment
                      </p>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-[#c0bdb0] bg-[#d6d3c4] px-3 py-2 text-[11px] leading-relaxed text-gray-800">
{selectedLoweredCodePreview.stepJson}
                      </pre>
                    </div>
                  )}
                </div>
              )}
              {showLabelField && (
                <>
                  <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans">
                    {labelTitle}
                  </label>
                  <textarea
                    value={selectedNode.data.label}
                    onChange={(e) => updateSelectedNodeLabel(e.target.value)}
                    rows={textareaRows}
                    readOnly={selectedNodeNonEditable}
                    className={`w-full border border-[#c0bdb0] rounded px-3 py-2 text-sm font-serif text-gray-800 focus:outline-none focus:border-gray-500 resize-y leading-relaxed ${
                      selectedNodeNonEditable
                        ? "bg-[#d8d5c8] cursor-not-allowed opacity-80"
                        : "bg-[#cbc8b8]"
                    }`}
                  />
                </>
              )}
              {!selectedNodeNonEditable &&
                inspector.renderExtra?.(
                  selectedNode.data,
                  updateSelectedNodeData,
                  inspectorContext ?? {}
                )}
            </>
          ) : selectedEdge ? (
            <>
              <p className="text-xs text-gray-500 font-serif">Selected edge</p>
              <p className="text-[11px] font-serif text-gray-500 leading-relaxed">
                {describeNodeLabelById(selectedEdge.source)} →{" "}
                {describeNodeLabelById(selectedEdge.target)}
              </p>
              <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans">
                Edge label
              </label>
              <input
                type="text"
                value={typeof selectedEdge.label === "string" ? selectedEdge.label : ""}
                onChange={(e) => updateSelectedEdgeLabel(e.target.value)}
                className="w-full border border-[#c0bdb0] rounded bg-[#cbc8b8] px-3 py-2 text-sm font-serif text-gray-800 focus:outline-none focus:border-gray-500"
              />
              <div>
                <p className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
                  Available locals
                </p>
                {selectedEdgeDataFlow.length > 0 ? (
                  renderIoFieldCards(selectedEdgeDataFlow)
                ) : (
                  <p className="text-[11px] font-serif text-gray-500 mt-1 leading-relaxed">
                    No local variables are definitely available at this point.
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-3">
              {isCorpusCanvas && (
                <div className="rounded border border-sky-300 bg-sky-50 px-3 py-3">
                  <p className="text-[10px] uppercase tracking-widest text-sky-900 font-sans">
                    Try the RAG example
                  </p>
                  <p className="text-[11px] font-serif text-sky-900/80 leading-relaxed mt-1">
                    Ask these in the chat. Click a question to copy it. They are
                    answered from the seeded corpus — run{" "}
                    <span className="font-mono">npm run corpus:seed</span> first.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {CORPUS_DEMO_QUESTIONS.grounded.map((q) => (
                      <li key={q}>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard?.writeText(q).catch(() => {});
                            setCopiedQuestion(q);
                            window.setTimeout(
                              () => setCopiedQuestion((c) => (c === q ? null : c)),
                              1200
                            );
                          }}
                          title="Click to copy"
                          className="w-full text-left text-[11px] font-serif leading-snug text-sky-900 hover:text-sky-700 hover:underline"
                        >
                          {copiedQuestion === q ? "Copied!" : `→ ${q}`}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[10px] uppercase tracking-widest text-sky-900/70 font-sans mt-3">
                    Control (should NOT retrieve)
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      const q = CORPUS_DEMO_QUESTIONS.control;
                      navigator.clipboard?.writeText(q).catch(() => {});
                      setCopiedQuestion(q);
                      window.setTimeout(
                        () => setCopiedQuestion((c) => (c === q ? null : c)),
                        1200
                      );
                    }}
                    title="Click to copy"
                    className="w-full text-left text-[11px] font-serif leading-snug text-sky-900 hover:text-sky-700 hover:underline mt-1"
                  >
                    {copiedQuestion === CORPUS_DEMO_QUESTIONS.control
                      ? "Copied!"
                      : `→ ${CORPUS_DEMO_QUESTIONS.control}`}
                  </button>
                  <p className="text-[11px] font-serif text-sky-900/70 leading-relaxed mt-2">
                    The relevance gate evaluates false here, so no{" "}
                    <span className="font-mono">search_documents</span> call fires —
                    watch the step-by-step trace to confirm.
                  </p>
                  <p className="text-[11px] font-serif text-sky-900/70 leading-relaxed mt-2 pt-2 border-t border-sky-200">
                    Note: the IF is <span className="font-medium">model-judged</span> —
                    the model reads the condition and decides whether to retrieve each
                    turn (an affordance, not an engine-guaranteed step).
                  </p>
                </div>
              )}
              <p className="text-xs text-gray-500 font-serif leading-relaxed">
                Click a node or edge to edit. Drag from a handle to connect nodes. Use the{" "}
                <span className="font-medium">+ Canvas</span> tab above to add another flow.
              </p>
              {nodeWarnings.length > 0 && (
                <div className="rounded border border-rose-300 bg-rose-50 px-3 py-3">
                  <p className="text-[10px] uppercase tracking-widest text-rose-900 font-sans">
                    Canvas issues
                  </p>
                  <div className="mt-2 space-y-2">
                    {nodeWarnings.map((warning, index) => (
                      <p
                        key={`${warning.nodeId}:${index}:${warning.message}`}
                        className="text-[11px] font-serif leading-relaxed text-rose-900"
                      >
                        {warning.label}: {warning.message}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          </div>
          )}

          {inspectorTab === "compiler" && (
            <pre className="w-full max-h-[460px] overflow-auto rounded border border-[#c8c4b4] bg-[#d6d3c4] px-3 py-2 text-[11px] font-mono text-gray-800 whitespace-pre-wrap leading-relaxed">
{preview}
            </pre>
          )}

          {inspectorTab === "notes" && (
            <div>
              <p className="text-[11px] font-serif text-gray-400 mb-2 leading-relaxed">
                Free-text instructions appended after this canvas&rsquo;s compiled output. Use for
                nuances the diagram cannot capture.
              </p>
              <textarea
                value={active.freeText}
                onChange={(e) => updateFreeText(e.target.value)}
                rows={8}
                placeholder="e.g. Do not repeat a question already asked…"
                className="w-full bg-[#d6d3c4] border border-[#c8c4b4] rounded px-3 py-2 text-sm font-serif text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500 resize-y leading-relaxed"
              />
            </div>
          )}

          {(inspectorExtraTabs ?? []).map(
            (t) => inspectorTab === t.id && <div key={t.id}>{t.content}</div>
          )}
        </aside>
      </div>
    </div>
  );

  return (
    <div className="rf-canvas flex flex-col gap-4">
      {!canvasFullscreen ? renderEditorWorkspace(false) : null}

      {canvasFullscreen && typeof document !== "undefined"
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-[90] bg-black/40"
                onClick={() => setCanvasFullscreen(false)}
              />
              <div className="fixed inset-4 z-[100] overflow-hidden rounded border border-[#c8c4b4] bg-[#f3f1e6] p-4 shadow-2xl">
                {renderEditorWorkspace(true)}
              </div>
            </>,
            document.body
          )
        : null}

    </div>
  );
}
