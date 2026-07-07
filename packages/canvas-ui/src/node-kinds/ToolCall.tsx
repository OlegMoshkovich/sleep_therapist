import { useEffect, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { DEFAULT_OPENCLAW_BRIDGE_PATH } from "@airlab/openclaw-runtime";
import {
  NODE_LOCAL_INPUTS_DATA_KEY,
} from "@airlab/canvas-core/lib/canvas-node-local-fields";
import {
  readCanvasAsyncContinuationPolicy,
  type CanvasAsyncContinuationPolicy,
} from "@airlab/canvas-core/lib/canvas-async-job-config";
import type {
  CanvasInspectorContext,
  CanvasNode,
  CanvasNodeData,
  NodeKindDef,
} from "../types";
import { ClampedNodeText } from "./ClampedNodeText";
import {
  LocalInputsEditor,
  updateLocalInputFields,
} from "./LocalInputsEditor";

export type ToolCallSourceType =
  | "http"
  | "rss"
  | "page"
  | "web_search"
  | "knowledge_save"
  | "dataset_read"
  | "mcp"
  | "openclaw";
export type ToolCallSaveTarget = "knowledge" | "dataset";

export function readToolCallSourceType(raw: unknown): ToolCallSourceType {
  if (raw === "rss") return "rss";
  if (raw === "page") return "page";
  if (raw === "web_search") return "web_search";
  if (raw === "mcp") return "mcp";
  if (raw === "openclaw") return "openclaw";
  if (raw === "knowledge_save" || raw === "supabase_insert") return "knowledge_save";
  if (raw === "dataset_read") return "dataset_read";
  return "http";
}

function readSaveTarget(raw: unknown): ToolCallSaveTarget {
  return raw === "dataset" ? "dataset" : "knowledge";
}

type ParamType = "string" | "number" | "integer" | "boolean";
const PARAM_TYPES: ParamType[] = ["string", "number", "integer", "boolean"];

interface ParamSample {
  name: string;
  type: ParamType;
  description: string;
}

const PARAM_SAMPLES: ParamSample[] = [
  {
    name: "topic",
    type: "string",
    description: 'The subject the user asked about, e.g. "Albert Einstein".',
  },
  {
    name: "summary",
    type: "string",
    description: "A short note to save capturing what should be remembered.",
  },
  {
    name: "query",
    type: "string",
    description: "Search query the model wants to look up.",
  },
  {
    name: "count",
    type: "integer",
    description: "How many items to return (defaults to 1 if omitted).",
  },
];

const WEB_SEARCH_DEFAULT_PARAMS_SCHEMA = JSON.stringify(
  {
    query: {
      type: "string",
      description: "The web search query.",
    },
    limit: {
      type: "integer",
      description: "Optional number of results to return, up to 10.",
    },
    include_content: {
      type: "boolean",
      description: "Optional. When true, ask the provider for fuller page content when supported.",
    },
    time_range: {
      type: "string",
      description: 'Optional freshness filter such as "day", "week", "month", or "year".',
    },
  },
  null,
  2
);

interface ParamRow {
  id: string;
  name: string;
  type: ParamType;
  description: string;
}

function makeParamId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `p-${Math.random().toString(36).slice(2, 10)}`;
}

function rowsFromSchema(raw: string | undefined): { rows: ParamRow[]; parseError: boolean } {
  if (!raw || !raw.trim()) return { rows: [], parseError: false };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { rows: [], parseError: true };
    }
    const rows: ParamRow[] = Object.entries(parsed).map(([name, frag]) => {
      const f = (frag ?? {}) as { type?: string; description?: string };
      const type: ParamType = PARAM_TYPES.includes(f.type as ParamType)
        ? (f.type as ParamType)
        : "string";
      return {
        id: makeParamId(),
        name,
        type,
        description: typeof f.description === "string" ? f.description : "",
      };
    });
    return { rows, parseError: false };
  } catch {
    return { rows: [], parseError: true };
  }
}

function schemaFromRows(rows: ParamRow[]): string {
  const obj: Record<string, { type: ParamType; description?: string }> = {};
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue;
    const frag: { type: ParamType; description?: string } = { type: r.type };
    if (r.description.trim()) frag.description = r.description.trim();
    obj[name] = frag;
  }
  return Object.keys(obj).length === 0 ? "" : JSON.stringify(obj, null, 2);
}

