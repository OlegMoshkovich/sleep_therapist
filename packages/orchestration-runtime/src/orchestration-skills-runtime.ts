import {
  normalizeCanvasDoc,
  type CanvasDoc,
  type CanvasEdgeRecord,
  type CanvasEntry,
  type CanvasNodeRecord,
} from "@airlab/canvas-compiler/types";

export const SKILL_CONDITION_TRUE_OUTPUT = "__skill_condition_true__";
export const SKILL_CONDITION_FALSE_OUTPUT = "__skill_condition_false__";

function findTerminalConditionNodes(entry: CanvasEntry): CanvasNodeRecord[] {
  const outgoingSources = new Set(entry.graph.edges.map((edge) => edge.source));
  return entry.graph.nodes.filter(
    (node) => node.type === "condition" && !outgoingSources.has(node.id)
  );
}

export function prepareSkillConditionCanvasDoc(args: {
  doc: CanvasDoc | null;
  skillName: string;
  phase: "start" | "termination";
}): CanvasDoc {
  const normalizedDoc = normalizeCanvasDoc(args.doc);
  const rootCanvas = normalizedDoc?.canvases[0];
  if (!normalizedDoc || !rootCanvas) {
    throw new Error(
      `${args.skillName} is missing a ${args.phase} condition canvas.`
    );
  }

  const terminalConditions = findTerminalConditionNodes(rootCanvas);
  if (terminalConditions.length !== 1) {
    throw new Error(
      `${args.skillName} ${args.phase} condition canvas must end with exactly one Condition node.`
    );
  }

  const condition = terminalConditions[0]!;
  const trueOutputId = `${condition.id}__skill_true_output`;
  const falseOutputId = `${condition.id}__skill_false_output`;
  const nextNodes: CanvasNodeRecord[] = [
    ...rootCanvas.graph.nodes,
    {
      id: trueOutputId,
      type: "prompt",
      position: {
        x: condition.position.x - 120,
        y: condition.position.y + 180,
      },
      data: {
        label: `Return exactly ${SKILL_CONDITION_TRUE_OUTPUT}.`,
        actionType: "prompt",
      },
    },
    {
      id: falseOutputId,
      type: "prompt",
      position: {
        x: condition.position.x + 120,
        y: condition.position.y + 180,
      },
      data: {
        label: `Return exactly ${SKILL_CONDITION_FALSE_OUTPUT}.`,
        actionType: "prompt",
      },
    },
  ];
  const nextEdges: CanvasEdgeRecord[] = [
    ...rootCanvas.graph.edges,
    {
      id: `${condition.id}__skill_true_edge`,
      source: condition.id,
      target: trueOutputId,
      sourceHandle: "true",
    },
    {
      id: `${condition.id}__skill_false_edge`,
      source: condition.id,
      target: falseOutputId,
      sourceHandle: "false",
    },
  ];

  return {
    ...normalizedDoc,
    canvases: normalizedDoc.canvases.map((canvas, index) =>
      index === 0
        ? {
            ...canvas,
            graph: {
              nodes: nextNodes,
              edges: nextEdges,
            },
          }
        : canvas
    ),
  };
}

export function skillConditionOutputIsTrue(output: string): boolean {
  return output.trim() === SKILL_CONDITION_TRUE_OUTPUT;
}
