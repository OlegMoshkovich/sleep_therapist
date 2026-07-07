import { fetchHttp } from "./http";
import { fetchPage } from "./webpage";
import { fetchRss } from "./rss";
import { searchWeb } from "./web-search";
import { savePostedToolData } from "./knowledge-save";
import { readDatasetRecords } from "./dataset-read";
import { recordToolCall } from "./sandbox-logging";
import { callMcpTool } from "./mcp";
import {
  awaitOpenClawTaskCompletion,
  dispatchOpenClawTask,
  isOpenClawTaskInProgress,
} from "@airlab/openclaw-runtime";
import {
  awaitAsyncRuntimeJobCompletion,
  queueToolDispatchJob,
} from "./async-job-runtime";
import type {
  McpAuth,
  ToolDispatchConfig,
  ToolDispatchContext,
  ToolDispatchResult,
} from "@airlab/canvas-compiler/tool-types";

export interface ResolvedToolDispatchServer {
  url?: string;
  auth?: McpAuth;
  command?: string;
  args?: string[];
}

export type ToolDispatchServerResolver = (
  logicalName: string
) => ResolvedToolDispatchServer;

export type InProcessMcpHandler = (
  namespace: string,
  tool: string,
  args: Record<string, unknown>
) => Promise<unknown>;

let toolDispatchServerResolver: ToolDispatchServerResolver | null = null;
const inProcessMcpHandlers = new Map<string, InProcessMcpHandler>();

export function registerToolDispatchServerResolver(
  resolver: ToolDispatchServerResolver | null
): void {
  toolDispatchServerResolver = resolver;
}

export function registerToolDispatchInProcessMcpHandler(
  server: string,
  handler: InProcessMcpHandler | null
): void {
  const normalized = server.trim();
  if (!normalized) {
    return;
  }
  if (handler) {
    inProcessMcpHandlers.set(normalized, handler);
  } else {
    inProcessMcpHandlers.delete(normalized);
  }
}

function resolveToolDispatchServer(
  logicalName: string
): ResolvedToolDispatchServer {
  return toolDispatchServerResolver?.(logicalName) ?? {};
}

// Resolve an "mcp" tool: look the logical server name up in the servers map,
// call it over MCP, and fall back to the pinned REST template (config.url) when
// the server is unconfigured or unreachable. This is the "warn and proceed"
// drift posture from the proposal — the agent stays alive on a benign config
// gap instead of failing closed.
// Logical servers whose namespace is the signed-in user, so memory is private
// per user and persists across that user's sessions.
const PER_USER_MCP_SERVERS = new Set(["memory"]);

// In-repo MCP servers handled in-process instead of over HTTP. Calling our own
// memory endpoint over HTTP would loop back to this same deployment, which on
// Vercel sits behind Deployment Protection and answers the self-call with a 401
// auth page. Running the tool in-process avoids the network hop entirely (and
// needs no MCP SDK). The /api/mcp/memory route still exists for external clients.
async function dispatchMcp(
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  context?: ToolDispatchContext
): Promise<ToolDispatchResult> {
  const ref = config.mcp;

  // `reason` explains the MCP outcome that led here; the note then records
  // whether a REST template was available to fall back to.
  const restFallback = async (reason: string): Promise<ToolDispatchResult> => {
    if (config.url) {
      const r = await fetchHttp(config.url, args);
      return {
        ...r,
        transport: "rest",
        transportNote: `${reason} Fell back to the REST template (${config.url}).`,
      };
    }
    return {
      ok: false,
      transport: "rest",
      transportNote: `${reason} No REST fallback was configured on this tool.`,
      error: ref
        ? `No MCP server configured for "${ref.server}" and no REST fallback.`
        : "MCP tool is missing its { server, tool } reference.",
    };
  };

  if (!ref) return restFallback("This tool has no MCP { server, tool } reference.");

  // In-repo servers (memory) run in-process — no HTTP loopback to our own
  // deployment (see IN_PROCESS_MCP_HANDLERS above). Per-user servers scope the
  // namespace to the signed-in user; others use a shared "default" namespace.
  const inProcessHandler = inProcessMcpHandlers.get(ref.server);
  if (inProcessHandler) {
    const namespace = PER_USER_MCP_SERVERS.has(ref.server)
      ? context?.userId ?? "default"
      : "default";
    try {
      const data = await inProcessHandler(namespace, ref.remoteTool, args);
      return {
        ok: true,
        data,
        transport: "mcp",
        transportNote: `Served by the in-repo "${ref.server}" MCP server in-process (namespace "${namespace}", tool "${ref.remoteTool}").`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: message,
        transport: "mcp",
        transportNote: `The in-repo "${ref.server}" MCP server failed in-process (tool "${ref.remoteTool}"): ${message}.`,
      };
    }
  }

  const { url, auth, command, args: serverArgs } =
    resolveToolDispatchServer(ref.server);
  if (!url && !command) {
    return restFallback(
      `Tried to reach MCP server "${ref.server}", but no endpoint is configured ` +
        `(set WIKIPEDIA_MCP_SERVER_URL, or allow the stdio command).`
    );
  }

  const where = url
    ? `HTTP ${url}`
    : `stdio "${[command, ...(serverArgs ?? [])].join(" ").trim()}"`;

  const result = await callMcpTool(
    { serverUrl: url, auth, command, args: serverArgs, remoteTool: ref.remoteTool },
    args
  );
  if (result.ok) {
    return {
      ...result,
      transport: "mcp",
      transportNote: `Reached MCP server "${ref.server}" via ${where}; called tool "${ref.remoteTool}".`,
    };
  }

  // MCP server was configured but the call failed — fall back to REST if the
  // binding pinned one, otherwise surface the MCP error.
  const failure = `Tried MCP server "${ref.server}" (${where}, tool "${ref.remoteTool}") but it failed: ${result.error}.`;
  return config.url
    ? restFallback(failure)
    : { ...result, transport: "mcp", transportNote: failure };
}

