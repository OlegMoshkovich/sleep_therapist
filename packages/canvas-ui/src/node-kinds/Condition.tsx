import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

const baseClass =
  "relative px-3 py-2 text-sm font-sans border rounded-none shadow-sm min-w-[9rem] max-w-[16rem] text-left";

function ConditionNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`${baseClass} bg-[#FFD100] border-[#FFD100] text-[#3d3838] ${
        selected ? "ring-2 ring-[#FFD100]" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-[#FFD100]" />
      <div>
        <div className="rf-node-title mb-0.5 text-left text-[#3d3838]">If</div>
        <ClampedNodeText
          className="text-[12px]"
          lines={4}
          title={data.label || "condition?"}
        >
          {data.label || "condition?"}
        </ClampedNodeText>
      </div>
      <Handle
        id="true"
        type="source"
        position={Position.Right}
        className="!bg-green-600"
        style={{ top: "40%" }}
      />
      <Handle id="false" type="source" position={Position.Bottom} className="!bg-red-500" />
    </div>
  );
}

export const CONDITION: NodeKindDef = {
  kind: "condition",
  toolbarLabel: "+ Condition",
  toolbarDescription: "Branch true or false based on a condition.",
  toolbarClassName:
    "border border-[#FFD100] text-[#3d3838] bg-[#FFD100] hover:bg-[#f0c400]",
  component: ConditionNode,
  defaultLabel: "new condition?",
  sourceHandles: [
    { id: "true", label: "true" },
    { id: "false", label: "false" },
  ],
  inspector: {
    labelTitle: "Condition",
  },
};
