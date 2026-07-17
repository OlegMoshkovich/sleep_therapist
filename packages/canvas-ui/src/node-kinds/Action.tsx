import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME,
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
  FINALIZED_ASSISTANT_MESSAGE_PROMPT_VALUE_NAME,
} from "@airlab/canvas-core/lib/canvas-flow-values";
import type {
  CanvasNode,
  CanvasNodeData,
  NodeKindDef,
} from "../types";
import {
  PromptOutputFieldsEditor,
  updatePromptOutputFields,
} from "./PromptOutputFieldsEditor";
import {
  CodeLocalOutputsEditor,
  updateCodeLocalOutputFields,
} from "./CodeLocalOutputsEditor";
import {
  LocalInputsEditor,
  updateLocalInputFields,
} from "./LocalInputsEditor";
import {
  normalizePromptNodeSubtype,
  type ActionSubtype,
  type PromptNodeSubtype,
} from "@airlab/canvas-core/components/canvas/action-subtype";
import {
  NODE_EXECUTABLE_CODE_LANGUAGE_DATA_KEY,
  NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY,
  NODE_EXECUTABLE_CODE_LOCAL_OUTPUTS_DATA_KEY,
  readNodeCodeExecutionLanguage,
  readNodeExecutableCodeSource,
} from "@airlab/canvas-core/lib/canvas-node-code-script";
import { NODE_LOCAL_INPUTS_DATA_KEY } from "@airlab/canvas-core/lib/canvas-node-local-fields";
import { ClampedNodeText } from "./ClampedNodeText";
import type { ToolCallData } from "./ToolCall";

const baseClass =
  "px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[9rem] max-w-[16rem] text-center";
const fieldLabel =
  "block text-[10px] uppercase tracking-widest text-gray-500 font-sans mt-2";
const input =
  "w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-2 py-1.5 text-xs font-mono text-gray-800 focus:outline-none focus:border-gray-500";

export interface PromptData extends CanvasNodeData {
  actionType?: PromptNodeSubtype | "default" | "summarize";
  actionTypeSource?: "auto" | "manual";
  inputVariable?: string;
  outputVariable?: string;
  promptOutputFields?: unknown;
}

export interface CodeData extends CanvasNodeData {
  actionType?: ActionSubtype;
  actionTypeSource?: "auto" | "manual";
  codeLanguage?: "visual" | "typescript";
  codeSource?: string;
}

export interface ActionData extends ToolCallData {
  actionType?: ActionSubtype;
  actionTypeSource?: "auto" | "manual";
  codeLanguage?: "visual" | "typescript";
  codeSource?: string;
  promptOutputFields?: unknown;
}

function getPromptSubtype(data: PromptData): PromptNodeSubtype {
  return normalizePromptNodeSubtype(data.actionType);
}

function getPromptTransformInputVariable(data: PromptData): string {
  const raw = typeof data.inputVariable === "string" ? data.inputVariable.trim() : "";
  return raw || CARRIED_OUTPUT_PROMPT_VALUE_NAME;
}

function getPromptTransformOutputVariable(data: PromptData): string {
  return typeof data.outputVariable === "string" ? data.outputVariable.trim() : "";
}

function isTypeScriptCodeNodeData(data: CodeData): boolean {
  return readNodeCodeExecutionLanguage({ data }) === "typescript";
}

