import { Handle, Position, type NodeProps } from "@xyflow/react";
import { DEFAULT_OPENCLAW_BRIDGE_PATH } from "@airlab/openclaw-runtime";
import type { CanvasNode, CanvasNodeData, NodeKindDef } from "../types";
import { ClampedNodeText } from "./ClampedNodeText";

const baseClass =
  "relative px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[10rem] max-w-[17rem] text-center";
const inspectorFieldLabel =
  "block text-[10px] uppercase tracking-widest text-gray-500 font-sans mt-2";
const inspectorInput =
  "w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-2 py-1.5 text-xs font-mono text-gray-800 focus:outline-none focus:border-gray-500";

type CallAgentType =
  | "default"
  | "internal_connection"
  | "external_agent"
  | "openclaw"
  | "hermes";

function readString(data: CanvasNodeData, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}

function readBackendConfig(data: CanvasNodeData): {
  mode?: "sync" | "async";
  bearerToken?: string;
  responseFormat?: "text" | "json";
} {
  const value = data.backend;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as {
        mode?: "sync" | "async";
        bearerToken?: string;
        responseFormat?: "text" | "json";
      })
    : {};
}

function readCallAgentType(data: CanvasNodeData): CallAgentType {
  if (data.callAgentType === "internal_connection") {
    return "internal_connection";
  }
  if (data.callAgentType === "external_agent") {
    return "external_agent";
  }
  if (data.callAgentType === "hermes" || data.backendType === "hermes") {
    return "hermes";
  }
  if (
    data.callAgentType === "openclaw" ||
    data.backendType === "openclaw"
  ) {
    return "openclaw";
  }
  return "default";
}

function readExecutionMode(data: CanvasNodeData): "sync" | "async" {
  if (data.executionMode === "async") {
    return "async";
  }
  return readBackendConfig(data).mode === "async" ? "async" : "sync";
}

function callAgentTypeLabel(type: CallAgentType): string {
  if (type === "internal_connection") {
    return "Internal agent call";
  }
  if (type === "external_agent") {
    return "External agent call";
  }
  if (type === "openclaw") {
    return "OpenClaw backend";
  }
  if (type === "hermes") {
    return "Hermes backend";
  }
  return "Default";
}

function defaultEndpointForType(type: CallAgentType): string {
  return type === "openclaw" ? DEFAULT_OPENCLAW_BRIDGE_PATH : "";
}

function endpointPlaceholderForType(type: CallAgentType): string {
  if (type === "openclaw") {
    return DEFAULT_OPENCLAW_BRIDGE_PATH;
  }
  if (type === "hermes") {
    return "https://hermes.example.com/tasks";
  }
  return "";
}

