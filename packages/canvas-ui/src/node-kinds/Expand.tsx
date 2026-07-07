import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

const baseClass =
  "px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[9rem] max-w-[16rem] text-center";

function ExpandNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`${baseClass} bg-emerald-600 border-emerald-700 text-emerald-50 ${
        selected ? "ring-2 ring-emerald-400" : ""
      }`}
      style={{ boxShadow: "inset 0 0 0 2px #ecfdf5" }}
    >
      <Handle type="target" position={Position.Top} className="!bg-emerald-700" />
      <div className="text-[10px] uppercase tracking-widest text-emerald-100 mb-0.5">
        Subtree reference
      </div>
      <ClampedNodeText
        className="font-medium"
        lines={4}
        title={data.label || "(referenced canvas name)"}
      >
        {data.label || "(referenced canvas name)"}
      </ClampedNodeText>
      <Handle type="source" position={Position.Bottom} className="!bg-emerald-700" />
    </div>
  );
}

export const EXPAND: NodeKindDef = {
  kind: "expand",
  toolbarLabel: "+ Expand",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-3 py-2 border border-emerald-700 text-emerald-50 bg-emerald-600 hover:bg-emerald-700 rounded",
  component: ExpandNode,
  defaultLabel: "Referenced canvas name",
  inspector: {
    labelTitle: "Referenced canvas name",
    helpText: "Use the name of the canvas whose subtree should be inserted here.",
    textareaRows: 2,
  },
};