function PromptNode({ data, selected }: NodeProps<CanvasNode>) {
  const promptData = data as PromptData;
  const promptType = getPromptSubtype(promptData);
  const chrome =
    promptType === "prompt_transform"
      ? {
          container: "bg-orange-50 border-orange-400 text-orange-900",
          ring: "ring-orange-500",
          handle: "!bg-orange-500",
          eyebrow: "text-orange-700",
          title: "Prompt transform",
        }
      : {
          container: "bg-sky-50 border-sky-400 text-sky-900",
          ring: "ring-sky-500",
          handle: "!bg-sky-500",
          eyebrow: "text-sky-700",
          title: "Prompt",
        };
  const body =
    promptType === "prompt_transform"
      ? data.label || "transform rules"
      : data.label || "prompt";

  return (
    <div
      className={`${baseClass} ${chrome.container} ${
        selected ? `ring-2 ${chrome.ring}` : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className={chrome.handle} />
      <div className={`text-[10px] uppercase tracking-widest mb-0.5 ${chrome.eyebrow}`}>
        {chrome.title}
      </div>
      <ClampedNodeText lines={4} title={body}>
        {body}
      </ClampedNodeText>
      <Handle type="source" position={Position.Bottom} className={chrome.handle} />
    </div>
  );
}

function CodeNode({ data, selected }: NodeProps<CanvasNode>) {
  const body = data.label || "state mutation";
  return (
    <div
      className={`${baseClass} max-w-[18rem] bg-slate-900 border-slate-700 text-left text-slate-50 ${
        selected ? "ring-2 ring-slate-400" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-widest text-slate-300">
          Code
        </div>
        <span className="rounded border border-slate-500 bg-slate-800 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-[0.18em] text-slate-200">
          Code
        </span>
      </div>
      <div className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-slate-100">
        <ClampedNodeText lines={6} title={body}>
          {body}
        </ClampedNodeText>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
}

function renderPromptInspectorExtra(
  data: CanvasNodeData,
  update: (patch: Partial<CanvasNodeData>) => void
) {
  const promptData = data as PromptData;
  const promptType = getPromptSubtype(promptData);

  return (
    <div className="pt-2 mt-2 border-t border-[#c0bdb0]">
      <label className={fieldLabel}>Prompt type</label>
      <select
        className={input}
        value={promptType}
        onChange={(e) => {
          const next = e.target.value as PromptNodeSubtype;
          update({
            actionType: next,
            actionTypeSource: next === "prompt" ? "manual" : undefined,
            ...(next === "prompt_transform"
              ? {
                  inputVariable: getPromptTransformInputVariable(promptData),
                  outputVariable:
                    getPromptTransformOutputVariable(promptData) || "transformed_output",
                }
              : {}),
          });
        }}
      >
        <option value="prompt">Default</option>
        <option value="prompt_transform">Prompt transform</option>
      </select>

      {promptType === "prompt_transform" && (
        <>
          <label className={fieldLabel}>Value source</label>
          <input
            className={input}
            placeholder={CARRIED_OUTPUT_PROMPT_VALUE_NAME}
            value={getPromptTransformInputVariable(promptData)}
            onChange={(e) => update({ inputVariable: e.target.value })}
          />
          <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
            Local variable or state field this transform reads. Defaults to{" "}
            <span className="font-mono">{CARRIED_OUTPUT_PROMPT_VALUE_NAME}</span>.
          </p>

          <label className={fieldLabel}>Output variable</label>
          <input
            className={input}
            placeholder="transformed_output"
            value={getPromptTransformOutputVariable(promptData)}
            onChange={(e) => update({ outputVariable: e.target.value })}
          />
          <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
            New local variable that receives the transformed result. Leaving it blank
            keeps legacy behavior and writes to{" "}
            <span className="font-mono">{CARRIED_OUTPUT_PROMPT_VALUE_NAME}</span>.
          </p>
        </>
      )}

      {promptType === "prompt" && (
        <p className="mt-2 text-[10px] font-serif leading-relaxed text-gray-500">
          {promptData.actionTypeSource === "auto"
            ? "Auto-detected as a prompt-producing node."
            : "Default prompt node. This lowers to a regular prompt step."}
        </p>
      )}

      {(promptType === "prompt" || promptType === "prompt_transform") && (
        <>
          <LocalInputsEditor
            value={
              (promptData as Record<string, unknown>)[NODE_LOCAL_INPUTS_DATA_KEY]
            }
            onChange={(next) => updateLocalInputFields(update, next)}
          />
          <PromptOutputFieldsEditor
            value={promptData.promptOutputFields}
            onChange={(next) => updatePromptOutputFields(update, next)}
          />
        </>
      )}
    </div>
  );
}

function renderCodeInspectorExtra(
  data: CanvasNodeData,
  update: (patch: Partial<CanvasNodeData>) => void
) {
  const codeData = data as CodeData;

  return (
    <div className="pt-2 mt-2 border-t border-[#c0bdb0]">
      {codeData.actionTypeSource && (
        <p className="mb-2 text-[10px] font-serif leading-relaxed text-gray-500">
          {codeData.actionTypeSource === "auto"
            ? "Auto-detected from a supported deterministic state rule."
            : "Explicit code node. Automatic classification will preserve this node as code."}
        </p>
      )}

      <label className={fieldLabel}>Code mode</label>
      <select
        className={input}
        value={readNodeCodeExecutionLanguage({ data: codeData })}
        onChange={(e) =>
          update({
            [NODE_EXECUTABLE_CODE_LANGUAGE_DATA_KEY]:
              e.target.value === "typescript" ? "typescript" : "visual",
            [NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY]:
              e.target.value === "typescript"
                ? readNodeExecutableCodeSource({ data: codeData })
                : "",
          })
        }
      >
        <option value="visual">Visual ops</option>
        <option value="typescript">TypeScript</option>
      </select>

      <LocalInputsEditor
        value={(codeData as Record<string, unknown>)[NODE_LOCAL_INPUTS_DATA_KEY]}
        onChange={(next) => updateLocalInputFields(update, next)}
      />

      {isTypeScriptCodeNodeData(codeData) ? (
        <>
          <label className={fieldLabel}>TypeScript body</label>
          <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
            Write only the function body. The runtime provides
            <span className="font-mono"> ctx.state</span>,
            <span className="font-mono"> ctx.locals</span>. Read the latest
            input from
            <span className="font-mono"> ctx.locals.{AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME}</span>.
            Return an object
            with optional <span className="font-mono">setState</span>,
            <span className="font-mono">setLocals</span>, or
            <span className="font-mono">clearLocals</span>. Returning a plain
            object like <span className="font-mono">{`{ my_local: value }`}</span>
            publishes locals directly.
          </p>
          <textarea
            className={`${input} mt-2 min-h-[12rem] resize-y leading-relaxed`}
            rows={10}
            placeholder={`const message = String(ctx.locals.${FINALIZED_ASSISTANT_MESSAGE_PROMPT_VALUE_NAME} ?? "").trim();\nif (!message) {\n  return {};\n}\n\nconst events = Array.isArray(ctx.state.new_events) ? [...ctx.state.new_events] : [];\nconst last = events[events.length - 1];\nif (last && typeof last === "object" && last && !Array.isArray(last) && !last.action) {\n  events[events.length - 1] = { ...last, action: message };\n} else {\n  events.push({ action: message, observation: "", reward: "" });\n}\n\nreturn { setState: { new_events: events } };`}
            value={readNodeExecutableCodeSource({ data: codeData })}
            onChange={(e) =>
              update({
                [NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY]: e.target.value,
              })
            }
          />
          <CodeLocalOutputsEditor
            value={
              (codeData as Record<string, unknown>)[
                NODE_EXECUTABLE_CODE_LOCAL_OUTPUTS_DATA_KEY
              ]
            }
            onChange={(next) => updateCodeLocalOutputFields(update, next)}
          />
        </>
      ) : null}
    </div>
  );
}

export const PROMPT: NodeKindDef = {
  kind: "prompt",
  toolbarLabel: "+ Prompt",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-sky-400 text-sky-900 bg-sky-50 hover:bg-sky-100 rounded-full",
  component: PromptNode,
  defaultLabel: "new prompt",
  defaultData: {
    actionType: "prompt",
    actionTypeSource: "manual",
  },
  inspector: {
    labelTitle: (data) => {
      const promptType = getPromptSubtype(data as PromptData);
      if (promptType === "prompt_transform") return "Transform rules";
      return "Prompt";
    },
    helpText: (data) => {
      const promptType = getPromptSubtype(data as PromptData);
      if (promptType === "prompt_transform") {
        return "Rules for how the selected source value should be rewritten or formatted into the output variable. In prompt-based flows this is rendered into the system prompt, and in hybrid flows it can run as a prompt_transform step.";
      }
      return "Default prompt node. This lowers to a regular prompt step.";
    },
    textareaRows: (data) =>
      getPromptSubtype(data as PromptData) === "prompt_transform" ? 4 : 3,
    renderExtra: renderPromptInspectorExtra,
  },
};

export const CODE: NodeKindDef = {
  kind: "code",
  toolbarLabel: "+ Code",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-slate-700 text-slate-50 bg-slate-900 hover:bg-slate-800 rounded-full",
  component: CodeNode,
  defaultLabel: "state mutation",
  defaultData: {
    actionType: "code",
    actionTypeSource: "manual",
  },
  inspector: {
    labelTitle: "Code rule",
    helpText: (data) =>
      isTypeScriptCodeNodeData(data as CodeData)
        ? `Constrained TypeScript code with full state and local-variable read access. Scripts can update state, define locals, and read reserved locals like ${CARRIED_OUTPUT_PROMPT_VALUE_NAME}, ${FINALIZED_ASSISTANT_MESSAGE_PROMPT_VALUE_NAME}, and ${AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME}.`
        : "Deterministic state mutation that lowers to a code step instead of a prompt step.",
    textareaRows: 3,
    renderExtra: renderCodeInspectorExtra,
  },
};
