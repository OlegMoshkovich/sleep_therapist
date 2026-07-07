import {
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
} from "@airlab/canvas-core/lib/canvas-flow-values";
import {
  getNodeActionSubtype,
  normalizeDisplayNodeType,
  normalizePromptNodeSubtype,
} from "@airlab/canvas-core/components/canvas/action-subtype";
import { normalizeNodeExecutableCodeSourceNode } from "@airlab/canvas-core/lib/canvas-node-code-script";
import type { ToolDispatchConfig } from "./tool-types";

export interface CanvasNodeRecord {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { label: string } & Record<string, unknown>;
}

export const CANVAS_NODE_NON_EDITABLE_DATA_KEY = "nonEditable";
export const CANVAS_NODE_NON_EDITABLE_REASON_DATA_KEY = "nonEditableReason";

export type RuntimeOperationNodeKind =
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
  | "raise_error";

export interface CanvasEdgeRecord {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
}

export interface CanvasIoEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: unknown;
}

export interface CanvasGraph {
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
}

export interface CanvasEntry {
  id: string;
  name: string;
  graph: CanvasGraph;
  freeText: string;
}

export interface CanvasDoc {
  version: 2;
  activeId: string;
  canvases: CanvasEntry[];
}

export type CanvasNode = CanvasNodeRecord;

export function isRuntimeOperationNodeKind(
  kind: string
): kind is RuntimeOperationNodeKind {
  return (
    kind === "read_async_job" ||
    kind === "await_async_job" ||
    kind === "build_default_primary_state_schema" ||
    kind === "build_default_environment_state_schema" ||
    kind === "build_initial_canvas_shape_materialization_requests" ||
    kind === "materialize_initial_canvas_structures" ||
    kind === "merge_materialized_initial_canvas_structures" ||
    kind === "prepare_canvas_rule_detection_requests" ||
    kind === "build_canvas_rule_repair_requests" ||
    kind === "apply_canvas_rule_repairs" ||
    kind === "prepare_canvas_rule_recheck_requests" ||
    kind === "finalize_canvas_rule_repair_pass" ||
    kind === "apply_structured_patch" ||
    kind === "scaffold_tools" ||
    kind === "sync_derived_prompts" ||
    kind === "repair_canvas_rules" ||
    kind === "finalize_assistant_reply" ||
    kind === "raise_error"
  );
}

export function getRuntimeOperationKindFromNode(
  node: { type?: string | null; data?: Record<string, unknown> | null }
): RuntimeOperationNodeKind | null {
  const nodeType = typeof node.type === "string" ? node.type : "";
  if (isRuntimeOperationNodeKind(nodeType)) {
    return nodeType;
  }

  if (nodeType !== "action") {
    return null;
  }

  const actionType =
    typeof node.data?.actionType === "string" ? node.data.actionType.trim() : "";
  return isRuntimeOperationNodeKind(actionType) ? actionType : null;
}

export function normalizeRuntimeOperationNodeRecord(
  node: CanvasNodeRecord
): CanvasNodeRecord {
  const runtimeOperation = getRuntimeOperationKindFromNode(node);
  if (!runtimeOperation) {
    return node;
  }

  const defaultLabel =
    runtimeOperation === "read_async_job"
      ? "Load the latest status for a previously queued async job into local variables."
      : runtimeOperation === "await_async_job"
        ? "Poll a previously queued async job until it finishes or the timeout elapses."
      : runtimeOperation === "build_default_primary_state_schema"
      ? "Build the default primary-agent state schema for first-draft seeding before planner extras are merged."
      : runtimeOperation === "build_default_environment_state_schema"
        ? "Build the default environment-agent state schemas for any planner-requested environment agents before planner extras are merged."
        : runtimeOperation ===
            "build_initial_canvas_shape_materialization_requests"
          ? "Build the local initial-canvas-shape materialization requests from the current structured planner patch without changing the carried planner JSON."
        : runtimeOperation === "materialize_initial_canvas_structures"
          ? "If the structured planner patch still contains abstract initial canvas shapes, ask a model to materialize them into concrete InitialCanvasStructure IR before patch application."
        : runtimeOperation ===
            "merge_materialized_initial_canvas_structures"
          ? "Merge the local materialized InitialCanvasStructure IR back into the carried structured planner patch."
        : runtimeOperation === "prepare_canvas_rule_detection_requests"
          ? "Inspect the current draft canvases in code, canonicalize them, and build local model-detection requests for the canvas-rule repair pass."
        : runtimeOperation === "build_canvas_rule_repair_requests"
          ? "Build local canvas-rule repair requests from the detected issues and the current inspected canvas summaries."
        : runtimeOperation === "apply_canvas_rule_repairs"
          ? "Apply the local model-proposed canvas-rule repair edits to the inspected draft canvases."
        : runtimeOperation === "prepare_canvas_rule_recheck_requests"
          ? "Re-inspect the repaired draft canvases in code, canonicalize them again if needed, and build local recheck requests for the final canvas-rule pass."
        : runtimeOperation === "finalize_canvas_rule_repair_pass"
          ? "Publish the canvas-rule repair pass results, merge any repair summary into the carried planner reply, and expose whether another visible retry pass is still needed."
        : runtimeOperation === "apply_structured_patch"
      ? "Apply the structured planner patch to the target draft."
      : runtimeOperation === "scaffold_tools"
        ? "Synthesize requested tools, add any needed dataset hooks, and append tool canvases."
        : runtimeOperation === "sync_derived_prompts"
          ? "Recompile the draft's derived policy and state prompts after structural edits."
          : runtimeOperation === "repair_canvas_rules"
            ? "Check the draft for canvas-rule violations, ask a model for the needed structured repairs, apply those repairs in code, and report whether another repair pass is still needed."
          : runtimeOperation === "raise_error"
            ? "Abort policy execution and raise an explicit runtime error."
            : "Finalize the visible assistant reply so it only claims concrete updates when the workflow actually applied them.";

  const nodeData = { ...(node.data ?? {}) };
  const label =
    typeof nodeData.label === "string" && nodeData.label.trim()
      ? nodeData.label
      : defaultLabel;
  const hadLegacyActionType = "actionType" in nodeData;
  delete nodeData.actionType;

  if (node.type === runtimeOperation && !hadLegacyActionType) {
    return node;
  }

  return {
    ...node,
    type: runtimeOperation,
    data: {
      ...nodeData,
      label,
    },
  };
}

