import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

const baseClass =
  "relative px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[9rem] max-w-[16rem] text-center";

function ConditionNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`${baseClass} bg-amber-50 border-amber-400 text-amber-900 ${
        selected ? "ring-2 ring-amber-500" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-amber-500" />
      <div>
        <div className="text-[10px] uppercase tracking-widest text-amber-700 mb-0.5">If</div>
        <ClampedNodeText
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
      <span className="pointer-events-none absolute right-[-2.35rem] top-[40%] -translate-y-1/2 text-[9px] font-semibold uppercase tracking-wider text-green-700">
        true
      </span>
      <Handle id="false" type="source" position={Position.Bottom} className="!bg-red-500" />
      <span className="pointer-events-none absolute bottom-[-1.15rem] left-1/2 -translate-x-1/2 text-[9px] font-semibold uppercase tracking-wider text-red-700">
        false
      </span>
    </div>
  );
}

export const CONDITION: NodeKindDef = {
  kind: "condition",
  toolbarLabel: "+ Condition",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-amber-400 text-amber-900 bg-amber-50 hover:bg-amber-100 rounded-full",
  component: ConditionNode,
  defaultLabel: "new condition?",
  sourceHandles: [
    { id: "true", label: "true" },
    { id: "false", label: "false" },
  ],
  inspector: {
    labelTitle: "Condition",
    helpText:
      'Use plain field conditions like "status is ready" for state fields, and use "local value_name is true" when the branch depends on a downstream local value from an earlier prompt, tool, or runtime step.',
  },
};
