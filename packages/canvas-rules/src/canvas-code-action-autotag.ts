import {
  getNodeActionSubtype,
  type ActionSubtype,
} from "@airlab/canvas-core/components/canvas/action-subtype";
import { normalizePromptOutputFields } from "@airlab/canvas-core/components/canvas/prompt-output-fields";
import type {
  CanvasDoc,
  CanvasNodeRecord,
} from "@airlab/canvas-compiler/types";
import { getRuntimeOperationKindFromNode } from "@airlab/canvas-compiler/types";
import type { RuntimeStateField } from "@airlab/canvas-planner/canvas-hybrid-runtime";
import { readExplicitNodeExecutableStateCodeOps } from "@airlab/canvas-core/lib/canvas-node-code-ops";
import { nodeHasExecutableCodeSource } from "@airlab/canvas-core/lib/canvas-node-code-script";
import { parseStateActionLabel } from "@airlab/canvas-planner/canvas-structural-planner";

export type AutomaticCanvasActionSubtype = Extract<ActionSubtype, "code" | "prompt">;

function readActionTypeSource(node: CanvasNodeRecord): "auto" | "manual" | "" {
  const actionTypeSource =
    typeof node.data?.actionTypeSource === "string"
      ? node.data.actionTypeSource.trim()
      : "";
  return actionTypeSource === "auto" || actionTypeSource === "manual"
    ? actionTypeSource
    : "";
}

export function inferAutomaticCanvasActionSubtype(
  node: CanvasNodeRecord,
  stateSchema: RuntimeStateField[]
): AutomaticCanvasActionSubtype | null {
  if (node.type !== "action" && node.type !== "prompt" && node.type !== "code") {
    return null;
  }

  if (getRuntimeOperationKindFromNode(node)) {
    return null;
  }

  const normalizedActionType = getNodeActionSubtype(node);
  if (
    normalizedActionType === "tool_call" ||
    normalizedActionType === "display" ||
    normalizedActionType === "prompt_transform"
  ) {
    return null;
  }

  if (normalizePromptOutputFields(node.data?.promptOutputFields).length > 0) {
    return "prompt";
  }

  if (readExplicitNodeExecutableStateCodeOps(node, stateSchema)) {
    return "code";
  }

  if (nodeHasExecutableCodeSource(node)) {
    return "code";
  }

  return parseStateActionLabel(String(node.data?.label ?? ""), stateSchema)
    ? "code"
    : "prompt";
}

export function autoTagCanvasActionSubtypes(
  doc: CanvasDoc | null,
  stateSchema: RuntimeStateField[]
): CanvasDoc | null {
  if (!doc) {
    return doc;
  }

  let changed = false;

  const canvases = doc.canvases.map((canvas) => {
    let canvasChanged = false;
    const nodes = canvas.graph.nodes.map((node) => {
      const inferredSubtype = inferAutomaticCanvasActionSubtype(node, stateSchema);
      const currentActionType = getNodeActionSubtype(node);
      const currentActionTypeSource = readActionTypeSource(node);

      if (inferredSubtype === null) {
        if (
          currentActionTypeSource !== "auto" ||
          (currentActionType !== "code" && currentActionType !== "prompt")
        ) {
          return node;
        }

        changed = true;
        canvasChanged = true;
        const nextData = { ...node.data };
        nextData.actionType = "prompt";
        delete nextData.actionTypeSource;
        return {
          ...node,
          type: "prompt",
          data: nextData,
        };
      }

      if (
        currentActionType === inferredSubtype &&
        currentActionTypeSource === "auto"
      ) {
        return node;
      }

      changed = true;
      canvasChanged = true;
      return {
        ...node,
        type: inferredSubtype === "code" ? "code" : "prompt",
        data: {
          ...node.data,
          actionType: inferredSubtype,
          actionTypeSource: "auto",
        },
      };
    });

    return canvasChanged
      ? {
          ...canvas,
          graph: {
            ...canvas.graph,
            nodes,
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
