import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

function StartNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`px-4 py-3 text-sm font-sans bg-emerald-50 border-2 border-emerald-400 text-emerald-950 rounded-lg shadow-sm w-[280px] ${
        selected ? "ring-2 ring-emerald-500" : ""
      }`}
    >
      <div className="text-[10px] uppercase tracking-widest text-emerald-700 mb-1 text-center">
        Start
      </div>
      <ClampedNodeText
        className="leading-relaxed text-left"
        lines={8}
        title={data.label || "Describe the starting point for this canvas..."}
      >
        {data.label || "Describe the starting point for this canvas..."}
      </ClampedNodeText>
      <Handle type="source" position={Position.Bottom} className="!bg-emerald-500" />
    </div>
  );
}

export const START: NodeKindDef = {
  kind: "start",
  toolbarLabel: "+ Start",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-3 py-2 border border-emerald-400 text-emerald-900 bg-emerald-50 hover:bg-emerald-100 rounded",
  component: StartNode,
  defaultLabel: "Start",
  hideFromToolbar: true,
  singleton: true,
  inspector: {
    labelTitle: "General-purpose prompt",
    helpText:
      "This text is prepended to this canvas as the “General-purpose prompt” the model sees before the flow.",
    textareaRows: 10,
  },
};
