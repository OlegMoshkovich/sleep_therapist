import type {
  DelegatedTaskPollUpdate,
  OpenClawDispatchConfig,
} from "@airlab/openclaw-runtime";
import type { CanvasAsyncContinuationPolicy } from "@airlab/canvas-core/lib/canvas-async-job-config";

export type ToolSourceType =
  | "http"
  | "rss"
  | "page"
  | "web_search"
  | "knowledge_save"
  | "dataset_read"
  | "video"
  | "mcp"
  | "openclaw";
export type ToolSaveTarget = "knowledge" | "dataset";

export type DatasetColumnType =
  | "string"
  | "url"
  | "string[]"
  | "integer"
  | "number"
  | "boolean";
export type DatasetRecordValue = string | string[] | number | boolean | null;

export interface StoredDatasetColumn {
  name: string;
  type: DatasetColumnType;
}

export interface StoredDataset {
  name: string;
  notes: string;
  columns: StoredDatasetColumn[];
  records: Array<Record<string, DatasetRecordValue>>;
}

export interface DatasetToolRuntimeEnvironmentPlayer {
  id: string;
  datasets: StoredDataset[];
}

export interface DatasetToolRuntime {
  primaryDatasets: StoredDataset[];
  sharedDatasets: StoredDataset[];
  environmentPlayers: DatasetToolRuntimeEnvironmentPlayer[];
}

/**
 * How a server in the servers map is authenticated. A bearer token may itself
 * be an "env:VAR_NAME" reference (resolved server-side) so secrets never live
 * in client-persisted policy data.
 */
export type McpAuth = { type: "none" } | { type: "bearer"; token: string };

/**
 * Servers map entry (policy layer): a logical server name resolves to where the
 * MCP server actually lives, so a policy can be re-pointed without rewriting
 * bindings. A server is reached one of two ways:
 *   - remote:  a `url` (Streamable HTTP / SSE), optionally with `auth`
 *   - local:   a `command` + `args` launched over stdio (e.g. npx a public
 *              server) — nothing bundled, just referenced
 * `url` and a bearer `token` may be literal values or "env:VAR_NAME" references
 * (resolved server-side). When both a url and a command are present, the
 * resolved url wins (lets an env var re-point a local default to a hosted one).
 */
export interface ServerRef {
  url?: string;
  auth?: McpAuth;
  command?: string;
  args?: string[];
}

/**
 * A tool binding's portable coordinates, carried on a compiled "mcp" tool.
 * `server` is the logical name resolved against the servers map; `remoteTool`
 * is the tool name exposed by that MCP server (the alias the model sees is the
 * compiled function name, independent of this).
 */
export interface McpBinding {
  server: string;
  remoteTool: string;
}

export interface ToolDispatchConfig {
  sourceType: ToolSourceType;
  url: string;
  /**
   * When set to "async", Airlab queues this tool call as a persisted background
   * job and returns a job handle immediately. The background worker then runs
   * the real transport to completion.
   */
  executionMode?: "sync" | "async";
  /**
   * Controls what the canvas runtime should do after an async job handle is
   * created. "fork_continue" keeps executing the current canvas, "fork_yield"
   * ends the visible turn and leaves the run resumable, "detach" releases the
   * run from waiting on the job, and "await_now" is reserved for callers that
   * intentionally block on a persisted job.
   */
  asyncContinuationPolicy?: CanvasAsyncContinuationPolicy;
  /**
   * Only meaningful for sourceType === "mcp". The reference resolved at
   * runtime: a logical server name (looked up in the servers map) plus the
   * remote tool to call. When the server is unconfigured or unreachable, the
   * dispatcher falls back to `url` (a REST template) if one is present.
   */
  mcp?: McpBinding;
  /**
   * Only meaningful for sourceType === "openclaw". The URL points at an
   * OpenClaw-compatible delegation endpoint; it may be an external gateway or
   * the built-in Airlab bridge route. This block carries backend defaults such
   * as target agent id, sync/async mode, and bearer auth indirection.
   */
  openclaw?: OpenClawDispatchConfig;
  /**
   * @deprecated legacy "supabase_insert" config carried a table name. Post
   * tools now always write to sandbox_knowledge_blocks; this field is
   * ignored. Kept on the type so old saved canvases still load.
   */
  table?: string;
  /**
   * Only meaningful for sourceType === "http" | "rss" | "page" |
   * "web_search" | "openclaw".
   * When true, the successful result is also written to
   * sandbox_knowledge_blocks so it surfaces in the Domain Knowledge section.
   * For knowledge_save the write happens regardless — saving IS the dispatch.
   */
  promoteToKnowledge?: boolean;
  /**
   * Only meaningful for sourceType === "knowledge_save". Defaults to
   * "knowledge" for backward compatibility with older canvases.
   */
  saveTarget?: ToolSaveTarget;
  /**
   * Required when saveTarget === "dataset" or sourceType === "dataset_read".
   * Must match a configured dataset name in the current request snapshot or
   * persisted setup row.
   */
  datasetName?: string;
}

