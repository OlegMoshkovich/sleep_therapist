import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

const baseClass =
  "px-3 py-2 text-sm font-sans border rounded-none shadow-sm min-w-[9rem] max-w-[16rem] text-left";

function ExpandNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`${baseClass} bg-[#445A1E] border-[#445A1E] text-white ${
        selected ? "ring-2 ring-[#B9C2B0]" : ""
      }`}
      style={{ boxShadow: "inset 0 0 0 2px rgba(185,194,176,0.35)" }}
    >
      <Handle type="target" position={Position.Top} className="!bg-[#445A1E]" />
      <div className="rf-node-title mb-0.5 text-left text-white">
        Subtree reference
      </div>
      <ClampedNodeText
        className="font-medium"
        lines={4}
        title={data.label || "(referenced canvas name)"}
      >
        {data.label || "(referenced canvas name)"}
      </ClampedNodeText>
      <Handle type="source" position={Position.Bottom} className="!bg-[#445A1E]" />
    </div>
  );
}

export const EXPAND: NodeKindDef = {
  kind: "expand",
  toolbarLabel: "+ Expand",
  toolbarDescription: "Reference another canvas as a subtree.",
  toolbarClassName:
    "border border-[#445A1E] text-white bg-[#445A1E] hover:bg-[#364816]",
  component: ExpandNode,
  defaultLabel: "Referenced canvas name",
  inspector: {
    labelTitle: "Canvas name",
    textareaRows: 2,
  },
};