function normalizeLegacyActionNodeRecord(node: CanvasNodeRecord): CanvasNodeRecord {
  const nodeData = { ...(node.data ?? {}) };

  const makeDisplayNode = (
    displayType: "text" | "video",
    data: Record<string, unknown>
  ): CanvasNodeRecord => {
    const displayData = { ...data };
    delete displayData.actionType;
    delete displayData.actionTypeSource;
    const normalizedDisplayType = normalizeDisplayNodeType(displayType);
    const inputVariable =
      typeof displayData.inputVariable === "string" &&
      displayData.inputVariable.trim()
        ? displayData.inputVariable.trim()
        : CARRIED_OUTPUT_PROMPT_VALUE_NAME;
    const label =
      typeof displayData.label === "string" ? displayData.label : node.data.label;
    return {
      ...node,
      type: "display",
      data: {
        ...displayData,
        label,
        displayType: normalizedDisplayType,
        ...(normalizedDisplayType === "text" ? { inputVariable } : {}),
      },
    };
  };

  if (node.type === "display") {
    const displayType = normalizeDisplayNodeType(nodeData.displayType);
    const inputVariable =
      typeof nodeData.inputVariable === "string" && nodeData.inputVariable.trim()
        ? nodeData.inputVariable.trim()
        : CARRIED_OUTPUT_PROMPT_VALUE_NAME;
    delete nodeData.actionType;
    delete nodeData.actionTypeSource;
    return {
      ...node,
      data: {
        ...nodeData,
        displayType,
        ...(displayType === "text" ? { inputVariable } : {}),
      },
    };
  }

  if (node.type === "prompt") {
    if (normalizeDisplayNodeType(nodeData.displayType) === "video") {
      return makeDisplayNode("video", nodeData);
    }
    if (getNodeActionSubtype(node) === "display") {
      return makeDisplayNode("text", nodeData);
    }
    const promptType = normalizePromptNodeSubtype(nodeData.actionType);
    const inputVariable =
      typeof nodeData.inputVariable === "string" && nodeData.inputVariable.trim()
        ? nodeData.inputVariable.trim()
        : CARRIED_OUTPUT_PROMPT_VALUE_NAME;
    if (
      nodeData.actionType === promptType &&
      (promptType !== "prompt_transform" || nodeData.inputVariable === inputVariable)
    ) {
      return node;
    }
    return {
      ...node,
      data: {
        ...nodeData,
        actionType: promptType,
        ...(promptType === "prompt_transform" ? { inputVariable } : {}),
      },
    };
  }

  if (node.type === "code") {
    if (nodeData.actionType === "code") {
      return node;
    }
    return {
      ...node,
      data: {
        ...nodeData,
        actionType: "code",
      },
    };
  }

  if (node.type === "tool_call") {
    if (nodeData.sourceType === "video") {
      return makeDisplayNode("video", {
        ...nodeData,
        videoUrl:
          typeof nodeData.videoUrl === "string" && nodeData.videoUrl.trim()
            ? nodeData.videoUrl
            : nodeData.url,
      });
    }
    if (!("actionType" in nodeData) && !("actionTypeSource" in nodeData)) {
      return node;
    }
    delete nodeData.actionType;
    delete nodeData.actionTypeSource;
    return {
      ...node,
      data: nodeData,
    };
  }

  if (node.type !== "action") {
    return node;
  }

  const rawActionType =
    typeof nodeData.actionType === "string" ? nodeData.actionType.trim() : "";
  const actionType = getNodeActionSubtype(node);
  if (rawActionType === "video") {
    return makeDisplayNode("video", {
      ...nodeData,
      videoUrl:
        typeof nodeData.videoUrl === "string" && nodeData.videoUrl.trim()
          ? nodeData.videoUrl
          : nodeData.url,
    });
  }

  if (actionType === "tool_call") {
    delete nodeData.actionType;
    delete nodeData.actionTypeSource;
    return {
      ...node,
      type: "tool_call",
      data: nodeData,
    };
  }

  if (actionType === "code") {
    return {
      ...node,
      type: "code",
      data: {
        ...nodeData,
        actionType: "code",
      },
    };
  }

  if (actionType === "display") {
    return makeDisplayNode("text", nodeData);
  }

  const promptType =
    actionType === "prompt_transform"
      ? actionType
      : "prompt";

  return {
    ...node,
    type: "prompt",
    data: {
      ...nodeData,
      actionType: promptType,
    },
  };
}

