import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

const baseClass =
  "px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[9rem] max-w-[15rem] text-center";

function ContinueNode({ data, selected }: NodeProps<CanvasNode>) {
  const body = data.label || "continue this stage next turn";

  return (
    <div
      className={`${baseClass} bg-sky-50 border-sky-600 text-sky-950 ${
        selected ? "ring-2 ring-sky-500" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-sky-600" />
      <div className="text-[10px] uppercase tracking-widest text-sky-700 mb-0.5">
        Continue
      </div>
      <ClampedNodeText className="font-medium" lines={4} title={body}>
        {body}
      </ClampedNodeText>
    </div>
  );
}

export const CONTINUE_STAGE: NodeKindDef = {
  kind: "continue",
  toolbarLabel: "+ Continue",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-3 py-2 border border-sky-600 text-sky-950 bg-sky-50 hover:bg-sky-100 rounded",
  component: ContinueNode,
  defaultLabel: "continue this stage next turn",
  inspector: {
    labelTitle: "Continuation note",
    helpText:
      "Ends this turn after the current policy action while keeping control in the same stage canvas for the next turn.",
    textareaRows: 2,
  },
};