function CallAgentNode({ data, selected }: NodeProps<CanvasNode>) {
  const target = readString(data, "targetAgentId").trim();
  const type = readCallAgentType(data);
  const mode = readExecutionMode(data);
  const display = target || data.label || "agent id";

  return (
    <div
      className={`${baseClass} bg-cyan-50 border-cyan-600 text-cyan-950 ${
        selected ? "ring-2 ring-cyan-500" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-cyan-600" />
      <div className="text-[10px] uppercase tracking-widest text-cyan-700 mb-0.5">
        {type === "default" ? "Call agent" : callAgentTypeLabel(type)}{" "}
        {mode === "async" ? "async" : "sync"}
      </div>
      <ClampedNodeText className="font-medium" lines={4} title={display}>
        {display}
      </ClampedNodeText>
      <Handle
        id="success"
        type="source"
        position={Position.Bottom}
        className="!bg-green-600"
        style={{ left: "62%" }}
      />
      <span className="pointer-events-none absolute bottom-[-1.15rem] left-[62%] -translate-x-1/2 text-[9px] font-semibold uppercase tracking-wider text-green-700">
        success
      </span>
      <Handle
        id="error"
        type="source"
        position={Position.Left}
        className="!bg-red-500"
        style={{ top: "64%" }}
      />
      <span className="pointer-events-none absolute left-[-2.15rem] top-[64%] -translate-y-1/2 text-[9px] font-semibold uppercase tracking-wider text-red-700">
        error
      </span>
    </div>
  );
}

export const CALL_AGENT: NodeKindDef = {
  kind: "call_agent",
  toolbarLabel: "+ Call agent",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-cyan-600 text-cyan-950 bg-cyan-50 hover:bg-cyan-100 rounded-full",
  component: CallAgentNode,
  defaultLabel: "when another agent should be called",
  defaultData: {
    callAgentType: "internal_connection",
    executionMode: "sync",
    targetAgentId: "",
  },
  sourceHandles: [
    { id: "success", label: "success" },
    { id: "error", label: "error" },
  ],
  inspector: {
    labelTitle: "When to call",
    helpText:
      "Calls another agent by target agent ID. Internal calls activate a managed connection; external-agent turns are only valid inside the matching connection policy.",
    textareaRows: 3,
    renderExtra: (data, update) => {
      const type = readCallAgentType(data);
      const backend = readBackendConfig(data);
      const executionMode = readExecutionMode(data);
      const endpoint = readString(data, "url");

      return (
        <div>
          <label className={inspectorFieldLabel}>Type</label>
          <select
            className={inspectorInput}
            value={type}
            onChange={(event) => {
              const nextType = event.currentTarget.value as CallAgentType;
              const isBackend = nextType === "openclaw" || nextType === "hermes";
              update({
                callAgentType: nextType,
                backendType: isBackend ? nextType : undefined,
                url: isBackend ? endpoint : "",
              });
            }}
          >
            <option value="internal_connection">Internal connection</option>
            <option value="external_agent">External agent</option>
            <option value="default">Default legacy</option>
            <option value="openclaw">OpenClaw backend</option>
            <option value="hermes">Hermes backend</option>
          </select>

          <label className={inspectorFieldLabel}>Target agent ID</label>
          <input
            className={inspectorInput}
            placeholder={
              type === "external_agent"
                ? "inbox_zero"
                : type === "internal_connection" || type === "default"
                  ? "agent_..."
                  : "research-specialist"
            }
            value={readString(data, "targetAgentId")}
            onChange={(event) =>
              update({
                targetAgentId: event.currentTarget.value,
              })
            }
          />

          <label className={inspectorFieldLabel}>Execution mode</label>
          <select
            className={inspectorInput}
            value={executionMode}
            onChange={(event) => {
              const nextMode = event.currentTarget.value as "sync" | "async";
              update({
                executionMode: nextMode,
                ...(type === "default" ||
                type === "internal_connection" ||
                type === "external_agent"
                  ? {}
                  : { backend: { ...backend, mode: nextMode } }),
              });
            }}
          >
            <option value="sync">Sync</option>
            <option value="async">Async</option>
          </select>

          {type !== "default" &&
          type !== "internal_connection" &&
          type !== "external_agent" && (
            <>
              <p className="mt-2 text-[10px] font-serif leading-snug text-gray-500">
                Delegates a JSON task envelope to the selected backend.
                {defaultEndpointForType(type) ? (
                  <>
                    {" "}
                    Leave the endpoint blank to use{" "}
                    <span className="font-mono">{defaultEndpointForType(type)}</span>.
                  </>
                ) : null}
              </p>

              <label className={inspectorFieldLabel}>
                Endpoint URL (optional override)
              </label>
              <textarea
                className={`${inspectorInput} resize-y leading-relaxed`}
                rows={2}
                placeholder={endpointPlaceholderForType(type)}
                value={endpoint}
                onChange={(event) => update({ url: event.currentTarget.value })}
              />

              <label className={inspectorFieldLabel}>
                Bearer token (prefer env:VAR_NAME)
              </label>
              <input
                className={inspectorInput}
                placeholder={
                  type === "openclaw"
                    ? "env:OPENCLAW_GATEWAY_TOKEN"
                    : "env:HERMES_GATEWAY_TOKEN"
                }
                value={backend.bearerToken ?? ""}
                onChange={(event) =>
                  update({
                    backend: {
                      ...backend,
                      bearerToken: event.currentTarget.value,
                      mode: executionMode,
                    },
                  })
                }
              />

              <label className={inspectorFieldLabel}>Default response format</label>
              <select
                className={inspectorInput}
                value={backend.responseFormat ?? "json"}
                onChange={(event) =>
                  update({
                    backend: {
                      ...backend,
                      responseFormat: event.currentTarget.value as "text" | "json",
                      mode: executionMode,
                    },
                  })
                }
              >
                <option value="json">JSON</option>
                <option value="text">Text</option>
              </select>
            </>
          )}
        </div>
      );
    },
  },
};
