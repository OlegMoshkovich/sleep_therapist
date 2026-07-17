import type { ChangeEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, CanvasNodeData, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

interface LoopNodeData extends CanvasNodeData {
  maxIterations?: number;
}

function readMaxIterations(data: LoopNodeData): number {
  const raw = data.maxIterations;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1
    ? Math.trunc(raw)
    : 3;
}

function handleMaxIterationChange(
  event: ChangeEvent<HTMLInputElement>,
  update: (patch: Partial<CanvasNodeData>) => void
) {
  const raw = event.target.value.trim();
  if (!raw) {
    update({ maxIterations: undefined });
    return;
  }

  const parsed = Number.parseInt(raw, 10);
  update({
    maxIterations:
      Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 12) : 1,
  });
}

function WhileNode({ data, selected }: NodeProps<CanvasNode>) {
  const maxIterations = readMaxIterations(data as LoopNodeData);

  return (
    <div
      className={`px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[10rem] max-w-[17rem] text-center bg-orange-50 border-orange-500 text-orange-950 ${
        selected ? "ring-2 ring-orange-500" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-orange-500" />
      <div>
        <div className="text-[10px] uppercase tracking-widest text-orange-700 mb-0.5">
          While
        </div>
        <ClampedNodeText
          className="text-xs leading-snug"
          lines={4}
          title={data.label || "condition?"}
        >
          {data.label || "condition?"}
        </ClampedNodeText>
        <div className="mt-2 text-[10px] uppercase tracking-widest text-orange-700">
          Max {maxIterations}
        </div>
      </div>
      <Handle
        id="body"
        type="source"
        position={Position.Right}
        className="!bg-orange-600"
        style={{ top: "40%" }}
      />
      <Handle id="done" type="source" position={Position.Bottom} className="!bg-stone-500" />
    </div>
  );
}

const fieldLabel = "block text-[10px] uppercase tracking-widest text-gray-500 font-sans mt-2";
const input =
  "w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-2 py-1.5 text-xs font-mono text-gray-800 focus:outline-none focus:border-gray-500";

export const WHILE: NodeKindDef = {
  kind: "while",
  toolbarLabel: "+ While",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-orange-500 text-orange-900 bg-orange-50 hover:bg-orange-100 rounded-full",
  component: WhileNode,
  defaultLabel: "condition?",
  sourceHandles: [
    { id: "body", label: "body" },
    { id: "done", label: "done" },
  ],
  inspector: {
    labelTitle: "Condition",
    helpText:
      'WHILE uses the same condition syntax as a normal condition node, including "local value_name ..." for downstream local values, but it repeats the body branch only up to max iterations before exiting through done.',
    renderExtra: (data, update) => (
      <div className="pt-2 mt-2 border-t border-[#c0bdb0]">
        <label className={fieldLabel}>Max iterations</label>
        <input
          className={input}
          type="number"
          min={1}
          max={12}
          step={1}
          value={readMaxIterations(data as LoopNodeData)}
          onChange={(event) => handleMaxIterationChange(event, update)}
        />
      </div>
    ),
  },
};
