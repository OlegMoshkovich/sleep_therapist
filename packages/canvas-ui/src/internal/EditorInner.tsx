"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  Background,
  Controls,
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
  useReactFlow,
  getBezierPath,
  ConnectionLineType,
  type EdgeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas-selection.css";

import type {
  CanvasDoc,
  CanvasEdgeRecord,
  CanvasEntry,
  CanvasFireSignal,
  CanvasGraph,
  CanvasInspectorContext,
  CanvasNode,
  CanvasNodeData,
  CanvasOnChange,
  CompilerFn,
  NodeKindDef,
} from "../types";
import {
  isCanvasNodeNonEditable,
  normalizeCanvasDoc,
} from "../types";
import { uid } from "./id";
import { anchorBetweenRects } from "./edge-anchors";
import { ShortestStepEdge } from "./ShortestStepEdge";
import { collectCanvasNodeWarnings } from "@airlab/canvas-rules/node-warnings";
import {
  collectStructuralPromptGroups,
  type StructuralPromptGroup,
} from "@airlab/canvas-planner/canvas-structural-planner";
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

/** Below this board height, Tools / Fullscreen / zoom / Save overlap — hide them. */
const MIN_BOARD_CHROME_H = 168;

// True when the active canvas contains the corpus retrieval tool — i.e. it is
// the RAG example, however it was loaded (tab switch or the "RAG example"
// button). Matches the { server: "corpus", tool: "search_documents" } binding.
function isCorpusCanvasNodes(nodes: CanvasNode[]): boolean {
  return nodes.some((n) => {
    const d = (n.data ?? {}) as { toolName?: string; ref?: { server?: string } };
    return d.ref?.server === "corpus" || d.toolName === "search_documents";
  });
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
  /** When true, the inspector panel (Inspector/Compiler tabs) is not rendered. */
  hideInspector?: boolean;
  /**
   * When true, the canvas + inspector row is given a constant height that fills
   * from below the toolbars to the bottom of the viewport, rather than a fixed
   * inline height that varies with the inspector's content. Used inside the
   * full-screen-ish config overlay.
   */
  fillHeight?: boolean;
  /**
   * fillHeight layout: `stack` = canvas above inspector (side drawer default);
   * `split` = canvas | inspector side by side (bottom drawer).
   */
  panelLayout?: "stack" | "split";
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
  /**
   * Content docked in the bottom-right canvas chrome (e.g. Save).
   */
  tabBarTrailing?: ReactNode;
  /**
   * Content to the right of the info (i) button in the canvas tab nav
   * (e.g. workflow drawer ×).
   */
  tabBarEnd?: ReactNode;
  /**
   * Fired when a node is clicked, in addition to the built-in selection. Lets a
   * host react to node clicks (e.g. a workflow stage node opening its policy
   * canvas) without owning the canvas internals.
   */
  onNodeActivate?: (node: { id: string; type?: string; data: CanvasNodeData }) => void;
  /**
   * When the nonce (`n`) changes, switch the active canvas tab to `canvasId` (if
   * it exists). Lets a host select a specific canvas — e.g. a workflow stage
   * opening its policy canvas.
   */
  selectCanvasSignal?: { canvasId: string; n: number } | null;
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

const CANVAS_EDGE_TYPES: EdgeTypes = {
  shortestStep: ShortestStepEdge,
};

/** Same as Controls' fit-view (third button): center the graph when a canvas opens. */
function FitViewOnOpen({
  canvasId,
  layoutKey,
}: {
  canvasId: string;
  /** Remount/resize signal — drawer open, split drag, collapse toggle, etc. */
  layoutKey: string;
}) {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();

  useEffect(() => {
    if (!nodesInitialized) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      fitView({ padding: 0.2, duration: 0 });
    };
    // Wait a frame so the surface has a real size (drawer/split often mounts at 0),
    // then a short follow-up after layout settles (tab switch / drawer expand).
    const raf = requestAnimationFrame(run);
    const t = window.setTimeout(run, 80);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [canvasId, layoutKey, nodesInitialized, fitView]);

  return null;
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
        const [path] = getBezierPath(anchors);
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
                fill={selected ? "rgba(0, 126, 39, 0.08)" : "rgba(255, 255, 255, 0.02)"}
                stroke={selected ? "#007E27" : "#9a8f78"}
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
                fill={selected ? "#007E27" : "#6f6859"}
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
              strokeWidth={3}
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

/**
 * Restore any missing singleton kinds (e.g. Start) onto a saved canvas and
 * wire them to the current root when the graph has no incoming edges there.
 */
function ensureSingletonNodes(
  entry: CanvasEntry,
  nodeKinds: NodeKindDef[]
): CanvasEntry {
  const singletons = nodeKinds.filter((k) => k.singleton);
  if (singletons.length === 0) return entry;

  let nodes = [...entry.graph.nodes];
  let edges = [...entry.graph.edges];
  let changed = false;

  for (const kind of singletons) {
    if (nodes.some((n) => n.type === kind.kind)) continue;
    changed = true;

    const topY = nodes.reduce(
      (min, n) => Math.min(min, n.position?.y ?? 0),
      Number.POSITIVE_INFINITY
    );
    const avgX =
      nodes.length > 0
        ? nodes.reduce((sum, n) => sum + (n.position?.x ?? 0), 0) / nodes.length
        : 340;

    let id = kind.kind;
    if (nodes.some((n) => n.id === id)) {
      id = `${kind.kind}_${uid("n")}`;
    }

    const newNode = {
      id,
      type: kind.kind,
      position: {
        x: Number.isFinite(avgX) ? Math.round(avgX) : 340,
        y: Number.isFinite(topY) ? Math.round(topY - 180) : 40,
      },
      data: { label: kind.defaultLabel, ...(kind.defaultData ?? {}) },
    };
    nodes = [newNode, ...nodes];

    const targets = new Set(edges.map((e) => e.target));
    const roots = nodes
      .filter((n) => n.id !== id && !targets.has(n.id))
      .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));
    if (roots[0]) {
      edges = [
        {
          id: `e_${id}_${roots[0].id}`,
          source: id,
          target: roots[0].id,
        },
        ...edges,
      ];
    }
  }

  if (!changed) return entry;
  return {
    ...entry,
    graph: { ...entry.graph, nodes, edges },
  };
}

function normalizeDoc(doc: CanvasDoc | null): CanvasDoc | null {
  const normalized = normalizeCanvasDoc(doc);
  if (!normalized || !Array.isArray(normalized.canvases) || normalized.canvases.length === 0) {
    return null;
  }
  return normalized;
}

