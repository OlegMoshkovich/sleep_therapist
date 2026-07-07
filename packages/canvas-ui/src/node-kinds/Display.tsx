import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CARRIED_OUTPUT_PROMPT_VALUE_NAME } from "@airlab/canvas-core/lib/canvas-flow-values";
import type {
  CanvasInspectorContext,
  CanvasNode,
  CanvasNodeData,
  NodeKindDef,
} from "../types";
import {
  normalizeDisplayNodeType,
  type DisplayNodeType,
} from "@airlab/canvas-core/components/canvas/action-subtype";
import { ClampedNodeText } from "./ClampedNodeText";

const baseClass =
  "px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[9rem] max-w-[16rem] text-center";
const fieldLabel =
  "block text-[10px] uppercase tracking-widest text-gray-500 font-sans mt-2";
const input =
  "w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-2 py-1.5 text-xs font-mono text-gray-800 focus:outline-none focus:border-gray-500";

export interface DisplayData extends CanvasNodeData {
  displayType?: DisplayNodeType;
  inputVariable?: string;
  videoUrl?: string;
}

export function getDisplayType(data: DisplayData): DisplayNodeType {
  return normalizeDisplayNodeType(data.displayType);
}

export function getDisplayInputVariable(data: DisplayData): string {
  const raw = typeof data.inputVariable === "string" ? data.inputVariable.trim() : "";
  return raw || CARRIED_OUTPUT_PROMPT_VALUE_NAME;
}

function DisplayNode({ data, selected }: NodeProps<CanvasNode>) {
  const displayData = data as DisplayData;
  const displayType = getDisplayType(displayData);
  const body =
    displayType === "video"
      ? displayData.videoUrl?.trim() || displayData.label || "video"
      : getDisplayInputVariable(displayData);

  return (
    <div
      className={`${baseClass} bg-emerald-50 border-emerald-500 text-emerald-900 ${
        selected ? "ring-2 ring-emerald-500" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-emerald-500" />
      <div className="text-[10px] uppercase tracking-widest text-emerald-700 mb-0.5">
        {displayType === "video" ? "Display video" : "Display text"}
      </div>
      <ClampedNodeText
        className={displayType === "text" ? "font-mono text-xs" : undefined}
        lines={4}
        title={body}
      >
        {body}
      </ClampedNodeText>
      <Handle type="source" position={Position.Bottom} className="!bg-emerald-500" />
    </div>
  );
}

function renderDisplayInspectorExtra(
  data: CanvasNodeData,
  update: (patch: Partial<CanvasNodeData>) => void,
  _context: CanvasInspectorContext
) {
  const displayData = data as DisplayData;
  const displayType = getDisplayType(displayData);

  return (
    <div className="pt-2 mt-2 border-t border-[#c0bdb0]">
      <label className={fieldLabel}>Display type</label>
      <select
        className={input}
        value={displayType}
        onChange={(e) => {
          const next = e.target.value as DisplayNodeType;
          update({
            displayType: next,
            ...(next === "text"
              ? { inputVariable: getDisplayInputVariable(displayData) }
              : {}),
          });
        }}
      >
        <option value="text">Text</option>
        <option value="video">Video</option>
      </select>

      {displayType === "text" ? (
        <>
          <label className={fieldLabel}>Value source</label>
          <input
            className={input}
            placeholder={CARRIED_OUTPUT_PROMPT_VALUE_NAME}
            value={getDisplayInputVariable(displayData)}
            onChange={(e) => update({ inputVariable: e.target.value })}
          />
        </>
      ) : (
        <>
          <label className={fieldLabel}>Video URL</label>
          <textarea
            className={`${input} resize-y leading-relaxed`}
            rows={2}
            placeholder="https://example.com/clip.mp4"
            value={displayData.videoUrl ?? ""}
            onChange={(e) => update({ videoUrl: e.target.value })}
          />
        </>
      )}
    </div>
  );
}

export const DISPLAY: NodeKindDef = {
  kind: "display",
  toolbarLabel: "+ Display",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-3 py-2 border border-emerald-500 text-emerald-900 bg-emerald-50 hover:bg-emerald-100 rounded",
  component: DisplayNode,
  defaultLabel: "display output",
  defaultData: {
    displayType: "text",
    inputVariable: CARRIED_OUTPUT_PROMPT_VALUE_NAME,
  },
  inspector: {
    labelTitle: "Display label",
    helpText: (data) =>
      getDisplayType(data as DisplayData) === "video"
        ? "Embeds a video from the configured URL."
        : "Displays a local value or state field in chat.",
    textareaRows: 2,
    renderExtra: renderDisplayInspectorExtra,
  },
};
