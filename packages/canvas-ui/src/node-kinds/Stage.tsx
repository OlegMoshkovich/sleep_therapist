import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

// Two connection points per side (kept in sync with the runtime slot patterns in
// general-orchestration.ts, which now only assign slots 0 and 1).
const SIDE_HANDLE_OFFSETS = ["33%", "67%"];
const LOOP_SOURCE_HANDLE_OFFSETS = ["40%", "68%"];
const LOOP_TARGET_HANDLE_OFFSETS = ["32%", "60%"];
const HANDLE_CLASS =
  "!h-2.5 !w-2.5 !border-2 !border-white !bg-[#B0BEA5]";
const LOOP_HANDLE_CLASS =
  "!h-2.5 !w-2.5 !border-2 !border-white !bg-[#9aab8f]";
const LEGACY_HANDLE_CLASS =
  "!h-1 !w-1 !border-0 !bg-transparent !opacity-0";

function StageNode({ data, selected }: NodeProps<CanvasNode>) {
  const childWorkflowCanvasName =
    typeof data.childWorkflowCanvasName === "string"
      ? data.childWorkflowCanvasName.trim()
      : "";

  return (
    <div
      className={`relative w-[290px] rounded-none border-2 border-[#C7C7C7] bg-[#C7C7C7] px-4 py-3 text-left font-sans text-sm text-[#3d4a35] shadow-sm ${
        selected ? "ring-2 ring-[#B0BEA5]" : ""
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
      <div className="rf-node-title mb-1 text-left text-[#3d4a35]">
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
        <div className="mt-2 rounded-none border border-[#B0BEA5] bg-white/70 px-2 py-1 text-[11px] font-medium text-[#3d4a35]">
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
  toolbarDescription: "A high-level workflow stage the run can enter.",
  toolbarClassName:
    "rounded-none border border-[#B0BEA5] bg-[#eef1eb] px-3 py-2 text-xs font-sans uppercase tracking-widest text-[#3d4a35] hover:bg-[#e0e5da]",
  component: StageNode,
  defaultLabel: "Stage: new workflow stage",
  inspector: {
    labelTitle: "Stage description",
    textareaRows: 4,
  },
};