export interface ToolCallData extends CanvasNodeData {
  toolName?: string;
  description?: string;
  resultVariable?: string;
  executionMode?: "sync" | "async";
  asyncContinuationPolicy?: CanvasAsyncContinuationPolicy;
  sourceType?: ToolCallSourceType;
  ref?: { server?: string; tool?: string };
  url?: string;
  table?: string;
  paramsSchema?: string;
  promoteToKnowledge?: boolean;
  saveTarget?: ToolCallSaveTarget;
  datasetName?: string;
}

const baseClass =
  "relative px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[9rem] max-w-[16rem] text-center";

function toolSourceBadge(
  data: ToolCallData,
  saveTarget: ToolCallSaveTarget,
  datasetName: string,
  executionMode: "sync" | "async"
): string {
  const modeSuffix = executionMode === "async" ? " | async" : "";
  switch (readToolCallSourceType(data.sourceType)) {
    case "knowledge_save":
      if (saveTarget === "dataset" && datasetName) {
        return `post | dataset: ${datasetName}${modeSuffix}`;
      }
      return saveTarget === "dataset"
        ? `post | dataset${modeSuffix}`
        : `post | domain knowledge${modeSuffix}`;
    case "dataset_read":
      return `read | dataset: ${datasetName || "(unset)"}${modeSuffix}`;
    case "mcp":
      return `mcp | ${data.ref?.server?.trim() || "server"}:${data.ref?.tool?.trim() || "tool"}${modeSuffix}`;
    case "openclaw":
      return `openclaw${modeSuffix}`;
    case "rss":
      return `fetch | rss${modeSuffix}`;
    case "page":
      return `fetch | page${modeSuffix}`;
    case "web_search":
      return `search | web${modeSuffix}`;
    case "http":
      return `fetch${modeSuffix}`;
  }
}

function toolNamePlaceholderFor(
  action: "fetch" | "post" | "read_dataset",
  sourceType: ToolCallSourceType
): string {
  if (action === "post") return "save_summary";
  if (action === "read_dataset") return "lookup_records";
  if (sourceType === "web_search") return "search_web";
  if (sourceType === "openclaw") return "delegate_openclaw_task";
  return "fetch_tweets";
}

function descriptionPlaceholderFor(
  action: "fetch" | "post" | "read_dataset",
  sourceType: ToolCallSourceType,
  saveTarget: ToolCallSaveTarget
): string {
  if (action === "post") {
    return saveTarget === "dataset"
      ? "Save a structured record into the selected dataset."
      : "Save a short note so it can be retrieved later from Domain Knowledge.";
  }
  if (action === "read_dataset") {
    return "Look up stored records from the selected dataset.";
  }
  if (sourceType === "page") {
    return "Retrieve the contents of a page URL directly.";
  }
  if (sourceType === "web_search") {
    return "Search the web and return normalized sources for retrieval-augmented answers.";
  }
  if (sourceType === "openclaw") {
    return "Delegate a task to an OpenClaw-compatible agent backend.";
  }
  return "Fetch recent tweets matching a query";
}

