import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

const baseClass =
  "px-3 py-2 text-sm font-sans border rounded-none shadow-sm min-w-[9rem] max-w-[15rem] text-left";

function TerminateNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`${baseClass} bg-[#F00E26] border-[#F00E26] text-white ${
        selected ? "ring-2 ring-[#F00E26]" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-[#F00E26]" />
      <div className="rf-node-title mb-0.5 text-left text-white">
        Terminate
      </div>
      <ClampedNodeText
        className="font-medium"
        lines={4}
        title={data.label || "task complete; no future turns"}
      >
        {data.label || "task complete; no future turns"}
      </ClampedNodeText>
    </div>
  );
}

export const TERMINATE: NodeKindDef = {
  kind: "terminate",
  toolbarLabel: "+ Terminate",
  toolbarDescription: "End the session with a final message.",
  toolbarClassName:
    "border border-[#F00E26] text-white bg-[#F00E26] hover:bg-[#d40c21]",
  component: TerminateNode,
  defaultLabel: "task complete; no future turns",
  inspector: {
    labelTitle: "Message",
    textareaRows: 3,
  },
};