export function normalizeCanvasNodeRecord(node: CanvasNodeRecord): CanvasNodeRecord {
  const normalized = normalizeLegacyActionNodeRecord(
    normalizeNodeExecutableCodeSourceNode(
      normalizeRuntimeOperationNodeRecord(node)
    )
  );
  const reason =
    typeof normalized.data?.[CANVAS_NODE_NON_EDITABLE_REASON_DATA_KEY] === "string"
      ? normalized.data[CANVAS_NODE_NON_EDITABLE_REASON_DATA_KEY].trim()
      : "";
  if (
    reason !== "Runtime-managed policy action commit." &&
    reason !== "Runtime-managed state ingress append."
  ) {
    return normalized;
  }

  const nextData = { ...normalized.data };
  delete nextData[CANVAS_NODE_NON_EDITABLE_DATA_KEY];
  delete nextData[CANVAS_NODE_NON_EDITABLE_REASON_DATA_KEY];
  return {
    ...normalized,
    data: nextData,
  };
}

function inferBranchSourceHandle(
  sourceNode: CanvasNodeRecord | undefined,
  edge: CanvasEdgeRecord
): string | null {
  const existing =
    typeof edge.sourceHandle === "string"
      ? edge.sourceHandle.trim()
      : edge.sourceHandle ?? "";
  if (existing) {
    return null;
  }

  const label = typeof edge.label === "string" ? edge.label.trim().toLowerCase() : "";
  if (!label) {
    return null;
  }

  if (sourceNode?.type === "condition" && (label === "true" || label === "false")) {
    return label;
  }

  if (
    (sourceNode?.type === "for" || sourceNode?.type === "while") &&
    (label === "body" || label === "done")
  ) {
    return label;
  }

  return null;
}

export function normalizeCanvasDoc(doc: CanvasDoc | null): CanvasDoc | null {
  if (!doc) {
    return null;
  }

  let changed = false;
  const canvases = doc.canvases.map((canvas) => {
    let canvasChanged = false;
    const removedNodeIds = new Set(
      canvas.graph.nodes
        .filter((node) => node.type === "end")
        .map((node) => node.id)
    );
    if (removedNodeIds.size > 0) {
      changed = true;
      canvasChanged = true;
    }

    const nodes = canvas.graph.nodes.flatMap((node) => {
      if (removedNodeIds.has(node.id)) {
        return [];
      }
      const normalized = normalizeCanvasNodeRecord(node);
      if (normalized !== node) {
        changed = true;
        canvasChanged = true;
      }
      return [normalized];
    });
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edges = canvas.graph.edges.flatMap((edge) => {
      if (removedNodeIds.has(edge.source) || removedNodeIds.has(edge.target)) {
        changed = true;
        canvasChanged = true;
        return [];
      }

      let nextEdge = edge;
      if ("kind" in edge) {
        changed = true;
        canvasChanged = true;
        const rest = { ...edge } as CanvasEdgeRecord & { kind?: unknown };
        delete rest.kind;
        nextEdge = rest;
      }

      const sourceHandle = inferBranchSourceHandle(nodeById.get(nextEdge.source), nextEdge);
      if (sourceHandle) {
        changed = true;
        canvasChanged = true;
        nextEdge = {
          ...nextEdge,
          sourceHandle,
        };
      }

      return [nextEdge];
    });

    return canvasChanged
      ? {
          ...canvas,
          graph: {
            ...canvas.graph,
            nodes,
            edges,
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

export interface CompiledToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
  config: ToolDispatchConfig;
}

export interface CompilerResult<TOutput> {
  output: TOutput;
  preview?: string;
  tools?: CompiledToolDef[];
}

export type CompilerFn<TOutput> = (doc: CanvasDoc) => CompilerResult<TOutput>;