function ToolCallNode({ data, selected }: NodeProps<CanvasNode>) {
  const d = data as ToolCallData;
  const display = d.toolName?.trim() || d.label || "tool_name(args)";
  const saveTarget = readSaveTarget(d.saveTarget);
  const datasetName = typeof d.datasetName === "string" ? d.datasetName.trim() : "";
  const executionMode = d.executionMode === "async" ? "async" : "sync";
  return (
    <div
      className={`${baseClass} bg-violet-50 border-violet-400 text-violet-900 ${
        selected ? "ring-2 ring-violet-500" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-violet-500" />
      <div className="text-[10px] uppercase tracking-widest text-violet-700 mb-0.5">
        Tool call
      </div>
      <ClampedNodeText className="font-mono text-xs" lines={4} title={display}>
        {display}
      </ClampedNodeText>
      {d.sourceType && (
        <div className="text-[10px] font-sans text-violet-600 mt-0.5">
          {toolSourceBadge(d, saveTarget, datasetName, executionMode)}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-violet-500"
        style={{ left: "42%" }}
      />
      <Handle
        id="success"
        type="source"
        position={Position.Bottom}
        className="!bg-green-600"
        style={{ left: "64%" }}
      />
      <Handle
        id="error"
        type="source"
        position={Position.Left}
        className="!bg-red-500"
        style={{ top: "64%" }}
      />
    </div>
  );
}

const fieldLabel = "block text-[10px] uppercase tracking-widest text-gray-500 font-sans mt-2";
const input =
  "w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-2 py-1.5 text-xs font-mono text-gray-800 focus:outline-none focus:border-gray-500";

function ParametersEditor({
  schemaJson,
  onChange,
}: {
  schemaJson: string | undefined;
  onChange: (next: string) => void;
}) {
  const initial = rowsFromSchema(schemaJson);
  const [rows, setRows] = useState<ParamRow[]>(initial.rows);
  const [hadParseError] = useState(initial.parseError);

  useEffect(() => {
    const next = rowsFromSchema(schemaJson);
    if (schemaFromRows(rows) === schemaJson) return;
    setRows(next.rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaJson]);

  function commit(next: ParamRow[]) {
    setRows(next);
    onChange(schemaFromRows(next));
  }

  function patch(id: string, patchObj: Partial<ParamRow>) {
    commit(rows.map((r) => (r.id === id ? { ...r, ...patchObj } : r)));
  }

  function remove(id: string) {
    commit(rows.filter((r) => r.id !== id));
  }

  function add() {
    commit([...rows, { id: makeParamId(), name: "", type: "string", description: "" }]);
  }

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
          Parameters
        </span>
        <button
          type="button"
          onClick={add}
          className="text-[10px] font-sans uppercase tracking-widest border border-gray-500 text-gray-700 hover:bg-gray-100 rounded px-2 py-0.5"
        >
          + Parameter
        </button>
      </div>

      {hadParseError && rows.length === 0 && (
        <p className="text-[10px] font-serif text-amber-700 mt-1 leading-snug">
          Existing parameters JSON could not be parsed. Add fresh parameters below.
        </p>
      )}

      {rows.length === 0 ? (
        <>
          <p className="text-[10px] font-serif text-gray-500 italic mt-2">
            No parameters yet - the model will call this tool with no arguments.
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <span className="text-[10px] font-serif text-gray-500 italic mr-1">Try:</span>
            {PARAM_SAMPLES.map((sample) => (
              <button
                key={sample.name}
                type="button"
                onClick={() =>
                  commit([
                    ...rows,
                    {
                      id: makeParamId(),
                      name: sample.name,
                      type: sample.type,
                      description: sample.description,
                    },
                  ])
                }
                className="text-[10px] font-mono border border-[#c0bdb0] bg-[#e0dccc] hover:bg-[#d4d0c0] text-gray-800 rounded px-1.5 py-0.5"
                title={sample.description}
              >
                + {sample.name} ({sample.type})
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="space-y-2 mt-2">
          {rows.map((r) => (
            <div
              key={r.id}
              className="border border-[#c0bdb0] rounded p-2 bg-[#e0dccc] space-y-1.5"
            >
              <div className="flex items-center gap-1.5">
                <input
                  value={r.name}
                  onChange={(e) => patch(r.id, { name: e.target.value })}
                  placeholder="name"
                  className={`${input} flex-1`}
                />
                <select
                  value={r.type}
                  onChange={(e) => patch(r.id, { type: e.target.value as ParamType })}
                  className={`${input} w-24`}
                >
                  {PARAM_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  className="text-gray-500 hover:text-red-600 text-base leading-none px-1"
                  aria-label="Remove parameter"
                >
                  x
                </button>
              </div>
              <textarea
                value={r.description}
                onChange={(e) => patch(r.id, { description: e.target.value })}
                placeholder="description (hint for the model)"
                rows={1}
                className={`${input} resize-y leading-relaxed`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function renderToolCallInspectorFields(
  data: ToolCallData,
  update: (patch: Partial<CanvasNodeData>) => void,
  options: { showDivider?: boolean; datasetNames?: string[] } = {}
) {
  const { showDivider = true, datasetNames = [] } = options;
  const d = data as ToolCallData;
  const sourceType = readToolCallSourceType(d.sourceType);
  const action: "fetch" | "post" | "read_dataset" =
    sourceType === "knowledge_save"
      ? "post"
      : sourceType === "dataset_read"
        ? "read_dataset"
        : "fetch";
  const rawSaveTarget = readSaveTarget(d.saveTarget);
  const normalizedDatasetNames = Array.from(
    new Set(datasetNames.map((name) => name.trim()).filter((name) => name.length > 0))
  );
  const currentDatasetName = typeof d.datasetName === "string" ? d.datasetName.trim() : "";
  const datasetOptions = currentDatasetName &&
    !normalizedDatasetNames.some((name) => name.toLowerCase() === currentDatasetName.toLowerCase())
    ? [currentDatasetName, ...normalizedDatasetNames]
    : normalizedDatasetNames;
  const saveTarget =
    rawSaveTarget === "dataset" && datasetOptions.length === 0 ? "knowledge" : rawSaveTarget;
  const toolNamePlaceholder = toolNamePlaceholderFor(action, sourceType);
  const descriptionPlaceholder = descriptionPlaceholderFor(action, sourceType, saveTarget);

  return (
    <div className={showDivider ? "pt-2 mt-2 border-t border-[#c0bdb0]" : ""}>
      <label className={fieldLabel}>Action</label>
      <select
        className={input}
        value={action}
        onChange={(e) => {
          const next = e.target.value as "fetch" | "post" | "read_dataset";
          if (next === "post") {
            update({ sourceType: "knowledge_save" });
          } else if (next === "read_dataset") {
            update({ sourceType: "dataset_read", promoteToKnowledge: false });
          } else if (
            sourceType === "knowledge_save" ||
            sourceType === "dataset_read"
          ) {
            update({ sourceType: "http" });
          }
        }}
      >
        <option value="fetch">Fetch (read from external source)</option>
        <option value="post">Post (save structured data)</option>
        <option value="read_dataset">Read dataset (query stored records)</option>
      </select>

      {action === "fetch" ? (
        <>
          <label className={fieldLabel}>Source</label>
          <select
            className={input}
            value={
              sourceType === "rss"
                ? "rss"
                : sourceType === "page"
                  ? "page"
                  : sourceType === "web_search"
                    ? "web_search"
                    : sourceType === "mcp"
                      ? "mcp"
                      : sourceType === "openclaw"
                        ? "openclaw"
                        : "http"
            }
            onChange={(e) => {
              const nextSourceType = e.target.value as ToolCallSourceType;
              if (nextSourceType === "web_search") {
                update({
                  sourceType: "web_search",
                  url: "",
                  toolName: d.toolName?.trim() ? d.toolName : "search_web",
                  description: d.description?.trim()
                    ? d.description
                    : "Search the web and return normalized sources for retrieval-augmented answers.",
                  paramsSchema: d.paramsSchema?.trim()
                    ? d.paramsSchema
                    : WEB_SEARCH_DEFAULT_PARAMS_SCHEMA,
                });
                return;
              }
              if (nextSourceType === "openclaw") {
                update({
                  sourceType: "openclaw",
                  url: d.url?.trim() ? d.url : DEFAULT_OPENCLAW_BRIDGE_PATH,
                  toolName: d.toolName?.trim()
                    ? d.toolName
                    : "delegate_openclaw_task",
                  description: d.description?.trim()
                    ? d.description
                    : "Delegate a task to an OpenClaw-compatible agent backend.",
                });
                return;
              }
              update({ sourceType: nextSourceType });
            }}
          >
            <option value="http">HTTP / JSON</option>
            <option value="rss">RSS / Atom</option>
            <option value="page">Direct page retrieval</option>
            <option value="web_search">Web search</option>
            <option value="mcp">MCP server (reference)</option>
            <option value="openclaw">OpenClaw task backend</option>
          </select>

          {sourceType === "page" && (
            <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
              Fetch the page directly in the runtime without relying on an OpenAI tool call.
            </p>
          )}

          {sourceType === "web_search" && (
            <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
              Search is resolved server-side using WEB_SEARCH_PROVIDER and one of
              TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, or SERPAPI_API_KEY.
            </p>
          )}

          {sourceType === "mcp" && (
            <>
              <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
                The tool is a reference, not an implementation. It names a logical{" "}
                <span className="font-mono">server</span> (resolved against the servers
                map) and the <span className="font-mono">tool</span> exposed by that public
                MCP server, resolved and dispatched over MCP at runtime.
              </p>
              <label className={fieldLabel}>Server (logical name)</label>
              <input
                className={input}
                placeholder="wikipedia"
                value={d.ref?.server ?? ""}
                onChange={(e) => update({ ref: { ...d.ref, server: e.target.value } })}
              />
              <label className={fieldLabel}>Tool (on that server)</label>
              <input
                className={input}
                placeholder="readArticle"
                value={d.ref?.tool ?? ""}
                onChange={(e) => update({ ref: { ...d.ref, tool: e.target.value } })}
              />
            </>
          )}

          {sourceType === "openclaw" && (
            <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
              Delegates to an OpenClaw-compatible task endpoint. The built-in
              bridge accepts task, goal, context, agentId, sessionKey, mode,
              allowedSkills, allowedTools, and timeoutMs.
            </p>
          )}

          {sourceType !== "web_search" && (
            <>
              <label className={fieldLabel}>
                {sourceType === "mcp"
                  ? "REST fallback URL (optional)"
                  : sourceType === "openclaw"
                    ? "OpenClaw endpoint"
                    : "URL"}
              </label>
              <textarea
                className={`${input} resize-y leading-relaxed`}
                rows={2}
                placeholder={
                  sourceType === "openclaw"
                    ? DEFAULT_OPENCLAW_BRIDGE_PATH
                    : "https://api.example.com/search?q={query}"
                }
                value={d.url ?? ""}
                onChange={(e) => update({ url: e.target.value })}
              />
            </>
          )}
          {sourceType === "mcp" && (
            <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
              Used only when no MCP server is configured for this logical name, so the
              agent stays alive on a benign config gap.
            </p>
          )}

          {sourceType === "page" ? (
            <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
              The main runtime fetches this configured URL directly.
            </p>
          ) : (
            <>
              <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
                {sourceType === "web_search" ? (
                  "The dispatcher returns normalized search results. The model should aggregate across sources and cite URLs from the result payload."
                ) : (
                  <>
                    Use <span className="font-mono">{"{paramName}"}</span> to interpolate
                    arguments from the model.
                  </>
                )}
              </p>
              <ParametersEditor
                schemaJson={d.paramsSchema}
                onChange={(next) => update({ paramsSchema: next })}
              />
              <details className="mt-2 text-[10px] font-mono text-gray-500">
                <summary className="cursor-pointer">JSON schema (advanced)</summary>
                <pre className="mt-1 whitespace-pre-wrap text-gray-700">
                  {d.paramsSchema?.trim() || "{}"}
                </pre>
              </details>
            </>
          )}

          <label className="mt-3 flex items-start gap-2 text-xs font-sans text-gray-800 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={d.promoteToKnowledge ?? false}
              onChange={(e) => update({ promoteToKnowledge: e.target.checked })}
            />
            <span>Also save result to Domain Knowledge</span>
          </label>
          <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
            When the fetch succeeds, append a Domain Knowledge block with the result.
          </p>
        </>
      ) : action === "read_dataset" ? (
        <>
          <label className={fieldLabel}>Dataset</label>
          {datasetOptions.length > 0 ? (
            <select
              className={input}
              value={currentDatasetName}
              onChange={(e) => update({ datasetName: e.target.value })}
            >
              <option value="">Choose dataset...</option>
              {datasetOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={input}
              value={currentDatasetName}
              onChange={(e) => update({ datasetName: e.target.value })}
              placeholder="Dataset name"
            />
          )}
          <p className="text-[10px] font-serif text-gray-500 mt-2 leading-snug">
            Returns matching records from this dataset. The model can always pass{" "}
            <span className="font-mono">query</span> (substring across text columns) and{" "}
            <span className="font-mono">limit</span>; parameters named after columns
            become exact-match filters.
          </p>
        </>
      ) : (
        <>
          <label className={fieldLabel}>Save destination</label>
          <select
            className={input}
            value={saveTarget}
            onChange={(e) =>
              update({
                saveTarget: e.target.value as ToolCallSaveTarget,
                ...(e.target.value === "knowledge" ? { datasetName: "" } : {}),
              })
            }
          >
            <option value="knowledge">Domain Knowledge</option>
            {datasetOptions.length > 0 && <option value="dataset">Dataset</option>}
          </select>

          {saveTarget === "dataset" && (
            <>
              <label className={fieldLabel}>Dataset</label>
              {datasetOptions.length > 0 ? (
                <select
                  className={input}
                  value={currentDatasetName}
                  onChange={(e) => update({ datasetName: e.target.value })}
                >
                  <option value="">Choose dataset...</option>
                  {datasetOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={input}
                  value={currentDatasetName}
                  onChange={(e) => update({ datasetName: e.target.value })}
                  placeholder="Dataset name"
                />
              )}
            </>
          )}

          <p className="text-[10px] font-serif text-gray-500 mt-2 leading-snug">
            The model fills in the parameters below, and the dispatcher saves them as{" "}
            {saveTarget === "dataset" ? "a new dataset record." : "a new Domain Knowledge block."}
          </p>
        </>
      )}

      <label className={fieldLabel}>Tool name</label>
      <textarea
        className={`${input} resize-y leading-relaxed`}
        rows={1}
        placeholder={toolNamePlaceholder}
        value={d.toolName ?? ""}
        onChange={(e) => update({ toolName: e.target.value })}
      />
      <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
        If left blank, the runtime derives a safe tool name from the instruction text.
      </p>

      <label className={fieldLabel}>Description (for the model)</label>
      <textarea
        className={`${input} resize-y leading-relaxed`}
        rows={2}
        placeholder={descriptionPlaceholder}
        value={d.description ?? ""}
        onChange={(e) => update({ description: e.target.value })}
      />

      <label className={fieldLabel}>Result variable</label>
      <textarea
        className={`${input} resize-y leading-relaxed`}
        rows={1}
        placeholder="tool_result"
        value={d.resultVariable ?? ""}
        onChange={(e) => update({ resultVariable: e.target.value })}
      />
      <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
        Optional local variable name for the tool result. If left blank, downstream
        steps can reference it by the tool name.
      </p>

      <LocalInputsEditor
        value={(d as Record<string, unknown>)[NODE_LOCAL_INPUTS_DATA_KEY]}
        onChange={(next) => updateLocalInputFields(update, next)}
      />

      <label className={fieldLabel}>Node execution mode</label>
      <select
        className={input}
        value={d.executionMode ?? "sync"}
        onChange={(e) =>
          update({ executionMode: e.target.value as "sync" | "async" })
        }
      >
        <option value="sync">Sync</option>
        <option value="async">Async job</option>
      </select>
      <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
        Sync waits for the real tool result before continuing. Async queues a
        persisted Airlab job and returns a job handle immediately so later nodes
        can inspect or await it.
      </p>

      {(d.executionMode ?? "sync") === "async" && (
        <>
          <label className={fieldLabel}>Continuation policy</label>
          <select
            className={input}
            value={readCanvasAsyncContinuationPolicy(d)}
            onChange={(e) =>
              update({
                asyncContinuationPolicy: e.target
                  .value as CanvasAsyncContinuationPolicy,
              })
            }
          >
            <option value="fork_continue">Fork and continue</option>
            <option value="fork_yield">Fork and end turn</option>
            <option value="detach">Detach background job</option>
            <option value="await_now">Await in this turn</option>
          </select>
          <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
            Attached jobs keep the run logically waiting for the result. Detached
            jobs are fire-and-forget. Fork and end turn returns a response now
            and leaves the job handle for a later read or await node.
          </p>
        </>
      )}

      {(action === "post" || action === "read_dataset") && (
        <>
          <ParametersEditor
            schemaJson={d.paramsSchema}
            onChange={(next) => update({ paramsSchema: next })}
          />
          <details className="mt-2 text-[10px] font-mono text-gray-500">
            <summary className="cursor-pointer">JSON schema (advanced)</summary>
            <pre className="mt-1 whitespace-pre-wrap text-gray-700">
              {d.paramsSchema?.trim() || "{}"}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}

export const TOOL_CALL: NodeKindDef = {
  kind: "tool_call",
  toolbarLabel: "+ Tool call",
  toolbarClassName:
    "text-xs font-sans uppercase tracking-widest px-3 py-2 border border-violet-400 text-violet-900 bg-violet-50 hover:bg-violet-100 rounded",
  component: ToolCallNode,
  defaultLabel: "tool_name(args)",
  defaultData: {
    sourceType: "http",
  },
  sourceHandles: [
    { id: "success", label: "success" },
    { id: "error", label: "error" },
  ],
  inspector: {
    labelTitle: "When to call (natural language)",
    helpText:
      'Hint that appears in the system prompt, e.g. "when the user asks about trending topics".',
    textareaRows: 2,
    renderExtra: (data, update, context: CanvasInspectorContext) => {
      const d = data as ToolCallData;
      return renderToolCallInspectorFields(d, update, {
        showDivider: false,
        datasetNames: context.datasetNames,
      });
    },
  },
};
