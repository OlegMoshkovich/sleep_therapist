import { getCanvasNodeDeclaredOutputFields } from "../components/canvas/node-declared-outputs";
import type {
  CanvasEdgeRecord,
  CanvasEntry,
  CanvasNodeRecord,
} from "../components/canvas/types";
import { RESERVED_PROMPT_VALUE_NAMES } from "./canvas-flow-values";

export interface CanvasAvailableLocalField {
  name: string;
  type: string;
  origin: string;
}

interface LocalDataflowMaps {
  availableBeforeByNodeId: Map<string, Set<string>>;
  fieldsByName: Map<string, CanvasAvailableLocalField>;
}

function cloneSet(values: Set<string>): Set<string> {
  return new Set(values);
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function unionSets(...sets: Set<string>[]): Set<string> {
  const result = new Set<string>();
  for (const set of sets) {
    for (const value of set) {
      result.add(value);
    }
  }
  return result;
}

function intersectSets(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) {
    return new Set();
  }

  const [first, ...rest] = sets;
  const result = cloneSet(first);
  for (const set of rest) {
    for (const value of Array.from(result)) {
      if (!set.has(value)) {
        result.delete(value);
      }
    }
  }
  return result;
}

function buildIncomingMap(edges: CanvasEdgeRecord[]): Map<string, CanvasEdgeRecord[]> {
  const incoming = new Map<string, CanvasEdgeRecord[]>();
  for (const edge of edges) {
    const group = incoming.get(edge.target) ?? [];
    group.push(edge);
    incoming.set(edge.target, group);
  }
  return incoming;
}

function buildOutgoingMap(edges: CanvasEdgeRecord[]): Map<string, CanvasEdgeRecord[]> {
  const outgoing = new Map<string, CanvasEdgeRecord[]>();
  for (const edge of edges) {
    const group = outgoing.get(edge.source) ?? [];
    group.push(edge);
    outgoing.set(edge.source, group);
  }
  return outgoing;
}

function collectReachableNodeIds(entry: CanvasEntry): Set<string> {
  const nodeIds = new Set(entry.graph.nodes.map((node) => node.id));
  const incoming = buildIncomingMap(entry.graph.edges);
  const outgoing = buildOutgoingMap(entry.graph.edges);
  const roots = entry.graph.nodes
    .filter(
      (node) =>
        node.type === "start" || (incoming.get(node.id) ?? []).length === 0
    )
    .map((node) => node.id);
  const reachable = new Set<string>();
  const stack = roots.length > 0 ? [...roots] : entry.graph.nodes.map((node) => node.id);

  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId || reachable.has(nodeId) || !nodeIds.has(nodeId)) {
      continue;
    }
    reachable.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) {
      stack.push(edge.target);
    }
  }

  return reachable;
}

function buildLocalFieldMap(
  nodes: Pick<CanvasNodeRecord, "type" | "data">[]
): Map<string, CanvasAvailableLocalField> {
  const fieldsByName = new Map<string, CanvasAvailableLocalField>();
  for (const name of RESERVED_PROMPT_VALUE_NAMES) {
    fieldsByName.set(name, {
      name,
      type: "string",
      origin: "reserved local variable",
    });
  }

  for (const node of nodes) {
    for (const field of getCanvasNodeDeclaredOutputFields(node)) {
      const name = field.name.trim();
      if (!name) {
        continue;
      }
      fieldsByName.set(name, {
        name,
        type: field.type,
        origin: field.origin,
      });
    }
  }
  return fieldsByName;
}

function getNodeOutputNames(
  node: Pick<CanvasNodeRecord, "type" | "data">
): Set<string> {
  return new Set(
    getCanvasNodeDeclaredOutputFields(node)
      .map((field) => field.name.trim())
      .filter((name) => name.length > 0)
  );
}

function analyzeLocalDataflow(entry: CanvasEntry): LocalDataflowMaps {
  const incoming = buildIncomingMap(entry.graph.edges);
  const reachable = collectReachableNodeIds(entry);
  const nodeById = new Map(entry.graph.nodes.map((node) => [node.id, node]));
  const reserved = new Set<string>(RESERVED_PROMPT_VALUE_NAMES);
  const fieldsByName = buildLocalFieldMap(entry.graph.nodes);
  const universe = new Set(fieldsByName.keys());
  const availableBeforeByNodeId = new Map<string, Set<string>>();
  const availableAfterByNodeId = new Map<string, Set<string>>();

  for (const node of entry.graph.nodes) {
    const initial = reachable.has(node.id) ? cloneSet(universe) : cloneSet(reserved);
    availableBeforeByNodeId.set(node.id, initial);
    availableAfterByNodeId.set(node.id, unionSets(initial, getNodeOutputNames(node)));
  }

  for (let iteration = 0; iteration < entry.graph.nodes.length * 4 + 4; iteration += 1) {
    let changed = false;
    for (const node of entry.graph.nodes) {
      const predecessors = (incoming.get(node.id) ?? [])
        .map((edge) => nodeById.get(edge.source))
        .filter((candidate): candidate is CanvasNodeRecord => Boolean(candidate));
      const nextBefore =
        !reachable.has(node.id) || predecessors.length === 0
          ? cloneSet(reserved)
          : intersectSets(
              predecessors.map(
                (predecessor) =>
                  availableAfterByNodeId.get(predecessor.id) ?? reserved
              )
            );
      const nextAfter = unionSets(nextBefore, getNodeOutputNames(node));
      const previousBefore = availableBeforeByNodeId.get(node.id) ?? new Set();
      const previousAfter = availableAfterByNodeId.get(node.id) ?? new Set();
      if (!setsEqual(previousBefore, nextBefore)) {
        availableBeforeByNodeId.set(node.id, nextBefore);
        changed = true;
      }
      if (!setsEqual(previousAfter, nextAfter)) {
        availableAfterByNodeId.set(node.id, nextAfter);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return {
    availableBeforeByNodeId,
    fieldsByName,
  };
}

function makeEntry(
  nodes: CanvasNodeRecord[],
  edges: CanvasEdgeRecord[]
): CanvasEntry {
  return {
    id: "local-dataflow",
    name: "Local dataflow",
    freeText: "",
    graph: {
      nodes,
      edges,
    },
  };
}

export function collectAvailableLocalValueNames(
  entry: CanvasEntry,
  nodeId: string
): string[] {
  const analysis = analyzeLocalDataflow(entry);
  return Array.from(analysis.availableBeforeByNodeId.get(nodeId) ?? []);
}

export function collectAvailableLocalFields(
  entry: CanvasEntry,
  nodeId: string
): CanvasAvailableLocalField[] {
  const analysis = analyzeLocalDataflow(entry);
  return Array.from(analysis.availableBeforeByNodeId.get(nodeId) ?? [])
    .map((name) => analysis.fieldsByName.get(name))
    .filter((field): field is CanvasAvailableLocalField => Boolean(field));
}

export function collectAvailableCanvasLocalValueNames(args: {
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
  nodeId: string;
}): string[] {
  return collectAvailableLocalValueNames(
    makeEntry(args.nodes, args.edges),
    args.nodeId
  );
}

export function collectAvailableCanvasLocalFields(args: {
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
  nodeId: string;
}): CanvasAvailableLocalField[] {
  return collectAvailableLocalFields(
    makeEntry(args.nodes, args.edges),
    args.nodeId
  );
}
