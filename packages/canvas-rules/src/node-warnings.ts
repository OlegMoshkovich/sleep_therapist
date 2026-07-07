import type { CanvasNode } from "@airlab/canvas-compiler/types";
import { getCanvasNodeDeclaredOutputFields } from "@airlab/canvas-core/components/canvas/node-declared-outputs";
import type { RuntimeStateField } from "@airlab/canvas-planner/canvas-hybrid-runtime";
import { collectCanvasRuleDiagnostics } from "./canvas-rule-diagnostics";

interface CanvasWarningEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export interface CanvasNodeWarning {
  nodeId: string;
  severity: "error";
  message: string;
  label: string;
}

function displayNodeLabel(node: Pick<CanvasNode, "type" | "data">): string {
  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  return label || node.type?.trim() || "node";
}

function normalizeVariableKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "_");
}

export function collectCanvasNodeWarnings(
  nodes: CanvasNode[],
  edges: CanvasWarningEdge[],
  stateSchema: RuntimeStateField[]
): CanvasNodeWarning[] {
  const warnings: CanvasNodeWarning[] = [];
  const stateFieldsByKey = new Map(
    stateSchema.map((field) => [normalizeVariableKey(field.fieldName), field.fieldName])
  );

  for (const node of nodes) {
    for (const output of getCanvasNodeDeclaredOutputFields(node)) {
      const outputName = output.name.trim();
      if (!outputName) {
        continue;
      }

      const matchingStateField = stateFieldsByKey.get(normalizeVariableKey(outputName));
      if (!matchingStateField) {
        continue;
      }

      warnings.push({
        nodeId: node.id,
        severity: "error",
        label: displayNodeLabel(node),
        message: `${output.origin} "${outputName}" collides with state field "${matchingStateField}". Rename one of them so unprefixed references stay unambiguous.`,
      });
    }
  }

  for (const diagnostic of collectCanvasRuleDiagnostics({
    nodes,
    edges,
    stateSchema,
  })) {
    if (diagnostic.severity !== "error" || !diagnostic.nodeId) {
      continue;
    }

    warnings.push({
      nodeId: diagnostic.nodeId,
      severity: "error",
      label: diagnostic.label || "node",
      message: diagnostic.summary,
    });
  }

  return warnings.filter((warning) => warning.message.trim().length > 0);
}
