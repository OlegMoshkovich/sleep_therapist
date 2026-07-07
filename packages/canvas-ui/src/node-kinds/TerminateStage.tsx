import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode, CanvasNodeData, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

const baseClass =
  "px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[10rem] max-w-[16rem] text-center";
const inspectorFieldLabel =
  "block text-[10px] uppercase tracking-widest text-gray-500 font-sans mt-2";
const inspectorInput =
  "w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-2 py-1.5 text-xs font-mono text-gray-800 focus:outline-none focus:border-gray-500";

function readString(data: CanvasNodeData, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}

function renderStageHandoffInspector(
  data: CanvasNodeData,
  update: (patch: Partial<CanvasNodeData>) => void
) {
  return (
    <div>
      <label className={inspectorFieldLabel}>Next stage id</label>
      <input
        className={inspectorInput}
        placeholder="review_and_iterate"
        value={readString(data, "nextStageId")}
        onChange={(event) => update({ nextStageId: event.currentTarget.value })}
      />
      <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
        Optional. Leave blank when the state canvas already sets the stage field.
      </p>
      <label className={inspectorFieldLabel}>Next stage name</label>
      <input
        className={inspectorInput}
        placeholder="Review and iterate"
        value={readString(data, "nextStageName")}
        onChange={(event) =>
          update({ nextStageName: event.currentTarget.value })
        }
      />
    </div>
  );
}

function TerminateStageNode({ data, selected }: NodeProps<CanvasNode>) {
  const body = data.label || "finish this stage; continue on the next turn";

  return (
    <div
      className={`${baseClass} bg-emerald-50 border-emerald-600 text-emerald-950 ${
        selected ? "ring-2 ring-emerald-500" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-emerald-600" />
      <div className="text-[10px] uppercase tracking-widest text-emerald-700 mb-0.5">
        Terminate stage
      </div>
      <ClampedNodeText className="font-medium" lines={4} title={body}>
        {body}
      </ClampedNodeText>
    </div>
  );
}

function TerminateStageImmediateNode({
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const body = data.label || "finish this stage; run the next state canvas now";

  return (
    <div
      className={`${baseClass} bg-teal-50 border-teal-700 text-teal-950 ${
        selected ? "ring-2 ring-teal-500" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-teal-700" />
      <div className="text-[10px] uppercase tracking-widest text-teal-800 mb-0.5">
        Move immediately
      </div>
      <ClampedNodeText className="font-medium" lines={4} title={body}>
        {body}
      </ClampedNodeText>
    </div>
  );
}

export const TERMINATE_STAGE: NodeKindDef = {
  kind: "terminate_stage",
  toolbarLabel: "+ Terminate stage",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-3 py-2 border border-emerald-600 text-emerald-950 bg-emerald-50 hover:bg-emerald-100 rounded",
  component: TerminateStageNode,
  defaultLabel: "finish this stage; continue on the next turn",
  inspector: {
    labelTitle: "Stage handoff note",
    helpText:
      "Ends this stage after the current policy action. The next turn will be scoped to the next stage canvas.",
    textareaRows: 2,
    renderExtra: renderStageHandoffInspector,
  },
};

export const TERMINATE_STAGE_IMMEDIATE: NodeKindDef = {
  kind: "terminate_stage_immediate",
  toolbarLabel: "+ Move immediately",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-3 py-2 border border-teal-700 text-teal-950 bg-teal-50 hover:bg-teal-100 rounded",
  component: TerminateStageImmediateNode,
  defaultLabel: "finish this stage; run the next state canvas now",
  inspector: {
    labelTitle: "Stage handoff note",
    helpText:
      "Ends this stage after the current policy action, then executes the next stage state canvas before the other agent acts.",
    textareaRows: 2,
    renderExtra: renderStageHandoffInspector,
  },
};