function titleCaseKindLabel(kind: string): string {
  return kind
    .split(" / ")
    .map((part) =>
      part
        .split(/[_\s]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
    )
    .join(" / ");
}

/** Hover tip rendered under a Tools toolbar control. */
function ToolTipWrap({
  tip,
  children,
}: {
  tip: string;
  children: ReactNode;
}) {
  return (
    <span className="rf-tool-tip-wrap">
      {children}
      {tip ? (
        <span className="rf-tool-tip" role="tooltip">
          {tip}
        </span>
      ) : null}
    </span>
  );
}

/** Fullscreen inspector: grow the prompt box to fit its text. */
function InspectorAutoTextarea({
  autoHeight,
  value,
  className,
  rows,
  onChange,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  autoHeight: boolean;
  value: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const syncHeight = useCallback(() => {
    const el = ref.current;
    if (!el || !autoHeight) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [autoHeight]);

  useLayoutEffect(() => {
    syncHeight();
  }, [syncHeight, value]);

  useEffect(() => {
    if (!autoHeight) {
      const el = ref.current;
      if (el) el.style.height = "";
      return;
    }
    syncHeight();
    window.addEventListener("resize", syncHeight);
    return () => window.removeEventListener("resize", syncHeight);
  }, [autoHeight, syncHeight]);

  return (
    <textarea
      {...rest}
      ref={ref}
      value={value}
      rows={autoHeight ? 1 : rows}
      onChange={(e) => {
        onChange?.(e);
        if (autoHeight) {
          const el = e.currentTarget;
          el.style.height = "0px";
          el.style.height = `${el.scrollHeight}px`;
        }
      }}
      className={`${className ?? ""} ${
        autoHeight ? "resize-none overflow-hidden" : ""
      }`.trim()}
    />
  );
}

function describeSelectedNodeKind(node: CanvasNode | null): string {
  if (!node) {
    return "";
  }

  const subtype = getNodeActionSubtype(node);
  if (node.type === "prompt" && subtype !== "prompt") {
    return titleCaseKindLabel(`prompt / ${subtype}`);
  }
  return titleCaseKindLabel(node.type);
}

function markerEndForEdge() {
  return { type: MarkerType.ArrowClosed };
}

const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true };

function makeInitialCanvases(args: {
  doc: CanvasDoc | null;
  seedDoc?: CanvasDoc;
  nodeKinds: NodeKindDef[];
}): { canvases: WorkingCanvas[]; activeId: string } {
  const source = normalizeDoc(args.doc) ?? normalizeDoc(args.seedDoc ?? null);
  if (source && source.canvases.length > 0) {
    const canvases = source.canvases.map((entry) =>
      graphToWorking(ensureSingletonNodes(entry, args.nodeKinds))
    );
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
  hideInspector,
  fillHeight,
  panelLayout = "stack",
  graphTag,
  fireSignal,
  tabBarTrailing,
  tabBarEnd,
  onNodeActivate,
  selectCanvasSignal,
}: EditorInnerProps<TOutput>) {
  // Bottom drawer: side-by-side. Side drawer / Model Setup: stacked column.
  const splitPanels = Boolean(fillHeight && panelLayout === "split");
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
  // Inspector-tab Fullscreen: overlay with the inspector filling the shell
  // (canvas hidden). Distinct from the canvas tab-bar Fullscreen (side-by-side).
  const [inspectorMaximized, setInspectorMaximized] = useState(false);
  // Fullscreen uses the same canvas | inspector chrome as the workflow bottom
  // drawer (side-by-side + drag resize), even when the host is a stacked pane.
  const splitChrome = splitPanels || canvasFullscreen;
  // Collapse the graph surface (docked column layout) so the inspector below
  // gets the reclaimed height.
  const [canvasCollapsed, setCanvasCollapsed] = useState(false);
  // Collapse only in the docked workflow drawer — fullscreen has no Collapse control.
  // Inspector-maximized fullscreen also hides the canvas surface.
  const canvasIsCollapsed =
    (splitPanels && !canvasFullscreen && canvasCollapsed) ||
    (canvasFullscreen && inspectorMaximized);
  // Share of the body axis for the graph (rest → inspector).
  // Stack (State/Policy height) and split (workflow / fullscreen width): both 2/3 · 1/3.
  // Separate storage keys so one layout doesn't overwrite the other.
  const defaultCanvasShare = 2 / 3;
  const canvasShareKey = splitChrome
    ? "rf-canvas-inspector-share-split"
    : "rf-canvas-inspector-share-stack";
  const [canvasShare, setCanvasShare] = useState(defaultCanvasShare);
  const [splitDragging, setSplitDragging] = useState(false);
  // "How to use the canvas" help overlay.
  const [helpOpen, setHelpOpen] = useState(false);
  // Node + canvas-action toolbar (Control structure, Prompt, Expand, Terminate,
  // Delete selected). Collapsed by default; expand via Tools.
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [isControlStructureMenuOpen, setIsControlStructureMenuOpen] = useState(false);
  const [copiedQuestion, setCopiedQuestion] = useState<string | null>(null);
  const controlStructureMenuRef = useRef<HTMLDivElement | null>(null);
  // Only one surface (inline OR fullscreen) is mounted at a time.
  const canvasSurfaceRef = useRef<HTMLDivElement | null>(null);
  // The canvas + inspector row, and its measured fill height (see effect below).
  const canvasBodyRef = useRef<HTMLDivElement | null>(null);
  const [fillRowHeight, setFillRowHeight] = useState<number | null>(null);
  // Hide Tools / Fullscreen / Save / zoom when the board is too short for them
  // to sit without overlapping (top chrome vs bottom chrome).
  const [boardChromeVisible, setBoardChromeVisible] = useState(true);

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

  // Restore the canvas/inspector split from localStorage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(canvasShareKey);
      if (!raw) return;
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0.2 && n <= 0.8) setCanvasShare(n);
    } catch {
      // ignore
    }
  }, [canvasShareKey]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(canvasShareKey, String(canvasShare));
    } catch {
      // ignore
    }
  }, [canvasShare, canvasShareKey]);

  // In fillHeight mode, give the canvas + inspector row a CONSTANT height that
  // spans from its top (just below the toolbars) to the bottom of the host.
  // Cap against the host's client box so the row can never grow the drawer and
  // drag Inspector/Compiler off-screen. Do NOT observe the row itself — that
  // feedback loop was expanding fill height while dragging the split.
  useEffect(() => {
    if (!fillHeight) {
      setFillRowHeight(null);
      return;
    }
    if (typeof window === "undefined") return;
    let raf = 0;
    let ro: ResizeObserver | null = null;
    const recompute = () => {
      const el = canvasBodyRef.current;
      if (!el) return;
      const host =
        el.closest(".obs-docked-body") ||
        el.closest(".bottom-drawer-body") ||
        el.closest(".sc-canvas-host");
      const reserve =
        parseFloat(getComputedStyle(el).getPropertyValue("--rf-fill-reserve-bottom")) || 0;
      const elTop = el.getBoundingClientRect().top;
      let next: number;
      if (host) {
        const hostRect = host.getBoundingClientRect();
        const padBottom =
          parseFloat(getComputedStyle(host).paddingBottom) || 0;
        const fromViewport = hostRect.bottom - padBottom - elTop;
        // Prefer the host's laid-out client height so a previous oversized
        // fillRowHeight can't ratchet the drawer taller on each drag.
        const relativeTop = Math.max(0, elTop - hostRect.top);
        const fromClient = host.clientHeight - relativeTop - padBottom;
        next = Math.min(fromViewport, fromClient);
      } else {
        next = window.innerHeight - reserve - elTop - (reserve > 0 ? 36 : 8);
      }
      setFillRowHeight(Math.max(160, Math.round(next)));
    };
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    let tries = 0;
    const kick = () => {
      if (!canvasBodyRef.current && tries < 20) {
        tries += 1;
        raf = requestAnimationFrame(kick);
        return;
      }
      raf = requestAnimationFrame(recompute);
      const el = canvasBodyRef.current;
      if (el && ro) {
        const host =
          el.closest(".obs-docked-body") ||
          el.closest(".bottom-drawer-body") ||
          el.closest(".sc-canvas-host");
        // Observe the host + window only — never the row being sized.
        if (host) ro.observe(host);
      }
    };
    window.addEventListener("resize", onResize);
    ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    ro?.observe(document.body);
    raf = requestAnimationFrame(kick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [fillHeight, toolbarOpen]);

  // Let Escape exit the fullscreen canvas overlay (and inspector-max mode).
  useEffect(() => {
    if (!canvasFullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setCanvasFullscreen(false);
        setInspectorMaximized(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvasFullscreen]);

  // Watch board height; tuck floating controls away before they collide.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const el = canvasSurfaceRef.current;
    if (!el) return;
    const sync = () => {
      const h = el.clientHeight;
      if (h <= 0) return;
      const visible = h >= MIN_BOARD_CHROME_H;
      setBoardChromeVisible(visible);
      if (!visible) {
        setToolbarOpen(false);
        setIsControlStructureMenuOpen(false);
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fillRowHeight, canvasIsCollapsed, canvasFullscreen, fillHeight]);

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
    const nextDoc = workingToDoc(canvases, activeId);
    const nextDocString = JSON.stringify(nextDoc);
    if (nextDocString === lastEmittedDocRef.current) {
      firstEmitRef.current = false;
      return;
    }
    if (firstEmitRef.current) {
      firstEmitRef.current = false;
      // Always notify the host on first mount so dirty-tracking can adopt the
      // editor-normalized doc as its clean baseline. Skipping this made the
      // first *edit* look like the baseline (Save stayed disabled).
      // Still run immediately (no debounce) so adoption happens before typing.
      const compilerGroups = collectPromptGroupsForCompiler(nextDoc, inspectorContext);
      const compilerDoc = normalizePromptGroupsForCompiler(nextDoc, compilerGroups);
      const result = compileRef.current(compilerDoc);
      lastEmittedDocRef.current = nextDocString;
      onChangeRef.current({ doc: nextDoc, result });
      return;
    }
    const handle = setTimeout(() => {
      const compilerGroups = collectPromptGroupsForCompiler(nextDoc, inspectorContext);
      const compilerDoc = normalizePromptGroupsForCompiler(nextDoc, compilerGroups);
      const result = compileRef.current(compilerDoc);
      lastEmittedDocRef.current = nextDocString;
      onChangeRef.current({ doc: nextDoc, result });
    }, 150);
    return () => clearTimeout(handle);
  }, [canvases, activeId, inspectorContext, docProp, seedDoc, nodeKinds]);

  // Re-hydrate when the parent sends a genuinely new doc.
  useEffect(() => {
    const incoming = normalizeDoc(docProp);
    if (!incoming) return;
    const incomingStr = JSON.stringify(incoming);
    if (incomingStr === lastEmittedDocRef.current) return;
    const ensured = incoming.canvases.map((entry) =>
      ensureSingletonNodes(entry, nodeKinds)
    );
    const rehydrated = ensured.map((entry) => graphToWorking(entry));
    // Keep lastEmitted as the unrepaired prop so the emit effect can push the
    // restored Start (and any other singleton) back to the parent/save path.
    lastEmittedDocRef.current = incomingStr;
    firstEmitRef.current = false;
    setCanvases(rehydrated);
    setActiveId(
      rehydrated.find((c) => c.id === incoming.activeId)?.id ?? rehydrated[0].id
    );
    setSelectedId(null);
    setSelectedPromptGroupKey(null);
    setSelectedCollapsedEdgeId(null);
  }, [docProp, nodeKinds]);

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
    // Singleton kinds (Start) cannot be removed from the canvas.
    const selectedKind = selectedNodeForDelete
      ? kindByKey.get(selectedNodeForDelete.type ?? "")
      : null;
    if (selectedKind?.singleton) return;
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

  // Host-driven canvas selection (e.g. a workflow stage opening its policy canvas).
  useEffect(() => {
    const target = selectCanvasSignal?.canvasId;
    if (!target || !canvases.some((c) => c.id === target)) return;
    setActiveId(target);
    setSelectedId(null);
    setSelectedPromptGroupKey(null);
    setSelectedCollapsedEdgeId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectCanvasSignal?.n]);

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
    // Selection is driven by `selectedId` (set on node click, cleared on pane
    // click). We feed it into React Flow's `selected` here — `handleNodesChange`
    // drops `select` changes to keep selection out of the saved doc, so this is
    // the single source of truth for what looks selected.
    return active.nodes.map((node) => {
      const extra = fireNodeClass.get(node.id);
      const selected = node.id === selectedId;
      const needsSelectFlag = selected !== !!node.selected;
      if (!extra && !needsSelectFlag) return node;
      return {
        ...node,
        ...(needsSelectFlag ? { selected } : {}),
        ...(extra
          ? {
              className: [node.className, extra].filter(Boolean).join(" "),
              style: {
                ...(node.style ?? {}),
                boxShadow: extra.includes("rf-fire-active")
                  ? "0 0 0 4px #0f766e, 0 0 22px rgba(15, 118, 110, 0.6)"
                  : "0 0 0 3px rgba(194, 97, 31, 0.75)",
                borderRadius: 0,
              },
            }
          : {}),
      };
    });
  }, [active, fireNodeClass, selectedId]);

  const fireEdges = useMemo<Edge[]>(() => {
    // Shortest-side curved edges: side-by-side nodes attach left↔right instead of
    // detouring through the default top/bottom handles.
    return visibleEdges.map((edge) => {
      const fireState = fireEdgeStateById.get(edge.id);
      const branch =
        typeof edge.label === "string"
          ? edge.label.trim().toLowerCase()
          : typeof edge.sourceHandle === "string"
            ? edge.sourceHandle.trim().toLowerCase()
            : "";
      const branchStroke =
        branch === "true"
          ? "#007E27"
          : branch === "false"
            ? "#D9582B"
            : undefined;

      if (!fireState) {
        return {
          ...edge,
          type: "shortestStep",
          markerEnd: branchStroke
            ? { type: MarkerType.ArrowClosed, color: branchStroke }
            : edge.markerEnd ?? markerEndForEdge(),
          style: {
            ...(edge.style ?? {}),
            strokeWidth: 3,
            ...(branchStroke ? { stroke: branchStroke } : {}),
          },
        };
      }

      // Keep true/false branch ink during trace highlights. Neutral edges stay
      // the same grey as idle connections (no amber/teal override).
      const neutralStroke = "#6b6b63";
      const color = branchStroke ?? neutralStroke;
      const branchClass =
        branch === "true"
          ? "rf-fire-edge--true"
          : branch === "false"
            ? "rf-fire-edge--false"
            : "";
      const glow =
        branch === "true"
          ? fireState === "active"
            ? "drop-shadow(0 0 7px rgba(0, 126, 39, 0.55))"
            : "drop-shadow(0 0 4px rgba(0, 126, 39, 0.35))"
          : branch === "false"
            ? fireState === "active"
              ? "drop-shadow(0 0 7px rgba(217, 88, 43, 0.55))"
              : "drop-shadow(0 0 4px rgba(217, 88, 43, 0.35))"
            : fireState === "active"
              ? "drop-shadow(0 0 6px rgba(107, 107, 99, 0.45))"
              : "drop-shadow(0 0 3px rgba(107, 107, 99, 0.28))";

      return {
        ...edge,
        type: "shortestStep",
        animated: true,
        className: [edge.className, "rf-fire-edge", branchClass]
          .filter(Boolean)
          .join(" "),
        // Idle markers default to 12.5 with markerUnits=strokeWidth and stroke 3.
        // Trace arrows use a fixed user-space size so line weight doesn't scale them.
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 60,
          height: 60,
          markerUnits: "userSpaceOnUse",
        },
        style: {
          ...(edge.style ?? {}),
          stroke: color,
          // Idle edges use 3 — traced connections are 2× heavier.
          strokeWidth: 6,
          filter: glow,
        },
        labelStyle: {
          ...(edge.labelStyle ?? {}),
          fill: color,
          fontWeight: 800,
          fontSize: 12,
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
  const collapsedEdgeDetails = useMemo(
    () =>
      promptGroupEdgePresentation.collapsedEdges.map((edge) => ({ edge })),
    [promptGroupEdgePresentation.collapsedEdges]
  );
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
  const startToolbarKinds = toolbarKinds.filter((k) => k.kind === "start");
  const controlStructureKinds = toolbarKinds.filter(isControlStructureKind);
  const directToolbarKinds = toolbarKinds.filter(
    (k) => !isControlStructureKind(k) && k.kind !== "start"
  );

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
  const textareaRows = resolveInspectorValue(inspector.textareaRows, 3);
  const showLabelField = resolveInspectorValue(inspector.showLabelField, true);
  // Right-aligned selection chip in the Inspector/Compiler nav — kind only
  // (no "Selected node" prefix), selected-tab ink.
  const inspectorSelectionKind = selectedPromptGroup
    ? titleCaseKindLabel(selectedPromptGroup.phase)
    : selectedCollapsedEdge
      ? "Combined edge"
      : selectedNode
        ? describeSelectedNodeKind(selectedNode)
        : selectedEdge
          ? "Edge"
          : null;
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

  const renderCanvasSurface = (fullscreen: boolean) => {
    // Docked Policy/State: wait for a measured body height before mounting
    // React Flow — otherwise it inits at 0×0 (#004) and stays blank even after
    // the flex chain later gets a real size. Fullscreen always has a box.
    const boardReady = !fillHeight || fullscreen || fillRowHeight != null;
    return (
    <div
      ref={canvasSurfaceRef}
      className={
        fullscreen || fillHeight
          ? // fillHeight / fullscreen: borderless — the rf-vsplit / rf-hsplit is
            // the only separator between board and inspector.
            "rf-canvas-surface relative block h-full min-h-0 overflow-hidden bg-[#f3f1e6]"
          : "rf-canvas-surface relative hidden lg:block flex-1 min-h-[300px] h-[360px] overflow-hidden rounded-none border border-[#c8c4b4] bg-[#f3f1e6]"
      }
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen || undefined}
      // Collapsed: hide the surface entirely so the inspector fills the row.
      style={canvasIsCollapsed ? { display: "none" } : undefined}
    >
      {boardReady ? (
      <ReactFlow
        key={`${active.id}-${fullscreen ? "full" : "inline"}`}
        nodes={fireNodes}
        edges={fireEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeDragStop={handleNodeDragStop}
        nodeTypes={nodeTypes}
        edgeTypes={CANVAS_EDGE_TYPES}
        connectionLineType={ConnectionLineType.Bezier}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={REACT_FLOW_PRO_OPTIONS}
        onNodeClick={(_, n) => {
          setSelectedCollapsedEdgeId(null);
          setSelectedPromptGroupKey(null);
          setSelectedId(n.id);
          onNodeActivate?.({ id: n.id, type: n.type, data: n.data as CanvasNodeData });
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
        <FitViewOnOpen
          canvasId={active.id}
          layoutKey={[
            fullscreen ? "full" : "inline",
            fillHeight ? "fill" : "fixed",
            canvasIsCollapsed ? "collapsed" : "open",
            // Bucket height so tiny resize jitter doesn't refit; big open still does.
            String(Math.round((fillRowHeight ?? 0) / 40)),
          ].join(":")}
        />
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
        {/* Zoom top-right — hidden when the board is too short for chrome. */}
        {boardChromeVisible ? (
          <Controls showInteractive={false} position="top-right" orientation="vertical" />
        ) : null}
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
              <div className="h-full w-full rounded-none border-2 border-dashed border-[#c2611f]/70" />
              <span className="absolute -top-3 left-5 whitespace-nowrap rounded-none bg-[#c2611f] px-2.5 py-1 text-[11px] font-sans uppercase tracking-widest text-white">
                {graphTag}
              </span>
            </div>
          </ViewportPortal>
        )}
      </ReactFlow>
      ) : null}
      {/* Tools — top-left. Fullscreen — bottom-left. Save — bottom-right.
          Hidden when board height would make top/bottom controls overlap. */}
      {!canvasIsCollapsed && boardChromeVisible && (
        <>
          {toolbarOpen && (
            <div className="rf-canvas-tools absolute top-14 left-3 z-20 flex max-w-[calc(100%-4.5rem)] flex-col overflow-y-auto overflow-x-hidden rounded-none border border-[#c8c4b4] bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                {startToolbarKinds.map((k) => {
                  const alreadyPresent = (active?.nodes ?? []).some(
                    (n) => n.type === k.kind
                  );
                  const tip = alreadyPresent
                    ? "This canvas already has a Start node."
                    : k.toolbarDescription ?? "Add the Start node.";
                  return (
                    <ToolTipWrap key={k.kind} tip={tip}>
                      <button
                        type="button"
                        onClick={() => addNode(k)}
                        disabled={alreadyPresent}
                        className={`rf-tool-btn ${k.toolbarClassName} disabled:cursor-not-allowed disabled:bg-[#d5dcd0] disabled:text-[#1c1b16] disabled:border-[#b8c2ad]`}
                      >
                        {k.toolbarLabel}
                      </button>
                    </ToolTipWrap>
                  );
                })}
                {controlStructureKinds.length > 0 && (
                  <ToolTipWrap
                    tip={
                      isControlStructureMenuOpen
                        ? ""
                        : "Add a branch or loop (condition, while, for)."
                    }
                  >
                    <div className="relative" ref={controlStructureMenuRef}>
                      <button
                        type="button"
                        onClick={() => setIsControlStructureMenuOpen((open) => !open)}
                        className="rf-tool-btn border border-[#FFD100] text-[#3d3838] bg-[#FFD100] hover:bg-[#f0c400]"
                        aria-haspopup="menu"
                        aria-expanded={isControlStructureMenuOpen}
                      >
                        + Control structure
                      </button>
                      {isControlStructureMenuOpen && (
                        <div
                          className="absolute left-0 top-full z-30 mt-2 min-w-[14rem] rounded-none border border-[#c8c4b4] bg-[#f7f4e8] p-2 shadow-xl"
                          role="menu"
                        >
                          <div className="mb-2 px-2 text-[14px] font-sans text-gray-500">
                            Choose node type
                          </div>
                          <div className="space-y-1">
                            {controlStructureKinds.map((k) => (
                              <button
                                key={k.kind}
                                type="button"
                                onClick={() => addNode(k)}
                                title={k.toolbarDescription}
                                className="flex w-full items-center justify-between rounded-none px-2 py-2 text-left text-[14px] font-sans text-gray-700 hover:bg-[#ece7d6]"
                                role="menuitem"
                              >
                                <span>{k.toolbarLabel.replace(/^\+\s*/, "")}</span>
                                <span className="font-mono text-[12px] lowercase text-gray-500">
                                  {k.kind}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </ToolTipWrap>
                )}
                {directToolbarKinds.map((k) => (
                  <ToolTipWrap
                    key={k.kind}
                    tip={k.toolbarDescription ?? `Add a ${k.kind} node.`}
                  >
                    <button
                      type="button"
                      onClick={() => addNode(k)}
                      className={`rf-tool-btn ${k.toolbarClassName}`}
                    >
                      {k.toolbarLabel}
                    </button>
                  </ToolTipWrap>
                ))}
                <div className="w-px h-5 bg-[#c8c4b4] mx-1" />
                <ToolTipWrap tip="Remove the selected node or edge.">
                  <button
                    type="button"
                    disabled={
                      (!selectedId && !selectedCollapsedEdgeId) ||
                      (Boolean(selectedNode) && selectedNodeNonEditable)
                    }
                    onClick={deleteSelected}
                    className="rf-tool-btn border border-gray-400 text-gray-700 bg-transparent hover:bg-gray-100 disabled:opacity-40"
                  >
                    Delete selected
                  </button>
                </ToolTipWrap>
              </div>
            </div>
          )}
          <div className="rf-canvas-chrome rf-canvas-chrome--tools absolute top-3 left-3 z-20 flex items-center rounded-none border border-[#c8c4b4] bg-white p-0">
            <button
              type="button"
              onClick={() => setToolbarOpen((o) => !o)}
              aria-expanded={toolbarOpen}
              className="rf-canvas-tab-btn"
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
          </div>
          <div className="rf-canvas-chrome rf-canvas-chrome--fs absolute bottom-3 left-3 z-20 flex items-center rounded-none border border-[#c8c4b4] bg-white p-0">
            {!fullscreen ? (
              <button
                type="button"
                onClick={() => {
                  setInspectorMaximized(false);
                  setCanvasFullscreen(true);
                }}
                aria-label="Fullscreen"
                title="Fullscreen"
                className="rf-canvas-tab-btn"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
                </svg>
                Fullscreen
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setCanvasFullscreen(false);
                  setInspectorMaximized(false);
                }}
                aria-label="Exit fullscreen"
                title="Exit fullscreen (Esc)"
                className="rf-canvas-tab-btn"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
                Close
              </button>
            )}
          </div>
          {tabBarTrailing ? (
            <div className="rf-canvas-chrome rf-canvas-chrome--save absolute bottom-3 right-3 z-20 flex max-w-[calc(100%-6rem)] flex-wrap items-center justify-end rounded-none border border-[#c8c4b4] bg-white p-0">
              <div className="rf-canvas-tab-trailing flex items-center">{tabBarTrailing}</div>
            </div>
          ) : null}
        </>
      )}
    </div>
    );
  };

  const renderEditorWorkspace = (fullscreen: boolean) => (
    <div
      className={
        fullscreen || fillHeight
          ?             // `rf-canvas-workspace` is the flex-chain hook for docked Policy/State.
            // Prefer flex-1 over h-full — percentage height collapses when the
            // drawer ancestor height is indefinite (blank board + inspector).
            // Tools chrome overlays the board (bottom-right); no flex gap needed.
            "rf-canvas-workspace flex min-h-0 flex-1 flex-col overflow-hidden gap-0"
          : "rf-canvas-workspace flex flex-col gap-4"
      }
    >
      {/* Canvas tabs */}
      {/* gap-x matches .obs-setup / .drawer-tabs (22px); px-4 = 16px matches
          those rows so "Main" lines up with Knowledge / Model Setup when the
          docked body side padding is zeroed. Tab label padding 0 2px hugs the
          underline like the rows above. */}
      <div className={`rf-canvas-tabs ${fullscreen ? "flex" : "hidden lg:flex"} h-[46px] min-h-[46px] flex-nowrap items-center border-b border-[#c8c4b4] py-0 pl-4 pr-2`}>
        {/* Titles scroll under a pinned (i) when the drawer is narrow — never wrap the end chrome. */}
        <div className="rf-canvas-tab-scroll min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex h-[46px] min-w-min items-center gap-x-[22px]">
            {canvases.map((c) => {
              const isActive = c.id === activeId;
              const isRenaming = renamingId === c.id;
              return (
                <div
                  key={c.id}
                  className={`rf-canvas-tab group flex h-auto shrink-0 items-center gap-1 px-0.5 pb-1 border-b-2 cursor-pointer whitespace-nowrap text-[14px] font-sans text-[#1c1b16] ${
                    isActive ? "border-[#1c1b16]" : "border-transparent"
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
                      className="bg-transparent border-b border-gray-500 outline-none text-[14px] font-sans text-[#1c1b16] px-1 w-32"
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
          </div>
        </div>
        <div className="rf-canvas-tab-end ml-1 flex h-[46px] shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={addCanvas}
            aria-label="Add canvas"
            title="Add canvas"
            className="rf-canvas-tab-btn rf-canvas-tab-btn--icon h-[46px]"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" />
              <line x1="12" y1="8" x2="12" y2="16" />
              <line x1="8" y1="12" x2="16" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            aria-label="How to use the canvas"
            title="How to use the canvas"
            className="rf-canvas-tab-btn rf-canvas-tab-btn--icon h-[46px]"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" />
              <line x1="12" y1="11" x2="12" y2="16.5" />
              <circle cx="12" cy="7.75" r="1" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {tabBarEnd}
          {fullscreen && (
            <button
              type="button"
              onClick={() => {
                setCanvasFullscreen(false);
                setInspectorMaximized(false);
              }}
              aria-label="Exit fullscreen"
              title="Exit fullscreen (Esc)"
              className="rf-canvas-tab-btn rf-canvas-tab-btn--icon h-[46px]"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Canvas + inspector */}
      <div
        ref={fullscreen || fillHeight ? canvasBodyRef : undefined}
        className={
          fullscreen || splitPanels
            ? "rf-canvas-body flex min-h-0 flex-1 flex-row"
            : fillHeight
              ? "rf-canvas-body flex min-h-0 flex-1 flex-col"
              : "rf-canvas-body flex flex-col gap-4 lg:flex-row"
        }
        style={
          fullscreen
            ? { minHeight: 0, height: "100%", maxHeight: "100%" }
            : // Docked stacked: flex-fill the workspace (no pixel height — that
              // left a gap under Compiler and let the drawer scroll away).
              fillHeight
              ? { flex: "1 1 0", minHeight: 0, maxHeight: "100%", overflow: "hidden" }
              : undefined
        }
      >
        {fullscreen || fillHeight ? (
          <div
            className="rf-canvas-slot min-h-0 min-w-0 overflow-hidden"
            style={
              canvasIsCollapsed
                ? { display: "none" }
                : fillHeight && !splitPanels && !fullscreen
                  ? {
                      // Flex grow share — inspector keeps minHeight 46px so it
                      // cannot be dragged off-screen.
                      flex: `${Math.max(0.15, canvasShare)} 1 0`,
                      minHeight: 0,
                      minWidth: 0,
                    }
                  : {
                      flex: `0 0 ${Math.round(canvasShare * 1000) / 10}%`,
                      minHeight: 0,
                      minWidth: 0,
                    }
            }
          >
            {renderCanvasSurface(fullscreen)}
          </div>
        ) : (
          renderCanvasSurface(fullscreen)
        )}

        {/* Drag handle: vertical in stacked side drawer; horizontal in
            workflow split + fullscreen (same interaction). */}
        {(fullscreen || fillHeight) && !hideInspector && !canvasIsCollapsed && (
          <div
            className={
              (fullscreen || splitPanels ? "rf-hsplit" : "rf-vsplit") +
              (splitDragging ? " active" : "")
            }
            role="separator"
            aria-orientation={fullscreen || splitPanels ? "vertical" : "horizontal"}
            aria-label="Resize canvas and inspector (double-click to reset)"
            title="Drag to resize · double-click to reset"
            onDoubleClick={() => setCanvasShare(defaultCanvasShare)}
            onPointerDown={(e) => {
              e.preventDefault();
              const body = canvasBodyRef.current;
              if (!body) return;
              const rect = body.getBoundingClientRect();
              const horizontal = fullscreen || splitPanels;
              const axisSize = horizontal ? rect.width : rect.height;
              if (axisSize <= 0) return;
              const startPos = horizontal ? e.clientX : e.clientY;
              const startShare = canvasShare;
              const resizeClass = horizontal ? "ra-resizing-h" : "ra-resizing-v";
              setSplitDragging(true);
              document.body.classList.add(resizeClass);
              const onMove = (ev: PointerEvent) => {
                const delta = (horizontal ? ev.clientX : ev.clientY) - startPos;
                const next = startShare + delta / axisSize;
                // Stacked: keep ≥46px for Inspector/Compiler tabs.
                if (!horizontal && axisSize > 0) {
                  const minInspector = 46 + 7;
                  const maxShare = Math.max(
                    0.15,
                    Math.min(0.85, 1 - minInspector / axisSize)
                  );
                  const minShare = Math.min(0.2, maxShare);
                  setCanvasShare(Math.max(minShare, Math.min(maxShare, next)));
                  return;
                }
                setCanvasShare(Math.max(0.2, Math.min(0.8, next)));
              };
              const onUp = () => {
                setSplitDragging(false);
                document.body.classList.remove(resizeClass);
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
            }}
          />
        )}

        {!hideInspector && (
        <aside
          className={
            // Force every label, help line, textarea, and chip to the same 14px
            // body size — child utilities like text-[10px]/text-xs otherwise win.
            fullscreen || fillHeight
              ? // Drawer / fullscreen: no outer border/radius — flush to the drag split.
                "rf-inspector flex w-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#dddacb] text-[14px] text-[#1c1b16]"
              : "rf-inspector flex w-full min-h-0 flex-col lg:w-72 lg:h-[360px] shrink-0 overflow-hidden rounded-none border border-[#c8c4b4] bg-[#dddacb] text-[14px] text-[#1c1b16]"
          }
          style={
            fillHeight && !splitPanels && !fullscreen
              ? {
                  flex: `${Math.max(0.15, 1 - canvasShare)} 1 0`,
                  minHeight: 46,
                  minWidth: 0,
                  overflow: "hidden",
                }
              : fullscreen || fillHeight
                ? {
                    maxHeight: "none",
                    flex: "1 1 0",
                    minHeight: 0,
                    minWidth: 0,
                  }
                : undefined
          }
        >
          {/* Same underline nav as Main / Sleep Intake / Knowledge (46px · 22px gap · 16px inset). */}
          <div className="rf-inspector-tabs flex h-[46px] shrink-0 items-center gap-[22px] border-b border-[#c8c4b4] px-4">
            {[
              ["inspector", "Inspector"],
              ["compiler", "Compiler"],
              ...(inspectorExtraTabs ?? []).map((t) => [t.id, t.label] as const),
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setInspectorTab(id)}
                className={`rf-inspector-tab flex h-auto items-center self-center px-0.5 pb-1 border-b-2 bg-transparent text-[14px] font-sans text-[#1c1b16] outline-none focus:outline-none focus-visible:outline-none rounded-none ${
                  inspectorTab === id
                    ? "border-[#1c1b16]"
                    : "border-transparent text-gray-500 hover:text-[#1c1b16]"
                }`}
              >
                {label}
              </button>
            ))}
            <div className="ml-auto flex min-w-0 items-center gap-1">
              {inspectorSelectionKind ? (
                <span className="min-w-0 max-w-[12rem] truncate text-[14px] font-sans font-normal text-[#1c1b16] sm:max-w-[16rem]">
                  {inspectorSelectionKind}
                </span>
              ) : null}
              {/* Inspector Fullscreen / Expand control removed per request. */}
            </div>
          </div>

          <div className="rf-inspector-body min-h-0 flex-1 overflow-auto text-[#1c1b16]">
          {inspectorTab === "inspector" && (
          <div className="space-y-3 px-4 py-3 text-[#1c1b16]">
          {selectedPromptGroup ? (
            <>
              <div className="space-y-2">
                <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans">
                  Connect to
                </label>
                <select
                  value={promptGroupConnectTargetId}
                  onChange={(event) => setPromptGroupConnectTargetId(event.target.value)}
                  className="w-full rounded-none border border-[#c0bdb0] bg-[#cbc8b8] px-2 py-1.5 text-xs font-serif text-gray-800 focus:outline-none focus:border-gray-500"
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
                  className="w-full rounded-none border border-gray-500 px-3 py-1.5 text-[10px] font-sans uppercase tracking-widest text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                >
                  Connect
                </button>
              </div>
            </>
          ) : selectedCollapsedEdge ? (
            <>
              <p className="text-[11px] font-serif text-gray-500 leading-relaxed">
                {describeCollapsedEndpointLabel(selectedCollapsedEdge.edge.source)} →{" "}
                {describeCollapsedEndpointLabel(selectedCollapsedEdge.edge.target)}
              </p>
              <button
                type="button"
                onClick={() => deleteCollapsedEdge(selectedCollapsedEdge.edge.id)}
                className="w-full rounded-none border border-red-300 bg-red-50 px-3 py-2 text-xs font-sans uppercase tracking-widest text-red-700 hover:bg-red-100"
              >
                Delete combined edge
              </button>
            </>
          ) : selectedNode ? (
            <>
              {selectedNodeNonEditable && (
                <div className="rounded-none border border-slate-300 bg-slate-100 px-3 py-2 text-[11px] font-serif leading-relaxed text-slate-700">
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
              {selectedNodeWarnings.length > 0 && (
                <div className="space-y-2">
                  {selectedNodeWarnings.map((warning, index) => (
                    <div
                      key={`${warning.nodeId}:${index}:${warning.message}`}
                      className="rounded-none border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] font-serif leading-relaxed text-rose-900"
                    >
                      {warning.message}
                    </div>
                  ))}
                </div>
              )}
              {showLabelField && (
                <>
                  <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans">
                    {labelTitle}
                  </label>
                  <InspectorAutoTextarea
                    autoHeight
                    value={
                      typeof selectedNode.data.label === "string"
                        ? selectedNode.data.label
                        : ""
                    }
                    onChange={(e) => updateSelectedNodeLabel(e.target.value)}
                    rows={textareaRows}
                    readOnly={selectedNodeNonEditable}
                    className={`w-full border border-[#c0bdb0] rounded-none px-3 py-2 text-sm font-serif text-gray-800 focus:outline-none focus:border-gray-500 leading-relaxed ${
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
                className="w-full border border-[#c0bdb0] rounded-none bg-[#cbc8b8] px-3 py-2 text-sm font-serif text-gray-800 focus:outline-none focus:border-gray-500"
              />
            </>
          ) : (
            <div className="space-y-3">
              {isCorpusCanvas && (
                <div className="rounded-none border border-sky-300 bg-sky-50 px-3 py-3">
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
              <p className="text-[14px] font-sans leading-relaxed text-[#56534b]">
                Click a node or edge to edit. Drag from a handle to connect nodes. Use the{" "}
                <span className="font-medium text-[#1c1b16]">+ Canvas</span> tab above to add another flow.
              </p>
              {nodeWarnings.length > 0 && (
                <div className="rounded-none border border-rose-300 bg-rose-50 px-3 py-3">
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
            <pre className="rf-compiler-output m-0 h-full min-h-0 w-full overflow-auto border-0 bg-transparent p-4 text-[14px] font-mono text-gray-800 whitespace-pre-wrap leading-relaxed">
{preview}
            </pre>
          )}

          {(inspectorExtraTabs ?? []).map(
            (t) =>
              inspectorTab === t.id && (
                <div key={t.id} className="px-4 py-3">
                  {t.content}
                </div>
              )
          )}
          </div>
        </aside>
        )}
      </div>
    </div>
  );

  return (
    <div
      className={
        fillHeight
          ? "rf-canvas flex min-h-0 flex-1 flex-col overflow-hidden"
          : "rf-canvas flex flex-col gap-4"
      }
    >
      {!canvasFullscreen ? renderEditorWorkspace(false) : null}

      {canvasFullscreen && typeof document !== "undefined"
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-[90] bg-black/40"
                onClick={() => {
                  setCanvasFullscreen(false);
                  setInspectorMaximized(false);
                }}
              />
              <div className="rf-canvas-fullscreen fixed inset-4 z-[100] flex flex-col overflow-hidden rounded-none border border-[#c8c4b4] bg-[#f3f1e6] shadow-2xl">
                {renderEditorWorkspace(true)}
              </div>
            </>,
            document.body
          )
        : null}

      {helpOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[200] flex items-center justify-center p-6"
              style={{ background: "rgba(31,29,24,0.42)" }}
              role="dialog"
              aria-modal="true"
              aria-label="How to use the canvas"
              onClick={() => setHelpOpen(false)}
            >
              <div
                className="rf-canvas-help w-[min(560px,100%)] max-h-[85vh] overflow-auto rounded-none border border-[#a8a698] bg-[#d8d6c7] shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="rf-canvas-help-head sticky top-0 flex items-center justify-between gap-3 border-b border-[#bcbaad] bg-[#d8d6c7] px-[18px] py-4">
                  <span className="font-sans text-[16px] font-semibold text-[#1f1d18]">
                    How to use the canvas
                  </span>
                  <button
                    type="button"
                    onClick={() => setHelpOpen(false)}
                    aria-label="Close"
                    className="flex h-7 w-7 items-center justify-center rounded-none text-[#86806f] hover:bg-[#c9c7b9] hover:text-[#1f1d18]"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
                <div className="px-[18px] pb-5 pt-4 font-sans text-[13.5px] leading-[1.6] text-[#56534b]">
                  <p className="mb-3.5">
                    The canvas is a flowchart that <b className="font-semibold text-[#1f1d18]">compiles into the prompt</b> the
                    model runs each turn. Build it like this:
                  </p>
                  {inspectorContext?.executionPhase === "state" && (
                    <div className="rf-canvas-help-note mb-4 rounded-none! border border-[#bcbaad] bg-[#cfcdbe] px-3.5 py-3" style={{ borderRadius: 0 }}>
                      <div className="mb-1 text-[14px] font-semibold text-[#1f1d18]">How state works</div>
                      <p className="mb-2">
                        <b className="font-semibold text-[#1f1d18]">State</b> is the structured profile the
                        assistant keeps about the person across the whole conversation — fields like age,
                        sleep concern, or whether an emergency was flagged. Every turn, before it decides
                        what to say, the model reads the newest message and updates these values.
                      </p>
                      <p className="mb-2">
                        This canvas defines <b className="font-semibold text-[#1f1d18]">how</b> those updates
                        happen: it compiles into the state-extraction prompt the runtime runs each turn to
                        pull new facts out of the conversation and write them back into state.
                      </p>
                      <p>
                        The variables themselves — their name, type, and initial value — are defined in the{" "}
                        <b className="font-semibold text-[#1f1d18]">State</b> tab (via{" "}
                        <b className="font-semibold text-[#1f1d18]">Edit</b>). The{" "}
                        <b className="font-semibold text-[#1f1d18]">Policy</b> canvas then reads the
                        up-to-date state to choose the assistant&apos;s next step, so what you capture here
                        is what the assistant can reason about later.
                      </p>
                    </div>
                  )}
                  {inspectorContext?.executionPhase === "policy" && (
                    <div className="rf-canvas-help-note mb-4 rounded-none! border border-[#bcbaad] bg-[#cfcdbe] px-3.5 py-3" style={{ borderRadius: 0 }}>
                      <div className="mb-1 text-[14px] font-semibold text-[#1f1d18]">How the Policy canvas works</div>
                      <p className="mb-2">
                        The <b className="font-semibold text-[#1f1d18]">Policy canvas</b> is the flowchart of{" "}
                        <span className="rounded-none border border-[#bcbaad] bg-[#c9c7b9] px-1 font-mono text-[11px] text-[#1f1d18]">IF</span>{" "}
                        conditions and{" "}
                        <span className="rounded-none border border-[#bcbaad] bg-[#c9c7b9] px-1 font-mono text-[11px] text-[#1f1d18]">PROMPT</span>{" "}
                        nodes. It compiles into the policy prompt — the instructions that decide the assistant&apos;s reply.
                      </p>
                      <p className="mb-2">
                        Each turn the model gets the <b className="font-semibold text-[#1f1d18]">freshly-updated state</b> (from
                        the State canvas) plus the conversation history, walks the conditions from the{" "}
                        <b className="font-semibold text-[#1f1d18]">Start</b> node downward, and stops at the PROMPT node whose
                        branch matches — that becomes the reply for that turn.
                      </p>
                      <p>
                        A <b className="font-semibold text-[#1f1d18]">Terminate stage</b> node ends the current workflow stage
                        and routes to the next one (set its <span className="font-mono text-[11px]">nextStageId</span>). Switch the
                        Inspector to <b className="font-semibold text-[#1f1d18]">Compiler</b> to read the exact compiled prompt.
                      </p>
                    </div>
                  )}
                  {inspectorContext?.executionPhase === "workflow" && (
                    <div className="rf-canvas-help-note mb-4 rounded-none! border border-[#bcbaad] bg-[#cfcdbe] px-3.5 py-3" style={{ borderRadius: 0 }}>
                      <div className="mb-1 text-[14px] font-semibold text-[#1f1d18]">How the workflow works</div>
                      <p className="mb-2">
                        The <b className="font-semibold text-[#1f1d18]">workflow</b> is the high-level map of the stages a
                        conversation moves through (e.g. Intake → Assess → Guide → Follow up). Each{" "}
                        <b className="font-semibold text-[#1f1d18]">Stage</b> node is one phase — lay them out left-to-right.
                      </p>
                      <p className="mb-2">
                        Edges left→right are <b className="font-semibold text-[#1f1d18]">forward</b> transitions; an edge back to
                        an earlier stage is a <b className="font-semibold text-[#1f1d18]">loop / return</b>. Order is read from
                        each stage&apos;s position, so the left-to-right layout <i>is</i> the flow.
                      </p>
                      <p>
                        At runtime only the <b className="font-semibold text-[#1f1d18]">current stage&apos;s</b> slice of the
                        Policy and State canvases runs. A <b className="font-semibold text-[#1f1d18]">Terminate stage</b> node
                        inside the Policy canvas advances the run to the next stage. So the workflow decides <i>what stages
                        exist</i>, while Policy and State decide <i>how each stage behaves</i>.
                      </p>
                    </div>
                  )}
                  <div className="space-y-3.5">
                    <div className="flex gap-3">
                      <div className="flex h-6 w-6 flex-none items-center justify-center bg-[#1c1b16] text-[13px] font-semibold text-[#f6f7f2]">1</div>
                      <div>
                        <div className="mb-0.5 text-[14px] font-semibold text-[#1f1d18]">Expand the screen</div>
                        <p>Use the fullscreen control (top-right of the canvas) to enlarge the workspace — more room makes it easier to lay out and refine the flow.</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <div className="flex h-6 w-6 flex-none items-center justify-center bg-[#1c1b16] text-[13px] font-semibold text-[#f6f7f2]">2</div>
                      <div>
                        <div className="mb-0.5 text-[14px] font-semibold text-[#1f1d18]">Add a node</div>
                        <p>Open <b className="font-semibold text-[#1f1d18]">Tools</b> and pick a node type (Prompt, IF/condition, Subtree, Terminate…). It drops onto the canvas.</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <div className="flex h-6 w-6 flex-none items-center justify-center bg-[#1c1b16] text-[13px] font-semibold text-[#f6f7f2]">3</div>
                      <div>
                        <div className="mb-0.5 text-[14px] font-semibold text-[#1f1d18]">Connect nodes</div>
                        <p>Drag from the small handle (dot) on one node to another. IF nodes have separate <span className="rounded-none border border-[#bcbaad] bg-[#c9c7b9] px-1 font-mono text-[11px] text-[#1f1d18]">TRUE</span> / <span className="rounded-none border border-[#bcbaad] bg-[#c9c7b9] px-1 font-mono text-[11px] text-[#1f1d18]">FALSE</span> outputs.</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <div className="flex h-6 w-6 flex-none items-center justify-center bg-[#1c1b16] text-[13px] font-semibold text-[#f6f7f2]">4</div>
                      <div>
                        <div className="mb-0.5 text-[14px] font-semibold text-[#1f1d18]">Edit a node</div>
                        <p>Click it to open the <b className="font-semibold text-[#1f1d18]">Inspector</b> on the right, where you set its text, type, and options. Click an edge to edit or remove it.</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <div className="flex h-6 w-6 flex-none items-center justify-center bg-[#1c1b16] text-[13px] font-semibold text-[#f6f7f2]">5</div>
                      <div>
                        <div className="mb-0.5 text-[14px] font-semibold text-[#1f1d18]">Delete</div>
                        <p>Select a node or edge and press <span className="rounded-none border border-[#bcbaad] bg-[#c9c7b9] px-1 font-mono text-[11px] text-[#1f1d18]">Delete</span>, or use the delete control in Tools.</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <div className="flex h-6 w-6 flex-none items-center justify-center bg-[#1c1b16] text-[13px] font-semibold text-[#f6f7f2]">6</div>
                      <div>
                        <div className="mb-0.5 text-[14px] font-semibold text-[#1f1d18]">Move around</div>
                        <p>Drag the empty canvas to pan; scroll or use the <span className="font-mono text-[11px]">+ / −</span> buttons to zoom; the fit / fullscreen buttons sit at the top-right.</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <div className="flex h-6 w-6 flex-none items-center justify-center bg-[#1c1b16] text-[13px] font-semibold text-[#f6f7f2]">7</div>
                      <div>
                        <div className="mb-0.5 text-[14px] font-semibold text-[#1f1d18]">Multiple flows</div>
                        <p>Use the <b className="font-semibold text-[#1f1d18]">+ Canvas</b> tab to add another flow, double-click a tab to rename it, and reference one from another with a Subtree node.</p>
                      </div>
                    </div>
                  </div>
                  <p className="mt-3.5 border-t border-[#bcbaad] pt-3">
                    Execution starts at the <b className="font-semibold text-[#1f1d18]">Start</b> node and follows the branches
                    top-to-bottom. To see the exact compiled prompt, switch the Inspector to the <b className="font-semibold text-[#1f1d18]">Compiler</b> tab.
                  </p>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

    </div>
  );
}
