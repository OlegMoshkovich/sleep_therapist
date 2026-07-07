import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

const baseClass =
  "px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[9rem] max-w-[15rem] text-center";

function YieldNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`${baseClass} bg-amber-50 border-amber-600 text-amber-950 ${
        selected ? "ring-2 ring-amber-500" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-amber-600" />
      <div className="text-[10px] uppercase tracking-widest text-amber-700 mb-0.5">
        End turn
      </div>
      <ClampedNodeText
        className="font-medium"
        lines={4}
        title={data.label || "pause here; continue on the next event"}
      >
        {data.label || "pause here; continue on the next event"}
      </ClampedNodeText>
    </div>
  );
}

export const YIELD_TURN: NodeKindDef = {
  kind: "yield",
  toolbarLabel: "+ End turn",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-3 py-2 border border-amber-600 text-amber-950 bg-amber-50 hover:bg-amber-100 rounded",
  component: YieldNode,
  defaultLabel: "pause here; continue on the next event",
  inspector: {
    labelTitle: "Turn response",
    helpText:
      "Ends only the current visible turn. Use this when the run should remain resumable, for example while waiting on a user reply or an async job.",
    textareaRows: 2,
  },
};