async function runDispatch(
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  context?: ToolDispatchContext
): Promise<ToolDispatchResult> {
  switch (config.sourceType) {
    case "http":
      return fetchHttp(config.url, args);
    case "rss":
      return fetchRss(config.url, args);
    case "page":
      return fetchPage(config.url, args);
    case "web_search":
      return searchWeb(args);
    case "mcp":
      return dispatchMcp(config, args, context);
    case "openclaw":
      return dispatchOpenClawTask(config.url, config.openclaw, args, context);
    case "video":
      return {
        ok: true,
        data: { kind: "video", url: config.url },
      };
    case "knowledge_save":
      if (!context) {
        return {
          ok: false,
          error: "knowledge_save requires runtime context.",
        };
      }
      return savePostedToolData(config, args, context);
    case "dataset_read":
      if (!context) {
        return {
          ok: false,
          error: "dataset_read requires runtime context.",
        };
      }
      return readDatasetRecords(config, args, context);
    default:
      return { ok: false, error: `Unknown sourceType: ${config.sourceType as string}` };
  }
}

async function maybeAwaitOpenClawCompletion(
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  result: ToolDispatchResult,
  context?: ToolDispatchContext
): Promise<ToolDispatchResult> {
  if (
    config.sourceType !== "openclaw" ||
    !context?.awaitOpenClawCompletion ||
    !result.ok ||
    !isOpenClawTaskInProgress(result.data)
  ) {
    return result;
  }

  const timeoutMs =
    typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? Math.trunc(args.timeoutMs)
      : undefined;
  const awaited = await awaitOpenClawTaskCompletion(
    config.url,
    config.openclaw,
    result.data,
    {
      timeoutMs,
      onStatus: context.onOpenClawStatus,
    }
  );
  const transportNote = `${
    result.transportNote ?? `Delegated to OpenClaw backend at ${config.url}.`
  } Awaited delegated job completion via polling.`;

  if (awaited.status === "failed") {
    return {
      ok: false,
      error: awaited.error,
      data: awaited,
      transport: "openclaw",
      transportNote,
    };
  }

  return {
    ok: true,
    data: awaited,
    transport: "openclaw",
    transportNote,
  };
}

export async function dispatchTool(
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  context?: ToolDispatchContext
): Promise<ToolDispatchResult> {
  if (config.executionMode === "async" && !context?.disableAsyncJobQueue) {
    const timeoutMs =
      typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
        ? Math.trunc(args.timeoutMs)
        : undefined;
    const queued = await queueToolDispatchJob({
      config,
      dispatchArgs: args,
      context,
      timeoutMs,
      continuationPolicy: config.asyncContinuationPolicy,
    });
    const shouldAwaitNow = config.asyncContinuationPolicy === "await_now";
    const data = shouldAwaitNow
      ? await awaitAsyncRuntimeJobCompletion(queued.jobId, { timeoutMs })
      : queued;
    const queuedResult: ToolDispatchResult = {
      ok: true,
      data,
      transport: "internal",
      transportNote: shouldAwaitNow
        ? `Queued and awaited Airlab async job for tool "${context?.toolName ?? "tool_call"}".`
        : `Queued Airlab async job for tool "${context?.toolName ?? "tool_call"}".`,
    };
    if (context) {
      await recordToolCall(config, args, queuedResult, context);
    }
    return queuedResult;
  }

  const result = await maybeAwaitOpenClawCompletion(
    config,
    args,
    await runDispatch(config, args, context),
    context
  );

  // Label the transport so the trace can show MCP vs REST. dispatchMcp sets its
  // own ("mcp" or "rest") with a note; fill the rest here.
  if (!result.transport) {
    if (
      config.sourceType === "knowledge_save" ||
      config.sourceType === "dataset_read" ||
      config.sourceType === "video"
    ) {
      result.transport = "internal";
    } else {
      result.transport = "rest";
      result.transportNote ??=
        "Direct REST/HTTP call — this tool is not configured as an MCP reference, so no MCP server was contacted.";
    }
  }

  if (context) {
    await recordToolCall(config, args, result, context);
  }

  return result;
}