/**
 * Maps a raw sourceType string (including the legacy "supabase_insert" name)
 * to the canonical ToolSourceType. Use this at every read boundary so old
 * canvas data keeps loading after the rename.
 */
export function normalizeSourceType(raw: unknown): ToolSourceType {
  if (raw === "rss") return "rss";
  if (raw === "page") return "page";
  if (raw === "web_search") return "web_search";
  if (raw === "video") return "video";
  if (raw === "mcp") return "mcp";
  if (raw === "openclaw") return "openclaw";
  if (raw === "knowledge_save" || raw === "supabase_insert") return "knowledge_save";
  if (raw === "dataset_read") return "dataset_read";
  return "http";
}

/**
 * Optional metadata the API route passes through to the dispatcher so it
 * can log the tool call to sandbox_tool_call_logs and auto-promote results
 * to sandbox_knowledge_blocks when configured. When configId is omitted,
 * logging and promotion are skipped (the dispatcher still returns the
 * tool result).
 */
export interface ToolDispatchContext {
  configId?: string;
  canvasId?: string;
  conversationId?: string;
  /**
   * The signed-in user's stable id. Used to scope per-user, tenant-isolated
   * tools — notably the memory knowledge graph, whose namespace is derived from
   * this so each user's memories persist across their sessions and stay private
   * from other users. When absent, such tools fall back to their configured
   * (shared) namespace.
   */
  userId?: string;
  toolName: string;
  setupTable?: string;
  setupId?: string;
  /**
   * Scopes dataset tools to an environment agent: datasets stored on that
   * player (in the setup row's environment_players column) resolve first,
   * falling back to the row's top-level datasets. Absent for primary-agent
   * and draft-level runs.
   */
  environmentPlayerId?: string;
  /**
   * Request-scoped dataset snapshot. When present, dataset tools resolve reads
   * and writes here first so runs observe the project the client submitted,
   * even if draft autosave has not persisted those edits yet.
   */
  datasetRuntime?: DatasetToolRuntime;
  /**
   * Internal escape hatch for the async-job worker so a queued tool call does
   * not recursively re-queue itself when the background executor runs it.
   */
  disableAsyncJobQueue?: boolean;
  /**
   * When true, queued/running OpenClaw jobs are polled to a terminal result
   * before the tool payload is returned to the caller.
   */
  awaitOpenClawCompletion?: boolean;
  /**
   * Optional streaming hook for queued/running OpenClaw status updates while a
   * delegated job is being polled.
   */
  onOpenClawStatus?: (update: DelegatedTaskPollUpdate) => void | Promise<void>;
  /**
   * Fired after a dataset record is committed by a knowledge_save tool with
   * saveTarget "dataset", so the caller can mirror the write into its own
   * in-memory copy of the setup row and report it to the client. In-memory
   * only: this callback does NOT survive serialization into async jobs, so
   * async-mode dataset writes happen in the worker without reporting back.
   */
  onDatasetSave?: (event: {
    datasetName: string;
    record: Record<string, string | string[] | number | boolean | null>;
    setupTable?: string;
    setupId?: string;
    /**
     * Which tier the record landed on: the primary agent's own datasets, an
     * environment player's own datasets, or the draft's shared datasets.
     * Missing scope means primary (older callers).
     */
    scope?: "primary" | "player" | "shared";
    /** Set when the record landed on an environment player's datasets. */
    environmentPlayerId?: string;
  }) => void | Promise<void>;
}

export type ToolTransport = "mcp" | "rest" | "internal" | "openclaw";

export interface ToolDispatchResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /**
   * How the call was actually carried out — set after dispatch so the trace can
   * show whether an "mcp" tool ran over MCP ("mcp") or fell back to its REST
   * template ("rest"). Other source types report "rest" (external HTTP),
   * "openclaw" (delegated task backend), or "internal" (knowledge_save / video).
   */
  transport?: ToolTransport;
  /**
   * Human-readable explanation of the transport decision — in particular,
   * whether MCP was attempted, how it was reached, and why it fell back to
   * REST. Shown in the sandbox trace.
   */
  transportNote?: string;
}
