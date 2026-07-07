import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

const SIDE_HANDLE_OFFSETS = ["18%", "34%", "50%", "66%", "82%"];
const LOOP_SOURCE_HANDLE_OFFSETS = ["24%", "38%", "52%", "66%", "80%"];
const LOOP_TARGET_HANDLE_OFFSETS = ["16%", "30%", "44%", "58%", "72%"];
const HANDLE_CLASS =
  "!h-2.5 !w-2.5 !border-2 !border-white !bg-teal-600";
const LOOP_HANDLE_CLASS =
  "!h-2.5 !w-2.5 !border-2 !border-white !bg-teal-700";
const LEGACY_HANDLE_CLASS =
  "!h-1 !w-1 !border-0 !bg-transparent !opacity-0";

function StageNode({ data, selected }: NodeProps<CanvasNode>) {
  const childWorkflowCanvasName =
    typeof data.childWorkflowCanvasName === "string"
      ? data.childWorkflowCanvasName.trim()
      : "";

  return (
    <div
      className={`relative w-[290px] rounded-lg border-2 border-teal-500 bg-teal-50 px-4 py-3 text-left font-sans text-sm text-teal-950 shadow-sm ${
        selected ? "ring-2 ring-teal-600" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className={HANDLE_CLASS} />
      {SIDE_HANDLE_OFFSETS.map((offset, index) => (
        <Handle
          key={`workflow-previous-${index}`}
          id={`workflow-previous-${index}`}
          type="target"
          position={Position.Left}
          className={HANDLE_CLASS}
          style={{ top: offset }}
        />
      ))}
      {SIDE_HANDLE_OFFSETS.map((offset, index) => (
        <Handle
          key={`workflow-next-${index}`}
          id={`workflow-next-${index}`}
          type="source"
          position={Position.Right}
          className={HANDLE_CLASS}
          style={{ top: offset }}
        />
      ))}
      <Handle
        id="workflow-previous"
        type="target"
        position={Position.Left}
        className={LEGACY_HANDLE_CLASS}
      />
      <Handle
        id="workflow-next"
        type="source"
        position={Position.Right}
        className={LEGACY_HANDLE_CLASS}
      />
      <div className="mb-1 text-[10px] uppercase tracking-widest text-teal-700">
        Stage
      </div>
      <ClampedNodeText
        className="whitespace-pre-line leading-relaxed"
        lines={10}
        title={data.label || "Describe this workflow stage..."}
      >
        {data.label || "Describe this workflow stage..."}
      </ClampedNodeText>
      {childWorkflowCanvasName ? (
        <div className="mt-2 rounded border border-teal-200 bg-white/70 px-2 py-1 text-[11px] font-medium text-teal-800">
          Child workflow: {childWorkflowCanvasName}
        </div>
      ) : null}
      {LOOP_TARGET_HANDLE_OFFSETS.map((offset, index) => (
        <Handle
          key={`workflow-loop-target-${index}`}
          id={`workflow-loop-target-${index}`}
          type="target"
          position={Position.Bottom}
          className={LOOP_HANDLE_CLASS}
          style={{ left: offset }}
        />
      ))}
      {LOOP_SOURCE_HANDLE_OFFSETS.map((offset, index) => (
        <Handle
          key={`workflow-loop-${index}`}
          id={`workflow-loop-${index}`}
          type="source"
          position={Position.Bottom}
          className={LOOP_HANDLE_CLASS}
          style={{ left: offset }}
        />
      ))}
      <Handle
        id="workflow-loop-target"
        type="target"
        position={Position.Bottom}
        className={LEGACY_HANDLE_CLASS}
      />
      <Handle
        id="workflow-loop"
        type="source"
        position={Position.Bottom}
        className={LEGACY_HANDLE_CLASS}
      />
    </div>
  );
}

export const STAGE: NodeKindDef = {
  kind: "stage",
  toolbarLabel: "+ Stage",
  toolbarClassName:
    "rounded border border-teal-500 bg-teal-50 px-3 py-2 text-xs font-sans uppercase tracking-widest text-teal-900 hover:bg-teal-100",
  component: StageNode,
  defaultLabel: "Stage: new workflow stage",
  inspector: {
    labelTitle: "Stage description",
    helpText:
      "A workflow-stage node for the Overall Workflow canvas. Use it for stage name, purpose, entry/completion conditions, participants, and stage notes.",
    textareaRows: 10,
  },
};
