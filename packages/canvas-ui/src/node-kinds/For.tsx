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

function ForNode({ data, selected }: NodeProps<CanvasNode>) {
  const maxIterations = readMaxIterations(data as LoopNodeData);

  return (
    <div
      className={`px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[10rem] max-w-[17rem] text-center bg-lime-50 border-lime-500 text-lime-950 ${
        selected ? "ring-2 ring-lime-500" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-lime-600" />
      <div className="text-[10px] uppercase tracking-widest text-lime-800 mb-0.5">For</div>
      <ClampedNodeText
        className="text-xs leading-snug"
        lines={4}
        title={data.label?.trim() || "Repeat the body."}
      >
        {data.label?.trim() || "Repeat the body."}
      </ClampedNodeText>
      <div className="mt-2 text-[10px] uppercase tracking-widest text-lime-700">
        Max {maxIterations}
      </div>
      <Handle
        id="body"
        type="source"
        position={Position.Right}
        className="!bg-lime-700"
        style={{ top: "42%" }}
      />
      <Handle id="done" type="source" position={Position.Bottom} className="!bg-stone-500" />
    </div>
  );
}

const fieldLabel = "block text-[10px] uppercase tracking-widest text-gray-500 font-sans mt-2";
const input =
  "w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-2 py-1.5 text-xs font-mono text-gray-800 focus:outline-none focus:border-gray-500";

export const FOR: NodeKindDef = {
  kind: "for",
  toolbarLabel: "+ For",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-3 py-2 border border-lime-500 text-lime-900 bg-lime-50 hover:bg-lime-100 rounded",
  component: ForNode,
  defaultLabel: "Repeat the body.",
  sourceHandles: [
    { id: "body", label: "body" },
    { id: "done", label: "done" },
  ],
  inspector: {
    labelTitle: "Loop note",
    helpText:
      "FOR runs its body branch up to max iterations, then continues through the done branch. The label is descriptive only.",
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
