import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

function StartNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`px-4 py-3 text-sm font-sans bg-[#eef1eb] border border-[#B0BEA5] text-[#3d4a35] rounded-none shadow-none w-[280px] ${
        selected ? "ring-2 ring-[#B0BEA5]" : ""
      }`}
    >
      <div className="rf-node-title mb-1 text-left text-[#3d4a35]">
        Start
      </div>
      <ClampedNodeText
        className="leading-relaxed text-left"
        lines={8}
        title={data.label || "Describe the starting point for this canvas..."}
      >
        {data.label || "Describe the starting point for this canvas..."}
      </ClampedNodeText>
      <Handle type="source" position={Position.Bottom} className="!bg-[#B0BEA5]" />
    </div>
  );
}

export const START: NodeKindDef = {
  kind: "start",
  toolbarLabel: "+ Start",
  toolbarDescription: "Entry point and system prompt for this canvas.",
  toolbarClassName:
    "border border-[#B0BEA5] text-[#1c1b16] bg-[#B0BEA5] hover:bg-[#9aab8f]",
  component: StartNode,
  defaultLabel:
    "You are a calm, helpful sleep assistant. You will be given the current conversation inputs plus an already-updated sleeper state. Use the updated state to decide the next assistant step.",
  singleton: true,
  inspector: {
    labelTitle: "Prompt",
    textareaRows: 10,
  },
};
