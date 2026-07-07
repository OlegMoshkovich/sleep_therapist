import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

const baseClass =
  "px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[9rem] max-w-[15rem] text-center";

function TerminateNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`${baseClass} bg-stone-100 border-stone-600 text-stone-950 ${
        selected ? "ring-2 ring-stone-500" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-stone-600" />
      <div className="text-[10px] uppercase tracking-widest text-stone-700 mb-0.5">
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
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-3 py-2 border border-stone-600 text-stone-950 bg-stone-100 hover:bg-stone-200 rounded",
  component: TerminateNode,
  defaultLabel: "task complete; no future turns",
  inspector: {
    labelTitle: "Interaction termination result",
    helpText:
      "Ends the whole interaction, not just the turn. When an external connection id is configured on the node, it terminates that connection and resets its connection-local state instead.",
    textareaRows: 2,
  },
};
