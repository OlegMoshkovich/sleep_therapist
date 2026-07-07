export interface CanvasNodeRecord {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { label: string } & Record<string, unknown>;
}

export interface CanvasEdgeRecord {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
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
  node: Pick<CanvasNodeRecord, "type" | "data">
): RuntimeOperationNodeKind | null {
  if (isRuntimeOperationNodeKind(node.type)) {
    return node.type;
  }

  if (node.type !== "action") {
    return null;
  }

  const actionType =
    typeof node.data?.actionType === "string" ? node.data.actionType.trim() : "";
  return isRuntimeOperationNodeKind(actionType) ? actionType : null;
}
